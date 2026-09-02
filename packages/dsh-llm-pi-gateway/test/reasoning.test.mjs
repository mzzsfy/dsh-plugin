// reasoningEfforts 解析 BDD:与官方 dsh-llm-pi-ai resolveModelReasoning 逐条对表。
// 钉 null / off 缺席 / off 带值 / 校验拒绝 / false 短路 / 缺省回退。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { resolveRoute } from '../src/config.mjs'

const BASE_PROFILE = {
  api: 'anthropic-messages',
  baseURL: 'https://gw.example.com',
  models: [{ id: 'auto', contextWindow: 200000 }],
}

function codeOf(fn) {
  try {
    fn()
    return undefined
  } catch (error) {
    return error.code
  }
}

function modelOf(route, id) {
  return resolveRoute('p', route).models.get(id)
}

test('reasoningEfforts 字典翻译为 thinkingLevelMap:已声明带 wire 值,未声明钉 null', () => {
  const model = modelOf({
    ...BASE_PROFILE,
    models: [{ id: 'think', contextWindow: 200000, reasoningEfforts: { off: null, low: 'low', max: 'ultra' } }],
  }, 'think')
  assert.equal(model.reasoning, true)
  assert.deepEqual(model.thinkingLevelMap, {
    minimal: null,
    low: 'low',
    medium: null,
    high: null,
    xhigh: null,
    max: 'ultra',
  })
})

test('off 无值从 map 缺席(pi-ai 读作支持且不发参数)', () => {
  const model = modelOf({
    ...BASE_PROFILE,
    models: [{ id: 'think', contextWindow: 200000, reasoningEfforts: { off: null, high: 'high' } }],
  }, 'think')
  assert.equal('off' in model.thinkingLevelMap, false)
  assert.equal(model.thinkingLevelMap.high, 'high')
})

test('off 带字符串值进 map(显式关闭语义)', () => {
  const model = modelOf({
    ...BASE_PROFILE,
    models: [{ id: 'think', contextWindow: 200000, reasoningEfforts: { off: 'disable', high: 'high' } }],
  }, 'think')
  assert.equal(model.thinkingLevelMap.off, 'disable')
})

test('reasoningEfforts 缺省:无目录基础,reasoning 回退模型 reasoning 字段(false)', () => {
  const model = modelOf(BASE_PROFILE, 'auto')
  assert.equal(model.reasoning, false)
  assert.equal(model.thinkingLevelMap, undefined)
})

test('reasoningEfforts: false 显式声明非推理', () => {
  const model = modelOf({
    ...BASE_PROFILE,
    models: [{ id: 'plain', contextWindow: 200000, reasoningEfforts: false }],
  }, 'plain')
  assert.equal(model.reasoning, false)
})

test('空字典拒绝', () => {
  assert.equal(codeOf(() => modelOf({
    ...BASE_PROFILE,
    models: [{ id: 'x', reasoningEfforts: {} }],
  }, 'x')), 'INVALID_CONFIG')
})

test('仅声明 off(无 thinking level)拒绝', () => {
  assert.equal(codeOf(() => modelOf({
    ...BASE_PROFILE,
    models: [{ id: 'x', reasoningEfforts: { off: null } }],
  }, 'x')), 'INVALID_CONFIG')
})

test('非 off 的 null wire 值拒绝(该档位需要发射值)', () => {
  assert.equal(codeOf(() => modelOf({
    ...BASE_PROFILE,
    models: [{ id: 'x', reasoningEfforts: { high: null } }],
  }, 'x')), 'INVALID_CONFIG')
})

test('空字符串 wire 值拒绝', () => {
  assert.equal(codeOf(() => modelOf({
    ...BASE_PROFILE,
    models: [{ id: 'x', reasoningEfforts: { high: '' } }],
  }, 'x')), 'INVALID_CONFIG')
})

test('未知档位键拒绝', () => {
  assert.equal(codeOf(() => modelOf({
    ...BASE_PROFILE,
    models: [{ id: 'x', reasoningEfforts: { extreme: 'x' } }],
  }, 'x')), 'INVALID_CONFIG')
})
