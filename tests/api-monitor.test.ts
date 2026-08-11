// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { apiMonitorPlugin, type ApiMonitorPluginOptions } from '../src/plugins/api-monitor'
import type { ApiBodyPayload, ApiBodySendOutcome } from '../src/plugins/api-monitor/uploader'
import type { TrackOptions } from '../src/types'
import { allEvents, createTestClient, destroyAllClients, type TestClient } from './helpers'

afterEach(() => destroyAllClients())

// ---------------------------------------------------------------- 测试桩

/** 假 gzip：加 'GZIP:' 前缀模拟压缩（decodeBody 对称还原） */
const fakeGzip = async (body: string): Promise<ArrayBuffer> =>
  new TextEncoder().encode(`GZIP:${body}`).buffer as ArrayBuffer

function decodeBody(p: ApiBodyPayload): string {
  const raw = new TextDecoder().decode(Uint8Array.from(atob(p.payload), (c) => c.charCodeAt(0)))
  return p.gzip ? raw.slice('GZIP:'.length) : raw
}

interface BodySendCall {
  payload: ApiBodyPayload
}

/** body 上传捕获：outcome 队列控制每次发送结果（默认 ok） */
function captureBodySend() {
  const calls: BodySendCall[] = []
  const state = { outcomes: [] as ApiBodySendOutcome[] }
  const send = async (payload: ApiBodyPayload): Promise<ApiBodySendOutcome> => {
    calls.push({ payload })
    return state.outcomes.shift() ?? 'ok'
  }
  return { calls, state, send }
}

/** 等读体/编码链/发送泵的微任务落地 */
async function settle(rounds = 20): Promise<void> {
  for (let i = 0; i < rounds; i++) await Promise.resolve()
}

/** JSON 响应桩 */
function jsonResponse(body: string, headers: Record<string, string> = {}, status = 200): Response {
  return new Response(body, {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...headers }
  })
}

/** XHR 桩：open/send 在原型上（插件包装原型方法），测试手动 fire loadend */
class FakeXHR {
  static instances: FakeXHR[] = []
  status = 200
  responseText = ''
  responseHeaders: Record<string, string> = {}
  opened: { method: string; url: string } | null = null
  sentBody: unknown
  private listeners = new Map<string, Array<() => void>>()

  constructor() {
    FakeXHR.instances.push(this)
  }
  open(method: string, url: string | URL) {
    this.opened = { method: String(method), url: String(url) }
  }
  send(body?: unknown) {
    this.sentBody = body
  }
  addEventListener(type: string, fn: () => void) {
    const list = this.listeners.get(type) ?? []
    list.push(fn)
    this.listeners.set(type, list)
  }
  getResponseHeader(name: string): string | null {
    return this.responseHeaders[name.toLowerCase()] ?? null
  }
  fire(type: string): void {
    for (const fn of this.listeners.get(type) ?? []) fn.call(this)
  }
}

const OrigXHR = globalThis.XMLHttpRequest

function useFakeXhr(): void {
  FakeXHR.instances = []
  ;(globalThis as { XMLHttpRequest?: unknown }).XMLHttpRequest = FakeXHR
}

afterEach(() => {
  ;(globalThis as { XMLHttpRequest?: unknown }).XMLHttpRequest = OrigXHR
})

function setup(
  options: Partial<TrackOptions> = {},
  pluginOpts: ApiMonitorPluginOptions = {},
  context: Record<string, unknown> = {}
): TestClient {
  return createTestClient(
    { apiMonitorEnabled: true, ...options, plugins: [apiMonitorPlugin(pluginOpts)] },
    {},
    context
  )
}

// ---------------------------------------------------------------- ① 开关与包装

