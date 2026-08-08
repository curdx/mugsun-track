import type { ClientDeps } from '../src/core/client'
import { TrackClient } from '../src/core/client'
import { MemoryKeyValueStore, MemoryQueueStore } from '../src/core/storage'
import { Transport, type TransportDeps } from '../src/core/transport'
import type { Props, TrackOptions, TrackPayload } from '../src/types'

/** 可控假时钟 */
export class FakeClock {
  t = 1_700_000_000_000
  now(): number {
    return this.t
  }
  advance(ms: number): void {
    this.t += ms
  }
}

export interface SendRecord {
  payload: TrackPayload
  preferBeacon: boolean
}

/** 录制所有发送的 transport 依赖；fail=true 时 fetch 返回 503；throwOnFetch 时抛错走降级 */
export function recordingTransport() {
  const sent: SendRecord[] = []
  const attempts: SendRecord[] = []
  const state = { fail: false, throwOnFetch: false }
  const deps: TransportDeps = {
    fetch: async (_url, init) => {
      const payload = JSON.parse(
        typeof init.body === 'string' ? init.body : new TextDecoder().decode(init.body)
      ) as TrackPayload
      attempts.push({ payload, preferBeacon: init.keepalive })
      if (state.throwOnFetch) throw new Error('network down')
      if (state.fail) return { ok: false, status: 503 }
      sent.push({ payload, preferBeacon: init.keepalive })
      return { ok: true, status: 204 }
    }
  }
  const transport = new Transport('https://t.example.com/track/collect', deps)
  return { sent, attempts, state, transport }
}

export interface TestClient {
  client: TrackClient
  kv: MemoryKeyValueStore
  store: MemoryQueueStore
  clock: FakeClock
  sent: SendRecord[]
  attempts: SendRecord[]
  state: { fail: boolean; throwOnFetch: boolean }
  context: Props
}

const liveClients: TrackClient[] = []

/** 测试后统一 destroy，清掉队列定时器 */
export function destroyAllClients(): void {
  for (const c of liveClients.splice(0)) c.destroy()
}

export function createTestClient(
  options: Partial<TrackOptions> = {},
  deps: Partial<ClientDeps> = {},
  context: Props = {}
): TestClient {
  const kv = new MemoryKeyValueStore()
  const store = new MemoryQueueStore()
  const clock = new FakeClock()
  const recording = recordingTransport()
  const client = new TrackClient(
    {
      appKey: 'test-app',
      endpoint: 'https://t.example.com',
      fetchRemoteConfig: false,
      flushInterval: 60_000,
      ...options
    },
    {
      kv,
      queueStore: store,
      transport: recording.transport,
      clock,
      contextProvider: () => ({ ...context }),
      ...deps
    }
  )
  liveClients.push(client)
  return { client, kv, store, clock, context, ...recording }
}

/** 展开 sent 里的全部事件 */
export function allEvents(sent: SendRecord[]) {
  return sent.flatMap((r) => r.payload.events)
}
