import type { PluginContext, Props, TrackPlugin } from '../types'
import { truncate } from '../core/utils'

const ALWAYS_MASK = 'input[type="password"], [data-track-mask]'
const CLICKABLE =
  'a, button, input[type="submit"], input[type="button"], [role="button"], [data-track-click]'

/**
 * autocapture：$click + form_submit。
 * 隐私口径：永不采集 input/textarea 的 value；password 与 maskSelectors
 * （本地 + 远端下发合并）命中的元素整块屏蔽；文本内容截断 64。
 */
export function autocapturePlugin(): TrackPlugin {
  return {
    name: 'autocapture',
    setup(ctx: PluginContext) {
      if (typeof document === 'undefined') return
      const { client, options } = ctx

      const maskSelector = [ALWAYS_MASK, ...options.maskSelectors].join(', ')
      const isMasked = (el: Element): boolean => {
        try {
          return !!el.closest(maskSelector)
        } catch {
          return false
        }
      }

      const elementProps = (el: Element): Props => {
        const props: Props = { tag: el.tagName.toLowerCase() }
        const id = el.getAttribute('id')
        if (id) props.element_id = truncate(id, 128)
        const cls = (el.getAttribute('class') ?? '').trim()
        if (cls) props.element_class = truncate(cls, 128)
        const isFormField = /^(input|textarea|select)$/i.test(el.tagName)
        if (!isFormField) {
          const text = (el.textContent ?? '').trim()
          if (text) props.element_text = truncate(text, 64)
        }
        if (el.tagName === 'A') {
          const href = el.getAttribute('href')
          if (href) props.href = truncate(href, 512)
        }
        return props
      }

      const onClick = (e: Event) => {
        const target = e.target as Element | null
        if (!target || typeof target.closest !== 'function') return
        if (isMasked(target)) return
        const el = target.closest(CLICKABLE)
        if (!el || isMasked(el)) return
        client.track('$click', elementProps(el))
      }

      const onSubmit = (e: Event) => {
        const form = e.target as HTMLFormElement | null
        if (!form || isMasked(form)) return
        const props: Props = { tag: 'form' }
        if (form.id) props.form_id = truncate(form.id, 128)
        if (form.name) props.form_name = truncate(form.name, 128)
        if (form.action) {
          try {
            props.form_action = truncate(new URL(form.action).pathname, 512)
          } catch {
            // action 非合法 URL 时忽略
          }
        }
        if (form.method) props.form_method = form.method.toUpperCase()
        // 事件名不带 $ 前缀（$ 为服务端保留字，白名单外的 $ 事件一律拒收）
        client.track('form_submit', props)
      }

      document.addEventListener('click', onClick, { capture: true, passive: true })
      document.addEventListener('submit', onSubmit, { capture: true, passive: true })
      return () => {
        document.removeEventListener('click', onClick, { capture: true })
        document.removeEventListener('submit', onSubmit, { capture: true })
      }
    }
  }
}
