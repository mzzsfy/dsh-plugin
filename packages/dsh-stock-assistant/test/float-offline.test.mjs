import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import vm from 'node:vm'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

// 离线兜底的界面:
//   Given 分时请求失败但服务端给了当日缓存或报价拍点
//   When 浮窗图形模式渲染
//   Then 图上照画, 不显示"无法连接行情来源", 而是说清这条线是什么
async function loadClient() {
  let plugin
  const source = await readFile(new URL('../src/client.js', import.meta.url), 'utf8')
  const store = new Map()
  const localStorage = { getItem: key => store.get(key) ?? null, setItem: (key, value) => store.set(key, String(value)) }
  const window = { __ModuleLoader__: { load: entry => { plugin = entry.factory(name => name === 'react' ? React : {}) } } }
  vm.runInNewContext(source, { window, localStorage, console, fetch: globalThis.fetch, AbortController, URLSearchParams, setTimeout, clearTimeout, setInterval, clearInterval, crypto: globalThis.crypto })
  return plugin.__testing
}

const candles = [{ time: '09:30', at: 1794792600, close: 10 }, { time: '09:31', at: 1794792660, close: 10.2 }]
const current = { marks: [], priceScale: 2 }

test('离线提示说清缓存时刻与续了几个报价点', async () => {
  const { offlineText } = await loadClient()
  assert.equal(offlineText(null), '')
  const cache = offlineText({ kind: 'cache', cachedAt: Date.parse('2026-11-16T06:20:00Z') })
  assert.match(cache, /离线/)
  assert.match(cache, /缓存/)
  assert.match(cache, /14:20/, '要给出缓存的时间点')
  assert.match(offlineText({ kind: 'cache', cachedAt: Date.parse('2026-11-16T06:20:00Z'), appended: 37 }), /补 37 个报价点/)
})

test('有离线数据时不显示连接错误, 图照画', async () => {
  const { FloatChart } = await loadClient()
  const html = renderToStaticMarkup(React.createElement(FloatChart, { securityId: 'XSHG:equity:600519', current, candles, preClose: 10, error: '无法连接行情来源', last: 10.2, pct: 2, offline: { kind: 'cache', cachedAt: Date.parse('2026-11-16T06:20:00Z'), appended: 2 } }))
  assert.doesNotMatch(html, /无法连接行情来源/, '有兜底数据就不该报连接失败')
  assert.match(html, /ssb-float-chart/, '图还在')
  assert.match(html, /补 2 个报价点/)
})

test('拍点线要走客户端的蜡烛校验, 补了开高低才画得出', async () => {
  const { sanitizeCandles, FloatChart } = await loadClient()
  const ticks = [{ time: '10:10', at: 1794792600, open: 10, high: 10, low: 10, close: 10 }, { time: '10:11', at: 1794792660, open: 10.3, high: 10.3, low: 10.3, close: 10.3 }]
  const kept = sanitizeCandles(ticks)
  assert.equal(kept.length, 2, '含开高低的拍点能过校验')
  // 只有收盘价会被校验整根丢掉: 这正是服务端必须补齐开高低的原因
  assert.equal(sanitizeCandles(ticks.map(({ open, high, low, ...rest }) => rest)).length, 0)
  const html = renderToStaticMarkup(React.createElement(FloatChart, { securityId: 'XSHG:equity:600519', current, candles: kept, preClose: 10, error: '', last: 10.3, pct: 3, offline: { kind: 'ticks', points: kept.length } }))
  assert.match(html, /<svg/, '真实链路下拍点线画得出来')
})

test('详情页的离线前缀与浮窗同一句话', async () => {
  const { offlinePrefix } = await loadClient()
  assert.equal(offlinePrefix(null), '')
  const cachedAt = Date.parse('2026-11-16T06:20:00Z')
  const sameDay = Date.parse('2026-11-16T08:20:00Z')
  const nextDay = Date.parse('2026-11-17T08:20:00Z')
  assert.match(offlinePrefix({ kind: 'cache', cachedAt }, sameDay), /^离线：当日缓存 14:20/, '当日只给时分, 时刻精确到分即可')
  assert.match(offlinePrefix({ kind: 'cache', cachedAt }, nextDay), /^离线：当日缓存 11-16 14:20/, '跨日补 MM-DD 前缀')
})

test('离线兜底也要说清数据可能不完整', async () => {
  const { FloatChart } = await loadClient()
  const html = renderToStaticMarkup(React.createElement(FloatChart, { securityId: 'XSHG:equity:600519', current, candles, preClose: 10, error: '', last: 10.2, pct: 2, offline: { kind: 'cache', cachedAt: Date.parse('2026-11-16T06:20:00Z') } }))
  assert.match(html, /缓存/)
  assert.doesNotMatch(html, /ssb-float-error/)
})

test('分时没有数据时, 价格退回报价行而不是破折号', async () => {
  const { floatReadout } = await loadClient()
  // 跨 realm 的对象原型不同, 逐字段比
  const fallback = floatReadout({ candles: null, trendData: null, quote: { last: 10.2, previousClose: 9.9 } })
  assert.equal(fallback.last, 10.2)
  assert.equal(fallback.base, 9.9)
  const live = floatReadout({ candles, trendData: { preClose: 10 }, quote: { last: 10.2, previousClose: 9.9 } })
  assert.equal(live.last, 10.2, '分时在时以图为准')
  assert.equal(live.base, 10, '昨收优先用分时给的')
  const empty = floatReadout({ candles: null, trendData: null, quote: {} })
  assert.ok(Number.isNaN(empty.last) && Number.isNaN(empty.base), '都没有时保持缺失, 不编造 0')
})
