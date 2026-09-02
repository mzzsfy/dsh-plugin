// 用量统计账本纯模块测试:计量聚合、汇总、修剪、计价(见 dynamic-plugins/usage-stats/README.md)
import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  createLedger,
  dayKeyOf,
  recordCall,
  pruneLedger,
  summarize,
  costOfCall,
  flattenPricing,
  priceFor,
  FALLBACK_PRICING,
} from '../src/ledger.mjs'

const DAY_MS = 24 * 60 * 60 * 1000
const PER_MILLION = 1000000

function callAt(ts, overrides) {
  return Object.assign({
    at: ts,
    sessionId: 'sess-1',
    model: 'deepseek-chat',
    provider: 'deepseek',
    inputTokens: 1000,
    cacheReadTokens: 500,
    outputTokens: 200,
  }, overrides)
}

test('dayKeyOf:本地时区 YYYY-MM-DD', () => {
  const ts = new Date(2026, 1, 26, 15, 30).getTime()
  assert.equal(dayKeyOf(ts), '2026-02-26')
})

test('recordCall:同会话同日累计,跨日/跨会话分桶', () => {
  const day0 = new Date(2026, 1, 26, 10).getTime()
  const ledger = createLedger()
  recordCall(ledger, callAt(day0), 0.001)
  recordCall(ledger, callAt(day0, { outputTokens: 300 }), 0.002)
  recordCall(ledger, callAt(day0 + DAY_MS, { sessionId: 'sess-2' }), 0.003)

  assert.equal(Object.keys(ledger.days).length, 2)
  const day1 = ledger.days[dayKeyOf(day0)]
  assert.equal(day1.calls, 2)
  assert.equal(day1.inputTokens, 2000)
  assert.equal(day1.outputTokens, 500)
  assert.ok(Math.abs(day1.cost - 0.003) < 1e-9)
  assert.equal(day1.sessions['sess-1'].calls, 2)
  const day2 = ledger.days[dayKeyOf(day0 + DAY_MS)]
  assert.equal(day2.sessions['sess-2'].calls, 1)
})

test('recordCall:无 usage 数据不计 token 但计调用', () => {
  const ts = new Date(2026, 1, 26, 10).getTime()
  const ledger = createLedger()
  recordCall(ledger, callAt(ts, { inputTokens: null, cacheReadTokens: null, outputTokens: null }), null)
  const day = ledger.days[dayKeyOf(ts)]
  assert.equal(day.calls, 1)
  assert.equal(day.inputTokens, 0)
  assert.equal(day.cost, 0)
})

test('costOfCall:按百万 token 单价计价,缺字段容错', () => {
  const price = { input: 0.28, output: 0.56, cacheRead: 0.028 }
  const cost = costOfCall({ inputTokens: PER_MILLION, cacheReadTokens: 0, outputTokens: PER_MILLION }, price)
  assert.ok(Math.abs(cost - (0.28 + 0.56)) < 1e-9)
  assert.equal(costOfCall({ inputTokens: 100 }, null), null)
  assert.equal(costOfCall({ inputTokens: null, outputTokens: null, cacheReadTokens: null }, price), null)
})

test('flattenPricing + priceFor:provider/model 精确 -> 裸名精确 -> 前缀回退', () => {
  const raw = {
    deepseek: {
      models: {
        'deepseek-chat': { cost: { input: 0.14, output: 0.28, cache_read: 0.014 } },
        'deepseek/deepseek-v4-pro': { cost: { input: 1.74, output: 3.48, cache_read: 0.145 } },
      },
    },
  }
  const table = flattenPricing(raw)
  assert.equal(table.length, 2)
  assert.ok(priceFor(table, 'deepseek', 'deepseek-chat'))
  assert.ok(priceFor(table, 'other', 'deepseek/deepseek-v4-pro'))
  assert.ok(priceFor(table, 'openai', 'deepseek-chat'))
  assert.equal(priceFor(table, 'openai', 'unknown-model'), null)
  assert.equal(priceFor(FALLBACK_PRICING, 'deepseek', 'deepseek-chat') !== null, true)
})

test('summarize:今日/本月/累计与近 N 天列表', () => {
  const base = new Date(2026, 1, 26, 10).getTime()
  const ledger = createLedger()
  recordCall(ledger, callAt(base), 0.01)
  recordCall(ledger, callAt(base - DAY_MS, { sessionId: 's0' }), 0.02)
  recordCall(ledger, callAt(base - 40 * DAY_MS), 0.04)

  const summary = summarize(ledger, dayKeyOf(base), 14)
  assert.ok(Math.abs(summary.today.cost - 0.01) < 1e-9)
  assert.equal(summary.today.calls, 1)
  assert.ok(Math.abs(summary.month.cost - 0.03) < 1e-9)
  assert.ok(Math.abs(summary.total.cost - 0.07) < 1e-9)
  assert.equal(summary.recentDays.length, 3)
  assert.equal(summary.recentDays[0].date, dayKeyOf(base))
  assert.equal(summary.recentDays[0].calls, 1)
  assert.ok(Math.abs(summary.recentDays[0].cost - 0.01) < 1e-9)
  assert.equal(summary.todaySessions.length, 1)
})

test('pruneLedger:仅保留最近 N 天', () => {
  const base = new Date(2026, 1, 26, 10).getTime()
  const ledger = createLedger()
  for (let i = 0; i < 5; i += 1) {
    recordCall(ledger, callAt(base - i * DAY_MS), 0.01)
  }
  pruneLedger(ledger, dayKeyOf(base), 3)
  assert.equal(Object.keys(ledger.days).length, 3)
})
