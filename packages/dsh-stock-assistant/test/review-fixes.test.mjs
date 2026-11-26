// 复检 K4/K5/K6/K7 的客户端用例: 适配器剪枝、Select 异常值、凭据录入顺序、peek 报价生命周期与目录同步失败出口。
// 与 client-edge 同一套加载器(真 React + vm 里的 client.js), 单独成文件避免主文件继续变长。
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import vm from 'node:vm'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

async function loadPlugin(options = {}) {
  let plugin
  const source = await readFile(new URL('../src/client.js', import.meta.url), 'utf8')
  const clock = createTestClock()
  const window = { __ModuleLoader__: { load: entry => { plugin = entry.factory(name => name === 'react' ? React : {}) } } }
  vm.runInNewContext(source, {
    window, console, AbortController, URLSearchParams, crypto: globalThis.crypto,
    fetch: options.fetch ?? globalThis.fetch,
    setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout, setInterval: clock.setInterval, clearInterval: clock.clearInterval,
  })
  return { plugin, clock }
}

// 与 client-edge 同款测试时钟: 只推进显式 advance/until, 不让真实退避与用例超时窗口竞速
function createTestClock() {
  let now = 0, seq = 0
  const pending = new Map()
  const set = kind => (fn, ms = 0, ...rest) => {
    if (ms === 0) return setImmediate(() => fn(...rest))
    const id = ++seq
    pending.set(id, { kind, fn, at: now + ms, ms, rest })
    return id
  }
  const clear = id => pending.delete(id)
  const drain = async () => { for (let i = 0; i < 3; i++) await new Promise(resolve => setImmediate(resolve)) }
  async function advance(step) {
    now += step
    for (;;) {
      await drain()
      const due = [...pending].filter(([, timer]) => timer.at <= now).sort((a, b) => (a[1].at - b[1].at) || (a[0] - b[0]))
      if (!due.length) return
      for (const [id, timer] of due) {
        if (!pending.has(id)) continue
        pending.delete(id)
        if (timer.kind === 'interval') pending.set(id, { ...timer, at: timer.at + timer.ms })
        timer.fn(...timer.rest)
      }
    }
  }
  return { setTimeout: set('timeout'), clearTimeout: clear, setInterval: set('interval'), clearInterval: clear, advance }
}

const jsonResponse = payload => ({ ok: true, status: 200, async json() { return payload } })
const emptyControl = (overrides = {}) => ({ revision: 1, routingRevision: 0, watchlist: { order: [], items: {} }, preferences: {}, providers: [], routes: [], ...overrides })
const snapshot = (seq, control, quotes = {}) => ({ serverEpoch: 'a', snapshotSeq: seq, routingRevision: 0, routeSelections: {}, quotes, control })

async function runtimeWith(fetchImpl) {
  let plugin, snapshotRefresh, onReset
  const source = await readFile(new URL('../src/client.js', import.meta.url), 'utf8')
  const clock = createTestClock()
  const window = { __ModuleLoader__: { load: entry => { plugin = entry.factory(() => ({})) } } }
  vm.runInNewContext(source, {
    window, console, AbortController, URLSearchParams, crypto: globalThis.crypto, fetch: fetchImpl,
    setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout, setInterval: clock.setInterval, clearInterval: clock.clearInterval,
  })
  const doc = { visibilityState: 'visible', addEventListener() {}, removeEventListener() {} }
  const value = plugin.__testing.createPageRuntime({
    layout: { panelInfo: { getSnapshot: () => ({ activePanelId: 'stock-assistant' }), subscribe: () => () => {} }, selectPanel() {} },
    bus: { publish() {}, subscribe: (fn, options) => { onReset = options?.onReset; return () => {} } },
    tools: { createSnapshotRefresh: fn => { snapshotRefresh = fn; return { refresh() {}, dispose() {} } } },
    document: doc,
  })
  return { value, clock, pull: () => snapshotRefresh(), reset: () => onReset?.() }
}

test('K4 Select 当前值不在选项里时显示异常项, 不静默回退首个选项', async () => {
  const { plugin } = await loadPlugin()
  const { Select, selectEntries } = plugin.__testing
  assert.deepEqual([...selectEntries('ghost', [{ value: 'a', label: 'A' }]).map(option => option.label)], ['ghost（不可用）', 'A'])
  assert.deepEqual([...selectEntries('', [{ value: '', label: '未配置' }]).map(option => option.label)], ['未配置'], '空值由选项显式表达时不补异常项')
  assert.deepEqual([...selectEntries(5, [{ value: 5, label: '5秒' }]).map(option => option.label)], ['5秒'])
  const html = renderToStaticMarkup(React.createElement(Select, { value: 'ghost', label: '适配器', options: [{ value: 'a', label: 'A' }], onChange() {} }))
  assert.match(html, /ghost（不可用）/, '触发器显示失效值')
  assert.match(html, /ssb-select-value-invalid/)
  assert.match(html, /aria-disabled="true"/, '异常项不可选')
  assert.equal((html.match(/aria-selected="true"/g) || []).length, 1, '仅异常项代表当前值')
})

