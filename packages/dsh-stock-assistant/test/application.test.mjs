import test from 'node:test'
import assert from 'node:assert/strict'
import { createApplication } from '../src/application.mjs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import { JsonStorageBackend } from '@deepseek-ai/dsh-storage-json'
import { openState } from '../src/state.mjs'
import { initialControl } from '../src/schemas.mjs'
import { memoryStorage, operation } from './helpers.mjs'
import { provider, route } from './helpers.mjs'
import { makeSecurity, StockError } from '../src/market-model.mjs'
const security = makeSecurity('XSHG', '600519', '贵州茅台')
const fake = { descriptor: { adapterId: 'fake', capabilities: ['quotes', 'catalog', 'calendar'], markets: ['XSHG', 'XSHE'], instruments: ['equity'], maxQuoteBatch: 20 }, async probe(request) { return { status: 'ready', capability: request.capability } }, async catalog() { return { items: [security], complete: true } }, async calendar() { return { items: [] } }, async quotes() { return { items: [{ securityId: security.id, providerInstanceId: 'ts-one', last: '10.00', previousClose: '8.00', receivedAt: 100, quoteAt: null, delayKind: 'unknown' }] } } }
test('P04/P13 配置检查摘要匹配后落独立域，目录源可供标准自选查价', async () => {
  let now = 1000
  const app = await createApplication({ storageDomain: memoryStorage(), providers: [fake], env: { DSH_STOCK_TUSHARE_TOKEN: 'fake' }, now: () => now })
  const config = { providers: [provider('ts-one', 'fake')], routes: [route(), route('ts-one', 'XSHG', 'catalog')] }
  const checked = await app.providerCheck({ ...config, capabilities: ['quotes'] })
  assert.equal(checked.checks[0].status, 'ready')
  now += 1000
  const checkedCatalog = await app.providerCheck({ ...config, capabilities: ['catalog'] })
  await app.configuration({ ...operation(), payload: config, checkIds: [checked.checkId, checkedCatalog.checkId] })
  assert.equal(app.snapshot().control.routingRevision, 1)
  assert.equal(JSON.stringify(app.snapshot()).includes('"fake"'), true)
  assert.equal(JSON.stringify(app.snapshot()).includes('"token"'), false)
  // 增量合同: 清空路由无验证目标, 保存直通(删路由永远无害)
  const emptied = await app.configuration({ ...operation(2, 1), payload: { ...config, routes: [] }, checkIds: [checked.checkId] })
  assert.equal(emptied.routes, undefined)
  assert.equal(app.snapshot().control.routes.length, 0)
  // 恢复路由(重新检查后保存, 覆盖 replay 分支前置态)
  const rechecked = await app.providerCheck({ ...config, capabilities: ['quotes', 'catalog'] })
  void rechecked
  const restored = { ...config, providers: [{ ...config.providers[0] }] }
  now += 1000
  const recheckQuotes = await app.providerCheck({ ...restored, capabilities: ['quotes'] })
  now += 1000
  const recheckCatalog = await app.providerCheck({ ...restored, capabilities: ['catalog'] })
  await app.configuration({ ...operation(7, 2), payload: restored, checkIds: [recheckQuotes.checkId, recheckCatalog.checkId] })
  assert.equal(app.snapshot().control.routes.length, 2)
  now += 6 * 60 * 1000
  const replay = await app.configuration({ ...operation(), payload: restored, checkIds: [] })
  assert.ok(replay.revision >= 1)
  await app.close()
})

test('snapshot 下发实例可观测面: 凭据/代理/端点覆盖/最近请求', async () => {
  const app = await createApplication({ storageDomain: memoryStorage(), env: {}, now: () => 1000 })
  const snap = app.snapshot()
  const status = snap.providerStatus.find(s => s.id === 'em-default')
  assert.equal(status.credentialPresent, true)
  assert.equal('proxy' in status, true, '下发是否配置代理')
  assert.equal('endpointsCovered' in status, true, '下发端点覆盖 key 数')
  assert.deepEqual(status.recentRequests, [], '最近请求初始为空')
  const em = snap.adapters.find(a => a.adapterId === 'eastmoney')
  assert.ok(em.endpointKeys?.length >= 5, '适配器下发端点键(供反代 UI)')
  assert.equal(em.endpointKeys[0].label.length > 0, true, '端点键带中文标签')
  await app.close()
})


