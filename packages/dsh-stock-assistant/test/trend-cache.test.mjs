import test from 'node:test'
import assert from 'node:assert/strict'
import { createTrendCache } from '../src/trend-cache.mjs'

// 当日分时缓存:
//   Given 当日已成功取过一次分时
//   When 再次成功
//   Then 缓存被最新一次覆盖, 且只在数据属于当前市场日期时才算可用
const fakeTable = () => {
  const map = new Map()
  return { map, get: async key => map.get(key), put: async (key, value) => { map.set(key, value) }, delete: async key => { map.delete(key) } }
}
// 上海上午 10:00, 当天的分时最后一根在这里
const MONDAY = Date.parse('2026-11-16T02:00:00Z')
const atOf = ms => Math.floor(ms / 1000)
const candles = at => [{ time: '09:30', at: atOf(at) - 60, close: 10 }, { time: '09:31', at: atOf(at), close: 10.1 }]
const cacheAt = (table, now) => createTrendCache({ table, now: () => now })
const key = { market: 'XSHG', code: '600519', limit: 250 }

test('当日成功一次就写入, 再次成功覆盖前一份', async () => {
  const table = fakeTable(), cache = cacheAt(table, MONDAY)
  assert.equal(await cache.get(key), null, '没写过就是没有')
  await cache.put(key, { preClose: 10, complete: true, candles: candles(MONDAY) })
  assert.equal((await cache.get(key)).payload.candles.at(-1).close, 10.1)
  await cache.put(key, { preClose: 10, complete: true, candles: candles(MONDAY + 60 * 1000) })
  assert.equal((await cache.get(key)).payload.candles.at(-1).close, 10.1, '后一次覆盖前一次')
})

test('数据属于上一交易日就不算当日缓存', async () => {
  const table = fakeTable()
  // 周一盘前请求, 上游返回的是上周五的线: 不能存成"今天"的缓存
  const friday = Date.parse('2026-11-13T07:00:00Z')
  await cacheAt(table, MONDAY).put(key, { complete: true, candles: candles(friday) })
  assert.equal(await cacheAt(table, MONDAY).get(key), null)
})

test('上游回传上一交易日结果时保留已有的当日真实分时', async () => {
  const table = fakeTable(), cache = cacheAt(table, MONDAY)
  await cache.put(key, { complete: true, candles: candles(MONDAY) })
  await cache.put(key, { complete: true, candles: candles(MONDAY - 3 * 24 * 60 * 60 * 1000) })
  assert.deepEqual((await cache.get(key))?.payload.candles, candles(MONDAY))
})

test('跨日视为没有缓存, 且顺手删掉旧记录', async () => {
  const table = fakeTable(), cache = cacheAt(table, MONDAY)
  await cache.put(key, { complete: true, candles: candles(MONDAY) })
  const tomorrow = cacheAt(table, MONDAY + 24 * 60 * 60 * 1000)
  assert.equal(await tomorrow.get(key), null)
  assert.equal(table.map.size, 0, '过期记录不留着占淘汰池')
})

test('空结果与兜底结果都不写缓存', async () => {
  const table = fakeTable(), cache = cacheAt(table, MONDAY)
  await cache.put(key, { complete: true, candles: [] })
  await cache.put(key, { complete: false, candles: candles(MONDAY) })
  await cache.put(key, { complete: true, candles: candles(MONDAY), offline: { kind: 'ticks', points: 2 } })
  assert.equal(table.map.size, 0)
})

test('不同 limit 与不同市场各自一份', async () => {
  const table = fakeTable(), cache = cacheAt(table, MONDAY)
  await cache.put(key, { complete: true, candles: candles(MONDAY) })
  assert.equal(await cache.get({ ...key, limit: 1000 }), null, 'limit 不同不互相命中')
  assert.equal(await cache.get({ ...key, market: 'XNAS' }), null)
  assert.equal(await cache.get({ ...key, code: '000001' }), null)
})

test('存储层写失败不影响请求', async () => {
  const table = { get: async () => null, put: async () => { throw new Error('disk full') }, delete: async () => {} }
  const cache = cacheAt(table, MONDAY)
  await assert.doesNotReject(cache.put(key, { complete: true, candles: candles(MONDAY) }))
})

test('缓存不按路由代次拆分，换源后仍能读取当日真实分时', async () => {
  const table = fakeTable(), cache = cacheAt(table, MONDAY)
  await cache.put({ ...key, routeKey: '0:trend:0:em' }, { complete: true, candles: candles(MONDAY) })
  assert.equal((await cache.get({ ...key, routeKey: '0:trend:1:backup' }))?.payload.candles.at(-1).close, 10.1)
})

test('换源迁移不会覆盖目标键上已有的在飞窗口', async () => {
  const table = fakeTable(), cache = cacheAt(table, MONDAY)
  const { promise: holdA, resolve: releaseA } = Promise.withResolvers()
  const { promise: holdB, resolve: releaseB } = Promise.withResolvers()
  const { promise: aStarted, resolve: aReady } = Promise.withResolvers()
  const result = close => ({ complete: true, candles: candles(MONDAY).map(candle => ({ ...candle, close })) })
  const first = cache.fetch({ ...key, routeKey: 'old' }, undefined, async (signal, moveTo) => { aReady(); await holdA; moveTo({ ...key, routeKey: 'new' }); return result(11) })
  await aStarted
  const second = cache.fetch({ ...key, routeKey: 'new' }, undefined, async () => { await holdB; return result(12) })
  releaseA()
  await first
  releaseB()
  await second
  assert.equal((await cache.fetch({ ...key, routeKey: 'new' }, undefined, async () => result(13))).candles.at(-1).close, 12)
})

test('换源迁移也不会覆盖目标键上只有冷却的窗口', async () => {
  const table = fakeTable(), cache = cacheAt(table, MONDAY)
  const failed = cache.fetch({ ...key, routeKey: 'new' }, undefined, async () => { throw Object.assign(new Error('断网'), { code: 'NETWORK', status: 503 }) }).catch(error => error)
  assert.equal((await failed).code, 'NETWORK')
  const migrated = await cache.fetch({ ...key, routeKey: 'old' }, undefined, async (signal, moveTo) => {
    moveTo({ ...key, routeKey: 'new' })
    return { complete: true, candles: candles(MONDAY) }
  })
  assert.equal(migrated.candles.at(-1).close, 10.1)
  await assert.rejects(cache.fetch({ ...key, routeKey: 'new' }), { code: 'NETWORK' })
})
