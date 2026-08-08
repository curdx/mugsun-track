import type { PluginContext, Props, TrackPlugin } from '../types'

/**
 * $web_vitals：PerformanceObserver 采集 LCP/INP/CLS/FCP/TTFB/longtask，
 * 页面首次隐藏/关闭时一次性上报（beacon 冲刷）；上报形态为逐指标事件 {metric, value}
 * （与服务端直方图聚合口径一致），longtask 统计随首条捎带。
 * 无 PerformanceObserver 的环境静默跳过。
 */
export function webVitalsPlugin(): TrackPlugin {
  return {
    name: 'web-vitals',
    setup(ctx: PluginContext) {
      if (typeof window === 'undefined' || typeof PerformanceObserver === 'undefined') return
      const { client } = ctx

      const metrics: Props = {}
      let longtaskCount = 0
      let longtaskTotal = 0
      let emitted = false
      const observers: PerformanceObserver[] = []
      const supported: readonly string[] = PerformanceObserver.supportedEntryTypes ?? []

      const observe = (
        type: string,
        cb: (entries: PerformanceEntry[]) => void,
        buffered = true
      ) => {
        if (!supported.includes(type)) return
        try {
          const po = new PerformanceObserver((list) => cb(list.getEntries()))
          po.observe({ type, buffered })
          observers.push(po)
        } catch {
          // 个别实现支持列表与实际行为不一致，跳过即可
        }
      }

      observe('largest-contentful-paint', (entries) => {
        const last = entries[entries.length - 1]
        if (last) metrics.lcp = Math.round(last.startTime)
      })
      observe('event', (entries) => {
        // INP 近似：取最长交互耗时（Event Timing 需 durationThreshold）
        for (const e of entries) {
          const duration = (e as PerformanceEventTiming).duration
          if (duration > ((metrics.inp as number) ?? 0)) metrics.inp = Math.round(duration)
        }
      })
      observe('layout-shift', (entries) => {
        let cls = (metrics.cls as number) ?? 0
        for (const e of entries) {
          const shift = e as PerformanceEntry & { hadRecentInput?: boolean; value?: number }
          if (!shift.hadRecentInput) cls += shift.value ?? 0
        }
        metrics.cls = Math.round(cls * 1000) / 1000
      })
      observe('paint', (entries) => {
        for (const e of entries) {
          if (e.name === 'first-contentful-paint') metrics.fcp = Math.round(e.startTime)
        }
      })
      observe('navigation', (entries) => {
        const nav = entries[0] as PerformanceNavigationTiming | undefined
        if (nav) metrics.ttfb = Math.round(nav.responseStart)
      })
      observe('longtask', (entries) => {
        for (const e of entries) {
          longtaskCount++
          longtaskTotal += e.duration
        }
      })

      const emit = () => {
        if (emitted) return
        emitted = true
        // 服务端直方图按 props.metric/props.value 逐指标聚合：一指标一事件；
        // longtask 统计服务端不聚合，随首条指标事件捎带留存于 props
        const extra: Props = {}
        if (longtaskCount > 0) {
          extra.longtask_count = longtaskCount
          extra.longtask_total_ms = Math.round(longtaskTotal)
        }
        let sent = false
        for (const metric of ['lcp', 'inp', 'cls', 'fcp', 'ttfb'] as const) {
          const value = metrics[metric]
          if (typeof value !== 'number') continue
          client.track('$web_vitals', { metric, value, ...(sent ? {} : extra) })
          sent = true
        }
        if (!sent && longtaskCount > 0) {
          client.track('$web_vitals', extra)
        }
        if (sent || longtaskCount > 0) void client.flushBeacon()
      }

      const onVisibility = () => {
        if (document.visibilityState === 'hidden') emit()
      }
      if (typeof document !== 'undefined') {
        document.addEventListener('visibilitychange', onVisibility, { passive: true })
      }
      window.addEventListener('pagehide', emit)

      return () => {
        for (const po of observers) po.disconnect()
        if (typeof document !== 'undefined') {
          document.removeEventListener('visibilitychange', onVisibility)
        }
        window.removeEventListener('pagehide', emit)
      }
    }
  }
}
