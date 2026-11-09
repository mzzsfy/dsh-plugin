import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import vm from 'node:vm'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

// 悬浮盯盘的悬停信息:
//   Given 盯盘图模式
//   When 鼠标移到分时曲线上
//   Then 读出该分钟的时间、价格与涨跌, 并把成本/卖价标记一起给出
//   Given 列表模式
//   When 鼠标移到某一行
//   Then 给出当日最高/最低/今开/昨收与该股全部标记价
async function loadClient() {
  let plugin
  const source = await readFile(new URL('../src/client.js', import.meta.url), 'utf8')
  const store = new Map()
  const localStorage = { getItem: key => store.get(key) ?? null, setItem: (key, value) => store.set(key, String(value)) }
  const window = { __ModuleLoader__: { load: entry => { plugin = entry.factory(name => name === 'react' ? React : {}) } } }
  vm.runInNewContext(source, { window, localStorage, console, fetch: globalThis.fetch, AbortController, URLSearchParams, setTimeout, clearTimeout, setInterval, clearInterval, crypto: globalThis.crypto })
  return { plugin, store }
}

test('分时悬停按水平位置取最近一根, 越界夹到两端', async () => {
  const { sparkIndexAt } = (await loadClient()).plugin.__testing
  assert.equal(sparkIndexAt(0, 241), 0)
  assert.equal(sparkIndexAt(0.5, 5), 2, '中间四舍五入到最近一根')
  assert.equal(sparkIndexAt(1, 241), 240)
  assert.equal(sparkIndexAt(-1, 5), 0, '移出左边界仍取第一根')
  assert.equal(sparkIndexAt(2, 5), 4, '移出右边界仍取最后一根')
  assert.equal(sparkIndexAt(0.5, 0), -1, '空序列不产生下标')
})

test('分时时间标签优先用来源给的时钟, 缺失给空串', async () => {
  const { candleTimeText } = (await loadClient()).plugin.__testing
  assert.equal(candleTimeText({ time: '09:31' }), '09:31')
  assert.equal(candleTimeText({ at: Date.parse('2026-11-09T02:00:00Z') / 1000 }), '10:00:00', '秒级时间戳按上海时区换算')
  assert.equal(candleTimeText({ time: 'garbage', at: Date.parse('2026-11-09T02:00:00Z') }), '10:00:00', '坏时钟字段退回时间戳')
  assert.equal(candleTimeText({}), '')
})

test('列表悬停信息给出今日高低、今开昨收与全部标记', async () => {
  const { quoteTipLines } = (await loadClient()).plugin.__testing
  const lines = quoteTipLines({ quote: { high: 10.5, low: 9.8, open: 10, previousClose: 9.9 }, marks: [{ id: 'a', kind: 'cost', price: 9.9 }, { id: 'b', kind: 'target', price: 11 }], scale: 2 })
  assert.deepEqual([...lines], ['今高 10.50　今低 9.80', '今开 10.00　昨收 9.90', '成本 9.90', '卖价 11.00'])
  const missing = quoteTipLines({ quote: {}, marks: [], scale: 2 })
  assert.deepEqual([...missing], ['今高 —　今低 —', '今开 —　昨收 —'], '缺字段给破折号, 不能把 null 当 0')
})

