import type { KeyValueStore, Props, QueueStore, RemoteConfig, TrackEvent } from './types'
import type { ConfigFetcher } from './core/config'
import type { TransportDeps } from './core/transport'
import { MemoryKeyValueStore } from './core/storage'

/**
 * 浏览器环境适配器：core 纯逻辑所需能力的真实实现集中在这里，
 * 使 core 保持零 DOM 依赖（node/测试环境注入内存实现即可）。
 */

export function createBrowserKv(): KeyValueStore {
  try {
    const ls = window.localStorage
    // 探测可用性（隐私模式可能抛错）
    const probe = '__mst_probe__'
    ls.setItem(probe, '1')
    ls.removeItem(probe)
    return {
      getItem: (k) => ls.getItem(k),
      setItem: (k, v) => {
        try {
          ls.setItem(k, v)
        } catch {
          // 写满/隐私模式：忽略，退化为当次内存态
        }
      },
      removeItem: (k) => ls.removeItem(k)
    }
  } catch {
    return new MemoryKeyValueStore()
  }
}

const DB_NAME = 'mst-track'
const STORE_NAME = 'queue'

interface QueueRecord {
  event_id: string
  app_key: string
  event: TrackEvent
}

/** IndexedDB 队列持久化：按 event_id 存取，by_app 索引按应用恢复 */
export class IdbQueueStore implements QueueStore {
  private dbPromise: Promise<IDBDatabase> | null = null

  private open(): Promise<IDBDatabase> {
    if (!this.dbPromise) {
      this.dbPromise = new Promise((resolve, reject) => {
        const req = indexedDB.open(DB_NAME, 1)
        req.onupgradeneeded = () => {
          const db = req.result
          if (!db.objectStoreNames.contains(STORE_NAME)) {
            db.createObjectStore(STORE_NAME, { keyPath: 'event_id' }).createIndex(
              'by_app',
              'app_key'
            )
          }
        }
        req.onsuccess = () => resolve(req.result)
        req.onerror = () => reject(req.error ?? new Error('indexedDB open failed'))
      })
    }
    return this.dbPromise
  }

  private tx<T>(
    mode: IDBTransactionMode,
    run: (store: IDBObjectStore) => IDBRequest<T> | void
  ): Promise<T | undefined> {
    return this.open().then(
      (db) =>
        new Promise<T | undefined>((resolve, reject) => {
          const tx = db.transaction(STORE_NAME, mode)
          const req = run(tx.objectStore(STORE_NAME))
          tx.oncomplete = () => resolve(req?.result)
          tx.onerror = () => reject(tx.error ?? new Error('indexedDB tx failed'))
          tx.onabort = () => reject(tx.error ?? new Error('indexedDB tx aborted'))
        })
    )
  }

  async load(appKey: string): Promise<TrackEvent[]> {
    const records = await this.tx<QueueRecord[]>('readonly', (store) =>
      store.index('by_app').getAll(appKey)
    )
    return (records ?? []).map((r) => r.event)
  }

  async put(appKey: string, events: TrackEvent[]): Promise<void> {
    await this.tx('readwrite', (store) => {
      for (const event of events) {
        store.put({ event_id: event.event_id, app_key: appKey, event } satisfies QueueRecord)
      }
    })
  }

  async remove(appKey: string, eventIds: string[]): Promise<void> {
    await this.tx('readwrite', (store) => {
      for (const id of eventIds) store.delete(id)
    })
  }

  async clear(appKey: string): Promise<void> {
    const keys = await this.tx<IDBValidKey[]>('readonly', (store) =>
      store.index('by_app').getAllKeys(appKey)
    )
    await this.tx('readwrite', (store) => {
      for (const key of keys ?? []) store.delete(key)
    })
  }
}

export function createBrowserTransportDeps(): TransportDeps {
  const deps: TransportDeps = {}
  if (typeof navigator !== 'undefined' && typeof navigator.sendBeacon === 'function') {
    deps.beacon = (url, body) =>
      navigator.sendBeacon(url, new Blob([body], { type: 'application/json' }))
  }
  if (typeof fetch === 'function') {
    deps.fetch = async (url, init) => {
      const res = await fetch(url, {
        method: 'POST',
        body: init.body,
        headers: init.headers,
        keepalive: init.keepalive,
        credentials: 'omit'
      })
      return { ok: res.ok, status: res.status }
    }
  }
  if (typeof XMLHttpRequest !== 'undefined') {
    deps.xhr = (url, body, headers) =>
      new Promise<boolean>((resolve) => {
        try {
          const xhr = new XMLHttpRequest()
          xhr.open('POST', url, true)
          for (const [k, v] of Object.entries(headers)) xhr.setRequestHeader(k, v)
          xhr.onload = () => resolve(xhr.status >= 200 && xhr.status < 300)
          xhr.onerror = () => resolve(false)
          xhr.ontimeout = () => resolve(false)
          xhr.send(body)
        } catch {
          resolve(false)
        }
      })
  }
  if (typeof CompressionStream === 'function') {
    deps.gzip = async (body) => {
      const stream = new Blob([body]).stream().pipeThrough(new CompressionStream('gzip'))
      return new Response(stream).arrayBuffer()
    }
  }
  return deps
}

/** GET /track/config 拉取；兼容平台 {code,data} 包装与裸对象两种返回 */
export const defaultConfigFetcher: ConfigFetcher = async (url) => {
  if (typeof fetch !== 'function') return null
  try {
    const res = await fetch(url, { method: 'GET', credentials: 'omit' })
    if (!res.ok) return null
    const json: unknown = await res.json()
    if (!json || typeof json !== 'object') return null
    const obj = json as Record<string, unknown>
    const cfg = (obj.data && typeof obj.data === 'object' ? obj.data : obj) as RemoteConfig
    return cfg
  } catch {
    return null
  }
}

const UTM_KEYS = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content'] as const

/**
 * 浏览器公共属性：url_path（原始路径）/referrer/UTM（着陆页归属，启动时解析一次）/
 * screen/viewport/语言/时区/network/release。route_path 由 client 的路由模板提供者补充。
 */
export function browserContextProvider(release?: string): () => Props {
  const utm: Props = {}
  try {
    const params = new URLSearchParams(window.location.search)
    for (const key of UTM_KEYS) {
      const v = params.get(key)
      if (v) utm[key] = v
    }
  } catch {
    // search 解析失败则无 UTM
  }
  const referrer = document.referrer || ''
  const language = navigator.language
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone
  return () => ({
    url_path: window.location.pathname,
    page_title: document.title,
    referrer,
    ...utm,
    screen: typeof screen === 'undefined' ? undefined : `${screen.width}x${screen.height}`,
    viewport: `${window.innerWidth}x${window.innerHeight}`,
    language,
    timezone,
    network: (navigator as Navigator & { connection?: { effectiveType?: string } }).connection
      ?.effectiveType,
    release
  })
}

export function browserIsDnt(): boolean {
  if (typeof navigator === 'undefined') return false
  const nav = navigator as Navigator & { doNotTrack?: string | null }
  const win = (globalThis as { doNotTrack?: string | null }).doNotTrack
  return nav.doNotTrack === '1' || nav.doNotTrack === 'yes' || win === '1' || win === 'yes'
}
