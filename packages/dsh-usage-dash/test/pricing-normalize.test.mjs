import { test } from 'node:test'
import assert from 'node:assert/strict'

import { GLOBAL_DEFAULT_MODEL, normalizePricingRules } from '../src/pricing.js'

const rule = (model, input, conditions = []) => ({
  model,
  unit: 'perMillion',
  currency: '¥',
  price: { input, output: 0, cacheRead: 0, cacheWrite: 0 },
  conditions,
})
const condition = { kind: 'weekdays', days: [1] }

test('Given 同模型多条无条件规则 When 归一 Then 保留首条为默认并置组末', () => {
  // Given a/b 的首条价格 1、次条价格 2
  // When 归一
  // Then 价格 1 保留在默认位,价格 2 删除,数组顺序为默认价
  const first = rule('a/b', 1)
  const second = rule('a/b', 2)
  const normalized = normalizePricingRules([first, second])
  assert.deepEqual(normalized, [first])
  assert.equal(normalized[0], first)
})

test('Given 无条件规则排在条件规则前 When 归一 Then 条件规则升到默认价前', () => {
  // Given [默认, 条件]
  // When 归一
  // Then [条件, 默认],条件规则不会排在默认价之后成为死规则
  const fallback = rule('a/b', 1)
  const special = rule('a/b', 2, [condition])
  const normalized = normalizePricingRules([fallback, special])
  assert.deepEqual(normalized, [special, fallback])
})

test('Given 组内只有条件规则 When 归一 Then 全部保留且不合成默认价', () => {
  const first = rule('a/b', 1, [condition])
  const second = rule('a/b', 2, [{ kind: 'weekdays', days: [2] }])
  assert.deepEqual(normalizePricingRules([first, second]), [first, second])
})

test('Given 多条 */* 规则 When 归一 Then 保留首条并整体移到其他模型之后', () => {
  // Given */* 首条 1、次条 2,中间夹一个精确模型
  // When 归一
  // Then 精确模型在前,*/* 只保留首条在最后
  const globalFirst = rule(GLOBAL_DEFAULT_MODEL, 1)
  const exact = rule('p/m', 3)
  const globalSecond = rule(GLOBAL_DEFAULT_MODEL, 2)
  const normalized = normalizePricingRules([globalFirst, exact, globalSecond])
  assert.deepEqual(normalized, [exact, globalFirst])
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
  assert.deepEqual(normalized, [early, late, fallback])
})

test('Given 缺失 conditions 的存量规则 When 归一 Then 视为无条件默认价', () => {
  const fallback = { ...rule('a/b', 1), conditions: undefined }
  const duplicate = rule('a/b', 2)
  assert.deepEqual(normalizePricingRules([fallback, duplicate]), [fallback])
})
