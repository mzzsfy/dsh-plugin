import test from 'node:test'
import assert from 'node:assert/strict'
import { createKlineCache } from '../src/kline-cache.mjs'
import { memoryStorage } from './helpers.mjs'

const keyParts = { providerInstanceId: 'em-default', market: 'XSHG', period: '1d', code: '600519' }
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
  await domain.table('cache').put('kline:em-default:XSHG:1d:600519', { kind: 'kline' })
  let now = 1_000_000_000_000
  const cache = createKlineCache({ cacheTable: domain.table('cache'), now: () => now })
  assert.equal(await cache.get(keyParts, 0), null)
})

test('trend TTL=0 put 跳过写入 get 恒 miss', async () => {
  const { cache } = await setup()
  await cache.put({ ...keyParts, period: 'trend' }, payload, 0)
  assert.equal(await cache.get({ ...keyParts, period: 'trend' }, 0), null)
})

test('invalidate 删除指定条目', async () => {
  const { cache } = await setup()
  await cache.put(keyParts, payload, 0)
  await cache.invalidate(keyParts)
  assert.equal(await cache.get(keyParts, 0), null)
})

test('缓存存储异常时 put 静默不阻塞', async () => {
  const storage = memoryStorage()
  storage.broken = true
  const domain = await storage.open()
  let now = 1_000_000_000_000
  const cache = createKlineCache({ cacheTable: domain.table('cache'), now: () => now })
  await assert.doesNotReject(() => cache.put(keyParts, payload, 0))
})
