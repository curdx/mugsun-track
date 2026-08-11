// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { visualTrack } from '../src/plugins/visual-track'
import type { TrackOptions, VisualRule } from '../src/types'
import { allEvents, createTestClient, destroyAllClients, type TestClient } from './helpers'

const CONFIG_KEY = 'mst:test-app:config'
const BASE_URL = 'https://app.example.com/home'
const INSPECT_URL = 'https://app.example.com/orders?__mst_inspect=tok-1&b=2'

const origFetch = window.fetch

afterEach(() => {
  destroyAllClients()
  window.fetch = origFetch
})

beforeEach(() => {
  document.body.innerHTML = ''
  window.location.href = BASE_URL
})

function click(el: Element): MouseEvent {
  const ev = new window.MouseEvent('click', { bubbles: true, cancelable: true })
  el.dispatchEvent(ev)
  return ev
}

function setupRules(rules: VisualRule[], options: Partial<TrackOptions> = {}): TestClient {
  return createTestClient({ ...options, visualRules: rules, plugins: [visualTrack()] })
}

async function eventsOf(t: TestClient, event: string) {
  await t.client.flush()
  return allEvents(t.sent).filter((e) => e.event === event)
}

// ---------------------------------------------------------------- 正常模式

describe('visual-track 正常模式（visualRules 命中上报）', () => {
  it('规则命中 → client.track 正确事件名与 props（element_text 截 64）', async () => {
    const btn = document.createElement('button')
    btn.id = 'buy'
    btn.textContent = '立即购买'
    document.body.appendChild(btn)
    const t = setupRules([{ event: 'buy_click', selector: '#buy' }])
    click(btn)
    const events = await eventsOf(t, 'buy_click')
    expect(events).toHaveLength(1)
    expect(events[0]?.props.vs_selector).toBe('#buy')
    expect(events[0]?.props.element_text).toBe('立即购买')
  })

  it('多个规则命中同一事件名去重，不同事件名各自上报', async () => {
    const btn = document.createElement('button')
    btn.id = 'buy'
    btn.textContent = '购买'
    document.body.appendChild(btn)
    const t = setupRules([
      { event: 'buy_click', selector: '#buy' },
      { event: 'buy_click', selector: 'button' },
      { event: 'buy_alias', selector: 'button' }
    ])
    click(btn)
    expect(await eventsOf(t, 'buy_click')).toHaveLength(1)
    expect(await eventsOf(t, 'buy_alias')).toHaveLength(1)
  })

  it('mask 子树不触发（硬屏蔽 + maskSelectors）', async () => {
    const zone = document.createElement('div')
    zone.setAttribute('data-track-mask', '')
    const btn = document.createElement('button')
    btn.id = 'buy'
    zone.appendChild(btn)
    document.body.appendChild(zone)
    const t = setupRules([{ event: 'buy_click', selector: '#buy' }])
    click(btn)
    expect(await eventsOf(t, 'buy_click')).toHaveLength(0)
  })

  it('rules 为空/未设置不装 click 监听（零开销）', async () => {
    const btn = document.createElement('button')
    btn.id = 'buy'
    document.body.appendChild(btn)
    for (const visualRules of [undefined, []] as Array<VisualRule[] | undefined>) {
      const spy = vi.spyOn(document, 'addEventListener')
      const t = createTestClient({ plugins: [visualTrack()], visualRules })
      expect(spy.mock.calls.filter((c) => c[0] === 'click')).toHaveLength(0)
      spy.mockRestore()
      const trackSpy = vi.spyOn(t.client, 'track')
      click(btn)
      expect(trackSpy).not.toHaveBeenCalled()
      trackSpy.mockRestore()
      t.client.destroy()
    }
  })

  it('routePath/matchText 限定参与命中', async () => {
    const btn = document.createElement('button')
    btn.id = 'p'
    btn.textContent = '立即购买'
    document.body.appendChild(btn)
    const rules: VisualRule[] = [
      { event: 'ev_route', selector: '#p', routePath: '/orders' },
      { event: 'ev_text', selector: '#p', matchText: '购买' },
      { event: 'ev_text_miss', selector: '#p', matchText: '抢购' }
    ]
    // 有路由模板且前缀命中
    const t = setupRules(rules)
    t.client.setRoutePathProvider(() => '/orders/detail')
    click(btn)
    expect(await eventsOf(t, 'ev_route')).toHaveLength(1)
    expect(await eventsOf(t, 'ev_text')).toHaveLength(1)
    expect(await eventsOf(t, 'ev_text_miss')).toHaveLength(0)
    t.client.destroy()
    // 无路由模板（getRoutePath undefined）：routePath 限定规则不命中
    const t2 = setupRules(rules)
    click(btn)
    expect(await eventsOf(t2, 'ev_route')).toHaveLength(0)
    expect(await eventsOf(t2, 'ev_text')).toHaveLength(1)
  })

  it('远端缓存 visualRules 下次启动生效：非法项过滤、本地显式设置优先', async () => {
    const t = createTestClient()
    t.kv.setItem(
      CONFIG_KEY,
      JSON.stringify({
        visualRules: [
          { event: 'remote_ev', selector: '#r' },
          { event: '$bad', selector: '#x' },
          { event: 123, selector: '#y' },
          { event: 'no_selector' },
          'garbage'
        ]
      })
    )
    const t2 = createTestClient({ plugins: [visualTrack()] }, { kv: t.kv })
    expect(t2.client.options.visualRules).toEqual([
      { event: 'remote_ev', selector: '#r', routePath: null, matchText: null }
    ])
    const btn = document.createElement('button')
    btn.id = 'r'
    document.body.appendChild(btn)
    click(btn)
    expect(await eventsOf(t2, 'remote_ev')).toHaveLength(1)
    // 本地显式设置（含空数组）覆盖远端下发
    const t3 = createTestClient({ plugins: [visualTrack()], visualRules: [] }, { kv: t.kv })
    expect(t3.client.options.visualRules).toEqual([])
  })
})