test('保存不做探针闸门: 未验证的目标照样能存, 校验只针对配置自身', async () => {
  let now = 1000
  const app = await createApplication({ storageDomain: memoryStorage(), providers: [fake], env: { DSH_STOCK_TUSHARE_TOKEN: 'fake' }, now: () => now })
  const generous = { ...provider('ts-one', 'fake'), budget: { ...provider('ts-one', 'fake').budget, requestsPerMinute: 10000, capabilityLimits: { quotes: 10000, catalog: 10000, calendar: 10000 } } }
  const config = { providers: [generous], routes: [route(), route('ts-one', 'XSHG', 'catalog')] }
  // 一次探针都没跑, 直接保存
  await app.configuration({ ...operation(), payload: config })
  assert.equal(app.snapshot().control.routes.length, 2)
  // 从没验证过的全新目标同样能存
  const stranger = { providers: [{ ...provider('ts-two', 'fake') }], routes: [route('ts-two', 'XSHG', 'quotes')] }
  await app.configuration({ ...operation(3, 1), payload: stranger })
  assert.equal(app.snapshot().control.routes[0].primaryInstanceId, 'ts-two')
  // 但配置自身的非法仍要拒绝: 路由指向不存在的实例
  await assert.rejects(app.configuration({ ...operation(5, 2), payload: { providers: [], routes: [route('ghost', 'XSHG', 'quotes')] } }), e => e.code === 'INVALID_ROUTE')
  await app.close()
})

test('F02 进入面板时缓存新鲜则跳过重复拉取, 过期才刷新', async () => {
  let clock = Date.parse('2026-11-25T02:00:00Z'), quoteCalls = 0
  const adapter = { descriptor: { adapterId: 'fake', capabilities: ['quotes', 'catalog', 'calendar'], markets: ['XSHG', 'XSHE'], instruments: ['equity'], maxQuoteBatch: 20 },
    async probe(request) { return { status: 'ready', capability: request.capability } },
    async catalog() { return { items: [security], complete: true } },
    async calendar() { return { items: [] } },
    async quotes() { quoteCalls += 1; return { items: [{ securityId: security.id, providerInstanceId: 'ts-one', last: '10.00', previousClose: '8.00', receivedAt: clock, quoteAt: null, delayKind: 'realtime' }] } } }
  const app = await createApplication({ storageDomain: memoryStorage(), providers: [adapter], env: { DSH_STOCK_TUSHARE_TOKEN: 'x' }, now: () => clock })
  const config = { providers: [provider('ts-one', 'fake')], routes: [route(), route('ts-one', 'XSHG', 'catalog')] }
  const checked = await app.providerCheck({ ...config, capabilities: ['quotes'] })
  // 同组探针需间隔一拍: 冻结时钟下同毫秒双探针会撞 RATE_LIMIT
  clock += 1000
  const checkedCatalog = await app.providerCheck({ ...config, capabilities: ['catalog'] })
  await app.configuration({ ...operation(), payload: config, checkIds: [checked.checkId, checkedCatalog.checkId] })
  clock += 1000
  await app.sync({ market: 'XSHG', expectedRoutingRevision: app.snapshot().control.routingRevision })
  await app.watchlist({ ...operation(2, app.snapshot().control.revision), action: 'add', payload: { securityId: security.id } })
  const pageId = '00000000-0000-4000-8000-0000000000aa'
  // 每次进入前推进一拍: 组内节拍等待基于冻结时钟, 不推进会真实等待 1 秒
  const open = async generation => { clock += 1000; app.demand({ pageId, generation, active: true }); await new Promise(resolve => setTimeout(resolve, 60)) }
  await open(1)
  assert.equal(quoteCalls, 1, '首次进入拉取一次')
  app.demand({ pageId, generation: 2, active: false })
  await open(3)
  assert.equal(quoteCalls, 1, '缓存新鲜时再次进入不再拉取')
  clock += 20_000
  app.demand({ pageId, generation: 4, active: false })
  await open(5)
  assert.equal(quoteCalls, 2, '缓存过期后进入重新拉取')
  await app.close()
})

