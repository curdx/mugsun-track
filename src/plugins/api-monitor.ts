import type { PluginContext, TrackPlugin } from '../types'
import { truncate } from '../core/utils'

/**
 * api_request：fetch / XHR 包装监控（默认关，需显式加入 plugins）。
 * 排除自身 collect/config 请求防自埋点；url 去查询串防敏感参数泄露。
 * 事件名不带 $ 前缀（$ 为服务端保留字，白名单外的 $ 事件一律拒收）。
 */
export function apiMonitorPlugin(): TrackPlugin {
  return {
    name: 'api-monitor',
    setup(ctx: PluginContext) {
      if (typeof window === 'undefined') return
      const { client, options } = ctx
      const selfPrefix = options.endpoint

      const isSelf = (url: string): boolean => url.startsWith(selfPrefix)
      const cleanUrl = (url: string): string => {
        try {
          const u = new URL(url, window.location.href)
          return truncate(`${u.origin}${u.pathname}`, 512)
        } catch {
          return truncate(url.split('?')[0] ?? url, 512)
        }
      }
      const report = (props: {
        url: string
        method: string
        status: number
        duration_ms: number
        error?: string
      }) => {
        client.track('api_request', {
          ...props,
          success: props.status >= 200 && props.status < 400
        })
      }

      const teardowns: Array<() => void> = []

      // fetch 包装
      if (typeof window.fetch === 'function') {
        const origFetch = window.fetch
        const callFetch = (input: RequestInfo | URL, init?: RequestInit) =>
          origFetch.call(window, input, init)
        window.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
          const url = typeof input === 'string' || input instanceof URL ? String(input) : input.url
          const method = (
            init?.method ?? (input instanceof Request ? input.method : 'GET')
          ).toUpperCase()
          if (isSelf(url)) return callFetch(input, init)
          const start = Date.now()
          try {
            const res = await callFetch(input, init)
            report({
              url: cleanUrl(url),
              method,
              status: res.status,
              duration_ms: Date.now() - start
            })
            return res
          } catch (err) {
            report({
              url: cleanUrl(url),
              method,
              status: 0,
              duration_ms: Date.now() - start,
              error: err instanceof Error ? err.message : String(err)
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
        type XhrMeta = { method: string; url: string; start: number }
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
            start: 0
          }
          return origOpen.call(this, method, url, async ?? true, username, password)
        } as typeof origOpen
        proto.send = function (
          this: XMLHttpRequest,
          body?: Document | XMLHttpRequestBodyInit | null
        ) {
          const meta = (this as XMLHttpRequest & { __mst?: XhrMeta }).__mst
          if (!meta || isSelf(meta.url)) return origSend.call(this, body)
          meta.start = Date.now()
          this.addEventListener('loadend', () => {
            report({
              url: cleanUrl(meta.url),
              method: meta.method,
              status: this.status,
              duration_ms: Date.now() - meta.start
            })
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
      }
    }
  }
}
