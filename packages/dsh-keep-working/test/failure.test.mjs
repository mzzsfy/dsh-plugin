import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
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

test('鉴权与权限失败按临时错误重试(可能只是某条上游通道)', () => {
  assert.equal(isTransientFailure(facts('UNAUTHORIZED', 'invalid api key')), true)
  assert.equal(isTransientFailure(facts('UPSTREAM', 'forbidden', 403)), true)
  assert.equal(isTransientFailure(facts('UPSTREAM', 'something', 401)), true)
  assert.equal(isTransientFailure(facts('AUTH', 'credentials rejected')), true)
})

test('余额与配额耗尽按临时错误重试(换上游可能仍可用)', () => {
  assert.equal(isTransientFailure(facts('BILLING', 'insufficient balance')), true)
  assert.equal(isTransientFailure(facts('QUOTA', 'insufficient quota for this account')), true)
})

test('模型不存在按临时错误重试,上下文超限仍永久', () => {
  assert.equal(isTransientFailure(facts('UPSTREAM', 'model not found: foo')), true)
  assert.equal(isTransientFailure(facts('UPSTREAM', 'context length exceeded')), false)
})

test('网络、超时、5xx、429 属临时错误', () => {
  assert.equal(isTransientFailure(facts('UPSTREAM', 'bad gateway', 502)), true)
  assert.equal(isTransientFailure(facts('RATE_LIMIT', 'rate limit exceeded', 429)), true)
  assert.equal(isTransientFailure(facts('TIMEOUT', 'request timed out')), true)
})

test('网关断流即使包装成 INVALID_REQUEST 也按临时错误重试', () => {
  const message =
    "litellm.APIConnectionError: APIConnectionError: OpenAIException - Response payload is not completed: <TransferEncodingError: 400, message='Not enough data to satisfy transfer length header.'>. ConnectionResetError(104, 'Connection reset by peer')"
  assert.equal(isTransientFailure({ code: 'INVALID_REQUEST', message }), true)
  assert.equal(isTransientFailure({ code: 'UPSTREAM', message: 'socket hang up' }), true)
  // 包装码不可信,文本里泛泛的 invalid request 也重试;工具参数校验错误(INVALID_ARGS)才判永久
  assert.equal(isTransientFailure({ code: 'INVALID_REQUEST', message: 'invalid request: unknown field foo' }), true)
  assert.equal(isTransientFailure({ code: 'INVALID_ARGS', message: 'unknown field foo' }), false)
})

test('中转把上游错误包成 BadRequestError 时不误判永久', () => {
  assert.equal(
    isTransientFailure({ code: 'QUOTA', message: 'litellm.BadRequestError: Your credit balance is too low' }),
    true,
  )
  assert.equal(
    isTransientFailure({
      code: 'AUTH',
      message: '401 {"error":{"type":"invalid_request_error","message":"Incorrect API key provided"}}',
    }),
    true,
  )
  assert.equal(
    isTransientFailure({ code: 'UNKNOWN', message: 'litellm.BadRequestError: model does not exist' }),
    true,
  )
})

test('context deadline exceeded 按超时重试,真正的上下文超限仍永久', () => {
  assert.equal(isTransientFailure({ code: 'TIMEOUT', message: 'context deadline exceeded' }), true)
  assert.equal(
    isTransientFailure({ code: 'UNKNOWN', message: 'Post "https://api": context deadline exceeded', status: 504 }),
    true,
  )
  assert.equal(isTransientFailure({ code: 'UNKNOWN', message: 'context window exceeded' }), false)
  assert.equal(isTransientFailure({ code: 'UNKNOWN', message: 'maximum context length is 128000' }), false)
  assert.equal(isTransientFailure({ code: 'UNKNOWN', message: 'max context exceeded' }), false)
  assert.equal(isTransientFailure({ code: 'UNKNOWN', message: 'context_size_exceeded' }), false)
})

test('MALFORMED_RESPONSE 虽含关键词仍按临时处理', () => {
  assert.equal(isTransientFailure(facts('MALFORMED_RESPONSE', 'tool echoed {api_key}')), true)
})

test('宿主把状态并进 message 时 401/403 也按临时错误重试', () => {
  assert.equal(isTransientFailure(facts('AUTH', '401 {"error":{"status":401}}')), true)
  assert.equal(isTransientFailure(facts('UNKNOWN', 'upstream replied 403 forbidden')), true)
  assert.equal(isTransientFailure(facts('UPSTREAM', 'bad gateway 502')), true)
})

test('非状态语境的 401/403 数字不误判为永久错误', () => {
  assert.equal(isTransientFailure(facts('UPSTREAM', 'retry after 403 ms')), true)
  assert.equal(isTransientFailure(facts('UPSTREAM', 'remaining 401 tokens')), true)
})

test('MALFORMED_RESPONSE 回显 401/403 数字仍按临时处理', () => {
  assert.equal(isTransientFailure(facts('MALFORMED_RESPONSE', 'context has 401 tokens')), true)
  assert.equal(isTransientFailure(facts('MALFORMED_RESPONSE', 'after 403 ms')), true)
})

test('AUTH 码单独出现也按临时错误重试', () => {
  assert.equal(isTransientFailure(facts('AUTH', 'the request failed')), true)
})

test('用户自定义片段优先于内置判定,且可匹配规范码', () => {
  assert.equal(isTransientFailure({ code: 'CONTEXT_WINDOW_EXCEEDED', message: 'the request failed' }, 'the request failed'), true)
  assert.equal(isTransientFailure({ code: 'CONTEXT_WINDOW_EXCEEDED', message: 'the request failed' }, 'context_window_exceeded'), true)
  assert.equal(isTransientFailure(facts('UPSTREAM', 'bad gateway', 502), 'bad gateway'), true)
})

test('只有请求结构类规范码判永久', () => {
  for (const code of ['CONTEXT_WINDOW_EXCEEDED', 'INVALID_ARGS', 'NO_ADAPTER', 'MISSING_CREDENTIAL']) {
    assert.equal(isTransientFailure({ code, message: 'the request failed' }), false, `${code} 应判永久`)
  }
  for (const code of ['QUOTA', 'ACCOUNT_QUOTA', 'AUTH', 'INVALID_CREDENTIAL']) {
    assert.equal(isTransientFailure({ code, message: 'the request failed' }), true, `${code} 属上游级,应重试`)
  }
})

test('额度耗尽原文也按临时错误重试', () => {
  const samples = [
    'Resource has been exhausted (e.g. check quota).',
    'Your credit balance is too low to access the Anthropic API',
  ]
  for (const message of samples) {
    assert.equal(isTransientFailure({ code: 'QUOTA', message }), true, message)
    assert.equal(isTransientFailure({ code: 'UNKNOWN', message }), true, `无规范码也重试: ${message}`)
  }
})
