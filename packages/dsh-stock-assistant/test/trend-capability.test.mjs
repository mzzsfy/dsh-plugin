import test from 'node:test'
import assert from 'node:assert/strict'
import { createApplication } from '../src/application.mjs'
import { parseConfiguration } from '../src/schemas.mjs'
import { eastmoney } from '../src/providers/eastmoney.mjs'
import { tencent } from '../src/providers/tencent.mjs'
import { initialControl } from '../src/schemas.mjs'
import { memoryStorage, provider } from './helpers.mjs'

// 分时是独立能力:
//   Given K 线主源不支持分时(只有日/周/月的来源)
//   When 用户看分时
//   Then 分时走自己的路由, 不被 K 线主源连带打死
//   Given 存量配置没有分时路由
//   When 升级后打开
//   Then 按适配器能力声明补一条, 指向真正支持分时的源

const candle = (time, close) => ({ time, at: 1, open: close, high: close, low: close, close, volume: 1, amount: 1 })
const klineBody = (instanceId, close) => ({ providerInstanceId: instanceId, fetchedAt: 1, complete: true, preClose: close, candles: [candle('2026-10-30', close)] })
const trendBody = instanceId => ({ providerInstanceId: instanceId, fetchedAt: 1, complete: true, preClose: 10, candles: [candle('09:30', 10), candle('15:00', 11)] })

const MARKETS = ['XSHG', 'XSHE', 'XHKG', 'XNAS', 'XNYS', 'XJPX', 'XKRX', 'XLON']

// 两个假适配器: 一个声明分时, 一个只有 K 线。名字不能借用真实来源: 真实腾讯已经声明 trend
function adapters() {
  const calls = { trend: 0, kline: 0 }
  const em = {
    descriptor: { adapterId: 'eastmoney', capabilities: ['quotes', 'kline', 'trend'], markets: MARKETS, instruments: ['equity'], maxQuoteBatch: 20 },
    async probe(request) { return { status: 'ready', capability: request.capability, market: request.market, instrument: 'equity' } },
    async quotes() { return { providerInstanceId: 'em-one', fetchedAt: 1, items: [], errors: [] } },
    async kline(request) { calls.kline++; return klineBody(request.providerInstanceId, 99) },
    async trend(request) { calls.trend++; return trendBody(request.providerInstanceId) },
  }
  const tx = {
    descriptor: { adapterId: 'kline-only', capabilities: ['kline'], markets: MARKETS, instruments: ['equity'] },
    async probe(request) { return { status: 'ready', capability: request.capability, market: request.market, instrument: 'equity' } },
    async kline(request) { calls.kline++; return klineBody(request.providerInstanceId, 20) },
  }
  return { calls, providers: [em, tx] }
}

const routeOf = (capability, market = 'XHKG', primary = 'em-one') => ({ id: `${market.toLowerCase()}-${capability}`, capability, market, instrument: 'equity', primaryInstanceId: primary, fallbackInstanceIds: [], failoverMode: 'off', maxDelaySeconds: null, acceptUnknownDelay: true })
// 免凭据实例: credentialRef 为 null 才不需要环境里的密钥
const instances = () => [provider('em-one', 'eastmoney'), provider('tx-one', 'kline-only')].map(p => ({ ...p, credentialRef: null }))

// 存量配置: 八市场 K 线全指给只有日 K 的源, 且没有分时路由(旧版本写下的形态, 也没有迁移标记)
function legacyStorage() {
  const storage = memoryStorage()
  const { routeMigration: _migration, ...legacy } = initialControl()
  storage.maps.control.set('root', { ...legacy, providers: instances(), routes: MARKETS.map(market => routeOf('kline', market, 'tx-one')) })
  return storage
}

const idsOf = routes => routes.filter(r => r.capability === 'trend').map(r => r.id).sort()

