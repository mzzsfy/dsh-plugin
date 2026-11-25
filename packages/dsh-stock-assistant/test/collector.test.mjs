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
  const c = createCollector({ getControl: () => config, router, registry: { get: () => ({ descriptor: { maxQuoteBatch: 20 } }) }, executor: { run: instance => { if (instance.id === 'b') return Promise.resolve({ items: [], errors: [] }); calls++; return new Promise((_, no) => { reject = no }) } } })
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

test('P2-57 prune 清掉已移除自选的行情, entries 不再无界增长', async () => {
  const config = control(), c = createCollector({ getControl: () => config, router: createRouter(() => config), registry: { get: () => ({ descriptor: { maxQuoteBatch: 20 } }) }, executor: { run: async () => ({ items: [{ securityId: security.id, last: '10.00', previousClose: '9.00', quoteAt: null, receivedAt: 1, providerInstanceId: 'a', delayKind: 'unknown' }] }) } })
  await c.refresh()
  assert.ok(c.entries()[security.id])
  c.prune(security.id)
  assert.deepEqual(c.entries(), {})
  c.dispose()
})

test('P2-58 新凭据写入后清除该引用的 AUTH 暂停并允许下一轮重试', async () => {
  const config = control()
  config.providers[0].credentialRef = 'TOKEN_TEST'
  let calls = 0
  const c = createCollector({ getControl: () => config, router: createRouter(() => config), registry: { get: () => ({ descriptor: { maxQuoteBatch: 20 } }) }, executor: { run: async () => { calls++; throw Object.assign(Error('auth'), { code: 'AUTH', message: '未配置凭据' }) } }, now: () => 1000 })
  await assert.rejects(() => c.refresh(), e => e.code === 'AUTH')
  await assert.rejects(() => c.refresh(), e => e.code === 'SOURCE_PAUSED', 'AUTH 后进入永久暂停')
  assert.equal(calls, 1, '暂停期间不触达上游')
  c.recoverCredential('TOKEN_TEST')
  await assert.rejects(() => c.refresh(), e => e.code === 'AUTH', '恢复后重新请求, 仍失败则重新记 AUTH')
  assert.equal(calls, 2)
  c.dispose()
})

test('P2-59 刷新等待被取消时中止已发出的上游批次', async () => {
  const config = control(), router = createRouter(() => config)
  let aborted = false, started
  const ready = new Promise(resolve => { started = resolve })
  const c = createCollector({ getControl: () => config, router, registry: { get: () => ({ descriptor: { maxQuoteBatch: 20 } }) }, executor: { run: (i, cap, req, options) => { started(); return new Promise((_, reject) => { options.signal.addEventListener('abort', () => { aborted = true; reject(Object.assign(Error('cancelled'), { code: 'CANCELLED' })) }, { once: true }) }) } } })
  const controller = new AbortController()
  const pending = c.refresh(undefined, { signal: controller.signal })
  await ready
  controller.abort()
  await assert.rejects(pending, e => e.code === 'CANCELLED')
  assert.equal(aborted, true, '上游执行器必须收到 abort')
  c.dispose()
})

test('P2-62 一轮刷新内同市场的市场状态只计算一次', async () => {
  const config = control()
  const second = makeSecurity('XSHG', '600521', '第二个')
  config.watchlist.order.push(second.id); config.watchlist.items[second.id] = second
  let phaseCalls = 0
  const c = createCollector({ getControl: () => config, router: createRouter(() => config), registry: { get: () => ({ descriptor: { maxQuoteBatch: 20 } }) }, calendarState: () => { phaseCalls++; return { state: 'trading' } }, executor: { run: async () => ({ items: [] }) } })
  await c.refresh()
  assert.ok(phaseCalls <= 2, `同市场状态应复用, 实际调用 ${phaseCalls} 次`)
  c.dispose()
})

test('F01 缓存新鲜度判定: 全部自选报价未过期才算新鲜', async () => {
  const config = control(), router = createRouter(() => config)
  let clock = 1_000_000
  const c = createCollector({ getControl: () => config, router, registry: { get: () => ({ descriptor: { maxQuoteBatch: 20 } }) }, now: () => clock, executor: { run: async () => ({ items: [{ securityId: security.id, last: '10.00', previousClose: '9.50', quoteAt: null, receivedAt: clock, providerInstanceId: 'a', delayKind: 'realtime', delaySeconds: 0 }] }) } })
  assert.equal(c.freshWithin(15_000), false, '无报价时不新鲜')
  await c.refresh()
  assert.equal(c.freshWithin(15_000), true, '刚刷新完新鲜')
  clock += 14_000
  assert.equal(c.freshWithin(15_000), true, '窗口内新鲜')
  clock += 2_000
  assert.equal(c.freshWithin(15_000), false, '超出窗口过期')
  c.dispose()
})

