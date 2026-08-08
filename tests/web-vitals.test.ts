// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest'
import { webVitalsPlugin } from '../src/plugins/web-vitals'
import { allEvents, createTestClient, destroyAllClients } from './helpers'

afterEach(() => destroyAllClients())

describe('web-vitals 插件', () => {
  it('无 PerformanceObserver 环境静默跳过，不影响其他事件', async () => {
    // happy-dom 无 PerformanceObserver：插件应直接 no-op
    const t = createTestClient({ plugins: [webVitalsPlugin()] })
    t.client.track('normal')
    await t.client.flush()
    expect(allEvents(t.sent).map((e) => e.event)).toContain('normal')
    expect(allEvents(t.sent).filter((e) => e.event === '$web_vitals')).toHaveLength(0)
  })
})
