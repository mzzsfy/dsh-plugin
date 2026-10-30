import test from 'node:test'
import assert from 'node:assert/strict'
import { parseConfiguration, initialControl } from '../src/schemas.mjs'
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