// K5: peek(浏览/详情打开的非自选)报价只随本次显式刷新返回; 常驻快照按自选过滤,
// 读取即释放非自选键 —— 否则每浏览一只票就在 Host 内存里留一条永不回收的行情。
test('K5 peek 报价不进常驻快照, 快照读取后释放', async () => {
  const config = control(), router = createRouter(() => config)
  const peer = makeSecurity('XSHG', '600521', '目录中的另一只')
  const c = createCollector({ getControl: () => config, router, resolveSecurity: id => id === peer.id ? peer : null, registry: { get: () => ({ descriptor: { maxQuoteBatch: 20 } }) }, executor: { run: async (i, cap, req) => ({ items: req.securities.map(s => ({ securityId: s.id, last: s.id === peer.id ? '20.00' : '10.00', previousClose: '19.00', quoteAt: null, receivedAt: 1, providerInstanceId: 'a', delayKind: 'unknown', delaySeconds: null })) }) } })
  await c.refresh()
  const peeked = await c.refresh([peer.id])
  assert.equal(peeked[peer.id].quote.last, '20.00', '本次响应必须带 peek 报价(详情首屏数据)')
  assert.equal(peeked[security.id].quote.last, '10.00', '本次响应也带自选报价')
  const snapshotFace = c.watchEntries()
  assert.deepEqual(Object.keys(snapshotFace), [security.id], '常驻快照只含自选')
  assert.equal(c.entries()[peer.id], undefined, '快照读取后 peek 键已释放')
  assert.equal(c.watchEntries()[peer.id], undefined, '后续快照也不会再出现')
  c.dispose()
})

// K5: 移除自选与在飞批次之间的竞态 —— 晚到的上游结果不能把已删标的写回来
test('K5 移除竞态: 在飞批次返回后不再写回已删自选', async () => {
  const config = control(), router = createRouter(() => config)
  let resolve
  const c = createCollector({ getControl: () => config, router, registry: { get: () => ({ descriptor: { maxQuoteBatch: 20 } }) }, executor: { run: () => new Promise(r => { resolve = r }) } })
  const pending = c.refresh()
  await new Promise(r => setImmediate(r))
  config.watchlist = { order: [], items: {} }
  resolve({ items: [{ securityId: security.id, last: '10.00', previousClose: '9.00', quoteAt: null, receivedAt: 1, providerInstanceId: 'a', delayKind: 'unknown', delaySeconds: null }] })
  await pending
  assert.deepEqual(c.entries(), {}, '已移除标的的报价不得写回')
  c.dispose()
})

// K12: 定时器清理 —— dispose 后 reconcile 不得再调度, 已排的定时器必须被清掉
test('K12 dispose 清掉 reconcile 定时器且停止后再不调度', async () => {
  const cleared = []
  let scheduled = null, seq = 0
  const config = control(), timers = { setTimeout(fn, ms) { scheduled = { id: ++seq, fn, ms }; return scheduled.id }, clearTimeout(id) { cleared.push(id) } }
  const c = createCollector({ getControl: () => config, router: createRouter(() => config), registry: { get: () => ({ descriptor: { maxQuoteBatch: 20 } }) }, executor: { run: async () => ({ items: [] }) }, now: () => 1000, active: () => true, calendarState: () => ({ state: 'closed', nextAt: 1000 + 60 * 60 * 1000 }), timers })
  c.reconcile()
  assert.ok(scheduled, '收盘后应排下一次开盘定时器')
  c.dispose()
  assert.deepEqual(cleared.filter(id => id !== undefined), [scheduled.id], 'dispose 清掉已排定时器')
  c.reconcile()
  assert.equal(scheduled.id, 1, '停止后不得再调度')
})

// 拍点必须跟着报价生命周期走: 不写入就没有续点的来源, 不清理就会随浏览与重载无界增长
test('拍点随报价写入, 移除/重置/销毁时同步清理', async () => {
  const config = control(), calls = []
  const ticks = { push: (...args) => calls.push(['push', ...args]), delete: id => calls.push(['delete', id]), clear: () => calls.push(['clear']) }
  const quoteAt = '2026-11-16T02:00:30Z'
  const now = () => Date.parse(quoteAt)
  const c = createCollector({ getControl: () => config, router: createRouter(() => config), registry: { get: () => ({ descriptor: { maxQuoteBatch: 20 } }) }, ticks, now, calendarState: () => ({ state: 'trading' }), active: () => false, executor: { run: async () => ({ items: [{ securityId: security.id, last: '10.00', previousClose: '9.00', quoteAt, timestampKind: 'trade', receivedAt: now(), providerInstanceId: 'a', delayKind: 'unknown', delaySeconds: null }] }) } })
  await c.refresh()
  assert.deepEqual(calls[0], ['push', security.id, security.exchange, Math.floor(Date.parse(quoteAt) / 1000), '10.00'], '拍点用报价自带的时刻')
  c.prune(security.id)
  assert.deepEqual(calls.at(-1), ['delete', security.id], '自选移除后不再攒点')
  c.reset()
  assert.deepEqual(calls.at(-1), ['clear'], '配置重载清空, 旧点不得混进新线')
  c.dispose()
  assert.equal(calls.filter(call => call[0] === 'clear').length, 2, '销毁时也清')
})
