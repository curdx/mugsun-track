import type { Clock } from '../types'

export class SystemClock implements Clock {
  now(): number {
    return Date.now()
  }
}
