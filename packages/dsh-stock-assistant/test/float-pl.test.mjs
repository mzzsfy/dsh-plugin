import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import vm from 'node:vm'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

// 悬浮盯盘的成本盈亏:
//   Given 标的设置了成本价
//   When 打开悬浮盯盘(列表或图形)
//   Then 用小字给出相对成本的盈亏, 与当日涨跌分开读数
//   Given 没有设置成本
//   Then 不出现盈亏读数
const source = await readFile(new URL('../src/client.js', import.meta.url), 'utf8')

async function load() {
  let plugin
  const store = new Map()
  const localStorage = { getItem: key => store.get(key) ?? null, setItem: (key, value) => store.set(key, String(value)) }
  const window = { __ModuleLoader__: { load: entry => { plugin = entry.factory(name => name === 'react' ? React : {}) } } }
  vm.runInNewContext(source, { window, localStorage, console, fetch: globalThis.fetch, AbortController, URLSearchParams, setTimeout, clearTimeout, setInterval, clearInterval, crypto: globalThis.crypto })
  return { ...plugin.__testing, __store: store }
}

const held = { id: 'XSHG:equity:600519', code: '600519', alias: '', officialName: '贵州茅台', priceScale: 2, pinned: false, tags: [], marks: [{ id: 'c1', kind: 'cost', price: 1400 }] }
const doubleCost = { ...held, marks: [{ id: 'c1', kind: 'cost', price: 1400 }, { id: 'c2', kind: 'cost', price: 1500 }, { id: 't1', kind: 'target', price: 1800 }] }
const free = { ...held, id: 'XSHE:equity:000001', code: '000001', officialName: '平安银行', marks: [] }
const items = { [held.id]: held, [free.id]: free }
const entryOf = id => ({ quote: { last: id === held.id ? 1444.99 : 12.16, changePct: id === held.id ? -0.55 : 1.28, receivedAt: 1 }, health: 'ok' })
const renderList = (api, ids) => renderToStaticMarkup(React.createElement(api.FloatList, { picked: ids, items, securityId: ids[0], entryOf, onPick() {}, onTip() {}, onLeave() {}, onScroll() {} }))
const plText = html => [...html.matchAll(/ssb-float-row-pl[^>]*>([^<]*)</g)].map(match => match[1])
const chartPl = html => /class="ssb-float-pl[^"]*"[^>]*>([^<]*)</.exec(html)?.[1] ?? null

test('列表模式给设置了成本的标的补一行小字盈亏', async () => {
  const api = await load()
  const html = renderList(api, [held.id, free.id])
  // +3.21% = (1444.99-1400)/1400, 分母是成本价; 若误用最新价做分母会得 +3.11%
  assert.deepEqual([...plText(html)], ['盈亏 +3.21%'], '只有设了成本的行有读数')
  assert.match(html, /ssb-float-row-pl ssb-number ssb-up/, '盈利按涨跌色着色(红涨)')
  assert.match(html, /<span class="ssb-float-row-pct[^>]*>-0\.55%<\/span>/, '当日涨跌仍在原列, 两个读数分开')
})

test('多条成本取最低价当基准, 与列表页口径一致', async () => {
  const api = await load()
  const single = { ...items, [doubleCost.id]: doubleCost }
  const html = renderToStaticMarkup(React.createElement(api.FloatList, { picked: [doubleCost.id], items: single, securityId: doubleCost.id, entryOf, onPick() {}, onTip() {}, onLeave() {}, onScroll() {} }))
  assert.deepEqual([...plText(html)], ['盈亏 +3.21%'], '成本 1500 不参与, 基准仍是最低 1400')
})

test('没有成本或没有现价时盈亏不写成 0', async () => {
  const api = await load()
  const html = renderToStaticMarkup(React.createElement(api.FloatList, { picked: [held.id], items, securityId: held.id, entryOf: () => null, onPick() {}, onTip() {}, onLeave() {}, onScroll() {} }))
  assert.deepEqual([...plText(html)], ['盈亏 —'], '停牌/无行情时保留占位而不是算出 0%')
  assert.doesNotMatch(html, /ssb-float-row-pl[^"]*ssb-(up|down)/, '无读数不上色')
})

test('图形模式报价行给出同一口径的盈亏, 与当日涨跌分开', async () => {
  const api = await load()
  const html = renderToStaticMarkup(React.createElement(api.FloatChart, { securityId: held.id, current: held, candles: [{ close: 1444.99 }], preClose: 1453, error: '', last: 1444.99, pct: -0.55 }))
  assert.equal(chartPl(html), '盈亏 +3.21%')
  assert.match(html, /class="ssb-float-pct">-0\.55%</)
  assert.match(html, /title="成本 1400\.00 · 每股 \+44\.99"/, '悬停给出成本基准与每股盈亏')
})

test('图形模式没有成本就不出现盈亏读数', async () => {
  const api = await load()
  const html = renderToStaticMarkup(React.createElement(api.FloatChart, { securityId: free.id, current: free, candles: [{ close: 12.16 }], preClose: 12.01, error: '', last: 12.16, pct: 1.28 }))
  assert.equal(chartPl(html), null)
})

// 列表页的持仓列与浮窗共用 costPlOf, 精度与着色仍是列表页原来的口径
test('自选列表的持仓盈亏列跟着同一口径走', async () => {
  const api = await load()
  const item = { ...held, exchange: 'XSHG', instrument: 'equity', currency: 'CNY', timezone: 'Asia/Shanghai', listingStatus: 'listed' }
  const entry = { quote: { last: '1444.99', previousClose: '1453', change: '-8.01', changePct: '-0.55', providerInstanceId: 'p', delayKind: 'realtime', quoteAt: null, receivedAt: 1, sessionState: 'trading' }, health: 'ok', lastError: null }
  const state = { view: { view: 'list', sort: 'manual', alias: '' }, busy: {}, candidates: [], composing: false, undo: null, error: '', paused: false, kline: null, data: { control: { revision: 1, routingRevision: 0, watchlist: { order: [item.id], items: { [item.id]: item } }, preferences: {} }, quotes: { [item.id]: entry }, adapters: [], providerStatus: [], catalogs: [], routeSelections: {}, klineReady: {}, vendorAvailable: false } }
  const html = renderToStaticMarkup(React.createElement(api.StockPage, { runtime: { getSnapshot: () => state, subscribe: () => () => {}, updateView() {} }, layout: {} }))
  assert.match(html, /ssb-cell-pl ssb-up">\+3\.2%</, '盈利按涨跌色着色的 1 位小数')
})
