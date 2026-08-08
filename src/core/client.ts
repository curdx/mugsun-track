import type {
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
  TrackPayload
} from '../types'
import { SCHEMA_VERSION, SDK_PLATFORM, SDK_VERSION } from '../version'
import { RemoteConfigManager, resolveOptions, type ConfigFetcher } from './config'
import { IdentityManager } from './identity'
import { EventQueue } from './queue'
import { isSampled } from './sampler'
import { SessionManager } from './session'
import { TimeEventTracker } from './timeEvent'
import { Transport } from './transport'
import { sanitizeProps, uuid } from './utils'

export interface ClientDeps {
  kv: KeyValueStore
  queueStore: QueueStore
  transport: Transport
  clock: Clock
  /** 浏览器公共属性（url/referrer/UTM/screen 等），core 之外注入 */
  contextProvider?: () => Props
  configFetcher?: ConfigFetcher
  /** DNT 探测，默认false（不启用 DNT 限制）由外层注入真实实现 */
  isDnt?: () => boolean
}

export interface ExposureParams {
  event?: string
  props?: Props
}

const OPTOUT_SUFFIX = 'optout'

export class TrackClient {
  readonly options: ResolvedTrackOptions
  /** 回放插件挂载点（G100）：replay 插件 setup 时注册，teardown 摘除；未加载回放插件时恒为 null */
  replay: ReplayController | null = null

  private identity: IdentityManager
  private session: SessionManager
  private queue: EventQueue
  private timeEvents: TimeEventTracker
  private remoteConfig: RemoteConfigManager
  private superProps: Props = {}
  private sampled: boolean
  private disabled: boolean
  private optedOut: boolean
  private routePathProvider: (() => string | undefined) | null = null
  private routeListeners = new Set<(info: RouteInfo) => void>()
  private sessionListeners = new Set<(sessionId: string | null) => void>()
  private errorListeners = new Set<(props: Props) => void>()
  private exposureDelegate: ((el: Element, params: ExposureParams) => void) | null = null
  private teardowns: Array<() => void> = []
  private contextProvider?: () => Props
  private clock: Clock
  private kv: KeyValueStore
  private transport: Transport

  constructor(options: TrackOptions, deps: ClientDeps) {
    this.options = resolveOptions(options)
    this.clock = deps.clock
    this.contextProvider = deps.contextProvider
    this.kv = deps.kv
    this.transport = deps.transport

    const prefix = `${this.options.storagePrefix}:${this.options.appKey}`

    // 远端配置（上次缓存）先落地到 options
    this.remoteConfig = new RemoteConfigManager(
      deps.kv,
      `${prefix}:config`,
      `${this.options.endpoint}/track/config?app_key=${encodeURIComponent(this.options.appKey)}`,
      deps.configFetcher ?? null
    )
    // 上次启动缓存的远端配置本次先生效；fetchRemoteConfig 只控制是否再拉新配置
    this.remoteConfig.applyTo(this.options)

    this.optedOut = deps.kv.getItem(`${prefix}:${OPTOUT_SUFFIX}`) === '1'
    const dntBlocked = this.options.respectDnt && (deps.isDnt?.() ?? false)
    this.disabled = !this.options.enabled || dntBlocked

    this.identity = new IdentityManager(deps.kv, `${prefix}:identity`)
    this.session = new SessionManager(deps.kv, `${prefix}:session`, this.options.sessionTimeout)
    this.timeEvents = new TimeEventTracker(deps.clock)
    this.sampled = isSampled(
      `${this.options.appKey}:${this.identity.distinctId}`,
      this.options.sampleRate
    )

    this.queue = new EventQueue({
      appKey: this.options.appKey,
      store: deps.queueStore,
      capacity: this.options.queueCapacity,
      maxAge: this.options.queueMaxAge,
      batchSize: this.options.batchSize,
      flushInterval: this.options.flushInterval,
      maxBatchSize: this.options.maxBatchSize,
      retryBaseDelay: this.options.retryBaseDelay,
      retryMaxDelay: this.options.retryMaxDelay,
      now: () => this.clock.now(),
      send: (events, opts) => this.sendBatch(events, opts),
      onDrop: (n, reason) => this.log(`dropped ${n} events (${reason})`),
      log: (...a) => this.log(...a)
    })

    if (!this.disabled) {
      void this.queue.start()
      const ctx: PluginContext = {
        client: this,
        options: this.options,
        log: (...a) => this.log(...a)
      }
      for (const plugin of this.options.plugins) {
        try {
          const teardown = plugin.setup(ctx)
          if (typeof teardown === 'function') this.teardowns.push(teardown)
        } catch (err) {
          this.log(`plugin ${plugin.name} setup failed`, err)
        }
      }
      if (this.options.fetchRemoteConfig) this.remoteConfig.refresh()
    }
  }