// 初始化后半段(适配器合同、执行器、目录)失败时也必须关掉数据域:
// 否则占位留在宿主里, 热重载只会一路 already-open, 只能重启宿主
test('初始化失败后数据域已关闭, 可以重新打开', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'stock-init-fail-'))
  const backend = new JsonStorageBackend(dir)
  const facility = new DomainFacility({ storage: { backend: { get: () => backend } }, emit() {}, logger: { warn() {}, error() {} } }, { backend: 'isolated' })
  try {
    await assert.rejects(createApplication({ storageDomain: facility, providers: [{}], publish() {}, timers: globalThis }), error => error.code === 'INVALID_ADAPTER')
    const state = await openState(facility)
    assert.deepEqual(state.get().watchlist.order, [], '域已释放, 能重新打开')
    await state.close()
  } finally {
    await backend.close()
    await rm(dir, { recursive: true, force: true })
  }
})

// 偏好按字段合并: 悬浮盯盘间隔与列表间隔互不影响, 非法值不落盘
test('显示偏好按字段合并, 悬浮盯盘间隔独立于列表', async () => {
  const app = await createApplication({ storageDomain: memoryStorage(), env: {}, now: () => 1000 })
  await app.preferences({ ...operation(1, 0), payload: { floatRefreshSeconds: 3 } })
  assert.equal(app.snapshot().control.preferences.floatRefreshSeconds, 3)
  assert.equal(app.snapshot().control.preferences.refreshSeconds, 15, '只改悬浮间隔不动列表间隔')
  await app.preferences({ ...operation(2, 1), payload: { refreshSeconds: 60 } })
  assert.equal(app.snapshot().control.preferences.refreshSeconds, 60)
  assert.equal(app.snapshot().control.preferences.floatRefreshSeconds, 3, '只改列表间隔不动悬浮间隔')
  await assert.rejects(app.preferences({ ...operation(3, 2), payload: { floatRefreshSeconds: 7 } }), e => e.code === 'INVALID_PREFERENCES')
  assert.equal(app.snapshot().control.preferences.floatRefreshSeconds, 3, '非法值不写入')
  await app.close()
})

// K10: 回主源前必须验"这条路由自己的能力" —— 用 quotes 探针验 K 线路由既验错对象,
// 也会在来源没有报价能力时误判。探针请求必须带 route.capability。
test('K10 回主源探针按路由自身能力执行', async () => {
  const probes = []
  const klineAdapter = { descriptor: { adapterId: 'fake-k', capabilities: ['kline'], markets: ['XSHG'], instruments: ['equity'] }, async probe(request) { probes.push(request.capability); return { status: 'ready', capability: request.capability } }, async kline() { return { candles: [] } } }
  const app = await createApplication({ storageDomain: memoryStorage(), providers: [klineAdapter], env: { DSH_STOCK_TUSHARE_TOKEN: 'x' }, now: () => 1000 })
  const config = { providers: [provider('k1', 'fake-k')], routes: [route('k1', 'XSHG', 'kline')] }
  await app.configuration({ ...operation(), payload: config })
  const result = await app.routeSelection({ routeId: 'xshg-kline', target: 'primary', expectedRoutingRevision: app.snapshot().control.routingRevision, expectedRouteEpoch: 0 })
  assert.deepEqual(probes, ['kline'], '探针按 route.capability, 不是恒 quotes')
  assert.equal(result.routeSelections['xshg-kline'].routeEpoch, 1, '检查通过后切回并推进代次')
  await app.close()
})

