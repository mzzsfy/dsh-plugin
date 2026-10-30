import test from 'node:test'
import assert from 'node:assert/strict'
import { createCollector } from '../src/collector.mjs'
import { createRouter } from '../src/provider-router.mjs'
import { makeSecurity } from '../src/market-model.mjs'
const security = makeSecurity('XSHG', '600519', '贵州茅台')
const control = () => ({ revision: 0, routingRevision: 0, preferences: { refreshSeconds: 15 }, providers: [{ id: 'a', adapterId: 'fake', enabled: true, budget: { requestsPerMinute: 50 } }], routes: [{ id: 'sh', capability: 'quotes', market: 'XSHG', instrument: 'equity', primaryInstanceId: 'a', fallbackInstanceIds: [], failoverMode: 'off', acceptUnknownDelay: true }], watchlist: { order: [security.id], items: { [security.id]: security } } })
test('D05 无自动需求时手动刷新不被隐藏消息取消', async () => {
  const config = control(), router = createRouter(() => config)
  let resolve, signal
  const c = createCollector({ getControl: () => config, router, registry: { get: () => ({ descriptor: { maxQuoteBatch: 20 } }) }, active: () => false, executor: { run: (i, cap, req, options) => { signal = options.signal; return new Promise(r => { resolve = r }) } } })
  const pending = c.refresh(); c.cancelIdle()
  assert.equal(signal.aborted, false)
  resolve({ items: [], errors: [] }); await pending; c.dispose()
})
test('P07 同轮并发失败只计一次，不因三个用户同时刷新误切源', async () => {
  const config = control(); config.providers.push({ id: 'b', adapterId: 'fake', enabled: true }); config.routes[0].fallbackInstanceIds = ['b']; config.routes[0].failoverMode = 'network'
  const router = createRouter(() => config)
  let reject, calls = 0
  const c = createCollector({ getControl: () => config, router, registry: { get: () => ({ descriptor: { maxQuoteBatch: 20 } }) }, executor: { run: () => { calls++; return new Promise((_, no) => { reject = no }) } } })
  const jobs = [c.refresh(), c.refresh(), c.refresh()]
  await new Promise(r => setImmediate(r)); reject(Object.assign(Error('offline'), { code: 'NETWORK' }))
  await Promise.allSettled(jobs)
  assert.equal(calls, 1)
  assert.equal(router.select('quotes', 'XSHG').instance.id, 'a')
  c.dispose()
})
test('C04 相同来源的旧交易时间不覆盖新价', async () => {
  const config = control(), router = createRouter(() => config)
  let date = '2026-10-29T06:00:00Z', last = '10.00'
  const c = createCollector({ getControl: () => config, router, registry: { get: () => ({ descriptor: { maxQuoteBatch: 20 } }) }, executor: { run: async () => ({ items: [{ securityId: security.id, providerInstanceId: 'a', quoteAt: date, last, receivedAt: 1, delayKind: 'unknown' }] }) } })
  await c.refresh(); date = '2026-10-29T05:00:00Z'; last = '9.00'; await c.refresh()
  assert.equal(c.entries()[security.id].quote.last, '10.00')
  c.dispose()
})
test('C01/C02/C03 相同批次复用且同价手动刷新仍返回新获取时间', async () => {
  let resolve, calls = 0, now = 100, changed = 0
  const config = control(), router = createRouter(() => config)
  const executor = { run: () => { calls++; return new Promise(r => { resolve = r }) } }
  const c = createCollector({ getControl: () => config, router, registry: { get: () => ({ descriptor: { maxQuoteBatch: 20 } }) }, executor, changed: () => changed++, now: () => now, active: () => false })
  const a = c.refresh(), b = c.refresh()
  await new Promise(r => setImmediate(r))
  assert.equal(calls, 1)
  resolve({ items: [{ securityId: security.id, last: '10.00', previousClose: '8.00', quoteAt: null, receivedAt: now, providerInstanceId: 'a', delayKind: 'unknown' }], errors: [] })
  await Promise.all([a, b]); assert.equal(c.entries()[security.id].quote.receivedAt, 100)
  now = 200
  const d = c.refresh(); await new Promise(r => setImmediate(r))
  resolve({ items: [{ securityId: security.id, last: '10.00', previousClose: '8.00', quoteAt: null, receivedAt: now, providerInstanceId: 'a', delayKind: 'unknown' }], errors: [] })
  await d; assert.equal(c.entries()[security.id].quote.receivedAt, 200); assert.equal(changed, 1)
  c.dispose()
})
