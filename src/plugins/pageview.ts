import type { PluginContext, RouteInfo, TrackPlugin } from '../types'
import { getPageTracker, type PageTracker } from './page-tracker'

export interface PageviewPluginOptions {
  /**
   * 手动路由模式：不 hook history，由 client.notifyRouteChange() 驱动
   * （vue-router 集成时开启，afterEach 里能拿到 matched 路由模板）
   */
  manual?: boolean
}

/**
 * $pageview：SPA 路由配对 —— 路由切换 = 上一页 $pageleave（带 duration_ms）→ 新页 $pageview。
 * 首屏只有 pageview；页面关闭/隐藏的兜底 pageleave 由 pageleave 插件负责。
 */
export function pageviewPlugin(opts: PageviewPluginOptions = {}): TrackPlugin {
  return {
    name: 'pageview',
    setup(ctx: PluginContext) {
      if (typeof window === 'undefined' || typeof document === 'undefined') return
      const { client } = ctx
      const tracker: PageTracker = getPageTracker(ctx)
      let current: RouteInfo | null = null
      // 页面身份 = pathname + hash（hash 模式路由的路径在 hash 里；query 变化不算切页）
      let currentKey = ''

      const pageKey = () => `${window.location.pathname}${window.location.hash}`

      const emitView = (info: RouteInfo, key: string) => {
        if (current && key === currentKey) {
          // 同页：仅补全 route_path（如手动模式后到模板），不重复上报、不打断计时
          current = { ...current, route_path: info.route_path ?? current.route_path }
          tracker.update(current)
          return
        }
        if (current) {
          const duration = tracker.stop()
          if (duration !== null) {
            client.track('$pageleave', {
              url_path: current.url_path,
              route_path: current.route_path,
              page_title: current.title,
              duration_ms: duration
            })
          }
        }
        client.track('$pageview', {
          url_path: info.url_path,
          route_path: info.route_path,
          page_title: info.title
        })
        tracker.start(info)
        current = info
        currentKey = key
      }

      const fromLocation = (): RouteInfo => ({
        url_path: window.location.pathname,
        route_path: client.getRoutePath(),
        title: document.title
      })

      emitView(fromLocation(), pageKey())

      if (opts.manual) {
        return client.onRouteChange((info) => emitView(info, info.url_path))
      }

      // 自动模式：history hook + popstate/hashchange
      let lastUrl = window.location.href
      let timer: ReturnType<typeof setTimeout> | null = null
      const onNav = () => {
        if (window.location.href === lastUrl) return
        lastUrl = window.location.href
        // 等一拍让 document.title 与路由状态落定
        if (timer) clearTimeout(timer)
        timer = setTimeout(() => {
          timer = null
          emitView(fromLocation(), pageKey())
        }, 0)
      }
      const wrap = (type: 'pushState' | 'replaceState') => {
        const orig = window.history[type]
        window.history[type] = function (this: History, ...args: Parameters<History['pushState']>) {
          const ret = orig.apply(this, args)
          onNav()
          return ret
        } as History[typeof type]
      }
      wrap('pushState')
      wrap('replaceState')
      window.addEventListener('popstate', onNav)
      window.addEventListener('hashchange', onNav)

      return () => {
        window.removeEventListener('popstate', onNav)
        window.removeEventListener('hashchange', onNav)
        if (timer) clearTimeout(timer)
      }
    }
  }
}
