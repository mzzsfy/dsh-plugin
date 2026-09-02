// 历史快照纯逻辑 BDD:序列键映射 / 档位对齐去重 / 时间修剪 / 硬上限 / 月窗口聚合 / 读数取样。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  SEQUENCE_TIERS,
  GRANULARITY_MS,
  RETENTION_POINTS,
  HARD_POINT_CAP,
  labelToSuffix,
  granularityOf,
  alignTs,
  appendPoint,
  pruneSequence,
  readingToSnapshots,
  buildMonthSequence,
  newSequenceStore,
} from '../src/history.mjs'

const MIN = 60 * 1000
const TEN_MIN = 10 * MIN
const HOUR = 60 * MIN

test('场景: 窗口 label 与序列键后缀映射', () => {
  assert.equal(labelToSuffix('5小时'), '5h')
  assert.equal(labelToSuffix('7天'), '7d')
  assert.equal(labelToSuffix('月'), 'month')
  assert.equal(labelToSuffix('未知窗口'), null)
})

test('场景: 序列档位映射', () => {
  assert.equal(granularityOf('5h'), '10m')
  assert.equal(granularityOf('7d'), '1h')
  assert.equal(granularityOf('month'), '1h')
  assert.equal(granularityOf('balance'), '1h')
  assert.equal(Object.keys(SEQUENCE_TIERS).length, 4)
})

test('场景: 时间就近对齐到最近档', () => {
  assert.equal(alignTs(Date.UTC(2026, 0, 1, 10, 7), TEN_MIN), Date.UTC(2026, 0, 1, 10, 10))
  assert.equal(alignTs(Date.UTC(2026, 0, 1, 10, 0), TEN_MIN), Date.UTC(2026, 0, 1, 10, 0))
  assert.equal(alignTs(Date.UTC(2026, 0, 1, 14, 5), HOUR), Date.UTC(2026, 0, 1, 14, 0))
})

test('场景: 短窗口 10 分钟档采样并记录档内最前一次', () => {
  const store = newSequenceStore()
  const seqKey = 'acct-1:5h'
  appendPoint(store, seqKey, Date.UTC(2026, 0, 1, 10, 7), 80)
  appendPoint(store, seqKey, Date.UTC(2026, 0, 1, 10, 14), 70)
  const points = store[seqKey].points
  assert.equal(points.length, 1)
  assert.equal(points[0].t, Date.UTC(2026, 0, 1, 10, 10))
  assert.equal(points[0].v, 80, '档内只保留最前一次的值')
})

test('场景: 跨档落新点', () => {
  const store = newSequenceStore()
  const seqKey = 'acct-1:5h'
  appendPoint(store, seqKey, Date.UTC(2026, 0, 1, 10, 10), 80)
  appendPoint(store, seqKey, Date.UTC(2026, 0, 1, 10, 21), 70)
  const points = store[seqKey].points
  assert.equal(points.length, 2)
  assert.equal(points[1].t, Date.UTC(2026, 0, 1, 10, 20))
  assert.equal(points[1].v, 70)
})

test('场景: 超期快照修剪', () => {
  const store = newSequenceStore()
  const seqKey = 'acct-1:5h'
  const oldT = Date.UTC(2026, 0, 1, 10, 0)
  const newT = oldT + RETENTION_POINTS['10m'] * TEN_MIN + TEN_MIN
  store[seqKey] = { granularity: '10m', points: [{ t: oldT, v: 1 }, { t: newT, v: 2 }] }
  pruneSequence(store, seqKey, newT)
  assert.equal(store[seqKey].points.length, 1)
  assert.equal(store[seqKey].points[0].v, 2)
})

test('场景: 硬点数上限丢最旧', () => {
  const store = newSequenceStore()
  const seqKey = 'acct-1:balance'
  const start = Date.UTC(2026, 0, 1, 0, 0)
  const cap = HARD_POINT_CAP['1h']
  // 直接构造超上限序列:异常高频写入场景,正常轮询由时间修剪收敛
  store[seqKey] = {
    granularity: '1h',
    points: Array.from({ length: cap + 1 }, (_, i) => ({ t: start + i * 10 * 1000, v: i })),
  }
  appendPoint(store, seqKey, start + (cap + 1) * 10 * 1000, cap + 1, start + (cap + 1) * 10 * 1000)
  assert.equal(store[seqKey].points.length, cap, '序列长度不超上限')
  assert.equal(store[seqKey].points[0].v, 1, '最旧点被丢弃')
})

