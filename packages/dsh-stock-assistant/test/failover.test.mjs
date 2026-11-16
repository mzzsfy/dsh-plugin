import test from 'node:test'
import assert from 'node:assert/strict'
import { createApplication } from '../src/application.mjs'
import { createCollector } from '../src/collector.mjs'
import { createRouter } from '../src/provider-router.mjs'
import { makeSecurity } from '../src/market-model.mjs'
import { initialControl } from '../src/schemas.mjs'
import { memoryStorage, provider } from './helpers.mjs'

// 主源整轮不可用时, 备源当轮就要顶上:
//   Given 报价主源每次请求都断网、备源正常
//   When 刷新一轮
//   Then 这一轮就出数据, 不等连续三次失败
//   And 主源的退避不连累备源, 下一次排期按正常间隔

const MAOTAI = makeSecurity('XSHG', '600519', '贵州茅台')
const quote = { securityId: MAOTAI.id, last: '10.00', previousClose: '8.00', quoteAt: null, receivedAt: 1, delayKind: 'unknown', delaySeconds: null }

const failoverConfig = () => {
  const base = { revision: 0, routingRevision: 0, preferences: { refreshSeconds: 5 }, watchlist: { order: [MAOTAI.id], items: { [MAOTAI.id]: MAOTAI } } }
  return { ...base, providers: [{ id: 'a', adapterId: 'fake', enabled: true, quotaGroup: 'a', budget: { requestsPerMinute: 50 } }, { id: 'b', adapterId: 'fake', enabled: true, quotaGroup: 'b', budget: { requestsPerMinute: 50 } }], routes: [{ id: 'sh', capability: 'quotes', market: 'XSHG', instrument: 'equity', primaryInstanceId: 'a', fallbackInstanceIds: ['b'], failoverMode: 'network', acceptUnknownDelay: true }] }
}

test('报价主源整轮断网时, 同一轮就用备源出数', async () => {
  const config = failoverConfig(), router = createRouter(() => config)
  const calls = []
  const c = createCollector({
    getControl: () => config, router, active: () => false, now: () => 1000,
    registry: { get: () => ({ descriptor: { maxQuoteBatch: 20 } }) },
    executor: { run: async instance => { calls.push(instance.id); if (instance.id === 'a') throw Object.assign(Error('offline'), { code: 'NETWORK' }); return { items: [{ ...quote, providerInstanceId: 'b' }], errors: [] } } },
  })
  await c.refresh()
  assert.deepEqual(calls, ['a', 'b'], '主源失败后当轮就打备源, 不是等下一轮')
  assert.equal(c.entries()[MAOTAI.id].quote.last, '10.00', '这一轮就有报价')
  c.dispose()
})

test('计满三次那轮切换后, 同一轮仍然出数', async () => {
  const config = failoverConfig(), router = createRouter(() => config)
  const calls = []
  const c = createCollector({
    getControl: () => config, router, active: () => false, now: () => 1000,
    registry: { get: () => ({ descriptor: { maxQuoteBatch: 20 } }) },
    executor: { run: async instance => { calls.push(instance.id); if (instance.id === 'a') throw Object.assign(Error('offline'), { code: 'NETWORK' }); return { items: [{ ...quote, providerInstanceId: 'b' }], errors: [] } } },
  })
  // 第三次失败会让路由器把当前选择切到备源; 这一轮的备源结果不能因为代次变了被丢掉
  for (let round = 1; round <= 3; round++) {
    await c.refresh()
    const entry = c.entries()[MAOTAI.id].quote
    assert.equal(entry.last, '10.00', `第 ${round} 轮都该有报价`)
    assert.equal(entry.routeEpoch, round === 3 ? 1 : 0, `第 ${round} 轮的数据带的是当轮代次`)
  }
  assert.deepEqual(calls, ['a', 'b', 'a', 'b', 'a', 'b'], '每轮都是主源失败后当轮打备源')
  assert.equal(router.select('quotes', 'XSHG').instance.id, 'b', '三轮之后当前选择落到备源')
  c.dispose()
})

