import test from 'node:test'
import assert from 'node:assert/strict'
import { createApplication } from '../src/application.mjs'
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


test('增量检查合同: 目标粒度缓存命中, 无关字段改动与新增路由不再全量重验', async () => {
  let now = 1000
  const app = await createApplication({ storageDomain: memoryStorage(), providers: [fake], env: { DSH_STOCK_TUSHARE_TOKEN: 'fake' }, now: () => now })
  const generous = { ...provider('ts-one', 'fake'), budget: { ...provider('ts-one', 'fake').budget, requestsPerMinute: 10000, capabilityLimits: { quotes: 10000, catalog: 10000, calendar: 10000 } } }
  const config = { providers: [generous], routes: [route(), route('ts-one', 'XSHG', 'catalog')] }
  const checked = await app.providerCheck({ ...config, capabilities: ['quotes'] })
  now += 1000
  const checkedCatalog = await app.providerCheck({ ...config, capabilities: ['catalog'] })
  await app.configuration({ ...operation(), payload: config, checkIds: [checked.checkId, checkedCatalog.checkId] })
  // 1) 无关字段改动(预算数字) + 空 checkIds: 缓存命中应直接保存成功, 不再 CHECK_REQUIRED
  const tweaked = { ...config, providers: [{ ...config.providers[0], budget: { ...config.providers[0].budget, requestsPerMinute: 99 } }] }
  await app.configuration({ ...operation(3, 1), payload: tweaked, checkIds: [] })
  assert.equal(app.snapshot().control.providers[0].budget.requestsPerMinute, 99)
  // 2) 既有路由字段微调(接受延迟未知) + 空 checkIds: 目标未变缓存命中即过
  const tweakedRoute = { ...tweaked, routes: tweaked.routes.map(r => ({ ...r, acceptUnknownDelay: !r.acceptUnknownDelay })) }
  await app.configuration({ ...operation(4, 2), payload: tweakedRoute, checkIds: [] })
  assert.equal(app.snapshot().control.routes[0].acceptUnknownDelay, false)
  // 3) 探针从未验证过的全新目标仍拒绝
  const stranger = { providers: [{ ...provider('ts-two', 'fake') }], routes: [route('ts-two', 'XSHG', 'quotes')] }
  await assert.rejects(app.configuration({ ...operation(5, 3), payload: stranger, checkIds: [] }), e => e.code === 'CHECK_REQUIRED')
  // 4) 缓存过期后旧记录不再有效
  now += 11 * 60 * 1000
  const stale = { ...tweakedRoute, providers: [{ ...tweakedRoute.providers[0], budget: { ...tweakedRoute.providers[0].budget, requestsPerMinute: 77 } }] }
  await assert.rejects(app.configuration({ ...operation(6, 3), payload: stale, checkIds: [] }), e => e.code === 'CHECK_REQUIRED')
  await app.close()
})