// 适配器切换入口即剪枝: 新适配器不支持的能力/市场不能留在草稿里, 否则服务端校验整次 422
test('K4 适配器切换按能力剪枝, 保存载荷不再含新适配器不支持的引用', async () => {
  const { plugin } = await loadPlugin()
  const { providerChangeDraft, settingsSavePayload } = plugin.__testing
  const adapters = [
    { adapterId: 'eastmoney', capabilities: ['catalog', 'search', 'quotes', 'kline'], markets: ['XSHG', 'XSHE', 'XHKG'] },
    { adapterId: 'tushare', capabilities: ['catalog', 'quotes'], markets: ['XSHG', 'XSHE'] },
  ]
  const routeOf = (id, capability, market, primary, fallback = []) => ({ id, capability, market, instrument: 'equity', primaryInstanceId: primary, fallbackInstanceIds: fallback, failoverMode: fallback.length ? 'network' : 'off', maxDelaySeconds: null, acceptUnknownDelay: true })
  const providers = [{ id: 'p1', adapterId: 'eastmoney', enabled: true }, { id: 'p2', adapterId: 'eastmoney', enabled: true }]
  const routes = [
    routeOf('xshg-catalog', 'catalog', 'XSHG', 'p1', ['p2']),
    routeOf('xhkg-kline', 'kline', 'XHKG', 'p1'),
    routeOf('xhkg-kline-2', 'kline', 'XHKG', 'p2', ['p1']),
    routeOf('xshg-quotes', 'quotes', 'XSHG', 'p2', ['p1']),
    routeOf('xnas-search', 'search', 'XNAS', 'p1'),
  ]
  const draft = { providers, routes, expectedRevision: 1 }
  const next = providerChangeDraft(draft, 'p1', { adapterId: 'tushare' }, adapters)
  assert.deepEqual(next.routes.map(route => route.id), ['xshg-catalog', 'xhkg-kline-2', 'xshg-quotes'], 'kline/XHKG/XNAS 引用被剪掉, 支持的能力与市场保留')
  assert.deepEqual(next.routes.find(route => route.id === 'xhkg-kline-2').fallbackInstanceIds, [], '不支持的备源摘掉')
  assert.equal(next.routes.find(route => route.id === 'xhkg-kline-2').failoverMode, 'off')
  // 保存载荷兜底: 旧草稿没走过切换入口时同样不能提交服务端必拒的引用
  const saved = { providers, routes, revision: 1 }
  const staleDraft = { providers: providers.map(p => p.id === 'p1' ? { ...p, adapterId: 'tushare' } : p), routes, expectedRevision: 1 }
  const payload = settingsSavePayload('sources', staleDraft, saved, adapters)
  for (const route of payload.routes) {
    const provider = payload.providers.find(p => p.id === route.primaryInstanceId)
    const adapter = adapters.find(a => a.adapterId === provider.adapterId)
    assert.ok(adapter.capabilities.includes(route.capability) && adapter.markets.includes(route.market), `${route.id} 主源必须被新适配器支持`)
    for (const fallback of route.fallbackInstanceIds) {
      const fallbackAdapter = adapters.find(a => a.adapterId === payload.providers.find(p => p.id === fallback).adapterId)
      assert.ok(fallbackAdapter.capabilities.includes(route.capability) && fallbackAdapter.markets.includes(route.market), `${route.id} 备源也必须支持`)
    }
  }
})

// 凭据引用的合法前提是被某个数据源声明; 声明在草稿里时, 录入顺序不能倒置成"先保存数据源"
test('K6 凭据录入顺序: 引用名刚写在草稿里时先落配置再写凭据', async () => {
  const calls = []
  const control = emptyControl()
  const fetchImpl = async (url, options = {}) => {
    const path = String(url).replace('/api/stock-assistant', '')
    calls.push({ path, body: options.body ? JSON.parse(options.body) : null })
    if (path === '/configuration') return jsonResponse({ ok: true, data: { revision: 2, unchanged: false } })
    if (path === '/credential') return jsonResponse({ ok: true, data: { ref: 'NEW_REF', present: true } })
    if (path === '/snapshot') return jsonResponse({ ok: true, data: snapshot(6, emptyControl({ revision: 2, providers: [{ id: 'p1', credentialRef: 'NEW_REF' }] })) })
    return jsonResponse({ ok: false, error: { code: 'UNEXPECTED', message: path } })
  }
  const { value } = await runtimeWith(fetchImpl)
  value.applySnapshot(snapshot(1, control))
  const draftProviders = [{ id: 'p1', adapterId: 'tushare', enabled: true, credentialRef: 'NEW_REF' }]
  value.updateView({ overlay: 'settings', settingsDraft: { providers: draftProviders, routes: [], expectedRevision: 1 } })
  const outcome = await value.saveCredential({ ref: 'NEW_REF', value: 'secret', providers: draftProviders, routes: [] })
  assert.deepEqual(calls.map(call => call.path), ['/configuration', '/credential', '/snapshot'], '先配置后凭据, 自然顺序可完成录入')
  assert.equal(calls[0].body.expectedRevision, 1, '配置用草稿基线版本')
  assert.equal(calls[0].body.providers[0].credentialRef, 'NEW_REF')
  assert.equal(outcome.configurationSaved, true)
  assert.equal(value.getSnapshot().view.settingsDraft.expectedRevision, 2, '草稿基线推进, 后续保存不撞 409')
})

test('K6 引用已在已保存配置里时只写凭据, 不重复保存配置', async () => {
  const calls = []
  const control = emptyControl({ revision: 3, providers: [{ id: 'p1', adapterId: 'tushare', enabled: true, credentialRef: 'SAVED_REF' }] })
  const fetchImpl = async (url, options = {}) => {
    const path = String(url).replace('/api/stock-assistant', '')
    calls.push({ path, body: options.body ? JSON.parse(options.body) : null })
    if (path === '/credential') return jsonResponse({ ok: true, data: { ref: 'SAVED_REF', present: true } })
    if (path === '/snapshot') return jsonResponse({ ok: true, data: snapshot(2, control) })
    return jsonResponse({ ok: false, error: { code: 'UNEXPECTED', message: path } })
  }
  const { value } = await runtimeWith(fetchImpl)
  value.applySnapshot(snapshot(1, control))
  const outcome = await value.saveCredential({ ref: 'SAVED_REF', value: 'secret', providers: control.providers, routes: control.routes })
  assert.deepEqual(calls.map(call => call.path), ['/credential', '/snapshot'])
  assert.equal(outcome.configurationSaved, false)
})

// peek 报价不进常驻快照: 客户端必须接住 refresh 响应里的那一份, 关闭详情即释放
test('K5 客户端 peek 报价: 随 refresh 响应私有保存, 关闭详情即释放', async () => {
  const peer = { id: 'XSHG:equity:600521', exchange: 'XSHG', code: '600521', officialName: '目录中的另一只' }
  const entry = { quote: { last: '20.00', previousClose: '19.00', receivedAt: 1, delayKind: 'realtime', sessionState: 'trading' }, health: 'ok', lastError: null }
  const fetchImpl = async url => {
    const path = String(url).replace('/api/stock-assistant', '')
    if (path === '/refresh') return jsonResponse({ ok: true, data: { ...snapshot(3, emptyControl()), quotes: { [peer.id]: entry } } })
    return jsonResponse({ ok: false, error: { code: 'UNEXPECTED', message: path } })
  }
  const { value } = await runtimeWith(fetchImpl)
  value.applySnapshot(snapshot(1, emptyControl()))
  value.updateView({ view: 'list', detailId: peer.id, overlay: 'detail', browsePeek: { [peer.id]: peer } })
  await value.refresh([peer])
  assert.equal(value.getSnapshot().peekQuotes[peer.id]?.quote.last, '20.00', '非自选报价被客户端接住')
  assert.equal(value.getSnapshot().data.quotes[peer.id]?.quote.last, '20.00')
  // 常驻快照(服务端已按自选过滤)不会冲掉详情手里的 peek 报价
  value.applySnapshot({ ...snapshot(4, emptyControl()), quotes: {} })
  assert.equal(value.getSnapshot().peekQuotes[peer.id]?.quote.last, '20.00')
  value.updateView({ overlay: null })
  assert.equal(Object.keys(value.getSnapshot().peekQuotes).length, 0, '关闭详情即释放, 不在页面内存里留旧行情')
})

