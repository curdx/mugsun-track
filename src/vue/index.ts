import type { App, InjectionKey } from 'vue'
import type { TrackClient } from '../core/client'
import { createTracker, defaultPlugins } from '../index'
import { fingerprintOf } from '../plugins/error'
import { pageviewPlugin, type PageviewPluginOptions } from '../plugins/pageview'
import { pageleavePlugin } from '../plugins/pageleave'
import { autocapturePlugin } from '../plugins/autocapture'
import { exposurePlugin } from '../plugins/exposure'
import { webVitalsPlugin } from '../plugins/web-vitals'
import { errorPlugin } from '../plugins/error'
import type { TrackOptions, TrackPlugin } from '../types'
import { createTrackDirective } from './directive'

/** 结构化最小路由类型，避免强依赖 vue-router 包 */
export interface RouteLike {
  path: string
  fullPath?: string
  matched?: Array<{ path: string }>
  meta?: Record<string, unknown>
}

export interface RouterLike {
  currentRoute: { value: RouteLike }
  afterEach(hook: (to: RouteLike, from: RouteLike) => void): void
}

export interface VueTrackOptions extends TrackOptions {
  /** 传入 vue-router 实例即启用路由集成：route_path 模板 + afterEach 驱动路由配对 */
  router?: RouterLike
}

export const TRACK_INJECT_KEY: InjectionKey<TrackClient> = Symbol('mugsun-track')

/** 取 matched 叶子记录的路径模板（/user/:id/detail），无 matched 退回当前 path */
function routePathOf(route: RouteLike | undefined): string | undefined {
  if (!route) return undefined
  if (route.matched && route.matched.length > 0) {
    return route.matched[route.matched.length - 1]?.path
  }
  return route.path
}

function buildPlugins(router: RouterLike | undefined): TrackPlugin[] {
  if (!router) return defaultPlugins()
  const pageviewOpts: PageviewPluginOptions = { manual: true }
  return [
    pageviewPlugin(pageviewOpts),
    pageleavePlugin(),
    autocapturePlugin(),
    exposurePlugin(),
    webVitalsPlugin(),
    errorPlugin()
  ]
}

/**
 * Vue 集成：
 *   app.use(MugsunTrack, { endpoint, appKey, router, release })
 * - provide(TRACK_INJECT_KEY) + $track 全局属性
 * - v-track 指令（click/exposure）
 * - app.config.errorHandler 挂接 $error（链式保留原 handler）
 * - router 存在时：pageview 切手动模式，afterEach 驱动路由配对，route_path 取自 matched 模板
 */
export function install(app: App, options: VueTrackOptions): void {
  const router = options.router
  const client = createTracker({
    ...options,
    plugins: options.plugins ?? buildPlugins(router)
  })

  app.provide(TRACK_INJECT_KEY, client)
  app.config.globalProperties.$track = client
  app.directive(
    'track',
    createTrackDirective(() => client)
  )

  const prevErrorHandler = app.config.errorHandler
  app.config.errorHandler = (err, instance, info) => {
    try {
      const message = err instanceof Error ? err.message : String(err)
      const stack = err instanceof Error ? err.stack : undefined
      client.track('$error', {
        error_type: 'vue',
        message,
        stack,
        vue_info: info,
        release: client.options.release,
        error_fingerprint: fingerprintOf(message, stack)
      })
    } finally {
      prevErrorHandler?.(err, instance, info)
    }
  }

  if (router) {
    client.setRoutePathProvider(() => routePathOf(router.currentRoute.value))
    router.afterEach((to) => {
      client.notifyRouteChange({
        url_path: to.path,
        route_path: routePathOf(to),
        title: typeof document === 'undefined' ? undefined : document.title
      })
    })
  }
}

export const MugsunTrack = { install }
export default MugsunTrack
