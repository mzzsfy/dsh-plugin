import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import vm from 'node:vm'

// 指标是纯函数: 只经 client.js 顶层的 vm 求值即可取到, 不需要 React 运行时
async function load() {
  let plugin
  const source = await readFile(new URL('../src/client.js', import.meta.url), 'utf8')
  const window = { __ModuleLoader__: { load: entry => { plugin = entry.factory(() => ({})) } } }
  vm.runInNewContext(source, { window, console, fetch: () => {}, AbortController, URLSearchParams, setTimeout, clearTimeout, setInterval, clearInterval, crypto: globalThis.crypto })
  return plugin.__testing
}

// 指标一律按等长数组返回, 前导不足窗口的位为 null: BOLL/BBI 要按索引对齐多条均线, 不能返回短数组
const candles = closes => closes.map((close, index) => ({ time: `2026-10-${String(index + 1).padStart(2, '0')}`, close }))

// vm 里求值得到的数组原型属于另一个 realm, 与本文件的数组字面量比较要先摊平
test('seriesMA 前导补 null, 尾部为窗口均值', async () => {
  const { seriesMA } = await load()
  assert.deepEqual([...seriesMA(candles([1, 2, 3, 4, 5]), 3)], [null, null, 2, 3, 4])
  assert.deepEqual([...seriesMA(candles([1, 2]), 3)], [null, null])
  // 窗口长度 1 时每根都等于自身
  assert.deepEqual([...seriesMA(candles([4, 9]), 1)], [4, 9])
})

test('seriesMA 用滑动和而非逐段重算, 长序列末尾仍等于手工均值', async () => {
  const { seriesMA } = await load()
  const closes = [10, 11, 12, 13, 14, 15, 16]
  assert.equal(seriesMA(candles(closes), 4).at(-1), (13 + 14 + 15 + 16) / 4)
  // 滑出窗口的值必须从和中减掉, 否则末位会偏大
  assert.equal(seriesMA(candles(closes), 2).at(-1), (15 + 16) / 2)
})

test('seriesEMA 以首根收盘为种子, k=2/(n+1), 前 n-1 位为 null', async () => {
  const { seriesEMA } = await load()
  const result = seriesEMA(candles([1, 2, 3]), 2)
  assert.equal(result[0], null)
  // k=2/3: 2*(2/3)+1*(1/3)=5/3; 3*(2/3)+(5/3)*(1/3)=23/9
  assert.ok(Math.abs(result[1] - 5 / 3) < 1e-12)
  assert.ok(Math.abs(result[2] - 23 / 9) < 1e-12)
})

test('seriesEMA 在 n=1 时退化为收盘价本身', async () => {
  const { seriesEMA } = await load()
  assert.deepEqual([...seriesEMA(candles([7, 8]), 1)], [7, 8])
})

test('seriesBoll 中轨等于同周期 MA, 上下轨对称并各偏离两倍总体标准差', async () => {
  const { seriesBoll, seriesMA } = await load()
  const closes = Array.from({ length: 20 }, (_, i) => i + 1)
  const [mid, up, low] = seriesBoll(candles(closes), 20, 2)
  const ma = seriesMA(candles(closes), 20)
  assert.deepEqual(mid, ma)
  const mean = 10.5, variance = closes.reduce((s, v) => s + (v - mean) ** 2, 0) / 20
  assert.ok(Math.abs(up[19] - (mean + 2 * Math.sqrt(variance))) < 1e-12)
  assert.ok(Math.abs(low[19] - (mean - 2 * Math.sqrt(variance))) < 1e-12)
  // 上下轨关于中轨对称
  assert.ok(Math.abs((up[19] + low[19]) / 2 - mid[19]) < 1e-12)
})

test('seriesBoll 常数序列标准差为零, 三轨重合', async () => {
  const { seriesBoll } = await load()
  const [mid, up, low] = seriesBoll(candles(new Array(20).fill(5)), 20, 2)
  assert.equal(mid[19], 5)
  assert.equal(up[19], 5)
  assert.equal(low[19], 5)
})

test('seriesBBI 是 MA3/6/12/24 的均值, 不足 24 根时为 null', async () => {
  const { seriesBBI, seriesMA } = await load()
  const closes = Array.from({ length: 24 }, (_, i) => i + 1)
  const bbi = seriesBBI(candles(closes))
  assert.deepEqual([...bbi.slice(0, 23)], new Array(23).fill(null))
  const series = candles(closes)
  const expected = [seriesMA(series, 3), seriesMA(series, 6), seriesMA(series, 12), seriesMA(series, 24)]
    .reduce((sum, line) => sum + line[23], 0) / 4
  assert.ok(Math.abs(bbi[23] - expected) < 1e-12)
})

test('空序列与短于窗口的序列都不抛错', async () => {
  const { seriesMA, seriesEMA, seriesBoll, seriesBBI } = await load()
  assert.deepEqual([...seriesMA([], 5)], [])
  assert.deepEqual([...seriesEMA([], 5)], [])
  assert.deepEqual([...seriesBoll([], 20, 2).map(line => [...line])], [[], [], []])
  assert.deepEqual([...seriesBBI([])], [])
  // 长度不足窗口: 全部为 null, 交给调用侧过滤, 不产生越界读
  assert.deepEqual([...seriesMA(candles([1, 2]), 5)], [null, null])
})
