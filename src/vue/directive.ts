import type { Directive } from 'vue'
import type { TrackClient } from '../core/client'
import type { Props } from '../types'

export interface TrackDirectiveValue {
  event: string
  props?: Props
}

function normalize(value: unknown): TrackDirectiveValue | null {
  if (typeof value === 'string' && value) return { event: value }
  if (value && typeof value === 'object') {
    const v = value as TrackDirectiveValue
    if (typeof v.event === 'string' && v.event) return v
  }
  return null
}

const HANDLER_KEY = '__mstTrackClick__'

/**
 * v-track 声明式埋点：
 *   v-track:click="'event_name'" 或 v-track:click="{ event, props }"
 *   v-track:exposure="{ event, props }"（走曝光插件的有效曝光口径）
 */
export function createTrackDirective(getClient: () => TrackClient | null): Directive {
  return {
    mounted(el: HTMLElement, binding) {
      const value = normalize(binding.value)
      if (!value) return
      const arg = binding.arg ?? 'click'
      if (arg === 'click') {
        const handler = () => getClient()?.track(value.event, value.props)
        ;(el as unknown as Record<string, unknown>)[HANDLER_KEY] = handler
        el.addEventListener('click', handler)
      } else if (arg === 'exposure') {
        getClient()?.trackExposure(el, { event: value.event, props: value.props })
      }
    },
    unmounted(el: HTMLElement) {
      const handler = (el as unknown as Record<string, unknown>)[HANDLER_KEY]
      if (typeof handler === 'function') {
        el.removeEventListener('click', handler as EventListener)
        delete (el as unknown as Record<string, unknown>)[HANDLER_KEY]
      }
    }
  }
}
