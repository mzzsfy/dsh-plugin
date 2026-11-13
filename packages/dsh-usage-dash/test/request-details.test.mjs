// 最近请求详情派生值:token 合计、速度、费用与窗口均值。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { CLIENT_BODY, DECLARATION_NAMES } from './client-eval.mjs'

const core = new Function(`${CLIENT_BODY}\nreturn { ${DECLARATION_NAMES.join(', ')} }`)()

const {
  REQUEST_SPEED_MIN_DECODE_MS,
  requestTotalTokens,
  requestDecodeSpeed,
  requestCostOf,
  summarizeRequests,
  requestTtftAverageSeconds,
  formatRequestRowModel,
  formatRequestCost,
} = core

const row = (extra = {}) => ({
  turn: 0,
  step: 0,
  startedAt: 1000,
  firstTokenTime: 3000,
  completedAt: 8000,
  ttftMs: 2000,
  decodeMs: 5000,
  attempts: 1,
  model: 'deepseek/deepseek-chat',
  usage: {
    uncachedInputTokens: 100,
    outputTokens: 40,
    cacheReadTokens: 20,
    cacheWriteTokens: 5,
  },
  ...extra,
})

const rules = [{
  model: 'deepseek/*',
  currency: '¥',
  price: { input: 2, output: 10, cacheRead: 1, cacheWrite: 3 },
  conditions: [],
}]

test('Given 四桶用量 When 求总 token Then 四项相加', () => {
  assert.equal(requestTotalTokens(row()), 165)
  assert.equal(requestTotalTokens(row({ usage: null })), null)
  assert.equal(requestTotalTokens(row({ usage: { uncachedInputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 } })), 0)
})

test('Given 输出 token 与 decode 时长 When 求速度 Then 只算生成阶段', () => {
  assert.equal(requestDecodeSpeed(row()), 8)
  assert.equal(requestDecodeSpeed(row({ decodeMs: null })), null)
  assert.equal(requestDecodeSpeed(row({ usage: null })), null)
})

test('Given decode 窗口短于速度样本下限 When 求速度与汇总 Then 不作为可靠样本', () => {
  const short = row({ decodeMs: REQUEST_SPEED_MIN_DECODE_MS - 1 })
  assert.equal(requestDecodeSpeed(short), null)
  const normal = row({ decodeMs: REQUEST_SPEED_MIN_DECODE_MS })
  assert.equal(requestDecodeSpeed(normal), 400)
  assert.equal(summarizeRequests([normal, short], []).speed, 400)
})

test('Given 命中规则 When 求费用 Then 四桶分别计价且保留命中规则', () => {
  const cost = requestCostOf(row(), rules)
  assert.equal(cost.total, (100 * 2 + 40 * 10 + 20 * 1 + 5 * 3) / 1_000_000)
  assert.equal(cost.rule.model, 'deepseek/*')
  assert.equal(cost.rule.currency, '¥')
  assert.equal(requestCostOf(row({ model: null }), rules), null)
  assert.equal(requestCostOf(row(), null), null)
})

test('Given 两条请求 When 汇总 Then 首字用均值、速度用加权、费用只统计已定价行', () => {
  const summary = summarizeRequests([
    row({ ttftMs: 1000, decodeMs: 2000, usage: { uncachedInputTokens: 0, outputTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 0 } }),
    row({ step: 1, ttftMs: 3000, decodeMs: 6000, usage: { uncachedInputTokens: 0, outputTokens: 200, cacheReadTokens: 0, cacheWriteTokens: 0 } }),
    row({ step: 2, model: null, ttftMs: null, decodeMs: null, usage: { uncachedInputTokens: 0, outputTokens: 900, cacheReadTokens: 0, cacheWriteTokens: 0 } }),
  ], rules)
  assert.equal(summary.count, 3)
  assert.equal(summary.ttftMs, 2000)
  assert.equal(summary.speed, 300 / 8)
  assert.equal(summary.totalTokens, (100 + 200 + 900) / 3)
  assert.equal(summary.pricedCount, 2)
  assert.equal(summary.unpricedCount, 1)
  assert.equal(summary.cost, ((100 * 10 + 200 * 10) / 1_000_000) / 2)
})

test('Given 微观费用 When 格式化 Then 小于一分的金额保留足够有效位', () => {
  assert.equal(formatRequestCost(0.000003, '¥'), '≈¥0.000003')
  assert.equal(formatRequestCost(0.005, '¥'), '≈¥0.0050')
  assert.equal(formatRequestCost(1.2, '¥'), '≈¥1.20')
  assert.equal(formatRequestCost(0.01, '¥', true), '≥¥0.01')
  assert.equal(formatRequestCost(null, '¥'), '—')
})

test('Given 12 条带首字请求 When 取最近 10 次平均 Then 只平均最后 10 条并保留一位小数', () => {
  const rows = Array.from({ length: 12 }, (_, index) => row({ step: index, ttftMs: (index + 1) * 1000 }))
  // 最后 10 条为 3~12 秒,算术平均 7.5 秒
  assert.equal(requestTtftAverageSeconds(rows), 7.5)
  assert.equal(requestTtftAverageSeconds([row({ ttftMs: 1200 }), row({ ttftMs: null }), row({ ttftMs: 3450 })]), 2.3)
  assert.equal(requestTtftAverageSeconds([]), null)
  assert.equal(requestTtftAverageSeconds([row({ ttftMs: null })]), null)
})

test('Given 模型引用 When 展示短名 Then 去掉 provider 前缀', () => {
  assert.equal(formatRequestRowModel('deepseek/deepseek-chat'), 'deepseek-chat')
  assert.equal(formatRequestRowModel('solo'), 'solo')
  assert.equal(formatRequestRowModel(null), '—')
})
