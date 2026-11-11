import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  isNetworkFailure,
  isTransientAgentError,
  isTransientFailure,
  parseFailureFacts,
} from '../src/failure.mjs'

const facts = (code, message, status) =>
  status === undefined ? { code, message } : { code, message, status }

test('parseFailureFacts 只接受可解释的失败载荷', () => {
  assert.deepEqual(parseFailureFacts({ code: 'UPSTREAM', message: 'boom', status: 502 }), {
    code: 'UPSTREAM',
    message: 'boom',
    status: 502,
  })
  assert.deepEqual(parseFailureFacts({ message: '只有描述' }), { code: 'UNKNOWN', message: '只有描述' })
  assert.equal(parseFailureFacts(undefined), undefined)
  assert.equal(parseFailureFacts(null), undefined)
  assert.equal(parseFailureFacts('boom'), undefined)
  assert.equal(parseFailureFacts({}), undefined)
})

test('鉴权与权限失败属永久错误', () => {
  assert.equal(isTransientFailure(facts('UNAUTHORIZED', 'invalid api key')), false)
  assert.equal(isTransientFailure(facts('UPSTREAM', 'forbidden', 403)), false)
  assert.equal(isTransientFailure(facts('UPSTREAM', 'something', 401)), false)
})

test('余额与配额耗尽属永久错误', () => {
  assert.equal(isTransientFailure(facts('BILLING', 'insufficient balance')), false)
  assert.equal(isTransientFailure(facts('QUOTA', 'insufficient quota for this account')), false)
})

test('模型不存在与上下文超限属永久错误', () => {
  assert.equal(isTransientFailure(facts('UPSTREAM', 'model not found: foo')), false)
  assert.equal(isTransientFailure(facts('UPSTREAM', 'context length exceeded')), false)
})

test('网络、超时、5xx、429 属临时错误', () => {
  assert.equal(isTransientFailure(facts('UPSTREAM', 'bad gateway', 502)), true)
  assert.equal(isTransientFailure(facts('RATE_LIMIT', 'rate limit exceeded', 429)), true)
  assert.equal(isTransientFailure(facts('TIMEOUT', 'request timed out')), true)
})

test('MALFORMED_RESPONSE 虽含关键词仍按临时处理', () => {
  assert.equal(isTransientFailure(facts('MALFORMED_RESPONSE', 'tool echoed {api_key}')), true)
})

test('宿主把状态并进 message 时仍识别 401/403', () => {
  assert.equal(isTransientFailure(facts('AUTH', '401 {"error":{"status":401}}')), false)
  assert.equal(isTransientFailure(facts('UNKNOWN', 'upstream replied 403 forbidden')), false)
  assert.equal(isTransientFailure(facts('UPSTREAM', 'bad gateway 502')), true)
})

test('AUTH 码单独出现即为永久', () => {
  assert.equal(isTransientFailure(facts('AUTH', 'credentials rejected')), false)
})

test('用户自定义片段优先于内置判定', () => {
  assert.equal(isTransientFailure(facts('UPSTREAM', 'invalid api key'), 'invalid api key'), true)
  assert.equal(isTransientFailure(facts('UPSTREAM', 'bad gateway', 502), 'bad gateway'), true)
})

test('isTransientAgentError 只放行网络与传输类消息', () => {
  assert.equal(isTransientAgentError('network unreachable'), true)
  assert.equal(isTransientAgentError('upstream returned 503'), true)
  assert.equal(isTransientAgentError('serialization failed'), false)
  assert.equal(isTransientAgentError('agent disposed'), false)
})

test('isNetworkFailure 识别连接层失败', () => {
  assert.equal(isNetworkFailure(facts('TRANSPORT', 'x')), true)
  assert.equal(isNetworkFailure(facts('ECONNRESET', 'socket hang up')), true)
  assert.equal(isNetworkFailure(facts('UPSTREAM', 'fetch failed')), true)
  assert.equal(isNetworkFailure(facts('UPSTREAM', 'server error', 500)), false)
})
