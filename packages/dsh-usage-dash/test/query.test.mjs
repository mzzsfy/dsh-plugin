import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  MAX_SLOTS,
  daysInRange,
  hourKeysInRange,
  minuteKeysInRange,
  aggregateRange,
} from '../src/query.js'

const makeRow = (overrides = {}) => ({
  bucket: '2020-01-01',
  provider: 'default',
  model: 'deepseek-chat',
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  requests: 0,
  turns: 0,
  lastSeen: 0,
  ...overrides,
})

test('daysInRange 单日闭区间返回单槽', () => {
  assert.deepEqual(daysInRange('2020-01-01', '2020-01-01'), ['2020-01-01'])
})

test('daysInRange 跨月含闰日连续枚举', () => {
  assert.deepEqual(daysInRange('2020-02-27', '2020-03-01'), [
    '2020-02-27',
    '2020-02-28',
    '2020-02-29',
    '2020-03-01',
  ])
})

test('daysInRange 倒序边界返回空数组', () => {
  assert.deepEqual(daysInRange('2020-01-02', '2020-01-01'), [])
})

test('daysInRange 非法格式或不存在日期返回空数组', () => {
  assert.deepEqual(daysInRange('2020-1-1', '2020-01-02'), [])
  assert.deepEqual(daysInRange('2020-01-01', '2020-02-30'), [])
  assert.deepEqual(daysInRange('2020-01-01T00', '2020-01-02'), [])
})

test('hourKeysInRange 跨日闭区间连续枚举', () => {
  assert.deepEqual(hourKeysInRange('2020-01-01T22', '2020-01-02T02'), [
    '2020-01-01T22',
    '2020-01-01T23',
    '2020-01-02T00',
    '2020-01-02T01',
    '2020-01-02T02',
  ])
})

test('hourKeysInRange 倒序或非法格式返回空数组', () => {
  assert.deepEqual(hourKeysInRange('2020-01-02T00', '2020-01-01T23'), [])
  assert.deepEqual(hourKeysInRange('2020-01-01', '2020-01-02'), [])
  assert.deepEqual(hourKeysInRange('2020-01-01T25', '2020-01-02T00'), [])
})

test('minuteKeysInRange 按 10 分钟步长跨时枚举', () => {
  assert.deepEqual(minuteKeysInRange('2020-01-01T23:50', '2020-01-02T00:10'), [
    '2020-01-01T23:50',
    '2020-01-02T00:00',
    '2020-01-02T00:10',
  ])
})

test('minuteKeysInRange from 未对齐桶边界返回空数组', () => {
  assert.deepEqual(minuteKeysInRange('2020-01-01T23:58', '2020-01-02T00:10'), [])
  assert.deepEqual(minuteKeysInRange('2020-01-01T00:01', '2020-01-01T00:31'), [])
})

test('minuteKeysInRange 倒序或格式不匹配返回空数组', () => {
  assert.deepEqual(minuteKeysInRange('2020-01-01T00:10', '2020-01-01T00:00'), [])
  assert.deepEqual(minuteKeysInRange('2020-01-01T00', '2020-01-01T00:20'), [])
})

test('MAX_SLOTS 为文档定值', () => {
  assert.equal(MAX_SLOTS, 2000)
})

test('D 粒度聚合总量排序与占比正确', () => {
  const rows = [
    makeRow({
      model: 'deepseek/deepseek-chat',
      provider: 'deepseek',
      inputTokens: 100,
      outputTokens: 50,
      cacheReadTokens: 200,
      requests: 1,
    }),
    makeRow({
      model: 'deepseek-chat',
      provider: 'default',
      inputTokens: 10,
      outputTokens: 20,
      cacheWriteTokens: 30,
      requests: 2,
      turns: 1,
    }),
  ]
  const out = aggregateRange(rows, 'D', '2020-01-01', '2020-01-01')
  assert.equal(out.from, '2020-01-01')
  assert.equal(out.to, '2020-01-01')
  assert.equal(out.tokens, 100 + 50 + 200 + 10 + 20 + 30)
  assert.equal(out.requests, 3)
  assert.equal(out.turns, 1)
  assert.equal(out.cacheHit, 200)
  assert.equal(out.cacheMiss, 100 + 10 + 30)
  assert.equal(out.activeDays, 1)
  assert.equal(out.topModel, 'deepseek/deepseek-chat')
  assert.equal(out.topProvider, 'deepseek')
  assert.deepEqual(out.models, [
    { model: 'deepseek/deepseek-chat', provider: 'deepseek', tokens: 350, percent: (350 / 410) * 100 },
    { model: 'deepseek-chat', provider: 'default', tokens: 60, percent: (60 / 410) * 100 },
  ])
  assert.deepEqual(out.providers, [
    { provider: 'deepseek', tokens: 350, percent: (350 / 410) * 100 },
    { provider: 'default', tokens: 60, percent: (60 / 410) * 100 },
  ])
  assert.deepEqual(out.daily, [
    {
      day: '2020-01-01',
      total: 410,
      byModel: { 'deepseek/deepseek-chat': 350, 'deepseek-chat': 60 },
      byProvider: { deepseek: 350, default: 60 },
      requests: 3,
      turns: 1,
      cacheHit: 200,
      cacheMiss: 140,
    },
  ])
  assert.equal('truncated' in out, false)
})

