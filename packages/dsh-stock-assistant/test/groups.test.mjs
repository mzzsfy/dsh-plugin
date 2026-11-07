import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import vm from 'node:vm'

// 列表与悬浮窗勾选共用同一份分组切面, 两处对"某只属于哪个组"必须给出同一答案
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
// vm 里造出的数组与对象原型属于另一个 realm, deepStrictEqual 会因原型不同而判不等, 序列化一遍归一
const plain = slices => JSON.parse(JSON.stringify({ pinned: slices.pinned, groups: slices.groups, ungrouped: slices.ungrouped }))
const item = group => ({ group, pinned: false })

test('按置顶 / 各组 / 未分组切分, 组序取首次出现顺序', async () => {
  const { groupSlices } = await load()
  const items = {
    a: item('科技'), b: { group: '', pinned: true }, c: item('能源'), d: item('科技'), e: item(''), f: item('能源'),
  }
  const slices = plain(groupSlices(['b', 'a', 'c', 'd', 'e', 'f'], items))
  assert.deepEqual(slices.pinned, ['b'])
  // 科技先于能源出现, 所以排在前面; 同组内保持自选顺序
  assert.deepEqual(slices.groups, [{ name: '科技', ids: ['a', 'd'] }, { name: '能源', ids: ['c', 'f'] }])
  assert.deepEqual(slices.ungrouped, ['e'])
})

// 组序是"首次出现"而不是字母序: 用例特意让两者相反, 否则排序实现改坏了也测不出来
test('组序取首次出现, 不是字典序', async () => {
  const { groupSlices } = await load()
  const items = { a: item('能源'), b: item('科技') }
  const slices = plain(groupSlices(['a', 'b'], items))
  // 「科技」的码位小于「能源」, 按字典序会排到前面
  assert.deepEqual(slices.groups.map(g => g.name), ['能源', '科技'])
})

test('置顶优先, 即使它在自选里排后面', async () => {
  const { groupSlices } = await load()
  const items = { a: item('科技'), b: { group: '', pinned: true } }
  const slices = plain(groupSlices(['a', 'b'], items))
  assert.deepEqual(slices.pinned, ['b'])
  assert.deepEqual(slices.groups, [{ name: '科技', ids: ['a'] }])
})

test('没有分组时全部落在未分组, 不产生空组', async () => {
  const { groupSlices } = await load()
  const items = { a: item(''), b: item('') }
  const slices = plain(groupSlices(['a', 'b'], items))
  assert.deepEqual(slices.groups, [])
  assert.deepEqual(slices.ungrouped, ['a', 'b'])
})

test('自选里查不到的 id 不会凭空造组', async () => {
  const { groupSlices } = await load()
  const slices = plain(groupSlices(['ghost'], {}))
  assert.deepEqual(slices.pinned, [])
  assert.deepEqual(slices.groups, [])
  assert.deepEqual(slices.ungrouped, [])
})

// 轮询决策三件事必须同时成立: 收市后不打上游、又不能永远停在那儿、还不能每分钟真刷一次
test('轮询决策: 收市不打 trend, 但自己醒得过来', async () => {
  const { pollPlan } = await load()
  // 开市: 列表刷卡, 图形打分时
  assert.equal(pollPlan({ mode: 'list', quiet: false, tick: 1 }), 'refresh')
  assert.equal(pollPlan({ mode: 'kline', quiet: false, tick: 1 }), 'trend')
  // 安静档: 列表走只读快照省额度; 图形彻底停掉——trend 端点不进缓存, 每拍都是真上游
  assert.equal(pollPlan({ mode: 'list', quiet: true, tick: 1 }), 'snapshot')
  assert.equal(pollPlan({ mode: 'kline', quiet: true, tick: 1 }), 'skip')
  assert.equal(pollPlan({ mode: 'kline', quiet: true, tick: 9 }), 'skip')
})