describe('api-monitor 开关（默认关，本地显式设置优先）', () => {
  it('默认（无任何配置）不包装 fetch/XHR', async () => {
    const stub = async () => new Response('{}')
    window.fetch = stub as typeof fetch
    createTestClient({ plugins: [apiMonitorPlugin()] })
    expect(window.fetch).toBe(stub)
  })

  it('本地 apiMonitorEnabled=true 开启包装；远端缓存 0 关闭；本地 false 强制覆盖远端 1', async () => {
    const stub = async () => new Response('{}')

    window.fetch = stub as typeof fetch
    setup()
    expect(window.fetch).not.toBe(stub)
    destroyAllClients()

    // 远端缓存关闭：不包装
    window.fetch = stub as typeof fetch
    const t0 = createTestClient()
    t0.kv.setItem('mst:test-app:config', JSON.stringify({ apiMonitorEnabled: 0 }))
    createTestClient({ plugins: [apiMonitorPlugin()] }, { kv: t0.kv })
    expect(window.fetch).toBe(stub)
    destroyAllClients()

    // 本地显式 false 强制覆盖远端 1
    window.fetch = stub as typeof fetch
    t0.kv.setItem('mst:test-app:config', JSON.stringify({ apiMonitorEnabled: 1 }))
    createTestClient({ apiMonitorEnabled: false, plugins: [apiMonitorPlugin()] }, { kv: t0.kv })
    expect(window.fetch).toBe(stub)
  })

  it('teardown 恢复原 fetch', () => {
    const original = async () => new Response('{}')
    window.fetch = original as typeof fetch
    const t = setup()
    expect(window.fetch).not.toBe(original)
    t.client.destroy()
    expect(window.fetch).toBe(original)
  })
})

// ---------------------------------------------------------------- ② 事件字段（fetch/XHR 双路径）

describe('api-monitor 事件采集（fetch/XHR 同口径）', () => {
  it('fetch：method/url(含查询串)/status/耗时/响应大小/page 公共属性', async () => {
    const cap = captureBodySend()
    window.fetch = (async () =>
      jsonResponse('{"ok":true}', { 'content-length': '11' })) as typeof fetch
    const t = setup(
      { apiBodyEnabled: true },
      { send: cap.send, gzip: fakeGzip },
      { url_path: '/demo' }
    )
    await window.fetch('https://api.example.com/users?token=secret&page=1')
    await settle()
    await t.client.flush()
    const ev = allEvents(t.sent).find((e) => e.event === 'api_request')
    expect(ev).toBeTruthy()
    expect(ev?.props.url).toBe('https://api.example.com/users?token=secret&page=1')
    expect(ev?.props.method).toBe('GET')
    expect(ev?.props.status).toBe(200)
    expect(ev?.props.success).toBe(true)
    expect(typeof ev?.props.duration_ms).toBe('number')
    expect(ev?.props.response_size).toBe(11)
    // page 关联：url_path 走 core 公共属性机制
    expect(ev?.props.url_path).toBe('/demo')
  })

  it('XHR：method/url(含查询串)/status/耗时/响应大小', async () => {
    useFakeXhr()
    const cap = captureBodySend()
    const t = setup({ apiBodyEnabled: true }, { send: cap.send, gzip: fakeGzip })
    const xhr = new FakeXHR() as unknown as XMLHttpRequest
    xhr.open('POST', 'https://api.example.com/orders?source=app')
    const fake = FakeXHR.instances[0]
    fake.status = 201
    fake.responseHeaders = { 'content-type': 'application/json', 'content-length': '9' }
    fake.responseText = '{"id":1}'
    xhr.send('payload')
    fake.fire('loadend')
    await settle()
    await t.client.flush()
    const ev = allEvents(t.sent).find((e) => e.event === 'api_request')
    expect(ev?.props.url).toBe('https://api.example.com/orders?source=app')
    expect(ev?.props.method).toBe('POST')
    expect(ev?.props.status).toBe(201)
    expect(ev?.props.success).toBe(true)
    expect(typeof ev?.props.duration_ms).toBe('number')
    expect(ev?.props.response_size).toBe(9)
    // XHR body 走 responseText 上传
    expect(cap.calls).toHaveLength(1)
    expect(decodeBody(cap.calls[0].payload)).toBe('{"id":1}')
  })

  it('排除自身端点（路径后缀：collect/config/replay/api-body/sourcemap/raw），防自埋点', async () => {
    window.fetch = (async () => new Response('{}', { status: 204 })) as typeof fetch
    const t = setup()
    for (const path of ['collect', 'config', 'replay', 'api-body', 'sourcemap', 'raw']) {
      await window.fetch(`https://t.example.com/track/${path}?app_key=test-app`, { method: 'POST' })
    }
    // 同 origin 业务接口不受影响（endpoint 为裸 origin 时也不误杀）
    await window.fetch('https://t.example.com/biz/list')
    await t.client.flush()
    const events = allEvents(t.sent).filter((e) => e.event === 'api_request')
    expect(events).toHaveLength(1)
    expect(events[0].props.url).toBe('https://t.example.com/biz/list')
  })
})

