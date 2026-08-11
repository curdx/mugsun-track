import type { VisualRule } from '../../types'

/** 圈选 selector 上限（与 track_visual_rule.selector VARCHAR(512) 对齐） */
const MAX_SELECTOR_LEN = 512

/** 含 Tailwind 态前缀（hover:/focus: 等动态态）的 class 不稳定，剔除 */
const isStableClass = (cls: string): boolean => cls !== '' && !cls.includes(':')

/** CSS 标识符转义（CSS.escape 优先；降级手工：非 [a-zA-Z0-9_-] 反斜杠转义，首位数字按码点十六进制转义） */
function escapeIdent(value: string): string {
  const css = (globalThis as { CSS?: { escape?: (v: string) => string } }).CSS
  if (typeof css?.escape === 'function') return css.escape(value)
  let out = ''
  for (let i = 0; i < value.length; i++) {
    const ch = value.charAt(i)
    if (i === 0 && /[0-9]/.test(ch)) out += `\\3${ch} `
    else if (/[a-zA-Z0-9_-]/.test(ch)) out += ch
    else out += `\\${ch}`
  }
  return out
}

/** 单级选择器：有 id 即 #id（调用方据此截止）；否则 tag + 稳定 class + 同类型兄弟 >1 时补 :nth-of-type */
function levelSelector(el: Element): string {
  const id = el.getAttribute('id')
  if (id) return `#${escapeIdent(id)}`
  let part = el.tagName.toLowerCase()
  const classes = (el.getAttribute('class') ?? '').trim().split(/\s+/).filter(isStableClass)
  if (classes.length > 0) part += `.${classes.map(escapeIdent).join('.')}`
  const parent = el.parentElement
  if (parent) {
    const sameTag = Array.from(parent.children).filter((c) => c.tagName === el.tagName)
    if (sameTag.length > 1) part += `:nth-of-type(${sameTag.indexOf(el) + 1})`
  }
  return part
}

function isUnique(doc: Document, selector: string): boolean {
  try {
    return doc.querySelectorAll(selector).length === 1
  } catch {
    // 候选 selector 非法时按不唯一处理，继续向父链升级
    return false
  }
}

/**
 * 圈选 selector 生成：沿父链拼 `tag#id.cls:nth-of-type`，每升一级验唯一，唯一即返回；
 * 有 id 即 `#id` 截止；升到 body 仍不唯一返回 body 路径尽力值；结果 >512 字符返回 null
 */
export function generateSelector(el: Element, doc: Document): string | null {
  const parts: string[] = []
  let cur: Element | null = el
  let candidate = ''
  while (cur && cur !== doc.documentElement) {
    parts.unshift(levelSelector(cur))
    candidate = parts.join(' > ')
    // 前缀只增不减：当前候选已超限则最终结果必超限
    if (candidate.length > MAX_SELECTOR_LEN) return null
    if (cur.getAttribute('id')) return candidate
    if (isUnique(doc, candidate)) return candidate
    cur = cur.parentElement
  }
  // 升到 body 仍不唯一：尽力值（body 开头完整路径；candidate 恒为最近一次拼接结果）
  return candidate.length > 0 ? candidate : null
}

/**
 * 规则命中判定：closest 命中 && routePath 前缀（空=全站）&& matchText 包含（空=不限）。
 * 非法 selector 时 closest 抛错——吞掉返回 false，不炸页面
 */
export function matchesRule(
  el: Element,
  rule: VisualRule,
  currentRoutePath: string | null
): boolean {
  try {
    if (!el.closest(rule.selector)) return false
  } catch {
    return false
  }
  if (rule.routePath && !(currentRoutePath ?? '').startsWith(rule.routePath)) return false
  if (rule.matchText && !(el.textContent ?? '').includes(rule.matchText)) return false
  return true
}