  /** 采集自定义事件 */
  track(event: string, props?: Props): void {
    if (!this.canTrack()) return
    const ev = this.buildEvent(event, props)
    this.queue.add(ev)
    // $error 钩子：error 插件、vue errorHandler、手动 track 统一在此出口通知（replay 出错强传）
    if (event === '$error') this.notifyError(ev.props)
  }

  /** 登录绑定：$identify 事件 props 携带 user_id（服务端约定），是否落映射由服务端按 token 裁定 */
  identify(userId: string | number): void {
    if (!this.canTrack()) return
    this.identity.identify(userId)
    this.queue.add(this.buildEvent('$identify', { user_id: userId }))
  }

  /** 登出/切换账号：清空登录身份、更换 anonymous_id、轮换会话 */
  reset(): void {
    this.identity.reset()
    const sessionKey = `${this.options.storagePrefix}:${this.options.appKey}:session`
    // 持久化的旧会话一并失效：否则未过期的旧会话会被新 SessionManager 从 KV 读回复用，
    // 「轮换会话」落空（多标签页共享同 key，登出即整会话轮换）
    this.kv.removeItem(sessionKey)
    this.session = new SessionManager(this.kv, sessionKey, this.options.sessionTimeout)
    this.sampled = isSampled(
      `${this.options.appKey}:${this.identity.distinctId}`,
      this.options.sampleRate
    )
    // 会话失效通知（此时新会话尚未创建，listeners 收到 null）
    this.notifySessionChange(null)
  }

  /** timeEvent：开始计时，track 同名事件时自动带 duration_ms */
  timeEvent(name: string): void {
    this.timeEvents.start(name)
  }

  cancelTimeEvent(name: string): void {
    this.timeEvents.cancel(name)
  }

  registerSuperProperties(props: Props): void {
    Object.assign(this.superProps, props)
  }

  unregisterSuperProperty(key: string): void {
    delete this.superProps[key]
  }

  flush(): Promise<boolean> {
    return this.queue.flush()
  }

  flushBeacon(): Promise<boolean> {
    return this.queue.flushBeacon()
  }

  optOut(): void {
    this.optedOut = true
    try {
      this.kv.setItem(`${this.options.storagePrefix}:${this.options.appKey}:${OPTOUT_SUFFIX}`, '1')
    } catch {
      // 存储失败仅影响持久化
    }
    void this.queue.clearAll()
  }

  optIn(): void {
    this.optedOut = false
    this.kv.removeItem(`${this.options.storagePrefix}:${this.options.appKey}:${OPTOUT_SUFFIX}`)
  }

  isOptedOut(): boolean {
    return this.optedOut
  }

  getDistinctId(): string {
    return this.identity.distinctId
  }

  getUserId(): string | number | null {
    return this.identity.userId
  }

  getSessionId(): string {
    return this.session.touch(this.clock.now()).session.id
  }

  /** 只读当前会话 id（不续期不创建；无会话返回 null）。回放插件启动时首绑用，避免人为续期 */
  peekSessionId(): string | null {
    return this.session.current()?.id ?? null
  }

  /** 会话开始/轮换通知新 id、重置通知 null（replay 重置缓冲与 seq 用） */
  onSessionChange(listener: (sessionId: string | null) => void): () => void {
    this.sessionListeners.add(listener)
    return () => this.sessionListeners.delete(listener)
  }

  /** $error 钩子：会话内出现错误时通知（replay 无视采样强制上传） */
  onError(listener: (props: Props) => void): () => void {
    this.errorListeners.add(listener)
    return () => this.errorListeners.delete(listener)
  }

