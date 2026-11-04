import test from 'node:test'
import assert from 'node:assert/strict'
import { createCollector } from '../src/collector.mjs'
import { createRouter } from '../src/provider-router.mjs'
import { makeSecurity } from '../src/market-model.mjs'
const security = makeSecurity('XSHG', '600519', '贵州茅台')
function setup(state = { state: 'trading' }) {
  let now = 1000, scheduled
  const config = { routingRevision: 1, watchlist: { order: [security.id], items: { [security.id]: security } }, preferences: { refreshSeconds: 15 }, providers: [{ id: 'a', enabled: true, adapterId: 'fake', budget: { requestsPerMinute: 1, capabilityLimits: { quotes: 1 } } }], routes: [{ id: 'sh', capability: 'quotes', market: 'XSHG', instrument: 'equity', primaryInstanceId: 'a', fallbackInstanceIds: [], failoverMode: 'off', acceptUnknownDelay: true }] }
  const collector = createCollector({ getControl: () => config, router: createRouter(() => config), registry: { get: () => ({ descriptor: { maxQuoteBatch: 20 } }) }, executor: { run: async () => ({ items: [] }) }, now: () => now, active: () => true, calendarState: () => state, timers: { clearTimeout() {}, setTimeout(fn, ms) { scheduled = { fn, ms }; return 1 } } })
  return { collector, get scheduled() { return scheduled } }
}
test('D06 周期下界考虑来源额度，避免15秒轮询每分钟1次的来源', async () => {
  const s = setup(); await s.collector.refresh(); s.collector.reconcile()
  assert.ok(s.scheduled.ms >= 60000)
  s.collector.dispose()
})
test('交易转收盘时只做一次最后对账，然后等待下次开盘', async () => {
  let phase = { state: 'trading' }, calls = 0, now = 1000, scheduled
  const config = { routingRevision: 1, watchlist: { order: [security.id], items: { [security.id]: security } }, preferences: { refreshSeconds: 15 }, providers: [{ id: 'a', enabled: true, adapterId: 'fake', budget: { requestsPerMinute: 100, capabilityLimits: { quotes: 100 } } }], routes: [{ id: 'sh', capability: 'quotes', market: 'XSHG', instrument: 'equity', primaryInstanceId: 'a', fallbackInstanceIds: [], failoverMode: 'off', acceptUnknownDelay: true }] }
  const collector = createCollector({ getControl: () => config, router: createRouter(() => config), registry: { get: () => ({ descriptor: { maxQuoteBatch: 20 } }) }, executor: { run: async () => { calls++; return { items: [] } } }, now: () => now, active: () => true, calendarState: () => phase, timers: { clearTimeout() {}, setTimeout(fn, ms) { scheduled = { fn, ms }; return 1 } } })
  await collector.refresh(undefined, { periodic: true }); now += 15000
  phase = { state: 'closed', nextAt: now + 18 * 60 * 60 * 1000 }
  collector.reconcile(); assert.ok(scheduled.ms <= 1000)
  await collector.refresh(undefined, { periodic: true }); await collector.refresh(undefined, { periodic: true })
  assert.equal(calls, 2)
  collector.reconcile(); assert.equal(scheduled.ms, 18 * 60 * 60 * 1000)
  collector.dispose()
})
test('D04 已知午休仅在下个交易时段唤醒', () => {
  const s = setup({ state: 'break', nextAt: 1000 + 60 * 60 * 1000 }); s.collector.reconcile()
  assert.equal(s.scheduled.ms, 60 * 60 * 1000)
  s.collector.dispose()
})
