// 标记器 BDD:派生稳定性 / 隔离性 / 格式 / 三协议形状注入 / 未知形状不注入。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { deriveMarker, injectSessionMarker, isAnthropicPayload, isOpenAIPayload } from '../src/marker.mjs'

const HEX = /^[0-9a-f]+$/

test('同 id 派生恒定,异 id 派生不同', () => {
  const a = deriveMarker('session-a')
  assert.equal(a, deriveMarker('session-a'))
  assert.notEqual(a, deriveMarker('session-b'))
})

test('标记格式为 dsh:<40 位 hex>,不含原始会话 id', () => {
  const marker = deriveMarker('secret-session-id')
  const [prefix, hash] = marker.split(':')
  assert.equal(prefix, 'dsh')
  assert.equal(hash.length, 40)
  assert.match(hash, HEX)
  assert.ok(!marker.includes('secret-session-id'))
})

test('前缀可配', () => {
  assert.ok(deriveMarker('s', 'rstui').startsWith('rstui:'))
})

test('anthropic 形状注入 metadata.user_id', () => {
  const payload = { model: 'claude', system: 'sys', max_tokens: 10 }
  const next = injectSessionMarker(payload, 'session-a')
  assert.match(next.metadata.user_id, /^dsh:[0-9a-f]{40}$/)
  assert.equal(next.metadata.user_id, deriveMarker('session-a'))
  // 原对象不被改动
  assert.equal(payload.metadata, undefined)
})

test('按协议 api 显式分派与形状判别结果一致', () => {
  const anthropic = { system: 'x', max_tokens: 1 }
  for (const api of ['anthropic-messages', undefined]) {
    const next = injectSessionMarker(anthropic, 'session-a', { api })
    assert.equal(next.metadata.user_id, deriveMarker('session-a'))
  }
  for (const payload of [{ messages: [] }, { input: [] }]) {
    for (const api of ['openai-completions', 'openai-responses', undefined]) {
      const next = injectSessionMarker(payload, 'session-a', { api })
      assert.equal(next.prompt_cache_key, deriveMarker('session-a'))
    }
  }
})

test('api 已知时形状判别被跳过:非典型体也按协议注入', () => {
  const next = injectSessionMarker({ model: 'claude' }, 'session-a', { api: 'anthropic-messages' })
  assert.equal(next.metadata.user_id, deriveMarker('session-a'))
})

test('模板经 options.template 合入,user_id 恒为标记', () => {
  const next = injectSessionMarker(
    { system: 'x' },
    'session-a',
    { api: 'anthropic-messages', template: { gateway: 'newapi', user_id: 'old' } },
  )
  assert.equal(next.metadata.user_id, deriveMarker('session-a'))
  assert.equal(next.metadata.gateway, 'newapi')
})

test('openai 形状注入顶层 prompt_cache_key', () => {
  for (const payload of [
    { model: 'gpt', messages: [] },
    { model: 'gpt', input: [] },
  ]) {
    const next = injectSessionMarker(payload, 'session-a')
    assert.equal(next.prompt_cache_key, deriveMarker('session-a'))
  }
})

test('未知形状原样返回,无字段写入', () => {
  const payload = { foo: 'bar' }
  assert.equal(injectSessionMarker(payload, 'session-a'), payload)
})

test('形状判别器边界', () => {
  assert.equal(isAnthropicPayload({ system: 'x' }), true)
  assert.equal(isAnthropicPayload({ max_tokens: 1 }), true)
  // openai 系分页字段出现时不判为 anthropic
  assert.equal(isAnthropicPayload({ max_tokens: 1, stream_options: {} }), false)
  assert.equal(isAnthropicPayload({ max_tokens: 1, store: true }), false)
  assert.equal(isAnthropicPayload({ max_tokens: 1, max_completion_tokens: 1 }), false)
  assert.equal(isOpenAIPayload({ messages: [] }), true)
  assert.equal(isOpenAIPayload({ input: 'x' }), true)
  assert.equal(isOpenAIPayload({}), false)
  assert.equal(isAnthropicPayload(null), false)
  assert.equal(isOpenAIPayload('x'), false)
})

test('anthropic 已有 metadata 时保留其余键并覆盖 user_id', () => {
  const next = injectSessionMarker({ system: 'x', metadata: { user_id: 'old', other: 1 } }, 'session-a')
  assert.equal(next.metadata.user_id, deriveMarker('session-a'))
  assert.equal(next.metadata.other, 1)
})
