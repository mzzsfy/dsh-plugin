import test from 'node:test'
import assert from 'node:assert/strict'
import { parseConfiguration, initialControl, marketSchema, klineQuerySchema, capability } from '../src/schemas.mjs'
import { provider, route } from './helpers.mjs'
test('配置拒绝重复能力路由与不同变量外的密钥字段', () => {
  assert.throws(() => parseConfiguration({ providers: [provider()], routes: [route(), { ...route(), id: 'other' }] }))
  assert.throws(() => parseConfiguration({ providers: [{ ...provider(), token: 'secret' }], routes: [] }))
  assert.equal(parseConfiguration({ providers: [provider()], routes: [route()] }).routes.length, 1)
})
// D1: Given全新安装 When取初始控制状态 Then内置免凭据默认实例(目录新浪+行情搜索东财)与沪深六条路由,配置自身合法
test('初始控制状态内置免凭据默认实例与全市场四能力路由', () => {
  const control = initialControl()
  const MARKETS = ['XSHG', 'XSHE', 'XHKG', 'XNAS', 'XNYS', 'XJPX', 'XKRX', 'XLON']
  assert.equal(control.providers.length, 3, '三个免凭据源全开')
  assert.deepEqual(control.providers.map(p => p.adapterId).sort(), ['eastmoney', 'sina', 'tencent'])
  const catalogInstance = control.providers.find(p => p.adapterId === 'sina')
  const marketInstance = control.providers.find(p => p.adapterId === 'eastmoney')
  for (const p of control.providers) { assert.equal(p.credentialEnv, null, '默认实例不需要凭据'); assert.ok(p.budget.requestsPerMinute > 0) }
  // 目录只有沪深港美有来源节点;搜索/报价/K线八市场齐备
  const NODE_MARKETS = ['XSHG', 'XSHE', 'XHKG', 'XNAS', 'XNYS']
  assert.equal(control.routes.length, NODE_MARKETS.length + MARKETS.length * 3, '目录五市场 + 其余能力八市场')
  for (const m of MARKETS) for (const capability of ['search', 'quotes', 'kline', 'catalog']) {
    const r = control.routes.find(route => route.market === m && route.capability === capability)
    if (!NODE_MARKETS.includes(m) && capability === 'catalog') { assert.equal(r, undefined, `${m} 无目录来源节点时不应配目录路由`); continue }
    assert.ok(r, `${m} 缺 ${capability} 路由`)
    const expected = capability === 'catalog' && (m === 'XSHG' || m === 'XSHE') ? catalogInstance.id : marketInstance.id
    assert.equal(r.primaryInstanceId, expected, `${m}/${capability} 主源`)
  }
  // 备用源只允许出现在报价与K线,且只在备用源探针可验证的市场
  const fallbacks = control.routes.filter(route => route.fallbackInstanceIds.length)
  const quoteBackups = fallbacks.filter(route => route.capability === 'quotes')
  const klineBackups = fallbacks.filter(route => route.capability === 'kline')
  assert.equal(quoteBackups.length, NODE_MARKETS.length, '报价备源覆盖沪深港美')
  assert.equal(klineBackups.length, 3, 'K线备源只覆盖沪深港(腾讯美股需先建立代码映射)')
  assert.ok(fallbacks.every(route => ['quotes', 'kline'].includes(route.capability)), '目录与搜索不得配置备用源')
  assert.ok(fallbacks.every(route => route.failoverMode === 'network'))
  assert.ok(quoteBackups.every(route => route.fallbackInstanceIds[0] === 'sn-default'), '报价备源为新浪')
  assert.ok(quoteBackups.every(route => NODE_MARKETS.includes(route.market)))
  assert.ok(klineBackups.every(route => route.fallbackInstanceIds[0] === 'tx-backup'), 'K线备源为腾讯')
  assert.ok(klineBackups.every(route => ['XSHG', 'XSHE', 'XHKG'].includes(route.market)))
  assert.doesNotThrow(() => parseConfiguration({ providers: control.providers, routes: control.routes }))
})

