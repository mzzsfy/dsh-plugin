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

// 灌图策略是这条链上唯一连续阻断过一轮的判断, 抽成纯函数后在这里锁死三种迁移
test('灌图计划: 空壳不记 key, 首次进 key 才重置视口', async () => {
  const { klineShipPlan } = await load()
  // vm 里返回的对象原型属于另一个 realm, 摊平后再比较
  const planOf = (shipped, key, hasData) => { const plan = klineShipPlan(shipped, key, hasData); return { fit: plan.fit, next: plan.next } }
  // 空壳: 清屏但不重置、也不记 key, 否则真数据回来时 fit 被吃掉
  assert.deepEqual(planOf(null, 'A|1d', false), { fit: false, next: null })
  assert.deepEqual(planOf('B|1d', 'A|1d', false), { fit: false, next: 'B|1d' })
  // 首次看到该 key: 重置视口并记下
  assert.deepEqual(planOf(null, 'A|1d', true), { fit: true, next: 'A|1d' })
  assert.deepEqual(planOf('B|1d', 'A|1d', true), { fit: true, next: 'A|1d' })
  // 同一 key 下数据刷新(手动↻): 保留用户缩放
  assert.deepEqual(planOf('A|1d', 'A|1d', true), { fit: false, next: 'A|1d' })
})

// 拉取、校验、灌图必须共用同一个拼法, 否则校验永远对不上
test('klineKeyOf 对不同标的与周期给出不同键', async () => {
  const { klineKeyOf } = await load()
  assert.equal(klineKeyOf('XSHG:equity:600519', '1d'), 'XSHG:equity:600519|1d')
  assert.notEqual(klineKeyOf('XSHG:equity:600519', '1d'), klineKeyOf('XSHG:equity:600519', '1w'))
  assert.notEqual(klineKeyOf('XSHG:equity:600519', '1d'), klineKeyOf('XSHG:equity:000300', '1d'))
})

// 新增一条打开详情的路径时不该还需要记得带 alias, 否则不动输入框直接保存就会把已存别名写成空串
test('换详情时自动回填该标的已保存的别名', async () => {
  const { createPageRuntime } = await load()
  const runtime = createPageRuntime({
    layout: { panelInfo: { getSnapshot: () => ({}), subscribe: () => () => {} }, selectPanel() {} },
    bus: { subscribe: () => () => {}, publish() {} },
    tools: { createSnapshotRefresh: () => ({ refresh() {}, dispose() {} }) },
    document: { addEventListener() {}, removeEventListener() {} },
    fetch: async () => ({ ok: true, json: async () => ({ ok: true, data: snapshotOf({}) }) }),
  })
  const a = { ...securityOf('XSHG:equity:600519', '600519'), alias: '茅台' }
  const b = securityOf('XSHG:equity:000300', '000300')
  runtime.applySnapshot(snapshotOf({ [a.id]: a, [b.id]: b }))
  runtime.updateView({ detailId: a.id, overlay: 'detail' })
  assert.equal(runtime.getSnapshot().view.alias, '茅台')
  // 切到没有别名的标的应清空, 而不是留着上一只的别名
  runtime.updateView({ detailId: b.id })
  assert.equal(runtime.getSnapshot().view.alias, '')
  // 调用方显式传 alias 时以调用方为准
  runtime.updateView({ detailId: a.id, alias: '用户正在改' })
  assert.equal(runtime.getSnapshot().view.alias, '用户正在改')
  runtime.dispose()
})

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
  runtime.updateView({ markDraft: { kind: 'cost', price: '422' }, groupDraft: '科技', markError: '错', groupError: '错' })
  assert.equal(runtime.getSnapshot().view.markDraft.price, '422')
  // 同一只再写一次草稿: detailId 没变, 草稿不能被清掉
  runtime.updateView({ markDraft: { kind: 'cost', price: '430' } })
  assert.equal(runtime.getSnapshot().view.markDraft.price, '430')
  // 显式重复传同一个 detailId(键盘导航会这么做)同样不该清
  runtime.updateView({ detailId: 'A', markDraft: { kind: 'cost', price: '440' } })
  assert.equal(runtime.getSnapshot().view.markDraft.price, '440')
  // 换到 B: 四个草稿字段全部归零
  runtime.updateView({ detailId: 'B' })
  const view = runtime.getSnapshot().view
  assert.deepEqual({ markDraft: view.markDraft, groupDraft: view.groupDraft, markError: view.markError, groupError: view.groupError }, { markDraft: null, groupDraft: null, markError: null, groupError: null })
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
  // 正向确认 refresh 真的发出去了, 否则下面那条"没有 /kline"会恒真而无意义
  assert.ok(calls.some(([, path]) => path.endsWith('/refresh')), 'openDetail 应请求报价快照')
  // K 线由 KlineView 的加载 effect 负责, openDetail 不重复发
  assert.equal(calls.filter(([, path]) => path.endsWith('/kline')).length, 0, 'openDetail 不应预载 K 线')
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

