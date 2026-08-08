import { fnv1a } from './utils'

/**
 * 会话级一致采样：对 `${appKey}:${anonymous_id}` 哈希分桶，
 * 同一匿名用户在同一应用下采样结果恒定（会话内外一致，服务端按采样率外推量级）。
 */
export function bucketOf(key: string): number {
  return Math.floor((fnv1a(key) / 0x100000000) * 100)
}

export function isSampled(key: string, rate: number): boolean {
  if (rate >= 100) return true
  if (rate <= 0) return false
  return bucketOf(key) < rate
}