// ---------------------------------------------------------------- ③ 网络失败

describe('api-monitor 网络失败（status=0 + error_message）', () => {
  it('fetch reject：status 0 + error_message', async () => {
    window.fetch = (async () => {
      throw new Error('conn refused')
    }) as typeof fetch
    const t = setup()
    await expect(window.fetch('https://api.example.com/down')).rejects.toThrow('conn refused')
    await t.client.flush()
    const ev = allEvents(t.sent).find((e) => e.event === 'api_request')
    expect(ev?.props.status).toBe(0)
    expect(ev?.props.success).toBe(false)
    expect(ev?.props.error_message).toBe('conn refused')
  })

  it('XHR error（status 0）：status 0 + error_message', async () => {
    useFakeXhr()
    const t = setup()
    const xhr = new FakeXHR() as unknown as XMLHttpRequest
    xhr.open('GET', 'https://api.example.com/down')
    const fake = FakeXHR.instances[0]
    fake.status = 0
    xhr.send()
    fake.fire('loadend')
    await t.client.flush()
    const ev = allEvents(t.sent).find((e) => e.event === 'api_request')
    expect(ev?.props.status).toBe(0)
    expect(ev?.props.success).toBe(false)
    expect(ev?.props.error_message).toBe('network error')
  })
})

// ---------------------------------------------------------------- ④-⑦ body 过滤链

