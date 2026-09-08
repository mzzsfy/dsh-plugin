import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  MAX_SLOTS,
  daysInRange,
  hourKeysInRange,
  minuteKeysInRange,
  aggregateRange,
  attachCosts,
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

// ---- attachCosts 聚合计价:计价唯一以 H 桶起点匹配,费用精度=小时级 ----

const ruleOf = (overrides = {}) => ({
  model: '*/*',
  currency: '¥',
  price: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  conditions: [],
  ...overrides,
})

const inputPrice = (input) => ({ input, output: 0, cacheRead: 0, cacheWrite: 0 })

test('attachCosts H 槽按桶起点计价并归集 totals 与 models', () => {
  const rows = [
    makeRow({ bucket: '2020-01-01T01', model: 'm1', provider: 'p1', inputTokens: 1000000, outputTokens: 500000 }),
  ]
  const result = aggregateRange(rows, 'H', '2020-01-01T00', '2020-01-01T02')
  const out = attachCosts(result, rows, 'H', [ruleOf({ model: 'default/m1', price: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 } })])
  assert.equal(out.daily[1].cost, 2)
  assert.equal(out.cost, 2)
  assert.equal(out.unpriced, 0)
  assert.deepEqual(out.models, [{ model: 'm1', provider: 'p1', tokens: 1500000, percent: 100, cost: 2 }])
  assert.equal(out.from, '2020-01-01T00')
  assert.equal(out.tokens, 1500000)
  // 纯函数:入参 result 不被修改
  assert.equal('cost' in result.daily[1], false)
  assert.equal('cost' in result, false)
})

test('attachCosts 多行同桶多规则累加且残缺规则跳过后回落通配', () => {
  const rows = [
    makeRow({ bucket: '2020-01-01T01', model: 'm1', inputTokens: 1000000 }),
    makeRow({ bucket: '2020-01-01T01', model: 'm2', inputTokens: 1000000 }),
  ]
  const rules = [
    ruleOf({ model: 'default/m1', price: inputPrice(1) }),
    { model: 'm2' },
    ruleOf({ price: inputPrice(3) }),
  ]
  const result = aggregateRange(rows, 'H', '2020-01-01T01', '2020-01-01T01')
  const out = attachCosts(result, rows, 'H', rules)
  assert.equal(out.daily[0].cost, 4)
  assert.deepEqual(out.models.map((entry) => entry.cost), [1, 3])
  assert.equal(out.unpriced, 0)
})

test('attachCosts 无规则时 cost 恒零且 unpriced 按有 token 的 H 桶去重', () => {
  const rows = [
    makeRow({ bucket: '2020-01-01T01', model: 'm1', inputTokens: 5 }),
    makeRow({ bucket: '2020-01-01T01', model: 'm2', inputTokens: 5 }),
    makeRow({ bucket: '2020-01-01T02', model: 'm1', outputTokens: 5 }),
    makeRow({ bucket: '2020-01-01T02', model: 'm1', requests: 1 }),
    makeRow({ bucket: '2020-01-01T00', model: 'm1', turns: 1 }),
  ]
  for (const rules of [[], undefined]) {
    const result = aggregateRange(rows, 'H', '2020-01-01T00', '2020-01-01T02')
    const out = attachCosts(result, rows, 'H', rules)
    assert.equal(out.cost, 0)
    assert.equal(out.unpriced, 2)
    assert.deepEqual(out.daily.map((slot) => slot.cost), [0, 0, 0])
    assert.deepEqual(out.models.map((entry) => entry.cost), [0, 0])
  }
})

test('attachCosts M 行按父 H 桶起点匹配价格且全桶计入分钟槽', () => {
  const rows = [
    makeRow({ bucket: '2020-01-01T01:10', model: 'm1', inputTokens: 500000 }),
    makeRow({ bucket: '2020-01-01T01:20', model: 'm1', inputTokens: 500000 }),
  ]
  const result = aggregateRange(rows, 'M', '2020-01-01T01:10', '2020-01-01T01:20')
  const out = attachCosts(result, rows, 'M', [ruleOf({ price: inputPrice(1) })])
  assert.deepEqual(out.daily.map((slot) => slot.cost), [0.5, 0.5])
  assert.equal(out.cost, 1)
  assert.equal(out.unpriced, 0)
  assert.equal(out.models[0].cost, 1)
})

test('attachCosts M 行 unpriced 按父 H 桶去重', () => {
  const rows = [
    makeRow({ bucket: '2020-01-01T01:10', model: 'm1', inputTokens: 5 }),
    makeRow({ bucket: '2020-01-01T01:20', model: 'm1', inputTokens: 5 }),
    makeRow({ bucket: '2020-01-01T02:00', model: 'm1', inputTokens: 5 }),
  ]
  const result = aggregateRange(rows, 'M', '2020-01-01T01:10', '2020-01-01T02:00')
  const out = attachCosts(result, rows, 'M', [])
  assert.equal(out.unpriced, 2)
})

