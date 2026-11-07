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

// 全部收市后还按刷新间隔打上游是白烧额度: 休市应该只读快照
test('休市时轮询走只读快照, 开市才刷新', async () => {
  const { floatPollUrl } = await load()
  assert.equal(floatPollUrl(true), '/api/stock-assistant/snapshot')
  assert.equal(floatPollUrl(false), '/api/stock-assistant/refresh')
})

// 但只读快照不能是唯一路径: 面板不在前台时宿主会 cancelIdle, 没人刷新就会一直停在旧数据上,
// 所以收市档必须隔若干拍插一次真刷新
test('收市档每十拍至少插一次真刷新', async () => {
  const source = await readFile(new URL('../src/client.js', import.meta.url), 'utf8')
  const guard = source.match(/const readOnly = allClosed && tick % (\d+) !== 0/)
  assert.ok(guard, '收市档必须有真刷新兜底, 不能纯靠快照')
  const every = Number(guard[1])
  assert.ok(every >= 2 && every <= 20, `兜底间隔 ${every} 拍不合理`)
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
