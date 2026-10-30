import test from 'node:test'
import assert from 'node:assert/strict'
import { createRouter } from '../src/provider-router.mjs'
const route = { id: 'sh', capability: 'quotes', market: 'XSHG', instrument: 'equity', primaryInstanceId: 'a', fallbackInstanceIds: ['b'], failoverMode: 'network' }
const config = { routes: [route], providers: [{ id: 'a' }, { id: 'b' }] }
test('P06/P07/P08 路由连续网络失败才整源切换，429不切，返回不自动跳主源', () => {
  let now = 0
  const router = createRouter(() => config, () => now)
  assert.equal(router.select('quotes', 'XSHG').instance.id, 'a')
  router.recordRound('sh', { code: 'RATE_LIMIT' })
  assert.equal(router.select('quotes', 'XSHG').instance.id, 'a')
  for (let i = 0; i < 3; i++) router.recordRound('sh', { code: 'NETWORK' })
  assert.equal(router.select('quotes', 'XSHG').instance.id, 'b')
  assert.equal(router.select('quotes', 'XSHG').routeEpoch, 1)
  now = 60 * 60 * 1000
  router.switchPrimary('sh', 1)
  assert.equal(router.select('quotes', 'XSHG').instance.id, 'a')
  assert.equal(router.select('quotes', 'XSHG').routeEpoch, 2)
  router.recordRound('sh', { code: 'NETWORK' })
  for (let i = 0; i < 2; i++) router.recordRound('sh', { code: 'NETWORK' })
  assert.equal(router.select('quotes', 'XSHG').instance.id, 'b')
  assert.equal(router.select('quotes', 'XSHG').routeEpoch, 3)
  assert.throws(() => router.switchPrimary('sh', 3), e => e.code === 'ROUTE_DWELL')
})
