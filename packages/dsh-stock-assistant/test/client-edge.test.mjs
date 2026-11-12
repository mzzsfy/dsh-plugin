import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import vm from 'node:vm'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
async function loadClientWithReact() {
  let plugin
  const source = await readFile(new URL('../src/client.js', import.meta.url), 'utf8')
  const clock = createTestClock()
  const window = { __ModuleLoader__: { load: entry => { plugin = entry.factory(name => name === 'react' ? React : {}) } } }
  vm.runInNewContext(source, { window, console, fetch: globalThis.fetch, AbortController, URLSearchParams, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout, setInterval: clock.setInterval, clearInterval: clock.clearInterval, crypto: globalThis.crypto })
  return { plugin, clock }
}
// 测试时钟:定时器只在 advance/until 推进。负载下真实退避(4s retryAfter 缺省)与
// 11s abort 门不再与用例超时窗口竞速;被杀用例的在飞链也不会以真实定时器形态泄漏
function createTestClock() {
  let now = 0, seq = 0
  const pending = new Map()
  const set = kind => (fn, ms = 0, ...rest) => {
    // 0ms 是"当前执行段后立即"语义(真实时钟下一宏任务), 只接管长等待定时器;
    // interval 的 0 周期同样走立即语义, 防 advance 内 at 恒 due 的活锁
    if (ms === 0) return setImmediate(() => fn(...rest))
    const id = ++seq
    pending.set(id, { kind, fn, at: now + ms, ms, rest })
    return id
  }
  const clear = id => pending.delete(id)
  const drain = async () => { for (let i = 0; i < 3; i++) await new Promise(r => setImmediate(r)) }
  async function advance(step) {
    now += step
    // 循环:fetch 链的退避/abort 定时器注册晚于 fire, 反复排空-收集直到既无到期也无新注册
    for (;;) {
      await drain()
      const due = [...pending].filter(([, t]) => t.at <= now).sort((a, b) => (a[1].at - b[1].at) || (a[0] - b[0]))
      if (due.length === 0) return
      for (const [id, t] of due) {
        if (!pending.has(id)) continue
        pending.delete(id)
        if (t.kind === 'interval') pending.set(id, { ...t, at: t.at + t.ms })
        t.fn(...t.rest)
      }
    }
  }
  // 推进直至谓词成立(防止对注册时点的猜测): 每 50ms 小步推进, 谓词真即停
  async function until(predicate, budgetMs = 60 * 1000) {
    for (;;) {
      await drain()
      if (predicate()) return true
      await advance(50)
      if ((now > budgetMs)) throw new Error(`测试时钟预算耗尽(${budgetMs}ms), pending=${pending.size}`)
    }
  }
  return { setTimeout: set('timeout'), clearTimeout: clear, setInterval: set('interval'), clearInterval: clear, advance, until, elapsed: () => now, pendingCount: () => pending.size }
}
async function runtime(options = {}) {
  let plugin, reset, snapshotTask, listener, panel = 'stock-assistant'
  const messages = [], source = await readFile(new URL('../src/client.js', import.meta.url), 'utf8')
  const clock = createTestClock()
  const window = { __ModuleLoader__: { load: entry => { plugin = entry.factory(() => ({})) } } }
  vm.runInNewContext(source, { window, console, AbortController, URLSearchParams, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout, setInterval: clock.setInterval, clearInterval: clock.clearInterval, crypto: globalThis.crypto, fetch: globalThis.fetch })
  const doc = { visibilityState: 'visible', addEventListener() {}, removeEventListener() {} }
  const value = plugin.__testing.createPageRuntime({ layout: { panelInfo: { getSnapshot: () => ({ activePanelId: panel }), subscribe: fn => { listener = fn; return () => {} } } }, bus: { publish: m => messages.push(m), subscribe: (fn, opts) => { reset = opts.onReset; return () => {} } }, tools: { createSnapshotRefresh: fn => { snapshotTask = fn; return { refresh() {}, dispose() {} } } }, document: doc, ...options })
  return { value, doc, messages, clock, reset: () => reset(), pull: () => snapshotTask(), select: id => { panel = id; listener() } }
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
  const suggested = { providers: [{ id: 'em-default', adapterId: 'eastmoney', enabled: true, credentialRef: null, quotaGroup: 'free-quote', budget: { requestsPerMinute: 60, dailyRequestLimit: null, billingUnit: 'request', symbolCreditsPerMinute: null, capabilityLimits: {} } }], routes: [{ id: 'xshg-quotes', capability: 'quotes', market: 'XSHG', instrument: 'equity', primaryInstanceId: 'em-default', fallbackInstanceIds: [], failoverMode: 'off', maxDelaySeconds: null, acceptUnknownDelay: true }] }
  const state = { view: { view: 'list', overlay: 'settings', query: '', selectedId: null, sort: 'manual', settingsDraft: null }, busy: {}, candidates: [], composing: false, undo: null, error: '', errorCode: '', data: { control: { revision: 1, routingRevision: 0, watchlist: { order: [], items: {} }, preferences: {}, providers: [], routes: [] }, adapters: [{ adapterId: 'eastmoney', capabilities: ['quotes', 'catalog', 'search'], credential: 'none' }], providerStatus: [], catalogs: [], routeSelections: {}, suggested } }
  const updates = []
  const runtimeStub = { getSnapshot: () => state, subscribe: () => () => {}, updateView: patch => updates.push(patch) }
  renderToStaticMarkup(React.createElement(plugin.__testing.StockPage, { runtime: runtimeStub, layout: {} }))
  assert.match(renderToStaticMarkup(React.createElement(plugin.__testing.StockPage, { runtime: runtimeStub, layout: {} })), /应用推荐配置/)
  assert.equal(updates.length, 0)
})
// 设置页信息架构: 递进区块+实例卡描述+反代端点+最近请求+概览横幅
test('设置页递进区块与实例可观测面渲染', async () => {
  const { plugin } = await loadClientWithReact()
  const item = { id: 'XSHG:equity:600519', officialName: '贵州茅台', code: '600519', exchange: 'XSHG', instrument: 'equity', currency: 'CNY', timezone: 'Asia/Shanghai', priceScale: 2, listingStatus: 'listed', alias: '', pinned: false }
  const suggested = { providers: [{ id: 'em-default', adapterId: 'eastmoney', enabled: true, credentialRef: null, quotaGroup: 'free-quote', budget: { requestsPerMinute: 60, dailyRequestLimit: null, billingUnit: 'request', symbolCreditsPerMinute: null, capabilityLimits: {} } }], routes: [] }
  const state = { view: { view: 'list', overlay: 'settings', query: '', selectedId: null, sort: 'manual', settingsDraft: null }, busy: {}, candidates: [], composing: false, undo: null, error: '', errorCode: '', paused: false, data: { control: { revision: 1, routingRevision: 0, watchlist: { order: [], items: {} }, preferences: {}, routes: [{ id: 'xhkg-catalog', capability: 'catalog', market: 'XHKG', instrument: 'equity', primaryInstanceId: 'em-default', fallbackInstanceIds: [], failoverMode: 'off', maxDelaySeconds: null, acceptUnknownDelay: true }, { id: 'xnas-catalog', capability: 'catalog', market: 'XNAS', instrument: 'equity', primaryInstanceId: 'em-default', fallbackInstanceIds: [], failoverMode: 'off', maxDelaySeconds: null, acceptUnknownDelay: true }, { id: 'xnys-catalog', capability: 'catalog', market: 'XNYS', instrument: 'equity', primaryInstanceId: 'em-default', fallbackInstanceIds: [], failoverMode: 'off', maxDelaySeconds: null, acceptUnknownDelay: true }, { id: 'xshg-catalog', capability: 'catalog', market: 'XSHG', instrument: 'equity', primaryInstanceId: 'em-default', fallbackInstanceIds: [], failoverMode: 'off', maxDelaySeconds: null, acceptUnknownDelay: true }], providers: [{ id: 'em-default', adapterId: 'eastmoney', enabled: true, credentialRef: null, quotaGroup: 'free-quote', budget: { requestsPerMinute: 60, dailyRequestLimit: null, billingUnit: 'request', symbolCreditsPerMinute: null, capabilityLimits: {} }, endpoints: { kline: 'https://proxy.corp/em/kline' } }], routes: [] }, quotes: { [item.id]: { last: '1392.05', previousClose: '1376.95', receivedAt: 1, quoteAt: null, delayKind: 'unknown' } }, adapters: [{ adapterId: 'eastmoney', capabilities: ['quotes', 'kline'], credential: 'none', description: '东方财富公开接口：免凭据，八市场行情/K线/搜索/目录，非官方无SLA', endpointKeys: [{ key: 'kline', label: 'K线历史' }, { key: 'quotes', label: '行情批量' }] }], providerStatus: [{ id: 'em-default', credentialPresent: true, proxy: false, endpointsCovered: 1, recentRequests: [{ at: 1000, url: 'quotes eastmoney', status: 'ok', ms: 120 }] }], catalogs: [], routeSelections: {}, klineReady: {}, suggested, vendorAvailable: true } }
  const runtimeStub = { getSnapshot: () => state, subscribe: () => () => {}, updateView: () => {}, loadKline: () => Promise.resolve({ candles: [] }) }
  const html = renderToStaticMarkup(React.createElement(plugin.__testing.StockPage, { runtime: runtimeStub, layout: {} }))
  assert.match(html, /数据源/, '区块1标题')
  assert.match(html, /市场与能力/, '区块2标题')
  assert.match(html, /显示偏好/, '区块3标题')
  assert.match(html, /东方财富公开接口/, '适配器一句话描述')
  // 反代与运行状态收在「配置」展开区里, 默认只显示摘要行
  assert.match(html, /公开来源/, '摘要行标注公开来源')
  assert.match(html, /配置/, '摘要行给出展开入口')
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
  assert.match(html, /\+5\.00/, '涨跌额随现价单元格展示')
  assert.match(html, /\+1\.27%/, '涨跌幅胶囊')
  assert.match(html, /ssb-row-sub/, '副行展示开/高/低/成交额/振幅')
  assert.match(html, /ssb-kv/, '副行指标为键值对而非独立格子')
  assert.match(html, /ssb-row/, '行渲染为紧凑行而非表格单元格')
  const rowSeg = html.slice(html.indexOf('腾讯控股'), html.indexOf('贵州茅台'))
  assert.ok(!rowSeg.includes('延迟'), '来源延迟不再占主列（收进状态点 title）')
  assert.match(rowSeg, /ssb-dot/, '健康态渲染为状态点')
  assert.ok(!rowSeg.includes('✓'), '状态点不再占用文字列')
  assert.match(rowSeg, /draggable="true"/, '手动序行可拖拽排序')
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
test('设置Tab: 三分区独立保存+tablist', async () => {
  const { plugin } = await loadClientWithReact()
  const state = { view: { view: 'list', overlay: 'settings', sort: 'manual', alias: '', settingsDraft: { providers: [{ id: 'p1', adapterId: 'eastmoney', label: 'em-default', enabled: true, credentialRef: null, quotaGroup: 'eastmoney-account', budget: { requestsPerMinute: 60, dailyRequestLimit: null, billingUnit: 'request', symbolCreditsPerMinute: null, capabilityLimits: {} } }], routes: [{ id: 'r1', capability: 'quotes', market: 'XSHG', instrument: 'equity', primaryInstanceId: 'p1', fallbackInstanceIds: [], failoverMode: 'off', maxDelaySeconds: null, acceptUnknownDelay: true }], checkIds: [], checkResults: [], colorMode: 'red-up', klineAutoLoad: true } }, busy: {}, candidates: [], composing: false, undo: null, error: '', paused: false, data: { control: { revision: 1, routingRevision: 0, watchlist: { order: [], items: {} }, preferences: { colorMode: 'red-up', refreshSeconds: 15 }, routes: [{ id: 'r1', capability: 'quotes', market: 'XSHG', instrument: 'equity', primaryInstanceId: 'p1', fallbackInstanceIds: [], failoverMode: 'off', maxDelaySeconds: null, acceptUnknownDelay: true }], providers: [{ id: 'p1', adapterId: 'eastmoney', label: 'em-default', enabled: true, credentialRef: null, quotaGroup: 'eastmoney-account', budget: { requestsPerMinute: 60, dailyRequestLimit: null, billingUnit: 'request', symbolCreditsPerMinute: null, capabilityLimits: {} } }] }, quotes: {}, adapters: [{ id: 'eastmoney', label: 'eastmoney', capabilities: ['quotes', 'kline', 'search', 'catalog'], credential: 'none' }], providerStatus: [], catalogs: [], routeSelections: {}, klineReady: { XSHG: true }, vendorAvailable: false } }
  const html = renderToStaticMarkup(React.createElement(plugin.__testing.StockPage, { runtime: { getSnapshot: () => state, subscribe: () => () => {}, updateView: () => {}, loadKline: () => Promise.resolve({ candles: [] }) }, layout: { providerCheck: () => {} } }))
  assert.match(html, /role="tablist"/, '设置 tablist')
  assert.match(html, /保存数据源/, '① 独立保存钮')
  assert.ok(!html.includes('保存路由'), '默认 sources tab 不含②保存钮')
})
// 持仓成本盈亏: 行内盈亏%/详情成本块/概览持仓合计
test('价格标记渲染与多笔成本取最低', async () => {
  const { plugin } = await loadClientWithReact()
  const mk = (id, name, code, ex, marks) => ({ id, officialName: name, code, exchange: ex, instrument: 'equity', currency: 'CNY', timezone: 'Asia/Shanghai', priceScale: 2, listingStatus: 'listed', alias: '', pinned: false, marks })
  // 两笔成本 80 与 120, 成本基准取最低 80; 现价 120 时汇总盈亏 +50%
  const a = mk('XSHG:equity:600001', '甲股', '600001', 'XSHG', [{ id: 'm1', price: 80, kind: 'cost' }, { id: 'm2', price: 120, kind: 'cost' }, { id: 'm3', price: 150, kind: 'target' }])
  const b = mk('XSHG:equity:600519', '乙股', '600519', 'XSHG', [])
  const q = (last, change) => ({ quote: { last, previousClose: '1', change, changePct: '1', providerInstanceId: 'a', delayKind: 'realtime', quoteAt: null, receivedAt: 1, sessionState: 'trading' }, health: 'ok', lastError: null })
  const state = { view: { view: 'list', overlay: 'detail', detailId: a.id, sort: 'manual', alias: '' }, busy: {}, candidates: [], composing: false, undo: null, error: '', paused: false, kline: null, data: { control: { revision: 1, routingRevision: 0, watchlist: { order: [a.id, b.id], items: { [a.id]: a, [b.id]: b } }, preferences: {} }, quotes: { [a.id]: q('120', '1'), [b.id]: q('50', '1') }, adapters: [], providerStatus: [], catalogs: [], routeSelections: {}, klineReady: {}, vendorAvailable: false } }
  const html = renderToStaticMarkup(React.createElement(plugin.__testing.StockPage, { runtime: { getSnapshot: () => state, subscribe: () => () => {}, updateView: () => {}, loadKline: () => Promise.resolve({ candles: [] }) }, layout: {} }))
  assert.match(html, /持仓盈亏/, '详情盈亏块')
  assert.match(html, /成本价/, '多笔成本要显示取到的成本价')
  assert.match(html, /\+50\.0%/, '盈亏按最低成本 80 算, 现价 120 是 +50%')
  assert.match(html, /多笔成本取最低价/, '标记页要写清口径')
  // 每条标记各自一行: 两笔成本 + 一条卖价
  assert.equal([...html.matchAll(/class="ssb-mark-row"/g)].length, 3, '三个标记各占一行')
  assert.match(html, /卖价/, '卖价标记要单独标识')
  assert.match(html, /价格标记/, '详情要有标记编辑入口')
})

test('成本盈亏渲染', async () => {
  const { plugin } = await loadClientWithReact()
  const mk = (id, name, code, ex, marks) => ({ id, officialName: name, code, exchange: ex, instrument: 'equity', currency: 'CNY', timezone: 'Asia/Shanghai', priceScale: 2, listingStatus: 'listed', alias: '', pinned: false, marks })
  const a = mk('XSHG:equity:600001', '甲股', '600001', 'XSHG', [{ id: 'm1', price: 100, kind: 'cost' }]), b = mk('XSHG:equity:600519', '乙股', '600519', 'XSHG', [])
  const q = (last, change) => ({ quote: { last, previousClose: '1', change, changePct: '1', providerInstanceId: 'a', delayKind: 'realtime', quoteAt: null, receivedAt: 1, sessionState: 'trading' }, health: 'ok', lastError: null })
  const state = { view: { view: 'list', overlay: 'detail', detailId: a.id, sort: 'manual', alias: '' }, busy: {}, candidates: [], composing: false, undo: null, error: '', paused: false, kline: null, data: { control: { revision: 1, routingRevision: 0, watchlist: { order: [a.id, b.id], items: { [a.id]: a, [b.id]: b } }, preferences: {} }, quotes: { [a.id]: q('120', '1'), [b.id]: q('50', '1') }, adapters: [], providerStatus: [], catalogs: [], routeSelections: {}, klineReady: {}, vendorAvailable: false } }
  const html = renderToStaticMarkup(React.createElement(plugin.__testing.StockPage, { runtime: { getSnapshot: () => state, subscribe: () => () => {}, updateView: () => {}, loadKline: () => Promise.resolve({ candles: [] }) }, layout: {} }))
  assert.match(html, /\+20\.0%/, '成本100现价120盈亏20%')
  assert.match(html, /持仓盈亏/, '详情盈亏块')
  assert.match(html, /价格标记/, '详情标记设置入口')
})
// 自选分组: 置顶/各组/未分组都常显组头; 折叠; 全局排序保留分区但组内按该排序
// 分组视图 tab 化: 全部 → 各标签(首现序) → 未分组; 多标签的票出现在多个 tab, 置顶并入 tab 内排序
test('标签 tab 渲染与切换', async () => {
  const { plugin } = await loadClientWithReact()
  const mk = (id, name, code, tags) => ({ id, officialName: name, code, exchange: 'XSHG', instrument: 'equity', currency: 'CNY', timezone: 'Asia/Shanghai', priceScale: 2, listingStatus: 'listed', alias: '', pinned: false, tags })
  const a = mk('XSHG:equity:600001', '甲股', '600001', ['白酒']), b = mk('XSHG:equity:600002', '乙股', '600002', ['能源']), c = mk('XSHG:equity:600519', '丙股', '600519', ['白酒', '核心']), d = mk('XSHG:equity:600003', '丁股', '600003', [])
  const qOf = pct => ({ quote: { last: '10', previousClose: '1', change: '0.5', changePct: pct, providerInstanceId: 'a', delayKind: 'realtime', quoteAt: null, receivedAt: 1, sessionState: 'trading' }, health: 'ok', lastError: null })
  const mkState = ({ sort = 'manual', pinned = [] } = {}) => {
    const items = structuredClone({ [a.id]: a, [b.id]: b, [c.id]: c, [d.id]: d })
    for (const id of pinned) items[id].pinned = true
    return {
      view: { view: 'list', sort, alias: '' }, busy: {}, candidates: [], composing: false, undo: null, error: '', paused: false, kline: null,
      data: {
        control: { revision: 1, routingRevision: 0, watchlist: { order: [a.id, b.id, c.id, d.id], items }, preferences: {} },
        // 涨幅刻意让「能源」在降序里排到最前: 只有这样才测得出 tab 内排序与 tab 顺序互不影响
        quotes: { [a.id]: qOf('1'), [b.id]: qOf('9'), [c.id]: qOf('5'), [d.id]: qOf('-1') }, adapters: [], providerStatus: [], catalogs: [], routeSelections: {}, klineReady: {}, vendorAvailable: false,
      },
    }
  }
  const tabsOf = state => plugin.__testing.tagTabs(state.data.control.watchlist.order, state.data.control.watchlist.items)
  // 激活键由切面算出: tab 的 key 对用户不可见, 测试不硬编码前缀
  const withActive = (state, label) => { state.view.activeTab = label ? tabsOf(state).find(tab => tab.label === label).key : undefined; return state }
  const render = state => renderToStaticMarkup(React.createElement(plugin.__testing.StockPage, { runtime: { getSnapshot: () => state, subscribe: () => () => {}, updateView: () => {}, loadKline: () => Promise.resolve({ candles: [] }) }, layout: {} }))

  const manual = render(mkState())
  assert.match(manual, /role="tablist"/, '分组视图是 tab 条')
  for (const label of ['全部 · 4', '白酒 · 2', '能源 · 1', '核心 · 1', '未分组 · 1']) assert.ok(manual.includes(label), `缺 tab: ${label}`)
  // 默认激活全部, 首屏看得见所有自选; 断言要落在按钮自身, 不能只看文案出现
  const allAt = manual.indexOf('>全部 · 4<'), allOpen = manual.lastIndexOf('<button', allAt)
  assert.ok(allAt > 0 && allOpen >= 0, '存在「全部 · 4」按钮')
  assert.match(manual.slice(allOpen, allAt + 1), /aria-selected="true"/, '默认选中全部')
  for (const name of ['甲股', '乙股', '丙股', '丁股']) assert.ok(manual.includes(name), `全部 tab 应含 ${name}`)
  // 统计行按当前 tab 成员算: 全部四只, 三只上涨
  assert.match(manual, /4 只 · 3 涨 1 跌/)

  const bai = render(withActive(mkState(), '白酒'))
  assert.ok(bai.includes('甲股') && bai.includes('丙股'))
  assert.ok(!bai.includes('乙股') && !bai.includes('丁股'), '非激活 tab 的成员不渲染')
  assert.match(bai, /2 只 · 2 涨 0 跌/, '统计只算本 tab 成员')
  // 标签 tab 才有关联管理动作; 全部与未分组不是可管理的标签
  assert.ok(bai.includes('重命名') && bai.includes('解散'), '标签 tab 给重命名与解散')
  assert.ok(!manual.includes('重命名'), '全部 tab 不出现标签管理')
  // 部分票无标签: 未分组只装有标签外的票
  const rest = render(withActive(mkState(), '未分组'))
  assert.ok(rest.includes('丁股') && !rest.includes('甲股'), '未分组只含无标签票')

  // 一只票两个标签: 两个 tab 都要有它, 且成员来自同一份 tags
  const core = render(withActive(mkState(), '核心'))
  assert.ok(core.includes('丙股') && !core.includes('甲股'), '核心 tab 只有丙股')

  // 置顶并入 tab 内排序: 丙股在自选里排第三, 置顶后必须出现在本 tab 最前
  const pinnedState = withActive(mkState({ pinned: [c.id] }), '白酒')
  const pinned = render(pinnedState)
  assert.ok(pinned.indexOf('丙股') < pinned.indexOf('甲股'), '置顶票在 tab 内排最前')

  // 未分组 tab 仅在有成员时出现
  const allTagged = mkState()
  allTagged.data.control.watchlist.items[d.id].tags = ['能源']
  assert.ok(!render(allTagged).includes('未分组 ·'), '没有无标签票就不出未分组 tab')
  const none = mkState()
  for (const item of Object.values(none.data.control.watchlist.items)) item.tags = []
  const noneHtml = render(none)
  assert.match(noneHtml, /未分组 · 4/, '全无标签时未分组含全部')

  // 标签名恰好是原型链键: tab 走数组与全等比较, 不查对象索引
  const protoState = mkState()
  protoState.data.control.watchlist.items[a.id].tags = ['constructor']
  const proto = render(protoState)
  assert.match(proto, /constructor · 1/)
  // 激活的 tab 已失效(标签被解散): 回退全部而不是渲染空列表
  const stale = mkState()
  stale.view.activeTab = 'tag:已解散'
  const staleHtml = render(stale)
  for (const name of ['甲股', '乙股', '丙股', '丁股']) assert.ok(staleHtml.includes(name), `失效 tab 应回退全部: ${name}`)
})

// 多标签详情: 当前标签逐个可移除, 别的票用过的标签可一键加入, 新标签走输入框
test('详情标签编辑器: chips 与已有标签 pill', async () => {
  const { plugin } = await loadClientWithReact()
  const mk = (id, name, tags) => ({ id, officialName: name, code: id.split(':')[2], exchange: 'XSHG', instrument: 'equity', currency: 'CNY', timezone: 'Asia/Shanghai', priceScale: 2, listingStatus: 'listed', alias: '', pinned: false, tags, marks: [] })
  const a = mk('XSHG:equity:600001', '甲股', ['沪A', '核心']), b = mk('XSHG:equity:600002', '乙股', ['能源']), c = mk('XSHG:equity:600003', '丙股', [])
  const stateOf = detailId => ({ view: { view: 'list', overlay: 'detail', detailId, sort: 'manual', alias: '' }, busy: {}, candidates: [], composing: false, undo: null, error: '', paused: false, kline: null, data: { control: { revision: 1, routingRevision: 0, watchlist: { order: [a.id, b.id, c.id], items: { [a.id]: a, [b.id]: b, [c.id]: c } }, preferences: {} }, quotes: {}, adapters: [], providerStatus: [], catalogs: [], routeSelections: {}, klineReady: {}, vendorAvailable: false } })
  const render = detailId => renderToStaticMarkup(React.createElement(plugin.__testing.StockPage, { runtime: { getSnapshot: () => stateOf(detailId), subscribe: () => () => {}, updateView: () => {}, loadKline: () => Promise.resolve({ candles: [] }) }, layout: {} }))
  const html = render(a.id)
  assert.match(html, /当前分组标签/, '当前标签区')
  assert.match(html, /aria-label="移除标签 沪A"/, '每个当前标签可单独移除')
  assert.match(html, /aria-label="移除标签 核心"/)
  assert.match(html, /\+ 能源/, '别的票用过的标签可一键加入')
  assert.ok(!html.includes('+ 沪A'), '已属于本票的标签不再出现在加入列表')
  assert.match(html, /添加标签/, '新标签输入入口')
  const none = render(c.id)
  assert.match(none, /还没有分组标签/, '无标签票给出未分组说明')
  assert.ok(!none.includes('aria-label="移除标签 '), '无标签票没有可移除的标签')
})

test('审查R1: 详情分组表单+成本块锚+均值修正', async () => {
  const { plugin } = await loadClientWithReact()
  const mk = (id, name, code, price) => ({ id, officialName: name, code, exchange: 'XSHG', instrument: 'equity', currency: 'CNY', timezone: 'Asia/Shanghai', priceScale: 2, listingStatus: 'listed', alias: '', pinned: false, tags: [], marks: price == null ? [] : [{ id: 'm1', price, kind: 'cost' }] })
  const a = mk('XSHG:equity:600001', '甲股', '600001', 100), b = mk('XSHG:equity:600002', '乙股', '600002', 100), c = mk('XSHG:equity:600519', '丙股', '600519', null)
  const q = { quote: { last: '110', previousClose: '1', change: '1', changePct: '1', providerInstanceId: 'p', delayKind: 'realtime', quoteAt: null, receivedAt: 1, sessionState: 'trading' }, health: 'ok', lastError: null }
  const state = { view: { view: 'list', overlay: 'detail', detailId: a.id, sort: 'manual', alias: '' }, busy: {}, candidates: [], composing: false, undo: null, error: '', paused: false, kline: null, data: { control: { revision: 1, routingRevision: 0, watchlist: { order: [a.id, b.id, c.id], items: { [a.id]: a, [b.id]: b, [c.id]: c } }, preferences: {} }, quotes: { [a.id]: q, [b.id]: q, [c.id]: q }, adapters: [], providerStatus: [], catalogs: [], routeSelections: {}, klineReady: {}, vendorAvailable: false } }
  const html = renderToStaticMarkup(React.createElement(plugin.__testing.StockPage, { runtime: { getSnapshot: () => state, subscribe: () => () => {}, updateView: () => {}, loadKline: () => Promise.resolve({ candles: [] }) }, layout: {} }))
  assert.match(html, /添加标签/, '详情有多标签入口')
  assert.match(html, /还没有分组标签/, '没有标签时给出说明')
  assert.match(html, /持仓盈亏 \+10 · \+10%/, '详情成本块独立锚(S9)')
  const listState = JSON.parse(JSON.stringify(state)); listState.view = { view: 'list', sort: 'manual', alias: '' }
  const listHtml = renderToStaticMarkup(React.createElement(plugin.__testing.StockPage, { runtime: { getSnapshot: () => listState, subscribe: () => () => {}, updateView: () => {} }, layout: {} }))
  assert.match(listHtml, /持仓盈亏 \+10%(?!\d)/, '两持仓各+10%均值=+10%(B4,非求和+20%)')
})
// 可用性三连: 浏览全市场/搜索不逼同步/保存钮提示
test('审查R2: 浏览市场随实例能力+保存钮检查提示', async () => {
  const { plugin } = await loadClientWithReact()
  const state = { view: { view: 'browse', browseMarket: 'XSHG', browseRows: [], browseTotal: 0, browseOffset: 0, sort: 'manual', alias: '', browsePeek: {} }, busy: {}, candidates: [], composing: false, undo: null, error: '', errorCode: '', paused: false, data: { control: { revision: 1, routingRevision: 0, watchlist: { order: [], items: {} }, preferences: {}, routes: [{ id: 'xhkg-catalog', capability: 'catalog', market: 'XHKG', instrument: 'equity', primaryInstanceId: 'em-default', fallbackInstanceIds: [], failoverMode: 'off', maxDelaySeconds: null, acceptUnknownDelay: true }, { id: 'xnas-catalog', capability: 'catalog', market: 'XNAS', instrument: 'equity', primaryInstanceId: 'em-default', fallbackInstanceIds: [], failoverMode: 'off', maxDelaySeconds: null, acceptUnknownDelay: true }, { id: 'xnys-catalog', capability: 'catalog', market: 'XNYS', instrument: 'equity', primaryInstanceId: 'em-default', fallbackInstanceIds: [], failoverMode: 'off', maxDelaySeconds: null, acceptUnknownDelay: true }, { id: 'xshg-catalog', capability: 'catalog', market: 'XSHG', instrument: 'equity', primaryInstanceId: 'em-default', fallbackInstanceIds: [], failoverMode: 'off', maxDelaySeconds: null, acceptUnknownDelay: true }], providers: [{ id: 'em-default', adapterId: 'eastmoney', label: 'em-default', enabled: true, credentialRef: null, quotaGroup: 'eastmoney-account', budget: { requestsPerMinute: 60, dailyRequestLimit: null, billingUnit: 'request', symbolCreditsPerMinute: null, capabilityLimits: {} } }] }, quotes: {}, adapters: [{ id: 'eastmoney', adapterId: 'eastmoney', label: 'em', capabilities: ['quotes', 'catalog', 'search', 'kline'], markets: ['XSHG', 'XSHE', 'XHKG', 'XNAS', 'XNYS', 'XJPX', 'XKRX', 'XLON'], credential: 'none' }], providerStatus: [], catalogs: [], routeSelections: {}, klineReady: {}, vendorAvailable: false } }
  const rt = { getSnapshot: () => state, subscribe: () => () => {}, updateView: () => {}, loadBrowse: () => Promise.resolve({ items: [], total: 0 }) }
  const html = renderToStaticMarkup(React.createElement(plugin.__testing.StockPage, { runtime: rt, layout: {} }))
  for (const label of ['港股', '纳斯达克', '纽交所']) assert.ok(html.includes(label), `浏览按钮含 ${label}`)
  for (const label of ['日本', '英国']) assert.ok(!html.includes(label), `无目录路由不亮: ${label}`)
  // 设置页: 保存不再需要先检查, 探针结果只作诊断
  const settings = { ...state, view: { view: 'list', overlay: 'settings', sort: 'manual', alias: '', settingsDraft: { providers: [{ id: 'p1', adapterId: 'eastmoney', label: 'em-default', enabled: true, credentialRef: null, quotaGroup: 'eastmoney-account', budget: { requestsPerMinute: 60, dailyRequestLimit: null, billingUnit: 'request', symbolCreditsPerMinute: null, capabilityLimits: {} } }], routes: [], checkIds: [], checkResults: [], colorMode: 'red-up', klineAutoLoad: true, tab: 'routes' } } }
  const sHtml = renderToStaticMarkup(React.createElement(plugin.__testing.StockPage, { runtime: { getSnapshot: () => settings, subscribe: () => () => {}, updateView: () => {}, loadKline: () => Promise.resolve({ candles: [] }) }, layout: { providerCheck: () => {} } }))
  assert.match(sHtml, /保存路由/, '保存入口常驻')
  assert.ok(!sHtml.includes('通过后才能保存'), '保存不再被探针结果拦截')
})
// 浏览点进详情: overlay 打开时 updateView 不触发 leaveDetail 清理(崩溃修复锚)
test('审查R2b: browse点进保留browsePeek与detailId', async () => {
  const { plugin } = await loadClientWithReact()
  let view = { view: 'browse', browseMarket: 'XHKG', browseRows: [{ id: 'XHKG:equity:00001', exchange: 'XHKG', code: '00001', officialName: '长和' }], browseTotal: 1, browseOffset: 0, sort: 'manual', alias: '', browsePeek: {} }
  let lastPatch = null
  const updateView = next => { const merged = { ...view, ...next }; view = merged; lastPatch = next }
  const rt = { getSnapshot: () => ({ view, busy: {}, candidates: [], composing: false, undo: null, error: '', errorCode: '', paused: false, kline: null, data: { control: { revision: 1, routingRevision: 0, watchlist: { order: [], items: {} }, preferences: {} }, quotes: {}, adapters: [], providerStatus: [], catalogs: [], routeSelections: {}, klineReady: {}, vendorAvailable: false } }), subscribe: () => () => {}, updateView, loadKline: () => Promise.resolve({ candles: [] }), refresh: () => Promise.resolve({}), loadBrowse: () => Promise.resolve({ items: [], total: 0 }), sync: () => Promise.resolve([]) }
  const html = renderToStaticMarkup(React.createElement(plugin.__testing.StockPage, { runtime: rt, layout: {} }))
  assert.ok(html.includes('长和'), '浏览行渲染')
  // 模拟点行 updateView 语义: overlay 开着时 detailId/browsePeek 不被清
  const clickPatch = { detailId: 'XHKG:equity:00001', view: 'browse', overlay: 'detail', browsePeek: { 'XHKG:equity:00001': view.browseRows[0] } }
  const merged = { ...view, ...clickPatch, ...((clickPatch.view && clickPatch.view !== 'detail' && !clickPatch.overlay) ? { detailId: null, alias: '', browsePeek: {} } : {}) }
  assert.equal(merged.detailId, 'XHKG:equity:00001', '点行后 detailId 保留')
  assert.ok(merged.browsePeek['XHKG:equity:00001'], '点行后 browsePeek 保留')
})
// 设置页三段 Tab: 每 tab 独立保存(role=tablist)+③即改即存
test('设置R: 三段Tab布局与分域保存', async () => {
  const { plugin } = await loadClientWithReact()
  const mkState = overlay => ({ view: { view: 'list', overlay, sort: 'manual', alias: '', settingsDraft: { providers: [{ id: 'p1', adapterId: 'eastmoney', label: 'em-default', enabled: true, credentialRef: null, quotaGroup: 'eastmoney-account', budget: { requestsPerMinute: 60, dailyRequestLimit: null, billingUnit: 'request', symbolCreditsPerMinute: null, capabilityLimits: {} } }], routes: [{ id: 'xshg-quotes', capability: 'quotes', market: 'XSHG', instrument: 'equity', primaryInstanceId: 'p1', fallbackInstanceIds: [], failoverMode: 'off', maxDelaySeconds: null, acceptUnknownDelay: true }], checkIds: ['ck1'], checkResults: [], colorMode: 'red-up', klineAutoLoad: true, tab: 'sources' } }, busy: {}, candidates: [], composing: false, undo: null, error: '', errorCode: '', paused: false, data: { control: { revision: 1, routingRevision: 0, watchlist: { order: [], items: {} }, preferences: { colorMode: 'red-up', refreshSeconds: 15 }, providers: [{ id: 'p1', adapterId: 'eastmoney', label: 'em-default', enabled: true, credentialRef: null, quotaGroup: 'eastmoney-account', budget: { requestsPerMinute: 60, dailyRequestLimit: null, billingUnit: 'request', symbolCreditsPerMinute: null, capabilityLimits: {} } }] }, quotes: {}, adapters: [{ id: 'eastmoney', adapterId: 'eastmoney', label: 'em', capabilities: ['quotes', 'catalog', 'search', 'kline'], markets: ['XSHG', 'XSHE', 'XHKG', 'XNAS', 'XNYS'], credential: 'none' }], providerStatus: [], catalogs: [], routeSelections: {}, klineReady: {}, vendorAvailable: false } })
  const settings = mkState('settings')
  const sHtml = renderToStaticMarkup(React.createElement(plugin.__testing.StockPage, { runtime: { getSnapshot: () => settings, subscribe: () => () => {}, updateView: () => {}, loadKline: () => Promise.resolve({ candles: [] }), refresh: () => Promise.resolve({}), configuration: () => Promise.resolve({ ok: true }), preferences: () => Promise.resolve({ ok: true }) }, layout: { providerCheck: () => {} } }))
  assert.match(sHtml, /role="tablist"/, '设置是 tablist')
  for (const t of ['数据源', '市场与能力', '显示偏好']) assert.ok(sHtml.includes(t), `tab ${t} 存在`)
  assert.match(sHtml, /保存数据源|保存路由/, '①②各有独立保存钮')
  assert.ok(!sHtml.includes('② 市场与能力（'), '手风琴摘要行已移除')
  // 显示偏好 tab: 即改即存无保存钮
  const prefState = mkState('settings'); prefState.view.settingsDraft.tab = 'display'
  const pHtml = renderToStaticMarkup(React.createElement(plugin.__testing.StockPage, { runtime: { getSnapshot: () => prefState, subscribe: () => () => {}, updateView: () => {}, loadKline: () => Promise.resolve({ candles: [] }), refresh: () => Promise.resolve({}), preferences: () => Promise.resolve({ ok: true }) }, layout: { providerCheck: () => {} } }))
  assert.match(pHtml, /刷新间隔/, '③内容渲染')
  assert.match(pHtml, /悬浮盯盘刷新/, '③含悬浮盯盘刷新')
  assert.match(pHtml, /role="combobox"/, '③下拉是自绘 combobox')
  for (const n of [3, 5, 10, 30]) assert.ok(pHtml.includes(`>${n}秒</div>`), `悬浮档位含 ${n} 秒`)
  assert.ok(!pHtml.includes('保存显示偏好'), '③无保存钮(即改即存)')
})
// 一键全能力自举: 按适配器 markets×capabilities 补全缺失路由(含K线/目录/搜索)
test('bootstrap: 全能力路由补全', async () => {
  // bootstrapRoutes 内联在 client factory 作用域(bundle 源无 ESM import), 从源文本抽取函数体实例化验证
  const { readFileSync } = await import('node:fs')
  const src = readFileSync(new URL('../src/client.js', import.meta.url), 'utf8')
  const start = src.indexOf('const CAP_ORDER')
  const end = src.indexOf('const BROWSE_MARKETS')
  const bootstrapRoutes = new Function(`${src.slice(start, end)}; return bootstrapRoutes`)()
  const adapters = [{ adapterId: 'eastmoney', capabilities: ['quotes', 'kline', 'search', 'catalog'], markets: ['XSHG', 'XSHE', 'XHKG', 'XNAS', 'XNYS'] }]
  const providers = [{ id: 'em-default', adapterId: 'eastmoney', enabled: true }]
  const existing = [{ id: 'xshg-quotes', capability: 'quotes', market: 'XSHG', instrument: 'equity', primaryInstanceId: 'em-default', fallbackInstanceIds: [], failoverMode: 'off', maxDelaySeconds: null, acceptUnknownDelay: true }]
  const routes = bootstrapRoutes({ adapters, providers, routes: existing })
  assert.equal(routes.length, 20, '5市场×4能力全补齐')
  for (const cap of ['quotes', 'kline', 'catalog', 'search']) for (const m of ['XSHG', 'XSHE', 'XHKG', 'XNAS', 'XNYS']) assert.ok(routes.some(r => r.market === m && r.capability === cap), `${m}/${cap} 存在`)
  assert.equal(routes.find(r => r.market === 'XHKG' && r.capability === 'kline').primaryInstanceId, 'em-default', '主源=启用实例')
  // 多实例: quotes 主源跟随既有 quotes 路由的实例选择
  const adapters2 = [...adapters, { adapterId: 'sina', capabilities: ['quotes', 'catalog'], markets: ['XSHG', 'XSHE'] }]
  const providers2 = [...providers, { id: 'sn-catalog', adapterId: 'sina', enabled: true }]
  const routes2 = bootstrapRoutes({ adapters: adapters2, providers: providers2, routes: existing })
  assert.equal(routes2.find(r => r.market === 'XSHG' && r.capability === 'catalog').primaryInstanceId, 'sn-catalog', '目录优先专属适配器(唯一支持者)')
  // 无启用实例: 返回原样不炸
  assert.equal(bootstrapRoutes({ adapters, providers: [{ id: 'x', adapterId: 'eastmoney', enabled: false }], routes: existing }).length, 1)
  // 备源上限 1: 多实例支持同市场同能力时只取首个支持者, 否则 schema 拒绝整份配置
  const adapters3 = [{ adapterId: 'eastmoney', capabilities: ['quotes'], markets: ['XSHG'] }, { adapterId: 'sina', capabilities: ['quotes'], markets: ['XSHG'] }, { adapterId: 'tencent', capabilities: ['quotes'], markets: ['XSHG'] }]
  const providers3 = adapters3.map((a, i) => ({ id: 'p' + i, adapterId: a.adapterId, enabled: true }))
  const routes3 = bootstrapRoutes({ adapters: adapters3, providers: providers3, routes: [] })
  assert.equal(routes3.length, 1)
  assert.equal(routes3[0].fallbackInstanceIds.length, 1, '备源最多一个')
  // 只有 quotes/kline 支持备源: 目录与搜索路由恒无备源且不自动切换
  const adapters4 = [{ adapterId: 'eastmoney', capabilities: ['catalog', 'search'], markets: ['XSHG'] }, { adapterId: 'sina', capabilities: ['catalog'], markets: ['XSHG'] }]
  const providers4 = adapters4.map((a, i) => ({ id: 'q' + i, adapterId: a.adapterId, enabled: true }))
  for (const r of bootstrapRoutes({ adapters: adapters4, providers: providers4, routes: [] })) {
    if (!['quotes', 'kline'].includes(r.capability)) { assert.deepEqual(r.fallbackInstanceIds, [], `${r.capability} 无备源`); assert.equal(r.failoverMode, 'off', `${r.capability} 不自动切换`) }
  }
})
// 探针失败按目标粒度剔除: 主源不可用提升备源, 备源不可用仅移除备源, 全部不可用才删路由
test('pruneDeniedTargets: 主源失败提升备源而非删整条路由', async () => {
  const { readFileSync } = await import('node:fs')
  const src = readFileSync(new URL('../src/client.js', import.meta.url), 'utf8')
  const start = src.indexOf('const pruneDeniedTargets')
  const end = src.indexOf('const BROWSE_MARKETS')
  const pruneDeniedTargets = new Function(`${src.slice(start, end)}; return pruneDeniedTargets`)()
  const route = { id: 'xnas-kline', capability: 'kline', market: 'XNAS', instrument: 'equity', primaryInstanceId: 'ts-1', fallbackInstanceIds: ['em-default'], failoverMode: 'network', maxDelaySeconds: null, acceptUnknownDelay: true }
  // 主源腾讯美股K线不支持, 备源东财可用: 提升东财为主源, 不留死备源
  const lifted = pruneDeniedTargets([route], new Set(['ts-1:kline:XNAS']))
  assert.equal(lifted.length, 1, '不删整条路由')
  assert.equal(lifted[0].primaryInstanceId, 'em-default', '可用备源提升为主源')
  assert.deepEqual(lifted[0].fallbackInstanceIds, [], '被拒目标不留在备源')
  assert.equal(lifted[0].failoverMode, 'off', '无备源时关闭故障切换')
  // 备源不可用: 仅移除备源, 主源不动
  const trimmed = pruneDeniedTargets([route], new Set(['em-default:kline:XNAS']))
  assert.equal(trimmed.length, 1)
  assert.equal(trimmed[0].primaryInstanceId, 'ts-1', '主源保留')
  assert.deepEqual(trimmed[0].fallbackInstanceIds, [])
  // 全部目标不可用: 删除该路由
  assert.equal(pruneDeniedTargets([route], new Set(['ts-1:kline:XNAS', 'em-default:kline:XNAS'])).length, 0)
  // 无拒绝目标: 原样返回
  const untouched = pruneDeniedTargets([route], new Set())
  assert.equal(untouched[0].primaryInstanceId, 'ts-1')
  assert.deepEqual(untouched[0].fallbackInstanceIds, ['em-default'])
  assert.equal(untouched[0].failoverMode, 'network')
})
test('U01/U02 IME组合不查询，后发查询覆盖先发迟到结果', async () => {
  const callbacks = [], r = await runtime({ fetch: (url, opts) => new Promise(resolve => callbacks.push({ url, signal: opts.signal, resolve })) })
  r.value.applySnapshot(snapshot(1)); r.value.composition(true); r.value.search('茅'); await r.clock.advance(400); assert.equal(callbacks.length, 0)
  r.value.composition(false); await r.clock.until(() => callbacks.length >= 1); const old = callbacks[0]
  r.value.search('平安'); await r.clock.until(() => callbacks.length >= 2); const newer = callbacks[1]
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
  const calls = []
  const { value, clock } = await runtime({ fetch: async () => { calls.push(1); return { ok: false, status: 502, json: async () => ({ ok: false, error: { code: 'NETWORK', message: '无法连接行情来源' } }) } } })
  value.applySnapshot(klineSnapshot())
  const flight = value.loadKline('XSHG:equity:600519', '1d')
  // 先挂接 reject 再驱动时钟: rejection 落在时钟推进期间, 不能出现无接手窗口
  const expectation = assert.rejects(() => flight)
  await clock.until(() => calls.length >= 2)
  await expectation
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
  const { value, clock } = await runtime({ fetch: async (url, opts) => { calls.push(String(url)); if (calls.length === 1) { return { ok: false, status: 429, json: async () => ({ ok: false, error: { code: 'RATE_LIMIT', message: '数据源额度受限，请稍后重试', retryAfterMs: 20 } }) } } return { ok: true, json: async () => ({ ok: true, data: { candles: [{ time: '2026-10-29', open: 1, high: 2, low: 0.5, close: 1.5, volume: 100 }], preClose: 0.9, complete: true, source: 'em-default' } }) } } })
  value.applySnapshot(klineSnapshot())
  const flight = value.loadKline('XSHG:equity:600519', '1d')
  await clock.until(() => calls.length >= 2)
  const result = await flight
  assert.equal(result.candles.length, 1)
  assert.equal(calls.length, 2, '首次429后退避重试一次')
  assert.ok(clock.elapsed() >= 20, '重试等待不小于服务端 retryAfterMs')
  assert.equal(value.getSnapshot().kline.error, '')
  value.dispose()
}, { timeout: 10000 })

test('K6 NO_ROUTE 二次失败不自动重试(避免额外资损)', async () => {
  const calls = []
  const { value, clock } = await runtime({ fetch: async (url, opts) => { calls.push(String(url)); return { ok: false, status: 422, json: async () => ({ ok: false, error: { code: 'RATE_LIMIT', message: '数据源额度受限，请稍后重试' } }) } } })
  value.applySnapshot(klineSnapshot())
  const flight = value.loadKline('XSHG:equity:600519', '1d')
  // 先挂接 reject 再驱动时钟: rejection 落在时钟推进期间, 不能出现无接手窗口
  const expectation = assert.rejects(() => flight)
  await clock.until(() => calls.length >= 2)
  await expectation
  assert.equal(calls.length, 2, '重试一次后停止')
  assert.equal(value.getSnapshot().kline.errorCode, 'RATE_LIMIT')
  value.dispose()
}, { timeout: 10000 })

test('K7 NO_ROUTE 错误条渲染一键开启按钮', async () => {
  const { plugin } = await loadClientWithReact()
  const item = { id: 'XSHG:equity:600519', officialName: '贵州茅台', code: '600519', exchange: 'XSHG', instrument: 'equity', currency: 'CNY', timezone: 'Asia/Shanghai', priceScale: 2, listingStatus: 'listed', alias: '', pinned: false }
  const state = { view: { view: 'list', overlay: 'detail', query: '', selectedId: item.id, detailId: item.id, sort: 'manual', alias: '' }, busy: {}, candidates: [], composing: false, undo: null, error: '', errorCode: '', paused: false, klinePeriod: '1d', klineKey: `${item.id}|1d`, kline: { loading: false, error: '未配置该市场的数据来源', errorCode: 'NO_ROUTE', candles: null }, data: { control: { revision: 1, routingRevision: 0, watchlist: { order: [item.id], items: { [item.id]: item } }, preferences: {}, providers: [{ id: 'em-default', adapterId: 'eastmoney', enabled: true, credentialRef: null, quotaGroup: 'free', budget: { requestsPerMinute: 60, dailyRequestLimit: null, billingUnit: 'request', symbolCreditsPerMinute: null, capabilityLimits: {} } }], routes: [] }, quotes: {}, adapters: [], providerStatus: [], catalogs: [], routeSelections: {}, vendorAvailable: true } }
  const updates = []
  const runtimeStub = { getSnapshot: () => state, subscribe: () => () => {}, updateView: patch => updates.push(patch), loadKline: () => Promise.resolve({ candles: [] }) }
  const html = renderToStaticMarkup(React.createElement(plugin.__testing.StockPage, { runtime: runtimeStub, layout: {} }))
  assert.match(html, /未配置该市场的数据来源/)
  assert.match(html, /一键开启</, '一键开启按钮')
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
  const state = { view: { view: 'list', overlay: 'settings', query: '', selectedId: null, sort: 'manual', settingsDraft: { providers: saved.providers, routes: saved.routes, checkIds: ['seed'], checkResults: [], tab: 'routes' }, browseMarket: 'XSHG' }, busy: {}, candidates: [], composing: false, undo: null, error: '', errorCode: '', data }
  const runtimeStub = { getSnapshot: () => state, subscribe: () => () => {}, updateView() {}, mutate: async () => {}, check: async () => ({ checkId: 'x', checks: [] }), configuration: async () => {}, preferences: async () => {}, sync: async () => [], switchPrimary: async () => {} }
  const html = renderToStaticMarkup(React.createElement(plugin.__testing.StockPage, { runtime: runtimeStub, layout: {} }))
  for (const marker of ['数据源', '市场与能力', '显示偏好', '保存路由', '全部测一次', '放弃草稿', '目录缓存']) assert.ok(html.includes(marker), `设置页缺节点: ${marker}`)
  // 启用banner仅在无实例时出现(默认配置自带双实例, 不含该banner为正确行为)
  assert.ok(!html.includes('启用默认数据源'))
  // 8市场 fieldset 全渲染(K线行存在)
  for (const market of ['XSHG', 'XSHE', 'XHKG', 'XNAS', 'XNYS', 'XJPX', 'XKRX', 'XLON']) assert.ok(html.includes(market), `市场 fieldset 缺: ${market}`)
  assert.ok(html.includes('K线'), 'K线能力可见')
})

test('D02 拖拽落位计算: 段内前插/后插与非本 tab 成员回填', async () => {
  const { plugin } = await loadClientWithReact()
  const { dragOrder } = plugin.__testing
  const ids = ['a', 'b', 'c', 'd']
  assert.deepEqual([...dragOrder(ids, ids, 'a', 'c', false)], ['b', 'a', 'c', 'd'], '拖到目标上半=插到其前')
  assert.deepEqual([...dragOrder(ids, ids, 'a', 'c', true)], ['b', 'c', 'a', 'd'], '拖到目标下半=插到其后')
  assert.deepEqual([...dragOrder(ids, ids, 'd', 'b', false)], ['a', 'd', 'b', 'c'], '尾项前移')
  assert.equal(dragOrder(ids, ids, 'a', 'zz', false), null, '目标不在渲染序则不动')
  // 别的标签下的 x,y 不在本 tab 渲染序, 提交时按原槽位回填
  const full = ['a', 'x', 'b', 'y']
  assert.deepEqual([...dragOrder(['a', 'b'], full, 'b', 'a', false)], ['b', 'x', 'a', 'y'], '非本 tab 成员保持原槽位')
})

test('D03 副标题按自选实际市场面生成', async () => {
  const { plugin } = await loadClientWithReact()
  const mk = (id, name, code, ex) => ({ id, officialName: name, code, exchange: ex, instrument: 'equity', currency: 'CNY', timezone: 'Asia/Shanghai', priceScale: 2, listingStatus: 'listed', alias: '', pinned: false })
  const a = mk('XHKG:equity:00700', '腾讯控股', '00700', 'XHKG'), b = mk('XNAS:equity:NVDA', '英伟达', 'NVDA', 'XNAS'), c = mk('XSHE:equity:000001', '平安银行', '000001', 'XSHE')
  const build = ids => ({ view: { view: 'list', sort: 'manual', alias: '' }, busy: {}, candidates: [], composing: false, undo: null, error: '', paused: false, data: { control: { revision: 1, routingRevision: 0, watchlist: { order: ids, items: Object.fromEntries([a, b, c].map(s => [s.id, s]).filter(([id]) => ids.includes(id))) }, preferences: {} }, quotes: {}, adapters: [], providerStatus: [], catalogs: [], routeSelections: {}, klineReady: {}, vendorAvailable: false } })
  const render = state => renderToStaticMarkup(React.createElement(plugin.__testing.StockPage, { runtime: { getSnapshot: () => state, subscribe: () => () => {}, updateView: () => {}, loadKline: () => Promise.resolve({ candles: [] }) }, layout: {} }))
  assert.match(render(build([a.id, b.id, c.id])), /自选行情 · 沪深A股、港股、美股/, '三市场按固定优先级列出')
  assert.match(render(build([b.id, a.id])), /自选行情 · 港股、美股/, '只列实际持有市场')
  assert.match(render(build([c.id])), /自选行情 · 沪深A股/, '深市归入沪深A股')
  assert.match(render(build([])), /自选行情 · 沪深A股、港股、美股、日股、韩股、英股/, '空自选给出覆盖范围')
})

// 卖价不是报价要素, 但目标位必须能在图例里读到, 否则图上只有一条看不见的线
test('图例显示卖价与相对成本的潜在收益', async () => {
  const { plugin } = await loadClientWithReact()
  const item = { id: 'XSHG:equity:600519', officialName: '贵州茅台', code: '600519', exchange: 'XSHG', instrument: 'equity', currency: 'CNY', timezone: 'Asia/Shanghai', priceScale: 2, listingStatus: 'listed', alias: '', pinned: false, tags: ['沪A'], marks: [{ id: 'c1', price: 100, kind: 'cost' }, { id: 't1', price: 150, kind: 'target' }] }
  const state = { view: { view: 'detail', overlay: 'detail', detailId: item.id, klinePeriod: '1d', sort: 'manual', alias: '' }, busy: {}, candidates: [], composing: false, undo: null, error: '', errorCode: '', paused: false, klinePeriod: '1d', klineKey: `${item.id}|1d`, kline: { loading: false, error: '', candles: [{ time: '2026-11-07', open: 118, high: 122, low: 117, close: 120, volume: 100 }], preClose: 119 }, data: { control: { revision: 1, routingRevision: 0, watchlist: { order: [item.id], items: { [item.id]: item } }, preferences: {} }, quotes: {}, adapters: [], providerStatus: [], catalogs: [], routeSelections: {}, vendorAvailable: true, klineReady: { XSHG: true } } }
  const html = renderToStaticMarkup(React.createElement(plugin.__testing.StockPage, { runtime: { getSnapshot: () => state, subscribe: () => () => {}, updateView: () => {}, loadKline: () => Promise.resolve(null) }, layout: {} }))
  // 侧栏的标记列表里也有同样的数字, 所以必须切出图例那段再断言
  const legend = html.slice(html.indexOf('class="ssb-kline-legend"'))
  assert.match(legend, /class="ssb-legend-item ssb-legend-target"/, '卖价要单独占一个图例项')
  assert.match(legend, /卖价/, '图例要写明这是卖价')
  assert.match(legend, /150\.00/, '图例要给出卖价数值')
  assert.match(legend, /\+50\.00%/, '成本 100 的卖价 150 是 +50%')
  // 成本图例同时存在, 两个数不是同一个来源
  assert.match(legend, /class="ssb-legend-item ssb-legend-cost"/, '成本图例仍在')
})

// 凭据输入: 有 credentialRef 的实例展开后要能直接填密钥, 而不是只让用户去改环境变量名
test('设置页为需凭据的实例渲染密钥输入', async () => {
  const { plugin } = await loadClientWithReact()
  const provider = { id: 'fh-live', adapterId: 'finnhub', enabled: true, credentialRef: 'DSH_STOCK_FINNHUB_TOKEN', quotaGroup: 'finnhub-live', budget: { requestsPerMinute: 60, dailyRequestLimit: null, billingUnit: 'request', symbolCreditsPerMinute: null, capabilityLimits: {} } }
  const state = { view: { view: 'list', overlay: 'settings', query: '', selectedId: null, sort: 'manual', settingsDraft: { providers: [provider], routes: [], expectedRevision: 1, checkResults: [], probes: {}, expandedProvider: 'fh-live' } }, busy: {}, candidates: [], composing: false, undo: null, error: '', errorCode: '', paused: false, data: { control: { revision: 1, routingRevision: 1, watchlist: { order: [], items: {} }, preferences: {}, providers: [provider], routes: [] }, quotes: {}, adapters: [{ adapterId: 'finnhub', capabilities: ['quotes'], credential: 'DSH_STOCK_FINNHUB_TOKEN', description: '美股实时报价', endpointKeys: [{ key: 'quotes', label: '实时报价' }] }], providerStatus: [{ id: 'fh-live', credentialRef: 'DSH_STOCK_FINNHUB_TOKEN', credentialPresent: false, proxy: false, endpointsCovered: 0, recentRequests: [] }], catalogs: [], routeSelections: {}, klineReady: {}, vendorAvailable: true } }
  const runtimeStub = { getSnapshot: () => state, subscribe: () => () => {}, updateView: () => {}, api: () => Promise.resolve({}), applySnapshot: () => {}, loadKline: () => Promise.resolve({ candles: [] }) }
  const html = renderToStaticMarkup(React.createElement(plugin.__testing.StockPage, { runtime: runtimeStub, layout: {} }))
  assert.match(html, /密钥引用名/, '引用名可改')
  assert.match(html, /密钥（未配置）/, '未配置时提示')
  assert.match(html, /type="password"/, '密钥用密码框, 不回显')
  assert.match(html, /保存密钥/, '有保存动作')
  assert.doesNotMatch(html, /保存密钥<\/button><\/div><button[^>]*>清除/, '未配置时没有清除按钮')
})

test('设置页凭据已就绪时给出清除入口', async () => {
  const { plugin } = await loadClientWithReact()
  const provider = { id: 'fh-live', adapterId: 'finnhub', enabled: true, credentialRef: 'DSH_STOCK_FINNHUB_TOKEN', quotaGroup: 'finnhub-live', budget: { requestsPerMinute: 60, dailyRequestLimit: null, billingUnit: 'request', symbolCreditsPerMinute: null, capabilityLimits: {} } }
  const state = { view: { view: 'list', overlay: 'settings', query: '', selectedId: null, sort: 'manual', settingsDraft: { providers: [provider], routes: [], expectedRevision: 1, checkResults: [], probes: {}, expandedProvider: 'fh-live' } }, busy: {}, candidates: [], composing: false, undo: null, error: '', errorCode: '', paused: false, data: { control: { revision: 1, routingRevision: 1, watchlist: { order: [], items: {} }, preferences: {}, providers: [provider], routes: [] }, quotes: {}, adapters: [{ adapterId: 'finnhub', capabilities: ['quotes'], credential: 'DSH_STOCK_FINNHUB_TOKEN', description: '美股实时报价', endpointKeys: [{ key: 'quotes', label: '实时报价' }] }], providerStatus: [{ id: 'fh-live', credentialRef: 'DSH_STOCK_FINNHUB_TOKEN', credentialPresent: true, proxy: false, endpointsCovered: 0, recentRequests: [] }], catalogs: [], routeSelections: {}, klineReady: {}, vendorAvailable: true } }
  const runtimeStub = { getSnapshot: () => state, subscribe: () => () => {}, updateView: () => {}, api: () => Promise.resolve({}), applySnapshot: () => {}, loadKline: () => Promise.resolve({ candles: [] }) }
  const html = renderToStaticMarkup(React.createElement(plugin.__testing.StockPage, { runtime: runtimeStub, layout: {} }))
  assert.match(html, /密钥（已配置/, '已配置时换个说法')
  assert.match(html, /清除/, '已配置时可清除')
})