test('H 粒度零值槽全枚举含无数据槽', () => {
  const rows = [
    makeRow({ bucket: '2020-01-01T01', model: 'm1', provider: 'p1', inputTokens: 5, outputTokens: 5 }),
  ]
  const out = aggregateRange(rows, 'H', '2020-01-01T00', '2020-01-01T02')
  assert.deepEqual(out.daily.map((slot) => slot.day), [
    '2020-01-01T00',
    '2020-01-01T01',
    '2020-01-01T02',
  ])
  assert.deepEqual(out.daily[0], {
    day: '2020-01-01T00',
    total: 0,
    byModel: {},
    byProvider: {},
    requests: 0,
    turns: 0,
    cacheHit: 0,
    cacheMiss: 0,
  })
  assert.equal(out.daily[1].total, 10)
  assert.deepEqual(out.daily[1].byModel, { m1: 10 })
  assert.deepEqual(out.daily[1].byProvider, { p1: 10 })
  assert.equal(out.activeDays, 1)
})

test('M 粒度纯计数行不计入模型与活跃桶,未对齐残行跳过', () => {
  const rows = [
    makeRow({ bucket: '2020-01-01T00:00', model: '(turns)', provider: 'default', turns: 1 }),
    makeRow({ bucket: '2020-01-01T00:00', model: 'm1', provider: 'p1', requests: 2 }),
    makeRow({ bucket: '2020-01-01T00:07', model: 'm1', provider: 'p1', inputTokens: 9 }),
  ]
  const out = aggregateRange(rows, 'M', '2020-01-01T00:00', '2020-01-01T00:00')
  assert.equal(out.tokens, 0)
  assert.equal(out.requests, 2)
  assert.equal(out.turns, 1)
  assert.equal(out.activeDays, 0)
  assert.deepEqual(out.models, [])
  assert.deepEqual(out.providers, [])
  assert.deepEqual(out.daily, [
    {
      day: '2020-01-01T00:00',
      total: 0,
      byModel: {},
      byProvider: {},
      requests: 2,
      turns: 1,
      cacheHit: 0,
      cacheMiss: 0,
    },
  ])
  assert.equal(out.tokens, 0)
})

test('空 rows 时 top 值为空串且 daily 全零槽', () => {
  const out = aggregateRange([], 'D', '2020-01-01', '2020-01-03')
  assert.equal(out.topModel, '')
  assert.equal(out.topProvider, '')
  assert.equal(out.activeDays, 0)
  assert.equal(out.tokens, 0)
  assert.deepEqual(out.daily.map((slot) => slot.day), ['2020-01-01', '2020-01-02', '2020-01-03'])
  assert.deepEqual(out.models, [])
  assert.deepEqual(out.providers, [])
  assert.equal('truncated' in out, false)
})

test('D 粒度跨月边界 daily 序列完整', () => {
  const rows = [makeRow({ bucket: '2020-02-01', inputTokens: 1, outputTokens: 1 })]
  const out = aggregateRange(rows, 'D', '2020-01-30', '2020-02-02')
  assert.deepEqual(out.daily.map((slot) => slot.day), [
    '2020-01-30',
    '2020-01-31',
    '2020-02-01',
    '2020-02-02',
  ])
  assert.equal(out.daily[2].total, 2)
  assert.equal(out.daily[0].total, 0)
  assert.equal(out.activeDays, 1)
})

test('命中率口径 cacheMiss 含缓存写不含输出', () => {
  const rows = [
    makeRow({ inputTokens: 100, outputTokens: 400, cacheReadTokens: 300, cacheWriteTokens: 50 }),
  ]
  const out = aggregateRange(rows, 'D', '2020-01-01', '2020-01-01')
  assert.equal(out.cacheHit, 300)
  assert.equal(out.cacheMiss, 100 + 50)
  assert.equal(out.cacheHit / (out.cacheHit + out.cacheMiss), 300 / (300 + 150))
})

test('H 粒度槽数超过 MAX_SLOTS 保最新丢最旧并标记 truncated', () => {
  const from = '2020-05-01T00'
  const all = hourKeysInRange(from, '2020-12-31T23')
  assert.ok(all.length > MAX_SLOTS)
  const to = all[MAX_SLOTS]
  const out = aggregateRange([], 'H', from, to)
  assert.equal(out.truncated, true)
  assert.equal(out.daily.length, MAX_SLOTS)
  assert.equal(out.daily[0].day, all[1])
  assert.equal(out.daily[out.daily.length - 1].day, all[MAX_SLOTS])
})

test('H 粒度槽数恰为 MAX_SLOTS 时不出现 truncated', () => {
  const from = '2020-05-01T00'
  const all = hourKeysInRange(from, '2020-12-31T23')
  const to = all[MAX_SLOTS - 1]
  const out = aggregateRange([], 'H', from, to)
  assert.equal('truncated' in out, false)
  assert.equal(out.daily.length, MAX_SLOTS)
  assert.equal(out.daily[0].day, all[0])
  assert.equal(out.daily[out.daily.length - 1].day, to)
  assert.equal(out.from, from)
  assert.equal(out.to, to)
})
