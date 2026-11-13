// 官方用时弹窗注入:最近首 token 平均行与独立详情入口按钮。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { CLIENT_BODY, DECLARATION_NAMES } from './client-eval.mjs'

const core = new Function(`${CLIENT_BODY}\nreturn { ${DECLARATION_NAMES.join(', ')} }`)()
const { syncRecentTtftRow, syncRequestDetailsEntry } = core

function node(tag, text = '') {
  const element = {
    tagName: tag.toUpperCase(),
    textContent: text,
    children: [],
    parentElement: null,
    attributes: new Map(),
    listeners: [],
    get nextElementSibling() {
      const siblings = element.parentElement?.children ?? []
      return siblings[siblings.indexOf(element) + 1] ?? null
    },
    get nextSibling() {
      const siblings = element.parentElement?.children ?? []
      return siblings[siblings.indexOf(element) + 1] ?? null
    },
    hasAttribute(name) { return element.attributes.has(name) },
    getAttribute(name) { return element.attributes.get(name) ?? null },
    setAttribute(name, value) { element.attributes.set(name, value) },
    addEventListener(type, listener) { element.listeners.push([type, listener]) },
    remove() {
      const siblings = element.parentElement?.children ?? []
      const index = siblings.indexOf(element)
      if (index >= 0) siblings.splice(index, 1)
      element.parentElement = null
    },
    append(...nodes) {
      for (const child of nodes) {
        child.remove()
        child.parentElement = element
        element.children.push(child)
      }
    },
    insertBefore(child, reference) {
      child.remove()
      child.parentElement = element
      const index = reference === null ? element.children.length : element.children.indexOf(reference)
      element.children.splice(index < 0 ? element.children.length : index, 0, child)
      return child
    },
  }
  return element
}

function dialog({ ttft = true } = {}) {
  const container = node('div')
  const list = node('dl')
  container.append(list)
  list.ownerDocument = { createElement: (tag) => node(tag) }
  const children = []
  if (ttft) children.push(node('dt', '首 token 平均（TTFT）'), node('dd', '5.6秒'))
  children.push(node('dt', '输出速度（TPS）'), node('dd', '153 tok/s'))
  for (const child of children) list.append(child)
  return list
}

test('Given 官方 TTFT 行 When 同步最近首 token 平均 Then 插在官方 dd 后且只保留一份', () => {
  const list = dialog()
  assert.equal(syncRecentTtftRow(list, { label: '最近首 token 平均', value: 2.4, unit: '秒' }), true)
  const labels = list.children.filter((child) => child.tagName === 'DT').map((child) => child.textContent)
  assert.deepEqual(labels, ['首 token 平均（TTFT）', '最近首 token 平均', '输出速度（TPS）'])
  const own = list.children.find((child) => child.getAttribute('data-ud-recent-ttft') === 'value')
  assert.equal(own.textContent, '2.4秒')
  syncRecentTtftRow(list, { label: '最近首 token 平均', value: 2.4, unit: '秒' })
  assert.equal(list.children.filter((child) => child.getAttribute('data-ud-recent-ttft')).length, 2)
})

test('Given 没有官方 TTFT 行或没有值 When 同步 Then 不注入', () => {
  const noTtft = dialog({ ttft: false })
  assert.equal(syncRecentTtftRow(noTtft, { label: '最近首 token 平均', value: 1.2, unit: '秒' }), false)
  assert.equal(noTtft.children.some((child) => child.getAttribute('data-ud-recent-ttft')), false)
  const empty = dialog()
  assert.equal(syncRecentTtftRow(empty, { label: '最近首 token 平均', value: null, unit: '秒' }), false)
})

test('Given 详情入口 When 同步 Then 按钮挂在明细后且重复同步不叠加', () => {
  const list = dialog()
  let opened = 0
  const button = syncRequestDetailsEntry(list, { label: '查看最近请求详情', onOpen: () => { opened += 1 } })
  assert.equal(button.tagName, 'BUTTON')
  assert.equal(button.textContent, '查看最近请求详情')
  assert.equal(button.parentElement, list.parentElement)
  assert.equal(button.listeners[0][0], 'click')
  button.listeners[0][1]()
  assert.equal(opened, 1)
  const again = syncRequestDetailsEntry(list, { label: '查看最近请求详情', onOpen: () => {} })
  assert.equal(again, button)
})

test('Given 没有详情数据 When 同步入口 Then 不渲染按钮', () => {
  const list = dialog()
  assert.equal(syncRequestDetailsEntry(list, { label: '查看最近请求详情', onOpen: () => {}, enabled: false }), null)
})