describe('api-monitor body 过滤链', () => {
  function bodySetup(headers: Record<string, string>, body = '{"a":1}') {
    const cap = captureBodySend()
    window.fetch = (async () => jsonResponse(body, headers)) as typeof fetch
    const t = setup({ apiBodyEnabled: true }, { send: cap.send, gzip: fakeGzip })
    return { t, cap }
  }

  it('④ 仅 JSON 采 body：application/json 采集上传', async () => {
    const { t, cap } = bodySetup({})
    await window.fetch('https://api.example.com/a')
    await settle()
    await t.client.flush()
    expect(cap.calls).toHaveLength(1)
    expect(decodeBody(cap.calls[0].payload)).toBe('{"a":1}')
  })

  it('④ text/html 不采 body（事件照发、无 body_skipped 标记）', async () => {
    const cap = captureBodySend()
    window.fetch = (async () =>
      new Response('<html></html>', {
        status: 200,
        headers: { 'content-type': 'text/html' }
      })) as typeof fetch
    const t = setup({ apiBodyEnabled: true }, { send: cap.send, gzip: fakeGzip })
    await window.fetch('https://api.example.com/page')
    await settle()
    await t.client.flush()
    const ev = allEvents(t.sent).find((e) => e.event === 'api_request')
    expect(ev).toBeTruthy()
    expect(ev?.props.body_ref).toBeUndefined()
    expect(ev?.props.body_skipped).toBeUndefined()
    expect(cap.calls).toHaveLength(0)
  })

  it('⑤ content-length 超 apiBodyMaxBytes：跳过并标 body_skipped=size（不读体不上传）', async () => {
    const cap = captureBodySend()
    window.fetch = (async () =>
      jsonResponse('{"a":"1234567890"}', { 'content-length': '100' })) as typeof fetch
    const t = setup(
      { apiBodyEnabled: true, apiBodyMaxBytes: 8 },
      { send: cap.send, gzip: fakeGzip }
    )
    await window.fetch('https://api.example.com/big')
    await settle()
    await t.client.flush()
    expect(cap.calls).toHaveLength(0)
    const ev = allEvents(t.sent).find((e) => e.event === 'api_request')
    expect(ev?.props.body_skipped).toBe('size')
    expect(ev?.props.response_size).toBe(100)
  })

  it('⑤ content-length 缺失时按实际读体长度二次校验：超限标 size 不上传', async () => {
    const cap = captureBodySend()
    window.fetch = (async () => jsonResponse('{"a":"12345678901234567890"}')) as typeof fetch
    const t = setup(
      { apiBodyEnabled: true, apiBodyMaxBytes: 8 },
      { send: cap.send, gzip: fakeGzip }
    )
    await window.fetch('https://api.example.com/chunked')
    await settle()
    await t.client.flush()
    expect(cap.calls).toHaveLength(0)
    const ev = allEvents(t.sent).find((e) => e.event === 'api_request')
    expect(ev?.props.body_skipped).toBe('size')
    expect(ev?.props.response_size).toBe(28)
  })

  it('⑥ SSE（text/event-stream）硬跳过：不读体不上传', async () => {
    const cap = captureBodySend()
    window.fetch = (async () =>
      new Response('data: hello\n\n', {
        status: 200,
        headers: { 'content-type': 'text/event-stream' }
      })) as typeof fetch
    const t = setup({ apiBodyEnabled: true }, { send: cap.send, gzip: fakeGzip })
    await window.fetch('https://api.example.com/sse')
    await settle()
    await t.client.flush()
    expect(allEvents(t.sent).some((e) => e.event === 'api_request')).toBe(true)
    expect(cap.calls).toHaveLength(0)
  })

  it('⑥ 二进制（application/octet-stream）硬跳过：不上传', async () => {
    const cap = captureBodySend()
    window.fetch = (async () =>
      new Response(new Uint8Array([1, 2, 3]), {
        status: 200,
        headers: { 'content-type': 'application/octet-stream' }
      })) as typeof fetch
    const t = setup({ apiBodyEnabled: true }, { send: cap.send, gzip: fakeGzip })
    await window.fetch('https://api.example.com/file')
    await settle()
    await t.client.flush()
    expect(cap.calls).toHaveLength(0)
    const ev = allEvents(t.sent).find((e) => e.event === 'api_request')
    expect(ev?.props.body_ref).toBeUndefined()
  })

  it('⑦ 凭证端点内置硬屏蔽：body 永不采集（标 credential），事件元数据照发', async () => {
    const cap = captureBodySend()
    window.fetch = (async () =>
      jsonResponse('{"token":"jwt-abc","refresh_token":"jwt-def"}')) as typeof fetch
    const t = setup({ apiBodyEnabled: true }, { send: cap.send, gzip: fakeGzip })
    for (const path of ['/auth/login', '/auth/refresh', '/oauth/token', '/auth/social']) {
      await window.fetch(`https://api.example.com${path}`, { method: 'POST' })
    }
    await settle()
    await t.client.flush()
    const events = allEvents(t.sent).filter((e) => e.event === 'api_request')
    expect(events).toHaveLength(4)
    for (const ev of events) {
      expect(ev.props.body_skipped).toBe('credential')
      expect(ev.props.body_ref).toBeUndefined()
    }
    // 响应含令牌也绝不上传
    expect(cap.calls).toHaveLength(0)
  })
})

// ---------------------------------------------------------------- ⑧ body 独立上传通道

