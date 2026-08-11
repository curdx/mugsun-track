import type { PluginContext, ResolvedTrackOptions, TrackPlugin } from '../../types'
import { createBrowserTransportDeps } from '../../adapters'
import { Transport } from '../../core/transport'
import { byteLength, truncate, uuid } from '../../core/utils'
import { ApiBodyUploader, type ApiBodyPayload, type ApiBodySendOutcome } from './uploader'

export interface ApiMonitorPluginOptions {
  /** 测试注入：body 上传发送实现（默认内置独立 Transport 通道，不占事件队列） */
  send?: (payload: ApiBodyPayload) => Promise<ApiBodySendOutcome>
  /** 测试注入：gzip 实现；传 null 强制走明文降级路径 */
  gzip?: ((body: string) => Promise<ArrayBuffer>) | null
  /** 单条失败重试次数（指数退避后丢弃），默认 3 */
  maxRetries?: number
}

/** SDK 自身端点路径后缀：全排除（事件也不采），防自埋点循环 */
const SELF_PATH_SUFFIXES = [
  '/track/collect',
  '/track/config',
  '/track/replay',
  '/track/api-body',
  '/track/sourcemap',
  '/track/raw'
]

/** 凭证端点路径片段（内置硬屏蔽，不可关）：响应含令牌，body 永不采集，事件元数据照发 */
const CREDENTIAL_PATH_PARTS = ['/auth/login', '/auth/refresh', '/oauth/token', '/auth/social']

/** body 安全阀缺省 1MB（远端 apiBodyMaxBytes 可调） */
const DEFAULT_BODY_MAX_BYTES = 1024 * 1024

/** 默认发送：独立 Transport（不复用事件队列）；压缩在 payload 字段级完成，传输层不再二次 gzip */
function createDefaultSend(options: ResolvedTrackOptions) {
  const deps = createBrowserTransportDeps()
  delete deps.gzip
  const getHeaders = (): Record<string, string> => {
    const h = options.headers
    return typeof h === 'function' ? h() : (h ?? {})
  }
  const transport = new Transport(`${options.endpoint}/track/api-body`, deps, getHeaders)
  return async (payload: ApiBodyPayload): Promise<ApiBodySendOutcome> => {
    const res = await transport.sendDetailed(payload)
    if (res.ok) return 'ok'
    // 4xx（appKey 校验/限流/超限等服务端拒收）重试无意义直接丢弃；网络失败（0）与 5xx 走退避重试
    return res.status >= 400 && res.status < 500 ? 'drop' : 'retry'
  }
}

function createDefaultGzip(): ((body: string) => Promise<ArrayBuffer>) | undefined {
  if (typeof CompressionStream !== 'function') return undefined
  return async (body) => {
    const stream = new Blob([body]).stream().pipeThrough(new CompressionStream('gzip'))
    return new Response(stream).arrayBuffer()
  }
}

interface UrlInfo {
  /** 绝对化后的完整 url（含查询串），上报用 */
  href: string
  pathname: string
}

/** body 过滤链裁定：collect 读体上传；size/credential 跳过并标记；skip 静默跳过（非 JSON/SSE/二进制） */
type BodyAction = 'collect' | 'size' | 'credential' | 'skip'

/**
 * api_request：fetch / XHR 包装监控（G102）。
 * - 启停由 apiMonitorEnabled 控制（本地显式设置优先，否则远端下发，默认关）；关则不包装
 * - url 保留完整查询串：事件名固定、url 只在 props 不进维度索引，无基数风险，排障需要查询串
 * - body 采集（apiBodyEnabled）走独立上传通道，event_id 即 body_ref；过滤链：
 *   凭证端点硬屏蔽（不可关）→ 仅 content-type 含 json → content-length 超安全阀跳过
 *   → 过链后才 clone 读体（SSE/二进制/非 JSON 在 content-type 闸口统一拦截，不读体）
 *   → 实际读体长度二次校验安全阀
 * - 事件名不带 $ 前缀（$ 为服务端保留字，白名单外的 $ 事件一律拒收）
 */
