import type { KeyValueStore, QueueStore, TrackEvent } from '../types'

/** 内存 KV：node/测试环境默认实现；浏览器端用 localStorage 包装版 */
export class MemoryKeyValueStore implements KeyValueStore {
  private map = new Map<string, string>()

  getItem(key: string): string | null {
    return this.map.has(key) ? (this.map.get(key) as string) : null
  }

  setItem(key: string, value: string): void {
    this.map.set(key, value)
  }

  removeItem(key: string): void {
    this.map.delete(key)
  }
}

/** 内存队列持久化：node 无 IndexedDB 时的替代实现 */
export class MemoryQueueStore implements QueueStore {
  private byApp = new Map<string, Map<string, TrackEvent>>()

  private bucket(appKey: string): Map<string, TrackEvent> {
    let b = this.byApp.get(appKey)
    if (!b) {
      b = new Map()
      this.byApp.set(appKey, b)
    }
    return b
  }

  async load(appKey: string): Promise<TrackEvent[]> {
    return [...this.bucket(appKey).values()]
  }

  async put(appKey: string, events: TrackEvent[]): Promise<void> {
    const b = this.bucket(appKey)
    for (const e of events) b.set(e.event_id, e)
  }

  async remove(appKey: string, eventIds: string[]): Promise<void> {
    const b = this.bucket(appKey)
    for (const id of eventIds) b.delete(id)
  }

  async clear(appKey: string): Promise<void> {
    this.byApp.delete(appKey)
  }
}
