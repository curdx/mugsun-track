// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { isSampled } from '../src/core/sampler'
import { byteLength } from '../src/core/utils'
import { errorPlugin } from '../src/plugins/error'
import {
  replayPlugin,
  type ReplayPluginOptions,
  type ReplayRecordOptions
} from '../src/plugins/replay'
import { ReplayRecorder, type ReplayChunkPayload } from '../src/plugins/replay/recorder'
import type { TrackOptions, TrackPlugin } from '../src/types'
import { allEvents, createTestClient, destroyAllClients } from './helpers'

afterEach(() => destroyAllClients())

// ---------------------------------------------------------------- 测试桩

/** 假 rrweb 增量事件（type/timestamp 结构与 rrweb 一致） */
function fakeEvent(id: number, ts: number) {
  return { type: 3, timestamp: ts, data: { source: 1, id } }
}

/** 假 gzip：加 'GZIP:' 前缀模拟压缩（decodeChunk 对称还原） */
const fakeGzip = async (body: string): Promise<ArrayBuffer> =>
  new TextEncoder().encode(`GZIP:${body}`).buffer as ArrayBuffer

function decodeChunk(p: ReplayChunkPayload): Array<{ data: { id: number } }> {
  const raw = new TextDecoder().decode(Uint8Array.from(atob(p.payload), (c) => c.charCodeAt(0)))
  return JSON.parse(p.gzip ? raw.slice('GZIP:'.length) : raw)
}

interface SendCall {
  payload: ReplayChunkPayload
  preferBeacon: boolean
}

/** 回放发送捕获：fail=true 恒失败；failTimes 控制前 N 次失败 */
function captureSend() {
  const calls: SendCall[] = []
  const state = { fail: false, failTimes: 0 }
  const send = async (payload: ReplayChunkPayload, opts: { preferBeacon: boolean }) => {
    calls.push({ payload, preferBeacon: opts.preferBeacon })
    if (state.fail) return false
    if (state.failTimes > 0) {
      state.failTimes--
      return false
    }
    return true
  }
  return { calls, state, send }
}

/** rrweb.record 桩：捕获传入选项，emit 产假事件流 */
function stubRecord() {
  const calls: ReplayRecordOptions[] = []
  const record = (opts: ReplayRecordOptions) => {
    calls.push(opts)
    return () => {}
  }
  const emit = (event: unknown) => calls[0]?.emit(event)
  return { record, calls, emit }
}

/** 等编码链与发送泵的微任务落地 */
async function settle(rounds = 20): Promise<void> {
  for (let i = 0; i < rounds; i++) await Promise.resolve()
}

// ---------------------------------------------------------------- 环形缓冲（常录滚动覆盖）

describe('replay 环形缓冲', () => {
  it('时间窗上限：超窗事件滚动丢弃，强传只带最近窗口', async () => {
    const { calls, send } = captureSend()
    const rec = new ReplayRecorder({
      appKey: 'app',
      uploadEnabled: true,
      send,
      gzip: fakeGzip,
      bufferMaxAge: 1000
    })
    for (let i = 0; i < 100; i++) rec.push(fakeEvent(i, i * 100))
    // 未选中不上传；出错强传时只带最近窗口
    rec.bindSession('s1', false)
    rec.forceUpload()
    await settle()
    // 锚定最新 ts=9900，窗口 [8900, 9900] → 保留 id 89..99
    expect(calls).toHaveLength(1)
    const events = decodeChunk(calls[0].payload)
    expect(events.map((e) => e.data.id)).toEqual([89, 90, 91, 92, 93, 94, 95, 96, 97, 98, 99])
    rec.destroy()
  })

  it('字节上限：超限丢最旧', async () => {
    const { calls, send } = captureSend()
    // 时间戳取同位数，保证每条事件序列化等长
    const perEvent = byteLength(JSON.stringify(fakeEvent(0, 1000)))
    const rec = new ReplayRecorder({
      appKey: 'app',
      uploadEnabled: true,
      send,
      gzip: fakeGzip,
      bufferMaxAge: 60_000,
      bufferMaxBytes: perEvent * 5 + 1
    })
    for (let i = 0; i < 10; i++) rec.push(fakeEvent(i, 1000 + i * 10))
    rec.bindSession('s1', true)
    rec.forceUpload()
    await settle()
    const events = decodeChunk(calls[0].payload)
    expect(events).toHaveLength(5)
    expect(events.map((e) => e.data.id)).toEqual([5, 6, 7, 8, 9])
    rec.destroy()
  })
})

// ---------------------------------------------------------------- 分块与重试（recorder 纯逻辑）

