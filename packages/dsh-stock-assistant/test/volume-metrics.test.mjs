import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import vm from 'node:vm'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { eastmoney } from '../src/providers/eastmoney.mjs'
import { tencent } from '../src/providers/tencent.mjs'
import { sina } from '../src/providers/sina.mjs'
import { xueqiu } from '../src/providers/xueqiu.mjs'
import { makeSecurity } from '../src/market-model.mjs'

// client 的量能函数是纯函数, 只经顶层 vm 求值即可取到; 详情渲染需要真 React
async function loadClient() {
  let plugin
  const source = await readFile(new URL('../src/client.js', import.meta.url), 'utf8')
  const window = { __ModuleLoader__: { load: entry => { plugin = entry.factory(name => name === 'react' ? React : {}) } } }
  vm.runInNewContext(source, { window, console, fetch: () => {}, AbortController, URLSearchParams, setTimeout, clearTimeout, setInterval, clearInterval, crypto: globalThis.crypto })
  return plugin.__testing
}

// 量副图与量均线都按「每根一根量柱」取数, 前导不足窗口的位必须留空
const candles = volumes => volumes.map((volume, index) => ({ time: `2026-11-${String(index + 1).padStart(2, '0')}`, open: 10, close: 11, high: 11, low: 9, volume }))

test('MAVOL 前导补 null, 尾部为窗口均量', async () => {
  const { seriesMAVOL } = await loadClient()
  assert.deepEqual([...seriesMAVOL(candles([10, 20, 30, 40, 50]), 3)], [null, null, 20, 30, 40])
  assert.deepEqual([...seriesMAVOL(candles([10, 20]), 3)], [null, null])
})

test('MAVOL 窗口内任一根量缺失就不输出, 不拿 0 凑均值', async () => {
  const { seriesMAVOL } = await loadClient()
  // 缺失在窗口里: 该位空, 窗口滑过去后恢复
  assert.deepEqual([...seriesMAVOL(candles([10, null, 30, 40, 50]), 3)], [null, null, null, null, 40])
  // 真实 0 是有效成交量, 参与均值
  assert.deepEqual([...seriesMAVOL(candles([0, 0, 0]), 3)], [null, null, 0])
  assert.deepEqual([...seriesMAVOL(candles([0, 2, 4]), 3)], [null, null, 2])
})

test('量柱数据 K 线用业务日期, 分时用行情自带时刻', async () => {
  const { volumeBarPoints, trendAxis } = await loadClient()
  const theme = { volumeUp: '#f00', volumeDown: '#0f0' }
  const k = candles([100, 200]).map((candle, index) => ({ ...candle, close: index ? 9 : 11 }))
  assert.deepEqual([...volumeBarPoints(k, theme)].map(p => ({ ...p })), [
    { time: '2026-11-01', value: 100, color: '#f00' },
    { time: '2026-11-02', value: 200, color: '#0f0' },
  ])
  const trend = [{ at: 1000, open: 10, close: 10, high: 10, low: 10, volume: 50 }, { at: 1060, open: 10, close: 9, high: 10, low: 9 }, { quotePoint: true, at: 1120, open: 9, close: 9, high: 9, low: 9 }]
  const axis = trendAxis(trend)
  // 补点没有量: 记 0 高柱而不是跳过, 否则量副图会缺一段
  assert.deepEqual([...volumeBarPoints(trend, theme, axis)].map(p => ({ ...p })), [
    { time: 1000, value: 50, color: '#f00' },
    { time: 1060, value: 0, color: '#0f0' },
    { time: 1120, value: 0, color: '#f00' },
  ])
  // 缺 at 时退回「当天零点 + 分钟偏移」, 仍是递增的分钟轴
  const fallback = trendAxis([{}, {}])
  assert.equal(fallback({}, 1) - fallback({}, 0), 60)
})

const jsonCtx = body => ({ now: () => 100, signal: new AbortController().signal, usSymbols: new Map(), fetch: async () => ({ ok: true, json: async () => body }) })
const gbkCtx = text => ({ now: () => 100, signal: new AbortController().signal, usSymbols: new Map(), fetch: async () => ({ ok: true, arrayBuffer: async () => new TextEncoder().encode(text).buffer }) })

test('东财 f8/f10 映射为换手率与量比, 港美同义', async () => {
  const row = { f2: 1462.99, f5: 15568, f6: 2277648306, f8: 0.12, f10: 0.86, f12: '600519', f13: 1, f14: '贵州茅台', f15: 1470, f16: 1456, f17: 1470, f18: 1474.84, f124: 1795661664 }
  const req = { providerInstanceId: 'em', market: 'XSHG', securities: [makeSecurity('XSHG', '600519', '贵州茅台')] }
  const quote = (await eastmoney.quotes(req, jsonCtx({ data: { diff: [row] } }))).items[0]
  assert.equal(quote.turnoverRate, 0.12, 'f8 是百分数原值')
  assert.equal(quote.volumeRatio, 0.86)
  // 停牌时 f8/f10 给 "-": 记缺失, 不伪造 0
  const halted = await eastmoney.quotes(req, jsonCtx({ data: { diff: [{ ...row, f8: '-', f10: '-' }] } }))
  assert.equal(halted.items[0].turnoverRate, null)
  assert.equal(halted.items[0].volumeRatio, null)
  const hk = await eastmoney.quotes({ ...req, market: 'XHKG', securities: [makeSecurity('XHKG', '00700', '腾讯控股')] }, jsonCtx({ data: { diff: [{ ...row, f12: '00700', f13: 116, f8: 0.14, f10: 0.95 }] } }))
  assert.deepEqual([hk.items[0].turnoverRate, hk.items[0].volumeRatio], [0.14, 0.95])
})

