import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import vm from 'node:vm'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

// 悬浮盯盘卡常驻桌面: 没有时刻时, 停更的报价和刚拉的报价长得一模一样。
// 场景:
//   Given 卡片开着, 三只自选里只有一只的价格停在 10 分钟前
//   When 卡片渲染
//   Then 底部给出最旧那份价格的时刻并标出陈旧(而不是只报最新那只)
//   Given 图形模式的分时结果与报价的刷新节奏不同
//   When 判黄
//   Then 用图上最后一根的同一时刻源, 不因报价九拍才刷而假黄
async function loadClient() {
  let plugin
  const source = await readFile(new URL('../src/client.js', import.meta.url), 'utf8')
  const store = new Map()
  const localStorage = { getItem: key => store.get(key) ?? null, setItem: (key, value) => store.set(key, String(value)) }
  const window = { __ModuleLoader__: { load: entry => { plugin = entry.factory(name => name === 'react' ? React : {}) } } }
  vm.runInNewContext(source, { window, localStorage, console, fetch: globalThis.fetch, AbortController, URLSearchParams, setTimeout, clearTimeout, setInterval, clearInterval, crypto: globalThis.crypto })
  return { plugin, store }
}

const item = (id, name, code) => ({ id, officialName: name, code, exchange: 'XSHG', instrument: 'equity', currency: 'CNY', timezone: 'Asia/Shanghai', priceScale: 2, listingStatus: 'listed', alias: '', pinned: false })
const a = item('XSHG:equity:600519', '贵州茅台', '600519')
const b = item('XSHG:equity:600001', '甲股', '600001')

