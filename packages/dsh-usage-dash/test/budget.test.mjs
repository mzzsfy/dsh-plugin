import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  BUDGET_ACTION_NONE,
  DEFAULT_WARN_RATIO,
  MS_PER_HOUR,
  RATE_WINDOW_MINUTES,
  evaluateBudget,
  hourlyRateOf,
  normalizeBudgetConfig,
  planRequest,
} from '../src/budget.js'

// 启用位由 features.guard 在运行期投影,预算配置本身只存额度与动作
const configOf = (overrides = {}) => ({
  ...normalizeBudgetConfig({
    daily: { limit: 50, action: 'warn' },
    ...overrides,
  }),
  enabled: overrides.enabled !== false,
})

const NOW = 1_700_000_000_000

test('Given 未配置任何限额 When 评估 Then 无预算档且不动请求', () => {
  // Given 空配置(limit 0)
  const config = normalizeBudgetConfig({})
  // When 评估
  const evaluation = evaluateBudget({ config, spent: { daily: 10, monthly: 10 }, now: NOW })
  // Then 无档位、无动作、拦截放行
  assert.deepEqual(evaluation.budgets, [])
  assert.equal(evaluation.action, BUDGET_ACTION_NONE)
  assert.equal(evaluation.eta, null)
  assert.deepEqual(planRequest({ evaluation, config }), { kind: 'allow' })
})

test('Given 日预算 50 已花 40 速率 4 元每小时 When 评估 Then 警告且 ETA 2.5 小时', () => {
  // Given 80% 阈值下 40/50 命中警告
  const config = configOf()
  // When 评估
  const evaluation = evaluateBudget({ config, spent: { daily: 40 }, ratePerHour: 4, now: NOW })
  // Then 状态警告、剩余 10、ETA 2.5 小时
  assert.equal(evaluation.budgets.length, 1)
  assert.equal(evaluation.budgets[0].state, 'warn')
  assert.equal(evaluation.budgets[0].remaining, 10)
  assert.equal(evaluation.action, 'warn')
  assert.equal(evaluation.eta.scope, 'daily')
  assert.equal(evaluation.eta.hoursLeft, 10 / 4)
  assert.equal(evaluation.eta.at, NOW + (10 / 4) * MS_PER_HOUR)
})

test('Given 日预算超限且动作为 block When 评估 Then 拦截该请求', () => {
  // Given 60/50 已超限
  const config = configOf({ daily: { limit: 50, action: 'block' } })
  // When 评估
  const evaluation = evaluateBudget({ config, spent: { daily: 60 }, ratePerHour: 4, now: NOW })
  // Then 状态超限、动作 block、剩余归零、无 ETA
  assert.equal(evaluation.budgets[0].state, 'exceeded')
  assert.equal(evaluation.budgets[0].remaining, 0)
  assert.equal(evaluation.action, 'block')
  assert.equal(evaluation.eta, null)
  assert.deepEqual(planRequest({ evaluation, config }), { kind: 'block', scope: 'daily' })
})

test('Given 日与月同时配置且月档超限动作为 block When 评估 Then 取最重动作', () => {
  // Given 日档警告、月档超限 block
  const config = configOf({
    daily: { limit: 50, action: 'warn' },
    monthly: { limit: 100, action: 'block' },
  })
  // When 评估
  const evaluation = evaluateBudget({ config, spent: { daily: 40, monthly: 120 }, ratePerHour: 4, now: NOW })
  // Then 动作取 block,ETA 只对未超限档给出
  assert.equal(evaluation.action, 'block')
  assert.equal(evaluation.eta.scope, 'daily')
})

test('Given 超限动作为 degrade 且配置目标模型 When 计划请求 Then 降级到目标模型', () => {
  // Given 降级目标 model 已配置
  const config = configOf({ daily: { limit: 50, action: 'degrade' }, degradeModel: 'vendor/cheap' })
  // When 评估并计划
  const evaluation = evaluateBudget({ config, spent: { daily: 60 }, now: NOW })
  // Then 降级
  assert.deepEqual(planRequest({ evaluation, config }), { kind: 'degrade', model: 'vendor/cheap' })
})