test('K7 浏览页在目录同步失败时给出原因与重试入口', async () => {
  const { plugin } = await loadPlugin()
  const state = {
    view: { view: 'browse', browseMarket: 'XSHG', browseRows: null, browseTotal: 0, browseOffset: 0, browseSyncing: true, browseSyncError: { code: 'NO_ROUTE', message: '未配置该市场的数据来源' }, sort: 'manual', alias: '', browsePeek: {} },
    busy: {}, candidates: [], composing: false, undo: null, error: '', errorCode: '', paused: false,
    data: { control: emptyControl(), quotes: {}, adapters: [], providerStatus: [], catalogs: [], routeSelections: {}, klineReady: {}, vendorAvailable: false },
  }
  const runtimeStub = { getSnapshot: () => state, subscribe: () => () => {}, updateView: () => {}, loadBrowse: () => Promise.resolve(), sync: () => Promise.resolve() }
  const html = renderToStaticMarkup(React.createElement(plugin.__testing.StockPage, { runtime: runtimeStub, layout: {} }))
  assert.match(html, /目录同步失败：未配置该市场的数据来源/)
  assert.match(html, /重试同步/)
  assert.doesNotMatch(html, /目录首次同步中/, '失败态不再显示进行中')
})

// K7: 失败出口不能依赖用户手动切市场; 停在浏览页时客户端轮询 syncing 响应, 失败即展示
test('K7 浏览页停在原地也能从轮询响应拿到同步失败', async () => {
  let browseCalls = 0
  const queue = [
    { syncing: true, syncError: null, total: 0, items: [] },
    { syncing: true, syncError: { code: 'NO_ROUTE', message: '未配置该市场的数据来源' }, total: 0, items: [] },
  ]
  const fetchImpl = async url => {
    const path = String(url).replace('/api/stock-assistant', '')
    if (path.startsWith('/browse')) { browseCalls += 1; return jsonResponse({ ok: true, data: queue.shift() ?? { syncing: true, syncError: null, total: 0, items: [] } }) }
    return jsonResponse({ ok: false, error: { code: 'UNEXPECTED', message: path } })
  }
  const { value, clock } = await runtimeWith(fetchImpl)
  value.applySnapshot(snapshot(1, emptyControl()))
  value.updateView({ view: 'browse', browseMarket: 'XSHG', browseRows: null })
  await value.loadBrowse('XSHG', 0)
  assert.equal(value.getSnapshot().view.browseSyncing, true)
  assert.equal(value.getSnapshot().view.browseSyncError, null)
  await clock.advance(5000)
  assert.equal(value.getSnapshot().view.browseSyncing, true, '失败前仍是同步中')
  assert.equal(value.getSnapshot().view.browseSyncError?.code, 'NO_ROUTE', '轮询拿到失败原因')
  assert.equal(browseCalls, 2)
  await clock.advance(10000)
  assert.equal(browseCalls, 2, '失败后停止轮询, 等用户重试')
})

// K5: 关闭详情与在飞刷新之间的竞态 —— 晚到的 peek 响应不能重新写回页面内存
test('K5 关闭详情后晚到的 peek 响应不再写回', async () => {
  const peer = { id: 'XSHG:equity:600521', exchange: 'XSHG', code: '600521', officialName: '目录中的另一只' }
  const entry = { quote: { last: '20.00', previousClose: '19.00', receivedAt: 1, delayKind: 'realtime' }, health: 'ok', lastError: null }
  let release
  const fetchImpl = async url => {
    const path = String(url).replace('/api/stock-assistant', '')
    if (path === '/refresh') return new Promise(resolve => { release = () => resolve(jsonResponse({ ok: true, data: { ...snapshot(3, emptyControl()), quotes: { [peer.id]: entry } } })) })
    return jsonResponse({ ok: false, error: { code: 'UNEXPECTED', message: path } })
  }
  const { value } = await runtimeWith(fetchImpl)
  value.applySnapshot(snapshot(1, emptyControl()))
  value.updateView({ view: 'list', detailId: peer.id, overlay: 'detail', browsePeek: { [peer.id]: peer } })
  const pending = value.refresh([peer])
  value.updateView({ overlay: null })
  release()
  await pending
  assert.equal(Object.keys(value.getSnapshot().peekQuotes).length, 0, '详情已关闭, 晚到的报价不得留在页面内存')
})

// S1: 路由页保存必须用草稿 providers, 否则新加实例配好的路由会被已保存列表当孤儿剪掉
test('S1 路由页保存保留草稿里新增实例的路由', async () => {
  const { plugin } = await loadPlugin()
  const { settingsSavePayload } = plugin.__testing
  const adapters = [{ adapterId: 'tushare', capabilities: ['quotes'], markets: ['XSHG', 'XSHE'] }]
  const saved = { providers: [{ id: 'old', adapterId: 'tushare', enabled: true, credentialRef: null }], routes: [{ id: 'xshg-quotes', capability: 'quotes', market: 'XSHG', instrument: 'equity', primaryInstanceId: 'old', fallbackInstanceIds: [], failoverMode: 'off', maxDelaySeconds: null, acceptUnknownDelay: true }] }
  const added = { id: 'new', adapterId: 'tushare', enabled: true, credentialRef: null }
  const draft = { providers: [...saved.providers, added], routes: [...saved.routes, { id: 'xshe-quotes', capability: 'quotes', market: 'XSHE', instrument: 'equity', primaryInstanceId: 'new', fallbackInstanceIds: [], failoverMode: 'off', maxDelaySeconds: null, acceptUnknownDelay: true }] }
  const payload = settingsSavePayload('routes', draft, saved, adapters)
  assert.deepEqual([...payload.providers.map(p => p.id)], ['old', 'new'], '新增实例要随路由页一起提交')
  assert.deepEqual([...payload.routes.map(r => r.id)], ['xshg-quotes', 'xshe-quotes'], '新增实例的路由不能被静默丢弃')
})

