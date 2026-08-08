import type { KeyValueStore } from '../types'
import { safeParse, uuid } from './utils'

interface IdentityState {
  /** anonymous_id：crypto.randomUUID 持久化 */
  a: string
  /** identify 绑定的登录用户 */
  u: string | number | null
}

/**
 * 身份管理：distinct_id 恒为 anonymous_id；
 * identify(user_id) 绑定（绑定落库由服务端按 token 裁定），reset() 换匿名身份。
 */
export class IdentityManager {
  private state: IdentityState

  constructor(
    private kv: KeyValueStore,
    private storageKey: string
  ) {
    const saved = safeParse<IdentityState>(kv.getItem(storageKey))
    if (saved?.a) {
      this.state = { a: saved.a, u: saved.u ?? null }
    } else {
      this.state = { a: uuid(), u: null }
      this.persist()
    }
  }

  get distinctId(): string {
    return this.state.a
  }

  get userId(): string | number | null {
    return this.state.u
  }

  identify(userId: string | number): void {
    this.state.u = userId
    this.persist()
  }

  /** 登出/切换账号：清空登录身份并更换 anonymous_id，避免串号 */
  reset(): void {
    this.state = { a: uuid(), u: null }
    this.persist()
  }

  private persist(): void {
    try {
      this.kv.setItem(this.storageKey, JSON.stringify(this.state))
    } catch {
      // 隐私模式等写失败场景：身份退化为本次内存态
    }
  }
}