describe('replay 分块与重试', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  function makeRecorder(overrides: Partial<ConstructorParameters<typeof ReplayRecorder>[0]> = {}) {
    const cap = captureSend()
    const rec = new ReplayRecorder({
      appKey: 'app',
      uploadEnabled: true,
      send: cap.send,
      gzip: fakeGzip,
      ...overrides
    })
    rec.start()
    return { rec, ...cap }
  }

  it('50 事件触发切块，seq 自增；5s 定时切走尾巴', async () => {
    const { rec, calls } = makeRecorder()
    rec.bindSession('s1', true)
    for (let i = 0; i < 50; i++) rec.push(fakeEvent(i, i))
    await settle()
    expect(calls).toHaveLength(1)
    expect(calls[0].payload.seq).toBe(0)
    expect(calls[0].payload.event_count).toBe(50)
    // 再来 60：满 50 立即切第二块（seq=1），剩 10 条等 5s 定时切成第三块（seq=2）
    for (let i = 50; i < 110; i++) rec.push(fakeEvent(i, i))
    await settle()
    expect(calls).toHaveLength(2)
    expect(calls[1].payload.seq).toBe(1)
    await vi.advanceTimersByTimeAsync(5000)
    await settle()
    expect(calls).toHaveLength(3)
    expect(calls[2].payload.seq).toBe(2)
    expect(calls[2].payload.event_count).toBe(10)
    expect(calls.every((c) => c.payload.session_id === 's1')).toBe(true)
    rec.destroy()
  })

  it('失败块指数退避重试 3 次后丢弃，后续块不受影响', async () => {
    const { rec, calls, state } = makeRecorder()
    state.fail = true
    rec.bindSession('s1', true)
    for (let i = 0; i < 50; i++) rec.push(fakeEvent(i, i))
    await settle()
    expect(calls).toHaveLength(1) // 首次发送失败
    await vi.advanceTimersByTimeAsync(1000) // 重试 1（base*2^0）
    expect(calls).toHaveLength(2)
    await vi.advanceTimersByTimeAsync(2000) // 重试 2
    expect(calls).toHaveLength(3)
    await vi.advanceTimersByTimeAsync(4000) // 重试 3
    expect(calls).toHaveLength(4)
    await vi.advanceTimersByTimeAsync(60_000) // 重试耗尽已丢弃，不再有发送
    expect(calls).toHaveLength(4)
    // 丢弃不堵泵：恢复后新块照常发送
    state.fail = false
    for (let i = 50; i < 100; i++) rec.push(fakeEvent(i, i))
    await settle()
    expect(calls).toHaveLength(5)
    expect(calls[4].payload.seq).toBe(1)
    rec.destroy()
  })

  it('gzip 缺失/失败降级明文标记（gzip:false，payload 为 base64 明文）', async () => {
    const noGzip = makeRecorder({ gzip: undefined })
    noGzip.rec.bindSession('s1', true)
    for (let i = 0; i < 50; i++) noGzip.rec.push(fakeEvent(i, i))
    await settle()
    expect(noGzip.calls[0].payload.gzip).toBe(false)
    expect(decodeChunk(noGzip.calls[0].payload)).toHaveLength(50)
    noGzip.rec.destroy()

    const throwing = makeRecorder({
      gzip: async () => {
        throw new Error('no CompressionStream')
      }
    })
    throwing.rec.bindSession('s1', true)
    for (let i = 0; i < 50; i++) throwing.rec.push(fakeEvent(i, i))
    await settle()
    expect(throwing.calls[0].payload.gzip).toBe(false)
    expect(decodeChunk(throwing.calls[0].payload)).toHaveLength(50)
    throwing.rec.destroy()
  })

  it('协议字段：app_key/session_id/seq/event_count/gzip/payload 齐全且 payload 可还原事件流', async () => {
    const { rec, calls } = makeRecorder()
    rec.bindSession('s1', true)
    for (let i = 0; i < 50; i++) rec.push(fakeEvent(i, i))
    await settle()
    const p = calls[0].payload
    expect(p).toMatchObject({
      app_key: 'app',
      session_id: 's1',
      seq: 0,
      event_count: 50,
      gzip: true
    })
    expect(decodeChunk(p).map((e) => e.data.id)).toEqual(Array.from({ length: 50 }, (_, i) => i))
    rec.destroy()
  })
})

// ---------------------------------------------------------------- 插件集成（client + 钩子）

