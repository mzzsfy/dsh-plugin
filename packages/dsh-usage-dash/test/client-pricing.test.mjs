import { test } from 'node:test'
import assert from 'node:assert/strict'

import { CLIENT_BODY, DECLARATION_NAMES } from './client-eval.mjs'

const core = new Function(`${CLIENT_BODY}\nreturn { ${DECLARATION_NAMES.join(', ')} }`)()

const {
  MODEL_USAGE_PROJECTION,
  buildCostItem,
  buildSessionCostItem,
  ensureGlobalDefault,
  normalizePricingRules,
  partitionGroupOf,
  persistablePricingRules,
} = core

const t = (key, params = {}) => key === 'stats.cost' ? `费用 ≈ ${params.cost}` : key
const prefs = { costDisplay: true }
const at = (hour = 9) => new Date(2026, 10, 12, hour).getTime()
const price = (input = 0.03, output = 0.03, cacheRead = 0.03, cacheWrite = 0) => ({
  input, output, cacheRead, cacheWrite,
})
const rule = (model, value = price(), conditions = []) => ({
  model,
  unit: 'perMillion',
  currency: '¥',
  price: value,
  conditions,
})
const usage = (overrides = {}) => ({
  uncachedInputTokens: 25_564_756,
  outputTokens: 79_792,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  ...overrides,
})
const modelUsage = (hours) => ({ hours })

test('Given 无 routes When buildCostItem Then 不按 */* 猜价而显示占位符', () => {
  assert.equal(buildCostItem(usage(), [rule('*/*', price(1, 4, 0.02, 0))], prefs, t), '—')
})

test('Given routes 只有裸模型名 When buildCostItem Then 用两段键命中精确规则', () => {
  const rules = [rule('newapi/auto-free', price()), rule('*/*', price(1, 4, 0.02, 0))]
  assert.equal(buildCostItem(usage({ routes: [{ model: 'newapi/auto-free' }] }), rules, prefs, t), '费用 ≈ ¥0.77')
})

test('Given 多级模型名 oc/xx/xx When buildSessionCostItem Then 精确规则按整键命中', () => {
  // Given 投影模型键为三段,规则表同时有高价的 */* 与精确三段规则
  // When 底栏计价
  // Then 命中精确规则,租金由整键决定而不是被 */* 抢走
  const exact = rule('oc/xx/xx', price(1_000_000, 1_000_000, 1_000_000, 1_000_000))
  const wildcard = rule('*/*', price(1, 1, 1, 1))
  const value = buildSessionCostItem(usage(), modelUsage([{
    time: at(9),
    model: 'oc/xx/xx',
    uncachedInputTokens: 2,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
  }]), [wildcard, exact], prefs, t)
  assert.deepEqual(value, { text: '费用 ≈ ¥2.00', unpriced: 0 })
})

test('Given 投影小时/模型桶 When buildSessionCostItem Then 按模型与桶时刻计价', () => {
  const rules = [rule('*/auto-free', price(0.03, 0.03, 0.03, 0))]
  const value = buildSessionCostItem(usage(), modelUsage([{
    time: at(9),
    model: 'newapi/auto-free',
    uncachedInputTokens: 25_564_756,
    outputTokens: 79_792,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
  }]), rules, prefs, t)
  assert.deepEqual(value, { text: '费用 ≈ ¥0.77', unpriced: 0 })
})

test('Given 投影存在未命中的模型 When buildSessionCostItem Then 显示占位符并统计未计价小时', () => {
  const value = buildSessionCostItem(usage(), modelUsage([{
    time: at(9),
    model: 'unknown/model',
    uncachedInputTokens: 10,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
  }]), [rule('a/b')], prefs, t)
  assert.deepEqual(value, { text: '—', unpriced: 1 })
})

test('Given 投影全部为空 When buildSessionCostItem Then 回退到 usage 的 routes 而非投影', () => {
  const rules = [rule('newapi/auto-free', price())]
  const value = buildSessionCostItem(usage({ routes: [{ provider: 'newapi', model: 'auto-free' }] }), modelUsage([]), rules, prefs, t)
  assert.deepEqual(value, { text: '费用 ≈ ¥0.77', unpriced: 0 })
})

