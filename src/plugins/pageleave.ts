import type { PluginContext, TrackPlugin } from '../types'
import { getPageTracker } from './page-tracker'

/**
 * $pageleave 兜底：页面隐藏（visibilitychange→hidden）与关闭（pagehide）时，
 * 以 Page Visibility 精确停留时长补发上一页的 $pageleave，并立即 beacon 冲刷。
 * 回到前台后 PageTracker 继续累计，最终路由切换时 pageview 插件再结算剩余时长。
 */
export function pageleavePlugin(): TrackPlugin {
  return {
    name: 'pageleave',
    setup(ctx: PluginContext) {
      if (typeof window === 'undefined' || typeof document === 'undefined') return
      const { client } = ctx
      const tracker = getPageTracker(ctx)

      const leave = () => {
        const duration = tracker.stop()
        if (duration === null) return
        const page = tracker.currentPage()
        client.track('$pageleave', {
          url_path: page?.url_path ?? window.location.pathname,
          route_path: page?.route_path ?? client.getRoutePath(),
          page_title: page?.title ?? document.title,
          duration_ms: duration
        })
        void client.flushBeacon()
      }

      const onVisibility = () => {
        if (document.visibilityState === 'hidden') leave()
      }
      const onPageHide = () => leave()

      document.addEventListener('visibilitychange', onVisibility, { passive: true })
      window.addEventListener('pagehide', onPageHide)
      return () => {
        document.removeEventListener('visibilitychange', onVisibility)
        window.removeEventListener('pagehide', onPageHide)
      }
    }
  }
}
