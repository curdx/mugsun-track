import type { PluginContext, TrackPlugin } from '../types'
import type { ExposureParams } from '../core/client'
import { stableStringify } from '../core/utils'

interface WatchState {
  params: ExposureParams
  intersecting: boolean
  timer: ReturnType<typeof setTimeout> | null
}

const MIN_RATIO = 0.5
const MIN_DURATION = 1000

/**
 * $exposure：IntersectionObserver 双达标 —— 可见比例 ≥50% 且持续 ≥1s 才计有效曝光。
 * 同会话内同元素同参数只记一次（去重集合随会话 id 隔离）；
 * 列表分页/虚拟滚动重复进入视口不重复计。
 */
export function exposurePlugin(): TrackPlugin {
  return {
    name: 'exposure',
    setup(ctx: PluginContext) {
      const { client } = ctx
      const seen = new Set<string>()
      const states = new Map<Element, WatchState>()
      const elIds = new WeakMap<Element, number>()
      let seq = 0

      if (typeof IntersectionObserver === 'undefined') {
        ctx.log('当前环境无 IntersectionObserver，曝光采集停用')
        client.setExposureDelegate(() => {})
        return () => client.setExposureDelegate(null)
      }

      const elId = (el: Element): number => {
        let id = elIds.get(el)
        if (id === undefined) {
          id = ++seq
          elIds.set(el, id)
        }
        return id
      }

      const dedupeKey = (el: Element, params: ExposureParams): string =>
        `${client.getSessionId()}|${elId(el)}|${stableStringify({
          event: params.event ?? '$exposure',
          props: params.props ?? {}
        })}`

      const fire = (el: Element, state: WatchState) => {
        if (!state.intersecting) return
        const key = dedupeKey(el, state.params)
        if (seen.has(key)) return
        seen.add(key)
        io.unobserve(el)
        states.delete(el)
        client.track(state.params.event ?? '$exposure', state.params.props)
      }

      const io = new IntersectionObserver(
        (entries) => {
          for (const entry of entries) {
            const el = entry.target
            const state = states.get(el)
            if (!state) continue
            const hit = entry.isIntersecting && entry.intersectionRatio >= MIN_RATIO
            state.intersecting = hit
            if (hit && !state.timer) {
              state.timer = setTimeout(() => {
                state.timer = null
                fire(el, state)
              }, MIN_DURATION)
            } else if (!hit && state.timer) {
              clearTimeout(state.timer)
              state.timer = null
            }
          }
        },
        { threshold: [0, MIN_RATIO, 1] }
      )

      client.setExposureDelegate((el, params) => {
        if (states.has(el)) return
        states.set(el, { params, intersecting: false, timer: null })
        io.observe(el)
      })

      return () => {
        client.setExposureDelegate(null)
        io.disconnect()
        for (const state of states.values()) {
          if (state.timer) clearTimeout(state.timer)
        }
        states.clear()
      }
    }
  }
}