// S3: 全部证券刷新失败时服务端把带 lastError 的条目放进错误快照, 客户端要留住它
test('S3 刷新失败时详情保留带 lastError 的条目', async () => {
  const peer = { id: 'XSHG:equity:600521', exchange: 'XSHG', code: '600521', officialName: '目录中的另一只' }
  const failed = { quote: null, health: 'error', lastError: { code: 'NETWORK', message: '网络请求失败' }, lastAttemptAt: 7 }
  const errorResponse = { ok: false, status: 502, async json() { return { ok: false, error: { code: 'NETWORK', message: '网络请求失败' }, snapshot: { ...snapshot(2, emptyControl()), quotes: { [peer.id]: failed } } } } }
  const { value } = await runtimeWith(async () => errorResponse)
  value.applySnapshot(snapshot(1, emptyControl()))
  value.updateView({ view: 'list', detailId: peer.id, overlay: 'detail', browsePeek: { [peer.id]: peer } })
  await assert.rejects(value.refresh([peer]), /网络请求失败/)
  const held = value.getSnapshot().peekQuotes[peer.id]
  assert.equal(held?.lastError?.code, 'NETWORK', '失败条目要留在页面, 不能只剩等待')
  // 常驻快照按自选过滤后禁止回写 peek, 但失败条目属于当前详情, 不能被一次轮询抹掉
  value.applySnapshot(snapshot(3, emptyControl()))
  assert.equal(value.getSnapshot().peekQuotes[peer.id]?.lastError?.code, 'NETWORK', '轮询后失败原因仍在')
})

// S10: K线退避等待必须受 dispose 管理, 页面卸载后不能再醒来打请求
test('S10 dispose 清掉K线退避定时器且不再发请求', async () => {
  let calls = 0
  const fetchImpl = async url => {
    if (String(url).includes('/kline?')) { calls++; return { ok: false, status: 502, async json() { return { ok: false, error: { code: 'NETWORK', message: '网络请求失败' } } } } }
    return jsonResponse({ ok: false, error: { code: 'UNEXPECTED', message: String(url) } })
  }
  const { value, clock } = await runtimeWith(fetchImpl)
  value.applySnapshot(snapshot(1, emptyControl()))
  value.loadKline('XSHG:equity:600519', '1d').catch(() => {})
  for (let i = 0; i < 3; i++) await clock.advance(0)
  assert.equal(calls, 1, '首拍发出请求')
  value.dispose()
  for (let i = 0; i < 3; i++) await clock.advance(5000)
  assert.equal(calls, 1, 'dispose 后退避定时器已清, 不得再打请求')
})

// ---- 第四轮 C1-C5 回归 ----

const stripBase = url => String(url).replace('/api/stock-assistant', '')
const hangingFetch = (calls = []) => (url, options = {}) => {
  calls.push(stripBase(url))
  return new Promise((resolve, reject) => {
    // 浏览器在内部超时 abort 后按 AbortError 拒绝 fetch; name/code 与真实 DOMException 对齐
    options.signal.addEventListener('abort', () => reject(Object.assign(new Error('signal is aborted without reason'), { name: 'AbortError', code: 20 })), { once: true })
  })
}

// C1: 草稿 expectedRevision 不能在快照推进后停在旧值, 否则连续 409 且只能丢草稿重进
test('C1 后台快照推进 revision 时草稿基线同步, 保存不再撞 409', async () => {
  const calls = []
  const fetchImpl = async (url, options = {}) => {
    const path = stripBase(url)
    calls.push({ path, body: options.body ? JSON.parse(options.body) : null })
    if (path === '/configuration') return jsonResponse({ ok: true, data: { revision: 3, unchanged: false } })
    return jsonResponse({ ok: false, error: { code: 'UNEXPECTED', message: path } })
  }
  const { value } = await runtimeWith(fetchImpl)
  value.applySnapshot(snapshot(1, emptyControl({ revision: 1 })))
  const providers = [{ id: 'p1', adapterId: 'tushare', enabled: true, credentialRef: null }]
  value.updateView({ overlay: 'settings', settingsDraft: { providers, routes: [], expectedRevision: 1, expandedProvider: 'p1' } })
  // 即改即存(刷新间隔/悬浮刷新)或外部页面写推进 revision 后, 后台快照到达
  value.applySnapshot(snapshot(2, emptyControl({ revision: 2 })))
  const draft = value.getSnapshot().view.settingsDraft
  assert.equal(draft.expectedRevision, 2, '草稿基线跟随快照 revision')
  assert.equal(draft.expandedProvider, 'p1', '草稿内容原样保留')
  await value.configuration({ providers: draft.providers, routes: draft.routes })
  assert.equal(calls.find(call => call.path === '/configuration').body.expectedRevision, 2, '保存使用同步后的基线')
  value.dispose()
})

