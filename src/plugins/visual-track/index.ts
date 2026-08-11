import type { PluginContext, Props, TrackPlugin } from '../../types'
import { CUSTOM_EVENT_NAME_RE, truncate } from '../../core/utils'
import { generateSelector, matchesRule } from './selector'

/** 与 autocapture 同口径的硬屏蔽：password + 显式 mask 标记，叠加本地/远端 maskSelectors */
const ALWAYS_MASK = 'input[type="password"], [data-track-mask]'
/** inspect 激活参数（令牌值由管理端 token 接口签发，30min 有效） */
const INSPECT_PARAM = '__mst_inspect'
/** inspect UI 统一标记：自身事件过滤 + teardown 整体拆除 */
const UI_FLAG = '[data-mst-inspect-ui]'
/** 浮层级顶（低于浏览器上限 2147483647 一档，压过页面一切浮层） */
const Z_INDEX = '2147483646'
const DRAFT_PATH = '/track/visual/draft'
const FONT = 'font:13px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif'

/**
 * visual-track（G104 圈选式可视化埋点，不进 defaultPlugins，宿主显式注册）。
 * - inspect 模式：URL 带 __mst_inspect 令牌即激活（不依赖远端配置），悬停高亮 → 点击选定
 *   → 面板填事件名 → 独立 fetch POST /track/visual/draft（不进事件队列/不上 IDB）→ Esc 退出
 * - 正常模式：options.visualRules 非空才装 click 监听，命中 client.track（走主采样）
 */
export function visualTrack(): TrackPlugin {
  return {
    name: 'visual-track',
    setup(ctx: PluginContext) {
      if (typeof window === 'undefined' || typeof document === 'undefined') return
      const token = new URLSearchParams(window.location.search).get(INSPECT_PARAM)
      if (token) return setupInspect(ctx, token)
      return setupRules(ctx)
    }
  }
}

// ---------------------------------------------------------------- 正常模式

/** 正常模式：visualRules 非空才装监听（空规则零开销）；屏蔽子树不触发；同名规则每击去重 */
function setupRules(ctx: PluginContext): void | (() => void) {
  const { client, options } = ctx
  const rules = options.visualRules
  if (!Array.isArray(rules) || rules.length === 0) return
  const isMasked = createIsMasked(options.maskSelectors)

  const onClick = (e: Event) => {
    const target = e.target as Element | null
    if (!target || typeof target.closest !== 'function') return
    if (isMasked(target)) return
    const routePath = client.getRoutePath() ?? null
    const fired = new Set<string>()
    for (const rule of rules) {
      if (fired.has(rule.event) || !matchesRule(target, rule, routePath)) continue
      fired.add(rule.event)
      const props: Props = { vs_selector: truncate(rule.selector, 512) }
      const text = elementText(target)
      if (text) props.element_text = text
      client.track(rule.event, props)
    }
  }

  document.addEventListener('click', onClick, { capture: true, passive: true })
  return () => {
    document.removeEventListener('click', onClick, { capture: true })
  }
}

// ---------------------------------------------------------------- inspect 模式

interface Selection {
  el: Element
  selector: string
  /** 元素文本（表单字段为空串），提交时截 128 */
  text: string
}

/**
 * inspect 圈选模式：悬停高亮（屏蔽元素不高亮不可选）→ click capture 拦截防跳转 →
 * 面板填事件名（正则即时校验）→ 独立通道提交草稿（失败重试 1 次）→ 成功清空待下一次圈选。
 * Esc/关闭按钮退出：拆全部 DOM/监听 + history.replaceState 清 __mst_inspect 参数
 */
