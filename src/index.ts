import {
  browserContextProvider,
  browserIsDnt,
  createBrowserKv,
  createBrowserTransportDeps,
  defaultConfigFetcher,
  IdbQueueStore
} from './adapters'
import { TrackClient } from './core/client'
import { SystemClock } from './core/clock'
import { MemoryQueueStore } from './core/storage'
import { Transport } from './core/transport'
import { autocapturePlugin } from './plugins/autocapture'
import { apiMonitorPlugin } from './plugins/api-monitor'
import { errorPlugin } from './plugins/error'
import { exposurePlugin } from './plugins/exposure'
import { pageleavePlugin } from './plugins/pageleave'
import { pageviewPlugin } from './plugins/pageview'
import { webVitalsPlugin } from './plugins/web-vitals'
import type { TrackOptions, TrackPlugin } from './types'

/** 默认插件集：api-monitor 默认关闭，需显式加入 */
export function defaultPlugins(): TrackPlugin[] {
  return [
    pageviewPlugin(),
    pageleavePlugin(),
    autocapturePlugin(),
    exposurePlugin(),
    webVitalsPlugin(),
    errorPlugin()
  ]
}

/**
 * 浏览器环境一键初始化：装配 localStorage / IndexedDB / 传输降级链 / 公共属性，
 * hidden 与 pagehide 时自动 beacon 冲刷。
 */
export function createTracker(options: TrackOptions): TrackClient {
  const endpoint = options.endpoint.replace(/\/+$/, '')
  const getHeaders = (): Record<string, string> => {
    const h = options.headers
    return typeof h === 'function' ? h() : (h ?? {})
  }
  const transport = new Transport(
    `${endpoint}/track/collect`,
    createBrowserTransportDeps(),
    getHeaders
  )
  const client = new TrackClient(
    { ...options, plugins: options.plugins ?? defaultPlugins() },
    {
      kv: createBrowserKv(),
      queueStore: typeof indexedDB === 'undefined' ? new MemoryQueueStore() : new IdbQueueStore(),
      transport,
      clock: new SystemClock(),
      contextProvider:
        typeof window === 'undefined' ? undefined : browserContextProvider(options.release),
      configFetcher: defaultConfigFetcher,
      isDnt: browserIsDnt
    }
  )
  if (typeof document !== 'undefined') {
    document.addEventListener(
      'visibilitychange',
      () => {
        if (document.visibilityState === 'hidden') void client.flushBeacon()
      },
      { passive: true }
    )
  }
  if (typeof window !== 'undefined') {
    window.addEventListener('pagehide', () => void client.flushBeacon())
  }
  return client
}

export { TrackClient } from './core/client'
export type { ClientDeps, ExposureParams } from './core/client'
export { Transport } from './core/transport'
export type { TransportDeps } from './core/transport'
export { EventQueue } from './core/queue'
export { SessionManager } from './core/session'
export { IdentityManager } from './core/identity'
export { TimeEventTracker } from './core/timeEvent'
export { MemoryKeyValueStore, MemoryQueueStore } from './core/storage'
export { isSampled } from './core/sampler'
export { SDK_PLATFORM, SDK_VERSION, SCHEMA_VERSION } from './version'
export {
  pageviewPlugin,
  pageleavePlugin,
  autocapturePlugin,
  exposurePlugin,
  webVitalsPlugin,
  errorPlugin,
  apiMonitorPlugin
}
export type { PageviewPluginOptions } from './plugins/pageview'
export { fingerprintOf } from './plugins/error'
export type {
  KeyValueStore,
  PluginContext,
  Props,
  QueueStore,
  RemoteConfig,
  RouteInfo,
  TrackEvent,
  TrackOptions,
  TrackPayload,
  TrackPlugin
} from './types'
