// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest'
import { apiMonitorPlugin } from '../src/plugins/api-monitor'
import { allEvents, createTestClient, destroyAllClients } from './helpers'

afterEach(() => destroyAllClients())

describe('api-monitor 插件（默认关，排除自身请求）', () => {
  it('包装 fetch：记录 url(去查询串)/method/status/duration', async () => {
    const mockFetch = async (input: RequestInfo | URL) =>
      new Response(`{"ok":true}`, { status: 200, statusText: 'OK' })
    window.fetch = mockFetch as typeof fetch
    const t = createTestClient({ plugins: [apiMonitorPlugin()] })
    await window.fetch('https://api.example.com/users?token=secret&page=1')
    await t.client.flush()
    const ev = allEvents(t.sent).find((e) => e.event === 'api_request')
    expect(ev).toBeTruthy()
    expect(ev?.props.url).toBe('https://api.example.com/users')
    expect(ev?.props.method).toBe('GET')
    expect(ev?.props.status).toBe(200)
    expect(ev?.props.success).toBe(true)
    expect(typeof ev?.props.duration_ms).toBe('number')
    expect(JSON.stringify(ev?.props)).not.toContain('secret')
  })

  it('fetch 抛错也记录（status 0 + error）', async () => {
    window.fetch = (async () => {
      throw new Error('conn refused')
    }) as typeof fetch
    const t = createTestClient({ plugins: [apiMonitorPlugin()] })
    await expect(window.fetch('https://api.example.com/down')).rejects.toThrow('conn refused')
    await t.client.flush()
    const ev = allEvents(t.sent).find((e) => e.event === 'api_request')
    expect(ev?.props.status).toBe(0)
    expect(ev?.props.success).toBe(false)
    expect(ev?.props.error).toBe('conn refused')
  })

  it('排除自身 collect/config 请求，防自埋点', async () => {
    window.fetch = (async () => new Response('{}', { status: 204 })) as typeof fetch
    const t = createTestClient({ plugins: [apiMonitorPlugin()] })
    await window.fetch('https://t.example.com/track/collect', { method: 'POST' })
    await window.fetch('https://t.example.com/track/config?app_key=test-app')
    await t.client.flush()
    expect(allEvents(t.sent).filter((e) => e.event === 'api_request')).toHaveLength(0)
  })

  it('teardown 恢复原 fetch', () => {
    const original = async () => new Response('{}')
    window.fetch = original as typeof fetch
    const t = createTestClient({ plugins: [apiMonitorPlugin()] })
    expect(window.fetch).not.toBe(original)
    t.client.destroy()
    expect(window.fetch).toBe(original)
  })
})
