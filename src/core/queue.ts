import type { QueueStore, TrackEvent } from '../types'

/** fire-and-forget 持久化调用：失败静默（队列仍在内存，最坏情况是重发，服务端幂等兜底） */
function ignore(p: Promise<unknown>): void {
  p.catch(() => {})
}

export interface EventQueueOptions {
  appKey: string
  store: QueueStore
  /** 内存+持久化容量上限，超出丢最旧 */
  capacity: number
  /** 超龄丢弃 ms */
  maxAge: number
  /** 条数触发阈值 */
  batchSize: number
  /** 定时触发间隔 ms */
  flushInterval: number
  /** 单请求最大条数 */
  maxBatchSize: number
  retryBaseDelay: number
  retryMaxDelay: number
  now: () => number
  /** 实际发送（payload 组装在 client 完成，这里只传事件数组） */
  send: (events: TrackEvent[], opts: { preferBeacon: boolean }) => Promise<boolean>
  onDrop?: (count: number, reason: 'capacity' | 'expired') => void
  log?: (...args: unknown[]) => void
}

/**
 * 批量队列：10 条或 5s 双触发；IndexedDB（抽象）持久化，重启补发；
 * 失败指数退避（base*2^n 封顶）；容量上限丢最旧；超龄丢弃。
 * event_id 全程不变 —— 重发/补发的幂等由服务端按 event_id 去重。
 */
export class EventQueue {
  private events: TrackEvent[] = []
  private inflight: Promise<boolean> | null = null
  private attempts = 0
  private started = false
  private intervalTimer: ReturnType<typeof setInterval> | null = null
  private retryTimer: ReturnType<typeof setTimeout> | null = null
  private restorePromise: Promise<void> | null = null

  constructor(private opts: EventQueueOptions) {}

  /** 启动：恢复持久化事件（去重、超龄丢弃、容量裁剪）后立即尝试补发，并开启定时冲刷 */
  start(): Promise<void> {
    if (this.started) return this.restorePromise ?? Promise.resolve()
    this.started = true
    this.restorePromise = this.restore().then(() => {
      if (this.events.length > 0) void this.flush()
    })
    this.intervalTimer = setInterval(() => void this.flush(), this.opts.flushInterval)
    return this.restorePromise
  }

  add(event: TrackEvent): void {
    if (this.events.length >= this.opts.capacity) {
      const dropped = this.events.shift()
      if (dropped) ignore(this.opts.store.remove(this.opts.appKey, [dropped.event_id]))
      this.opts.onDrop?.(1, 'capacity')
    }
    this.events.push(event)
    ignore(this.opts.store.put(this.opts.appKey, [event]))
    if (this.events.length >= this.opts.batchSize) void this.flush()
  }

  get size(): number {
    return this.events.length
  }

  /** 冲刷：成功则移除已发事件；失败按指数退避安排补发。返回是否全部发完 */
  async flush(flushOpts: { preferBeacon?: boolean } = {}): Promise<boolean> {
    // 有进行中的冲刷时等它落地再冲一轮（期间可能又来了新事件）
    if (this.inflight) {
      await this.inflight.catch(() => false)
      if (this.events.length === 0) return true
    }
    const p = this.doFlush(flushOpts)
    this.inflight = p
    try {
      return await p
    } finally {
      if (this.inflight === p) this.inflight = null
    }
  }

  private async doFlush(flushOpts: { preferBeacon?: boolean }): Promise<boolean> {
    let allSent = true
    if (this.restorePromise) await this.restorePromise
    if (this.events.length === 0) return true
    this.dropExpired()
    while (this.events.length > 0) {
      const batch = this.events.slice(0, this.opts.maxBatchSize)
      const ok = await this.opts.send(batch, { preferBeacon: !!flushOpts.preferBeacon })
      if (!ok) {
        allSent = false
        this.scheduleRetry()
        break
      }
      const sentIds = new Set(batch.map((e) => e.event_id))
      this.events = this.events.filter((e) => !sentIds.has(e.event_id))
      try {
        await this.opts.store.remove(this.opts.appKey, [...sentIds])
      } catch {
        // 持久化清理失败仅导致下次启动重发，服务端按 event_id 幂等去重
      }
      this.attempts = 0
    }
    return allSent
  }

  /** 卸载/隐藏场景：beacon 优先冲刷 */
  async flushBeacon(): Promise<boolean> {
    return this.flush({ preferBeacon: true })
  }

  /** 清空（optOut 时调用）：内存与持久化一并清除 */
  async clearAll(): Promise<void> {
    this.events = []
    try {
      await this.opts.store.clear(this.opts.appKey)
    } catch {
      // 存储不可用则仅清内存
    }
  }

  destroy(): void {
    if (this.intervalTimer) clearInterval(this.intervalTimer)
    if (this.retryTimer) clearTimeout(this.retryTimer)
    this.intervalTimer = null
    this.retryTimer = null
    this.started = false
  }

  private async restore(): Promise<void> {
    let stored: TrackEvent[] = []
    try {
      stored = await this.opts.store.load(this.opts.appKey)
    } catch {
      stored = []
    }
    if (stored.length === 0) return
    const now = this.opts.now()
    const seen = new Set(this.events.map((e) => e.event_id))
    let expired = 0
    const merged: TrackEvent[] = []
    for (const e of stored) {
      if (seen.has(e.event_id)) continue
      if (now - e.ts > this.opts.maxAge) {
        expired++
        continue
      }
      seen.add(e.event_id)
      merged.push(e)
    }
    if (expired > 0) {
      this.opts.onDrop?.(expired, 'expired')
      ignore(
        this.opts.store.remove(
          this.opts.appKey,
          stored.filter((e) => now - e.ts > this.opts.maxAge).map((e) => e.event_id)
        )
      )
    }
    // 持久化的是更早的事件，排在内存事件之前
    this.events = [...merged, ...this.events]
    if (this.events.length > this.opts.capacity) {
      const over = this.events.length - this.opts.capacity
      const dropped = this.events.splice(0, over)
      this.opts.onDrop?.(over, 'capacity')
      ignore(
        this.opts.store.remove(
          this.opts.appKey,
          dropped.map((e) => e.event_id)
        )
      )
    }
    this.opts.log?.(`restored ${merged.length} events from store`)
  }

  private dropExpired(): void {
    const now = this.opts.now()
    const stale = this.events.filter((e) => now - e.ts > this.opts.maxAge)
    if (stale.length === 0) return
    this.events = this.events.filter((e) => now - e.ts <= this.opts.maxAge)
    this.opts.onDrop?.(stale.length, 'expired')
    ignore(
      this.opts.store.remove(
        this.opts.appKey,
        stale.map((e) => e.event_id)
      )
    )
  }

  private scheduleRetry(): void {
    if (this.retryTimer) return
    this.attempts++
    const delay = Math.min(
      this.opts.retryBaseDelay * 2 ** (this.attempts - 1),
      this.opts.retryMaxDelay
    )
    this.opts.log?.(`send failed, retry #${this.attempts} in ${delay}ms`)
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null
      void this.flush()
    }, delay)
  }
}
