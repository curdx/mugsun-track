import { describe, expect, it } from 'vitest'
import { bucketOf, isSampled } from '../src/core/sampler'

describe('采样器', () => {
  it('同一 anonymous_id 采样结果恒定（会话级一致）', () => {
    for (let i = 0; i < 50; i++) {
      const key = `app:user-${i}`
      const first = isSampled(key, 37)
      for (let j = 0; j < 10; j++) expect(isSampled(key, 37)).toBe(first)
    }
  })

  it('rate 0 全拒 / rate 100 全收', () => {
    for (let i = 0; i < 100; i++) {
      expect(isSampled(`app:user-${i}`, 0)).toBe(false)
      expect(isSampled(`app:user-${i}`, 100)).toBe(true)
    }
  })

  it('分桶在 [0,100) 且分布大体均匀', () => {
    let hit = 0
    const n = 2000
    for (let i = 0; i < n; i++) {
      const b = bucketOf(`app:user-${i}`)
      expect(b).toBeGreaterThanOrEqual(0)
      expect(b).toBeLessThan(100)
      if (isSampled(`app:user-${i}`, 50)) hit++
    }
    expect(hit).toBeGreaterThan(n * 0.35)
    expect(hit).toBeLessThan(n * 0.65)
  })

  it('不同 appKey 采样相互独立（键含 appKey）', () => {
    const a = isSampled(`app-a:same-user`, 50)
    const b = isSampled(`app-b:same-user`, 50)
    // 不强制不同，只验证函数接受复合键且稳定
    expect(isSampled(`app-a:same-user`, 50)).toBe(a)
    expect(isSampled(`app-b:same-user`, 50)).toBe(b)
  })
})
