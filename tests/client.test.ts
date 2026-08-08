import { afterEach, describe, expect, it } from 'vitest'
import { MemoryKeyValueStore } from '../src/core/storage'
import { allEvents, createTestClient, destroyAllClients, type SendRecord } from './helpers'

afterEach(() => destroyAllClients())

describe('身份与客户端行为', () => {
  it('anonymous_id 用 crypto.randomUUID 生成并持久化，二次启动复用', () => {
    const t1 = createTestClient()
    const id1 = t1.client.getDistinctId()
    expect(id1).toMatch(/^[0-9a-f-]{36}$/)
    const t2 = createTestClient({}, { kv: t1.kv })
    expect(t2.client.getDistinctId()).toBe(id1)
  })

  it('identify 设置 user_id 并上报 $identify 事件（user_id 放 props，服务端裁定口径）', async () => {
    const t = createTestClient()
    t.client.identify(1001)
    await t.client.flush()
    const identify = allEvents(t.sent).find((e) => e.event === '$identify')
    expect(identify).toBeTruthy()
    expect(identify?.user_id).toBe(1001)
    expect(identify?.props.user_id).toBe(1001)
    // 后续事件携带 user_id
    t.client.track('after_login')
    await t.client.flush()
    expect(allEvents(t.sent).find((e) => e.event === 'after_login')?.user_id).toBe(1001)
  })

  it('reset 清空 user_id 并更换 anonymous_id', () => {
    const t = createTestClient()
    const before = t.client.getDistinctId()
    t.client.identify(1)
    t.client.reset()
    expect(t.client.getUserId()).toBeNull()
    expect(t.client.getDistinctId()).not.toBe(before)
  })

  it('track 事件结构符合协议：event_id/ts/distinct_id/session_id/props', async () => {
    const t = createTestClient()
    t.client.track('buy', { price: 9.9 })
    await t.client.flush()
    const ev = allEvents(t.sent).find((e) => e.event === 'buy')
    expect(ev).toBeTruthy()
    expect(ev?.event_id).toMatch(/^[0-9a-f-]{36}$/)
    expect(ev?.ts).toBe(t.clock.now())
    expect(ev?.distinct_id).toBe(t.client.getDistinctId())
    expect(ev?.session_id).toBeTruthy()
    expect(ev?.props.price).toBe(9.9)
  })

  it('首个事件前自动补 $session_start，且顺序在其之前', async () => {
    const t = createTestClient()
    t.client.track('first')
    await t.client.flush()
    const events = allEvents(t.sent)
    const names = events.map((e) => e.event)
    expect(names.indexOf('$session_start')).toBeGreaterThanOrEqual(0)
    expect(names.indexOf('$session_start')).toBeLessThan(names.indexOf('first'))
  })

  it('会话超时轮换：$session_end（旧会话带 duration）→ $session_start（新会话）', async () => {
    const t = createTestClient()
    t.client.track('first')
    await t.client.flush()
    const oldSession = t.client.getSessionId()
    t.clock.advance(31 * 60 * 1000)
    t.client.track('after_timeout')
    await t.client.flush()
    const events = allEvents(t.sent)
    const end = events.find((e) => e.event === '$session_end')
    const startIdx = events.findIndex(
      (e) => e.event === '$session_start' && e.session_id !== oldSession
    )
    const trackIdx = events.findIndex((e) => e.event === 'after_timeout')
    expect(end?.session_id).toBe(oldSession)
    expect(end?.props.duration_ms).toBe(0)
    expect(startIdx).toBeGreaterThan(-1)
    expect(startIdx).toBeLessThan(trackIdx)
    expect(events[trackIdx]?.session_id).not.toBe(oldSession)
  })

  it('timeEvent 计时挂到同名事件 props.duration_ms', async () => {
    const t = createTestClient()
    t.client.timeEvent('pay')
    t.clock.advance(2500)
    t.client.track('pay')
    await t.client.flush()
    const ev = allEvents(t.sent).find((e) => e.event === 'pay')
    expect(ev?.props.duration_ms).toBe(2500)
  })

  it('registerSuperProperties 合并进所有事件，可被注销', async () => {
    const t = createTestClient()
    t.client.registerSuperProperties({ tenant: 't1', plan: 'pro' })
    t.client.track('e1')
    t.client.unregisterSuperProperty('plan')
    t.client.track('e2')
    await t.client.flush()
    const events = allEvents(t.sent)
    expect(events.find((e) => e.event === 'e1')?.props).toMatchObject({ tenant: 't1', plan: 'pro' })
    expect(events.find((e) => e.event === 'e2')?.props).toMatchObject({ tenant: 't1' })
    expect(events.find((e) => e.event === 'e2')?.props.plan).toBeUndefined()
  })

  it('event_id 跨重发稳定：失败后重发同一 event_id', async () => {
    const t = createTestClient({ batchSize: 1 })
    t.state.fail = true
    t.client.track('retry_me')
    await t.client.flush()
    expect(t.sent).toHaveLength(0)
    t.state.fail = false
    await t.client.flush()
    expect(t.attempts.length).toBeGreaterThanOrEqual(2)
    // 每次尝试发送的事件集合完全一致（event_id 稳定，服务端按此幂等去重）
    const idsOf = (r: SendRecord) => r.payload.events.map((e) => e.event_id).sort()
    const first = idsOf(t.attempts[0]!)
    for (const a of t.attempts) expect(idsOf(a)).toEqual(first)
    expect(t.sent.length).toBeGreaterThan(0)
  })

  it('sampleRate 0 全部丢弃；上报体含 app_key/schema_version/sdk/sent_at', async () => {
    const t = createTestClient({ sampleRate: 0 })
    t.client.track('never')
    await t.client.flush()
    expect(t.sent).toHaveLength(0)

    const t2 = createTestClient()
    t2.client.track('hello')
    await t2.client.flush()
    const payload = t2.sent[0]?.payload
    expect(payload?.app_key).toBe('test-app')
    expect(payload?.schema_version).toBe('1')
    expect(payload?.sdk.platform).toBe('web')
    expect(payload?.sdk.version).toBeTruthy()
    expect(typeof payload?.sent_at).toBe('number')
  })

  it('optOut 停采并清空队列，optIn 恢复', async () => {
    const t = createTestClient()
    t.client.optOut()
    t.client.track('blocked')
    await t.client.flush()
    expect(t.sent).toHaveLength(0)
    expect(t.client.isOptedOut()).toBe(true)
    t.client.optIn()
    t.client.track('allowed')
    await t.client.flush()
    expect(allEvents(t.sent).map((e) => e.event)).toContain('allowed')
  })

  it('respectDnt：DNT 开启时不采集', async () => {
    const t = createTestClient({}, { isDnt: () => true })
    t.client.track('dnt_event')
    await t.client.flush()
    expect(t.sent).toHaveLength(0)
  })

  it('公共属性合并 + route_path 提供者 + release', async () => {
    const t = createTestClient({ release: '1.2.3' }, {}, { url_path: '/home', language: 'zh-CN' })
    t.client.setRoutePathProvider(() => '/user/:id/detail')
    t.client.track('view')
    await t.client.flush()
    const ev = allEvents(t.sent).find((e) => e.event === 'view')
    expect(ev?.props).toMatchObject({
      url_path: '/home',
      route_path: '/user/:id/detail',
      release: '1.2.3',
      language: 'zh-CN'
    })
  })

  it('props 清洗：键/字符串值截断，undefined 剔除', async () => {
    const t = createTestClient()
    t.client.track('dirty', {
      ['k'.repeat(100)]: 'v',
      long: 'x'.repeat(2000),
      gone: undefined
    })
    await t.client.flush()
    const ev = allEvents(t.sent).find((e) => e.event === 'dirty')
    const keys = Object.keys(ev?.props ?? {})
    expect(keys.some((k) => k.length > 64)).toBe(false)
    expect((ev?.props.long as string).length).toBe(1024)
    expect('gone' in (ev?.props ?? {})).toBe(false)
  })

  it('不同 anonymous_id 序列化进新 KV 时互不影响（identify 持久化）', () => {
    const kv = new MemoryKeyValueStore()
    const t = createTestClient({}, { kv })
    t.client.identify('u-9')
    const t2 = createTestClient({}, { kv })
    expect(t2.client.getUserId()).toBe('u-9')
  })
})