export function apiMonitorPlugin(pluginOpts: ApiMonitorPluginOptions = {}): TrackPlugin {
  return {
    name: 'api-monitor',
    setup(ctx: PluginContext) {
      if (typeof window === 'undefined') return
      const { client, options, log } = ctx
      // 总开关：本地显式设置优先，否则远端缓存配置补齐；默认关（不包装 fetch/XHR）
      if (!options.apiMonitorEnabled) return
      const bodyEnabled = options.apiBodyEnabled ?? false
      const maxBytes = options.apiBodyMaxBytes ?? DEFAULT_BODY_MAX_BYTES

      const uploader = bodyEnabled
        ? new ApiBodyUploader({
            appKey: options.appKey,
            send: pluginOpts.send ?? createDefaultSend(options),
            gzip: pluginOpts.gzip === null ? undefined : (pluginOpts.gzip ?? createDefaultGzip()),
            maskEnabled: options.apiBodyMaskEnabled ?? false,
            maxRetries: pluginOpts.maxRetries,
            retryBaseDelay: options.retryBaseDelay,
            retryMaxDelay: options.retryMaxDelay,
            log
          })
        : null

      const nowMs = (): number =>
        typeof performance !== 'undefined' ? performance.now() : Date.now()

      const parseUrl = (url: string): UrlInfo | null => {
        try {
          const u = new URL(url, window.location.href)
          return { href: truncate(u.href, 1024), pathname: u.pathname }
        } catch {
          return null
        }
      }
      const isSelf = (info: UrlInfo | null): boolean =>
        info !== null && SELF_PATH_SUFFIXES.some((s) => info.pathname.endsWith(s))
      const parseContentLength = (raw: string | null): number | null => {
        if (!raw) return null
        const n = Number(raw)
        return Number.isFinite(n) && n >= 0 ? n : null
      }

      /** body 过滤链（严格按 §19）：凭证硬屏蔽最先裁定（永不读体） */
      const decideBody = (
        info: UrlInfo,
        contentType: string,
        contentLength: number | null
      ): BodyAction => {
        if (CREDENTIAL_PATH_PARTS.some((p) => info.pathname.includes(p))) return 'credential'
        // SSE/二进制/非 JSON 统一在此闸口拦截（不 clone 读体，避免整响应入内存双份）
        if (!contentType.includes('json')) return 'skip'
        if (contentLength !== null && contentLength > maxBytes) return 'size'
        return 'collect'
      }

      interface EventProps {
        url: string
        method: string
        status: number
        duration_ms: number
        error_message?: string
        response_size?: number
        body_ref?: string
        body_skipped?: 'size' | 'credential'
      }

      /** 事件元数据上报（进正常事件队列；page 关联 url_path/route_path 走 core 公共属性机制） */
      const report = (props: EventProps): void => {
        client.track('api_request', {
          ...props,
          success: props.status >= 200 && props.status < 400
        })
      }

      /**
       * 读体完成后的收尾：实际长度二次安全阀 → 预生成 event_id（body_ref 与上传同源）→
       * 事件与 body 上传。track 返回 null（optOut/采样外）时 body 一并放弃（无事件可关联）
       */
      const reportWithBody = (
        base: EventProps,
        contentLength: number | null,
        text: string | null
      ): void => {
        if (text === null) {
          report({ ...base, response_size: contentLength ?? undefined })
          return
        }
        const size = contentLength ?? byteLength(text)
        if (byteLength(text) > maxBytes) {
          report({ ...base, response_size: size, body_skipped: 'size' })
          return
        }
        const eventId = uuid()
        const tracked = client.track(
          'api_request',
          {
            ...base,
            response_size: size,
            body_ref: eventId,
            success: base.status >= 200 && base.status < 400
          },
          { eventId }
        )
        if (tracked) uploader?.push(text, tracked)
      }

      const teardowns: Array<() => void> = []

      // fetch 包装
      if (typeof window.fetch === 'function') {
        const origFetch = window.fetch
        const callFetch = (input: RequestInfo | URL, init?: RequestInit) =>
          origFetch.call(window, input, init)
        window.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
          const rawUrl =
            typeof input === 'string' || input instanceof URL ? String(input) : input.url
          const method = (
            init?.method ?? (input instanceof Request ? input.method : 'GET')
          ).toUpperCase()
          const info = parseUrl(rawUrl)
          // 自身端点：事件与 body 都不采（防自埋点循环）
          if (isSelf(info)) return callFetch(input, init)
          const url = info?.href ?? truncate(rawUrl, 1024)
          const start = nowMs()
          try {
            const res = await callFetch(input, init)
            const base: EventProps = {
              url,
              method,
              status: res.status,
              duration_ms: Math.round(nowMs() - start)
            }
            if (!uploader || !info) {
              report(base)
              return res
            }
            const contentType = (res.headers.get('content-type') ?? '').toLowerCase()
            const contentLength = parseContentLength(res.headers.get('content-length'))
            const action = decideBody(info, contentType, contentLength)
            if (action !== 'collect') {
              report({
                ...base,
                response_size: contentLength ?? undefined,
                body_skipped: action === 'skip' ? undefined : action
              })
              return res
            }
            // 过滤链通过才 clone 读体；读体异步收尾，不阻塞调用方拿到响应
            void (async () => {
              let text: string | null = null
              try {
                text = await res.clone().text()
              } catch {
                // body 已被消费/流中断：放弃 body，事件元数据照发
                text = null
              }
              reportWithBody(base, contentLength, text)
            })()
            return res
          } catch (err) {
            // 网络失败（reject）：status=0 + error_message
            report({
              url,
              method,
              status: 0,
              duration_ms: Math.round(nowMs() - start),
              error_message: err instanceof Error ? err.message : String(err)
            })
            throw err
          }
        }
        teardowns.push(() => {
          window.fetch = origFetch
        })
      }

      // XHR 包装
      if (typeof XMLHttpRequest !== 'undefined') {
        type XhrMeta = { method: string; url: string; info: UrlInfo | null; start: number }
        const proto = XMLHttpRequest.prototype
        const origOpen = proto.open
        const origSend = proto.send
        proto.open = function (
          this: XMLHttpRequest,
          method: string,
          url: string | URL,
          async?: boolean,
          username?: string | null,
          password?: string | null
        ) {
          ;(this as XMLHttpRequest & { __mst?: XhrMeta }).__mst = {
            method: String(method).toUpperCase(),
            url: String(url),
            info: parseUrl(String(url)),
            start: 0
          }
          return origOpen.call(this, method, url, async ?? true, username, password)
        } as typeof origOpen
        proto.send = function (
          this: XMLHttpRequest,
          body?: Document | XMLHttpRequestBodyInit | null
        ) {
          const meta = (this as XMLHttpRequest & { __mst?: XhrMeta }).__mst
          if (!meta || isSelf(meta.info)) return origSend.call(this, body)
          meta.start = nowMs()
          this.addEventListener('loadend', () => {
            const base: EventProps = {
              url: meta.info?.href ?? truncate(meta.url, 1024),
              method: meta.method,
              status: this.status,
              duration_ms: Math.round(nowMs() - meta.start)
            }
            // 网络失败（error/timeout/abort）：XHR 无细粒度原因，status=0 + error_message
            if (this.status === 0) {
              report({ ...base, error_message: 'network error' })
              return
            }
            if (!uploader || !meta.info) {
              report(base)
              return
            }
            let contentType = ''
            let contentLength: number | null = null
            try {
              contentType = (this.getResponseHeader('content-type') ?? '').toLowerCase()
              contentLength = parseContentLength(this.getResponseHeader('content-length'))
            } catch {
              // 跨域受限头部读取失败：按无头信息处理（body 不采，事件照发）
            }
            const action = decideBody(meta.info, contentType, contentLength)
            if (action !== 'collect') {
              report({
                ...base,
                response_size: contentLength ?? undefined,
                body_skipped: action === 'skip' ? undefined : action
              })
              return
            }
            // responseType 非文本（json/blob/arraybuffer）时 responseText 抛错：放弃 body
            let text: string | null = null
            try {
              text = typeof this.responseText === 'string' ? this.responseText : null
            } catch {
              text = null
            }
            reportWithBody(base, contentLength, text)
          })
          return origSend.call(this, body)
        } as typeof origSend
        teardowns.push(() => {
          proto.open = origOpen
          proto.send = origSend
        })
      }

      return () => {
        for (const fn of teardowns) fn()
        uploader?.destroy()
      }
    }
  }
}

export { ApiBodyUploader, maskSensitiveBody } from './uploader'
export type { ApiBodyPayload, ApiBodySendOutcome, ApiBodyUploaderOptions } from './uploader'
