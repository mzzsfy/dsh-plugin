import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import vm from 'node:vm'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
async function loadClientWithReact() {
  let plugin
  const source = await readFile(new URL('../src/client.js', import.meta.url), 'utf8')
  const window = { __ModuleLoader__: { load: entry => { plugin = entry.factory(name => name === 'react' ? React : {}) } } }
  vm.runInNewContext(source, { window, console, fetch: globalThis.fetch, AbortController, URLSearchParams, setTimeout, clearTimeout, setInterval, clearInterval, crypto: globalThis.crypto })
  return { plugin }
}
async function runtime(options = {}) {
  let plugin, reset, snapshotTask, listener, panel = 'stock-sidebar'
  const messages = [], source = await readFile(new URL('../src/client.js', import.meta.url), 'utf8')
  const window = { __ModuleLoader__: { load: entry => { plugin = entry.factory(() => ({})) } } }
  vm.runInNewContext(source, { window, console, AbortController, URLSearchParams, setTimeout, clearTimeout, setInterval, clearInterval, crypto: globalThis.crypto, fetch: globalThis.fetch })
  const doc = { visibilityState: 'visible', addEventListener() {}, removeEventListener() {} }
  const value = plugin.__testing.createPageRuntime({ layout: { panelInfo: { getSnapshot: () => ({ activePanelId: panel }), subscribe: fn => { listener = fn; return () => {} } } }, bus: { publish: m => messages.push(m), subscribe: (fn, opts) => { reset = opts.onReset; return () => {} } }, tools: { createSnapshotRefresh: fn => { snapshotTask = fn; return { refresh() {}, dispose() {} } } }, document: doc, ...options })
  return { value, doc, messages, reset: () => reset(), pull: () => snapshotTask(), select: id => { panel = id; listener() } }
}
const snapshot = (seq, epoch = 'a', routingRevision = 0) => ({ serverEpoch: epoch, snapshotSeq: seq, routingRevision, routeSelections: {}, quotes: { a: { quote: { last: String(seq) } } }, control: { revision: seq, watchlist: { order: [], items: {} } } })
test('U07/U10 旧序号与退休Host epoch都不能回滚UI', async () => {
  const { value } = await runtime()
  value.applySnapshot(snapshot(10)); value.applySnapshot(snapshot(9)); assert.equal(value.getSnapshot().data.snapshotSeq, 10)
  value.applySnapshot(snapshot(1, 'b')); value.applySnapshot(snapshot(11, 'a')); assert.equal(value.getSnapshot().data.serverEpoch, 'b')
  value.dispose()
})
test('U05 暂停期间路由变化清掉旧价格而保留暂停和设置草稿', async () => {
  const { value } = await runtime()
  value.applySnapshot(snapshot(1)); value.updateView({ settingsDraft: { preserved: true } }); value.setPaused(true)
  const newer = snapshot(2, 'a', 1); newer.quotes = {}; value.applySnapshot(newer)
  assert.equal(Object.keys(value.getSnapshot().data.quotes).length, 0)
  assert.equal(value.getSnapshot().paused, true); assert.equal(value.getSnapshot().view.settingsDraft.preserved, true)
  value.dispose()
})
test('D01/D04/H09 同页反复入口不重复需求；暂停只撤销本页', async () => {
  const r = await runtime(), before = r.messages.length
  r.select('stock-sidebar'); assert.equal(r.messages.length, before)
  r.value.setPaused(true); assert.equal(r.messages.at(-1).active, false)
  r.value.setPaused(false); assert.equal(r.messages.at(-1).active, true)
  assert.equal(new Set(r.messages.map(m => m.pageId)).size, 1)
  r.value.dispose()
})
test('U06 配置409保留草稿且不自动重放写请求', async () => {
  let calls = 0
  const r = await runtime({ fetch: async () => { calls++; return { ok: false, json: async () => ({ ok: false, error: { code: 'REVISION_CONFLICT', message: '版本冲突' } }) } } })
  r.value.applySnapshot(snapshot(1)); r.value.updateView({ settingsDraft: { preserved: true } })
  await assert.rejects(r.value.configuration({ providers: [], routes: [] }, []), /版本冲突/)
  assert.equal(r.value.getSnapshot().view.settingsDraft.preserved, true); assert.equal(calls, 1)
  r.value.dispose()
})
test('U03 未选中候选时确认添加不可用，不自动取首项', async () => {
  const { plugin } = await loadClientWithReact()
  const security = { id: 'XSHG:equity:600519', officialName: '贵州茅台', code: '600519', exchange: 'XSHG' }
  let adds = 0
  const runtimeStub = { getSnapshot: () => ({ view: { view: 'search', query: '茅台', selectedId: null, sort: 'manual' }, busy: {}, candidates: [security], composing: false, data: { control: { revision: 1, watchlist: { order: [], items: {} }, preferences: {} } } }), subscribe: () => () => {}, updateView() {}, mutate: async () => { adds++ } }
  const html = renderToStaticMarkup(React.createElement(plugin.__testing.StockPage, { runtime: runtimeStub, layout: {} }))
  assert.match(html, /确认添加/)
  assert.match(html, /disabled/)
  assert.equal(adds, 0)
})
// D2: Given已持久化空配置 When点一键默认源 Then草稿填充suggested;再走检查→保存回路提交
test('设置页空配置一键默认源填充草稿', async () => {
  const { plugin } = await loadClientWithReact()
  const suggested = { providers: [{ id: 'em-default', adapterId: 'eastmoney', enabled: true, credentialEnv: null, quotaGroup: 'free-quote', budget: { requestsPerMinute: 60, dailyRequestLimit: null, billingUnit: 'request', symbolCreditsPerMinute: null, capabilityLimits: {} } }], routes: [{ id: 'xshg-quotes', capability: 'quotes', market: 'XSHG', instrument: 'equity', primaryInstanceId: 'em-default', fallbackInstanceIds: [], failoverMode: 'off', maxDelaySeconds: null, acceptUnknownDelay: true }] }
  const state = { view: { view: 'settings', query: '', selectedId: null, sort: 'manual', settingsDraft: null }, busy: {}, candidates: [], composing: false, undo: null, error: '', errorCode: '', data: { control: { revision: 1, routingRevision: 0, watchlist: { order: [], items: {} }, preferences: {}, providers: [], routes: [] }, adapters: [{ adapterId: 'eastmoney', capabilities: ['quotes', 'catalog', 'search'], credential: 'none' }], providerStatus: [], catalogs: [], routeSelections: {}, suggested } }
  const updates = []
  const runtimeStub = { getSnapshot: () => state, subscribe: () => () => {}, updateView: patch => updates.push(patch) }
  renderToStaticMarkup(React.createElement(plugin.__testing.StockPage, { runtime: runtimeStub, layout: {} }))
  assert.match(renderToStaticMarkup(React.createElement(plugin.__testing.StockPage, { runtime: runtimeStub, layout: {} })), /启用默认数据源/)
  assert.equal(updates.length, 0)
})
// E1: Given搜索报目录未就绪 When搜索页渲染 Then错误下方出现前往浏览市场引导
test('搜索未就绪时引导前往浏览市场', async () => {
  const { plugin } = await loadClientWithReact()
  const state = { view: { view: 'search', query: '茅台', selectedId: null, sort: 'manual' }, busy: {}, candidates: [], composing: false, undo: null, error: '目录未就绪，请先配置并同步目录来源', errorCode: 'CATALOG_NOT_READY', data: { control: { revision: 1, watchlist: { order: [], items: {} }, preferences: {} } } }
  const updates = []
  const runtimeStub = { getSnapshot: () => state, subscribe: () => () => {}, updateView: patch => updates.push(patch) }
  const html = renderToStaticMarkup(React.createElement(plugin.__testing.StockPage, { runtime: runtimeStub, layout: {} }))
  assert.match(html, /前往浏览市场/)
})
// M3: Given浏览视图无缓存 When渲染 Then显示同步引导
test('浏览视图渲染市场目录与空态同步引导', async () => {
  const { plugin } = await loadClientWithReact()
  const securities = [{ id: 'XSHG:equity:600001', officialName: '甲', code: '600001', exchange: 'XSHG' }]
  const state = { view: { view: 'browse', query: '', selectedId: null, sort: 'manual', browseMarket: 'XSHG', browseRows: securities, browseTotal: 1 }, busy: {}, candidates: [], composing: false, undo: null, data: { control: { revision: 1, watchlist: { order: [], items: {} }, preferences: {} } } }
  const runtimeStub = { getSnapshot: () => state, subscribe: () => () => {}, updateView() {}, mutate: async () => {} }
  const html = renderToStaticMarkup(React.createElement(plugin.__testing.StockPage, { runtime: runtimeStub, layout: {} }))
  assert.match(html, /浏览市场/)
  assert.match(html, /600001/)
})
test('U01/U02 IME组合不查询，后发查询覆盖先发迟到结果', async () => {
  const callbacks = [], r = await runtime({ fetch: (url, opts) => new Promise(resolve => callbacks.push({ url, signal: opts.signal, resolve })) })
  r.value.applySnapshot(snapshot(1)); r.value.composition(true); r.value.search('茅'); await new Promise(resolve => setTimeout(resolve, 320)); assert.equal(callbacks.length, 0)
  r.value.composition(false); await new Promise(resolve => setTimeout(resolve, 320)); const old = callbacks[0]
  r.value.search('平安'); await new Promise(resolve => setTimeout(resolve, 320)); const newer = callbacks[1]
  newer.resolve({ ok: true, json: async () => ({ ok: true, data: { routingRevision: 0, items: [{ id: 'new' }] } }) })
  await new Promise(resolve => setImmediate(resolve))
  old.resolve({ ok: true, json: async () => ({ ok: true, data: { routingRevision: 0, items: [{ id: 'old' }] } }) })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(r.value.getSnapshot().candidates[0].id, 'new'); assert.equal(old.signal.aborted, true)
  r.value.dispose()
  for (const item of callbacks) item.resolve({ ok: true, json: async () => ({ ok: true, data: { items: [], routingRevision: 0 } }) })
})
