import test from 'node:test'
import assert from 'node:assert/strict'
import { openState } from '../src/state.mjs'
import { memoryStorage } from './helpers.mjs'

// 分时当日缓存与 K 线缓存必须是两个池:
//   Given 一天里会为每只打开过的票存一份分时
//   When 条目数超过池子上限
//   Then 淘汰只发生在自己的池里, 不把 K 线挤掉
test('分时缓存与 K 线缓存各用各的池, 淘汰互不牵连', async () => {
  const state = await openState(memoryStorage())
  assert.notEqual(state.trendCache, state.klineCache, '不是同一张表')
  for (let i = 0; i < 200; i++) await state.trendCache.put(`kline:${i}`, { i })
  assert.equal(state.klineCache.size, 0, '分时缓存写得再多也不占 K 线的名额')
  assert.ok(state.trendCache.size < 200, '分时缓存有自己的上限')
  for (let i = 0; i < 600; i++) await state.klineCache.put(`kline:${i}`, { i })
  assert.ok(state.trendCache.size > 0, 'K 线写满也不会清掉分时缓存')
  assert.ok(state.klineCache.size < 600, 'K 线池还是原来那个上限')
})