// K11: 概览的时段判定与采集同源(catalog.marketState), 不用来源报价里的 sessionState 猜 ——
// 来源不带该字段时旧实现恒按"非交易", 交易时段的 2 小时旧报价会被报成"休市/收盘"。
test('K11 概览时段判定与采集同源: 盘中旧报价 delayed, 收盘后 closed', async () => {
  let clock = Date.parse('2026-11-09T02:00:00Z') // 沪深 10:00, 交易中
  const adapter = {
    descriptor: { adapterId: 'fake-q', capabilities: ['quotes'], markets: ['XSHG'], instruments: ['equity'], maxQuoteBatch: 20 },
    async probe(request) { return { status: 'ready', capability: request.capability } },
    async quotes() { return { items: [{ securityId: 'XSHG:index:000001', last: '3900.25', previousClose: '3800.00', quoteAt: '2026-11-08T23:30:00Z', receivedAt: clock, providerInstanceId: 'q1', delayKind: 'unknown', delaySeconds: null }] } },
  }
  const app = await createApplication({ storageDomain: memoryStorage(), providers: [adapter], env: { DSH_STOCK_TUSHARE_TOKEN: 'x' }, now: () => clock })
  await app.configuration({ ...operation(), payload: { providers: [provider('q1', 'fake-q')], routes: [route('q1', 'XSHG', 'quotes')] } })
  const trading = await app.browse({ market: 'XSHG', offset: 0, limit: 50 })
  assert.equal(trading.overview.sessionState, 'trading', '概览时段来自市场时段判定')
  assert.equal(trading.overview.delayKind, 'delayed', '盘中旧报价是延迟, 不是休市')
  assert.ok(trading.overview.delaySeconds > 90)
  clock = Date.parse('2026-11-09T13:00:00Z') // 沪深 21:00, 休市
  const closed = await app.browse({ market: 'XSHG', offset: 0, limit: 50 })
  assert.equal(closed.overview.sessionState, 'closed')
  assert.equal(closed.overview.delayKind, 'closed', '休市按收盘时间点报, 不再算延迟')
  assert.equal(closed.overview.delaySeconds, null)
  await app.close()
})

// K2/K3: 存量明文经真实数据域打开后, 快照回显与持久化都不再含账号密码
test('K2 存量代理/端点明文不进快照, 打开后持久化也已清洗', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'stock-legacy-secret-')), backend = new JsonStorageBackend(dir)
  const facility = new DomainFacility({ storage: { backend: { get: () => backend } }, emit() {}, logger: { warn() {}, error() {} } }, { backend: 'isolated' })
  try {
    const base = initialControl()
    const userinfo = (host, path = '') => `https://${['legacy-user', 'legacy-secret'].join(':')}@${host}${path}`
    const legacyRoot = {
      ...base,
      providers: base.providers.map((p, index) => index === 0 ? { ...p, proxy: userinfo('proxy.example.com:8443'), endpoints: { kline: userinfo('mirror.example.com', '/kline') } } : p),
      operations: [{ id: crypto.randomUUID(), hash: 'h', at: 1, result: { revision: 1 }, action: 'configuration', payload: { providers: [{ ...base.providers[0], proxy: userinfo('payload.example.com:8443') }] } }],
    }
    await writeFile(join(dir, 'stock_assistant.json'), JSON.stringify({ unit: { name: 'stock_assistant', version: 1 }, global: null, tables: { control: { root: legacyRoot }, cache: {} } }))
    const app = await createApplication({ storageDomain: facility, env: {}, now: () => 1000 })
    const text = JSON.stringify(app.snapshot())
    assert.equal(text.includes('legacy-user'), false, '快照不得含账号')
    assert.equal(text.includes('legacy-secret'), false, '快照不得含密码')
    assert.equal(JSON.parse(text).control.providers[0].endpoints.kline, 'https://mirror.example.com/kline')
    await app.close()
  } finally {
    await backend.close()
    await rm(dir, { recursive: true, force: true })
  }
})

