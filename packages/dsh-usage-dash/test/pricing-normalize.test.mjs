import { test } from 'node:test'
import assert from 'node:assert/strict'

import { GLOBAL_DEFAULT_MODEL, normalizePricingRules, resolvePricingRule } from '../src/pricing.js'

const rule = (model, input, conditions = []) => ({
  model,
  unit: 'perMillion',
  currency: '¥',
  price: { input, output: 0, cacheRead: 0, cacheWrite: 0 },
  conditions,
})
const condition = { kind: 'weekdays', days: [1] }

test('Given 同模型多条无条件规则 When 归一 Then 仅保留首条', () => {
  const first = rule('a/b', 1)
  const second = rule('a/b', 2)
  const normalized = normalizePricingRules([first, second])
  assert.deepEqual(normalized, [first])
  assert.equal(normalized[0], first)
})

test('Given 无条件规则排在条件规则前 When 归一 Then 保留原序', () => {
  const fallback = rule('a/b', 1)
  const special = rule('a/b', 2, [condition])
  const normalized = normalizePricingRules([fallback, special])
  assert.deepEqual(normalized, [fallback, special])
})

test('Given 同优先级的不同通配模式交错 When 归一 Then 保留胜者顺序', () => {
  const ineligible = rule('p/a*cd', 1, [{ kind: 'weekdays', days: [1] }])
  const winner = rule('p/ab*d', 2, [{ kind: 'weekdays', days: [0] }])
  const tied = rule('p/a*cd', 3, [{ kind: 'weekdays', days: [0] }])
  const normalized = normalizePricingRules([ineligible, winner, tied])
  assert.deepEqual(normalized, [ineligible, winner, tied])
  assert.equal(resolvePricingRule(normalized, 'p/abcd', new Date(2026, 8, 6)).winner, winner)
})

test('Given 组内只有条件规则 When 归一 Then 全部保留且不合成默认价', () => {
  const first = rule('a/b', 1, [condition])
  const second = rule('a/b', 2, [{ kind: 'weekdays', days: [2] }])
  assert.deepEqual(normalizePricingRules([first, second]), [first, second])
})

test('Given 多条 */* 规则 When 归一 Then 首条留在原位', () => {
  const globalFirst = rule(GLOBAL_DEFAULT_MODEL, 1)
  const exact = rule('p/m', 3)
  const globalSecond = rule(GLOBAL_DEFAULT_MODEL, 2)
  const normalized = normalizePricingRules([globalFirst, exact, globalSecond])
  assert.deepEqual(normalized, [globalFirst, exact])
})

test('Given 空数组或非数组 When 归一 Then 返回空数组', () => {
  assert.deepEqual(normalizePricingRules([]), [])
  assert.deepEqual(normalizePricingRules(null), [])
  assert.deepEqual(normalizePricingRules(undefined), [])
})

test('Given 同模型条件规则与多条无条件 When 归一 Then 默认价与条件规则分别保序', () => {
  const early = rule('a/b', 1, [condition])
  const fallback = rule('a/b', 2)
  const late = rule('a/b', 3, [{ kind: 'weekdays', days: [2] }])
  const duplicate = rule('a/b', 4)
  const normalized = normalizePricingRules([early, fallback, late, duplicate])
  assert.deepEqual(normalized, [early, fallback, late])
})

test('Given 缺失 conditions 的存量规则 When 归一 Then 视为无条件默认价', () => {
  const fallback = { ...rule('a/b', 1), conditions: undefined }
  const duplicate = rule('a/b', 2)
  assert.deepEqual(normalizePricingRules([fallback, duplicate]), [fallback])
})
