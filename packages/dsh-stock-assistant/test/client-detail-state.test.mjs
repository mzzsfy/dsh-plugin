import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import vm from 'node:vm'

async function load() {
  let plugin
  const source = await readFile(new URL('../src/client.js', import.meta.url), 'utf8')
  const window = { __ModuleLoader__: { load: entry => { plugin = entry.factory(() => ({})) } } }
  vm.runInNewContext(source, { window, console, fetch: () => {}, AbortController, URLSearchParams, setTimeout, clearTimeout, setInterval, clearInterval, crypto: globalThis.crypto })
  return plugin.__testing
}

const snapshotOf = items => ({ serverEpoch: 'e', snapshotSeq: 1, routingRevision: 0, routeSelections: {}, control: { revision: 1, routingRevision: 0, watchlist: { order: Object.keys(items), items }, preferences: { refreshSeconds: 15, colorMode: 'red-up' } }, quotes: {} })
const securityOf = (id, code) => ({ id, exchange: id.split(':')[0], code, officialName: code, alias: '', pinned: false, cost: null, group: '', currency: 'CNY', priceScale: 2 })
const runtimeOf = (plugin, extra = {}) => plugin.__testing.createPageRuntime({
  layout: { panelInfo: { getSnapshot: () => ({}), subscribe: () => () => {} }, selectPanel: extra.selectPanel || (() => {}) },
  bus: { subscribe: () => () => {}, publish() {} },
  tools: { createSnapshotRefresh: () => ({ refresh() {}, dispose() {} }) },
  document: { addEventListener() {}, removeEventListener() {}, visibilityState: 'visible' },
  fetch: extra.fetch || (async () => ({ ok: true, json: async () => ({ ok: true, data: snapshotOf({}) }) })),
})

// 成本草稿绑定的是"当前详情", 换详情不清就会把上一只输了一半的数字写到另一只身上
test('换详情时清空成本与分组草稿, 同一只重复打开不清', async () => {
  const { createPageRuntime } = await load()
  const runtime = createPageRuntime({
    layout: { panelInfo: { getSnapshot: () => ({}), subscribe: () => () => {} }, selectPanel() {} },
    bus: { subscribe: () => () => {}, publish() {} },
    tools: { createSnapshotRefresh: () => ({ refresh() {}, dispose() {} }) },
    document: { addEventListener() {}, removeEventListener() {} },
    fetch: async () => ({ ok: true, json: async () => ({ ok: true, data: snapshotOf({}) }) }),
  })
  runtime.updateView({ detailId: 'A', overlay: 'detail' })
  runtime.updateView({ costDraft: '422', groupDraft: '科技', costError: '错', groupError: '错' })
  assert.equal(runtime.getSnapshot().view.costDraft, '422')
  // 同一只再写一次草稿: detailId 没变, 草稿不能被清掉
  runtime.updateView({ costDraft: '430' })
  assert.equal(runtime.getSnapshot().view.costDraft, '430')
  // 换到 B: 四个草稿字段全部归零
  runtime.updateView({ detailId: 'B' })
  const view = runtime.getSnapshot().view
  assert.deepEqual({ costDraft: view.costDraft, groupDraft: view.groupDraft, costError: view.costError, groupError: view.groupError }, { costDraft: null, groupDraft: null, costError: null, groupError: null })
  runtime.dispose()
})

// 面板不在前台时点"打开详情"必须先把面板切回来, 否则界面毫无反应
test('openDetail 先切面板再进详情, 且不预载 K 线', async () => {
  const { createPageRuntime } = await load()
  const calls = []
  const runtime = createPageRuntime({
    layout: { panelInfo: { getSnapshot: () => ({}), subscribe: () => () => {} }, selectPanel: id => calls.push(['selectPanel', id]) },
    bus: { subscribe: () => () => {}, publish() {} },
    tools: { createSnapshotRefresh: () => ({ refresh() {}, dispose() {} }) },
    document: { addEventListener() {}, removeEventListener() {} },
    fetch: async url => { calls.push(['fetch', url.split('?')[0]]); return { ok: true, json: async () => ({ ok: true, data: snapshotOf({}) }) } },
  })
  const security = securityOf('XSHG:equity:600519', '600519')
  runtime.applySnapshot(snapshotOf({ [security.id]: security }))
  runtime.openDetail(security.id)
  const view = runtime.getSnapshot().view
  assert.equal(view.overlay, 'detail')
  assert.equal(view.detailId, security.id)
  assert.deepEqual(calls[0], ['selectPanel', 'stock-assistant'])
  // K 线由 KlineView 的加载 effect 负责, openDetail 不重复发
  assert.equal(calls.filter(([, path]) => path === '/kline').length, 0)
  runtime.dispose()
})

// 请求发出后切走: 旧结果晚到时不能覆盖新标的的数据
test('标的变化后到达的 K 线结果被丢弃', async () => {
  const { createPageRuntime } = await load()
  let release
  const pending = new Promise(resolve => { release = resolve })
  const runtime = createPageRuntime({
    layout: { panelInfo: { getSnapshot: () => ({}), subscribe: () => () => {} }, selectPanel() {} },
    bus: { subscribe: () => () => {}, publish() {} },
    tools: { createSnapshotRefresh: () => ({ refresh() {}, dispose() {} }) },
    document: { addEventListener() {}, removeEventListener() {} },
    fetch: () => pending,
  })
  const first = runtime.loadKline('A', '1d')
  runtime.loadKline('B', '1d')
  const before = runtime.getSnapshot()
  assert.equal(before.klineKey, 'B|1d')
  release({ ok: true, json: async () => ({ ok: true, data: { candles: [{ time: '2026-11-06', open: 1, high: 1, low: 1, close: 1 }] } }) })
  await first.catch(() => {})
  const after = runtime.getSnapshot()
  // A 的结果不该落到 B 的 key 上
  assert.equal(after.klineKey, 'B|1d')
  assert.equal(after.kline?.candles ?? null, null)
  runtime.dispose()
})