test('腾讯只在沪深取 f[38]/f[49]; 港股同列位语义不同不映射', async () => {
  const fields = Array.from({ length: 88 }, () => '')
  fields[1] = '贵州茅台'; fields[3] = '1462.01'; fields[4] = '1474.84'; fields[5] = '1470.00'; fields[30] = '20261126105415'
  fields[33] = '1470.00'; fields[34] = '1456.00'; fields[36] = '15568'; fields[37] = '227619'; fields[38] = '0.12'; fields[49] = '0.86'
  const cn = await tencent.quotes({ providerInstanceId: 'tc', market: 'XSHG', securities: [makeSecurity('XSHG', '600519', '贵州茅台')] }, gbkCtx(`v_sh600519="${fields.join('~')}";`))
  assert.equal(cn.items[0].turnoverRate, 0.12)
  assert.equal(cn.items[0].volumeRatio, 0.86)
  const hkFields = [...fields]; hkFields[38] = '0'; hkFields[49] = '333.000'
  const hk = await tencent.quotes({ providerInstanceId: 'tc', market: 'XHKG', securities: [makeSecurity('XHKG', '00700', '腾讯控股')] }, gbkCtx(`v_hk00700="${hkFields.join('~')}";`))
  assert.ok(!('turnoverRate' in hk.items[0]), '港股 f[38] 恒 0, 不能当换手率')
  assert.ok(!('volumeRatio' in hk.items[0]), '港股 f[49] 是周高, 不能当量比')
})

test('不给量比换手率的来源不写这两个键', async () => {
  const fields = Array.from({ length: 34 }, () => '')
  fields[0] = '贵州茅台'; fields[1] = '1363.000'; fields[2] = '1354.000'; fields[3] = '1369.510'; fields[4] = '1376.000'; fields[5] = '1352.980'; fields[8] = '2365407'; fields[9] = '3234488592'; fields[30] = '2026-10-30'; fields[31] = '11:00:01'
  const quote = (await sina.quotes({ providerInstanceId: 'sina', market: 'XSHG', securities: [makeSecurity('XSHG', '600519', '贵州茅台')] }, gbkCtx(`var hq_str_sh600519="${fields.join(',')}";`))).items[0]
  assert.ok(!('turnoverRate' in quote))
  assert.ok(!('volumeRatio' in quote))
})

test('雪球 turnover_rate 落到报价实体, 且没有量比字段', async () => {
  const ctx = { now: () => 1, signal: new AbortController().signal, fetch: async url => url === 'https://xueqiu.com/'
    ? { headers: { getSetCookie: () => ['xq_a_token=abc; path=/'] } }
    : { ok: true, json: async () => ({ data: { items: [{ quote: { symbol: 'SH600519', current: 1464.01, last_close: 1474.84, open: 1470, high: 1470, low: 1456, volume: 1578746, amount: 2309688887, turnover_rate: 0.13, currency: 'CNY', timestamp: 1795661791164 } }] } }) } }
  const quote = (await xueqiu.quotes({ providerInstanceId: 'xq', market: 'XSHG', securities: [makeSecurity('XSHG', '600519', '贵州茅台')] }, ctx)).items[0]
  assert.equal(quote.turnoverRate, 0.13)
  assert.ok(!('volumeRatio' in quote), '雪球 quote 对象没有 volume_ratio, 不补造')
})

test('详情事实表展示量比与换手率, 缺值呈现破折号', async () => {
  const { StockPage } = await loadClient()
  const item = { id: 'XSHG:equity:600519', officialName: '贵州茅台', code: '600519', exchange: 'XSHG', instrument: 'equity', currency: 'CNY', timezone: 'Asia/Shanghai', priceScale: 2, listingStatus: 'listed', alias: '', pinned: false }
  const state = quote => ({ view: { view: 'list', overlay: 'detail', detailId: item.id, sort: 'manual', alias: '' }, busy: {}, candidates: [], composing: false, undo: null, error: '', paused: false, kline: null, data: { control: { revision: 1, routingRevision: 0, watchlist: { order: [item.id], items: { [item.id]: item } }, preferences: {} }, quotes: { [item.id]: { quote: { last: '1462.99', previousClose: '1474.84', change: '-11.85', changePct: '-0.80', providerInstanceId: 'em-default', delayKind: 'realtime', quoteAt: null, receivedAt: 1, open: '1470.00', high: '1470.00', low: '1456.00', volume: '1556800', amount: '2277648306', sessionState: 'trading', ...quote }, health: 'ok', lastError: null } }, adapters: [], providerStatus: [], catalogs: [], routeSelections: {}, klineReady: {}, vendorAvailable: false } })
  const render = snapshot => renderToStaticMarkup(React.createElement(StockPage, { runtime: { getSnapshot: () => snapshot, subscribe: () => () => {}, updateView: () => {}, loadKline: () => Promise.resolve({ candles: [] }) }, layout: {} }))
  const html = render(state({ turnoverRate: 0.12, volumeRatio: 0.86 }))
  assert.match(html, /量比<\/dt><dd>0\.86<\/dd>/)
  assert.match(html, /换手率<\/dt><dd>0\.12%<\/dd>/)
  const missing = render(state({}))
  assert.match(missing, /量比<\/dt><dd>—<\/dd>/)
  assert.match(missing, /换手率<\/dt><dd>—<\/dd>/)
})