// C1: 没有快照兜底时, 409 响应带回的 revision 也必须立刻成为草稿新基线
test('C1 保存 409 后推进草稿基线, 再点保存直接成功', async () => {
  const calls = []
  let attempts = 0
  const fetchImpl = async (url, options = {}) => {
    const path = stripBase(url)
    if (path !== '/configuration') return jsonResponse({ ok: false, error: { code: 'UNEXPECTED', message: path } })
    attempts++
    calls.push(JSON.parse(options.body))
    if (attempts === 1) return { ok: false, status: 409, async json() { return { ok: false, error: { code: 'REVISION_CONFLICT', message: '数据已被其他页面修改，请重新确认', revision: 4 } } } }
    return jsonResponse({ ok: true, data: { revision: 5, unchanged: false } })
  }
  const { value } = await runtimeWith(fetchImpl)
  value.applySnapshot(snapshot(1, emptyControl({ revision: 1 })))
  const providers = [{ id: 'p1', adapterId: 'tushare', enabled: true, credentialRef: null }]
  value.updateView({ overlay: 'settings', settingsDraft: { providers, routes: [], expectedRevision: 1, expandedProvider: 'p1' } })
  await assert.rejects(value.configuration({ providers, routes: [] }), /数据已被其他页面修改/)
  const draft = value.getSnapshot().view.settingsDraft
  assert.equal(draft.expectedRevision, 4, '409 带回的服务端 revision 成为新基线')
  assert.equal(draft.providers[0].id, 'p1', '失败不丢草稿内容')
  assert.equal(value.getSnapshot().errorCode, 'REVISION_CONFLICT')
  await value.configuration({ providers: draft.providers, routes: draft.routes })
  assert.deepEqual(calls.map(body => body.expectedRevision), [1, 4], '第二次保存用 409 带回的基线')
  assert.equal(value.getSnapshot().error, '', '重试成功清掉 409 横幅')
  assert.equal(value.getSnapshot().errorCode, '', 'errorCode 与 error 同生命周期')
  value.dispose()
})

// C2: 操作错误的生命周期与数据面刷新解耦
test('C2 数据快照与无关操作不清操作错误, 用户关闭才清', async () => {
  const fetchImpl = async url => {
    const path = stripBase(url)
    if (path === '/watchlist') return { ok: false, status: 409, async json() { return { ok: false, error: { code: 'REVISION_CONFLICT', message: '数据已被其他页面修改，请重新确认' } } } }
    if (path.startsWith('/browse')) return jsonResponse({ ok: true, data: { syncing: false, total: 0, items: [] } })
    return jsonResponse({ ok: false, error: { code: 'UNEXPECTED', message: path } })
  }
  const { value } = await runtimeWith(fetchImpl)
  value.applySnapshot(snapshot(1, emptyControl()))
  await assert.rejects(value.mutate('add', { securityId: 'XSHG:equity:600519' }), /数据已被其他页面修改/)
  assert.equal(value.getSnapshot().error, '数据已被其他页面修改，请重新确认')
  value.applySnapshot(snapshot(2, emptyControl({ revision: 2 })))
  assert.equal(value.getSnapshot().error, '数据已被其他页面修改，请重新确认', '后台快照落地不清操作错误')
  assert.equal(value.getSnapshot().errorCode, 'REVISION_CONFLICT', '快照也不单独清 errorCode')
  await value.loadBrowse('XSHG', 0)
  assert.equal(value.getSnapshot().error, '数据已被其他页面修改，请重新确认', '无关操作成功不清别的动作的错误')
  value.clearError()
  assert.equal(value.getSnapshot().error, '')
  assert.equal(value.getSnapshot().errorCode, '')
  value.dispose()
})

// C2: 后台快照失败是数据面错误, 不能覆盖操作错误, 也不该永久驻留
test('C2 后台快照错误独立自愈, 不与操作错误互相清除', async () => {
  let snapshotCalls = 0
  const fetchImpl = async url => {
    const path = stripBase(url)
    if (path === '/snapshot') {
      snapshotCalls++
      if (snapshotCalls === 1) return { ok: false, status: 503, async json() { return { ok: false, error: { code: 'STORAGE', message: '服务暂时不可用' } } } }
      return jsonResponse({ ok: true, data: snapshot(3, emptyControl({ revision: 3 })) })
    }
    if (path === '/watchlist') return { ok: false, status: 409, async json() { return { ok: false, error: { code: 'REVISION_CONFLICT', message: '数据已被其他页面修改，请重新确认' } } } }
    return jsonResponse({ ok: false, error: { code: 'UNEXPECTED', message: path } })
  }
  const { value, pull } = await runtimeWith(fetchImpl)
  value.applySnapshot(snapshot(1, emptyControl()))
  await assert.rejects(value.mutate('add', { securityId: 'XSHG:equity:600519' }))
  await pull()
  assert.equal(value.getSnapshot().dataError, '服务暂时不可用')
  assert.equal(value.getSnapshot().error, '数据已被其他页面修改，请重新确认', '数据面失败不改写操作错误')
  await pull()
  assert.equal(value.getSnapshot().dataError, '', '下一次快照成功即自愈')
  assert.equal(value.getSnapshot().error, '数据已被其他页面修改，请重新确认', '数据面自愈不清操作错误')
  value.dispose()
})

// C2: 两条横幅互不覆盖, 各自有独立关闭入口
test('C2 操作错误与数据面错误分别渲染并各自可关闭', async () => {
  const { plugin } = await loadPlugin()
  const state = { view: { view: 'list', query: '', selectedId: null, sort: 'manual', alias: '' }, busy: {}, candidates: [], composing: false, undo: null, error: '数据已被其他页面修改，请重新确认', errorCode: 'REVISION_CONFLICT', errorKey: 'write', dataError: '服务暂时不可用', paused: false, data: { control: { revision: 1, watchlist: { order: [], items: {} }, preferences: {} }, quotes: {}, adapters: [], providerStatus: [], catalogs: [], routeSelections: {}, vendorAvailable: false } }
  const runtimeStub = { getSnapshot: () => state, subscribe: () => () => {}, updateView() {}, clearError() {}, clearDataError() {}, refresh: async () => {}, mutate: async () => {} }
  const html = renderToStaticMarkup(React.createElement(plugin.__testing.StockPage, { runtime: runtimeStub, layout: {} }))
  assert.match(html, /数据已被其他页面修改/)
  assert.match(html, /服务暂时不可用/)
  assert.equal((html.match(/关闭<\/button>/g) || []).length, 2, '两条横幅各有关闭按钮')
  assert.match(html, /class="ssb-banner ssb-error" role="alert">服务暂时不可用/, '数据面错误留在文档流, 不占用浮层之上的固定坐标')
})