test('主源正常时不碰备源, 也不记失败', async () => {
  const config = failoverConfig(), router = createRouter(() => config)
  const calls = []
  const c = createCollector({
    getControl: () => config, router, active: () => false, now: () => 1000,
    registry: { get: () => ({ descriptor: { maxQuoteBatch: 20 } }) },
    executor: { run: async instance => { calls.push(instance.id); return { items: [{ ...quote, providerInstanceId: instance.id }], errors: [] } } },
  })
  await c.refresh(); await c.refresh()
  assert.deepEqual(calls, ['a', 'a'], '主源好着就不该去动备源')
  assert.equal(router.selections().sh.failures, 0)
  c.dispose()
})

test('一次请求只试环上的下一格, 失败只记一次', async () => {
  const calls = []
  const adapters = ['eastmoney', 'tencent', 'sina', 'xueqiu'].map(adapterId => ({
    descriptor: { adapterId, capabilities: ['quotes', 'kline', 'trend'], markets: ['XHKG'], instruments: ['equity'], maxQuoteBatch: 20 },
    async probe(request) { return { status: 'ready', capability: request.capability, market: request.market, instrument: 'equity' } },
    async quotes() { return { providerInstanceId: `${adapterId}-one`, fetchedAt: 1, items: [], errors: [] } },
    async kline() { calls.push(`${adapterId}-one`); throw Object.assign(Error('offline'), { code: 'NETWORK' }) },
    async trend() { calls.push(`${adapterId}-one`); throw Object.assign(Error('offline'), { code: 'NETWORK' }) },
  }))
  const ids = ['em-one', 'tx-one', 'sina-one', 'xq-one']
  const names = ['eastmoney', 'tencent', 'sina', 'xueqiu']
  const storage = memoryStorage()
  const { routeMigration: _migration, ...legacy } = initialControl()
  storage.maps.control.set('root', {
    ...legacy,
    providers: ids.map((id, i) => ({ ...provider(id, names[i]), credentialRef: null, quotaGroup: id })),
    routes: [{ id: 'xhkg-kline', capability: 'kline', market: 'XHKG', instrument: 'equity', primaryInstanceId: 'em-one', fallbackInstanceIds: ['tx-one', 'sina-one', 'xq-one'], failoverMode: 'network', maxDelaySeconds: null, acceptUnknownDelay: true }],
  })
  let now = 1000
  const app = await createApplication({ storageDomain: storage, providers: adapters, env: {}, now: () => now })
  try {
    const request = { securityId: 'XHKG:equity:00700', period: '1d', limit: 20 }
    for (let round = 1; round <= 3; round++) {
      await app.kline(request).catch(() => {})
      const selection = app.snapshot().routeSelections['xhkg-kline']
      if (round < 3) assert.equal(selection.failures, round, `第 ${round} 次请求只记一次失败, 不是四个候选各记一次`)
      now += 1000
    }
    assert.equal(app.snapshot().routeSelections['xhkg-kline'].providerInstanceId, 'tx-one', '三轮之后才降一级')
    assert.deepEqual(calls, ['eastmoney-one', 'tencent-one', 'eastmoney-one', 'tencent-one', 'eastmoney-one', 'tencent-one'], '每轮只试当前和环上下一格, 不会一次把四个来源全打一遍')
  } finally { await app.close() }
})

test('主源恢复一次就把失败计数清零, 不攒够三次才换源', async () => {
  const config = failoverConfig(), router = createRouter(() => config)
  // 两轮失败 → 一轮成功 → 两轮失败: 中间那次成功把计数清了, 所以始终不该换源
  const primary = ['NETWORK', 'NETWORK', 'ok', 'NETWORK', 'NETWORK']
  let round = 0
  const c = createCollector({
    getControl: () => config, router, active: () => false, now: () => 1000,
    registry: { get: () => ({ descriptor: { maxQuoteBatch: 20 } }) },
    executor: { run: async instance => {
      if (instance.id !== 'a') return { items: [{ ...quote, providerInstanceId: instance.id }], errors: [] }
      if (primary[round++] !== 'ok') throw Object.assign(Error('offline'), { code: 'NETWORK' })
      return { items: [{ ...quote, providerInstanceId: instance.id }], errors: [] }
    } },
  })
  for (let i = 0; i < primary.length; i++) await c.refresh().catch(() => {})
  assert.equal(router.select('quotes', 'XSHG').instance.id, 'a', '中途成功过就不算连续三轮')
  assert.equal(router.selections().sh.failures, 2, '只累计成功之后的那两次')
  c.dispose()
})