  isEnabled(): boolean {
    return this.canTrack()
  }

  /** vue-router 集成：提供路由模板（route_path）来源 */
  setRoutePathProvider(provider: (() => string | undefined) | null): void {
    this.routePathProvider = provider
  }

  getRoutePath(): string | undefined {
    return this.routePathProvider?.()
  }

  /** 手动路由模式（vue-router afterEach 驱动） */
  onRouteChange(listener: (info: RouteInfo) => void): () => void {
    this.routeListeners.add(listener)
    return () => this.routeListeners.delete(listener)
  }

  notifyRouteChange(info: RouteInfo): void {
    for (const fn of [...this.routeListeners]) fn(info)
  }

  /** 曝光插件注册观察委托；v-track:exposure 走此通道 */
  setExposureDelegate(fn: ((el: Element, params: ExposureParams) => void) | null): void {
    this.exposureDelegate = fn
  }

  trackExposure(el: Element, params: ExposureParams): void {
    if (!this.canTrack()) return
    if (this.exposureDelegate) this.exposureDelegate(el, params)
    else this.log('exposure 插件未启用，trackExposure 忽略')
  }

  get queueSize(): number {
    return this.queue.size
  }

  log(...args: unknown[]): void {
    if (this.options.debug) console.log('[track]', ...args)
  }

  destroy(): void {
    for (const fn of this.teardowns.splice(0)) {
      try {
        fn()
      } catch {
        // teardown 失败忽略
      }
    }
    this.routeListeners.clear()
    this.exposureDelegate = null
    this.queue.destroy()
  }

  // ---------------------------------------------------------------- internal

  private canTrack(): boolean {
    return !this.disabled && !this.optedOut && this.sampled
  }

  private notifySessionChange(sessionId: string | null): void {
    for (const fn of [...this.sessionListeners]) fn(sessionId)
  }

  private notifyError(props: Props): void {
    for (const fn of [...this.errorListeners]) fn(props)
  }

  private buildEvent(event: string, props?: Props): TrackEvent {
    const now = this.clock.now()
    const { session, isNew, expired } = this.session.touch(now)

    // 会话轮换：先发旧会话 $session_end（ts 取旧会话最后活动时刻），再发新会话 $session_start
    if (expired) {
      this.queue.add(
        this.makeEvent(
          '$session_end',
          { duration_ms: expired.lastActivity - expired.startAt },
          expired.id,
          expired.lastActivity
        )
      )
    }
    if (isNew) {
      this.queue.add(this.makeEvent('$session_start', undefined, session.id, now))
      // 首次建会与轮换都走这里（expired 蕴含 isNew）；回放插件据此重置缓冲与 seq
      this.notifySessionChange(session.id)
    }

    return this.makeEvent(event, props, session.id, now)
  }

  private makeEvent(
    event: string,
    props: Props | undefined,
    sessionId: string,
    ts: number
  ): TrackEvent {
    const merged: Props = {
      ...this.commonProps(),
      ...this.superProps,
      ...props
    }
    const duration = this.timeEvents.consume(event)
    if (duration !== null && merged.duration_ms === undefined) merged.duration_ms = duration
    return {
      event_id: uuid(),
      event,
      ts,
      distinct_id: this.identity.distinctId,
      user_id: this.identity.userId,
      session_id: sessionId,
      props: sanitizeProps(merged)
    }
  }

  private commonProps(): Props {
    const base = this.contextProvider?.() ?? {}
    const routePath = this.getRoutePath()
    if (routePath && base.route_path === undefined) base.route_path = routePath
    if (this.options.release && base.release === undefined) base.release = this.options.release
    return base
  }

  private sendBatch(events: TrackEvent[], opts: { preferBeacon: boolean }): Promise<boolean> {
    const payload: TrackPayload = {
      app_key: this.options.appKey,
      schema_version: SCHEMA_VERSION,
      sdk: { platform: SDK_PLATFORM, version: SDK_VERSION },
      sent_at: this.clock.now(),
      events
    }
    return this.transport.send(payload, opts)
  }
}
