import test from 'node:test'
import assert from 'node:assert/strict'
import { createTerminalTool } from '../src/lib/tool.mjs'
import { defineTool, validateJsonSchemaValue } from './host.mjs'


test('Given all action results, When validated by Host output validator, Then each closed branch is accepted and incomplete output is rejected', async () => {
  const controller = makeController({ list() { return [{ id: 'term-a', title: 'bash', cwd: '/work', cols: 80, rows: 24, state: 'running', controllerId: 'attach-a' }] } })
  const tool = makeTool(controller)
  const cases = [{ action: 'open' }, { action: 'list' }, { action: 'read', terminal_id: 'term-a' },
    { action: 'write', terminal_id: 'term-a', text: 'hi' }, { action: 'close', terminal_id: 'term-a' }, { action: 'read', terminal_id: '' }]
  for (const args of cases) assert.deepEqual(validateJsonSchemaValue(tool.output.schema, await tool.execute(args, exec)), [])
  assert.notDeepEqual(validateJsonSchemaValue(tool.output.schema, { ok: true }), [])
  assert.notDeepEqual(validateJsonSchemaValue(tool.output.schema, { ok: true, terminal_id: 'x', extra: true }), [])
})

test('Given dispatched write waiting on Controller, When the turn aborts, Then already submitted input cannot be retracted', async () => {
  let release
  const gate = new Promise((resolve) => { release = resolve })
  const sent = []
  const controller = makeController({ list() { return [{ id: 'term-a', controllerId: 'attach-a' }] }, async write(...args) { await gate; sent.push(args.at(-1)) } })
  const abort = new AbortController()
  const running = makeTool(controller).execute({ action: 'write', terminal_id: 'term-a', text: 'echo test', submit: true }, { agent, signal: abort.signal })
  abort.abort()
  release()
  assert.equal((await running).accepted, true)
  assert.deepEqual(sent, ['echo test\r'])
})

const agent = { id: 'session-a', session: { id: 'session-a' } }
const exec = { agent, signal: new AbortController().signal }

function makeController(overrides = {}) {
  const calls = []
  const data = new Map()
  const controller = {
    async shells() { return [{ path: 'bash', name: 'bash', args: [] }] },
    list(sessionId) { assert.equal(sessionId, 'session-a'); return data.get(sessionId) ?? [] },
    async create(actualAgent, request) { calls.push(['create', actualAgent, request]); return { id: request.id, title: 'bash', cwd: 'C:/work', cols: request.cols, rows: request.rows, state: 'running' } },
    async write(...args) { calls.push(['write', ...args]) },
    async close(...args) { calls.push(['close', ...args]) },
    calls,
    data,
    ...overrides,
  }
  return controller
}

const makeTool = (controller, readScreen = async () => ({ text: 'screen', lines: 1, truncated: false, state: 'running', sequence: 3 })) =>
  createTerminalTool({ controller, readScreen, defineTool })

test('Given open with default dimensions, When creating terminal, Then it uses DSH controller and returns id', async () => {
  const controller = makeController()
  const result = await makeTool(controller).execute({ action: 'open' }, exec)
  assert.equal(result.ok, true)
  assert.equal(controller.calls[0][0], 'create')
  assert.equal(controller.calls[0][1], agent)
  assert.equal(controller.calls[0][2].cols, 80)
  assert.equal(controller.calls[0][2].rows, 24)
  assert.equal(result.terminal_id, controller.calls[0][2].id)
})

test('Given an unavailable shell profile, When opening with shell_path, Then creation is rejected', async () => {
  const controller = makeController({ async shells() { return [] } })
  const result = await makeTool(controller).execute({ action: 'open', shell_path: 'other' }, exec)
  assert.equal(result.error.code, 'INVALID_SHELL')
  assert.equal(controller.calls.length, 0)
})

test('Given current Session terminals, When listing, Then metadata is session scoped', async () => {
  const row = { id: 'term-a', title: 'bash', cwd: '/work', cols: 80, rows: 24, state: 'running', controllerId: 'attach-a' }
  const controller = makeController({ list(sessionId) { assert.equal(sessionId, 'session-a'); return [row] } })
  const result = await makeTool(controller).execute({ action: 'list' }, exec)
  assert.deepEqual(result.terminals, [{ terminal_id: 'term-a', title: 'bash', cwd: '/work', state: 'running', cols: 80, rows: 24, attached: true }])
})

