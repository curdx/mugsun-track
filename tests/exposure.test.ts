// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { exposurePlugin } from '../src/plugins/exposure'
import { allEvents, createTestClient, destroyAllClients } from './helpers'

interface FakeEntry {
  target: Element
  isIntersecting: boolean
  intersectionRatio: number
}

class FakeIO {
  static instances: FakeIO[] = []
  private cb: IntersectionObserverCallback
  elements = new Set<Element>()

  constructor(cb: IntersectionObserverCallback) {
    this.cb = cb
    FakeIO.instances.push(this)
  }

  observe(el: Element): void {
    this.elements.add(el)
  }

  unobserve(el: Element): void {
    this.elements.delete(el)
  }

  disconnect(): void {
    this.elements.clear()
  }

  trigger(entries: FakeEntry[]): void {
    this.cb(
      entries as unknown as IntersectionObserverEntry[],
      this as unknown as IntersectionObserver
    )
  }
}

afterEach(() => {
  destroyAllClients()
  vi.unstubAllGlobals()
})

describe('exposure 插件（≥50% 且持续 ≥1s，同会话同元素同参数去重）', () => {
  beforeEach(() => {
    vi.stubGlobal('IntersectionObserver', FakeIO)
    FakeIO.instances = []
    vi.useFakeTimers()
  })
  afterEach(() => vi.useRealTimers())

  function setupEl() {
    const t = createTestClient({ plugins: [exposurePlugin()] })
    const el = document.createElement('div')
    document.body.appendChild(el)
    return { t, el, io: FakeIO.instances[0]! }
  }

  it('可见 ≥50% 持续 1s 触发一次有效曝光', async () => {
    const { t, el, io } = setupEl()
    t.client.trackExposure(el, { event: 'banner_view', props: { id: 1 } })
    io.trigger([{ target: el, isIntersecting: true, intersectionRatio: 0.6 }])
    await vi.advanceTimersByTimeAsync(999)
    await t.client.flush()
    expect(allEvents(t.sent).filter((e) => e.event === 'banner_view')).toHaveLength(0)
    await vi.advanceTimersByTimeAsync(1)
    await t.client.flush()
    const evs = allEvents(t.sent).filter((e) => e.event === 'banner_view')
    expect(evs).toHaveLength(1)
    expect(evs[0]?.props.id).toBe(1)
  })

  it('同会话同元素同参数重复进入视口不重复计', async () => {
    const { t, el, io } = setupEl()
    t.client.trackExposure(el, { event: 'banner_view', props: { id: 1 } })
    io.trigger([{ target: el, isIntersecting: true, intersectionRatio: 0.8 }])
    await vi.advanceTimersByTimeAsync(1000)
    // 有效曝光后 unobserve；业务侧可能再次注册（虚拟滚动重建），再次触发应被去重
    t.client.trackExposure(el, { event: 'banner_view', props: { id: 1 } })
    io.trigger([{ target: el, isIntersecting: true, intersectionRatio: 0.8 }])
    await vi.advanceTimersByTimeAsync(2000)
    await t.client.flush()
    expect(allEvents(t.sent).filter((e) => e.event === 'banner_view')).toHaveLength(1)
  })

  it('参数不同视为新曝光', async () => {
    const { t, el, io } = setupEl()
    t.client.trackExposure(el, { event: 'banner_view', props: { id: 1 } })
    io.trigger([{ target: el, isIntersecting: true, intersectionRatio: 1 }])
    await vi.advanceTimersByTimeAsync(1000)
    t.client.trackExposure(el, { event: 'banner_view', props: { id: 2 } })
    io.trigger([{ target: el, isIntersecting: true, intersectionRatio: 1 }])
    await vi.advanceTimersByTimeAsync(1000)
    await t.client.flush()
    expect(allEvents(t.sent).filter((e) => e.event === 'banner_view')).toHaveLength(2)
  })

  it('可见比例不足 50% 不计', async () => {
    const { t, el, io } = setupEl()
    t.client.trackExposure(el, { event: 'half_view' })
    io.trigger([{ target: el, isIntersecting: true, intersectionRatio: 0.3 }])
    await vi.advanceTimersByTimeAsync(3000)
    await t.client.flush()
    expect(allEvents(t.sent).filter((e) => e.event === 'half_view')).toHaveLength(0)
  })

  it('持续不足 1s 被打断不计', async () => {
    const { t, el, io } = setupEl()
    t.client.trackExposure(el, { event: 'short_view' })
    io.trigger([{ target: el, isIntersecting: true, intersectionRatio: 0.9 }])
    await vi.advanceTimersByTimeAsync(400)
    io.trigger([{ target: el, isIntersecting: false, intersectionRatio: 0 }])
    await vi.advanceTimersByTimeAsync(2000)
    await t.client.flush()
    expect(allEvents(t.sent).filter((e) => e.event === 'short_view')).toHaveLength(0)
  })

  it('默认事件名 $exposure', async () => {
    const { t, el, io } = setupEl()
    t.client.trackExposure(el, { props: { slot: 'footer' } })
    io.trigger([{ target: el, isIntersecting: true, intersectionRatio: 1 }])
    await vi.advanceTimersByTimeAsync(1000)
    await t.client.flush()
    const evs = allEvents(t.sent).filter((e) => e.event === '$exposure')
    expect(evs).toHaveLength(1)
    expect(evs[0]?.props.slot).toBe('footer')
  })
})
