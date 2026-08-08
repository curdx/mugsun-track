import { describe, expect, it } from 'vitest'
import { TimeEventTracker } from '../src/core/timeEvent'
import { FakeClock } from './helpers'

describe('timeEvent', () => {
  it('track 同名事件消费计时并得到 duration_ms', () => {
    const clock = new FakeClock()
    const tt = new TimeEventTracker(clock)
    tt.start('upload')
    clock.advance(1530)
    expect(tt.consume('upload')).toBe(1530)
    // 已消费，再取为 null
    expect(tt.consume('upload')).toBeNull()
  })

  it('未计时的同名事件 consume 返回 null', () => {
    const tt = new TimeEventTracker(new FakeClock())
    expect(tt.consume('never')).toBeNull()
  })

  it('重复 start 覆盖起点；cancel 取消计时', () => {
    const clock = new FakeClock()
    const tt = new TimeEventTracker(clock)
    tt.start('a')
    clock.advance(100)
    tt.start('a')
    clock.advance(50)
    expect(tt.consume('a')).toBe(50)
    tt.start('b')
    tt.cancel('b')
    expect(tt.consume('b')).toBeNull()
  })

  it('超过容量上限忽略新计时', () => {
    const tt = new TimeEventTracker(new FakeClock(), 2)
    tt.start('a')
    tt.start('b')
    tt.start('c')
    expect(tt.consume('c')).toBeNull()
    expect(tt.consume('a')).not.toBeNull()
  })
})
