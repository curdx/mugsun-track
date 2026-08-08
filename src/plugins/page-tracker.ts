import type { PluginContext, RouteInfo } from '../types'

/**
 * 页面可见时长计时器：Page Visibility 精确停表（切后台暂停、回前台继续）。
 * pageview 与 pageleave 插件通过 WeakMap 共享同一实例：
 * pageview 路由切换时 stop() 取时长，pageleave 在 hidden/pagehide 时兜底。
 */
export class PageTracker {
  private accumulated = 0
  private startedAt: number | null = null
  private running = false
  private current: RouteInfo | null = null

  constructor(
    private nowFn: () => number,
    private isVisible: () => boolean
  ) {}

  /** 开始新页面段的计时（路由切换/回到前台时调用） */
  start(info: RouteInfo): void {
    this.current = info
    this.accumulated = 0
    this.startedAt = null
    this.running = false
    if (this.isVisible()) {
      this.startedAt = this.nowFn()
      this.running = true
    }
  }

  /** 同 URL 仅更新页面信息（如后到的路由模板），不打断计时 */
  update(info: RouteInfo): void {
    this.current = info
  }

  /** 同页回到前台：继续累计（不重置已有时长） */
  resume(): void {
    if (!this.current) return
    if (!this.running) {
      this.startedAt = this.nowFn()
      this.running = true
    }
  }

  pause(): void {
    if (this.running && this.startedAt !== null) {
      this.accumulated += this.nowFn() - this.startedAt
      this.running = false
      this.startedAt = null
    }
  }

  /** 结束当前页面段，返回可见时长 ms；无在计时段返回 null（避免重复 pageleave） */
  stop(): number | null {
    if (!this.current) return null
    this.pause()
    const duration = this.accumulated
    this.accumulated = 0
    return duration
  }

  currentPage(): RouteInfo | null {
    return this.current
  }
}

const trackers = new WeakMap<object, { tracker: PageTracker; wired: boolean }>()

/** 每个 client 共享一个 PageTracker，并挂一次 visibilitychange 停表/续表 */
export function getPageTracker(ctx: PluginContext): PageTracker {
  let entry = trackers.get(ctx.client)
  if (!entry) {
    const tracker = new PageTracker(
      () => Date.now(),
      () => typeof document === 'undefined' || document.visibilityState === 'visible'
    )
    entry = { tracker, wired: false }
    trackers.set(ctx.client, entry)
  }
  if (!entry.wired && typeof document !== 'undefined') {
    entry.wired = true
    document.addEventListener(
      'visibilitychange',
      () => {
        if (document.visibilityState === 'hidden') entry.tracker.pause()
        else entry.tracker.resume()
      },
      { passive: true }
    )
  }
  return entry.tracker
}