const waitFor = async (predicate, message) => {
  for (let i = 0; i < 300; i++) { if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 10)) }
  assert.fail(message)
}

// S3: 刷新全失败时 collector 里保留带 lastError 的 peek 条目, 错误快照必须把它带给详情
test('S3 刷新全失败时错误快照保留 peek 的 lastError 条目', async () => {
  const down = {
    descriptor: { adapterId: 'down', capabilities: ['quotes'], markets: ['XSHG'], instruments: ['equity'], maxQuoteBatch: 20 },
    async probe(request) { return { status: 'ready', capability: request.capability } },
    async quotes() { throw new StockError('NETWORK', '网络请求失败', 502) },
  }
  const peer = { id: 'XSHG:equity:600521', exchange: 'XSHG', code: '600521' }
  const app = await createApplication({ storageDomain: memoryStorage(), providers: [down], env: { DSH_STOCK_TUSHARE_TOKEN: 'x' }, now: () => 1000 })
  await app.configuration({ ...operation(), payload: { providers: [provider('down-one', 'down')], routes: [route('down-one', 'XSHG', 'quotes')] } })
  const error = await app.refresh({ securities: [peer] }).catch(e => e)
  assert.equal(error.code, 'NETWORK')
  assert.equal(error.snapshot.quotes[peer.id]?.lastError?.code, 'NETWORK', '错误快照要带失败原因, 否则详情只剩等待')
  assert.equal(error.snapshot.quotes[peer.id]?.health, 'error')
  assert.equal(app.snapshot().quotes[peer.id], undefined, 'peek 条目不得进入常驻快照')
  await app.close()
})

// S5: 面板空闲才做后台预热。旧实现只写在 wanted 分支又要求 !demand.active(), 后台目录永不执行
test('S5 面板空闲时按 60 秒节流执行后台目录预热', async () => {
  let now = 1_000_000, calls = 0
  const down = {
    descriptor: { adapterId: 'cat-down', capabilities: ['catalog'], markets: ['XSHG'], instruments: ['equity'], maxQuoteBatch: 20 },
    async probe(request) { return { status: 'ready', capability: request.capability } },
    async catalog() { calls += 1; throw new StockError('NETWORK', '网络失败', 502) },
  }
  const app = await createApplication({ storageDomain: memoryStorage(), providers: [down], env: { DSH_STOCK_TUSHARE_TOKEN: 'x' }, now: () => now })
  await app.configuration({ ...operation(), payload: { providers: [provider('down-one', 'cat-down')], routes: [route('down-one', 'XSHG', 'catalog')] } })
  const pageId = crypto.randomUUID()
  app.demand({ pageId, generation: 1, active: true })
  app.demand({ pageId, generation: 2, active: false })
  await waitFor(() => calls === 1, '面板空闲后应触发一次后台目录预热')
  now += 61 * 1000
  app.demand({ pageId, generation: 3, active: true })
  app.demand({ pageId, generation: 4, active: false })
  await waitFor(() => calls === 2, '超过 60 秒节流窗口后应允许再次预热')
  await app.close()
})

// S7: securities 形状由 zod 校验, null 元素与坏市场枚举必须是 400 而不是 500
test('S7 刷新证券参数非法时返回 400 INVALID_REFRESH', async () => {
  const app = await createApplication({ storageDomain: memoryStorage(), env: { DSH_STOCK_TUSHARE_TOKEN: 'x' }, now: () => 1000 })
  const bad = async securities => {
    const error = await app.refresh({ securities }).catch(e => e)
    assert.equal(error.code, 'INVALID_REFRESH')
    assert.equal(error.status, 400)
    return error
  }
  await bad([null])
  await bad([{ id: 'XSHG:equity:600519', exchange: 'NOPE', code: '600519' }])
  await bad([{ id: 'XSHG:equity:600519', exchange: 'XSHG', code: '000001' }])
  await bad('XSHG:equity:600519')
  await app.close()
})