const stateWith = quotes => ({
  view: {},
  busy: {},
  data: {
    control: { revision: 1, watchlist: { order: [a.id, b.id], items: { [a.id]: a, [b.id]: b } }, preferences: { refreshSeconds: 15, colorMode: 'red-up' } },
    quotes,
  },
})
const runtimeStub = state => ({ getSnapshot: () => state, subscribe: () => () => {}, openDetail() {} })
// 必须锚到元素 class: 样式表里也有 .ssb-float-stamp-stale 定义, 全文匹配会永远为真
const stampOf = html => (html.match(/<span class="ssb-float-stamp[^"]*"[^>]*>/) || [''])[0]
const renderFloat = async (state, pref = { open: true, mode: 'list', live: true }) => {
  const { plugin, store } = await loadClient()
  store.set('ssb-floating', JSON.stringify({ ids: [a.id, b.id], live: true, ...pref }))
  return { html: renderToStaticMarkup(React.createElement(plugin.__testing.FloatingTicker, { runtime: runtimeStub(state) })), plugin }
}

test('时刻解析只认真实时间, 缺失与坏值不落成 0', async () => {
  const { plugin } = await loadClient()
  const { timestampOf } = plugin.__testing
  assert.equal(timestampOf('2026-11-08T15:59:59.000Z'), Date.parse('2026-11-08T15:59:59.000Z'))
  assert.equal(timestampOf(1794191346), 1794191346000, '分时来源给的是 unix 秒, 不换算会落成 1970')
  assert.equal(timestampOf(1794191346000), 1794191346000, '毫秒级不再乘一千')
  assert.equal(timestampOf(null), null, 'Number(null) 是 0, 缺失必须是 null')
  assert.equal(timestampOf(''), null)
  assert.equal(timestampOf('not-a-time'), null)
})

test('价格时刻优先取成交时间, 来源没给才退回取数时刻', async () => {
  const { plugin } = await loadClient()
  const { priceTimeOf } = plugin.__testing
  const quoteAt = '2026-11-09T01:30:00.000Z', receivedAt = Date.parse('2026-11-09T01:31:00.000Z')
  assert.equal(priceTimeOf({ quoteAt, receivedAt }), Date.parse(quoteAt), '用户问的是这个价是几点的, 成交时间才是答案')
  assert.equal(priceTimeOf({ quoteAt: null, receivedAt }), receivedAt, '没有成交时间才退回取数时刻')
  assert.equal(priceTimeOf({}), null)
})

test('列表模式展示最旧价时刻, 陈旧只看还在刷新的报价', async () => {
  const { plugin } = await loadClient()
  const { floatFreshness, staleAfter } = plugin.__testing
  const now = Date.parse('2026-11-09T02:00:00.000Z')
  const fresh = now - 5 * 1000, old = now - 10 * 60 * 1000
  const view = overrides => floatFreshness({ mode: 'list', quiet: false, now, refreshSeconds: 15, quoteTimes: [fresh, old], liveQuoteTimes: [fresh, old], trendAt: null, ...overrides })
  assert.equal(view().stamp, old, '展示取最旧的一份')
  assert.equal(view().stale, true)
  assert.equal(view({ liveQuoteTimes: [fresh], quoteTimes: [fresh, old] }).stale, false, '休市那只停在旧时刻不算停更')
  assert.equal(view({ liveQuoteTimes: [] }).stale, false, '全部休市时只给时刻不标黄')
  // 阈值跟着设置页的刷新间隔: 60s 间隔下 150s 未到三拍, 不该黄
  assert.equal(staleAfter(60), 3 * 60 * 1000)
  assert.equal(view({ liveQuoteTimes: [now - 150 * 1000], refreshSeconds: 60 }).stale, false, '150s 在 60s 间隔的三拍之内')
  assert.equal(view({ liveQuoteTimes: [now - 150 * 1000], refreshSeconds: 15 }).stale, true, '15s 间隔下同一份数据已超阈值')
})

test('图形模式判黄与展示同源, 不因报价刷新慢而假黄', async () => {
  const { plugin } = await loadClient()
  const { floatFreshness } = plugin.__testing
  const now = Date.parse('2026-11-09T02:00:00.000Z')
  const chartAt = now - 5 * 1000, quoteOld = now - 10 * 60 * 1000
  const view = overrides => floatFreshness({ mode: 'kline', quiet: false, now, refreshSeconds: 15, quoteTimes: [quoteOld], liveQuoteTimes: [quoteOld], trendAt: chartAt, ...overrides })
  assert.equal(view().stamp, chartAt, '展示用图上最后一根的时间')
  assert.equal(view().stale, false, '图是新的就不该黄, 报价九拍才刷是设计如此')
  assert.equal(view({ trendAt: now - 10 * 60 * 1000 }).stale, true, '图停了要黄')
  assert.equal(view({ trendAt: now - 10 * 60 * 1000, quiet: true }).stale, false, '收市时图停了是正常状态')
  assert.equal(view({ trendAt: null, quoteTimes: [quoteOld] }).stamp, quoteOld, '分时还没到就退回当前标的的报价时刻')
})

test('悬浮窗时刻跨天补日期, 午夜用 h23', async () => {
  const { plugin } = await loadClient()
  const { clockText } = plugin.__testing
  const now = Date.parse('2026-11-09T02:00:00.000Z')
  assert.equal(clockText(Date.parse('2026-11-08T15:59:59.000Z'), now), '11-08 23:59:59', '跨天带月日并按上海时区换算')
  assert.equal(clockText(Date.parse('2026-11-08T16:00:00.000Z'), now), '00:00:00', '上海午夜是 00:00:00, 不是 24:00:00')
  assert.equal(clockText(Date.parse('2026-11-09T01:05:00.000Z'), now), '09:05:00', '当天只给时分秒')
  assert.equal(clockText(null, now), '', '缺时刻不返回占位文本')
  assert.equal(clockText('not-a-time', now), '', '坏时间戳不抛错')
})

test('悬浮窗底部渲染价格时刻并在陈旧时给非文本标记', async () => {
  const now = Date.now()
  const iso = ms => new Date(ms).toISOString()
  const fresh = { quote: { last: '10.00', quoteAt: iso(now - 5 * 1000), receivedAt: now - 5 * 1000 } }
  const stale = { quote: { last: '20.00', quoteAt: iso(now - 10 * 60 * 1000), receivedAt: now - 10 * 60 * 1000 } }
  const { html } = await renderFloat(stateWith({ [a.id]: fresh, [b.id]: stale }))
  assert.match(html, /2 只 · \d{2}:\d{2}:\d{2}/, '底部同时给只数与最旧价时刻')
  assert.match(stampOf(html), /ssb-float-stamp ssb-float-stamp-stale/, '最旧的一份陈旧时标出, 不能只报最新那只')
  assert.match(html, /aria-label="2 只，最近价时刻 [^"]*，数据已过时"/, '陈旧不只靠颜色: 读屏与触屏经 aria-label 拿到')
  assert.match(html, /最近价时刻 /, '悬停给出完整日期与时刻')

  const allFresh = { [a.id]: fresh, [b.id]: { quote: { last: '21.00', quoteAt: iso(now - 3 * 1000), receivedAt: now - 3 * 1000 } } }
  const { html: freshHtml } = await renderFloat(stateWith(allFresh))
  assert.match(freshHtml, /2 只 · \d{2}:\d{2}:\d{2}/, '新鲜时同样给出时刻')
  assert.doesNotMatch(stampOf(freshHtml), /ssb-float-stamp-stale/, '新鲜时不标出')
})

test('无报价时只给只数不给空时刻', async () => {
  const { html } = await renderFloat(stateWith({}))
  assert.match(html, /2 只/, '只数照常显示')
  assert.doesNotMatch(stampOf(html), / · /, '没有时间戳不产生空的时刻槽位')
})