describe('replay 插件', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  function setup(
    options: Partial<TrackOptions> = {},
    pluginOpts: ReplayPluginOptions = {},
    before: TrackPlugin[] = []
  ) {
    const cap = captureSend()
    const stub = stubRecord()
    const t = createTestClient({
      replayEnabled: true,
      replaySampleRate: 100,
      ...options,
      plugins: [
        ...before,
        replayPlugin({ record: stub.record, send: cap.send, gzip: fakeGzip, ...pluginOpts })
      ]
    })
    return { t, cap, stub }
  }

  it('采样命中才上传：命中切块发送，未命中缓冲随会话结束丢弃', async () => {
    const hit = setup({ replaySampleRate: 100 })
    hit.t.client.track('boot')
    for (let i = 0; i < 3; i++) hit.stub.emit(fakeEvent(i, i))
    await vi.advanceTimersByTimeAsync(5000)
    await settle()
    expect(hit.cap.calls).toHaveLength(1)
    expect(hit.cap.calls[0].payload.session_id).toBe(hit.t.client.peekSessionId())
    expect(decodeChunk(hit.cap.calls[0].payload)).toHaveLength(3)

    const miss = setup({ replaySampleRate: 0 })
    miss.t.client.track('boot')
    for (let i = 0; i < 3; i++) miss.stub.emit(fakeEvent(i, i))
    await vi.advanceTimersByTimeAsync(5000)
    await settle()
    expect(miss.cap.calls).toHaveLength(0)
    // 会话结束（reset 轮换）缓冲丢弃：依然无任何发送
    miss.t.client.reset()
    miss.t.client.track('next_session')
    for (let i = 3; i < 6; i++) miss.stub.emit(fakeEvent(i, i))
    await vi.advanceTimersByTimeAsync(5000)
    await settle()
    expect(miss.cap.calls).toHaveLength(0)
  })

  it('采样判定复用 sampler：键为 appKey:session_id，会话级一致', async () => {
    const { t, cap, stub } = setup({ replaySampleRate: 37 })
    t.client.track('boot')
    const sid = t.client.peekSessionId() as string
    for (let i = 0; i < 3; i++) stub.emit(fakeEvent(i, i))
    await vi.advanceTimersByTimeAsync(5000)
    await settle()
    const expected = isSampled(`test-app:${sid}`, 37)
    expect(cap.calls.length).toBe(expected ? 1 : 0)
  })

  it('$error 无视采样强制上传（error 插件钩子），且 $error 事件照常入库', async () => {
    const { t, cap, stub } = setup({ replaySampleRate: 0 }, {}, [errorPlugin()])
    t.client.track('boot')
    for (let i = 0; i < 3; i++) stub.emit(fakeEvent(i, i))
    await vi.advanceTimersByTimeAsync(5000)
    await settle()
    expect(cap.calls).toHaveLength(0) // 未命中采样：不上传
    const err = new Error('boom')
    window.dispatchEvent(new window.ErrorEvent('error', { message: 'boom', error: err }))
    await settle()
    // 强传：错误发生前的已录缓冲一并带出
    expect(cap.calls).toHaveLength(1)
    expect(decodeChunk(cap.calls[0].payload)).toHaveLength(3)
    // 事件主队列不受影响，$error 正常采集
    await t.client.flush()
    expect(allEvents(t.sent).map((e) => e.event)).toContain('$error')
  })

  it('replayEnabled=false（总开关关）不启动录制，$error 也不传', async () => {
    const { t, cap, stub } = setup({ replayEnabled: false })
    t.client.track('boot')
    expect(stub.calls).toHaveLength(0) // record 未被调用
    expect(t.client.replay).toBeNull() // 挂载点未注册
    window.dispatchEvent(new window.ErrorEvent('error', { message: 'x', error: new Error('x') }))
    await settle()
    expect(cap.calls).toHaveLength(0)
  })

  it('pagehide 收尾块：明文（gzip:false）+ beacon 直发剩余缓冲', async () => {
    const { t, cap, stub } = setup()
    t.client.track('boot')
    for (let i = 0; i < 5; i++) stub.emit(fakeEvent(i, i))
    window.dispatchEvent(new window.Event('pagehide'))
    expect(cap.calls).toHaveLength(1)
    expect(cap.calls[0].preferBeacon).toBe(true)
    expect(cap.calls[0].payload.gzip).toBe(false)
    expect(cap.calls[0].payload.event_count).toBe(5)
    expect(decodeChunk(cap.calls[0].payload).map((e) => e.data.id)).toEqual([0, 1, 2, 3, 4])
  })

  it('回放发送持续失败不阻塞事件主队列', async () => {
    const { t, stub } = setup({}, { send: async () => false })
    t.client.track('boot')
    for (let i = 0; i < 3; i++) stub.emit(fakeEvent(i, i))
    await vi.advanceTimersByTimeAsync(5000)
    await vi.advanceTimersByTimeAsync(60_000) // 经历若干次退避重试
    t.client.track('biz_event')
    await t.client.flush()
    expect(allEvents(t.sent).map((e) => e.event)).toContain('biz_event')
  })

  it('record 隐私选项：maskAllInputs、blockSelector（内置 + maskSelectors）、不采 canvas、不动文本遮罩', () => {
    const { stub } = setup({ maskSelectors: ['.secret'] })
    expect(stub.calls).toHaveLength(1)
    const opts = stub.calls[0]
    expect(opts.maskAllInputs).toBe(true)
    expect(opts.blockSelector).toBe('input[type="password"], [data-track-mask], .secret')
    expect(opts.recordCanvas).toBe(false)
    expect('maskTextSelector' in opts).toBe(false)
  })

  it('会话轮换：旧会话收尾块先发，新会话缓冲与 seq 重置', async () => {
    const { t, cap, stub } = setup({ sessionTimeout: 60_000 })
    t.client.track('boot')
    const sid1 = t.client.peekSessionId() as string
    for (let i = 0; i < 2; i++) stub.emit(fakeEvent(i, i))
    // 超时后首个事件触发轮换
    t.clock.advance(61_000)
    t.client.track('after_idle')
    const sid2 = t.client.peekSessionId() as string
    expect(sid2).not.toBe(sid1)
    await settle()
    // 旧会话剩余缓冲作为收尾块带走（seq=0）
    expect(cap.calls).toHaveLength(1)
    expect(cap.calls[0].payload.session_id).toBe(sid1)
    expect(cap.calls[0].payload.seq).toBe(0)
    expect(cap.calls[0].payload.event_count).toBe(2)
    // 新会话：seq 从 0 重新自增，缓冲不串旧会话事件
    for (let i = 2; i < 5; i++) stub.emit(fakeEvent(i, i))
    await vi.advanceTimersByTimeAsync(5000)
    await settle()
    expect(cap.calls).toHaveLength(2)
    expect(cap.calls[1].payload.session_id).toBe(sid2)
    expect(cap.calls[1].payload.seq).toBe(0)
    expect(decodeChunk(cap.calls[1].payload).map((e) => e.data.id)).toEqual([2, 3, 4])
  })

  it('reset() 解绑会话：缓冲重置，下一事件开启新会话绑定', async () => {
    const { t, cap, stub } = setup()
    t.client.track('boot')
    for (let i = 0; i < 2; i++) stub.emit(fakeEvent(i, i))
    t.client.reset()
    await settle()
    expect(cap.calls).toHaveLength(1) // 旧会话收尾块
    // 无会话期间继续常录但不上传
    for (let i = 2; i < 4; i++) stub.emit(fakeEvent(i, i))
    await vi.advanceTimersByTimeAsync(5000)
    await settle()
    expect(cap.calls).toHaveLength(1)
    // 下一事件建会话后恢复上传，缓冲含无会话期事件（同会话口径）
    t.client.track('relogin')
    await vi.advanceTimersByTimeAsync(5000)
    await settle()
    expect(cap.calls.length).toBeGreaterThanOrEqual(2)
    expect(cap.calls[1].payload.session_id).toBe(t.client.peekSessionId())
  })

  it('client.replay 挂载点随插件注册/摘除', () => {
    const { t } = setup()
    expect(t.client.replay).not.toBeNull()
    t.client.destroy()
    expect(t.client.replay).toBeNull()
  })
})

