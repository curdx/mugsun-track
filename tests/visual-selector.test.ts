// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from 'vitest'
import { generateSelector, matchesRule } from '../src/plugins/visual-track/selector'

beforeEach(() => {
  document.body.innerHTML = ''
})

describe('generateSelector 唯一性升级', () => {
  it('重复 class 兄弟补 :nth-of-type，逐级升级至 #id 截止', () => {
    document.body.innerHTML = `
      <div id="list-a"><ul><li class="item">a1</li><li class="item">a2</li></ul></div>
      <div id="list-b"><ul><li class="item">b1</li><li class="item">b2</li></ul></div>`
    const target = document.querySelectorAll('#list-a li.item')[1]
    expect(target).toBeTruthy()
    // li.item:nth-of-type(2) 与 ul > li... 均命中 2 个 → 升到 #list-a 截止
    expect(generateSelector(target!, document)).toBe('#list-a > ul > li.item:nth-of-type(2)')
  })

  it('元素自身有 id 即 #id 截止（不再向上拼）', () => {
    document.body.innerHTML = '<div><section><button id="save">存</button></section></div>'
    expect(generateSelector(document.querySelector('#save')!, document)).toBe('#save')
  })

  it('父级有 id 时拼到 id 为止', () => {
    document.body.innerHTML = '<div id="wrap"><button>x</button></div><button>y</button>'
    const target = document.querySelector('#wrap button')!
    expect(generateSelector(target, document)).toBe('#wrap > button')
  })

  it('剔除 :hover 等动态态 class', () => {
    document.body.innerHTML = '<span class="card hover:bg-blue-500 focus:x active">s</span>'
    expect(generateSelector(document.querySelector('span')!, document)).toBe('span.card.active')
  })

  it('body 仍不唯一时返回 body 路径尽力值', () => {
    document.body.innerHTML = '<div class="wrap"><span>s</span></div>'
    const target = document.querySelector('span')!
    // 桩 doc：querySelectorAll 恒不唯一，逼出尽力值分支
    const stubDoc = {
      documentElement: document.documentElement,
      querySelectorAll: () => ({ length: 2 })
    } as unknown as Document
    expect(generateSelector(target, stubDoc)).toBe('body > div.wrap > span')
  })

  it('结果 >512 字符返回 null', () => {
    document.body.innerHTML = `<div class="${'x'.repeat(600)}">s</div>`
    expect(generateSelector(document.querySelector('div')!, document)).toBeNull()
  })
})

describe('matchesRule 三路匹配', () => {
  beforeEach(() => {
    document.body.innerHTML = '<div class="card"><button id="b1">立即购买</button></div>'
  })
  const btn = () => document.querySelector('#b1')!

  it('selector：closest 命中自身或祖先', () => {
    expect(matchesRule(btn(), { event: 'e', selector: '#b1' }, null)).toBe(true)
    expect(matchesRule(btn(), { event: 'e', selector: '.card' }, null)).toBe(true)
    expect(matchesRule(btn(), { event: 'e', selector: '.nope' }, null)).toBe(false)
  })

  it('routePath：前缀限定；null=全站；当前路由 null 时不命中限定规则', () => {
    const rule = { event: 'e', selector: '#b1', routePath: '/orders' }
    expect(matchesRule(btn(), rule, '/orders/123')).toBe(true)
    expect(matchesRule(btn(), rule, '/orders')).toBe(true)
    expect(matchesRule(btn(), rule, '/users')).toBe(false)
    expect(matchesRule(btn(), rule, null)).toBe(false)
    expect(matchesRule(btn(), { event: 'e', selector: '#b1', routePath: null }, null)).toBe(true)
  })

  it('matchText：元素文本包含；null=不限', () => {
    expect(matchesRule(btn(), { event: 'e', selector: '#b1', matchText: '购买' }, null)).toBe(true)
    expect(matchesRule(btn(), { event: 'e', selector: '#b1', matchText: '抢购' }, null)).toBe(false)
    expect(matchesRule(btn(), { event: 'e', selector: '#b1', matchText: null }, null)).toBe(true)
  })

  it('非法 selector 返回 false 不炸页面', () => {
    expect(matchesRule(btn(), { event: 'e', selector: '>>>' }, null)).toBe(false)
  })
})
