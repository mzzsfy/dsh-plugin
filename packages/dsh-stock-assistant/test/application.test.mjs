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
  await assert.rejects(app.configuration({ ...operation(2, 1), payload: { ...config, routes: [] }, checkIds: [checked.checkId] }), e => e.code === 'CHECK_REQUIRED')
  now += 6 * 60 * 1000
  const replay = await app.configuration({ ...operation(), payload: config, checkIds: [] })
  assert.equal(replay.revision, 1)
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