test('默认配置给每个市场一条独立的分时路由, 主源声明了 trend', async () => {
  const app = await createApplication({ storageDomain: memoryStorage(), env: {}, now: () => 1000 })
  try {
    const snap = app.snapshot(), routes = snap.control.routes
    assert.deepEqual(idsOf(routes), MARKETS.map(market => `${market.toLowerCase()}-trend`).sort())
    const targets = new Map(snap.adapters.map(a => [a.adapterId, a.capabilities]))
    for (const route of routes.filter(r => r.capability === 'trend')) {
      const instance = snap.control.providers.find(p => p.id === route.primaryInstanceId)
      assert.equal(targets.get(instance.adapterId).includes('trend'), true, `${route.id} 的主源必须声明分时`)
    }
    // 推荐配置也要生成分时, 否则「应用推荐配置」会把分时删掉
    assert.equal(idsOf(snap.suggested.routes).length, 8)
    // 分时子额度要覆盖浮窗最快档(3 秒一拍 = 20 次/分), 顶格会自己限流
    assert.equal(snap.control.providers.find(p => p.adapterId === 'eastmoney').budget.capabilityLimits.trend, 30)
  } finally { await app.close() }
})

test('适配器能力矩阵: 东财与腾讯都声明分时', () => {
  assert.equal(eastmoney.descriptor.capabilities.includes('trend'), true)
  assert.equal(eastmoney.descriptor.capabilities.includes('kline'), true)
  // 真实腾讯有 trend(量能按分钟增量差分): 这条断言防止能力声明被误删后又回到「腾讯只有 K 线」的旧模型
  assert.equal(tencent.descriptor.capabilities.includes('trend'), true)
  assert.equal(tencent.descriptor.capabilities.includes('kline'), true)
})

test('存量配置缺分时路由时启动补齐, 且不跟 K 线主源走', async () => {
  const { providers } = adapters()
  const storage = legacyStorage()
  // 同一额度组两次请求要隔开一秒(预算按秒防连打)
  let now = 1000
  const app = await createApplication({ storageDomain: storage, providers, env: {}, now: () => now })
  try {
    const snap = app.snapshot()
    const trend = snap.control.routes.filter(r => r.capability === 'trend')
    assert.equal(trend.length, 8, '每个有 K 线的市场都补出分时路由')
    assert.deepEqual(trend.map(r => r.primaryInstanceId).filter(id => id === 'em-one').length, 8, '补出来的分时指向声明了分时的源')
    assert.equal(snap.control.routes.filter(r => r.capability === 'kline').every(r => r.primaryInstanceId === 'tx-one'), true, 'K 线路由原样保留')
    // 分时真的走通, 不再报「来源不提供分时」
    const trendResult = await app.kline({ securityId: 'XHKG:equity:02513', period: 'trend', limit: 250 })
    assert.equal(trendResult.source, 'em-one')
    assert.equal(trendResult.candles.length, 2)
    now += 1000
    const klineResult = await app.kline({ securityId: 'XHKG:equity:02513', period: '1d', limit: 250 })
    assert.equal(klineResult.source, 'tx-one', '日 K 仍走原来的 K 线路由')
  } finally { await app.close() }
})

