import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseArgs } from '../cli-args.mjs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const defaults = { port: 18123, log: join(tmpdir(), 'echo-upstream.jsonl') }

test('parseArgs preserves CLI defaults without options', () => {
  assert.deepEqual(parseArgs([], defaults), defaults)
})

test('parseArgs preserves default log when only port is overridden', () => {
  assert.deepEqual(parseArgs(['--port', '0'], defaults), { ...defaults, port: 0 })
})

test('parseArgs reads adjacent compat boolean flags', () => {
  const args = parseArgs(['--echo-user-message', '--port', '0'], defaults)
  assert.equal(args.echoUserMessage, true)
  assert.equal(args.port, 0)
  assert.equal(Object.hasOwn(args, 'echoAssistantInput'), false)
})

test('parseArgs reads value options between boolean flags', () => {
  const args = parseArgs(['--echo-user-message', '--port', '0', '--log', 'requests.jsonl'], defaults)
  assert.equal(args.echoUserMessage, true)
  assert.equal(args.port, 0)
  assert.equal(args.log, 'requests.jsonl')
  assert.equal(Object.hasOwn(args, 'echoAssistantInput'), false)
})

test('parseArgs rejects missing values, unknown options, and removed history option', () => {
  assert.throws(() => parseArgs(['--port', '--echo-user-message'], defaults), /缺少值/)
  assert.throws(() => parseArgs(['--unknown'], defaults), /无效参数/)
  assert.throws(() => parseArgs(['--echo-assistant-input'], defaults), /无效参数/)
})
