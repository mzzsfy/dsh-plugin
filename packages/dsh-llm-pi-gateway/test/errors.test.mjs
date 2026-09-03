// GatewayError BDD:failure 冻结信封是 dsh-llm own-failure 识别协议的载体,
// name 与 code 必须稳定。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { GatewayError } from '../src/errors.mjs'

test('GatewayError:failure 信封携带 message 与 code 且冻结', () => {
  const error = new GatewayError('boom', 'UNKNOWN_MODEL')
  assert.equal(error instanceof Error, true)
  assert.equal(error.name, 'GatewayError')
  assert.equal(error.message, 'boom')
  assert.equal(error.code, 'UNKNOWN_MODEL')
  assert.deepEqual(error.failure, { message: 'boom', code: 'UNKNOWN_MODEL' })
  assert.equal(Object.isFrozen(error.failure), true)
})
