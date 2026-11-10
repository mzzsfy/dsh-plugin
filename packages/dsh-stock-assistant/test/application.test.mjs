import test from 'node:test'
import assert from 'node:assert/strict'
import { createApplication } from '../src/application.mjs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import { JsonStorageBackend } from '@deepseek-ai/dsh-storage-json'
import { openState } from '../src/state.mjs'
import { memoryStorage, operation } from './helpers.mjs'
import { provider, route } from './helpers.mjs'
import { makeSecurity } from '../src/market-model.mjs'
const security = makeSecurity('XSHG', '600519', '贵州茅台')
const fake = { descriptor: { adapterId: 'fake', capabilities: ['quotes', 'catalog', 'calendar'], markets: ['XSHG', 'XSHE'], instruments: ['equity'], maxQuoteBatch: 20 }, async probe() { return { status: 'ready' } }, async catalog() { return { items: [security], complete: true } }, async calendar() { return { items: [] } }, async quotes() { return { items: [{ securityId: security.id, providerInstanceId: 'ts-one', last: '10.00', previousClose: '8.00', receivedAt: 100, quoteAt: null, delayKind: 'unknown' }] } } }
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
  let clock = 1_000_000, quoteCalls = 0
  const adapter = { descriptor: { adapterId: 'fake', capabilities: ['quotes', 'catalog', 'calendar'], markets: ['XSHG', 'XSHE'], instruments: ['equity'], maxQuoteBatch: 20 },
    async probe() { return { status: 'ready' } },
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

// 初始化后半段(适配器合同、执行器、目录)失败时也必须关掉两个数据域:
// 否则占位留在宿主里, 热重载只会一路 already-open, 只能重启宿主
test('初始化失败后两个数据域已关闭, 可以重新打开', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'stock-init-fail-'))
  const backend = new JsonStorageBackend(dir)
  const facility = new DomainFacility({ storage: { backend: { get: () => backend } }, emit() {}, logger: { warn() {}, error() {} } }, { backend: 'isolated' })
  try {
    await assert.rejects(createApplication({ storageDomain: facility, providers: [{}], publish() {}, timers: globalThis }), error => error.code === 'INVALID_ADAPTER')
    const state = await openState(facility)
    assert.deepEqual(state.get().watchlist.order, [], '两域已释放, 能重新打开')
    await state.close()
  } finally {
    await backend.close()
    await rm(dir, { recursive: true, force: true })
  }
})
