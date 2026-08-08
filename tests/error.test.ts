// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest'
import { errorPlugin, fingerprintOf } from '../src/plugins/error'
import { allEvents, createTestClient, destroyAllClients } from './helpers'

afterEach(() => destroyAllClients())

const STACK = `Error: boom\n    at fn (https://cdn.example.com/app.js:12:34)\n    at main (https://cdn.example.com/main.js:1:2)`

describe('error 插件', () => {
  it('fingerprint = message + 堆栈首帧 hash：同因同纹、异因异纹', () => {
    const f1 = fingerprintOf('boom', STACK)
    const f2 = fingerprintOf('boom', STACK)
    const f3 = fingerprintOf('other', STACK)
    const f4 = fingerprintOf(
      'boom',
      'Error: boom\n    at fn (https://cdn.example.com/other.js:9:9)'
    )
    expect(f1).toBe(f2)
    expect(f1).not.toBe(f3)
    expect(f1).not.toBe(f4)
    // 同文件不同行列号（压缩代码构建波动）指纹不变
    const shifted = STACK.replace('app.js:12:34', 'app.js:99:88')
    expect(fingerprintOf('boom', shifted)).toBe(f1)
  })

  it('window error 事件上报 $error：带 release 与 fingerprint', async () => {
    const t = createTestClient({ plugins: [errorPlugin()], release: '2.0.1' })
    const err = new Error('boom')
    err.stack = STACK
    window.dispatchEvent(new window.ErrorEvent('error', { message: 'boom', error: err }))
    await t.client.flush()
    const ev = allEvents(t.sent).find((e) => e.event === '$error')
    expect(ev).toBeTruthy()
    expect(ev?.props.error_type).toBe('js')
    expect(ev?.props.message).toBe('boom')
    expect(ev?.props.release).toBe('2.0.1')
    expect(ev?.props.error_fingerprint).toBe(fingerprintOf('boom', STACK))
  })

  it('捕获阶段资源加载错误：error_type=resource', async () => {
    const t = createTestClient({ plugins: [errorPlugin()] })
    const img = document.createElement('img')
    img.src = 'https://cdn.example.com/missing.png'
    document.body.appendChild(img)
    img.dispatchEvent(new window.Event('error'))
    await t.client.flush()
    const ev = allEvents(t.sent).find((e) => e.event === '$error')
    expect(ev?.props.error_type).toBe('resource')
    expect(ev?.props.element_tag).toBe('img')
    expect(ev?.props.resource_url).toContain('missing.png')
  })

  it('unhandledrejection：Error 与普通值都能上报', async () => {
    const t = createTestClient({ plugins: [errorPlugin()] })
    const rej1 = new window.Event('unhandledrejection') as PromiseRejectionEvent
    Object.defineProperty(rej1, 'reason', { value: new Error('async fail') })
    window.dispatchEvent(rej1)
    const rej2 = new window.Event('unhandledrejection') as PromiseRejectionEvent
    Object.defineProperty(rej2, 'reason', { value: 'string reason' })
    window.dispatchEvent(rej2)
    await t.client.flush()
    const evs = allEvents(t.sent).filter((e) => e.event === '$error')
    expect(evs).toHaveLength(2)
    expect(evs[0]?.props).toMatchObject({ error_type: 'promise', message: 'async fail' })
    expect(evs[1]?.props.message).toBe('string reason')
  })
})
