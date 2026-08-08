import type { KeyValueStore } from '../types'
import { safeParse, uuid } from './utils'

export interface SessionState {
  id: string
  startAt: number
  lastActivity: number
}

export interface TouchResult {
  session: SessionState
  /** 本次 touch 新建了会话 */
  isNew: boolean
  /** 因滑动过期被轮换掉的旧会话（无则为 null） */
  expired: SessionState | null
}

/**
 * 会话管理：30min 滑动过期。
 * 状态存 localStorage（KV 抽象注入），同浏览器多标签页共享同一会话，
 * 任一标签页活动即为整会话续期；每次 touch 先读最新状态再写回，
 * 因此跨标签页的续期即时可见。
 */
export class SessionManager {
  constructor(
    private kv: KeyValueStore,
    private storageKey: string,
    private timeoutMs: number = 30 * 60 * 1000
  ) {}

  touch(now: number): TouchResult {
    const saved = this.read()
    if (!saved) {
      const session = this.create(now)
      return { session, isNew: true, expired: null }
    }
    if (now - saved.lastActivity > this.timeoutMs) {
      const session = this.create(now)
      return { session, isNew: true, expired: saved }
    }
    const session: SessionState = { ...saved, lastActivity: now }
    this.write(session)
    return { session, isNew: false, expired: null }
  }

  /** 只读当前会话（不续期） */
  current(): SessionState | null {
    return this.read()
  }

  private create(now: number): SessionState {
    const session: SessionState = { id: uuid(), startAt: now, lastActivity: now }
    this.write(session)
    return session
  }

  private read(): SessionState | null {
    const s = safeParse<SessionState>(this.kv.getItem(this.storageKey))
    if (!s || typeof s.id !== 'string') return null
    return s
  }

  private write(session: SessionState): void {
    try {
      this.kv.setItem(this.storageKey, JSON.stringify(session))
    } catch {
      // 写失败时退化为内存态，下次 touch 重建
    }
  }
}
