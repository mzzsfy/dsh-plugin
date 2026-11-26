// 预算同源: 服务端把"一条请求最多能用多久"算在快照里, 客户端按它加裕度设时限。
// 两侧各自拍脑袋就是上一次的缺陷(服务端 24.5 秒, 客户端 11 秒先掐断)。
import test from 'node:test'
import assert from 'node:assert/strict'
import { createApplication } from '../src/application.mjs'
import { initialControl } from '../src/schemas.mjs'
import { routeTimeoutMs, requestBudgetMs, maxTickWaitMs, UPSTREAM_TIMEOUT_MS } from '../src/executor.mjs'
import { memoryStorage } from './helpers.mjs'

const prefsOf = seconds => ({ ...initialControl().preferences, refreshSeconds: seconds, floatRefreshSeconds: seconds })

test('路由预算等式: 半拍 + 组内间隔 + 上游预算 + 裕度, 内部预算再扣掉裕度', () => {
  // 字面量契约: 改公式必须同时改这里的期望, 否则客户端时限与服务端会再次脱节
  assert.equal(maxTickWaitMs(prefsOf(30)), 13500)
  assert.equal(routeTimeoutMs(prefsOf(30)), 13500 + 10000 + 8000 + 2000)
  assert.equal(requestBudgetMs(prefsOf(30)), 13500 + 10000 + 8000)
  assert.ok(requestBudgetMs(prefsOf(15)) > UPSTREAM_TIMEOUT_MS, '内部预算至少要放得下一段上游活动')
})

test('快照带出当前档位的路由预算, 客户端不必自己猜', async () => {
  const app = await createApplication({ storageDomain: memoryStorage(), providers: [], env: {} })
  try {
    const snapshot = app.snapshot()
    assert.equal(snapshot.timeouts.route, routeTimeoutMs(snapshot.control.preferences))
    assert.equal(snapshot.timeouts.route, routeTimeoutMs(initialControl().preferences))
  } finally { await app.close() }
})
