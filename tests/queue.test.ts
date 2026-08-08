import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EventQueue, type EventQueueOptions } from '../src/core/queue'
import { MemoryQueueStore } from '../src/core/storage'
import type { TrackEvent } from '../src/types'
import { FakeClock } from './helpers'

function ev(id: string, ts?: number): TrackEvent {
  return {
    event_id: id,
    event: 'test',
    ts: ts ?? 1_700_000_000_000,
    distinct_id: 'anon',
    user_id: null,
    session_id: 'sess',
    props: {}
  }
}

interface Setup {
  queue: EventQueue
  store: MemoryQueueStore
  clock: FakeClock
  sent: TrackEvent[][]
  state: { fail: boolean }
}

function setup(overrides: Partial<EventQueueOptions> = {}): Setup {
  const store = new MemoryQueueStore()
  const clock = new FakeClock()
  const sent: TrackEvent[][] = []
  const state = { fail: false }
  const queue = new EventQueue({
    appKey: 'app',
    store,
    capacity: 5,
    maxAge: 24 * 3600 * 1000,
    batchSize: 3,
    flushInterval: 5000,
    maxBatchSize: 100,
    retryBaseDelay: 1000,
    retryMaxDelay: 8000,
    now: () => clock.now(),
    send: async (events) => {
      if (state.fail) return false
      sent.push([...events])
      return true
    },
    ...overrides
  })
  return { queue, store, clock, sent, state }
}

describe('EventQueue', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('达到批量阈值立即触发发送', async () => {
    const { queue, sent } = setup()
    await queue.start()
    queue.add(ev('a'))
    queue.add(ev('b'))
    expect(sent).toHaveLength(0)
    queue.add(ev('c'))
    await vi.advanceTimersByTimeAsync(0)
    expect(sent).toHaveLength(1)
    expect(sent[0]!.map((e) => e.event_id)).toEqual(['a', 'b', 'c'])
    queue.destroy()
  })

  it('未满阈值时按 5s 定时触发', async () => {
    const { queue, sent } = setup()
    await queue.start()
    queue.add(ev('a'))
    await vi.advanceTimersByTimeAsync(4999)
    expect(sent).toHaveLength(0)
    await vi.advanceTimersByTimeAsync(1)
    expect(sent).toHaveLength(1)
    queue.destroy()
  })

  it('容量上限：超出丢最旧', async () => {
    const { queue, sent } = setup({ batchSize: 100, capacity: 5 })
    await queue.start()
    for (let i = 0; i < 7; i++) queue.add(ev(`e${i}`))
    expect(queue.size).toBe(5)
    await queue.flush()
    expect(sent.flat().map((e) => e.event_id)).toEqual(['e2', 'e3', 'e4', 'e5', 'e6'])
    queue.destroy()
  })

  it('持久化恢复：重启后补发且 event_id 稳定', async () => {
    const store = new MemoryQueueStore()
    await store.put('app', [ev('old-1'), ev('old-2')])
    const { queue, sent } = setup({ store })
    await queue.start()
    await vi.advanceTimersByTimeAsync(0)
    expect(sent.length).toBeGreaterThan(0)
    const ids = sent.flat().map((e) => e.event_id)
    expect(ids).toContain('old-1')
    expect(ids).toContain('old-2')
    // 发送成功后持久化清除
    expect(await store.load('app')).toHaveLength(0)
    queue.destroy()
  })

  it('恢复时超龄事件丢弃', async () => {
    const store = new MemoryQueueStore()
    const clock = new FakeClock()
    await store.put('app', [ev('stale', clock.now() - 25 * 3600 * 1000), ev('fresh', clock.now())])
    const dropped: number[] = []
    const { queue, sent } = setup({
      store,
      now: () => clock.now(),
      onDrop: (n, reason) => reason === 'expired' && dropped.push(n)
    })
    await queue.start()
    await vi.advanceTimersByTimeAsync(0)
    expect(sent.length).toBeGreaterThan(0)
    const ids = sent.flat().map((e) => e.event_id)
    expect(ids).toEqual(['fresh'])
    expect(dropped.reduce((a, b) => a + b, 0)).toBe(1)
    queue.destroy()
  })

  it('失败指数退避补发：1s/2s/4s，成功后重置', async () => {
    const { queue, sent, state } = setup()
    await queue.start()
    state.fail = true
    queue.add(ev('a'))
    queue.add(ev('b'))
    queue.add(ev('c'))
    // 阈值触发 flush → 失败 → 1s 后重试
    await vi.advanceTimersByTimeAsync(0)
    expect(sent).toHaveLength(0)
    await vi.advanceTimersByTimeAsync(999)
    expect(sent).toHaveLength(0)
    await vi.advanceTimersByTimeAsync(1) // 第 1 次重试（1s）失败
    await vi.advanceTimersByTimeAsync(1999)
    expect(sent).toHaveLength(0)
    state.fail = false
    await vi.advanceTimersByTimeAsync(1) // 到达 2s 重试点，成功
    expect(sent).toHaveLength(1)
    expect(sent[0]!.map((e) => e.event_id)).toEqual(['a', 'b', 'c'])
    queue.destroy()
  })

  it('退避上限封顶 retryMaxDelay', async () => {
    const { queue, state } = setup({ retryBaseDelay: 1000, retryMaxDelay: 3000 })
    await queue.start()
    state.fail = true
    queue.add(ev('a'))
    queue.add(ev('b'))
    queue.add(ev('c'))
    for (let i = 0; i < 5; i++) await vi.advanceTimersByTimeAsync(3000)
    state.fail = false
    await vi.advanceTimersByTimeAsync(3000)
    expect(queue.size).toBe(0)
    queue.destroy()
  })

  it('恢复与内存事件按 event_id 去重', async () => {
    const store = new MemoryQueueStore()
    await store.put('app', [ev('dup'), ev('other')])
    const { queue, sent } = setup({ store, batchSize: 100 })
    const startPromise = queue.start()
    queue.add(ev('dup')) // 恢复完成前先进入内存队列
    await startPromise
    await queue.flush()
    const ids = sent.flat().map((e) => e.event_id)
    expect(ids.filter((id) => id === 'dup')).toHaveLength(1)
    expect(ids).toContain('other')
    queue.destroy()
  })
})