describe('api-body 独立上传通道（不占事件队列）', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  function channelSetup() {
    const cap = captureBodySend()
    window.fetch = (async () => jsonResponse('{"a":1}')) as typeof fetch
    const t = setup({ apiBodyEnabled: true }, { send: cap.send, gzip: fakeGzip })
    return { t, cap }
  }

  it('503（retry）：指数退避重试 3 次后丢弃', async () => {
    const { t, cap } = channelSetup()
    cap.state.outcomes = ['retry', 'retry', 'retry', 'retry', 'retry']
    await window.fetch('https://api.example.com/a')
    await settle()
    expect(cap.calls).toHaveLength(1) // 首次失败
    await vi.advanceTimersByTimeAsync(1000) // 重试 1（base*2^0）
    expect(cap.calls).toHaveLength(2)
    await vi.advanceTimersByTimeAsync(2000) // 重试 2
    expect(cap.calls).toHaveLength(3)
    await vi.advanceTimersByTimeAsync(4000) // 重试 3
    expect(cap.calls).toHaveLength(4)
    await vi.advanceTimersByTimeAsync(60_000) // 重试耗尽已丢弃，不再有发送
    expect(cap.calls).toHaveLength(4)
    t.client.destroy()
  })

  it('4xx（drop）：不重试直接丢弃', async () => {
    const { t, cap } = channelSetup()
    cap.state.outcomes = ['drop']
    await window.fetch('https://api.example.com/a')
    await settle()
    expect(cap.calls).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(cap.calls).toHaveLength(1)
    t.client.destroy()
  })

  it('body 发送持续失败不阻塞事件主队列', async () => {
    const { t, cap } = channelSetup()
    cap.state.outcomes = ['retry', 'retry', 'retry', 'retry', 'retry']
    await window.fetch('https://api.example.com/a')
    await settle()
    await vi.advanceTimersByTimeAsync(60_000) // 经历若干次退避重试
    t.client.track('biz_event')
    await t.client.flush()
    const events = allEvents(t.sent).map((e) => e.event)
    expect(events).toContain('api_request')
    expect(events).toContain('biz_event')
  })

  it('默认通道状态码语义：503 重试、4xx 丢弃（独立 Transport 实例）', async () => {
    const apiBodyCalls: string[] = []
    window.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes('/track/api-body')) {
        apiBodyCalls.push(url)
        return new Response('rejected', { status: 503 })
      }
      return jsonResponse('{"a":1}')
    }) as typeof fetch
    // 不注入 send：走插件内置独立 Transport 通道
    const t = setup({ apiBodyEnabled: true }, { gzip: fakeGzip })
    await window.fetch('https://api.example.com/a')
    await settle()
    expect(apiBodyCalls).toHaveLength(1) // 503 → retry
    await vi.advanceTimersByTimeAsync(1000)
    expect(apiBodyCalls).toHaveLength(2)
    await vi.advanceTimersByTimeAsync(2000)
    expect(apiBodyCalls).toHaveLength(3)
    await vi.advanceTimersByTimeAsync(4000)
    expect(apiBodyCalls).toHaveLength(4)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(apiBodyCalls).toHaveLength(4) // 3 次重试耗尽丢弃
    t.client.destroy()

    // 4xx → 不重试
    apiBodyCalls.length = 0
    window.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes('/track/api-body')) {
        apiBodyCalls.push(url)
        return new Response('bad request', { status: 400 })
      }
      return jsonResponse('{"a":1}')
    }) as typeof fetch
    const t2 = setup({ apiBodyEnabled: true }, { gzip: fakeGzip })
    await window.fetch('https://api.example.com/a')
    await settle()
    expect(apiBodyCalls).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(apiBodyCalls).toHaveLength(1)
    t2.client.destroy()
  })

  it('gzip 缺失降级明文标记（gzip:false，payload 为 base64 明文）', async () => {
    const cap = captureBodySend()
    window.fetch = (async () => jsonResponse('{"a":1}')) as typeof fetch
    const t = setup({ apiBodyEnabled: true }, { send: cap.send, gzip: null })
    await window.fetch('https://api.example.com/a')
    await settle()
    expect(cap.calls).toHaveLength(1)
    expect(cap.calls[0].payload.gzip).toBe(false)
    expect(decodeBody(cap.calls[0].payload)).toBe('{"a":1}')
    t.client.destroy()
  })
})

// ---------------------------------------------------------------- ⑨ 业务字段脱敏

describe('api-body 脱敏（apiBodyMaskEnabled，默认关）', () => {
  const BODY = JSON.stringify({
    password: 'p1',
    user: { phone: '13800000000', name: '张三', Token: 't-1' },
    list: [{ email: 'a@b.c', id: 1 }, 'x'],
    ok: true
  })

  it('开启：键清单命中（大小写不敏感）替换 ***，对象/数组递归', async () => {
    const cap = captureBodySend()
    window.fetch = (async () => jsonResponse(BODY)) as typeof fetch
    const t = setup(
      { apiBodyEnabled: true, apiBodyMaskEnabled: true },
      { send: cap.send, gzip: fakeGzip }
    )
    await window.fetch('https://api.example.com/me')
    await settle()
    expect(cap.calls).toHaveLength(1)
    const decoded = JSON.parse(decodeBody(cap.calls[0].payload)) as Record<string, unknown>
    expect(decoded.password).toBe('***')
    expect(decoded.user).toEqual({ phone: '***', name: '张三', Token: '***' })
    expect(decoded.list).toEqual([{ email: '***', id: 1 }, 'x'])
    expect(decoded.ok).toBe(true)
    t.client.destroy()
  })

  it('关闭（默认）：原文上传不脱敏', async () => {
    const cap = captureBodySend()
    window.fetch = (async () => jsonResponse(BODY)) as typeof fetch
    const t = setup({ apiBodyEnabled: true }, { send: cap.send, gzip: fakeGzip })
    await window.fetch('https://api.example.com/me')
    await settle()
    expect(decodeBody(cap.calls[0].payload)).toBe(BODY)
    t.client.destroy()
  })
})

