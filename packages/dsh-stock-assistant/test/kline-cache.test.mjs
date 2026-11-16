import test from 'node:test'
import assert from 'node:assert/strict'
import { createKlineCache } from '../src/kline-cache.mjs'
import { memoryStorage } from './helpers.mjs'

const keyParts = { providerInstanceId: 'em-default', market: 'XSHG', period: '1d', code: '600519', limit: 250 }
const payload = { providerInstanceId: 'em-default', candles: [{ time: '2026-10-30', open: 1, high: 2, low: 0.5, close: 1.5, volume: 100 }], preClose: 1.4, complete: true, routingRevision: 0 }

const setup = async () => {
  const storage = memoryStorage()
  const domain = await storage.open()
  let now = 1_000_000_000_000
  const cache = createKlineCache({ cacheTable: domain.table('cache'), now: () => now })
  return { cache, tick: ms => { now += ms }, domain }
}

test('put 后 get 命中且 payload 原样返回', async () => {
  const { cache } = await setup()
  await cache.put(keyParts, payload, 0)
  const hit = await cache.get(keyParts, 0)
  assert.deepEqual(hit.payload.candles, payload.candles)
  assert.equal(hit.payload.preClose, 1.4)
  assert.equal(hit.source, 'em-default')
})

test('TTL 过期边界: 1d 期限内命中 超期 miss', async () => {
  const { cache, tick } = await setup()
  await cache.put(keyParts, payload, 0)
  tick(60 * 60 * 1000 - 1)
  assert.ok(await cache.get(keyParts, 0))
  tick(1)
  assert.equal(await cache.get(keyParts, 0), null)
})

test('1w/1M TTL 24 小时', async () => {
  const { cache, tick } = await setup()
  const week = { ...keyParts, period: '1w' }
  await cache.put(week, payload, 0)
  tick(24 * 60 * 60 * 1000 - 1)
  assert.ok(await cache.get(week, 0))
  tick(1)
  assert.equal(await cache.get(week, 0), null)
})

test('routingRevision 不符 miss', async () => {
  const { cache } = await setup()
  await cache.put(keyParts, payload, 0)
  assert.equal(await cache.get(keyParts, 1), null)
})

test('损坏条目 miss 且不抛', async () => {
  const storage = memoryStorage()
  const domain = await storage.open()
  await domain.table('cache').put('kline:em-default:XSHG:1d:600519:250', { kind: 'kline' })
  let now = 1_000_000_000_000
  const cache = createKlineCache({ cacheTable: domain.table('cache'), now: () => now })
  assert.equal(await cache.get(keyParts, 0), null)
})

// 回归: 不同 limit 的同一标的/周期结果长度不同, 缓存 key 必须隔离 limit
test('不同 limit 不互相命中', async () => {
  const { cache } = await setup()
  await cache.put({ ...keyParts, limit: 250 }, payload, 0)
  assert.equal(await cache.get({ ...keyParts, limit: 1000 }, 0), null)
  assert.ok(await cache.get({ ...keyParts, limit: 250 }, 0))
})

test('TTL 过期即删, 不留空记录', async () => {
  const { cache, domain, tick } = await setup()
  await cache.put(keyParts, payload, 0)
  tick(60 * 60 * 1000)
  assert.equal(await cache.get(keyParts, 0), null)
  assert.equal([...domain.table('cache').entries()].length, 0)
})

test('缓存存储异常时 put 静默不阻塞', async () => {
  const storage = memoryStorage()
  storage.broken = true
  const domain = await storage.open()
  let now = 1_000_000_000_000
  const cache = createKlineCache({ cacheTable: domain.table('cache'), now: () => now })
  await assert.doesNotReject(() => cache.put(keyParts, payload, 0))
})
