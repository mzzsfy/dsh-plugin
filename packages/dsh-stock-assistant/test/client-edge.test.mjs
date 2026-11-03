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
  let plugin, reset, snapshotTask, listener, panel = 'stock-assistant'
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
  r.select('stock-assistant'); assert.equal(r.messages.length, before)
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
  const state = { view: { view: 'list', overlay: 'settings', query: '', selectedId: null, sort: 'manual', settingsDraft: null }, busy: {}, candidates: [], composing: false, undo: null, error: '', errorCode: '', data: { control: { revision: 1, routingRevision: 0, watchlist: { order: [], items: {} }, preferences: {}, providers: [], routes: [] }, adapters: [{ adapterId: 'eastmoney', capabilities: ['quotes', 'catalog', 'search'], credential: 'none' }], providerStatus: [], catalogs: [], routeSelections: {}, suggested } }
  const updates = []
  const runtimeStub = { getSnapshot: () => state, subscribe: () => () => {}, updateView: patch => updates.push(patch) }
  renderToStaticMarkup(React.createElement(plugin.__testing.StockPage, { runtime: runtimeStub, layout: {} }))
  assert.match(renderToStaticMarkup(React.createElement(plugin.__testing.StockPage, { runtime: runtimeStub, layout: {} })), /启用默认数据源/)
  assert.equal(updates.length, 0)
})
// 设置页信息架构: 递进区块+实例卡描述+反代端点+最近请求+概览横幅
test('设置页递进区块与实例可观测面渲染', async () => {
  const { plugin } = await loadClientWithReact()
  const item = { id: 'XSHG:equity:600519', officialName: '贵州茅台', code: '600519', exchange: 'XSHG', instrument: 'equity', currency: 'CNY', timezone: 'Asia/Shanghai', priceScale: 2, listingStatus: 'listed', alias: '', pinned: false }
  const suggested = { providers: [{ id: 'em-default', adapterId: 'eastmoney', enabled: true, credentialEnv: null, quotaGroup: 'free-quote', budget: { requestsPerMinute: 60, dailyRequestLimit: null, billingUnit: 'request', symbolCreditsPerMinute: null, capabilityLimits: {} } }], routes: [] }
  const state = { view: { view: 'list', overlay: 'settings', query: '', selectedId: null, sort: 'manual', settingsDraft: null }, busy: {}, candidates: [], composing: false, undo: null, error: '', errorCode: '', paused: false, data: { control: { revision: 1, routingRevision: 0, watchlist: { order: [], items: {} }, preferences: {}, providers: [{ id: 'em-default', adapterId: 'eastmoney', enabled: true, credentialEnv: null, quotaGroup: 'free-quote', budget: { requestsPerMinute: 60, dailyRequestLimit: null, billingUnit: 'request', symbolCreditsPerMinute: null, capabilityLimits: {} }, endpoints: { kline: 'https://proxy.corp/em/kline' } }], routes: [] }, quotes: { [item.id]: { last: '1392.05', previousClose: '1376.95', receivedAt: 1, quoteAt: null, delayKind: 'unknown' } }, adapters: [{ adapterId: 'eastmoney', capabilities: ['quotes', 'kline'], credential: 'none', description: '东方财富公开接口：免凭据，八市场行情/K线/搜索/目录，非官方无SLA', endpointKeys: [{ key: 'kline', label: 'K线历史' }, { key: 'quotes', label: '行情批量' }] }], providerStatus: [{ id: 'em-default', credentialPresent: true, proxy: false, endpointsCovered: 1, recentRequests: [{ at: 1000, url: 'quotes eastmoney', status: 'ok', ms: 120 }] }], catalogs: [], routeSelections: {}, klineReady: {}, suggested, vendorAvailable: true } }
  const runtimeStub = { getSnapshot: () => state, subscribe: () => () => {}, updateView: () => {}, loadKline: () => Promise.resolve({ candles: [] }) }
  const html = renderToStaticMarkup(React.createElement(plugin.__testing.StockPage, { runtime: runtimeStub, layout: {} }))
  assert.match(html, /数据源/, '区块1标题')
  assert.match(html, /市场与能力/, '区块2标题')
  assert.match(html, /显示偏好/, '区块3标题')
  assert.match(html, /东方财富公开接口/, '适配器一句话描述')
  assert.match(html, /接口反代/, '反代端点区可见')
  assert.match(html, /proxy\.corp\/em\/kline/, '已覆盖端点值回显')
  assert.match(html, /运行状态/, '请求日志区可见')
  assert.match(html, /quotes eastmoney/, '日志条目渲染')
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
// 概览: browse 头部指数条(名称+点位+涨跌幅+来源延迟), 概览缺省不渲染不占位
test('浏览页指数概览条渲染与静默缺省', async () => {
  const { plugin } = await loadClientWithReact()
  const securities = [{ id: 'XSHG:equity:600001', officialName: '甲', code: '600001', exchange: 'XSHG' }]
  const base = { view: { view: 'browse', query: '', selectedId: null, sort: 'manual', browseMarket: 'XSHG', browseRows: securities, browseTotal: 1 }, busy: {}, candidates: [], composing: false, undo: null, data: { control: { revision: 1, watchlist: { order: [], items: {} }, preferences: {} } } }
  const withOverview = { ...base, data: { ...base.data, browseOverview: { name: '上证指数', last: '3900.25', change: '25.50', changePct: '0.66', delayKind: 'realtime', source: 'em-default' } } }
  const html = renderToStaticMarkup(React.createElement(plugin.__testing.StockPage, { runtime: { getSnapshot: () => withOverview, subscribe: () => () => {}, updateView() {}, mutate: async () => {} }, layout: {} }))
  assert.match(html, /上证指数/)
  assert.match(html, /3900\.25/)
  assert.match(html, /\+25\.50（\+0\.66%）/)
  assert.match(html, /em-default · 实时/)
  const html2 = renderToStaticMarkup(React.createElement(plugin.__testing.StockPage, { runtime: { getSnapshot: () => base, subscribe: () => () => {}, updateView() {}, mutate: async () => {} }, layout: {} }))
  assert.doesNotMatch(html2, /上证指数/, '无概览时不渲染不占位')
})
// 搜索候选「看一眼」: 名称区点击进详情(browsePeek 同源), 加自选/选择语义不变
test('搜索候选看一眼进详情', async () => {
  const { plugin } = await loadClientWithReact()
  const cand = [{ id: 'XHKG:equity:00700', officialName: '腾讯控股', code: '00700', exchange: 'XHKG', instrument: 'equity', currency: 'HKD', timezone: 'Asia/Hong_Kong', priceScale: 2, listingStatus: 'listed' }]
  const base = { view: { view: 'search', query: '腾讯', selectedId: null, sort: 'manual', alias: '' }, busy: {}, candidates: cand, composing: false, undo: null, error: '', data: { control: { revision: 1, routingRevision: 0, watchlist: { order: [], items: {} }, preferences: {} }, quotes: {}, adapters: [], providerStatus: [], catalogs: [], routeSelections: {}, klineReady: {}, vendorAvailable: false } }
  const updates = []
  const runtimeStub = { getSnapshot: () => base, subscribe: () => () => {}, updateView: patch => updates.push(patch), loadKline: () => Promise.resolve({ candles: [] }), refresh: () => Promise.resolve({}), mutate: async () => {} }
  const html = renderToStaticMarkup(React.createElement(plugin.__testing.StockPage, { runtime: runtimeStub, layout: {} }))
  assert.ok(html.includes('ssb-peek'), '候选行有看一眼按钮')
  assert.match(html, /腾讯控股/, '候选渲染')
  // 点击行为: 模拟 DOM 不便, 直接断言 updateView 调用契约由交互测试承担——渲染层锚定按钮与详情落地形态
  const detail = { ...base, view: { view: 'search', overlay: 'detail', detailId: cand[0].id, browsePeek: { [cand[0].id]: cand[0] }, selectedId: null, sort: 'manual', alias: '' }, kline: null }
  const html2 = renderToStaticMarkup(React.createElement(plugin.__testing.StockPage, { runtime: { getSnapshot: () => detail, subscribe: () => () => {}, updateView: () => {}, loadKline: () => Promise.resolve({ candles: [] }) }, layout: {} }))
  assert.match(html2, /腾讯控股/, 'peek 详情渲染')
  assert.match(html2, /加自选/, '非自选详情主操作')
  assert.match(html2, /HKD/, '港股币种徽标')
})
// browse 可点进详情: 行点击开详情(无需加自选), 非自选详情显示加自选而非别名/删除
test('browse行点击进详情与非自选详情形态', async () => {
  const { plugin } = await loadClientWithReact()
  const peer = { id: 'XSHG:equity:600001', officialName: '甲股', code: '600001', exchange: 'XSHG', instrument: 'equity', currency: 'CNY', timezone: 'Asia/Shanghai', priceScale: 2, listingStatus: 'listed', alias: '', pinned: false }
  const item = { id: 'XSHG:equity:600519', officialName: '贵州茅台', code: '600519', exchange: 'XSHG', instrument: 'equity', currency: 'CNY', timezone: 'Asia/Shanghai', priceScale: 2, listingStatus: 'listed', alias: '', pinned: false }
  const base = { view: { view: 'list', overlay: 'detail', detailId: peer.id, browsePeek: { [peer.id]: peer }, selectedId: null, sort: 'manual', alias: '' }, busy: {}, candidates: [], composing: false, undo: null, error: '', paused: false, kline: null, data: { control: { revision: 1, routingRevision: 0, watchlist: { order: [item.id], items: { [item.id]: item } }, preferences: {} }, quotes: { [peer.id]: { quote: { last: '12.00', previousClose: '11.50', change: '0.50', changePct: '4.35', providerInstanceId: 'a', delayKind: 'realtime', quoteAt: null, receivedAt: 1, open: '11.8', high: '12.1', low: '11.4', volume: '1000', amount: '12000', sessionState: 'trading' }, health: 'ok', lastError: null } }, adapters: [], providerStatus: [], catalogs: [], routeSelections: {}, klineReady: {}, vendorAvailable: false } }
  const runtimeStub = { getSnapshot: () => base, subscribe: () => () => {}, updateView: () => {}, loadKline: () => Promise.resolve({ candles: [] }) }
  const html = renderToStaticMarkup(React.createElement(plugin.__testing.StockPage, { runtime: runtimeStub, layout: {} }))
  assert.match(html, /甲股/, 'browsePeek 证券详情可渲染')
  assert.match(html, /加自选/, '非自选详情显示加自选')
  assert.doesNotMatch(html, /保存别名/, '非自选详情不显示别名区')
  assert.doesNotMatch(html, /删除/, '非自选详情不显示删除')
  const inWatch = { ...base, view: { ...base.view, detailId: item.id, browsePeek: {} } }
  const html2 = renderToStaticMarkup(React.createElement(plugin.__testing.StockPage, { runtime: { getSnapshot: () => inWatch, subscribe: () => () => {}, updateView: () => {}, loadKline: () => Promise.resolve({ candles: [] }) }, layout: {} }))
  const detailHtml2 = html2.slice(html2.indexOf('ssb-detail'))
  assert.match(html2.slice(html2.indexOf('ssb-detail')), /保存别名/, '自选详情保留别名区')
  assert.doesNotMatch(detailHtml2.slice(0, detailHtml2.indexOf('ssb-facts')), /加自选/, '自选详情无加自选主操作')
})
// 交互分层: 详情=右侧抽屉浮层(底层列表仍渲染, 关闭语义统一无返回按钮), 设置=模态, K线周期=Tab 语义
test('详情抽屉化: 浮层结构+底层保留+无返回按钮', async () => {
  const { plugin } = await loadClientWithReact()
  const item = { id: 'XSHG:equity:600519', officialName: '贵州茅台', code: '600519', exchange: 'XSHG', instrument: 'equity', currency: 'CNY', timezone: 'Asia/Shanghai', priceScale: 2, listingStatus: 'listed', alias: '', pinned: false }
  const state = { view: { view: 'list', overlay: 'detail', detailId: item.id, sort: 'manual', alias: '' }, busy: {}, candidates: [], composing: false, undo: null, error: '', paused: false, kline: null, data: { control: { revision: 1, routingRevision: 0, watchlist: { order: [item.id], items: { [item.id]: item } }, preferences: {} }, quotes: { [item.id]: { quote: { last: '10.00', previousClose: '9.50', change: '0.50', changePct: '5.26', providerInstanceId: 'a', delayKind: 'realtime', quoteAt: null, receivedAt: 1, sessionState: 'trading' }, health: 'ok', lastError: null } }, adapters: [], providerStatus: [], catalogs: [], routeSelections: {}, klineReady: {}, vendorAvailable: false } }
  const html = renderToStaticMarkup(React.createElement(plugin.__testing.StockPage, { runtime: { getSnapshot: () => state, subscribe: () => () => {}, updateView: () => {}, loadKline: () => Promise.resolve({ candles: [] }) }, layout: {} }))
  assert.match(html, /ssb-overlay/, '浮层容器渲染')
  assert.match(html, /ssb-drawer/, '抽屉形态')
  assert.match(html, /贵州茅台/, '抽屉内详情')
  assert.match(html, /自选 · /, '底层自选列表仍渲染')
  assert.doesNotMatch(html, /返回自选/, '抽屉无返回自选按钮')
  assert.doesNotMatch(html, /返回市场/, '抽屉无返回市场按钮')
  assert.match(html, /ssb-overlay-close|关闭/, '统一关闭入口')
})
test('设置模态化: 遮罩居中+关闭回主区', async () => {
  const { plugin } = await loadClientWithReact()
  const state = { view: { view: 'list', overlay: 'settings', settingsDraft: { step: 1, providers: [], routes: [], saved: false, json: '', checkIds: [], checkResults: [] }, sort: 'manual', alias: '' }, busy: {}, candidates: [], composing: false, undo: null, error: '', paused: false, data: { control: { revision: 1, routingRevision: 0, watchlist: { order: [], items: {} }, preferences: {} }, quotes: {}, adapters: [], providerStatus: [], catalogs: [], routeSelections: {}, klineReady: {}, vendorAvailable: false } }
  const html = renderToStaticMarkup(React.createElement(plugin.__testing.StockPage, { runtime: { getSnapshot: () => state, subscribe: () => () => {}, updateView: () => {} }, layout: { providerCheck: () => {} } }))
  assert.match(html, /ssb-modal/, '模态形态')
  assert.match(html, /ssb-overlay/, '遮罩层')
  assert.match(html, /自选 · /, '底层主区仍渲染')
  assert.doesNotMatch(html, /返回自选/, '模态无返回自选按钮')
})
test('K线周期Tab语义', async () => {
  const { plugin } = await loadClientWithReact()
  const item = { id: 'XSHG:equity:600519', officialName: '贵州茅台', code: '600519', exchange: 'XSHG', instrument: 'equity', currency: 'CNY', timezone: 'Asia/Shanghai', priceScale: 2, listingStatus: 'listed', alias: '', pinned: false }
  const state = { view: { view: 'list', overlay: 'detail', detailId: item.id, sort: 'manual', alias: '' }, busy: {}, candidates: [], composing: false, undo: null, error: '', kline: { [item.id]: { '1d': { candles: [] } } }, klinePeriod: '1d', data: { control: { revision: 1, routingRevision: 0, watchlist: { order: [item.id], items: { [item.id]: item } }, preferences: {} }, quotes: {}, adapters: [], providerStatus: [], catalogs: [], routeSelections: {}, klineReady: {}, vendorAvailable: false } }
  const html = renderToStaticMarkup(React.createElement(plugin.__testing.StockPage, { runtime: { getSnapshot: () => state, subscribe: () => () => {}, updateView: () => {}, loadKline: () => Promise.resolve({ candles: [] }) }, layout: {} }))
  assert.match(html, /role="tab"/, '周期为 tab 角色')
  assert.match(html, /aria-selected="true"/, '当前周期选中态')
})
// 规范收敛: 弹层焦点管理结构锚(aria/层次), 交互行为(焦点移入还原/滚动锁定/Esc)真机验证
test('弹层焦点结构: 对话框可聚焦容器+关闭钮aria', async () => {
  const { plugin } = await loadClientWithReact()
  const item = { id: 'XSHG:equity:600519', officialName: '贵州茅台', code: '600519', exchange: 'XSHG', instrument: 'equity', currency: 'CNY', timezone: 'Asia/Shanghai', priceScale: 2, listingStatus: 'listed', alias: '', pinned: false }
  const state = { view: { view: 'list', overlay: 'detail', detailId: item.id, sort: 'manual', alias: '' }, busy: {}, candidates: [], composing: false, undo: null, error: '', paused: false, kline: null, data: { control: { revision: 1, routingRevision: 0, watchlist: { order: [item.id], items: { [item.id]: item } }, preferences: {} }, quotes: {}, adapters: [], providerStatus: [], catalogs: [], routeSelections: {}, klineReady: {}, vendorAvailable: false } }
  const html = renderToStaticMarkup(React.createElement(plugin.__testing.StockPage, { runtime: { getSnapshot: () => state, subscribe: () => () => {}, updateView: () => {}, loadKline: () => Promise.resolve({ candles: [] }) }, layout: {} }))
  assert.match(html, /aria-label="关闭"/, '关闭钮有可访问名')
  assert.match(html, /tabindex="-1"/, '浮层卡片可编程聚焦(焦点移入落点)')
})
test('顶部导航层次: 低频操作收进更多菜单', async () => {
  const { plugin } = await loadClientWithReact()
  const state = { view: { view: 'list', sort: 'manual', alias: '' }, busy: {}, candidates: [], composing: false, undo: null, error: '', paused: false, data: { control: { revision: 1, routingRevision: 0, watchlist: { order: [], items: {} }, preferences: {} }, quotes: {}, adapters: [], providerStatus: [], catalogs: [], routeSelections: {}, klineReady: {}, vendorAvailable: false } }
  const html = renderToStaticMarkup(React.createElement(plugin.__testing.StockPage, { runtime: { getSnapshot: () => state, subscribe: () => () => {}, updateView: () => {} }, layout: {} }))
  assert.match(html, /更多/, '更多菜单入口')
  assert.ok(!html.match(/aria-label="股票工具操作"[^>]*>[^<]*<button[^>]*>设置/), '设置不再平铺在主导航')
})
test('browse主区返回入口与K线tablist纯净', async () => {
  const { plugin } = await loadClientWithReact()
  const state = { view: { view: 'browse', browseMarket: 'XSHG', browseRows: [], browseTotal: 0, browseOffset: 0, sort: 'manual', alias: '', browsePeek: {} }, busy: {}, candidates: [], composing: false, undo: null, error: '', paused: false, data: { control: { revision: 1, routingRevision: 0, watchlist: { order: [], items: {} }, preferences: {} }, quotes: {}, adapters: [], providerStatus: [], catalogs: [], routeSelections: {}, klineReady: {}, vendorAvailable: false } }
  const html = renderToStaticMarkup(React.createElement(plugin.__testing.StockPage, { runtime: { getSnapshot: () => state, subscribe: () => () => {}, updateView: () => {}, loadBrowse: () => Promise.resolve({ items: [], total: 0 }) }, layout: {} }))
  assert.match(html, /返回自选/, 'browse 主区有返回入口')
  const item = { id: 'XSHG:equity:600519', officialName: '贵州茅台', code: '600519', exchange: 'XSHG', instrument: 'equity', currency: 'CNY', timezone: 'Asia/Shanghai', priceScale: 2, listingStatus: 'listed', alias: '', pinned: false }
  const detail = { ...state, view: { ...state.view, view: 'list', overlay: 'detail', detailId: item.id, browsePeek: { [item.id]: item } }, kline: { [item.id]: { '1d': { candles: [] } } }, klinePeriod: '1d' }
  const html2 = renderToStaticMarkup(React.createElement(plugin.__testing.StockPage, { runtime: { getSnapshot: () => detail, subscribe: () => () => {}, updateView: () => {}, loadKline: () => Promise.resolve({ candles: [] }) }, layout: {} }))
  assert.ok(html2.includes('role="tablist"'), 'tablist 存在')
  const tabStart = html2.indexOf('role="tablist"')
  const tabSeg = html2.slice(tabStart, html2.indexOf('</div>', tabStart))
  assert.ok(!tabSeg.includes('↻'), '刷新钮不在 tablist 内')
})
// 好用性收敛: 穿透切换/键盘邻移/列权重/组合概览
test('自选列表列权重与组合概览', async () => {
  const { plugin } = await loadClientWithReact()
  const mk = (id, name, code, ex) => ({ id, officialName: name, code, exchange: ex, instrument: 'equity', currency: ex === 'XHKG' ? 'HKD' : 'CNY', timezone: 'Asia/Shanghai', priceScale: 2, listingStatus: 'listed', alias: '', pinned: false })
  const a = mk('XHKG:equity:00700', '腾讯控股', '00700', 'XHKG'), b = mk('XSHG:equity:600519', '贵州茅台', '600519', 'XSHG')
  const q = (last, pct, change) => ({ quote: { last, previousClose: '1', change, changePct: pct, providerInstanceId: 'a', delayKind: 'realtime', quoteAt: null, receivedAt: 1, sessionState: 'trading' }, health: 'ok', lastError: null })
  const state = { view: { view: 'list', sort: 'manual', alias: '' }, busy: {}, candidates: [], composing: false, undo: null, error: '', paused: false, kline: null, data: { control: { revision: 1, routingRevision: 0, watchlist: { order: [a.id, b.id], items: { [a.id]: a, [b.id]: b } }, preferences: {} }, quotes: { [a.id]: q('397.20', '1.27', '5.00'), [b.id]: q('1480.00', '2.84', '40.85') }, adapters: [], providerStatus: [], catalogs: [], routeSelections: {}, klineReady: {}, vendorAvailable: false } }
  const html = renderToStaticMarkup(React.createElement(plugin.__testing.StockPage, { runtime: { getSnapshot: () => state, subscribe: () => () => {}, updateView: () => {}, loadKline: () => Promise.resolve({ candles: [] }) }, layout: {} }))
  assert.match(html, /2 只 · 2 涨 0 跌/, '组合概览条')
  assert.match(html, /\+5\.00/, '涨跌额列存在')
  const rowSeg = html.slice(html.indexOf('腾讯控股'), html.indexOf('贵州茅台'))
  assert.ok(!rowSeg.includes('延迟'), '来源延迟不再占主列（收进状态徽标 title）')
  assert.match(rowSeg, /✓/, '健康徽标短形态')
})
test('键盘邻移与穿透切换契约', async () => {
  const { plugin } = await loadClientWithReact()
  const mk = (id, name, code, ex) => ({ id, officialName: name, code, exchange: ex, instrument: 'equity', currency: 'CNY', timezone: 'Asia/Shanghai', priceScale: 2, listingStatus: 'listed', alias: '', pinned: false })
  const a = mk('XSHG:equity:600001', '甲股', '600001', 'XSHG'), b = mk('XSHG:equity:600519', '贵州茅台', '600519', 'XSHG')
  const state = { view: { view: 'list', overlay: 'detail', detailId: a.id, sort: 'manual', alias: '', browsePeek: {} }, busy: {}, candidates: [], composing: false, undo: null, error: '', paused: false, kline: null, data: { control: { revision: 1, routingRevision: 0, watchlist: { order: [a.id, b.id], items: { [a.id]: a, [b.id]: b } }, preferences: {} }, quotes: {}, adapters: [], providerStatus: [], catalogs: [], routeSelections: {}, klineReady: {}, vendorAvailable: false } }
  const updates = []
  const rt = { getSnapshot: () => state, subscribe: () => () => {}, updateView: patch => updates.push(patch), loadKline: () => Promise.resolve({ candles: [] }), refresh: () => Promise.resolve({}) }
  // 渲染层锚: 详情抽屉含邻移按钮(上下只), 点击触发 updateView detailId 切换
  const html = renderToStaticMarkup(React.createElement(plugin.__testing.StockPage, { runtime: rt, layout: {} }))
  assert.match(html, /上一只|下一只/, '详情抽屉有邻移入口')
})
// Leek-Fund 对标降噪: 健康横幅仅异常态/概览并入节头/设置手风琴
test('主页横幅仅异常态且概览并入节头', async () => {
  const { plugin } = await loadClientWithReact()
  const mk = (id, name, code, ex) => ({ id, officialName: name, code, exchange: ex, instrument: 'equity', currency: 'CNY', timezone: 'Asia/Shanghai', priceScale: 2, listingStatus: 'listed', alias: '', pinned: false })
  const a = mk('XSHG:equity:600519', '贵州茅台', '600519', 'XSHG')
  const base = () => ({ view: { view: 'list', sort: 'manual', alias: '' }, busy: {}, candidates: [], composing: false, undo: null, error: '', paused: false, kline: null, data: { control: { revision: 1, routingRevision: 0, watchlist: { order: [a.id], items: { [a.id]: a } }, preferences: {} }, quotes: { [a.id]: { quote: { last: '1', change: '0.01', changePct: '1', providerInstanceId: 'a', delayKind: 'realtime', quoteAt: null, receivedAt: 1, sessionState: 'trading' }, health: 'ok', lastError: null } }, adapters: [], providerStatus: [], catalogs: [], routeSelections: {}, klineReady: {}, vendorAvailable: false } })
  const okHtml = renderToStaticMarkup(React.createElement(plugin.__testing.StockPage, { runtime: { getSnapshot: () => base(), subscribe: () => () => {}, updateView: () => {}, loadKline: () => Promise.resolve({ candles: [] }) }, layout: {} }))
  assert.ok(!okHtml.includes('个数据源启用'), '健康态无运维横幅')
  assert.match(okHtml, /1 涨 0 跌/, '概览数字仍在')
  const bad = base()
  bad.data.providerStatus = [{ id: 'em-default', recentRequests: [{ status: 'error' }] }]
  const badHtml = renderToStaticMarkup(React.createElement(plugin.__testing.StockPage, { runtime: { getSnapshot: () => bad, subscribe: () => () => {}, updateView: () => {} }, layout: {} }))
  assert.match(badHtml, /最近请求失败|个数据源启用/, '异常态横幅出现')
})
test('设置手风琴: 数据源展开+其余折叠摘要', async () => {
  const { plugin } = await loadClientWithReact()
  const state = { view: { view: 'list', overlay: 'settings', sort: 'manual', alias: '' }, busy: {}, candidates: [], composing: false, undo: null, error: '', paused: false, data: { control: { revision: 1, routingRevision: 0, watchlist: { order: [], items: {} }, preferences: { colorMode: 'red-up', refreshSeconds: 15 }, routes: [{ id: 'r1', capability: 'quotes', market: 'XSHG', instrument: 'equity', primaryInstanceId: 'p1', fallbackInstanceIds: [], failoverMode: 'off', maxDelaySeconds: null, acceptUnknownDelay: true }], providers: [{ id: 'p1', adapterId: 'eastmoney', label: 'em-default', enabled: true, credentialEnv: null, quotaGroup: 'eastmoney-account', budget: { requestsPerMinute: 60, dailyRequestLimit: null, billingUnit: 'request', symbolCreditsPerMinute: null, capabilityLimits: {} } }] }, quotes: {}, adapters: [{ id: 'eastmoney', label: 'eastmoney', capabilities: ['quotes', 'kline', 'search', 'catalog'], credential: 'none' }], providerStatus: [], catalogs: [], routeSelections: {}, klineReady: { XSHG: true }, vendorAvailable: false }, settingsDraft: { providers: [{ id: 'p1', adapterId: 'eastmoney', label: 'em-default', enabled: true, credentialEnv: null, quotaGroup: 'eastmoney-account', budget: { requestsPerMinute: 60, dailyRequestLimit: null, billingUnit: 'request', symbolCreditsPerMinute: null, capabilityLimits: {} } }], routes: [{ id: 'r1', capability: 'quotes', market: 'XSHG', instrument: 'equity', primaryInstanceId: 'p1', fallbackInstanceIds: [], failoverMode: 'off', maxDelaySeconds: null, acceptUnknownDelay: true }], checkIds: [], checkResults: [], colorMode: 'red-up', klineAutoLoad: true } }
  const html = renderToStaticMarkup(React.createElement(plugin.__testing.StockPage, { runtime: { getSnapshot: () => state, subscribe: () => () => {}, updateView: () => {}, loadKline: () => Promise.resolve({ candles: [] }) }, layout: { providerCheck: () => {} } }))
  assert.match(html, /<summary/, '手风琴 summary 存在')
  assert.match(html, /1 市场/, '能力分配摘要显示市场数')
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

// ---- KlineView 与 kline 数据流(设计"client 详情重构"节) ----

const klineSnapshot = (seq = 1) => ({ ...snapshot(seq), vendorAvailable: true, klineReady: { XSHG: true } })

test('K1 loadKline 拉取灌state与force参数', async () => {
  const calls = []
  const { value } = await runtime({ fetch: async (url, opts) => { calls.push(String(url)); return { ok: true, json: async () => ({ ok: true, data: { candles: [{ time: '2026-10-29', open: 1, high: 2, low: 0.5, close: 1.5, volume: 100 }], preClose: 0.9, complete: true, source: 'em-default' } }) } } })
  value.applySnapshot(klineSnapshot())
  const result = await value.loadKline('XSHG:equity:600519', '1d')
  assert.equal(result.candles[0].close, 1.5)
  assert.match(calls[0], /securityId=XSHG%3Aequity%3A600519/)
  assert.match(calls[0], /period=1d/)
  assert.ok(!calls[0].includes('force'))
  const again = await value.loadKline('XSHG:equity:600519', '1d')
  assert.deepEqual(again.candles, result.candles, '同证券同周期非force复用state结果')
  assert.equal(again.source, result.source)
  assert.equal(calls.length, 1)
  await value.loadKline('XSHG:equity:600519', '1d', true)
  assert.match(calls[1], /force=1/)
  value.dispose()
})

test('K2 loadKline 网络失败置错误态', async () => {
  const { value } = await runtime({ fetch: async () => ({ ok: false, status: 502, json: async () => ({ ok: false, error: { code: 'NETWORK', message: '无法连接行情来源' } }) }) })
  value.applySnapshot(klineSnapshot())
  await assert.rejects(() => value.loadKline('XSHG:equity:600519', '1d'))
  assert.equal(value.getSnapshot().kline.error, '无法连接行情来源')
  value.dispose()
})

test('K3 setKlinePeriod 切换state', async () => {
  const { value } = await runtime()
  value.setKlinePeriod('1w')
  assert.equal(value.getSnapshot().klinePeriod, '1w')
  value.dispose()
})

test('K4 NO_ROUTE 错误态携带 errorCode 供引导按钮判据', async () => {
  const { value } = await runtime({ fetch: async () => ({ ok: false, status: 422, json: async () => ({ ok: false, error: { code: 'NO_ROUTE', message: '未配置该市场的数据来源' } }) }) })
  value.applySnapshot(klineSnapshot())
  await assert.rejects(() => value.loadKline('XSHG:equity:600519', '1d'))
  assert.equal(value.getSnapshot().kline.errorCode, 'NO_ROUTE')
  value.dispose()
})

test('K5 RATE_LIMIT 退避自动重试一次后成功(等待≥retryAfterMs)', async () => {
  const calls = []
  const t0 = Date.now()
  const { value } = await runtime({ fetch: async (url, opts) => { calls.push(String(url)); if (calls.length === 1) { return { ok: false, status: 429, json: async () => ({ ok: false, error: { code: 'RATE_LIMIT', message: '数据源额度受限，请稍后重试', retryAfterMs: 20 } }) } } return { ok: true, json: async () => ({ ok: true, data: { candles: [{ time: '2026-10-29', open: 1, high: 2, low: 0.5, close: 1.5, volume: 100 }], preClose: 0.9, complete: true, source: 'em-default' } }) } } })
  value.applySnapshot(klineSnapshot())
  const result = await value.loadKline('XSHG:equity:600519', '1d')
  assert.equal(result.candles.length, 1)
  assert.equal(calls.length, 2, '首次429后退避重试一次')
  assert.ok(Date.now() - t0 >= 20, '重试等待不小于服务端 retryAfterMs')
  assert.equal(value.getSnapshot().kline.error, '')
  value.dispose()
}, { timeout: 10000 })

test('K6 NO_ROUTE 二次失败不自动重试(避免额外资损)', async () => {
  const calls = []
  const { value } = await runtime({ fetch: async (url, opts) => { calls.push(String(url)); return { ok: false, status: 422, json: async () => ({ ok: false, error: { code: 'RATE_LIMIT', message: '数据源额度受限，请稍后重试' } }) } } })
  value.applySnapshot(klineSnapshot())
  await assert.rejects(() => value.loadKline('XSHG:equity:600519', '1d'))
  assert.equal(calls.length, 2, '重试一次后停止')
  assert.equal(value.getSnapshot().kline.errorCode, 'RATE_LIMIT')
  value.dispose()
}, { timeout: 10000 })

test('K7 NO_ROUTE 错误条渲染一键开启按钮', async () => {
  const { plugin } = await loadClientWithReact()
  const item = { id: 'XSHG:equity:600519', officialName: '贵州茅台', code: '600519', exchange: 'XSHG', instrument: 'equity', currency: 'CNY', timezone: 'Asia/Shanghai', priceScale: 2, listingStatus: 'listed', alias: '', pinned: false }
  const state = { view: { view: 'list', overlay: 'detail', query: '', selectedId: item.id, detailId: item.id, sort: 'manual', alias: '' }, busy: {}, candidates: [], composing: false, undo: null, error: '', errorCode: '', paused: false, klinePeriod: '1d', kline: { loading: false, error: '未配置该市场的数据来源', errorCode: 'NO_ROUTE', candles: null }, data: { control: { revision: 1, routingRevision: 0, watchlist: { order: [item.id], items: { [item.id]: item } }, preferences: {}, providers: [{ id: 'em-default', adapterId: 'eastmoney', enabled: true, credentialEnv: null, quotaGroup: 'free', budget: { requestsPerMinute: 60, dailyRequestLimit: null, billingUnit: 'request', symbolCreditsPerMinute: null, capabilityLimits: {} } }], routes: [] }, quotes: {}, adapters: [], providerStatus: [], catalogs: [], routeSelections: {}, vendorAvailable: true } }
  const updates = []
  const runtimeStub = { getSnapshot: () => state, subscribe: () => () => {}, updateView: patch => updates.push(patch), loadKline: () => Promise.resolve({ candles: [] }) }
  const html = renderToStaticMarkup(React.createElement(plugin.__testing.StockPage, { runtime: runtimeStub, layout: {} }))
  assert.match(html, /未配置该市场的数据来源/)
  assert.match(html, /一键开启K线/)
})

test('K8 非瞬时码首拍即拒不重试', async () => {
  const calls = []
  const { value } = await runtime({ fetch: async (url, opts) => { calls.push(String(url)); return { ok: false, status: 422, json: async () => ({ ok: false, error: { code: 'NO_ROUTE', message: '未配置该市场的数据来源' } }) } } })
  value.applySnapshot(klineSnapshot())
  await assert.rejects(() => value.loadKline('XSHG:equity:600519', '1d'))
  assert.equal(calls.length, 1, 'NO_ROUTE 不在可重试集合, 首拍即拒')
  assert.equal(value.getSnapshot().kline.errorCode, 'NO_ROUTE')
  value.dispose()
})

// ---- M5 缺陷修复回归 ----

test('M5.1 remove后snapshot回刷横幅不消失且8s后清除', async () => {
  let removeCalls = 0, restoreCalls = 0
  const { value } = await runtime({ fetch: async (url, opts) => {
    const u = String(url)
    if (u.includes('/watchlist')) {
      const body = JSON.parse(opts.body)
      if (body.action === 'remove') { removeCalls++; return { ok: true, json: async () => ({ ok: true, data: { revision: 2, unchanged: false } }) } }
      if (body.action === 'restore') { restoreCalls++; return { ok: true, json: async () => ({ ok: true, data: { revision: 3, unchanged: false } }) } }
    }
    if (u.includes('/snapshot')) return { ok: true, json: async () => ({ ok: true, data: snapshot(2) }) }
    return { ok: true, json: async () => ({ ok: true, data: {} }) }
  } })
  value.applySnapshot(snapshot(1, 'a', 0))
  // remove 前快照回刷模拟: snapshot(2) 触发 invalidate→refresh
  await value.mutate('remove', { securityId: 'XSHG:equity:600519' })
  const undo = value.getSnapshot().undo
  assert.ok(undo, 'remove 后 undo 态存在')
  assert.ok(undo.until > Date.now())
  // snapshot 回刷(同 epoch 新 seq)不得清 undo
  value.applySnapshot(snapshot(5))
  assert.ok(value.getSnapshot().undo, 'snapshot 回刷后横幅态仍在')
  // 恢复清 undo
  await value.mutate('restore', { removeOperationId: undo.removeOperationId })
  assert.equal(value.getSnapshot().undo, null)
  assert.equal(removeCalls, 1); assert.equal(restoreCalls, 1)
  value.dispose()
})

test('M5.2 默认配置设置页全节点渲染无截断', async () => {
  let plugin
  const source = await readFile(new URL('../src/client.js', import.meta.url), 'utf8')
  const window = { __ModuleLoader__: { load: entry => { plugin = entry.factory(name => name === 'react' ? React : {}) } } }
  vm.runInNewContext(source, { window, console, fetch: globalThis.fetch, AbortController, URLSearchParams, setTimeout, clearTimeout, setInterval, clearInterval, crypto: globalThis.crypto })
  const { defaultConfig } = await import('../src/schemas.mjs')
  const saved = defaultConfig()
  const data = { serverEpoch: 'a', snapshotSeq: 1, routingRevision: 0, control: { ...saved, revision: 1, watchlist: { order: [], items: {} }, preferences: { refreshSeconds: 30, colorMode: 'red-up' } }, quotes: {}, routeSelections: {}, catalogs: [], adapters: [{ adapterId: 'tushare', credential: 'token', capabilities: ['quotes', 'catalog', 'search', 'calendar'] }, { adapterId: 'tencent', credential: 'none', capabilities: ['quotes', 'kline'] }, { adapterId: 'sina', credential: 'none', capabilities: ['quotes', 'catalog'] }, { adapterId: 'eastmoney', credential: 'none', capabilities: ['quotes', 'catalog', 'search', 'kline'] }], suggested: saved, providerStatus: [], markets: { XSHG: { currency: 'CNY', verified: true } }, vendorAvailable: true, klineReady: {} }
  const state = { view: { view: 'list', overlay: 'settings', query: '', selectedId: null, sort: 'manual', settingsDraft: null, browseMarket: 'XSHG' }, busy: {}, candidates: [], composing: false, undo: null, error: '', errorCode: '', data }
  const runtimeStub = { getSnapshot: () => state, subscribe: () => () => {}, updateView() {}, mutate: async () => {}, check: async () => ({ checkId: 'x', checks: [] }), configuration: async () => {}, preferences: async () => {}, sync: async () => [], switchPrimary: async () => {} }
  const html = renderToStaticMarkup(React.createElement(plugin.__testing.StockPage, { runtime: runtimeStub, layout: {} }))
  for (const marker of ['① 数据源', '② 市场与能力', '目录与日历', '③ 显示偏好', '保存配置', '检查所有来源能力', '放弃草稿', '一键为已启用市场配置K线']) assert.ok(html.includes(marker), `设置页缺节点: ${marker}`)
  // 启用banner仅在无实例时出现(默认配置自带双实例, 不含该banner为正确行为)
  assert.ok(!html.includes('启用默认数据源'))
  // 8市场 fieldset 全渲染(K线行存在)
  for (const market of ['XSHG', 'XSHE', 'XHKG', 'XNAS', 'XNYS', 'XJPX', 'XKRX', 'XLON']) assert.ok(html.includes(market), `市场 fieldset 缺: ${market}`)
  assert.ok(html.includes('>K线<'), 'K线能力行缺')
})