test('标记线常驻可见, 但不参与纵轴缩放', async () => {
  const { plugin } = await loadClient()
  const candles = [{ time: '09:31', close: 10.0 }, { time: '09:32', close: 10.1 }, { time: '09:33', close: 10.2 }]
  const count = html => (html.match(/<line class="ssb-float-markline /g) || []).length
  const inside = renderToStaticMarkup(React.createElement(plugin.__testing.Sparkline, { candles, preClose: 10, marks: [{ id: 'm1', kind: 'target', price: 10.15 }], scale: 2 }))
  assert.equal(count(inside), 1, '区间内的标记画成水平线')
  assert.match(inside, /ssb-float-markline-target/, '卖价用图表色板里的 target 色')
  const outside = renderToStaticMarkup(React.createElement(plugin.__testing.Sparkline, { candles, preClose: 10, marks: [{ id: 'm2', kind: 'cost', price: 8 }], scale: 2 }))
  assert.equal(count(outside), 0, '超范围的标记不显示: 缩放只由价格与昨收决定, 不能被成本价压扁')
  const many = renderToStaticMarkup(React.createElement(plugin.__testing.Sparkline, { candles, preClose: 10, marks: [{ id: 'a', kind: 'cost', price: 10.05 }, { id: 'b', kind: 'target', price: 11 }], scale: 2 }))
  assert.equal(count(many), 1, '只有落在区间里的那条出现')
  const noMarks = renderToStaticMarkup(React.createElement(plugin.__testing.Sparkline, { candles, preClose: 10, scale: 2 }))
  assert.equal(count(noMarks), 0)
})

test('右侧刻度按振幅选档, 数量在 2 到 4 之间', async () => {
  const { sparkTicksOf } = (await loadClient()).plugin.__testing
  assert.deepEqual([...sparkTicksOf({ low: 100, high: 200 })], [100, 150, 200], '宽区间用 50 的整档')
  assert.deepEqual([...sparkTicksOf({ low: 9.8, high: 10.4 })], [9.8, 10, 10.2, 10.4], '窄区间细到 0.2')
  assert.deepEqual([...sparkTicksOf({ low: 30.1, high: 30.98 })], [30.2, 30.4, 30.6, 30.8], '不能只剩一个刻度')
  assert.deepEqual([...sparkTicksOf({ low: 430, high: 450 })], [430, 440, 450], '4 个放不下就退一档')
  for (const [low, high] of [[1, 2], [3.1, 3.12], [1000, 1003], [0.001, 0.004]]) {
    const ticks = sparkTicksOf({ low, high })
    assert.ok(ticks.length >= 2 && ticks.length <= 4, `${low}~${high} 应给 2~4 个点, 实际 ${ticks.length}`)
  }
  assert.deepEqual([...sparkTicksOf({ low: 5, high: 5 })], [], '空区间不产生刻度')
})

test('分时图渲染右侧价格刻度与定位点', async () => {
  const { plugin } = await loadClient()
  const html = renderToStaticMarkup(React.createElement(plugin.__testing.Sparkline, { candles: [{ time: '09:31', close: 10.1 }, { time: '09:32', close: 10.3 }], preClose: 10, marks: [], scale: 2 }))
  assert.match(html, /class="ssb-float-axis"/, '有右侧刻度层')
  const ticks = (html.match(/class="ssb-float-tick"/g) || []).length
  const values = (html.match(/class="ssb-float-tick-value"/g) || []).length
  assert.ok(ticks >= 2 && ticks <= 4, `刻度点 2~4 个, 实际 ${ticks}`)
  assert.equal(values, ticks, '每个点位都配一个价格')
  assert.match(html, /10\.[0-3]/, '刻度显示为价格而非百分比')
})

test('涨跌配色与价格文本只有一处实现', async () => {
  const { plugin } = await loadClient()
  const { toneClass, priceTextOf } = plugin.__testing
  assert.equal(toneClass(1.2), ' ssb-up')
  assert.equal(toneClass(-0.3), ' ssb-down')
  assert.equal(toneClass(0), '', '零涨跌不上色')
  assert.equal(toneClass(null), '')
  assert.equal(priceTextOf(444.4, 2), '444.40', '价格按精度补零, 列表与图读数一致')
  assert.equal(priceTextOf(null, 2), '—')
  assert.equal(priceTextOf('', 2), '—')
})

test('一字板或贴边行情放大后曲线仍在窗内', async () => {
  const { sparkRangeOf } = (await loadClient()).plugin.__testing
  const flat = sparkRangeOf({ values: [10.2, 10.2, 10.2, 10.2], preClose: 10, zoom: 1.2 })
  assert.ok(flat.low < 10.2 && 10.2 < flat.high, '涨停横盘放大后不能把整条线挤出窗')
  const edge = sparkRangeOf({ values: [9.95, 10, 10.05, 10.1], preClose: 10.2, zoom: 1.2 })
  assert.ok(edge.low < 10 && edge.high > 10, '贴边序列放大后数据仍围绕窗口中心, 不会被整条挤出')
  const one = sparkRangeOf({ values: [10.2, 10.2], preClose: 10, zoom: 1 })
  assert.equal(one.low, 10, '1 倍仍容纳昨收')
  assert.equal(one.high, 10.2)
  assert.equal(sparkRangeOf({ values: [], preClose: 10 }).high, 1, '空数据不抛')
})

test('刻度标签按步长定精度, 不出现重复读数', async () => {
  const { plugin } = await loadClient()
  const render = candles => renderToStaticMarkup(React.createElement(plugin.__testing.Sparkline, { candles, preClose: candles[0].close, marks: [], scale: 2 }))
  const labels = html => [...html.matchAll(/ssb-float-tick-value[^>]*>([^<]+)</g)].map(match => match[1])
  const narrow = labels(render([{ time: '09:31', close: 1.2 }, { time: '09:32', close: 1.21 }]))
  assert.equal(new Set(narrow).size, narrow.length, `窄区间刻度应唯一, 实际 ${narrow.join()}`)
  const wide = labels(render([{ time: '09:31', close: 430 }, { time: '09:32', close: 450 }]))
  assert.deepEqual([...wide], ['430', '440', '450'], '步长 ≥1 时不带多余小数')
})

test('列表浮层在窗口底部放不下时向上翻', async () => {
  const { rowTipPositionOf } = (await loadClient()).plugin.__testing
  const roomy = rowTipPositionOf({ top: 300, bottom: 326, lines: 2, viewportHeight: 1000 })
  assert.equal(roomy.top, 300, '放得下就贴着行')
  for (const lines of [2, 4, 12]) {
    const cramped = rowTipPositionOf({ top: 900, bottom: 926, lines, viewportHeight: 1000 })
    assert.ok(cramped.top >= 8, `N=${lines} 不能顶出上边界`)
    assert.ok(cramped.top + cramped.height <= 992, `N=${lines} 不能超出视口底部`)
  }
})

test('没有悬停时不渲染读出浮层', async () => {
  const { plugin } = await loadClient()
  const html = renderToStaticMarkup(React.createElement(plugin.__testing.Sparkline, { candles: [{ time: '09:31', close: 10 }, { time: '09:32', close: 10.1 }], preClose: 10, marks: [], scale: 2 }))
  assert.doesNotMatch(html, /ssb-float-hover/, '悬停浮层只在指针进入后出现')
})