// 关键: 时段只能由刷新结果更新, 而面板不活跃时它的报价会冻结在 trading.
// 如果只在「已知安静」时才刷新, quiet 就永远翻不过来, 图形模式会无限打 trend
test('图形模式整十拍无条件真刷新, 才能从 trading 翻到安静', async () => {
  const { pollPlan } = await load()
  for (const tick of [10, 20, 30]) {
    assert.equal(pollPlan({ mode: 'kline', quiet: false, tick }), 'refresh', `第 ${tick} 拍必须真刷新, 否则收市永远发现不了`)
    assert.equal(pollPlan({ mode: 'kline', quiet: true, tick }), 'refresh')
    assert.equal(pollPlan({ mode: 'list', quiet: false, tick }), 'refresh')
  }
  // 整十拍之间: 开市打分时, 收市完全静默
  for (const tick of [1, 5, 9, 11, 19]) {
    assert.equal(pollPlan({ mode: 'kline', quiet: false, tick }), 'trend')
    assert.equal(pollPlan({ mode: 'kline', quiet: true, tick }), 'skip')
  }
})

// 午休不产生新数据, 与收盘同档; 只认 closed 的话午休一个半小时还在按交易频率打
test('午休与收盘同属安静档', async () => {
  const { QUIET_STATES } = await load()
  assert.deepEqual([...QUIET_STATES].sort(), ['break', 'closed'], '安静档必须同时含午休与收盘')
})

test('休市把轮询压到一分钟一拍, 开市跟随设置', async () => {
  const { floatPollDelay } = await load()
  assert.equal(floatPollDelay(15, false), 15 * 1000)
  assert.equal(floatPollDelay(60, false), 60 * 1000)
  // 设置比一分钟还慢时不该被强行提速
  assert.equal(floatPollDelay(120, true), 120 * 1000)
  assert.equal(floatPollDelay(15, true), 60 * 1000)
  // 设置缺失或非法时退回默认, 且不低于下限
  assert.equal(floatPollDelay(undefined, false), 15 * 1000)
  assert.equal(floatPollDelay(1, false), 15 * 1000)
})

// 主序列的键名决定重涂能不能生效: 分时用蜡烛那组键名等于什么都没改
test('重涂按主序列形态选键名', async () => {
  const { seriesPaintPlan } = await load()
  const theme = { up: '#c00', down: '#0a0' }
  const area = seriesPaintPlan(theme, true)
  assert.deepEqual(Object.keys(area).sort(), ['bottomColor', 'lineColor', 'topColor'])
  assert.equal(area.lineColor, theme.up)
  const candle = seriesPaintPlan(theme, false)
  assert.deepEqual(Object.keys(candle).sort(), ['borderDownColor', 'borderUpColor', 'downColor', 'upColor', 'wickDownColor', 'wickUpColor'])
  assert.equal(candle.upColor, theme.up)
  assert.equal(candle.downColor, theme.down)
  // 两套键名不允许重叠, 否则「按形态选键」这件事本身就没有意义
  assert.equal(Object.keys(area).some(key => key in candle), false)
})

// 同色系两套主题切换时明暗标记不变, 所以重涂不能只靠那个标记触发; 签名必须能分辨色值变化
test('主题签名能分辨换肤, 但不被无关字段干扰', async () => {
  const { themeSignature } = await load()
  const theme = {
    background: '#fff', textColor: '#334155', gridLine: '#e2e8f0', crosshair: '#94a3b8',
    up: '#dc2626', down: '#16a34a', volumeUp: '#dc262673', volumeDown: '#16a34a73',
    cost: '#7c3aed', EMA: '#c026d3', BBI: '#0f766e',
    MA: ['#a16207', '#b91c1c', '#1d4ed8', '#334155'], BOLL: ['#1d4ed8', '#60a5fa'],
  }
  const base = themeSignature(theme)
  // 同色系换主题: 背景与文字微调, 其余不动
  assert.notEqual(themeSignature({ ...theme, textColor: '#475569' }), base, '文字色变化必须重涂')
  // 只改涨跌配色
  assert.notEqual(themeSignature({ ...theme, up: '#b91c1c' }), base, '涨跌配色变化必须重涂')
  // 任一指标线换色
  assert.notEqual(themeSignature({ ...theme, MA: ['#000', ...theme.MA.slice(1)] }), base, '指标线换色必须重涂')
  // 背景变化必须重涂: 画布底色铺的就是它, canvas 不透明, 漏掉等于换了主题背景还停在旧色
  assert.notEqual(themeSignature({ ...theme, background: '#000' }), base, '背景变化必须重涂')
})
