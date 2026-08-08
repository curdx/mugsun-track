/** 通用工具：core 纯逻辑，不触碰 DOM */

export function uuid(): string {
  const c = (globalThis as { crypto?: Crypto }).crypto
  if (c?.randomUUID) return c.randomUUID()
  // 低版本/非安全上下文兜底
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (ch) => {
    const r = (Math.random() * 16) | 0
    return (ch === 'x' ? r : (r & 0x3) | 0x8).toString(16)
  })
}

/** FNV-1a 32bit，采样分桶与错误指纹共用 */
export function fnv1a(str: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return h >>> 0
}

export function hashHex(str: string): string {
  return fnv1a(str).toString(16).padStart(8, '0')
}

/** 稳定 JSON 序列化（键排序），用于曝光去重参数指纹 */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? ''
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  const obj = value as Record<string, unknown>
  const keys = Object.keys(obj).sort()
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(',')}}`
}

export function truncate(str: string, max: number): string {
  return str.length > max ? str.slice(0, max) : str
}

export function byteLength(str: string): number {
  return new TextEncoder().encode(str).length
}

export function safeParse<T>(raw: string | null): T | null {
  if (!raw) return null
  try {
    return JSON.parse(raw) as T
  } catch {
    return null
  }
}

/** 属性清洗：键 ≤64、字符串值 ≤1024，剔除 undefined（服务端再做深度/总量截断） */
export function sanitizeProps(props: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(props)) {
    if (v === undefined) continue
    const key = truncate(k, 64)
    out[key] = typeof v === 'string' ? truncate(v, 1024) : v
  }
  return out
}
