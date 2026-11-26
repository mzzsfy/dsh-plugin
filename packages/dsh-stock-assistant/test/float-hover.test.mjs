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

// 悬浮分时的时间窗: 滚轮以指针为锚, 拖动平移, 不越出当日首尾
test('分时缩放以指针为锚并夹在当日范围内', async () => {
  const { sparkWindowOf, sparkZoomOf, sparkPanOf, sparkNormalizeOf, sparkFollowOf } = (await loadClient()).plugin.__testing
  const full = sparkWindowOf({ total: 241, start: 0, span: 0 })
  assert.deepEqual({ ...full }, { start: 0, span: 241, end: 240 }, '未指定窗口时铺满全天')
  // 指针在 75% 处上滚一档: 窗口收窄, 该点仍在窗口内且相对位置大致不变
  const zoomed = sparkZoomOf({ total: 241, start: 0, span: 241, anchor: 180, factor: 1 / 2 })
  assert.equal(zoomed.span, 121)
  assert.ok(zoomed.start <= 180 && 180 <= zoomed.end)
  assert.ok(Math.abs((180 - zoomed.start) / (zoomed.span - 1) - 180 / 240) < 0.02)
  assert.equal(sparkZoomOf({ total: 241, start: 0, span: 241, anchor: 240, factor: 1 / 1000 }).span, 8, '最小窗口不碎成零根')
  assert.equal(sparkZoomOf({ total: 241, start: 0, span: 20, anchor: 5, factor: 1000 }).span, 241, '放大不超过全天')
  const panned = sparkPanOf({ start: 100, span: 50, total: 241, delta: -30 })
  assert.equal(panned.start, 70)
  assert.equal(sparkPanOf({ start: 10, span: 50, total: 241, delta: -30 }).start, 0, '左边界夹住')
  assert.equal(sparkPanOf({ start: 180, span: 50, total: 241, delta: 30 }).start, 191, '右边界夹住')
  assert.deepEqual({ ...sparkNormalizeOf({ total: 241, start: 0, span: 241 }) }, { start: 0, span: 0 }, '全天保存为哨兵而不是当前根数')
  assert.deepEqual({ ...sparkFollowOf({ before: 241, total: 242, start: 0, span: 0 }) }, { start: 0, span: 0 }, '全天在新分钟到达后仍是全天')
  assert.deepEqual({ ...sparkFollowOf({ before: 151, total: 152, start: 0, span: 151 }) }, { start: 0, span: 0 }, '物化过的全天窗口也要归回哨兵, 不能丢第一根')
  assert.deepEqual({ ...sparkFollowOf({ before: 241, total: 242, start: 191, span: 50 }) }, { start: 192, span: 50 }, '贴尾窗口跟着最新一根走')
  assert.deepEqual({ ...sparkFollowOf({ before: 241, total: 242, start: 0, span: 50 }) }, { start: 0, span: 50 }, '看历史时不被新分钟拽走')
  assert.deepEqual({ ...sparkFollowOf({ before: 241, total: 30, start: 0, span: 50 }) }, { start: 0, span: 0 }, '总根数回退时归回全天, 不保留超出总数的窗口')
  assert.deepEqual({ ...sparkFollowOf({ before: 241, total: 30, start: 200, span: 20 }) }, { start: 10, span: 20 }, '总根数回退但仍够窗口时, start 夹到有效范围')
})

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

test('列表悬停信息给出今日高低、今开昨收、全部标记与持仓盈亏', async () => {
  const { quoteTipLines } = (await loadClient()).plugin.__testing
  const rows = quoteTipLines({ quote: { high: 10.5, low: 9.8, open: 10, previousClose: 9.9, last: 10.2 }, marks: [{ id: 'a', kind: 'cost', price: 9.9 }, { id: 'b', kind: 'target', price: 11 }], scale: 2 })
  assert.deepEqual([...rows.map(row => row.text)], ['今高 10.50　今低 9.80', '今开 10.00　昨收 9.90', '成本 9.90', '卖价 11.00', '盈亏 +3.03%　每股 +0.30'])
  assert.equal(rows.at(-1).tone, ' ssb-up', '盈亏带涨跌方向色')
  // 没有成本就不占位
  assert.equal(quoteTipLines({ quote: { last: 10 }, marks: [], scale: 2 }).some(row => /盈亏/.test(row.text)), false)
  // 有成本没现价(停牌/盘前)给占位符而不是 +0.00%
  const stale = quoteTipLines({ quote: {}, marks: [{ id: 'a', kind: 'cost', price: 9.9 }], scale: 2 })
  assert.match(stale.at(-1).text, /盈亏 —　每股 —/)
  const missing = quoteTipLines({ quote: {}, marks: [], scale: 2 })
  assert.deepEqual([...missing.map(row => row.text)], ['今高 —　今低 —', '今开 —　昨收 —'], '缺字段给破折号, 不能把 null 当 0')
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

test('一字板或贴边行情纵轴仍容纳昨收且不把曲线挤出窗', async () => {
  const { sparkRangeOf } = (await loadClient()).plugin.__testing
  const flat = sparkRangeOf({ values: [10.2, 10.2, 10.2, 10.2], preClose: 10 })
  assert.ok(flat.low < 10.2 && 10.2 < flat.high, '横盘线要有厚度, 不能退化成一条边')
  assert.ok(flat.low <= 10 && flat.high >= 10.2, '昨收仍要落在窗内')
  const edge = sparkRangeOf({ values: [9.95, 10, 10.05, 10.1], preClose: 10.2 })
  assert.ok(edge.low < 9.95 && edge.high > 10.2, '贴边昨收不能被挤出窗口')
  const one = sparkRangeOf({ values: [10.2, 10.2], preClose: 10 })
  assert.ok(one.low <= 10 && one.high >= 10.2, '1 倍仍容纳昨收')
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

test('没有悬停时不渲染读出浮层', async () => {
  const { plugin } = await loadClient()
  const html = renderToStaticMarkup(React.createElement(plugin.__testing.Sparkline, { candles: [{ time: '09:31', close: 10 }, { time: '09:32', close: 10.1 }], preClose: 10, marks: [], scale: 2 }))
  assert.doesNotMatch(html, /ssb-float-hover/, '悬停浮层只在指针进入后出现')
})
