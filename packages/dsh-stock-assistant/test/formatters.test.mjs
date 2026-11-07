import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import vm from 'node:vm'

// 这两个函数决定界面上"没有数据"和"真的是 0"怎么区分, 混淆过一次就会把区间高低压到地板上
const load = async () => {
  const source = await readFile(new URL('../src/client.js', import.meta.url), 'utf8')
  const sandbox = {
    window: { __ModuleLoader__: { load: spec => { sandbox.__spec = spec } }, addEventListener() {}, removeEventListener() {}, dispatchEvent() {}, innerWidth: 1280, innerHeight: 800, LightweightCharts: {} },
    document: { addEventListener() {}, removeEventListener() {}, visibilityState: 'visible', documentElement: {}, body: {}, createElement: () => ({ style: {}, append() {}, addEventListener() {}, remove() {} }), querySelector: () => null, querySelectorAll: () => [], head: { appendChild() {} } },
    localStorage: { getItem: () => null, setItem() {} },
    fetch: async () => ({ ok: true, json: async () => ({ ok: true }) }),
    crypto: { randomUUID: () => 'id' },
    React: new Proxy({}, { get: () => () => null }),
    console, setTimeout, clearTimeout, setInterval, clearInterval, URLSearchParams, Date, Math, JSON, Number, String, Array, Object, Promise, Error,
  }
  vm.createContext(sandbox)
  vm.runInContext(source, sandbox)
  return sandbox.__spec.factory(() => ({})).__testing
}

test('finiteOr 不把缺失值变成 0', async () => {
  const { finiteOr } = await load()
  for (const empty of [null, undefined, '']) assert.ok(Number.isNaN(finiteOr(empty)), `${String(empty)} 应得 NaN`)
  // 真实的 0 要保留, 否则会把"确实没成交"又抹成未知
  assert.equal(finiteOr(0), 0)
  assert.equal(finiteOr('0'), 0)
  assert.equal(finiteOr(12.5), 12.5)
  assert.equal(finiteOr('12.5'), 12.5)
  assert.ok(Number.isNaN(finiteOr('abc')))
})

test('formatAmount 区分成交额缺省与成交量真值', async () => {
  const { formatAmount } = await load()
  assert.equal(formatAmount(null), '—')
  assert.equal(formatAmount(undefined), '—')
  // 默认: 成交额的 0 视为来源没给
  assert.equal(formatAmount(0), '—')
  assert.equal(formatAmount('0'), '—')
  // 显式关掉: 成交量 0 是真值
  assert.equal(formatAmount(0, { zeroIsMissing: false }), '0')
  // 缩写口径
  assert.equal(formatAmount(9999), '9999')
  assert.equal(formatAmount(10000), '1万')
  assert.equal(formatAmount(123456), '12万')
  assert.equal(formatAmount(123456789), '1.2亿')
  // 负数按绝对值判断量级, 不产出 "-0.0亿"
  assert.equal(formatAmount(-123456789), '-1.2亿')
  assert.equal(formatAmount(Number.NaN), '—')
})

// 清洗要同时满足三件事: 保住来源独有的字段、别让 null 变成 0 压扁价格轴、别让 NaN 毒掉后续指标
test('sanitizeCandles 保住额外字段并丢掉残根', async () => {
  const { sanitizeCandles } = await load()
  const raw = [
    { time: 1, open: 10, high: 11, low: 9, close: 10.5, volume: 100, avg: 10.2, amount: 1e6, extra: 'keep' },
    // close 缺失: 整根丢掉, 否则 NaN 会沿着均线窗口往后传染
    { time: 2, open: 11, high: 12, low: 10, close: null, volume: 200 },
    // open 是 NaN: 同样丢掉
    { time: 3, open: Number.NaN, high: 12, low: 10, close: 11 },
    // 数值字段以字符串形态给: 要解析出来
    { time: 4, open: '12', high: '13', low: '11', close: '12.5', volume: '300' },
  ]
  const out = sanitizeCandles(raw)
  assert.equal(out.length, 2, '两根残根应被丢掉')
  assert.equal(out[0].avg, 10.2, '分时均价线靠 avg, 不能被清洗剥掉')
  assert.equal(out[0].amount, 1e6, '成交额同理要保留')
  assert.equal(out[0].extra, 'keep', '未知字段原样带过')
  assert.equal(out[1].close, 12.5)
  // 缺失一律 undefined 而不是 NaN, 下游的 ?? 与默认值才接得住
  assert.equal(out[1].volume, 300)
  assert.equal(out[1].avg, undefined)
  assert.equal(sanitizeCandles(null).length, 0)
  // 停牌当根是真的一点成交都没有, 0 必须保留: 当成缺失会让图上那根柱子直接消失
  const flat = sanitizeCandles([{ time: 9, open: 5, high: 5, low: 5, close: 5, volume: 0 }])
  assert.equal(flat[0].volume, 0, '零成交量是真值, 不能清洗成 undefined')
  // 时间戳坏掉要整根丢: 图表库遇到非法日期字符串会抛, 而那异常在 effect 里会把整块图表卸掉
  const badTime = sanitizeCandles([
    { time: '09:30', at: 100, open: 5, high: 6, low: 4, close: 5 },
    { time: '09:31', at: 'abc', open: 5, high: 6, low: 4, close: 5 },
    { time: 42, at: '2026-11-07T01:30:00Z', open: 5, high: 6, low: 4, close: 5 },
    { time: {}, open: 5, high: 6, low: 4, close: 5 },
  ])
  assert.equal(badTime.length, 2, '解析不了的时间戳整根丢掉')
  assert.equal(badTime[0].time, '09:30', '分时的字符串时间保留')
  assert.equal(badTime[1].time, 42, '日K 的数字时间保留')
  assert.equal(badTime[1].at, '2026-11-07T01:30:00Z', 'ISO 时间戳保留')
  // 没给成交量与行情自带时间戳时要能分辨出来: 前者靠 ?? 退回 0, 后者决定横轴用不用它
  const bare = sanitizeCandles([{ time: 10, at: '2026-11-07T01:30:00Z', open: 1, high: 2, low: 1, close: 2 }])
  assert.equal(bare[0].volume, undefined, '没给量就是 undefined, 不是 0')
  assert.equal(bare[0].at, '2026-11-07T01:30:00Z', '行情自带时间戳要原样带过')
})
