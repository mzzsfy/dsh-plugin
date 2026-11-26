import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import vm from 'node:vm'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

// 详情页的分时也要说清数据从哪来:
//   Given 服务端返回分时兜底(offline 标记 + 缓存时刻 + 补了几个点)
//   When 详情页渲染 K 线工具栏
//   Then 元信息前带上同一句离线提示, 不让用户把当日缓存当成实时
async function loadClient() {
  let plugin
  const source = await readFile(new URL('../src/client.js', import.meta.url), 'utf8')
  const store = new Map()
  const localStorage = { getItem: key => store.get(key) ?? null, setItem: (key, value) => store.set(key, String(value)) }
  const window = { __ModuleLoader__: { load: entry => { plugin = entry.factory(name => name === 'react' ? React : {}) } } }
  vm.runInNewContext(source, { window, localStorage, console, fetch: globalThis.fetch, AbortController, URLSearchParams, setTimeout, clearTimeout, setInterval, clearInterval, crypto: globalThis.crypto })
  return plugin.__testing
}

const item = { id: 'XSHG:equity:600519', exchange: 'XSHG', code: '600519', officialName: '贵州茅台', instrument: 'equity', currency: 'CNY', timezone: 'Asia/Shanghai', priceScale: 2, listingStatus: 'listed', alias: '', pinned: false }
const candle = (at, close) => ({ time: '10:10', at, open: close, close, high: close, low: close, volume: 1 })
// 详情分时订阅趋势通道: 假运行时给出恒定版本
const runtimeOf = trend => ({ getTrend: () => trend, trendContext: () => 'test', subscribeTrend: () => () => {}, trendRevision: () => 0 })

test('详情页工具栏带离线提示', async () => {
  const { KlineView } = await loadClient()
  const state = {
    view: {}, busy: {}, klinePeriod: 'trend', data: { vendorAvailable: true },
    klineKey: 'XSHG:equity:600519|trend',
    kline: { candles: [candle(1794792600, 10.1), candle(1794792660, 10.2)], complete: false, offline: { kind: 'cache', cachedAt: Date.parse('2026-11-16T06:20:00Z'), appended: 2 } },
  }
  const html = renderToStaticMarkup(React.createElement(KlineView, { runtime: runtimeOf(state.kline), state, item }))
  assert.match(html, /ssb-kline-meta/, '工具栏元信息在')
  assert.match(html, /离线：当日缓存/, '详情页也要显示离线提示')
  assert.match(html, /补 2 个报价点/)
})

test('在线时详情页不显示离线提示', async () => {
  const { KlineView } = await loadClient()
  const state = { view: {}, busy: {}, klinePeriod: 'trend', data: { vendorAvailable: true }, klineKey: 'XSHG:equity:600519|trend', kline: { candles: [candle(1794792600, 10.1), candle(1794792660, 10.2)], complete: true } }
  const html = renderToStaticMarkup(React.createElement(KlineView, { runtime: runtimeOf(state.kline), state, item }))
  assert.doesNotMatch(html, /离线/)
})
