import type { TrackClient } from './core/client'

/** 事件自定义属性 */
export type Props = Record<string, unknown>

/** 线上协议单条事件（见 TRACK-PLAN §5.1/§10） */
export interface TrackEvent {
  event_id: string
  event: string
  /** 客户端原始时间（毫秒），服务端存 client_ts，校时在服务端完成 */
  ts: number
  /** 恒为 anonymous_id */
  distinct_id: string
  /** identify 后的登录用户；未登录为 null，服务端按 token 裁定 */
  user_id: string | number | null
  session_id: string
  props: Props
}

/** 批量上报体 */
export interface TrackPayload {
  app_key: string
  schema_version: string
  sdk: { platform: string; version: string }
  sent_at: number
  events: TrackEvent[]
}

/** GET /track/config 下发内容（R 信封 data 内，camelCase 与后端约定；下次启动生效） */
export interface RemoteConfig {
  sampleRate?: number
  enabled?: number | boolean
  maskSelectors?: string[] | string
  /** 回放总开关（0/1 或 boolean），G100 */
  replayEnabled?: number | boolean
  /** 回放会话采样率 0-100，G100 */
  replaySampleRate?: number
  /** 接口监控总开关（0/1 或 boolean），G102 */
  apiMonitorEnabled?: number | boolean
  /** 响应体采集开关（0/1 或 boolean），G102 */
  apiBodyEnabled?: number | boolean
  /** 响应体业务字段脱敏开关（0/1 或 boolean），G102 */
  apiBodyMaskEnabled?: number | boolean
  /** 响应体安全阀（字节），G102 */
  apiBodyMaxBytes?: number
  [key: string]: unknown
}

/** 同步 KV 抽象：浏览器 = localStorage，测试/node = 内存实现 */
export interface KeyValueStore {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

/** 队列持久化抽象：浏览器 = IndexedDB，测试/node = 内存实现 */
export interface QueueStore {
  load(appKey: string): Promise<TrackEvent[]>
  put(appKey: string, events: TrackEvent[]): Promise<void>
  remove(appKey: string, eventIds: string[]): Promise<void>
  clear(appKey: string): Promise<void>
}

export interface Clock {
  now(): number
}

export interface PluginContext {
  client: TrackClient
  options: ResolvedTrackOptions
  log: (...args: unknown[]) => void
}

/** 插件接口：setup 返回可选 teardown。replay 等后续插件按同一契约接入 */
export interface TrackPlugin {
  name: string
  setup(ctx: PluginContext): void | (() => void)
}

/**
 * 会话回放控制面（G100）：replay 插件 setup 时挂到 client.replay，teardown 摘除。
 * $error 强传与 pagehide 收尾块由插件内部钩子自动触发，外部一般无需调用；
 * 该挂载点供调试/测试与上层定制场景手动控制。
 */
export interface ReplayController {
  /** 无视采样强制上传本会话已录缓冲 */
  forceUpload(): void
  /** 立即切收尾块并 beacon 发送（页面卸载场景） */
  flushFinal(): void
}

/** SPA 路由信息（url_path 原始路径 + route_path 路由模板双写） */
export interface RouteInfo {
  url_path: string
  route_path?: string
  title?: string
}

export interface TrackOptions {
  /** 接入应用标识（浏览器可见，非机密） */
  appKey: string
  /** 服务端地址，collect = `${endpoint}/track/collect` */
  endpoint: string
  /** 应用版本号（构建注入），$error 等事件携带 */
  release?: string
  /** 本地采样率 0-100，默认 100；远端下发优先（下次启动生效） */
  sampleRate?: number
  /** 本地总开关，默认 true */
  enabled?: boolean
  /** 批量触发条数，默认 10 */
  batchSize?: number
  /** 定时触发间隔 ms，默认 5000 */
  flushInterval?: number
  /** 单次请求最大事件数，默认 100 */
  maxBatchSize?: number
  /** 队列容量上限（超出丢最旧），默认 500 */
  queueCapacity?: number
  /** 队列事件超龄丢弃 ms，默认 24h（服务端幂等窗 25h 内） */
  queueMaxAge?: number
  /** 补发退避基数 ms，默认 1000 */
  retryBaseDelay?: number
  /** 补发退避上限 ms，默认 30000 */
  retryMaxDelay?: number
  /** 尊重 Do Not Track，默认 true */
  respectDnt?: boolean
  /** 自动采集屏蔽选择器（与远端下发合并） */
  maskSelectors?: string[]
  /** 回放总开关，默认 false；远端下发 replayEnabled 可开启（下次启动生效）。replay 插件据此常录 */
  replayEnabled?: boolean
  /** 回放会话采样率 0-100，默认 10；远端下发优先（下次启动生效）。只决定上传，录制不受影响 */
  replaySampleRate?: number
  /**
   * 接口监控总开关（api_request 事件元数据），默认关。
   * 本地显式设置强制覆盖远端下发；本地未设置时远端 apiMonitorEnabled 决定（下次启动生效）。
   * api-monitor 插件不在默认插件集，需显式加入 plugins 后本开关才接管启停
   */
  apiMonitorEnabled?: boolean
  /** 响应体采集开关，默认关；优先级同上。仅在 apiMonitorEnabled 开启后生效 */
  apiBodyEnabled?: boolean
  /** 响应体业务字段脱敏开关（内置敏感键清单 → ***），默认关；优先级同上 */
  apiBodyMaskEnabled?: boolean
  /** 响应体安全阀（字节），默认 1MB；优先级同上。超限不采并标 body_skipped=size */
  apiBodyMaxBytes?: number
  /** 会话滑动过期 ms，默认 30min */
  sessionTimeout?: number
  /** 本地存储 key 前缀，默认 mst */
  storagePrefix?: string
  /** 插件列表；缺省由 createTracker 注入默认插件集（api-monitor 不在其中） */
  plugins?: TrackPlugin[]
  /** 是否启动时拉取远端配置，默认 true */
  fetchRemoteConfig?: boolean
  /** 上报额外请求头（如登录态 Authorization，供服务端身份裁定）；beacon 场景无法携带 */
  headers?: Record<string, string> | (() => Record<string, string>)
  debug?: boolean
}

export type ResolvedTrackOptions = Required<
  Pick<
    TrackOptions,
    | 'appKey'
    | 'endpoint'
    | 'sampleRate'
    | 'enabled'
    | 'batchSize'
    | 'flushInterval'
    | 'maxBatchSize'
    | 'queueCapacity'
    | 'queueMaxAge'
    | 'retryBaseDelay'
    | 'retryMaxDelay'
    | 'respectDnt'
    | 'sessionTimeout'
    | 'storagePrefix'
    | 'fetchRemoteConfig'
    | 'replayEnabled'
    | 'replaySampleRate'
    | 'debug'
  >
> &
  Pick<TrackOptions, 'release' | 'headers'> & {
    maskSelectors: string[]
    plugins: TrackPlugin[]
    /**
     * G102 接口监控链四开关：本地显式设置优先（强制覆盖远端下发），未设置时远端缓存配置补齐；
     * 最终缺省（关/关/关/1MB）由 api-monitor 插件兜底
     */
    apiMonitorEnabled?: boolean
    apiBodyEnabled?: boolean
    apiBodyMaskEnabled?: boolean
    apiBodyMaxBytes?: number
  }