test('attachCosts D 端点按 H 行桶起点计价折叠到日槽', () => {
  const costRows = [
    makeRow({ bucket: '2020-01-01T22', model: 'm1', inputTokens: 1000000 }),
    makeRow({ bucket: '2020-01-01T23', model: 'm1', inputTokens: 1000000 }),
    makeRow({ bucket: '2020-01-02T00', model: 'm1', inputTokens: 1000000 }),
  ]
  const aggregateRows = [
    makeRow({ bucket: '2020-01-01', model: 'm1', inputTokens: 2000000 }),
    makeRow({ bucket: '2020-01-02', model: 'm1', inputTokens: 1000000 }),
  ]
  const rules = [
    ruleOf({ price: inputPrice(1), conditions: [{ kind: 'dateRange', from: '2020-01-01', to: '2020-01-01' }] }),
    ruleOf({ price: inputPrice(3), conditions: [{ kind: 'dateRange', from: '2020-01-02', to: '2020-01-02' }] }),
  ]
  const result = aggregateRange(aggregateRows, 'D', '2020-01-01', '2020-01-02')
  const out = attachCosts(result, costRows, 'D', rules)
  assert.equal(out.daily[0].cost, 2)
  assert.equal(out.daily[1].cost, 3)
  assert.equal(out.cost, 5)
  assert.equal(out.models[0].cost, 5)
  assert.equal(out.unpriced, 0)
})

test('attachCosts D 端点 unpriced 按 H 行桶去重而非日', () => {
  const rows = [
    makeRow({ bucket: '2020-01-01T22', inputTokens: 5 }),
    makeRow({ bucket: '2020-01-01T23', inputTokens: 5 }),
    makeRow({ bucket: '2020-01-02T00', inputTokens: 5 }),
  ]
  const result = aggregateRange(rows, 'D', '2020-01-01', '2020-01-02')
  const out = attachCosts(result, rows, 'D', [])
  assert.equal(out.unpriced, 3)
})

test('attachCosts 截断后被丢槽的行整体不参与计价', () => {
  const from = '2020-01-01'
  const to = '2025-06-23'
  const dropped = makeRow({ bucket: '2020-01-01T05', model: 'm1', inputTokens: 1000000 })
  const kept = makeRow({ bucket: '2025-06-23T07', model: 'm1', inputTokens: 1000000 })
  const aggregateRows = [makeRow({ bucket: '2025-06-23', model: 'm1', inputTokens: 1000000 })]
  const result = aggregateRange(aggregateRows, 'D', from, to)
  assert.equal(result.truncated, true)
  const out = attachCosts(result, [dropped, kept], 'D', [ruleOf({ price: inputPrice(2) })])
  assert.equal(out.cost, 2)
  assert.deepEqual(out.daily.filter((slot) => slot.cost !== 0).map((slot) => slot.day), ['2025-06-23'])
  assert.deepEqual(out.models.map((entry) => entry.cost), [2])
  assert.equal(out.unpriced, 0)
  const unpricedOnly = attachCosts(result, [dropped, kept], 'D', [])
  assert.equal(unpricedOnly.unpriced, 1)
})

test('attachCosts 空串模型行的费用跟随 models 空串条目', () => {
  const rows = [makeRow({ bucket: '2020-01-01T01', model: '', inputTokens: 1000000 })]
  const result = aggregateRange(rows, 'H', '2020-01-01T01', '2020-01-01T01')
  const out = attachCosts(result, rows, 'H', [ruleOf({ price: inputPrice(1) })])
  assert.equal(out.cost, 1)
  assert.deepEqual(out.models.map((entry) => [entry.model, entry.cost]), [['', 1]])
})

test('attachCosts 计价时间恒为 H 桶起点(非分钟/日起点)', () => {
  // M 判别:窗口 01:05~01:55 下父 H 01:00 出窗回落价 3,按分钟起点判则
  // 01:10/01:20 均在窗走价 1
  const minuteWindow = ruleOf({ price: inputPrice(1), conditions: [{ kind: 'dailyWindow', from: '01:05', to: '01:55' }] })
  const minuteRows = [
    makeRow({ bucket: '2020-01-01T01:10', model: 'm1', inputTokens: 500000 }),
    makeRow({ bucket: '2020-01-01T01:20', model: 'm1', inputTokens: 500000 }),
  ]
  const minuteResult = aggregateRange(minuteRows, 'M', '2020-01-01T01:10', '2020-01-01T01:20')
  const minuteOut = attachCosts(minuteResult, minuteRows, 'M', [minuteWindow, ruleOf({ price: inputPrice(3) })])
  assert.deepEqual(minuteOut.daily.map((slot) => slot.cost), [1.5, 1.5])
  // D 判别:窗口 00:05~23:55 含 H 23:00 不含日起点 00:00,按日起点判则两日均出窗
  const dayWindow = ruleOf({ price: inputPrice(1), conditions: [{ kind: 'dailyWindow', from: '00:05', to: '23:55' }] })
  const hourRows = [
    makeRow({ bucket: '2020-01-01T23', model: 'm1', inputTokens: 1000000 }),
    makeRow({ bucket: '2020-01-02T00', model: 'm1', inputTokens: 1000000 }),
  ]
  const dayResult = aggregateRange([
    makeRow({ bucket: '2020-01-01', model: 'm1', inputTokens: 1000000 }),
    makeRow({ bucket: '2020-01-02', model: 'm1', inputTokens: 1000000 }),
  ], 'D', '2020-01-01', '2020-01-02')
  const dayOut = attachCosts(dayResult, hourRows, 'D', [dayWindow, ruleOf({ price: inputPrice(3) })])
  assert.deepEqual(dayOut.daily.map((slot) => slot.cost), [1, 3])
})
