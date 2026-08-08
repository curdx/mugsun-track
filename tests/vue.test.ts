// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, defineComponent, h } from 'vue'
import MugsunTrack, { TRACK_INJECT_KEY, type RouterLike } from '../src/vue/index'
import { createTrackDirective } from '../src/vue/directive'
import type { TrackClient } from '../src/core/client'
import type { TrackPayload } from '../src/types'
import { allEvents, createTestClient, destroyAllClients, type SendRecord } from './helpers'

const sent: SendRecord[] = []

beforeEach(() => {
  sent.length = 0
  // node 自带 CompressionStream 会触发 gzip 分支（body 变 ArrayBuffer），测试里关掉以便断言 JSON
  vi.stubGlobal('CompressionStream', undefined)
  vi.stubGlobal('fetch', async (_url: string, init?: { body?: string }) => {
    if (init?.body)
      sent.push({ payload: JSON.parse(init.body) as TrackPayload, preferBeacon: false })
    return new Response(null, { status: 204 })
  })
})

afterEach(() => {
  destroyAllClients()
  vi.unstubAllGlobals()
})

interface RouterStub extends RouterLike {
  navigate(to: { path: string; matched?: Array<{ path: string }> }): void
}

function makeRouter(): RouterStub {
  const hooks: Array<(to: never, from: never) => void> = []
  const router: RouterStub = {
    currentRoute: { value: { path: '/', matched: [{ path: '/' }] } },
    afterEach(fn) {
      hooks.push(fn as never)
    },
    navigate(to) {
      const from = this.currentRoute.value
      this.currentRoute.value = to
      for (const fn of hooks) fn(to as never, from as never)
    }
  }
  return router
}

function installApp(router?: RouterStub): {
  app: ReturnType<typeof createApp>
  client: TrackClient
} {
  const app = createApp(defineComponent({ render: () => h('div') }))
  app.use(MugsunTrack, {
    appKey: 'vue-app',
    endpoint: 'https://t.example.com',
    release: '3.1.0',
    fetchRemoteConfig: false,
    router
  })
  const client = app._context.provides[TRACK_INJECT_KEY as symbol] as TrackClient
  return { app, client }
}

describe('Vue 集成', () => {
  it('install：provide 客户端并注册 $track 全局属性', () => {
    const { app, client } = installApp()
    expect(client).toBeTruthy()
    expect(app.config.globalProperties.$track).toBe(client)
  })

  it('router 集成：afterEach 驱动路由配对，route_path 取 matched 模板', async () => {
    const router = makeRouter()
    const { client } = installApp(router)
    await client.flush()
    router.navigate({ path: '/user/42/detail', matched: [{ path: '/user/:id/detail' }] })
    await client.flush()
    const events = allEvents(sent)
    const leave = events.find((e) => e.event === '$pageleave')
    const views = events.filter((e) => e.event === '$pageview')
    expect(leave?.props.url_path).toBe('/')
    const last = views.at(-1)
    expect(last?.props.url_path).toBe('/user/42/detail')
    expect(last?.props.route_path).toBe('/user/:id/detail')
    // 公共属性 route_path 也来自路由模板
    expect(client.getRoutePath()).toBe('/user/:id/detail')
  })

  it('errorHandler 挂接：$error 带 vue_info/release，并保留原 handler 链', async () => {
    const { app, client } = installApp()
    const prev = app.config.errorHandler
    const prevCalls: string[] = []
    // 宿主在 install 之后再注册自己的 handler，应包在埋点上报之外形成调用链
    app.config.errorHandler = (err, instance, info) => {
      prevCalls.push(info)
      prev?.(err, instance, info)
    }
    app.config.errorHandler(new Error('vue boom'), null, 'setup')
    await client.flush()
    const ev = allEvents(sent).find((e) => e.event === '$error')
    expect(ev?.props.error_type).toBe('vue')
    expect(ev?.props.message).toBe('vue boom')
    expect(ev?.props.vue_info).toBe('setup')
    expect(ev?.props.release).toBe('3.1.0')
    expect(prevCalls).toEqual(['setup'])
  })

  it('v-track:click 指令', async () => {
    const t = createTestClient()
    const dir = createTrackDirective(() => t.client)
    const el = document.createElement('button')
    document.body.appendChild(el)
    // @ts-expect-error 指令钩子直接调用
    dir.mounted?.(el, { arg: 'click', value: { event: 'cta_click', props: { pos: 'hero' } } })
    el.dispatchEvent(new window.Event('click'))
    await t.client.flush()
    const ev = allEvents(t.sent).find((e) => e.event === 'cta_click')
    expect(ev?.props.pos).toBe('hero')
    // @ts-expect-error 卸载清理
    dir.unmounted?.(el)
  })

  it('v-track 字符串简写 + exposure 参数透传', async () => {
    const t = createTestClient()
    const exposed: Array<{ el: Element; event?: string }> = []
    t.client.setExposureDelegate((el, params) => exposed.push({ el, event: params.event }))
    const dir = createTrackDirective(() => t.client)
    const el = document.createElement('div')
    // @ts-expect-error 直接调用
    dir.mounted?.(el, { arg: 'exposure', value: 'banner_show' })
    expect(exposed).toHaveLength(1)
    expect(exposed[0]?.event).toBe('banner_show')
  })
})