test('场景: 追加快照时先时间修剪后点数上限', () => {
  const store = newSequenceStore()
  const seqKey = 'acct-1:5h'
  const start = Date.UTC(2026, 0, 1, 0, 0)
  const cap = HARD_POINT_CAP['10m']
  const retentionMs = RETENTION_POINTS['10m'] * GRANULARITY_MS['10m']
  // 构造留存期内的超上限序列(高频异常),验证修剪后仍受硬上限约束
  store[seqKey] = {
    granularity: '10m',
    points: Array.from({ length: cap + 1 }, (_, i) => ({ t: start + i * 30 * 1000, v: i })),
  }
  appendPoint(store, seqKey, start + retentionMs, 999, start + retentionMs)
  const points = store[seqKey].points
  assert.ok(points.length <= cap)
  assert.equal(points[points.length - 1].v, 999)
  assert.ok(points.every((p) => p.t >= start + retentionMs - retentionMs), '全部点在留存期内')
})

test('场景: 读数取样产出序列键与数值', () => {
  const quota = {
    kind: 'quota',
    windows: [
      { label: '5小时', remaining: 30, utilization: 70 },
      { label: '7天', remaining: null, utilization: 40 },
    ],
  }
  const snaps = readingToSnapshots(quota)
  assert.deepEqual(snaps, [
    { suffix: '5h', value: 30, tier: '10m' },
    { suffix: '7d', value: 40, tier: '1h' },
  ])
  const balance = { kind: 'balance', entries: [{ currency: 'USD', remaining: 12.5, total: 20 }] }
  assert.deepEqual(readingToSnapshots(balance), [{ suffix: 'balance', value: 12.5, tier: '1h' }])
  const balanceTotalOnly = { kind: 'balance', entries: [{ currency: 'CNY', remaining: null, total: 88 }] }
  assert.deepEqual(readingToSnapshots(balanceTotalOnly), [{ suffix: 'balance', value: 88, tier: '1h' }])
})

test('场景: 月窗口按余额快照聚合当月日历月', () => {
  const store = newSequenceStore()
  appendPoint(store, 'acct-1:balance', Date.UTC(2026, 0, 3, 0, 0), 100)
  appendPoint(store, 'acct-1:balance', Date.UTC(2026, 0, 5, 0, 0), 80)
  appendPoint(store, 'acct-1:balance', Date.UTC(2025, 11, 20, 0, 0), 150)
  const now = Date.UTC(2026, 0, 6, 0, 0)
  buildMonthSequence(store, 'acct-1', now)
  const month = store['acct-1:month']
  assert.ok(month)
  assert.equal(month.granularity, '1h')
  assert.deepEqual(month.points, [
    { t: Date.UTC(2026, 0, 3, 0, 0), v: 100 },
    { t: Date.UTC(2026, 0, 5, 0, 0), v: 80 },
  ], '仅保留当月日历月的余额点,跨月点剔除')
})

test('场景: 月窗口档内对齐去重与留存同规则', () => {
  const store = newSequenceStore()
  appendPoint(store, 'acct-1:balance', Date.UTC(2026, 0, 3, 0, 30), 100)
  const now = Date.UTC(2026, 0, 4, 0, 0)
  buildMonthSequence(store, 'acct-1', now)
  assert.deepEqual(store['acct-1:month'].points, [{ t: Date.UTC(2026, 0, 3, 1, 0), v: 100 }])
})

test('场景: 月窗口月界取本地时区月初零点,跨月点剔除', () => {
  const store = newSequenceStore()
  const monthStart = new Date(2026, 2, 1).getTime()
  const beforeMonth = monthStart - HOUR
  appendPoint(store, 'acct-1:balance', beforeMonth, 10)
  appendPoint(store, 'acct-1:balance', monthStart, 20)
  buildMonthSequence(store, 'acct-1', monthStart + HOUR)
  assert.deepEqual(store['acct-1:month'].points, [{ t: monthStart, v: 20 }], '上月末尾点不进本月窗口')
})

test('场景: 粒度毫秒与留存点数表', () => {
  assert.equal(GRANULARITY_MS['10m'], 10 * MIN)
  assert.equal(GRANULARITY_MS['1h'], HOUR)
  assert.equal(RETENTION_POINTS['10m'], 7 * 24 * 6)
  assert.equal(RETENTION_POINTS['1h'], 30 * 24)
  assert.equal(HARD_POINT_CAP['10m'], 2 * 7 * 24 * 6)
  assert.equal(HARD_POINT_CAP['1h'], 2 * 30 * 24)
})
