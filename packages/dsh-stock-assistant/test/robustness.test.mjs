import test from 'node:test'
import assert from 'node:assert/strict'
import { makeSecurity, normalizeQuote } from '../src/market-model.mjs'
import { createCollector } from '../src/collector.mjs'
import { createRouter } from '../src/provider-router.mjs'
import { createRegistry } from '../src/provider-registry.mjs'
import { createCatalog } from '../src/catalog.mjs'
import { openState } from '../src/state.mjs'
import { memoryStorage } from './helpers.mjs'
const a = makeSecurity('XSHG', '600519', '贵州茅台'), b = makeSecurity('XSHE', '000001', '平安银行')
const config = () => ({ routingRevision: 1, watchlist: { order: [a.id, b.id], items: { [a.id]: a, [b.id]: b } }, preferences: { refreshSeconds: 15 }, providers: [{ id: 'a', enabled: true, adapterId: 'one' }, { id: 'b', enabled: true, adapterId: 'two' }], routes: ['XSHG', 'XSHE'].map((market, i) => ({ id: market, capability: 'quotes', market, instrument: 'equity', primaryInstanceId: i ? 'b' : 'a', fallbackInstanceIds: [], failoverMode: 'off', acceptUnknownDelay: true })) })
const descriptor = adapterId => ({ adapterId, capabilities: ['quotes'], markets: ['XSHG', 'XSHE'], instruments: ['equity'], maxQuoteBatch: 20 })
test('P05 沪深拆批分别由两个独立适配器提供整条报价', async () => {
  const current = config(), calls = []
  const collector = createCollector({ getControl: () => current, router: createRouter(() => current), registry: createRegistry([{ descriptor: descriptor('one'), probe() {}, quotes() {} }, { descriptor: descriptor('two'), probe() {}, quotes() {} }]), executor: { run: async (instance, cap, request) => { calls.push([instance.id, request.securities.map(s => s.id)]); return { items: request.securities.map(s => normalizeQuote({ securityId: s.id, last: instance.id === 'a' ? '10' : '20', previousClose: instance.id === 'a' ? '8' : '25', providerInstanceId: instance.id, receivedAt: 1, delayKind: 'unknown' })) } } } })
  await collector.refresh()
  assert.deepEqual(calls, [['a', [a.id]], ['b', [b.id]]])
  assert.equal(collector.entries()[a.id].quote.changePct, '25.00')
  assert.equal(collector.entries()[b.id].quote.changePct, '-20.00')
  collector.dispose()
})
test('C05 路由变化后迟到结果被丢弃，不发布成功行情', async () => {
  const current = config(); current.watchlist.order = [a.id]
  let resolve
  const collector = createCollector({ getControl: () => current, router: createRouter(() => current), registry: { get: () => ({ descriptor: descriptor('one') }) }, executor: { run: () => new Promise(r => { resolve = r }) } })
  const pending = collector.refresh(); current.routingRevision++
  resolve({ items: [{ securityId: a.id, providerInstanceId: 'a', last: '10.00' }] })
  await assert.rejects(pending, e => e.code === 'ROUTE_CONFLICT')
  assert.equal(collector.entries()[a.id], undefined)
  collector.dispose()
})
test('D04 已知休市的市场不会被另一市场的活跃轮次带动采集', async () => {
  const current = config(), calls = []
  const collector = createCollector({ getControl: () => current, router: createRouter(() => current), registry: { get: () => ({ descriptor: descriptor('one') }) }, executor: { run: async (instance, cap, req) => { calls.push(instance.id); return { items: [] } } }, calendarState: market => market === 'XSHG' ? { state: 'closed', nextAt: Date.now() + 60 * 1000 } : { state: 'trading' } })
  await collector.refresh(undefined, { periodic: true })
  assert.deepEqual(calls, ['b'])
  collector.dispose()
})
test('目录同步遇到损坏标准身份不会保存看似完整的空目录', async () => {
  const state = await openState(memoryStorage())
  const catalog = createCatalog({ state, router: { select: () => ({ instance: { id: 'a' } }) }, executor: { run: async () => ({ items: [{ id: 'bad' }], complete: true }) } })
  const result = await catalog.sync('XSHG', ['catalog'])
  assert.equal(result[0].ok, false)
  assert.equal(catalog.status().length, 0)
  catalog.dispose(); await state.close()
})