// C3: errorCode 必须与 error 同生命周期, 成功搜索后不能残留“目录未就绪”横幅
test('C3 搜索成功清 errorCode, 与 error 同生命周期', async () => {
  let searchCalls = 0
  const fetchImpl = async url => {
    const path = stripBase(url)
    if (!path.startsWith('/search')) return jsonResponse({ ok: false, error: { code: 'UNEXPECTED', message: path } })
    searchCalls++
    if (searchCalls === 1) return { ok: false, status: 422, async json() { return { ok: false, error: { code: 'CATALOG_NOT_READY', message: '目录未就绪，请先在设置中配置目录来源或搜索来源并同步' } } } }
    return jsonResponse({ ok: true, data: { items: [{ id: 'XSHG:equity:600519', exchange: 'XSHG', code: '600519', officialName: '贵州茅台' }], routingRevision: 0 } })
  }
  const { value, clock } = await runtimeWith(fetchImpl)
  value.applySnapshot(snapshot(1, emptyControl()))
  value.search('茅台')
  await clock.advance(400)
  assert.equal(value.getSnapshot().errorCode, 'CATALOG_NOT_READY')
  value.applySnapshot(snapshot(2, emptyControl({ revision: 2 })))
  assert.equal(value.getSnapshot().errorCode, 'CATALOG_NOT_READY', '快照落地不单独清 errorCode')
  assert.match(value.getSnapshot().error, /目录未就绪/)
  value.search('茅台')
  await clock.advance(400)
  const state = value.getSnapshot()
  assert.equal(state.error, '', '同类搜索成功后清错误')
  assert.equal(state.errorCode, '', 'errorCode 与 error 同生命周期')
  assert.equal(state.candidates.length, 1)
  value.dispose()
})

// C4: 两个保存按钮载荷必须分离; 数据源页不提交市场页里未保存的路由删除
test('C4 数据源页与路由页保存语义分离', async () => {
  const { plugin } = await loadPlugin()
  const { settingsSavePayload } = plugin.__testing
  const adapters = [{ adapterId: 'eastmoney', capabilities: ['quotes', 'kline', 'catalog'], markets: ['XSHG'] }]
  const route = id => ({ id, capability: 'quotes', market: 'XSHG', instrument: 'equity', primaryInstanceId: 'p1', fallbackInstanceIds: [], failoverMode: 'off', maxDelaySeconds: null, acceptUnknownDelay: true })
  const provider = { id: 'p1', adapterId: 'eastmoney', enabled: true, credentialRef: null, budget: { requestsPerMinute: 60 } }
  const saved = { providers: [provider], routes: [route('xshg-quotes')], revision: 1 }
  // 用户先到「市场与能力」删掉草稿路由(未保存), 回「数据源」只改实例限额
  const draft = { providers: [{ ...provider, budget: { requestsPerMinute: 30 } }], routes: [], expectedRevision: 1 }
  const sources = settingsSavePayload('sources', draft, saved, adapters)
  assert.deepEqual(sources.routes.map(item => item.id), ['xshg-quotes'], '数据源页不提交未保存的草稿路由删除')
  assert.equal(sources.providers[0].budget.requestsPerMinute, 30, '实例改动照常保存')
  assert.deepEqual(settingsSavePayload('routes', draft, saved, adapters).routes, [], '路由页才落实路由删除')
  // 禁用实例: 数据源页仍须剪掉已保存路由里的悬空引用, 否则服务端必拒整次保存
  const disabled = { providers: [{ ...provider, enabled: false }], routes: [], expectedRevision: 1 }
  assert.deepEqual(settingsSavePayload('sources', disabled, saved, adapters).routes, [], '禁用实例后剪除引用它的已保存路由')
})

// C5: 内部 11s 超时 abort 的是客户端自己的控制器, 必须折算成中文可重试错误
test('C5 请求超时映射中文错误且带 TIMEOUT', async () => {
  const { value, clock } = await runtimeWith(hangingFetch())
  value.applySnapshot(snapshot(1, emptyControl()))
  const flight = value.refresh()
  const expectation = assert.rejects(() => flight, error => error.code === 'TIMEOUT' && error.message === '请求超时，请重试')
  await clock.advance(11 * 1000)
  await expectation
  assert.equal(value.getSnapshot().error, '请求超时，请重试')
  assert.equal(value.getSnapshot().errorCode, 'TIMEOUT')
  assert.doesNotMatch(value.getSnapshot().error, /abort/i, '不把英文 AbortError 直出给用户')
  value.dispose()
})

// 时限同源: 客户端按快照里的服务端预算加 1 秒裕度, 不能自己先掐断服务端还能等到的结果
test('C5 普通路由时限取服务端预算加裕度, 快照没带时才用兜底值', async () => {
  const { value, clock } = await runtimeWith(hangingFetch())
  value.applySnapshot({ ...snapshot(1, emptyControl()), timeouts: { route: 20 * 1000 } })
  const flight = value.refresh()
  let settled = false
  flight.finally(() => { settled = true }).catch(() => {})
  const expectation = assert.rejects(() => flight, error => error.code === 'TIMEOUT')
  await clock.advance(11 * 1000)
  assert.equal(settled, false, '11 秒是兜底值, 有服务端预算时不能在这里超时')
  await clock.advance(9 * 1000)
  assert.equal(settled, false, '预算内(20 秒)仍要在等')
  await clock.advance(1 * 1000)
  await expectation
  assert.equal(value.getSnapshot().errorCode, 'TIMEOUT')
  value.dispose()
})

// C5: 超时属于可退避错误, K线首拍超时后要退避重试一次再落错误
test('C5 K线超时按可退避错误重试一次后落中文错误', async () => {
  const calls = []
  const { value, clock } = await runtimeWith(hangingFetch(calls))
  value.applySnapshot({ ...snapshot(1, emptyControl()), vendorAvailable: true, klineReady: { XSHG: true } })
  const flight = value.loadKline('XSHG:equity:600519', '1d')
  const expectation = assert.rejects(() => flight, error => error.code === 'TIMEOUT' && error.message === '请求超时，请重试')
  // K线首拍经 0ms 调度器发出: 先让请求真正起步, 否则时钟先跳会把 11s 超时定时器注册到未来
  await clock.advance(0)
  assert.equal(calls.length, 1, '首拍发出')
  await clock.advance(11 * 1000)
  assert.equal(calls.length, 1, '首拍超时')
  await clock.advance(4 * 1000)
  assert.equal(calls.length, 2, '超时归入可退避错误, 重试一次')
  await clock.advance(11 * 1000)
  await expectation
  const kline = value.getSnapshot().kline
  assert.equal(kline.error, '请求超时，请重试')
  assert.equal(kline.errorCode, 'TIMEOUT')
  assert.equal(calls.length, 2, '只重试一次')
  value.dispose()
})

// ---- 第四轮第 2 轮复审 R2 回归 ----