// ---- Step 1.1: kline 能力 + 八市场枚举 + 备源守卫放宽 + endpoints + klineQuerySchema ----

test('capability 枚举含 kline 且 klineQuerySchema 校验与默认值', () => {
  assert.ok(capability.options.includes('kline'))
  const ok = klineQuerySchema.parse({ securityId: 'XSHG:equity:600519', period: '1d' })
  assert.equal(ok.limit, 250)
  assert.equal(klineQuerySchema.parse({ securityId: 'XHKG:equity:00700', period: 'trend', limit: 20 }).limit, 20)
  for (const bad of [{ securityId: 'XSHG:equity:600519', period: '5m' }, { securityId: 'XSHG:equity:600519', period: '1d', limit: 19 }, { securityId: 'XSHG:equity:600519', period: '1d', limit: 1001 }, { period: '1d' }]) {
    assert.throws(() => klineQuerySchema.parse(bad))
  }
})

test('marketSchema 八市场且 routeSchema 引用同源', () => {
  const markets = ['XSHG', 'XSHE', 'XHKG', 'XNAS', 'XNYS', 'XJPX', 'XKRX', 'XLON']
  assert.deepEqual(marketSchema.options, markets)
  for (const m of markets) assert.doesNotThrow(() => parseConfiguration({ providers: [provider()], routes: [{ ...route('ts-one', m, 'quotes'), primaryInstanceId: 'ts-one' }] }))
  assert.throws(() => parseConfiguration({ providers: [provider()], routes: [route('ts-one', 'XAMEX', 'quotes')] }))
})

test('kline 路由允许备源而 catalog 仍拒绝', () => {
  const base = { providers: [provider(), provider('ts-two', 'tushare')], routes: [] }
  const klineRoute = { ...route('ts-one', 'XHKG', 'kline'), id: 'xhkg-kline', fallbackInstanceIds: ['ts-two'], failoverMode: 'network' }
  assert.doesNotThrow(() => parseConfiguration({ ...base, routes: [klineRoute] }))
  const catalogRoute = { ...route('ts-one', 'XSHG', 'catalog'), id: 'xshg-catalog', fallbackInstanceIds: ['ts-two'], failoverMode: 'network' }
  assert.throws(() => parseConfiguration({ ...base, routes: [catalogRoute] }))
})

test('endpoints 覆盖块校验合法 URL 且可省略', () => {
  const withEndpoints = { ...provider(), endpoints: { kline: 'https://example.com/kline?symbol={symbol}&period={period}&limit={limit}' } }
  assert.doesNotThrow(() => parseConfiguration({ providers: [withEndpoints], routes: [] }))
  const bad = { ...provider(), endpoints: { kline: 'not-a-url' } }
  assert.throws(() => parseConfiguration({ providers: [bad], routes: [] }))
  assert.throws(() => parseConfiguration({ providers: [{ ...provider(), endpoints: { kline: 42 } }], routes: [] }))
})

test('proxy 仅接受 http(s) URL 且可省略(反代/代理出口)', () => {
  assert.doesNotThrow(() => parseConfiguration({ providers: [provider()], routes: [] }))
  assert.doesNotThrow(() => parseConfiguration({ providers: [{ ...provider(), proxy: 'http://127.0.0.1:7890' }], routes: [] }))
  assert.doesNotThrow(() => parseConfiguration({ providers: [{ ...provider(), proxy: 'https://user:pass@proxy.corp:8443' }], routes: [] }))
  assert.throws(() => parseConfiguration({ providers: [{ ...provider(), proxy: 'socks5://127.0.0.1:1080' }], routes: [] }))
  assert.throws(() => parseConfiguration({ providers: [{ ...provider(), proxy: 'not-a-url' }], routes: [] }))
})