test('Given 无规则 When buildSessionCostItem Then 不显示费用项而不是零价', () => {
  const value = buildSessionCostItem(usage(), modelUsage([{
    time: at(9),
    model: 'newapi/auto-free',
    uncachedInputTokens: 10,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
  }]), [], prefs, t)
  assert.equal(value, null)
})

test('Given 规则表无 */* When ensureGlobalDefault Then 补一条可编辑的未配置槽', () => {
  const ensured = ensureGlobalDefault([rule('a/b')], '¥')
  assert.equal(ensured.synthetic, true)
  assert.equal(ensured.rules.at(-1).model, '*/*')
  assert.deepEqual(ensured.rules.at(-1).price, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 })
})

test('Given 规则表已有 */* 默认价 When ensureGlobalDefault Then 不重复合成', () => {
  const existing = rule('*/*', price(1, 4, 0.02, 0))
  const ensured = ensureGlobalDefault([existing], '¥')
  assert.equal(ensured.synthetic, false)
  assert.equal(ensured.rules.length, 1)
  assert.equal(ensured.rules[0], existing)
})

test('Given 只有 */* 条件规则 When ensureGlobalDefault Then 仍补默认槽', () => {
  const conditional = rule('*/*', price(1), [{ kind: 'weekdays', days: [1] }])
  const ensured = ensureGlobalDefault([conditional], '¥')
  assert.equal(ensured.synthetic, true)
  assert.deepEqual(ensured.rules.map((item) => [item.model, item.conditions.length]), [['*/*', 1], ['*/*', 0]])
})

test('Given 合成全局槽仍全零 When persistablePricingRules Then 保存草稿剔除它', () => {
  const ensured = ensureGlobalDefault([rule('a/b')], '¥')
  assert.deepEqual(persistablePricingRules(ensured.rules, true).map((item) => item.model), ['a/b'])
})

test('Given 合成全局槽填了价 When persistablePricingRules Then 保留它', () => {
  const ensured = ensureGlobalDefault([rule('a/b')], '¥')
  ensured.rules.at(-1).price.input = 1
  assert.deepEqual(persistablePricingRules(ensured.rules, true).map((item) => item.model), ['a/b', '*/*'])
})

test('Given 全局条件规则全零且缺默认价 When 保存 Then 只剔除合成默认槽,保留条件规则', () => {
  const conditional = rule('*/*', price(0, 0, 0, 0), [{ kind: 'weekdays', days: [1] }])
  const ensured = ensureGlobalDefault([rule('a/b'), conditional], '¥')
  assert.equal(ensured.synthetic, true)
  const persisted = persistablePricingRules(ensured.rules, true)
  assert.deepEqual(persisted.map((item) => [item.model, item.conditions.length]), [['a/b', 0], ['*/*', 1]])
})

test('Given 组内首条无条件规则 When partitionGroupOf Then 首条是默认价而非末条', () => {
  const group = { model: 'a/b', slots: [
    { index: 0, rule: rule('a/b', price(1)) },
    { index: 1, rule: rule('a/b', price(2), [{ kind: 'weekdays', days: [1] }]) },
  ] }
  const { defaultSlot, extras } = partitionGroupOf(group)
  assert.equal(defaultSlot.index, 0)
  assert.deepEqual(extras.map((slot) => slot.index), [1])
})

test('Given 宿主投影键 When 读取常量 Then 与宿主注册键一致', () => {
  assert.equal(MODEL_USAGE_PROJECTION, 'usageDashModelUsage')
})

test('Given 客户端与宿主同一规则表 When 归一 Then 输出同序', () => {
  const rules = [rule('*/*', price(2)), rule('a/b', price(1)), rule('a/b', price(3), [{ kind: 'weekdays', days: [1] }])]
  assert.deepEqual(normalizePricingRules(rules).map((item) => [item.model, item.price.input]), [
    ['a/b', 3],
    ['a/b', 1],
    ['*/*', 2],
  ])
})