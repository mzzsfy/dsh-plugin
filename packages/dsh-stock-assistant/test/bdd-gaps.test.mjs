import test from 'node:test'
import assert from 'node:assert/strict'
import { createCatalog } from '../src/catalog.mjs'
import { createCollector } from '../src/collector.mjs'
import { createRouter } from '../src/provider-router.mjs'
import { createRegistry } from '../src/provider-registry.mjs'
import { createExecutor } from '../src/executor.mjs'
import { createBudget } from '../src/budget.mjs'
import { makeSecurity } from '../src/market-model.mjs'
import { openState } from '../src/state.mjs'
import { memoryStorage } from './helpers.mjs'
const security = makeSecurity('XSHG', '600519', '贵州茅台')
test('U09 无目录且无搜索来源时明确未就绪，不伪造空市场', async () => {
  const state = await openState(memoryStorage()), base = state.get()
  const config = { ...base, routingRevision: 1, routes: base.routes.filter(r => r.capability !== 'search') }
  const catalog = createCatalog({ state, getControl: () => config, router: { select: () => ({ instance: { id: 'a' }, route: {} }) }, executor: { run: async () => ({ items: [] }) } })
  await assert.rejects(catalog.remote('茅台'), e => e.code === 'CATALOG_NOT_READY')
  assert.deepEqual(catalog.search('茅台'), [])
  catalog.dispose(); await state.close()
})
test('C05 额度受限的手动刷新立即429并带等待时间', async () => {
  const config = { routingRevision: 1, preferences: { refreshSeconds: 15 }, providers: [{ id: 'a', adapterId: 'fake', enabled: true, credentialEnv: 'TOKEN_TEST', quotaGroup: 'g', budget: { requestsPerMinute: 1, dailyRequestLimit: null, billingUnit: 'request', symbolCreditsPerMinute: null, capabilityLimits: { quotes: 1 } } }], routes: [{ id: 'sh', capability: 'quotes', market: 'XSHG', instrument: 'equity', primaryInstanceId: 'a', fallbackInstanceIds: [], failoverMode: 'off', acceptUnknownDelay: true }], watchlist: { order: [security.id], items: { [security.id]: security } } }
  let now = 0
  const registry = createRegistry([{ descriptor: { adapterId: 'fake', capabilities: ['quotes'], markets: ['XSHG'], instruments: ['equity'], maxQuoteBatch: 20 }, probe() {}, async quotes(request, ctx) { await ctx.fetch('http://fixture'); return { items: [] } } }])
  const executor = createExecutor({ registry, budget: createBudget(() => now), env: { TOKEN_TEST: 'x' }, now: () => now, fetch: async () => ({}) })
  const collector = createCollector({ getControl: () => config, router: createRouter(() => config), registry, executor, now: () => now })
  await collector.refresh()
  now = 1000
  await assert.rejects(collector.refresh(), e => e.code === 'RATE_LIMIT' && e.retryAfterMs >= 58000)
  executor.dispose(); collector.dispose()
})
test('C06 相同批次部分证券缺行成功且缺行保旧值', async () => {
  const second = makeSecurity('XSHG', '601318', '中国平安'), config = { routingRevision: 1, preferences: { refreshSeconds: 15 }, providers: [{ id: 'a', adapterId: 'fake', enabled: true, budget: { requestsPerMinute: 50, capabilityLimits: { quotes: 50 } } }], routes: [{ id: 'sh', capability: 'quotes', market: 'XSHG', instrument: 'equity', primaryInstanceId: 'a', fallbackInstanceIds: [], failoverMode: 'off', acceptUnknownDelay: true }], watchlist: { order: [security.id, second.id], items: { [security.id]: security, [second.id]: second } } }
  const collector = createCollector({ getControl: () => config, router: createRouter(() => config), registry: { get: () => ({ descriptor: { maxQuoteBatch: 20 } }) }, executor: { run: async () => ({ items: [{ securityId: security.id, providerInstanceId: 'a', last: '10.00', previousClose: '9.00', receivedAt: 1, delayKind: 'unknown' }], errors: [{ securityId: second.id, code: 'NO_DATA', message: '缺行' }] }) } })
  await collector.refresh()
  const entries = collector.entries()
  assert.equal(entries[security.id].health, 'ok')
  assert.equal(entries[second.id].health, 'no-data')
  collector.dispose()
})
test('C07 429的Retry-After约束下一轮不早于指定时间', async () => {
  const config = { routingRevision: 1, preferences: { refreshSeconds: 15 }, providers: [{ id: 'a', adapterId: 'fake', enabled: true, budget: { requestsPerMinute: 50, capabilityLimits: { quotes: 50 } } }], routes: [{ id: 'sh', capability: 'quotes', market: 'XSHG', instrument: 'equity', primaryInstanceId: 'a', fallbackInstanceIds: [], failoverMode: 'off', acceptUnknownDelay: true }], watchlist: { order: [security.id], items: { [security.id]: security } } }
  let now = 0, calls = 0
  const collector = createCollector({ getControl: () => config, router: createRouter(() => config), registry: { get: () => ({ descriptor: { maxQuoteBatch: 20 } }) }, executor: { run: async () => { calls++; if (calls === 1) throw Object.assign(Error('limited'), { code: 'RATE_LIMIT', retryAfterMs: 30000 }); return { items: [] } } }, now: () => now })
  await assert.rejects(collector.refresh(), e => e.code === 'RATE_LIMIT')
  now = 1000
  await assert.rejects(collector.refresh(), e => e.code === 'RATE_LIMIT' && e.retryAfterMs >= 29000)
  collector.dispose()
})
