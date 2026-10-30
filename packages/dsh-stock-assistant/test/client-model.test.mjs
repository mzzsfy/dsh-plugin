import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import vm from 'node:vm'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
export async function loadClient(extra = {}) {
  let plugin
  const source = await readFile(new URL('../src/client.js', import.meta.url), 'utf8')
  const window = { __ModuleLoader__: { load: entry => { plugin = entry.factory(name => extra.modules?.[name] || {}) } } }
  vm.runInNewContext(source, { window, console, fetch: globalThis.fetch, AbortController, URLSearchParams, setTimeout, clearTimeout, setInterval, clearInterval, crypto: globalThis.crypto, ...extra })
  return { plugin, window }
}
test('暂停期间显式刷新应用新价，普通快照仍保持暂停行情', async () => {
  const { plugin } = await loadClient()
  const snapshot = (seq, last) => ({ serverEpoch: 'one', snapshotSeq: seq, routingRevision: 0, routeSelections: {}, control: { revision: 0 }, quotes: { a: { quote: { last } } } })
  const runtime = plugin.__testing.createPageRuntime({ layout: { panelInfo: { getSnapshot: () => ({}), subscribe: () => () => {} } }, bus: { subscribe: () => () => {}, publish() {} }, tools: { createSnapshotRefresh: () => ({ refresh() {}, dispose() {} }) }, document: { addEventListener() {}, removeEventListener() {} }, fetch: async () => ({ ok: true, json: async () => ({ ok: true, data: snapshot(3, '12.00') }) }) })
  runtime.applySnapshot(snapshot(1, '10.00')); runtime.setPaused(true); runtime.applySnapshot(snapshot(2, '11.00'))
  assert.equal(runtime.getSnapshot().data.quotes.a.quote.last, '10.00')
  await runtime.refresh()
  assert.equal(runtime.getSnapshot().data.quotes.a.quote.last, '12.00')
  runtime.dispose()
})
test('U04 行菜单开启时冻结行序并继续更新数字', async () => {
  const { plugin } = await loadClient({ modules: { react: React } })
  const data = { control: { watchlist: { order: ['a','b'], items: { a: { id: 'a', officialName: '甲证券', code: '600001', exchange: 'XSHG' }, b: { id: 'b', officialName: '乙证券', code: '600002', exchange: 'XSHG' } } }, preferences: {} }, quotes: { a: { quote: { changePct: '-1.00', last: '9.00' } }, b: { quote: { changePct: '2.00', last: '12.00' } } } }
  const runtime = { getSnapshot: () => ({ data, busy: {}, view: { sort: 'desc', menuId: 'a', frozenOrder: ['a','b'], view: 'list' } }), subscribe: () => () => {} }
  const html = renderToStaticMarkup(React.createElement(plugin.__testing.StockPage, { runtime, layout: {} }))
  assert.ok(html.indexOf('甲证券') < html.indexOf('乙证券')); assert.match(html, /12\.00/)
})
test('UI01 自选列表呈现同源价格、涨跌符号与未知延迟', async () => {
  const { plugin } = await loadClient({ modules: { react: React } })
  const runtime = { getSnapshot: () => ({ view: { view: 'list', sort: 'manual' }, busy: {}, data: { control: { revision: 1, watchlist: { order: ['XSHG:equity:600519'], items: { 'XSHG:equity:600519': { id: 'XSHG:equity:600519', officialName: '贵州茅台', code: '600519', exchange: 'XSHG' } } }, preferences: { colorMode: 'red-up' } }, quotes: { 'XSHG:equity:600519': { health: 'ok', quote: { last: '10.00', changePct: '25.00', providerInstanceId: 'a', delayKind: 'unknown' } } } } }), subscribe: () => () => {} }
  const html = renderToStaticMarkup(React.createElement(plugin.__testing.StockPage, { runtime, layout: {} }))
  assert.match(html, /贵州茅台/); assert.match(html, /10\.00/); assert.match(html, /\+25\.00%/); assert.match(html, /延迟未知/)
  assert.match(html, /data-plugin="@mzzsfy\/dsh-stock-assistant"/)
})
test('H03/H04 main和导航入口配对且注册清理成对', async () => {
  const modules = { react: { createElement: (...args) => args }, '@mzzsfy/dsh-common-tools/client': { setupCommonTools: () => ({ publish() {}, subscribe: () => () => {} }), createSnapshotRefresh: () => ({ refresh() {}, dispose() {} }) } }
  const document = { visibilityState: 'visible', addEventListener() {}, removeEventListener() {} }
  const { plugin } = await loadClient({ modules, document })
  const cleanups = [], registrations = [], removed = []
  const ctx = { effect: fn => cleanups.push(fn()), layout: { panelInfo: { getSnapshot: () => ({ activePanelId: null }), subscribe: () => () => {} } }, slots: { inject: (name, fn) => { fn(); return () => removed.push(name) }, register: options => registrations.push(options) } }
  plugin.apply(ctx)
  assert.equal(registrations.find(r => r.name === 'main')?.key, 'stock-assistant')
  assert.equal(registrations.find(r => r.name === 'sidebar.panellist')?.id, 'stock-assistant')
  for (const cleanup of cleanups.reverse()) cleanup?.()
  assert.equal(removed.length, 2)
})
test('H05/H07/H08 页面级运行时保留跨会话与隐藏后的草稿，不因view卸载重建', async () => {
  const { plugin } = await loadClient()
  let panel = 'stock-assistant', listener
  const layout = { panelInfo: { getSnapshot: () => ({ activePanelId: panel }), subscribe: fn => { listener = fn; return () => { listener = null } } } }
  const runtime = plugin.__testing.createPageRuntime({ layout, bus: { subscribe: () => () => {}, publish() {} }, tools: { createSnapshotRefresh: () => ({ refresh() {}, dispose() {} }) }, document: { visibilityState: 'visible', addEventListener() {}, removeEventListener() {} }, fetch: async () => ({ ok: true, json: async () => ({ ok: true, data: { serverEpoch: 'one', snapshotSeq: 1, control: { revision: 0, watchlist: { order: [] }, preferences: {} } } }) }) })
  runtime.updateView({ view: 'settings', query: '茅台', settingsDraft: { preserved: true }, scrollTop: 120 })
  panel = null; listener()
  panel = 'stock-assistant'; listener()
  const value = runtime.getSnapshot()
  assert.equal(value.view.query, '茅台')
  assert.equal(value.view.settingsDraft.preserved, true)
  assert.equal(value.view.scrollTop, 120)
  runtime.dispose()
  assert.equal(listener, null)
})
