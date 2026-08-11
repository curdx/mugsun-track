import type {
  KeyValueStore,
  RemoteConfig,
  ResolvedTrackOptions,
  TrackOptions,
  VisualRule
} from '../types'
import { CUSTOM_EVENT_NAME_RE, safeParse } from './utils'

export function resolveOptions(options: TrackOptions): ResolvedTrackOptions {
  if (!options.appKey) throw new Error('[track] appKey 必填')
  if (!options.endpoint) throw new Error('[track] endpoint 必填')
  return {
    appKey: options.appKey,
    endpoint: options.endpoint.replace(/\/+$/, ''),
    release: options.release,
    headers: options.headers,
    sampleRate: options.sampleRate ?? 100,
    enabled: options.enabled ?? true,
    batchSize: options.batchSize ?? 10,
    flushInterval: options.flushInterval ?? 5000,
    maxBatchSize: options.maxBatchSize ?? 100,
    queueCapacity: options.queueCapacity ?? 500,
    queueMaxAge: options.queueMaxAge ?? 24 * 60 * 60 * 1000,
    retryBaseDelay: options.retryBaseDelay ?? 1000,
    retryMaxDelay: options.retryMaxDelay ?? 30000,
    respectDnt: options.respectDnt ?? true,
    maskSelectors: [...(options.maskSelectors ?? [])],
    replayEnabled: options.replayEnabled ?? false,
    replaySampleRate: options.replaySampleRate ?? 10,
    // G102 接口监控链四开关：不透传默认值，undefined 留给远端缓存配置补齐（本地显式设置优先）
    apiMonitorEnabled: options.apiMonitorEnabled,
    apiBodyEnabled: options.apiBodyEnabled,
    apiBodyMaskEnabled: options.apiBodyMaskEnabled,
    apiBodyMaxBytes: options.apiBodyMaxBytes,
    // G104 圈选规则：同上，undefined 留给远端缓存配置补齐
    visualRules: options.visualRules,
    sessionTimeout: options.sessionTimeout ?? 30 * 60 * 1000,
    storagePrefix: options.storagePrefix ?? 'mst',
    plugins: options.plugins ?? [],
    fetchRemoteConfig: options.fetchRemoteConfig ?? true,
    debug: options.debug ?? false
  }
}

export type ConfigFetcher = (url: string) => Promise<RemoteConfig | null>

/** 远端开关 0/1 与 boolean 双形态归一（与 replayEnabled 同口径）；非开关形态返回 undefined */
function asBool(v: unknown): boolean | undefined {
  if (v === true || v === 1) return true
  if (v === false || v === 0) return false
  return undefined
}

/** 远端圈选规则过滤（G104）：event/selector 必为字符串且 event 过白名单正则；routePath/matchText 非字符串归 null */
function parseVisualRules(raw: unknown[]): VisualRule[] {
  const out: VisualRule[] = []
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue
    const r = item as Record<string, unknown>
    if (typeof r.event !== 'string' || typeof r.selector !== 'string') continue
    if (!CUSTOM_EVENT_NAME_RE.test(r.event)) continue
    out.push({
      event: r.event,
      selector: r.selector,
      routePath: typeof r.routePath === 'string' ? r.routePath : null,
      matchText: typeof r.matchText === 'string' ? r.matchText : null
    })
  }
  return out
}

/**
 * 远端配置：启动时先用上次缓存的配置生效，再异步拉新配置写缓存 ——
 * 新配置在下次启动生效（会话中途不热更）。
 */
export class RemoteConfigManager {
  constructor(
    private kv: KeyValueStore,
    private storageKey: string,
    private configUrl: string,
    private fetcher: ConfigFetcher | null
  ) {}

  /** 上次启动缓存的配置（本次生效） */
  cached(): RemoteConfig | null {
    return safeParse<RemoteConfig>(this.kv.getItem(this.storageKey))
  }

  /** 把缓存配置应用到 options（采样率/总开关/屏蔽选择器/回放配置；字段名与后端 camelCase 约定） */
  applyTo(options: ResolvedTrackOptions): void {
    const cfg = this.cached()
    if (!cfg) return
    if (typeof cfg.sampleRate === 'number') {
      options.sampleRate = Math.min(100, Math.max(0, cfg.sampleRate))
    }
    if (cfg.enabled === false || cfg.enabled === 0) {
      options.enabled = false
    }
    // 回放开关双向生效（G100 由后端开启）；采样率同主采样口径收拢 0-100
    if (cfg.replayEnabled === true || cfg.replayEnabled === 1) {
      options.replayEnabled = true
    }
    if (cfg.replayEnabled === false || cfg.replayEnabled === 0) {
      options.replayEnabled = false
    }
    if (typeof cfg.replaySampleRate === 'number') {
      options.replaySampleRate = Math.min(100, Math.max(0, cfg.replaySampleRate))
    }
    // G102 接口监控链：本地显式设置优先，未设置（undefined）时由远端下发补齐，双向可开关
    if (options.apiMonitorEnabled === undefined) {
      const v = asBool(cfg.apiMonitorEnabled)
      if (v !== undefined) options.apiMonitorEnabled = v
    }
    if (options.apiBodyEnabled === undefined) {
      const v = asBool(cfg.apiBodyEnabled)
      if (v !== undefined) options.apiBodyEnabled = v
    }
    if (options.apiBodyMaskEnabled === undefined) {
      const v = asBool(cfg.apiBodyMaskEnabled)
      if (v !== undefined) options.apiBodyMaskEnabled = v
    }
    if (
      options.apiBodyMaxBytes === undefined &&
      typeof cfg.apiBodyMaxBytes === 'number' &&
      cfg.apiBodyMaxBytes > 0
    ) {
      options.apiBodyMaxBytes = Math.floor(cfg.apiBodyMaxBytes)
    }
    // G104 圈选规则：本地显式设置优先，未设置（undefined）时远端下发补齐；非法项过滤
    if (options.visualRules === undefined && Array.isArray(cfg.visualRules)) {
      options.visualRules = parseVisualRules(cfg.visualRules)
    }
    const masks = Array.isArray(cfg.maskSelectors)
      ? cfg.maskSelectors
      : typeof cfg.maskSelectors === 'string'
        ? cfg.maskSelectors.split(',')
        : []
    for (const m of masks) {
      const trimmed = String(m).trim()
      if (trimmed && !options.maskSelectors.includes(trimmed)) options.maskSelectors.push(trimmed)
    }
  }

  /** 异步拉取并写缓存（本次不生效） */
  refresh(): void {
    if (!this.fetcher) return
    void this.fetcher(this.configUrl)
      .then((cfg) => {
        if (cfg && typeof cfg === 'object') {
          try {
            this.kv.setItem(this.storageKey, JSON.stringify(cfg))
          } catch {
            // 存储失败则下次启动无缓存，无妨
          }
        }
      })
      .catch(() => {
        // 配置拉取失败不影响采集
      })
  }
}
