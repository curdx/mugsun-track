import { describe, expect, it } from 'vitest'
import { Transport, type TransportDeps } from '../src/core/transport'

const payload = { app_key: 'app', events: [{ event_id: 'x' }] }

function makeDeps(overrides: Partial<TransportDeps> = {}) {
  const calls = { beacon: 0, fetch: 0, xhr: 0, gzip: 0 }
  const deps: TransportDeps = {
    beacon: () => {
      calls.beacon++
      return true
    },
    fetch: async () => {
      calls.fetch++
      return { ok: true, status: 204 }
    },
    xhr: async () => {
      calls.xhr++
      return true
    },
    ...overrides
  }
  return { calls, deps }
}

describe('Transport 降级链', () => {
  it('preferBeacon 时 beacon 成功即返回，不走 fetch', async () => {
    const { calls, deps } = makeDeps()
    const t = new Transport('https://t/collect', deps)
    expect(await t.send(payload, { preferBeacon: true })).toBe(true)
    expect(calls).toMatchObject({ beacon: 1, fetch: 0, xhr: 0 })
  })

  it('beacon 返回 false 时降级 fetch', async () => {
    let beaconCalls = 0
    const { calls, deps } = makeDeps({
      beacon: () => {
        beaconCalls++
        return false
      }
    })
    const t = new Transport('https://t/collect', deps)
    expect(await t.send(payload, { preferBeacon: true })).toBe(true)
    expect(beaconCalls).toBe(1)
    expect(calls).toMatchObject({ fetch: 1, xhr: 0 })
  })

  it('fetch 网络异常时降级 XHR', async () => {
    const { calls, deps } = makeDeps({
      fetch: async () => {
        calls.fetch++
        throw new Error('network error')
      }
    })
    const t = new Transport('https://t/collect', deps)
    expect(await t.send(payload)).toBe(true)
    expect(calls).toMatchObject({ fetch: 1, xhr: 1 })
  })

  it('fetch 返回 4xx/5xx 不再降级 XHR，直接判失败', async () => {
    const { calls, deps } = makeDeps({
      fetch: async () => {
        calls.fetch++
        return { ok: false, status: 500 }
      }
    })
    const t = new Transport('https://t/collect', deps)
    expect(await t.send(payload)).toBe(false)
    expect(calls.xhr).toBe(0)
  })

  it('无 beacon/fetch 时落到 XHR', async () => {
    const { calls, deps } = makeDeps({ beacon: undefined, fetch: undefined })
    const t = new Transport('https://t/collect', deps)
    expect(await t.send(payload, { preferBeacon: true })).toBe(true)
    expect(calls).toMatchObject({ beacon: 0, fetch: 0, xhr: 1 })
  })

  it('body 超阈值走 gzip 并带 Content-Encoding', async () => {
    const seen: { headers?: Record<string, string>; isBuffer?: boolean } = {}
    const { deps } = makeDeps({
      gzip: async (body) => {
        const buf = new TextEncoder().encode(`gz:${body}`).buffer as ArrayBuffer
        return buf
      },
      fetch: async (_url, init) => {
        seen.headers = init.headers
        seen.isBuffer = init.body instanceof ArrayBuffer
        return { ok: true, status: 204 }
      }
    })
    const t = new Transport('https://t/collect', deps)
    const big = { data: 'x'.repeat(4096) }
    expect(await t.send(big)).toBe(true)
    expect(seen.headers?.['Content-Encoding']).toBe('gzip')
    expect(seen.isBuffer).toBe(true)
  })

  it('beacon 不用于超 60KB 的 body，直接 fetch', async () => {
    const { calls, deps } = makeDeps()
    const t = new Transport('https://t/collect', deps)
    const big = { data: 'x'.repeat(61 * 1024) }
    expect(await t.send(big, { preferBeacon: true })).toBe(true)
    expect(calls.beacon).toBe(0)
    expect(calls.fetch).toBe(1)
  })

  it('getHeaders 注入的额外请求头合并进 fetch/xhr', async () => {
    const seen: Record<string, string> = {}
    const { deps } = makeDeps({
      fetch: async (_url, init) => {
        Object.assign(seen, init.headers)
        return { ok: true, status: 204 }
      }
    })
    const t = new Transport('https://t/collect', deps, () => ({ Authorization: 'Bearer token-1' }))
    await t.send(payload)
    expect(seen.Authorization).toBe('Bearer token-1')
  })
})