// 失败分支和成功分支必须守同一条不变式: 上一只的失败晚到时不能把当前这只清成错误态
test('标的变化后到达的 K 线失败不清空当前标的的数据', async () => {
  const { createPageRuntime } = await load()
  let pending = 0, rejectA, resolveB
  const runtime = createPageRuntime({
    layout: { panelInfo: { getSnapshot: () => ({}), subscribe: () => () => {} }, selectPanel() {} },
    bus: { subscribe: () => () => {}, publish() {} },
    tools: { createSnapshotRefresh: () => ({ refresh() {}, dispose() {} }) },
    document: { addEventListener() {}, removeEventListener() {} },
    fetch: () => ++pending === 1 ? new Promise((_, reject) => { rejectA = reject }) : new Promise(resolve => { resolveB = resolve }),
  })
  const first = runtime.loadKline('A', '1d').catch(() => {})
  // 让 A 的请求先真的发出去: 换代后到点的请求会被代际直接拦下, 那样就测不到「失败禁止落地」这条
  await new Promise(resolve => setTimeout(resolve, 10))
  const second = runtime.loadKline('B', '1d').catch(() => {})
  // loadKline 内部先等一拍再发请求, 同步取不到 resolve 句柄
  await new Promise(resolve => setTimeout(resolve, 20))
  resolveB({ ok: true, json: async () => ({ ok: true, data: { candles: [{ time: '2026-11-06', open: 2, high: 2, low: 2, close: 2 }] } }) })
  await second
  assert.equal(runtime.getSnapshot().kline?.candles?.length, 1)
  // A 在 B 成功之后才失败: key 对不上, 不应把 B 已加载的数据清成错误态
  rejectA(Object.assign(new Error('未配置该市场的数据来源'), { code: 'NO_ROUTE' }))
  await first
  const after = runtime.getSnapshot()
  assert.equal(after.kline?.candles?.length, 1, 'B 的数据应保留')
  assert.equal(after.kline?.error, '', 'A 的错误不该写到 B 上')
  runtime.dispose()
})

// 同一标的上连点刷新会并发两个同 key 请求, 先发的后到时不能盖掉后发的
test('同 key 并发只让最后一次请求的结果落地', async () => {
  const { createPageRuntime } = await load()
  let pending = 0
  const releases = []
  const runtime = createPageRuntime({
    layout: { panelInfo: { getSnapshot: () => ({}), subscribe: () => () => {} }, selectPanel() {} },
    bus: { subscribe: () => () => {}, publish() {} },
    tools: { createSnapshotRefresh: () => ({ refresh() {}, dispose() {} }) },
    document: { addEventListener() {}, removeEventListener() {} },
    fetch: () => { const index = ++pending; return new Promise(resolve => releases.push(() => resolve({ ok: true, json: async () => ({ ok: true, data: { candles: [{ time: '2026-11-06', open: index, high: index, low: index, close: index }] } }) }))) },
  })
  const first = runtime.loadKline('A', '1d').catch(() => {})
  // 先让第一个请求真的发出(退避到点前会被代际拦下, 这是有意的省流)
  await new Promise(resolve => setTimeout(resolve, 10))
  const second = runtime.loadKline('A', '1d').catch(() => {})
  await new Promise(resolve => setTimeout(resolve, 20))
  // 后发的先回, 先发的后回
  releases[1]()
  await second
  releases[0]()
  await first
  const after = runtime.getSnapshot()
  assert.equal(after.kline?.candles?.[0]?.close, 2, '应是后发请求的数据')
  runtime.dispose()
})

// 反向顺序: 被代际淘汰的旧请求失败时不能把新请求已经落地的数据清掉
test('同 key 并发: 先发的请求失败时不覆盖后发的成功结果', async () => {
  const { createPageRuntime } = await load()
  const releases = []
  const runtime = createPageRuntime({
    layout: { panelInfo: { getSnapshot: () => ({}), subscribe: () => () => {} }, selectPanel() {} },
    bus: { subscribe: () => () => {}, publish() {} },
    tools: { createSnapshotRefresh: () => ({ refresh() {}, dispose() {} }) },
    document: { addEventListener() {}, removeEventListener() {} },
    fetch: () => new Promise((resolve, reject) => releases.push({ resolve, reject })),
  })
  const first = runtime.loadKline('A', '1d').catch(() => {})
  await new Promise(resolve => setTimeout(resolve, 10))
  const second = runtime.loadKline('A', '1d').catch(() => {})
  await new Promise(resolve => setTimeout(resolve, 20))
  releases[1].resolve({ ok: true, json: async () => ({ ok: true, data: { candles: [{ time: '2026-11-06', open: 2, high: 2, low: 2, close: 2 }] } }) })
  await second
  // 先发的那个随后失败, 此时它已被淘汰。用不可重试的错误码, 否则破坏代际后会走 4s 退避把测试挂住
  releases[0].reject(Object.assign(new Error('无可用数据源'), { code: 'NO_ROUTE' }))
  await first
  const after = runtime.getSnapshot()
  assert.equal(after.kline?.candles?.[0]?.close, 2, '成功结果应保留')
  assert.equal(after.kline?.error || '', '', '淘汰的失败不该写错误')
  runtime.dispose()
})
