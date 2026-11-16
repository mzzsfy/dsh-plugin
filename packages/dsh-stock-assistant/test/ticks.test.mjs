import test from 'node:test'
import assert from 'node:assert/strict'
import { createTickStore } from '../src/ticks.mjs'
import { clockInZone } from '../src/market-model.mjs'

// 报价拍点:
//   Given 报价轮询每拍都在刷新
//   When 分时上游不可用
//   Then 用当日拍点拼一条简单的线, 同一分钟只留最后一条, 证券数与点数都有上限
const SHANGHAI_OPEN = Date.parse('2026-11-16T01:30:00Z') / 1000
const atMinute = minute => SHANGHAI_OPEN + minute * 60
const storeAt = (now, limit) => createTickStore({ now: () => now, limit })
const MAOTAI = 'XSHG:equity:600519'

test('不同分钟各留一点, 同一分钟只留最后一条', () => {
  const store = storeAt(atMinute(0) * 1000)
  store.push(MAOTAI, 'XSHG', atMinute(0), 10)
  store.push(MAOTAI, 'XSHG', atMinute(1), 10.2)
  assert.deepEqual(store.series(MAOTAI, 'XSHG').map(point => point.price), [10, 10.2])
  store.push(MAOTAI, 'XSHG', atMinute(1) + 30, 10.3)
  assert.deepEqual(store.series(MAOTAI, 'XSHG').map(point => point.price), [10, 10.3], '同一分钟后到的覆盖')
})

test('乱序到达的点按时间排好', () => {
  const store = storeAt(atMinute(0) * 1000)
  store.push(MAOTAI, 'XSHG', atMinute(5), 10.5)
  store.push(MAOTAI, 'XSHG', atMinute(1), 10.1)
  assert.deepEqual(store.series(MAOTAI, 'XSHG').map(point => point.at), [atMinute(1), atMinute(5)])
})

test('非数字价格不进序列', () => {
  const store = storeAt(atMinute(0) * 1000)
  store.push(MAOTAI, 'XSHG', atMinute(0), null)
  store.push(MAOTAI, 'XSHG', atMinute(1), Number.NaN)
  assert.deepEqual(store.series(MAOTAI, 'XSHG'), [])
})

test('跨日清空, 昨天的点不进今天的线', () => {
  const clock = { t: atMinute(0) * 1000 }
  const store = createTickStore({ now: () => clock.t })
  store.push(MAOTAI, 'XSHG', atMinute(0), 10)
  const tomorrow = atMinute(0) + 24 * 60 * 60
  clock.t = tomorrow * 1000
  store.push(MAOTAI, 'XSHG', tomorrow, 11)
  assert.deepEqual(store.series(MAOTAI, 'XSHG').map(point => point.price), [11])
  assert.deepEqual(store.series('XHKG:equity:02513', 'XHKG'), [], '没走过的证券就是空')
})

test('超过上限只留最新的点', () => {
  const store = storeAt(atMinute(0) * 1000, 3)
  for (let minute = 0; minute < 5; minute++) store.push(MAOTAI, 'XSHG', atMinute(minute), 10 + minute)
  assert.deepEqual(store.series(MAOTAI, 'XSHG').map(point => point.price), [12, 13, 14])
})

test('证券数超上限先淘汰最久没更新的', () => {
  const clock = { t: atMinute(0) * 1000 }
  const store = createTickStore({ now: () => clock.t, securities: 2 })
  store.push('A', 'XSHG', atMinute(0), 1)
  store.push('B', 'XSHG', atMinute(0), 2)
  store.push('A', 'XSHG', atMinute(1), 1.1)
  store.push('C', 'XSHG', atMinute(1), 3)
  assert.equal(store.size, 2)
  assert.deepEqual(store.series('B', 'XSHG'), [], '最久没更新的被淘汰')
  assert.deepEqual(store.series('C', 'XSHG').map(point => point.price), [3])
})

test('删除与清空: 自选移除后不该继续攒点', () => {
  const store = storeAt(atMinute(0) * 1000)
  store.push(MAOTAI, 'XSHG', atMinute(0), 10)
  store.delete(MAOTAI)
  assert.deepEqual(store.series(MAOTAI, 'XSHG'), [])
  store.push(MAOTAI, 'XSHG', atMinute(1), 10.1)
  store.clear()
  assert.equal(store.size, 0)
})

test('不同证券互不影响', () => {
  const store = storeAt(atMinute(0) * 1000)
  store.push(MAOTAI, 'XSHG', atMinute(0), 10)
  store.push('XHKG:equity:02513', 'XHKG', atMinute(0), 100)
  assert.deepEqual(store.series(MAOTAI, 'XSHG').map(point => point.price), [10])
  assert.deepEqual(store.series('XHKG:equity:02513', 'XHKG').map(point => point.price), [100])
})

test('拍点横轴按来源时区写, 与在线分时同一基准', () => {
  const utc = Date.UTC(2026, 10, 16, 2, 5) / 1000
  assert.equal(clockInZone('Asia/Shanghai', utc), '10:05')
  assert.equal(clockInZone('America/New_York', utc), '21:05', '纽约 11 月是 EST(UTC-5)')
})

test('不传上限时按最长交易时段封顶', () => {
  const store = createTickStore({ now: () => atMinute(0) * 1000 })
  // 一天远超最长交易时段的分钟数, 多出来的必须被截掉
  for (let minute = 0; minute < 10 * 60; minute++) store.push(MAOTAI, 'XSHG', atMinute(minute), 10)
  assert.equal(store.series(MAOTAI, 'XSHG').length, 8 * 60 + 30)
})
