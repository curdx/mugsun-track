import type { PluginContext, Props, TrackPlugin } from '../types'
import { hashHex, truncate } from '../core/utils'

/** 堆栈首帧：第一条带 URL 的堆栈行归一化（去行列号），与 message 一起生成指纹 */
export function firstFrame(stack: string | undefined): string {
  if (!stack) return ''
  for (const line of stack.split('\n')) {
    const m = line.match(/(https?:\/\/\S+?|file:\/\/\S+?|webpack:\/\/\S+?)(:\d+){1,2}/)
    if (m) return m[0].replace(/(:\d+){1,2}$/, '')
  }
  return ''
}

/** 错误指纹 = message + 堆栈首帧 哈希，服务端按 fingerprint 分组聚合 */
export function fingerprintOf(message: string, stack?: string): string {
  return hashHex(`${message}|${firstFrame(stack)}`)
}

/**
 * $error：window error（捕获阶段，含资源加载错误）+ unhandledrejection。
 * 事件携带 release 版本号与 error_fingerprint。
 */
export function errorPlugin(): TrackPlugin {
  return {
    name: 'error',
    setup(ctx: PluginContext) {
      if (typeof window === 'undefined') return
      const { client, options } = ctx

      const report = (props: Props) => {
        const message = truncate(String(props.message ?? 'unknown'), 512)
        const stack = props.stack ? truncate(String(props.stack), 4096) : undefined
        client.track('$error', {
          ...props,
          message,
          stack,
          release: options.release,
          error_fingerprint: fingerprintOf(message, stack)
        })
      }

      const onError = (e: Event) => {
        // ErrorEvent：JS 运行时错误；其余捕获阶段落到具体元素上的是资源加载错误
        if (e instanceof ErrorEvent && e.message) {
          report({
            error_type: 'js',
            message: e.message,
            stack: e.error instanceof Error ? e.error.stack : undefined,
            filename: e.filename,
            lineno: e.lineno,
            colno: e.colno
          })
          return
        }
        const target = e.target as (Element & { src?: string; href?: string }) | null
        if (target && target !== (window as unknown as Element) && target.tagName) {
          report({
            error_type: 'resource',
            message: `resource load failed: ${target.tagName.toLowerCase()}`,
            element_tag: target.tagName.toLowerCase(),
            resource_url: truncate(target.src ?? target.href ?? '', 512)
          })
        }
      }

      const onRejection = (e: PromiseRejectionEvent) => {
        const reason = e.reason
        report({
          error_type: 'promise',
          message: reason instanceof Error ? reason.message : String(reason),
          stack: reason instanceof Error ? reason.stack : undefined
        })
      }

      window.addEventListener('error', onError, true)
      window.addEventListener('unhandledrejection', onRejection)
      return () => {
        window.removeEventListener('error', onError, true)
        window.removeEventListener('unhandledrejection', onRejection)
      }
    }
  }
}
