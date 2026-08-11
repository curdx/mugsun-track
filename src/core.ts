/**
 * core 独立入口：纯逻辑、零 DOM 依赖（存储/传输/时钟全部注入）。
 * 体积门禁作用于此入口（gzip ≤ 8KB）；浏览器一键初始化请用主入口的 createTracker。
 */
export { TrackClient } from './core/client'
export type { ClientDeps, ExposureParams } from './core/client'
export { Transport } from './core/transport'
export type { SendResult, TransportDeps, SendOptions } from './core/transport'
export { EventQueue } from './core/queue'
export type { EventQueueOptions } from './core/queue'
export { SessionManager } from './core/session'
export type { SessionState, TouchResult } from './core/session'
export { IdentityManager } from './core/identity'
export { TimeEventTracker } from './core/timeEvent'
export { SystemClock } from './core/clock'
export { MemoryKeyValueStore, MemoryQueueStore } from './core/storage'
export { bucketOf, isSampled } from './core/sampler'
export { RemoteConfigManager, resolveOptions } from './core/config'
export type { ConfigFetcher } from './core/config'
export { SDK_PLATFORM, SDK_VERSION, SCHEMA_VERSION } from './version'
export {
  fnv1a,
  hashHex,
  safeParse,
  sanitizeProps,
  stableStringify,
  truncate,
  uuid
} from './core/utils'
export type {
  Clock,
  KeyValueStore,
  PluginContext,
  Props,
  QueueStore,
  RemoteConfig,
  ReplayController,
  ResolvedTrackOptions,
  RouteInfo,
  TrackEvent,
  TrackOptions,
  TrackPayload,
  TrackPlugin
} from './types'
