import test from 'node:test'
import assert from 'node:assert/strict'
import { createCatalog } from '../src/catalog.mjs'
import { createCollector } from '../src/collector.mjs'
import { createRouter } from '../src/provider-router.mjs'
import { makeSecurity } from '../src/market-model.mjs'
import { openState } from '../src/state.mjs'
import { memoryStorage } from './helpers.mjs'
test('C08 手动等待所有批次完成，前20只完成不能提前回执', async () => {
  const securities = Array.from({ length: 25 }, (_, i) => makeSecurity('XSHG', String(600000 + i), `证券${i}`))
  const config = { routingRevision: 1, watchlist: { order: securities.map(s => s.id), items: Object.fromEntries(securities.map(s => [s.id, s])) }, routes: [{ id: 'sh', capability: 'quotes', market: 'XSHG', instrument: 'equity', primaryInstanceId: 'a', fallbackInstanceIds: [], failoverMode: 'off', acceptUnknownDelay: true }], providers: [{ id: 'a', enabled: true }] }
  const resolvers = []; let done = false
  const collector = createCollector({ getControl: () => config, router: createRouter(() => config), registry: { get: () => ({ descriptor: { maxQuoteBatch: 20 } }) }, executor: { run: () => new Promise(resolve => resolvers.push(resolve)) } })
  const pending = collector.refresh().then(() => { done = true })
  resolvers[0]({ items: [], errors: [] }); await new Promise(resolve => setImmediate(resolve))
  assert.equal(done, false); assert.equal(resolvers.length, 2)
  resolvers[1]({ items: [], errors: [] }); await pending; assert.equal(done, true)
  collector.dispose()
})
test('缺目录与过期日历按需同步，不由每次搜索反复抓全量目录', async () => {
  const state = await openState(memoryStorage()), config = { ...state.get(), routes: [{ id: 'sh-catalog', market: 'XSHG', capability: 'catalog' }, { id: 'sh-calendar', market: 'XSHG', capability: 'calendar' }] }
  let calls = 0
  const catalog = createCatalog({ state, getControl: () => config, router: { select: () => ({ instance: { id: 'a' } }) }, executor: { run: async (instance, cap) => { calls++; return { items: cap === 'calendar' ? [{ date: new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString().slice(0, 10), isOpen: true }] : [], complete: true } } } })
  assert.equal(typeof catalog.ensure, 'function')
  await catalog.ensure(); await catalog.ensure()
  assert.equal(calls, 2)
  catalog.search('茅台'); assert.equal(calls, 2)
  catalog.dispose(); await state.close()
})
