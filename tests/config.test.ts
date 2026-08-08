import { afterEach, describe, expect, it } from 'vitest'
import { allEvents, createTestClient, destroyAllClients } from './helpers'

afterEach(() => destroyAllClients())

const CONFIG_KEY = 'mst:test-app:config'

describe('配置下发（下次启动生效）', () => {
  it('缓存的 sampleRate=0 在启动时生效：全部丢弃', async () => {
    const t = createTestClient()
    t.kv.setItem(CONFIG_KEY, JSON.stringify({ sampleRate: 0 }))
    const t2 = createTestClient({}, { kv: t.kv })
    t2.client.track('sampled_out')
    await t2.client.flush()
    expect(t2.sent).toHaveLength(0)
  })

  it('缓存的 enabled=false 关闭采集', async () => {
    const t = createTestClient()
    t.kv.setItem(CONFIG_KEY, JSON.stringify({ enabled: false }))
    const t2 = createTestClient({}, { kv: t.kv })
    t2.client.track('disabled_event')
    await t2.client.flush()
    expect(t2.sent).toHaveLength(0)
    expect(t2.client.isEnabled()).toBe(false)
  })

  it('缓存的 maskSelectors 合并进配置', () => {
    const t = createTestClient({ maskSelectors: ['.local'] })
    t.kv.setItem(CONFIG_KEY, JSON.stringify({ maskSelectors: '.remote-a, .remote-b' }))
    const t2 = createTestClient({ maskSelectors: ['.local'] }, { kv: t.kv })
    expect(t2.client.options.maskSelectors).toEqual(['.local', '.remote-a', '.remote-b'])
  })

  it('拉取的新配置只写缓存，本次不生效（下次启动生效）', async () => {
    let fetchedUrl = ''
    const t = createTestClient(
      { fetchRemoteConfig: true },
      {
        configFetcher: async (url) => {
          fetchedUrl = url
          return { sampleRate: 0 }
        }
      }
    )
    await new Promise((r) => setTimeout(r, 0))
    expect(fetchedUrl).toBe('https://t.example.com/track/config?app_key=test-app')
    // 已写入缓存
    expect(t.kv.getItem(CONFIG_KEY)).toContain('"sampleRate":0')
    // 本次仍按 sampleRate=100 采集
    t.client.track('still_tracked')
    await t.client.flush()
    expect(allEvents(t.sent).map((e) => e.event)).toContain('still_tracked')
    // 下次启动生效
    const t2 = createTestClient({}, { kv: t.kv })
    t2.client.track('next_boot')
    await t2.client.flush()
    expect(t2.sent).toHaveLength(0)
  })

  it('配置拉取失败不影响采集', async () => {
    const t = createTestClient(
      { fetchRemoteConfig: true },
      {
        configFetcher: async () => {
          throw new Error('config down')
        }
      }
    )
    await new Promise((r) => setTimeout(r, 0))
    t.client.track('ok')
    await t.client.flush()
    expect(allEvents(t.sent).map((e) => e.event)).toContain('ok')
  })
})
