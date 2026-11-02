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

test('延迟派生: 有quoteAt的unknown按时差定realtime/delayed, 缺quoteAt保持unknown', async () => {  const config = control(), router = createRouter(() => config)
  let items = []
  const c = createCollector({ getControl: () => config, router, registry: { get: () => ({ descriptor: { maxQuoteBatch: 20 } }) }, executor: { run: async () => ({ items }) }, now: () => Date.parse('2026-11-02T12:00:30Z'), active: () => false })
  // 5min 前: delayed+300(先入库); 10s 前: realtime 覆盖(新时间合法); 无 quoteAt: 保持 unknown 不编造
  items = [{ securityId: security.id, last: '10.00', previousClose: '8.00', quoteAt: '2026-11-02T11:55:30Z', receivedAt: 1, providerInstanceId: 'a', delayKind: 'unknown', delaySeconds: null }]
  await c.refresh()
  assert.deepEqual({ kind: c.entries()[security.id].quote.delayKind, s: c.entries()[security.id].quote.delaySeconds }, { kind: 'delayed', s: 300 })
  items = [{ securityId: security.id, last: '10.00', previousClose: '8.00', quoteAt: '2026-11-02T12:00:20Z', receivedAt: 1, providerInstanceId: 'a', delayKind: 'unknown', delaySeconds: null }]
  await c.refresh()
  assert.deepEqual({ kind: c.entries()[security.id].quote.delayKind, s: c.entries()[security.id].quote.delaySeconds }, { kind: 'realtime', s: null })
  items = [{ securityId: security.id, last: '10.00', previousClose: '8.00', quoteAt: null, receivedAt: 1, providerInstanceId: 'a', delayKind: 'unknown', delaySeconds: null }]
  await c.refresh()
  assert.equal(c.entries()[security.id].quote.delayKind, 'unknown')
  c.dispose()
})

test('目录证券解析链: refresh可拉非自选目录证券行情, 未知id仍NOT_FOUND', async () => {
  const config = control(), router = createRouter(() => config)
  const peer = makeSecurity('XSHG', '600521', '目录中的另一只')
  const requested = []
  const c = createCollector({ getControl: () => config, router, resolveSecurity: id => id === peer.id ? peer : null, registry: { get: () => ({ descriptor: { maxQuoteBatch: 20 } }) }, executor: { run: async (i, cap, req) => { requested.push(...req.securities.map(s => s.id)); return { items: [{ securityId: peer.id, last: '20.00', previousClose: '19.00', quoteAt: null, receivedAt: 1, providerInstanceId: 'a', delayKind: 'unknown', delaySeconds: null }] } } } })
  await c.refresh([peer.id])
  assert.deepEqual(requested, [peer.id], '目录证券经 resolveSecurity 解析并拉行情')
  assert.equal(c.entries()[peer.id].quote.last, '20.00')
  await assert.rejects(() => c.refresh(['XSHG:equity:999999']), e => e.code === 'NOT_FOUND', '不在自选也不在目录仍拒')
  c.dispose()
})

test('对象形态securities: 搜索候选peek不经目录解析直拉(港美股路径)', async () => {
  const config = control(), router = createRouter(() => ({ ...config, routes: [...config.routes, { id: 'hk', capability: 'quotes', market: 'XHKG', instrument: 'equity', primaryInstanceId: 'a', fallbackInstanceIds: [], failoverMode: 'off', acceptUnknownDelay: true }] }))
  const tencent = { id: 'XHKG:equity:00700', exchange: 'XHKG', code: '00700', officialName: '腾讯控股' }
  const requested = []
  const c = createCollector({ getControl: () => config, router, registry: { get: () => ({ descriptor: { maxQuoteBatch: 20 } }) }, executor: { run: async (i, cap, req) => { requested.push(...req.securities.map(s => ({ id: s.id, ex: s.exchange, code: s.code }))); return { items: [{ securityId: tencent.id, last: '383.60', previousClose: '377.20', quoteAt: null, receivedAt: 1, providerInstanceId: 'a', delayKind: 'unknown', delaySeconds: null }] } } } })
  await c.refresh([tencent])
  assert.deepEqual(requested, [{ id: tencent.id, ex: 'XHKG', code: '00700' }], '对象形态按完整身份构造')
  assert.equal(c.entries()[tencent.id].quote.last, '383.60')
  c.dispose()
})