// ---------------------------------------------------------------- 配置下发

describe('replay 配置下发（下次启动生效）', () => {
  const CONFIG_KEY = 'mst:test-app:config'

  it('默认：replayEnabled=false、replaySampleRate=10', () => {
    const t = createTestClient()
    expect(t.client.options.replayEnabled).toBe(false)
    expect(t.client.options.replaySampleRate).toBe(10)
  })

  it('缓存配置开启回放并下发采样率；远端可双向关停', () => {
    const t = createTestClient()
    t.kv.setItem(CONFIG_KEY, JSON.stringify({ replayEnabled: 1, replaySampleRate: 25 }))
    const t2 = createTestClient({}, { kv: t.kv })
    expect(t2.client.options.replayEnabled).toBe(true)
    expect(t2.client.options.replaySampleRate).toBe(25)
    t.kv.setItem(CONFIG_KEY, JSON.stringify({ replayEnabled: 0 }))
    const t3 = createTestClient({ replayEnabled: true }, { kv: t.kv })
    expect(t3.client.options.replayEnabled).toBe(false)
  })

  it('回放采样率收拢 0-100', () => {
    const t = createTestClient()
    t.kv.setItem(CONFIG_KEY, JSON.stringify({ replayEnabled: true, replaySampleRate: 250 }))
    const t2 = createTestClient({}, { kv: t.kv })
    expect(t2.client.options.replaySampleRate).toBe(100)
  })
})