// 分时只有一个来源时, 它一断整块就空白: 启动时要把其它声明分时的实例登记成备源
test('单源分时路由在启动时补上备源并允许网络失败自动切换', async () => {
  const body = (request, close) => ({ providerInstanceId: request.providerInstanceId, fetchedAt: 1, complete: true, preClose: 10, candles: [candle('09:30', close), candle('15:00', close)] })
  const providers = ['eastmoney', 'kline-only'].map(adapterId => ({
    descriptor: { adapterId, capabilities: ['quotes', 'kline', 'trend'], markets: ['XHKG'], instruments: ['equity'], maxQuoteBatch: 20 },
    async probe(request) { return { status: 'ready', capability: request.capability, market: request.market, instrument: 'equity' } },
    async quotes() { return { providerInstanceId: `${adapterId}-one`, fetchedAt: 1, items: [], errors: [] } },
    async kline(request) { return body(request, 20) },
    async trend(request) { return body(request, adapterId === 'eastmoney' ? 10 : 11) },
  }))
  const storage = memoryStorage()
  const { routeMigration: _migration, ...legacy } = initialControl()
  storage.maps.control.set('root', { ...legacy, providers: [{ ...provider('em-one', 'eastmoney'), credentialRef: null }, { ...provider('tx-one', 'kline-only'), credentialRef: null }], routes: [routeOf('trend', 'XHKG', 'em-one')] })
  const app = await createApplication({ storageDomain: storage, providers, env: {}, now: () => 1000 })
  try {
    const route = app.snapshot().control.routes.find(r => r.capability === 'trend' && r.market === 'XHKG')
    assert.deepEqual(route.fallbackInstanceIds, ['tx-one'], '把另一个声明分时的实例登记为备源')
    assert.equal(route.failoverMode, 'network', '主源网络失败时才切, 不是每拍都试备源')
  } finally { await app.close() }
})

test('已经有备源的分时路由不被重复改写', async () => {
  const providers = ['eastmoney', 'kline-only'].map(adapterId => ({
    descriptor: { adapterId, capabilities: ['trend'], markets: ['XHKG'], instruments: ['equity'], maxQuoteBatch: 20 },
    async probe(request) { return { status: 'ready', capability: request.capability, market: request.market, instrument: 'equity' } },
    async trend(request) { return { providerInstanceId: request.providerInstanceId, fetchedAt: 1, complete: true, preClose: 10, candles: [candle('09:30', 10)] } },
  }))
  const storage = memoryStorage()
  const { routeMigration: _migration, ...legacy } = initialControl()
  const kept = { ...routeOf('trend', 'XHKG', 'em-one'), fallbackInstanceIds: ['tx-one'], failoverMode: 'network' }
  storage.maps.control.set('root', { ...legacy, providers: [{ ...provider('em-one', 'eastmoney'), credentialRef: null }, { ...provider('tx-one', 'kline-only'), credentialRef: null }], routes: [kept] })
  const app = await createApplication({ storageDomain: storage, providers, env: {}, now: () => 1000 })
  try {
    assert.deepEqual(app.snapshot().control.routes.find(r => r.capability === 'trend').fallbackInstanceIds, ['tx-one'], '不重复追加')
  } finally { await app.close() }
})

test('已有备用链的分时路由不被迁移改写', async () => {
  const providers = ['eastmoney', 'kline-only'].map(adapterId => ({
    descriptor: { adapterId, capabilities: ['trend'], markets: ['XHKG'], instruments: ['equity'], maxQuoteBatch: 20 },
    async probe(request) { return { status: 'ready', capability: request.capability, market: request.market, instrument: 'equity' } },
    async trend(request) { return { providerInstanceId: request.providerInstanceId, fetchedAt: 1, complete: true, preClose: 10, candles: [candle('09:30', 10)] } },
  }))
  const storage = memoryStorage()
  const { routeMigration: _migration, ...legacy } = initialControl()
  const kept = { ...routeOf('trend', 'XHKG', 'em-one'), fallbackInstanceIds: ['tx-one'], failoverMode: 'off' }
  storage.maps.control.set('root', { ...legacy, providers: [{ ...provider('em-one', 'eastmoney'), credentialRef: null }, { ...provider('tx-one', 'kline-only'), credentialRef: null }], routes: [kept] })
  const app = await createApplication({ storageDomain: storage, providers, env: {}, now: () => 1000 })
  try {
    const route = app.snapshot().control.routes.find(r => r.capability === 'trend')
    assert.equal(route.failoverMode, 'off', '用户关掉的开关不被迁移打开')
    assert.deepEqual(route.fallbackInstanceIds, ['tx-one'], '用户已经配好的备用链保持原样')
  } finally { await app.close() }
})

