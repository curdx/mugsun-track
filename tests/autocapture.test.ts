// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { autocapturePlugin } from '../src/plugins/autocapture'
import { allEvents, createTestClient, destroyAllClients } from './helpers'

afterEach(() => destroyAllClients())

async function clickAndCollect(el: Element, maskSelectors: string[] = []) {
  const t = createTestClient({ plugins: [autocapturePlugin()], maskSelectors })
  el.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
  await t.client.flush()
  return allEvents(t.sent).filter((e) => e.event === '$click')
}

describe('autocapture 插件（掩码与隐私规则）', () => {
  beforeEach(() => {
    document.body.innerHTML = ''
  })

  it('点击按钮上报 $click：tag/id/截断文本', async () => {
    const btn = document.createElement('button')
    btn.id = 'buy'
    btn.textContent = '立即购买'
    document.body.appendChild(btn)
    const events = await clickAndCollect(btn)
    expect(events).toHaveLength(1)
    expect(events[0]?.props).toMatchObject({
      tag: 'button',
      element_id: 'buy',
      element_text: '立即购买'
    })
    expect(events[0]?.props.value).toBeUndefined()
  })

  it('普通文本输入框点击不产生事件（不在可点集合），且任何事件都不含 value', async () => {
    const input = document.createElement('input')
    input.type = 'text'
    input.value = 'user-secret'
    document.body.appendChild(input)
    const events = await clickAndCollect(input)
    expect(events).toHaveLength(0)
  })

  it('password 输入框整块屏蔽', async () => {
    const pw = document.createElement('input')
    pw.type = 'password'
    pw.value = 'p@ss'
    const wrap = document.createElement('div')
    wrap.setAttribute('data-track-click', '')
    wrap.appendChild(pw)
    document.body.appendChild(wrap)
    const events = await clickAndCollect(pw)
    expect(events).toHaveLength(0)
  })

  it('maskSelectors 命中的子树整体屏蔽', async () => {
    const zone = document.createElement('div')
    zone.className = 'sensitive-zone'
    const btn = document.createElement('button')
    btn.textContent = '内部按钮'
    zone.appendChild(btn)
    document.body.appendChild(zone)
    const events = await clickAndCollect(btn, ['.sensitive-zone'])
    expect(events).toHaveLength(0)
  })

  it('链接点击带 href，无 value 字段', async () => {
    const a = document.createElement('a')
    a.href = '/orders'
    a.textContent = '订单'
    document.body.appendChild(a)
    const events = await clickAndCollect(a)
    expect(events).toHaveLength(1)
    expect(events[0]?.props.href).toBe('/orders')
    expect(events[0]?.props.value).toBeUndefined()
  })

  it('表单提交上报 form_submit：不含任何输入值', async () => {
    const form = document.createElement('form')
    form.id = 'login-form'
    form.action = '/login'
    form.method = 'post'
    const input = document.createElement('input')
    input.name = 'username'
    input.value = 'somebody'
    form.appendChild(input)
    document.body.appendChild(form)

    const t = createTestClient({ plugins: [autocapturePlugin()] })
    form.dispatchEvent(new window.Event('submit', { bubbles: true }))
    await t.client.flush()
    const events = allEvents(t.sent).filter((e) => e.event === 'form_submit')
    expect(events).toHaveLength(1)
    expect(events[0]?.props.form_id).toBe('login-form')
    expect(events[0]?.props.form_action).toBe('/login')
    expect(JSON.stringify(events[0]?.props)).not.toContain('somebody')
  })

  it('长文本截断 64 字符', async () => {
    const btn = document.createElement('button')
    btn.textContent = '长'.repeat(100)
    document.body.appendChild(btn)
    const events = await clickAndCollect(btn)
    expect((events[0]?.props.element_text as string).length).toBe(64)
  })
})
