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
test('初始控制状态内置免凭据默认实例与沪深三能力路由', () => {
  const control = initialControl()
  assert.equal(control.providers.length, 2)
  const catalogInstance = control.providers.find(p => p.adapterId === 'sina')
  const marketInstance = control.providers.find(p => p.adapterId === 'eastmoney')
  assert.equal(catalogInstance.credentialEnv, null)
  assert.equal(marketInstance.credentialEnv, null)
  for (const p of control.providers) assert.ok(p.budget.requestsPerMinute > 0)
  assert.equal(control.routes.length, 6)
  for (const m of ['XSHG', 'XSHE']) for (const capability of ['catalog', 'search', 'quotes']) {
    const r = control.routes.find(r => r.market === m && r.capability === capability)
    assert.equal(r.primaryInstanceId, capability === 'catalog' ? catalogInstance.id : marketInstance.id)
  }
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