test('后台回切换代次时, 在飞的刷新不报错', async () => {
  const config = failoverConfig(), router = createRouter(() => config)
  for (let i = 0; i < 3; i++) router.recordRound('sh', { code: 'NETWORK' })
  assert.equal(router.select('quotes', 'XSHG').instance.id, 'b', '先降级到备源')
  let release
  const c = createCollector({
    getControl: () => config, router, active: () => false, now: () => 1000,
    registry: { get: () => ({ descriptor: { maxQuoteBatch: 20 } }) },
    executor: { run: instance => new Promise(resolve => { release = () => resolve({ items: [{ ...quote, providerInstanceId: instance.id }], errors: [] }) }) },
  })
  const pending = c.refresh()
  await new Promise(resolve => setImmediate(resolve))
  // 回探在主源恢复后回切, 换代次会让这一批被判成旧路由; 这不是故障, 不该弹给用户
  router.recordProbe('sh', 'a', true, router.select('quotes', 'XSHG').routeEpoch)
  release()
  await pending
  assert.equal(router.select('quotes', 'XSHG').instance.id, 'a')
  c.dispose()
})

test('本地退避拦下的轮次不清空失败计数', async () => {
  const config = failoverConfig()
  // 备源被停用: 环上没有可退的, 走本地退避; 退避期间的轮次没打上游, 不能把失败计数清零
  config.providers[1] = { ...config.providers[1], enabled: false }
  const router = createRouter(() => config)
  const c = createCollector({
    getControl: () => config, router, active: () => false, now: () => 1000,
    registry: { get: () => ({ descriptor: { maxQuoteBatch: 20 } }) },
    executor: { run: async () => { throw Object.assign(Error('offline'), { code: 'NETWORK' }) } },
  })
  await c.refresh().catch(() => {})
  assert.equal(router.selections().sh.failures, 1, '第一轮真实打上游, 记一次')
  await c.refresh().catch(() => {})
  assert.equal(router.selections().sh.failures, 1, '第二轮被本地退避拦住, 既不加也不清零')
  c.dispose()
})

test('一路被取消、另一路真实故障时, 刷新照常报错', async () => {
  const other = makeSecurity('XSHE', '000001', '平安银行')
  const config = failoverConfig()
  config.watchlist = { order: [MAOTAI.id, other.id], items: { [MAOTAI.id]: MAOTAI, [other.id]: other } }
  config.routes.push({ ...config.routes[0], id: 'sz', market: 'XSHE' })
  const c = createCollector({
    getControl: () => config, router: createRouter(() => config), active: () => false, now: () => 1000,
    registry: { get: () => ({ descriptor: { maxQuoteBatch: 20 } }) },
    executor: { run: async (instance, capability, request) => {
      if (request.market === 'XSHG') throw Object.assign(Error('cancelled'), { code: 'CANCELLED' })
      throw Object.assign(Error('bad credential'), { code: 'AUTH' })
    } },
  })
  await assert.rejects(c.refresh(), e => e.code === 'AUTH', '凭据失效不能被一路取消盖掉, 否则界面静默给旧价')
  c.dispose()
})

test('多批里前一批成功、后一批网络失败, 也记一轮失败', async () => {
  const many = Array.from({ length: 25 }, (_, i) => makeSecurity('XSHG', String(600000 + i), `股票${i}`))
  const config = failoverConfig()
  config.watchlist = { order: many.map(s => s.id), items: Object.fromEntries(many.map(s => [s.id, s])) }
  const router = createRouter(() => config)
  const c = createCollector({
    getControl: () => config, router, active: () => false, now: () => 1000,
    registry: { get: () => ({ descriptor: { maxQuoteBatch: 20 } }) },
    executor: { run: async (instance, capability, request) => {
      if (instance.id === 'a' && request.securities.length < 20) throw Object.assign(Error('offline'), { code: 'NETWORK' })
      return { items: request.securities.map(s => ({ ...quote, securityId: s.id, providerInstanceId: instance.id })), errors: [] }
    } },
  })
  for (let i = 0; i < 3; i++) { await c.refresh().catch(() => {}); await new Promise(resolve => setImmediate(resolve)) }
  assert.notEqual(router.select('quotes', 'XSHG').instance.id, 'a', '尾部批次一直失败也要能把整条路由降级, 而不是永远卡在主源')
  c.dispose()
})

