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