function setupInspect(ctx: PluginContext, token: string): () => void {
  const { client, options, log } = ctx
  const doc = document
  const isMasked = createIsMasked(options.maskSelectors)

  // ---------- 浮层体系（全内联样式，不进页面样式表） ----------
  const root = doc.createElement('div')
  root.setAttribute('data-mst-inspect-ui', '')

  const highlight = doc.createElement('div')
  highlight.style.cssText = `position:fixed;display:none;pointer-events:none;z-index:${Z_INDEX};box-shadow:0 0 0 2px #3b82f6,0 0 0 9999px rgba(0,0,0,0.25);border-radius:2px`

  const bar = doc.createElement('div')
  bar.style.cssText = `position:fixed;top:0;left:0;right:0;z-index:${Z_INDEX};display:flex;align-items:center;justify-content:space-between;padding:8px 16px;background:#1f2937;color:#fff;${FONT}`
  const barText = doc.createElement('span')
  barText.textContent = '圈选模式：点击元素完成圈选，Esc 退出'
  const closeBtn = doc.createElement('button')
  closeBtn.type = 'button'
  closeBtn.textContent = '退出'
  closeBtn.style.cssText = 'background:transparent;border:1px solid #9ca3af;color:#fff;border-radius:4px;padding:2px 10px;cursor:pointer'
  bar.append(barText, closeBtn)

  const panel = doc.createElement('div')
  panel.style.cssText = `position:fixed;left:0;right:0;bottom:0;display:none;z-index:${Z_INDEX};background:#fff;color:#111827;padding:12px 16px;box-shadow:0 -2px 12px rgba(0,0,0,0.15);${FONT}`
  const summary = doc.createElement('div')
  summary.style.cssText = 'margin-bottom:8px;word-break:break-all'
  const input = doc.createElement('input')
  input.type = 'text'
  input.placeholder = '事件名：字母开头，仅字母/数字/下划线，≤64 位'
  input.style.cssText = 'box-sizing:border-box;width:100%;padding:6px 8px;border:1px solid #d1d5db;border-radius:4px;margin-bottom:4px'
  const hint = doc.createElement('div')
  hint.style.cssText = 'color:#dc2626;min-height:18px;margin-bottom:4px'
  const submitBtn = doc.createElement('button')
  submitBtn.type = 'button'
  submitBtn.textContent = '提交'
  submitBtn.style.cssText = 'background:#3b82f6;border:none;color:#fff;border-radius:4px;padding:6px 16px;cursor:pointer;margin-right:8px'
  const reselectBtn = doc.createElement('button')
  reselectBtn.type = 'button'
  reselectBtn.textContent = '重选'
  reselectBtn.style.cssText = 'background:transparent;border:1px solid #d1d5db;color:#374151;border-radius:4px;padding:6px 16px;cursor:pointer'
  panel.append(summary, input, hint, submitBtn, reselectBtn)

  const toast = doc.createElement('div')
  toast.style.cssText = `position:fixed;top:48px;left:50%;transform:translateX(-50%);display:none;z-index:${Z_INDEX};background:#111827;color:#fff;padding:6px 14px;border-radius:4px;${FONT}`

  root.append(highlight, bar, panel, toast)
  ;(doc.body ?? doc.documentElement).appendChild(root)

  let toastTimer: ReturnType<typeof setTimeout> | null = null
  const showToast = (msg: string): void => {
    toast.textContent = msg
    toast.style.display = 'block'
    if (toastTimer) clearTimeout(toastTimer)
    toastTimer = setTimeout(() => {
      toast.style.display = 'none'
    }, 2400)
  }

  let selected: Selection | null = null
  let submitting = false

  const validate = (): boolean => {
    const ok = CUSTOM_EVENT_NAME_RE.test(input.value)
    submitBtn.disabled = !ok
    hint.textContent = ok || input.value === '' ? '' : '事件名不合法：字母开头，仅字母/数字/下划线，≤64 位'
    return ok
  }

  const openPanel = (): void => {
    if (!selected) return
    const tag = selected.el.tagName.toLowerCase()
    const text = selected.text ? `「${truncate(selected.text, 32)}」` : ''
    summary.textContent = `已选元素 <${tag}>${text}：${selected.selector}`
    input.value = ''
    validate()
    panel.style.display = 'block'
    input.focus()
  }

  /** 独立通道提交草稿（不进事件队列/不上 IDB，防采样丢失+防污染统计）；失败重试 1 次 */
  const postDraft = async (body: Record<string, unknown>): Promise<boolean> => {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const res = await window.fetch(`${options.endpoint}${DRAFT_PATH}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
          keepalive: true
        })
        if (res.ok) return true
      } catch {
        // 网络失败进入重试
      }
    }
    return false
  }

  const submit = async (): Promise<void> => {
    if (!selected || submitting || !validate()) return
    submitting = true
    submitBtn.disabled = true
    const body = {
      token,
      event_name: input.value,
      selector: selected.selector,
      route_path: client.getRoutePath() ?? null,
      match_text: selected.text ? truncate(selected.text, 128) : null,
      page_url: window.location.pathname
    }
    const ok = await postDraft(body)
    submitting = false
    if (ok) {
      showToast('已提交圈选草稿')
      selected = null
      panel.style.display = 'none'
    } else {
      showToast('提交失败，请重试')
      log('visual draft submit failed')
      validate()
    }
  }

  // ---------- 事件 ----------
  const onMouseOver = (e: Event) => {
    const target = e.target as Element | null
    if (!target || typeof target.closest !== 'function') return
    if (target.closest(UI_FLAG)) return
    if (isMasked(target)) {
      highlight.style.display = 'none'
      return
    }
    const r = target.getBoundingClientRect()
    highlight.style.display = 'block'
    highlight.style.left = `${r.left}px`
    highlight.style.top = `${r.top}px`
    highlight.style.width = `${r.width}px`
    highlight.style.height = `${r.height}px`
  }

  const onClick = (e: Event) => {
    const target = e.target as Element | null
    if (!target || typeof target.closest !== 'function') return
    // 面板/提示条内部点击放行（按钮自身逻辑在冒泡侧处理；root 冒泡闸口防穿透到页面）
    if (target.closest(UI_FLAG)) return
    // 页面点击整体拦截：防跳转/防触发页面逻辑
    e.preventDefault()
    e.stopPropagation()
    e.stopImmediatePropagation()
    if (isMasked(target)) return
    const selector = generateSelector(target, doc)
    if (!selector) {
      showToast('无法为该元素生成选择器，请重选')
      return
    }
    selected = { el: target, selector, text: elementText(target, 128) }
    openPanel()
  }

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Escape') teardown()
  }

  // 自身 UI 的点击/悬停不穿透到页面（capture 闸口只拦页面元素，这里拦冒泡回程）
  const onUiClick = (e: Event) => e.stopPropagation()

  let tornDown = false
  /** 退出圈选：拆全部 DOM/监听 + 清 URL 上的 __mst_inspect 参数（幂等） */
  function teardown(): void {
    if (tornDown) return
    tornDown = true
    doc.removeEventListener('mouseover', onMouseOver, { capture: true })
    doc.removeEventListener('click', onClick, true)
    doc.removeEventListener('keydown', onKeyDown, { capture: true })
    root.removeEventListener('click', onUiClick)
    if (toastTimer) clearTimeout(toastTimer)
    root.remove()
    try {
      const params = new URLSearchParams(window.location.search)
      if (params.has(INSPECT_PARAM)) {
        params.delete(INSPECT_PARAM)
        const qs = params.toString()
        window.history.replaceState(
          null,
          '',
          `${window.location.pathname}${qs ? `?${qs}` : ''}${window.location.hash}`
        )
      }
    } catch {
      // replaceState 失败不影响退出
    }
  }

  input.addEventListener('input', validate)
  submitBtn.addEventListener('click', () => void submit())
  reselectBtn.addEventListener('click', () => {
    selected = null
    panel.style.display = 'none'
  })
  closeBtn.addEventListener('click', teardown)
  root.addEventListener('click', onUiClick)
  doc.addEventListener('mouseover', onMouseOver, { capture: true, passive: true })
  // 非 passive：需 preventDefault 防跳转
  doc.addEventListener('click', onClick, true)
  doc.addEventListener('keydown', onKeyDown, { capture: true })

  return teardown
}

// ---------------------------------------------------------------- 共用

function createIsMasked(maskSelectors: string[]): (el: Element) => boolean {
  const selector = [ALWAYS_MASK, ...maskSelectors].join(', ')
  return (el: Element): boolean => {
    try {
      return !!el.closest(selector)
    } catch {
      return false
    }
  }
}

/** element_text 口径照 autocapture：表单字段不取文本，trim + 截断（正常模式 64 / 草稿 128） */
function elementText(el: Element, max = 64): string {
  if (/^(input|textarea|select)$/i.test(el.tagName)) return ''
  return truncate((el.textContent ?? '').trim(), max)
}

export { generateSelector, matchesRule } from './selector'
