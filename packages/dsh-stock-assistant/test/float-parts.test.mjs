import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import vm from 'node:vm'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

// 悬浮窗拆分后的各块:
//   Given 自选横跨多个标签且含置顶
//   When 打开选择器
//   Then 平铺全部标的(多标签下按段会重复列同一只票), 顶部给计数与全选
//   Given 一只都没勾
//   Then 列表给出引导文案, 刷新按钮不可用
const source = await readFile(new URL('../src/client.js', import.meta.url), 'utf8')

async function load() {
  let plugin
  const store = new Map()
  const localStorage = { getItem: key => store.get(key) ?? null, setItem: (key, value) => store.set(key, String(value)) }
  const window = { __ModuleLoader__: { load: entry => { plugin = entry.factory(name => name === 'react' ? React : {}) } } }
  vm.runInNewContext(source, { window, localStorage, console, fetch: globalThis.fetch, AbortController, URLSearchParams, setTimeout, clearTimeout, setInterval, clearInterval, crypto: globalThis.crypto })
  return plugin.__testing
}

const items = {
  'XSHG:equity:000001': { id: 'XSHG:equity:000001', code: '000001', officialName: '上证指数', priceScale: 2, pinned: true, tags: [] },
  'XSHG:equity:600519': { id: 'XSHG:equity:600519', code: '600519', officialName: '贵州茅台', priceScale: 2, tags: ['白酒', '核心'] },
  'XSHG:equity:000002': { id: 'XSHG:equity:000002', code: '000002', officialName: '万科A', priceScale: 2, tags: [] },
}
const order = Object.keys(items)

test('选择器平铺全部标的, 顶部给计数与全选', async () => {
  const { FloatPicker } = await load()
  const html = renderToStaticMarkup(React.createElement(FloatPicker, { order, items, picked: [order[0]], onPicked() {} }))
  assert.match(html, /已选 1\/3/, '顶部计数')
  assert.match(html, /全选/, '还没选满时给全选')
  for (const name of ['上证指数', '贵州茅台', '万科A']) assert.ok(html.includes(name), `${name} 要平铺列出`)
  assert.ok(!html.includes('白酒 · '), '不再按标签分段, 否则多标签的票会重复出现')
  assert.ok(!html.includes('未分组 · '), '未分组段同样取消')
  assert.match(html, /ssb-switch/, '多选行用开关')
})

test('全部选中时给全不选', async () => {
  const { FloatPicker } = await load()
  const html = renderToStaticMarkup(React.createElement(FloatPicker, { order, items, picked: order, onPicked() {} }))
  assert.match(html, /全不选/)
  assert.match(html, /已选 3\/3/)
})

test('一只都没勾时列表给引导, 刷新按钮不可用', async () => {
  const { FloatList, FloatFoot } = await load()
  const list = renderToStaticMarkup(React.createElement(FloatList, { picked: [], items, securityId: null, entryOf: () => null, onPick() {}, onTip() {}, onLeave() {}, onScroll() {} }))
  assert.match(list, /未选择标的，点 ☰ 勾选/)
  const foot = renderToStaticMarkup(React.createElement(FloatFoot, { mode: 'list', securityId: null, picked: [], current: null, stamp: null, stale: false, alertOn: false, error: '', liveOn: true, refresh: 15, onBell() {}, onLive() {}, onDetail() {} }))
  assert.match(foot, /aria-label="自动刷新不可用"/)
  assert.match(foot, /disabled=""/, '没有目标时刷新按钮必须禁用')
  assert.match(foot, /停|刷新/, '禁用态仍要说明原因')
})

test('头部与底栏的事件接线传的是同一份回调', async () => {
  const { FloatHeader, FloatFoot } = await load()
  const step = () => {}, mode = () => {}, picker = () => {}, close = () => {}, bell = () => {}, live = () => {}, detail = () => {}
  const header = FloatHeader({ mode: 'kline', picker: false, current: items[order[0]], picked: order, onStep: step, onMode: mode, onPicker: picker, onClose: close })
  const buttons = header.props.children.filter(child => child && child.props && typeof child.props === 'object')
  const byLabel = label => buttons.find(child => child.props['aria-label'] === label)
  byLabel('上一只').props.onClick()
  byLabel('关闭悬浮盯盘').props.onClick()
  assert.equal(typeof byLabel('上一只').props.onClick, 'function')
  const foot = FloatFoot({ mode: 'list', securityId: order[0], picked: order, current: items[order[0]], stamp: Date.now(), stale: false, alertOn: false, error: '', liveOn: true, refresh: 15, onBell: bell, onLive: live, onDetail: detail })
  const footButtons = foot.props.children
  assert.equal(footButtons[2].props.onClick, live, '播放/暂停按钮接的是父层回调')
  assert.equal(footButtons[3].props.onClick, detail)
  assert.equal(footButtons[1].props.onClick, bell)
})