// R2: 页面重置主动 abort 在飞请求, 不能把英文 AbortError 当成故障写进界面
test('R2 外部取消不直出英文 AbortError, K线给中文取消提示', async () => {
  const { value, clock, reset, pull } = await runtimeWith(hangingFetch())
  value.applySnapshot({ ...snapshot(1, emptyControl()), vendorAvailable: true, klineReady: { XSHG: true } })
  // 普通写操作: 取消是生命周期事件, 静默失败
  const flight = value.refresh()
  const expectation = assert.rejects(() => flight, error => error.code === 'CANCELLED' && error.cancelled === true)
  await clock.advance(0)
  reset()
  await expectation
  assert.equal(value.getSnapshot().error, '', '外部取消不产生错误横幅')
  assert.equal(value.getSnapshot().errorCode, '')
  // 后台快照: 被取消不算数据面故障
  const snapshotFlight = pull()
  await clock.advance(0)
  reset()
  await snapshotFlight
  assert.equal(value.getSnapshot().dataError, '', '被取消的快照不挂数据面错误')
  // K线: 取消要变成可重试的中文状态
  const klineFlight = value.loadKline('XSHG:equity:600519', '1d')
  const klineExpectation = assert.rejects(() => klineFlight, error => error.code === 'CANCELLED')
  await clock.advance(0)
  reset()
  await klineExpectation
  const kline = value.getSnapshot().kline
  assert.equal(kline.loading, false)
  assert.equal(kline.error, '请求已取消，请重试')
  assert.equal(kline.errorCode, 'CANCELLED')
  assert.doesNotMatch(kline.error, /abort/i, '不把英文 AbortError 直出给用户')
  value.dispose()
})

// R2: configuration 成功后必须按响应 revision 前推本地版本, 连续保存不再拿旧基线
test('R2 configuration 成功后按响应 revision 前推本地版本', async () => {
  const calls = []
  const revisions = [5, 6, 7]
  const fetchImpl = async (url, options = {}) => {
    const path = stripBase(url)
    if (path !== '/configuration') return jsonResponse({ ok: false, error: { code: 'UNEXPECTED', message: path } })
    calls.push(JSON.parse(options.body))
    return jsonResponse({ ok: true, data: { revision: revisions.shift(), unchanged: false } })
  }
  const { value } = await runtimeWith(fetchImpl)
  value.applySnapshot(snapshot(1, emptyControl({ revision: 4 })))
  const providers = [{ id: 'p1', adapterId: 'tushare', enabled: true, credentialRef: null }]
  await value.configuration({ providers, routes: [] })
  assert.equal(value.getSnapshot().data.control.revision, 5, '本地版本立即前推, 不等快照')
  await value.configuration({ providers, routes: [] })
  assert.deepEqual(calls.map(body => body.expectedRevision), [4, 5], '第二次保存用响应里的新版本')
  assert.equal(value.getSnapshot().data.control.revision, 6)
  // 推荐配置/一键补全直连 api 的路径同样前推, 紧接着保存不撞 409
  await value.commitConfiguration({ providers: [], routes: [], notice: '已应用推荐配置' })
  assert.deepEqual(calls.map(body => body.expectedRevision), [4, 5, 6])
  assert.equal(value.getSnapshot().data.control.revision, 7)
  value.dispose()
})

// R2: 数据源页只提交实例, 不能把市场/能力页里未提交的路由草稿一起清掉
test('R2 数据源保存保留路由草稿, 路由页保存才清整份草稿', async () => {
  const fetchImpl = async (url, options = {}) => {
    const path = stripBase(url)
    if (path !== '/configuration') return jsonResponse({ ok: false, error: { code: 'UNEXPECTED', message: path } })
    return jsonResponse({ ok: true, data: { revision: JSON.parse(options.body).expectedRevision + 1, unchanged: false } })
  }
  const { value } = await runtimeWith(fetchImpl)
  value.applySnapshot(snapshot(1, emptyControl({ revision: 1 })))
  const providers = [{ id: 'p1', adapterId: 'tushare', enabled: true, credentialRef: null }]
  const draftRoute = { id: 'xshg-quotes', capability: 'quotes', market: 'XSHG', instrument: 'equity', primaryInstanceId: 'p1', fallbackInstanceIds: [], failoverMode: 'off', maxDelaySeconds: null, acceptUnknownDelay: true }
  value.updateView({ overlay: 'settings', settingsDraft: { providers, routes: [draftRoute], expectedRevision: 1, expandedMarket: 'XSHG', probes: { 'p1:quotes:XSHG': { status: 'ready' } } } })
  // 数据源页载荷只含实例与已保存路由; 未保存的路由编辑不在本次提交里
  await value.configuration({ providers, routes: [] }, { keepRoutes: true })
  const draft = value.getSnapshot().view.settingsDraft
  assert.ok(draft, '数据源保存后草稿仍在')
  assert.deepEqual(draft.routes, [draftRoute], '未提交的路由草稿不得被清掉')
  assert.equal(draft.expectedRevision, 2, '草稿基线按响应前推')
  assert.equal(draft.expandedMarket, 'XSHG', '展开态保留')
  // 路由页保存提交整份草稿, 成功后才整份清掉
  await value.configuration({ providers, routes: draft.routes })
  assert.equal(value.getSnapshot().view.settingsDraft, null)
  value.dispose()
})

// ---- 第四轮第 3 轮复审 R3-stock 回归 ----

// C3-2: 迟到 409/慢响应不能把已推进的草稿基线拉回; 宿主换代才按新实例 revision 重定基
test('R3 草稿基线只前进, 只有宿主换代才重定基', async () => {
  const fetchImpl = async url => {
    const path = stripBase(url)
    if (path === '/configuration') return { ok: false, status: 409, async json() { return { ok: false, error: { code: 'REVISION_CONFLICT', message: '数据已被其他页面修改，请重新确认', revision: 5 } } } }
    return jsonResponse({ ok: false, error: { code: 'UNEXPECTED', message: path } })
  }
  const { value } = await runtimeWith(fetchImpl)
  value.applySnapshot(snapshot(1, emptyControl({ revision: 5 })))
  const providers = [{ id: 'p1', adapterId: 'tushare', enabled: true, credentialRef: null }]
  value.updateView({ overlay: 'settings', settingsDraft: { providers, routes: [], expectedRevision: 6, epoch: 'a' } })
  await assert.rejects(value.configuration({ providers, routes: [] }), /数据已被其他页面修改/)
  let draft = value.getSnapshot().view.settingsDraft
  assert.equal(draft.expectedRevision, 6, '409 带回更低的 revision 也不得把基线拉回')
  // 宿主换代: 新 serverEpoch 下旧 revision 没有意义, 必须按新实例重定基
  value.applySnapshot({ ...snapshot(1, emptyControl({ revision: 0 })), serverEpoch: 'b' })
  draft = value.getSnapshot().view.settingsDraft
  assert.equal(draft.expectedRevision, 0, '换代后按新实例 revision 重定基')
  assert.equal(draft.epoch, 'b')
  value.dispose()
})