// ---------------------------------------------------------------- ⑩ body_ref 关联

describe('body_ref = event_id 关联', () => {
  it('api_request 事件 props.body_ref === event_id === api-body 上传 event_id', async () => {
    const cap = captureBodySend()
    window.fetch = (async () => jsonResponse('{"a":1}')) as typeof fetch
    const t = setup({ apiBodyEnabled: true }, { send: cap.send, gzip: fakeGzip })
    await window.fetch('https://api.example.com/a')
    await settle()
    await t.client.flush()
    const ev = allEvents(t.sent).find((e) => e.event === 'api_request')
    expect(ev?.props.body_ref).toBe(ev?.event_id)
    expect(cap.calls).toHaveLength(1)
    expect(cap.calls[0].payload.event_id).toBe(ev?.event_id)
    expect(cap.calls[0].payload.app_key).toBe('test-app')
  })
})

// ---------------------------------------------------------------- 配置下发（下次启动生效）

describe('api-monitor 配置下发（下次启动生效）', () => {
  const CONFIG_KEY = 'mst:test-app:config'

  it('缓存配置开启接口监控链并下发安全阀', () => {
    const t = createTestClient()
    t.kv.setItem(
      CONFIG_KEY,
      JSON.stringify({
        apiMonitorEnabled: 1,
        apiBodyEnabled: 1,
        apiBodyMaskEnabled: 1,
        apiBodyMaxBytes: 64
      })
    )
    const t2 = createTestClient({}, { kv: t.kv })
    expect(t2.client.options.apiMonitorEnabled).toBe(true)
    expect(t2.client.options.apiBodyEnabled).toBe(true)
    expect(t2.client.options.apiBodyMaskEnabled).toBe(true)
    expect(t2.client.options.apiBodyMaxBytes).toBe(64)
  })

  it('本地显式设置强制覆盖远端下发（双向）', () => {
    const t = createTestClient()
    t.kv.setItem(
      CONFIG_KEY,
      JSON.stringify({ apiMonitorEnabled: 1, apiBodyEnabled: 1, apiBodyMaxBytes: 64 })
    )
    const t2 = createTestClient(
      { apiMonitorEnabled: false, apiBodyEnabled: false, apiBodyMaxBytes: 128 },
      { kv: t.kv }
    )
    expect(t2.client.options.apiMonitorEnabled).toBe(false)
    expect(t2.client.options.apiBodyEnabled).toBe(false)
    expect(t2.client.options.apiBodyMaxBytes).toBe(128)
    // 反向：本地 true 覆盖远端 0
    t.kv.setItem(CONFIG_KEY, JSON.stringify({ apiMonitorEnabled: 0 }))
    const t3 = createTestClient({ apiMonitorEnabled: true }, { kv: t.kv })
    expect(t3.client.options.apiMonitorEnabled).toBe(true)
  })

  it('远端可双向关停（本地未设置时）', () => {
    const t = createTestClient()
    t.kv.setItem(CONFIG_KEY, JSON.stringify({ apiMonitorEnabled: 1, apiBodyEnabled: 1 }))
    const t2 = createTestClient({}, { kv: t.kv })
    expect(t2.client.options.apiMonitorEnabled).toBe(true)
    expect(t2.client.options.apiBodyEnabled).toBe(true)
    t.kv.setItem(CONFIG_KEY, JSON.stringify({ apiMonitorEnabled: 0, apiBodyEnabled: 0 }))
    const t3 = createTestClient({}, { kv: t.kv })
    expect(t3.client.options.apiMonitorEnabled).toBe(false)
    expect(t3.client.options.apiBodyEnabled).toBe(false)
  })
})
