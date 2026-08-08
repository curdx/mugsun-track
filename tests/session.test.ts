import { describe, expect, it } from 'vitest'
import { SessionManager } from '../src/core/session'
import { MemoryKeyValueStore } from '../src/core/storage'

const TIMEOUT = 30 * 60 * 1000
const KEY = 'mst:app:session'

describe('会话管理（30min 滑动）', () => {
  it('首次 touch 新建会话并持久化', () => {
    const kv = new MemoryKeyValueStore()
    const sm = new SessionManager(kv, KEY, TIMEOUT)
    const r = sm.touch(1000)
    expect(r.isNew).toBe(true)
    expect(r.expired).toBeNull()
    expect(r.session.id).toBeTruthy()
    expect(kv.getItem(KEY)).toContain(r.session.id)
  })

  it('滑动窗口内活动即续期，不新建会话', () => {
    const kv = new MemoryKeyValueStore()
    const sm = new SessionManager(kv, KEY, TIMEOUT)
    const first = sm.touch(0)
    const later = sm.touch(TIMEOUT - 1)
    expect(later.isNew).toBe(false)
    expect(later.session.id).toBe(first.session.id)
    expect(later.session.lastActivity).toBe(TIMEOUT - 1)
  })

  it('静默超 30min 轮换：返回 expired 旧会话', () => {
    const kv = new MemoryKeyValueStore()
    const sm = new SessionManager(kv, KEY, TIMEOUT)
    const first = sm.touch(0)
    const rotated = sm.touch(TIMEOUT + 1)
    expect(rotated.isNew).toBe(true)
    expect(rotated.expired?.id).toBe(first.session.id)
    expect(rotated.session.id).not.toBe(first.session.id)
  })

  it('多标签页共享：两个实例共用 localStorage（同一 KV）即同一会话', () => {
    const sharedLocalStorage = new MemoryKeyValueStore()
    const tabA = new SessionManager(sharedLocalStorage, KEY, TIMEOUT)
    const tabB = new SessionManager(sharedLocalStorage, KEY, TIMEOUT)
    const a = tabA.touch(0)
    const b = tabB.touch(10_000)
    expect(b.isNew).toBe(false)
    expect(b.session.id).toBe(a.session.id)
  })

  it('多标签页共享：标签页 A 的活动为标签页 B 续期', () => {
    const shared = new MemoryKeyValueStore()
    const tabA = new SessionManager(shared, KEY, TIMEOUT)
    const tabB = new SessionManager(shared, KEY, TIMEOUT)
    const a = tabA.touch(0)
    // B 在 29min 时活动（续期写回共享存储），A 在 31min 时仍在窗口内
    tabB.touch(29 * 60 * 1000)
    const aLater = tabA.touch(31 * 60 * 1000)
    expect(aLater.isNew).toBe(false)
    expect(aLater.session.id).toBe(a.session.id)
  })

  it('反证：若用 sessionStorage（每标签页独立存储），同浏览器两标签页会裂成两个会话', () => {
    // 两个独立 KV 模拟 sessionStorage 的每标签页隔离语义 —— 故本 SDK 选择 localStorage
    const tabAStorage = new MemoryKeyValueStore()
    const tabBStorage = new MemoryKeyValueStore()
    const a = new SessionManager(tabAStorage, KEY, TIMEOUT).touch(0)
    const b = new SessionManager(tabBStorage, KEY, TIMEOUT).touch(1)
    expect(b.isNew).toBe(true)
    expect(b.session.id).not.toBe(a.session.id)
  })
})
