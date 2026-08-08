import type { KeyValueStore, RemoteConfig, ResolvedTrackOptions, TrackOptions } from '../types'
import { safeParse } from './utils'

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
    sessionTimeout: options.sessionTimeout ?? 30 * 60 * 1000,
    storagePrefix: options.storagePrefix ?? 'mst',
    plugins: options.plugins ?? [],
    fetchRemoteConfig: options.fetchRemoteConfig ?? true,
    debug: options.debug ?? false
  }
}

export type ConfigFetcher = (url: string) => Promise<RemoteConfig | null>

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

  /** 把缓存配置应用到 options（采样率/总开关/屏蔽选择器；字段名与后端 camelCase 约定） */
  applyTo(options: ResolvedTrackOptions): void {
    const cfg = this.cached()
    if (!cfg) return
    if (typeof cfg.sampleRate === 'number') {
      options.sampleRate = Math.min(100, Math.max(0, cfg.sampleRate))
    }
    if (cfg.enabled === false || cfg.enabled === 0) {
      options.enabled = false
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