// C3-2/C3-3: 保存响应 revision 落后于保存期间到达的快照时, 不得回退基线
test('R3 保存响应不回退并发快照已推进的基线', async () => {
  let release
  const fetchImpl = () => new Promise(resolve => { release = () => resolve(jsonResponse({ ok: true, data: { revision: 5, unchanged: false } })) })
  const { value } = await runtimeWith(fetchImpl)
  value.applySnapshot(snapshot(1, emptyControl({ revision: 4 })))
  const providers = [{ id: 'p1', adapterId: 'tushare', enabled: true, credentialRef: null }]
  value.updateView({ overlay: 'settings', settingsDraft: { providers, routes: [], expectedRevision: 4, epoch: 'a' } })
  const flight = value.configuration({ providers, routes: [] }, { keepRoutes: true })
  // 保存期间另一页面写入: 快照把草稿基线推到 6
  value.applySnapshot(snapshot(2, emptyControl({ revision: 6 })))
  assert.equal(value.getSnapshot().view.settingsDraft.expectedRevision, 6)
  release()
  await flight
  assert.equal(value.getSnapshot().view.settingsDraft.expectedRevision, 6, '响应 revision 5 不得覆盖已推进的 6')
  assert.equal(value.getSnapshot().data.control.revision, 6, 'control revision 同样不回退')
  value.dispose()
})

// C3-3: keepRoutes 成功处理不能拿点击时闭包里的 providers/routes 覆盖保存期间的新输入
test('R3 数据源保存在飞期间的新编辑不被点击时快照覆盖', async () => {
  let release
  const fetchImpl = () => new Promise(resolve => { release = () => resolve(jsonResponse({ ok: true, data: { revision: 2, unchanged: false } })) })
  const { value } = await runtimeWith(fetchImpl)
  value.applySnapshot(snapshot(1, emptyControl({ revision: 1 })))
  const clickProviders = [{ id: 'p1', adapterId: 'tushare', enabled: true, credentialRef: null }]
  const clickRoute = { id: 'xshg-quotes', capability: 'quotes', market: 'XSHG', instrument: 'equity', primaryInstanceId: 'p1', fallbackInstanceIds: [], failoverMode: 'off', maxDelaySeconds: null, acceptUnknownDelay: true }
  value.updateView({ overlay: 'settings', settingsDraft: { providers: clickProviders, routes: [clickRoute], expectedRevision: 1, epoch: 'a' } })
  const flight = value.configuration({ providers: clickProviders, routes: [] }, { keepRoutes: true })
  // 保存期间用户继续编辑: 新增实例与路由
  const newerProviders = [...clickProviders, { id: 'p2', adapterId: 'eastmoney', enabled: true, credentialRef: null }]
  const newerRoutes = [clickRoute, { ...clickRoute, id: 'xshe-quotes', market: 'XSHE', primaryInstanceId: 'p2' }]
  value.updateView({ settingsDraft: { ...value.getSnapshot().view.settingsDraft, providers: newerProviders, routes: newerRoutes } })
  release()
  await flight
  const draft = value.getSnapshot().view.settingsDraft
  assert.deepEqual(draft.providers, newerProviders, '在飞期间新增的实例不得被点击时快照覆盖')
  assert.deepEqual(draft.routes, newerRoutes, '在飞期间的路由编辑不得被清掉')
  assert.equal(draft.expectedRevision, 2)
  value.dispose()
})

// C3-4: 自选与偏好共用一个写锁, 但错误横幅必须各自独立
test('R3 自选与偏好的错误横幅互不清除', async () => {
  const flags = { prefFail: true, watchFail: true }
  const fetchImpl = async url => {
    const path = stripBase(url)
    if (path === '/preferences') return flags.prefFail
      ? { ok: false, status: 503, async json() { return { ok: false, error: { code: 'STORAGE', message: '偏好保存失败' } } } }
      : jsonResponse({ ok: true, data: { revision: 3, unchanged: false } })
    if (path === '/watchlist') return flags.watchFail
      ? { ok: false, status: 503, async json() { return { ok: false, error: { code: 'STORAGE', message: '自选保存失败' } } } }
      : jsonResponse({ ok: true, data: { revision: 4, unchanged: false } })
    return jsonResponse({ ok: false, error: { code: 'UNEXPECTED', message: path } })
  }
  const { value } = await runtimeWith(fetchImpl)
  value.applySnapshot(snapshot(1, emptyControl({ revision: 2 })))
  // 偏好失败 → 自选成功, 不得清偏好横幅
  await assert.rejects(value.preferences({ refreshSeconds: 30 }), /偏好保存失败/)
  assert.equal(value.getSnapshot().error, '偏好保存失败')
  flags.watchFail = false
  await value.mutate('add', { securityId: 'XSHG:equity:600519' })
  assert.equal(value.getSnapshot().error, '偏好保存失败', '自选成功不得清偏好失败')
  // 偏好重试成功清掉自己
  flags.prefFail = false
  await value.preferences({ refreshSeconds: 30 })
  assert.equal(value.getSnapshot().error, '')
  // 自选失败 → 偏好成功, 不得清自选横幅
  flags.watchFail = true
  await assert.rejects(value.mutate('add', { securityId: 'XSHG:equity:600519' }), /自选保存失败/)
  assert.equal(value.getSnapshot().error, '自选保存失败')
  await value.preferences({ refreshSeconds: 20 })
  assert.equal(value.getSnapshot().error, '自选保存失败', '偏好成功不得清自选失败')
  value.dispose()
})