test('Given a terminal id and N, When reading, Then it calls screen adapter and returns visible text', async () => {
  const controller = makeController()
  const reads = []
  const result = await makeTool(controller, async (...args) => { reads.push(args); return { text: 'last', lines: 1, truncated: true, state: 'running', sequence: 4 } })
    .execute({ action: 'read', terminal_id: 'term-a', lines: 1 }, exec)
  assert.deepEqual(reads, [[controller, agent, 'term-a', 1]])
  assert.equal(result.text, 'last')
  assert.equal(result.sequence, 4)
})

test('Given current attachment, When writing with submit, Then it appends CR and uses Controller id', async () => {
  const row = { id: 'term-a', controllerId: 'attach-a' }
  const controller = makeController({ list() { return [row] } })
  const result = await makeTool(controller).execute({ action: 'write', terminal_id: 'term-a', text: 'echo hi', submit: true }, exec)
  assert.equal(result.ok, true)
  assert.deepEqual(controller.calls[0], ['write', agent, 'term-a', 'attach-a', 'echo hi\r'])
})

test('Given attachment lost, When writing, Then it does not create a new follower', async () => {
  const controller = makeController({ list() { return [{ id: 'term-a' }] } })
  const result = await makeTool(controller).execute({ action: 'write', terminal_id: 'term-a', text: 'x' }, exec)
  assert.equal(result.error.code, 'NOT_ATTACHED')
  assert.equal(controller.calls.length, 0)
})

test('Given a terminal id, When closing, Then it delegates idempotent close to Controller', async () => {
  const controller = makeController()
  const result = await makeTool(controller).execute({ action: 'close', terminal_id: 'term-a' }, exec)
  assert.equal(result.ok, true)
  assert.deepEqual(controller.calls[0], ['close', agent, 'term-a'])
})

test('Given control errors, When writing, Then it maps read-only and not-running distinctly', async () => {
  for (const [reason, code] of [['read-only', 'NOT_ATTACHED'], ['not-running', 'TERMINAL_UNAVAILABLE'], ['unknown', 'TERMINAL_ERROR']]) {
    const controller = makeController({ list() { return [{ id: 'term-a', controllerId: 'attach-a' }] }, async write() { throw { code: 'terminal/control-unavailable', details: { reason }, message: reason } } })
    const result = await makeTool(controller).execute({ action: 'write', terminal_id: 'term-a', text: 'x' }, exec)
    assert.equal(result.error.code, code)
  }
})

test('Given malformed or extra action parameters, When executing, Then it rejects closed schemas', async () => {
  const tool = makeTool(makeController())
  assert.equal((await tool.execute({ action: 'open', cols: 20.5 }, exec)).error.code, 'INVALID_DIMS')
  assert.equal((await tool.execute({ action: 'list', other: true }, exec)).error.code, 'INVALID_ARGS')
  await assert.rejects(tool.execute({ action: 'write', terminal_id: 'x', text: 2 }, exec), { code: 'INVALID_ARGS' })
  assert.equal((await tool.execute({ action: 'close', terminal_id: '  ' }, exec)).error.code, 'INVALID_ARGS')
})

test('Given missing terminal id in current Session, When writing, Then unavailable differs from a missing attachment', async () => {
  const controller = makeController()
  const result = await makeTool(controller).execute({ action: 'write', terminal_id: 'foreign', text: 'x' }, exec)
  assert.equal(result.error.code, 'TERMINAL_UNAVAILABLE')
  assert.equal(controller.calls.length, 0)
})

test('Given malformed Agent Session identity, When executing, Then no ownership is forged or created', async () => {
  const controller = makeController()
  const result = await makeTool(controller).execute({ action: 'open' }, { agent: { id: 'child', session: { id: 'parent' } } })
  assert.equal(result.error.code, 'INVALID_ARGS')
  assert.equal(controller.calls.length, 0)
})

test('Given a different Agent, When invoking read, Then its actual Agent identity is preserved for owner validation', async () => {
  const otherAgent = { id: 'session-b', session: { id: 'session-b' } }
  const controller = makeController()
  const seen = []
  await makeTool(controller, async (...args) => { seen.push(args); throw { code: 'terminal/unavailable', message: 'unavailable' } })
    .execute({ action: 'read', terminal_id: 'term-a' }, { agent: otherAgent })
  assert.equal(seen[0][1], otherAgent)
})