test('暂时没有分时源时不烧迁移标记: 之后装上东财还能自动补, 且不要求该市场有 K 线路由', async () => {
  const { providers } = adapters()
  const storage = memoryStorage()
  const { routeMigration: _migration, ...legacy } = initialControl()
  // 存量: 只有腾讯(不声明分时), 且日韩英只有目录/搜索路由、没有 K 线路由
  storage.maps.control.set('root', {
    ...legacy,
    providers: [{ ...provider('tx-one', 'kline-only'), credentialRef: null }],
    routes: [routeOf('kline', 'XHKG', 'tx-one'), routeOf('catalog', 'XJPX', 'tx-one'), routeOf('search', 'XJPX', 'tx-one')],
  })
  const first = await createApplication({ storageDomain: storage, providers, env: {}, now: () => 1000 })
  try {
    assert.equal(first.snapshot().control.routes.some(r => r.capability === 'trend'), false, '没有可承接的来源就不补空路由')
    assert.equal(storage.maps.control.get('root').routeMigration, undefined, '不烧标记, 留给能补的时候')
  } finally { await first.close() }
  // 用户后来装上东财: 重启后连「只有目录/搜索」的市场也要有分时
  storage.maps.control.set('root', { ...storage.maps.control.get('root'), providers: instances() })
  const second = await createApplication({ storageDomain: storage, providers, env: {}, now: () => 1000 })
  try {
    assert.deepEqual(idsOf(second.snapshot().control.routes), ['xhkg-trend', 'xjpx-trend'])
  } finally { await second.close() }
})

test('迁移只做一次: 用户删掉分时路由后重启不再补回来', async () => {
  const { providers } = adapters()
  const storage = legacyStorage()
  const first = await createApplication({ storageDomain: storage, providers, env: {}, now: () => 1000 })
  assert.equal(first.snapshot().control.routes.filter(r => r.capability === 'trend').length, 8)
  await first.close()
  // 模拟用户在设置页删掉全部分时路由并保存
  const root = storage.maps.control.get('root')
  storage.maps.control.set('root', { ...root, revision: root.revision + 1, routes: root.routes.filter(r => r.capability !== 'trend') })
  const second = await createApplication({ storageDomain: storage, providers, env: {}, now: () => 1000 })
  try {
    assert.equal(second.snapshot().control.routes.some(r => r.capability === 'trend'), false, '被删掉的分时路由不该复活')
  } finally { await second.close() }
})

test('没有分时路由也没有支持分时的源时, 报错指明分时来源未配置', async () => {
  const onlyKline = {
    descriptor: { adapterId: 'kline-only', capabilities: ['kline'], markets: ['XHKG'], instruments: ['equity'] },
    async probe(request) { return { status: 'ready', capability: request.capability } },
    async kline(request) { return klineBody(request.providerInstanceId, 20) },
  }
  const storage = memoryStorage()
  const control = initialControl()
  control.providers = [{ ...provider('tx-one', 'kline-only'), credentialRef: null }]
  control.routes = [routeOf('kline', 'XHKG', 'tx-one')]
  storage.maps.control.set('root', control)
  const app = await createApplication({ storageDomain: storage, providers: [onlyKline], env: {}, now: () => 1000 })
  try {
    assert.equal(app.snapshot().control.routes.some(r => r.capability === 'trend'), false, '没有源声明分时就不补空路由')
    await assert.rejects(app.kline({ securityId: 'XHKG:equity:02513', period: 'trend', limit: 250 }), e => e.code === 'NO_ROUTE' && /分时/.test(e.message))
  } finally { await app.close() }
})