// S8: 手动同步只提交该市场真实配置的能力, 没有日历路由时不能必然回一条 NO_ROUTE
test('S8 手动同步按该市场实际能力过滤', async () => {
  const adapter = {
    descriptor: { adapterId: 'cat-quote', capabilities: ['catalog', 'quotes'], markets: ['XSHG'], instruments: ['equity'], maxQuoteBatch: 20 },
    async probe(request) { return { status: 'ready', capability: request.capability } },
    async catalog() { return { items: [makeSecurity('XSHG', '600001', '甲')], complete: true } },
    async quotes() { return { items: [] } },
  }
  const app = await createApplication({ storageDomain: memoryStorage(), providers: [adapter], env: { DSH_STOCK_TUSHARE_TOKEN: 'x' }, now: () => 1000 })
  await app.configuration({ ...operation(), payload: { providers: [provider('one', 'cat-quote')], routes: [route('one', 'XSHG', 'catalog')] } })
  const results = await app.sync({ market: 'XSHG', expectedRoutingRevision: app.snapshot().control.routingRevision })
  assert.deepEqual([...results.map(r => r.capability)], ['catalog'], '没有日历路由就只同步目录, 不产生假失败')
  assert.equal(results[0].ok, true)
  const revision = app.snapshot().control.routingRevision
  await app.configuration({ ...operation(2, revision), payload: { providers: [provider('one', 'cat-quote')], routes: [route('one', 'XSHG', 'quotes')] } })
  const error = await app.sync({ market: 'XSHG', expectedRoutingRevision: app.snapshot().control.routingRevision }).catch(e => e)
  assert.equal(error.code, 'NO_ROUTE', '没有目录/日历能力时明确报错而不是静默成功')
  assert.equal(error.status, 422)
  await app.close()
})

// S9: 自动故障切换只换来源, 不能重置 collector 让在飞刷新变成假 ROUTE_CONFLICT
test('S9 自动故障切换后当前刷新以真实网络错误结束', async () => {
  const down = adapterId => ({
    descriptor: { adapterId, capabilities: ['quotes'], markets: ['XSHG'], instruments: ['equity'], maxQuoteBatch: 20 },
    async probe(request) { return { status: 'ready', capability: request.capability } },
    async quotes() { throw new StockError('NETWORK', '网络请求失败', 502) },
  })
  let now = 1_000_000
  const app = await createApplication({ storageDomain: memoryStorage(), providers: [down('f-a'), down('f-b')], env: { DSH_STOCK_TUSHARE_TOKEN: 'x' }, now: () => now })
  const primary = provider('p1', 'f-a'), fallback = provider('p2', 'f-b')
  const failoverRoute = { ...route('p1', 'XSHG', 'quotes'), fallbackInstanceIds: ['p2'], failoverMode: 'network' }
  await app.configuration({ ...operation(), payload: { providers: [primary, fallback], routes: [failoverRoute] } })
  const errors = []
  for (let i = 0; i < 3; i++) {
    // 退避按 15s/30s 指数增长(带抖动), 每轮间隔 60 秒才能都打到真实网络
    now += 60 * 1000
    errors.push(await app.refresh({ securities: [{ id: 'XSHG:equity:600519', exchange: 'XSHG', code: '600519' }] }).catch(e => e))
  }
  assert.equal(errors[2].code, 'NETWORK', '第三轮应报真实网络错误, 不能是切换导致的 ROUTE_CONFLICT')
  assert.equal(app.snapshot().routeSelections['xshg-quotes'].providerInstanceId, 'p2', '连续网络失败后切换到备源')
  now += 1000
  const afterSwitch = await app.refresh({ securities: [{ id: 'XSHG:equity:600519', exchange: 'XSHG', code: '600519' }] }).catch(e => e)
  assert.equal(afterSwitch.code, 'NETWORK', '切换后立即刷新备源, 不能被主源退避误伤成 RATE_LIMIT')
  await app.close()
})