test('Given 超限动作为 degrade 但未配置目标模型 When 计划请求 Then 退化为提示而不拦截', () => {
  // Given degrade 无目标
  const config = configOf({ daily: { limit: 50, action: 'degrade' } })
  // When 评估并计划
  const evaluation = evaluateBudget({ config, spent: { daily: 60 }, now: NOW })
  // Then 动作降级为 warn,请求放行
  assert.equal(evaluation.action, 'warn')
  assert.deepEqual(planRequest({ evaluation, config }), { kind: 'allow' })
})

test('Given 关闭开关 When 评估 Then 即便超限也不拦截', () => {
  // Given enabled false
  const config = configOf({ enabled: false, daily: { limit: 50, action: 'block' } })
  // When 评估
  const evaluation = evaluateBudget({ config, spent: { daily: 999 }, now: NOW })
  // Then 评估仍算状态,但计划放行
  assert.equal(evaluation.budgets[0].state, 'exceeded')
  assert.deepEqual(planRequest({ evaluation, config }), { kind: 'allow' })
})

test('Given 燃烧率为零 When 评估 Then 不给 ETA', () => {
  // Given 有预算但无速率(空闲)
  const config = configOf()
  // When 评估
  const evaluation = evaluateBudget({ config, spent: { daily: 10 }, ratePerHour: 0, now: NOW })
  // Then 无 ETA,避免除零得到 Infinity
  assert.equal(evaluation.eta, null)
})

test('Given 非法配置 When 归一 Then 回落安全默认', () => {
  // Given 负数限额、未知动作、越界阈值
  const config = normalizeBudgetConfig({
    warnRatio: 2,
    daily: { limit: -5, action: 'destroy' },
    monthly: { limit: 100, action: 'block' },
    degradeModel: '  ',
  })
  // Then 负数限额归零、未知动作回落 warn、阈值回落默认
  assert.equal(config.warnRatio, DEFAULT_WARN_RATIO)
  assert.equal(config.daily.limit, 0)
  assert.equal(config.daily.action, 'warn')
  assert.equal(config.monthly.action, 'block')
  assert.equal(config.degradeModel, '')
  assert.equal(config.notify, true)
})

const RATE_RULES = [{
  model: 'p/priced',
  unit: 'perMillion',
  currency: '¥',
  price: { input: 1, output: 0, cacheRead: 0, cacheWrite: 0 },
  conditions: [],
}]

const minuteRow = (model, inputTokens) => ({
  bucket: '2026-11-15T09:50',
  model,
  inputTokens,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
})

test('Given 窗口内有定价的分钟桶 When 折算速率 Then 按每小时放大', () => {
  // Given 30 分钟窗口内 2 元用量
  const rows = [minuteRow('p/priced', 1_000_000), minuteRow('p/priced', 1_000_000)]
  // When 折算
  const rate = hourlyRateOf({ rows, rules: RATE_RULES, at: NOW })
  // Then 每小时 4 元
  assert.equal(rate, (2 / RATE_WINDOW_MINUTES) * 60)
})

test('Given 窗口分钟数显式给出 When 折算 Then 分母随之变化', () => {
  const rows = [minuteRow('p/priced', 1_000_000)]
  assert.equal(hourlyRateOf({ rows, rules: RATE_RULES, at: NOW, windowMinutes: 60 }), 1)
})

test('Given 未命中定价的行 When 折算 Then 不计入速率', () => {
  // Given 一半行没有规则
  const rows = [minuteRow('p/priced', 1_000_000), minuteRow('other/model', 1_000_000)]
  // Then 只剩有价行
  assert.equal(hourlyRateOf({ rows, rules: RATE_RULES, at: NOW }), 2)
})

test('Given 无行或无规则或窗口非正 When 折算 Then 速率为零', () => {
  assert.equal(hourlyRateOf({ rows: [], rules: RATE_RULES, at: NOW }), 0)
  assert.equal(hourlyRateOf({ rows: [minuteRow('p/priced', 1_000_000)], rules: [], at: NOW }), 0)
  assert.equal(hourlyRateOf({ rows: [minuteRow('p/priced', 1_000_000)], rules: RATE_RULES, at: NOW, windowMinutes: 0 }), 0)
  assert.equal(hourlyRateOf({ rows: null, rules: RATE_RULES, at: NOW }), 0)
})