// ---------------------------------------------------------------- inspect 模式

/** root 子节点顺序：highlight / bar / panel / toast（与插件实现同序） */
function uiParts() {
  const root = document.querySelector('[data-mst-inspect-ui]') as HTMLElement | null
  expect(root).toBeTruthy()
  const [highlight, bar, panel, toast] = Array.from(root!.children) as HTMLElement[]
  return { root: root!, highlight, bar, panel, toast }
}

function panelControls(panel: HTMLElement) {
  const input = panel.querySelector('input')!
  const [submitBtn, reselectBtn] = Array.from(
    panel.querySelectorAll('button')
  ) as HTMLButtonElement[]
  return { input, submitBtn, reselectBtn }
}

describe('visual-track inspect 模式（__mst_inspect 圈选）', () => {
  it('URL 带 __mst_inspect 即激活：浮层创建、悬停高亮、屏蔽元素不高亮', () => {
    window.location.href = INSPECT_URL
    createTestClient({ plugins: [visualTrack()] })
    const { highlight, bar, panel } = uiParts()
    expect(bar.textContent).toContain('圈选模式：点击元素完成圈选，Esc 退出')
    expect(panel.style.display).toBe('none')
    const btn = document.createElement('button')
    btn.id = 'pick'
    document.body.appendChild(btn)
    btn.dispatchEvent(new window.MouseEvent('mouseover', { bubbles: true }))
    expect(highlight.style.display).toBe('block')
    // 屏蔽元素不高亮
    const masked = document.createElement('div')
    masked.setAttribute('data-track-mask', '')
    document.body.appendChild(masked)
    masked.dispatchEvent(new window.MouseEvent('mouseover', { bubbles: true }))
    expect(highlight.style.display).toBe('none')
  })

  it('click 拦截默认行为与页面监听，选定后出底部面板', async () => {
    window.location.href = INSPECT_URL
    const t = createTestClient({ plugins: [visualTrack()] })
    const pageSpy = vi.fn()
    document.addEventListener('click', pageSpy)
    const a = document.createElement('a')
    a.id = 'go'
    a.setAttribute('href', '/jump')
    a.textContent = '去'
    document.body.appendChild(a)
    const ev = click(a)
    expect(ev.defaultPrevented).toBe(true)
    expect(pageSpy).not.toHaveBeenCalled()
    document.removeEventListener('click', pageSpy)
    const { panel } = uiParts()
    expect(panel.style.display).toBe('block')
    expect(panel.textContent).toContain('<a>')
    expect(panel.textContent).toContain('#go')
    // inspect 模式不产生埋点事件
    await t.client.flush()
    expect(allEvents(t.sent)).toHaveLength(0)
  })

  it('屏蔽元素不可选：点击后不出面板', () => {
    window.location.href = INSPECT_URL
    createTestClient({ plugins: [visualTrack()] })
    const zone = document.createElement('div')
    zone.setAttribute('data-track-mask', '')
    const btn = document.createElement('button')
    btn.textContent = '内部'
    zone.appendChild(btn)
    document.body.appendChild(zone)
    click(btn)
    const { panel } = uiParts()
    expect(panel.style.display).toBe('none')
  })

  it('面板事件名即时正则校验：非法红提示禁提交，合法放行', () => {
    window.location.href = INSPECT_URL
    createTestClient({ plugins: [visualTrack()] })
    const btn = document.createElement('button')
    btn.id = 'v'
    document.body.appendChild(btn)
    click(btn)
    const { panel } = uiParts()
    const { input, submitBtn } = panelControls(panel)
    input.value = '$bad'
    input.dispatchEvent(new window.Event('input'))
    expect(submitBtn.disabled).toBe(true)
    expect(panel.textContent).toContain('事件名不合法')
    input.value = 'good_name_1'
    input.dispatchEvent(new window.Event('input'))
    expect(submitBtn.disabled).toBe(false)
  })

  it('提交草稿：独立 fetch POST 字段齐全，成功 toast 并清空面板', async () => {
    window.location.href = INSPECT_URL
    const fetchMock = vi.fn().mockResolvedValue(new Response('', { status: 200 }))
    window.fetch = fetchMock as unknown as typeof fetch
    createTestClient({ plugins: [visualTrack()] })
    const btn = document.createElement('button')
    btn.id = 'x'
    btn.textContent = '加购'
    document.body.appendChild(btn)
    click(btn)
    const { panel, toast } = uiParts()
    const { input, submitBtn } = panelControls(panel)
    input.value = 'add_cart'
    input.dispatchEvent(new window.Event('input'))
    click(submitBtn)
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('https://t.example.com/track/visual/draft')
    expect(init.method).toBe('POST')
    expect(init.keepalive).toBe(true)
    expect(JSON.parse(init.body as string)).toEqual({
      token: 'tok-1',
      event_name: 'add_cart',
      selector: '#x',
      route_path: null,
      match_text: '加购',
      page_url: '/orders'
    })
    await vi.waitFor(() => expect(toast.textContent).toBe('已提交圈选草稿'))
    expect(panel.style.display).toBe('none')
  })

  it('提交失败重试 1 次后成功', async () => {
    window.location.href = INSPECT_URL
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new Error('network down'))
      .mockResolvedValueOnce(new Response('', { status: 200 }))
    window.fetch = fetchMock as unknown as typeof fetch
    createTestClient({ plugins: [visualTrack()] })
    const btn = document.createElement('button')
    btn.id = 'x'
    document.body.appendChild(btn)
    click(btn)
    const { panel, toast } = uiParts()
    const { input, submitBtn } = panelControls(panel)
    input.value = 'retry_ev'
    input.dispatchEvent(new window.Event('input'))
    click(submitBtn)
    await vi.waitFor(() => expect(toast.textContent).toBe('已提交圈选草稿'))
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('Esc 退出：拆全部 DOM + replaceState 清 __mst_inspect 参数（幂等）', () => {
    window.location.href = INSPECT_URL
    createTestClient({ plugins: [visualTrack()] })
    expect(document.querySelector('[data-mst-inspect-ui]')).toBeTruthy()
    document.body.dispatchEvent(
      new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
    )
    expect(document.querySelector('[data-mst-inspect-ui]')).toBeNull()
    expect(window.location.search).toBe('?b=2')
    // 再次 Esc 不炸（teardown 幂等）
    document.body.dispatchEvent(
      new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
    )
    expect(window.location.search).toBe('?b=2')
  })

  it('无 __mst_inspect 参数时不激活 inspect', () => {
    window.location.href = BASE_URL
    createTestClient({ plugins: [visualTrack()], visualRules: [] })
    expect(document.querySelector('[data-mst-inspect-ui]')).toBeNull()
  })
})