test('有备源时凭据失效也照旧永久暂停, 不会每轮重撞', async () => {
  const config = failoverConfig(), router = createRouter(() => config)
  const c = createCollector({
    getControl: () => config, router, active: () => false, now: () => 1000,
    registry: { get: () => ({ descriptor: { maxQuoteBatch: 20 } }) },
    executor: { run: async () => { throw Object.assign(Error('bad credential'), { code: 'AUTH' }) } },
  })
  await c.refresh().catch(() => {})
  assert.equal(router.selections().sh.failures, 0, '凭据失效不是网络问题, 不进降级计数')
  await assert.rejects(c.refresh(), e => e.code === 'SOURCE_PAUSED', '永久故障要停下, 不能每轮都拿同一个错误撞上游')
  c.dispose()
})

test('降到末级后继续失败三轮, 环回到主源', async () => {
  const config = failoverConfig(), router = createRouter(() => config)
  const c = createCollector({
    getControl: () => config, router, active: () => false, now: () => 1000,
    registry: { get: () => ({ descriptor: { maxQuoteBatch: 20 } }) },
    executor: { run: async () => { throw Object.assign(Error('offline'), { code: 'NETWORK' }) } },
  })
  const seen = []
  for (let i = 0; i < 6; i++) { await c.refresh().catch(() => {}); seen.push(router.select('quotes', 'XSHG').instance.id) }
  assert.deepEqual(seen, ['a', 'a', 'b', 'b', 'b', 'a'], '三级环要能转回来, 不能停在末级')
  c.dispose()
})

test('备源也断网时不重复请求同一个来源', async () => {
  const calls = { em: 0, tx: 0 }
  const candle = (time, close) => ({ time, at: 1, open: close, high: close, low: close, close, volume: 1 })
  const adapters = ['eastmoney', 'tencent'].map(adapterId => ({
    descriptor: { adapterId, capabilities: ['quotes', 'kline', 'trend'], markets: ['XHKG'], instruments: ['equity'], maxQuoteBatch: 20 },
    async probe(request) { return { status: 'ready', capability: request.capability, market: request.market, instrument: 'equity' } },
    async quotes() { return { providerInstanceId: `${adapterId}-one`, fetchedAt: 1, items: [], errors: [] } },
    async kline(request) { return { providerInstanceId: request.providerInstanceId, fetchedAt: 1, complete: true, preClose: 10, candles: [candle('2026-10-30', 10)] } },
    async trend(request) {
      calls[adapterId === 'eastmoney' ? 'em' : 'tx']++
      throw Object.assign(Error('offline'), { code: 'NETWORK' })
    },
  }))
  const storage = memoryStorage()
  const { routeMigration: _migration, ...legacy } = initialControl()
  storage.maps.control.set('root', {
    ...legacy,
    providers: [{ ...provider('em-one', 'eastmoney'), credentialRef: null, quotaGroup: 'em-one' }, { ...provider('tx-one', 'tencent'), credentialRef: null, quotaGroup: 'tx-one' }],
    routes: [{ id: 'xhkg-trend', capability: 'trend', market: 'XHKG', instrument: 'equity', primaryInstanceId: 'em-one', fallbackInstanceIds: ['tx-one'], failoverMode: 'network', maxDelaySeconds: null, acceptUnknownDelay: true }],
  })
  let now = 1000
  const app = await createApplication({ storageDomain: storage, providers: adapters, env: {}, now: () => now })
  try {
    // 连续三轮记满失败, 第四轮起路由器把当前选择定在备源; 备源此刻也断网
    for (let i = 0; i < 3; i++) { await app.kline({ securityId: 'XHKG:equity:00700', period: 'trend', limit: 250 }).catch(() => {}); now += 1000 }
    const before = calls.tx
    await app.kline({ securityId: 'XHKG:equity:00700', period: 'trend', limit: 250 }).catch(() => {})
    assert.equal(calls.tx - before, 1, '备源在一次请求里只该被调用一次')
  } finally { await app.close() }
})
