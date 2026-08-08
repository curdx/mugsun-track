import type { Clock } from '../types'

/**
 * timeEvent：记录事件开始时刻，track 同名事件时带出 duration_ms 并消费。
 * 纯内存实现（页面刷新即失效，计时语义本就限于单次停留）。
 */
export class TimeEventTracker {
  private starts = new Map<string, number>()

  constructor(
    private clock: Clock,
    private maxEntries = 1000
  ) {}

  start(name: string): void {
    if (this.starts.size >= this.maxEntries && !this.starts.has(name)) return
    this.starts.set(name, this.clock.now())
  }

  /** 取出并清除计时，返回时长 ms；未计时返回 null */
  consume(name: string): number | null {
    const start = this.starts.get(name)
    if (start === undefined) return null
    this.starts.delete(name)
    return Math.max(0, this.clock.now() - start)
  }

  cancel(name: string): void {
    this.starts.delete(name)
  }

  clear(): void {
    this.starts.clear()
  }
}