test('分时复用同分钟的真线，日 K 普通请求缓存而强刷仍回源', async () => {
  const { calls, providers } = adapters()
  const storage = memoryStorage()
  const control = initialControl()
  control.providers = instances()
  control.routes = [routeOf('kline', 'XHKG', 'tx-one'), routeOf('trend', 'XHKG', 'em-one')]
  storage.maps.control.set('root', control)
  // 同一额度组两次请求要隔开一秒(预算按秒防连打), 缓存命中不触源所以不需要等待
  let now = 1000
  const app = await createApplication({ storageDomain: storage, providers, env: {}, now: () => now })
  const request = async (period, force) => { now += 1000; return app.kline({ securityId: 'XHKG:equity:02513', period, limit: 250, force }) }
  try {
    await request('trend')
    await request('trend')
    assert.equal(calls.trend, 1, '分时同一分钟复用')
    await request('1d')
    await request('1d')
    assert.equal(calls.kline, 1, '日 K 正常走缓存')
    await request('1d', '1')
    assert.equal(calls.kline, 2, '日 K 强刷跳过缓存')
  } finally { await app.close() }
})

test('分时路由允许备源(与报价/K线同构), 只有非行情类能力禁止', () => {
  const config = { providers: [{ ...provider('em-one', 'eastmoney'), credentialRef: null }, { ...provider('em-two', 'eastmoney'), credentialRef: null }], routes: [{ ...routeOf('trend', 'XSHG', 'em-one'), fallbackInstanceIds: ['em-two'], failoverMode: 'network' }] }
  assert.equal(parseConfiguration(config).routes[0].capability, 'trend')
  assert.throws(() => parseConfiguration({ ...config, routes: [{ ...routeOf('catalog', 'XSHG', 'em-one'), fallbackInstanceIds: ['em-two'], failoverMode: 'network' }] }), e => e.code === 'INVALID_ROUTE')
})

test('适配器声明了分时却没有 trend 方法被视为合同不完整', async () => {
  const broken = { descriptor: { adapterId: 'broken', capabilities: ['trend'], markets: ['XHKG'], instruments: ['equity'] }, async probe() { return { status: 'ready' } } }
  await assert.rejects(createApplication({ storageDomain: memoryStorage(), providers: [broken], env: {}, now: () => 1000 }), e => e.code === 'INVALID_ADAPTER')
})

test('探针返回的能力与路由能力不一致时不算就绪', async () => {
  const liar = {
    descriptor: { adapterId: 'liar', capabilities: ['trend'], markets: ['XHKG'], instruments: ['equity'] },
    async probe() { return { status: 'ready', capability: 'quotes', market: 'XHKG', instrument: 'equity' } },
    async trend(request) { return trendBody(request.providerInstanceId) },
  }
  const app = await createApplication({ storageDomain: memoryStorage(), providers: [liar], env: {}, now: () => 1000 })
  try {
    const checked = await app.providerCheck({ providers: [{ ...provider('liar-one', 'liar'), credentialRef: null }], routes: [routeOf('trend', 'XHKG', 'liar-one')], capabilities: ['trend'] })
    assert.equal(checked.checks.length, 1)
    assert.equal(checked.checks[0].status, 'unavailable', '拿行情接口垫背的探针不能报分时就绪')
  } finally { await app.close() }
})

test('解除采集暂停只认行情探针(分时失败不该挡住行情恢复)', async () => {
  const { readFileSync } = await import('node:fs')
  const src = readFileSync(new URL('../src/application.mjs', import.meta.url), 'utf8')
  const lines = src.split('\n')
  const at = lines.findIndex(line => line.includes('collector.resume()'))
  assert.ok(at > 0, '找不到 resume 判定')
  assert.match(lines[at - 1] + lines[at], /capability === 'quotes'/, 'resume 的语义是行情采集可用了, 不能被分时探针结果绑架')
})

test('设置页可以对分时单独探一次', async () => {
  const { providers } = adapters()
  const app = await createApplication({ storageDomain: memoryStorage(), providers, env: {}, now: () => 1000 })
  try {
    const providersOf = { providers: instances().slice(0, 1), routes: [routeOf('trend', 'XHKG', 'em-one')] }
    const checked = await app.providerCheck({ ...providersOf, capabilities: ['trend'] })
    assert.equal(checked.checks.length, 1)
    assert.equal(checked.checks[0].capability, 'trend')
    assert.equal(checked.checks[0].status, 'ready')
  } finally { await app.close() }
})
