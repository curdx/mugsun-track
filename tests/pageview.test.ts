// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest'
import { pageviewPlugin } from '../src/plugins/pageview'
import { allEvents, createTestClient, destroyAllClients } from './helpers'

afterEach(() => destroyAllClients())

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

describe('pageview 插件（SPA 路由配对）', () => {
  it('首屏只发 $pageview，不带 $pageleave', async () => {
    const t = createTestClient({ plugins: [pageviewPlugin()] })
    await t.client.flush()
    const names = allEvents(t.sent).map((e) => e.event)
    expect(names).toContain('$pageview')
    expect(names).not.toContain('$pageleave')
    const pv = allEvents(t.sent).find((e) => e.event === '$pageview')
    expect(pv?.props.url_path).toBe(window.location.pathname)
  })

  it('pushState 路由切换：上一页 $pageleave（带 duration）→ 新页 $pageview 成对', async () => {
    const t = createTestClient({ plugins: [pageviewPlugin()] })
    await t.client.flush()
    await sleep(5)
    window.history.pushState({}, '', '/next')
    await sleep(10) // 插件 setTimeout(0) 等标题落定
    await t.client.flush()
    const names = allEvents(t.sent).map((e) => e.event)
    const leaveIdx = names.indexOf('$pageleave')
    const viewIdx = names.lastIndexOf('$pageview')
    expect(leaveIdx).toBeGreaterThan(-1)
    expect(viewIdx).toBeGreaterThan(leaveIdx)
    const events = allEvents(t.sent)
    expect(events[leaveIdx]?.props.url_path).toBe('/')
    expect(typeof events[leaveIdx]?.props.duration_ms).toBe('number')
    expect(events[viewIdx]?.props.url_path).toBe('/next')
  })

  it('hashchange 同样触发配对', async () => {
    const t = createTestClient({ plugins: [pageviewPlugin()] })
    await t.client.flush()
    window.location.hash = '#/sub'
    window.dispatchEvent(new Event('hashchange'))
    await sleep(10)
    await t.client.flush()
    const names = allEvents(t.sent).map((e) => e.event)
    expect(names).toContain('$pageleave')
  })

  it('同 path 重复 pushState（仅 query 变化）不重复上报', async () => {
    const t = createTestClient({ plugins: [pageviewPlugin()] })
    await t.client.flush()
    window.history.pushState({}, '', '/same?a=1')
    await sleep(10)
    window.history.pushState({}, '', '/same?a=2')
    await sleep(10)
    await t.client.flush()
    const pvs = allEvents(t.sent).filter((e) => e.event === '$pageview')
    // 首屏 '/' + 切到 '/same' 各一次；'/same?a=2' 仅 query 变化不再计
    expect(pvs).toHaveLength(2)
    expect(pvs.filter((e) => e.props.url_path === '/same')).toHaveLength(1)
  })

  it('手动模式：notifyRouteChange 驱动配对并写 route_path 模板', async () => {
    const t = createTestClient({ plugins: [pageviewPlugin({ manual: true })] })
    await t.client.flush()
    t.client.notifyRouteChange({
      url_path: '/user/42/detail',
      route_path: '/user/:id/detail',
      title: 'U'
    })
    await t.client.flush()
    const events = allEvents(t.sent)
    const leave = events.find((e) => e.event === '$pageleave')
    const view = events.filter((e) => e.event === '$pageview').at(-1)
    expect(leave).toBeTruthy()
    expect(view?.props.url_path).toBe('/user/42/detail')
    expect(view?.props.route_path).toBe('/user/:id/detail')
  })
})
