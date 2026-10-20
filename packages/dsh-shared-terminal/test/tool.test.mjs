import test from 'node:test'
import assert from 'node:assert/strict'
import { createTerminalTool } from '../src/lib/tool.mjs'
import { MAX_SCREEN_LINES } from '../src/lib/private-screen.mjs'
import { defineTool, validateJsonSchemaValue } from './host.mjs'


// Given 0.2.1 形态(无 write 有泵工厂),When 工具 write,Then 走泵通道且 submit 附加回车
test('attach泵工具层_write分叉_走泵且submit附加CR', async () => {
  const writes = []
  const pumpFactory = { for: () => ({ write: async (text) => { writes.push(text) } }) }
  const controller = makeController({ list() { return [{ id: 'term-a' }] } })
  const tool = makeTool(controller, undefined, pumpFactory)
  const result = await tool.execute({ action: 'write', terminal_id: 'term-a', text: 'echo pump', submit: true }, exec)
  assert.equal(result.ok, true)
  assert.equal(result.accepted, true)
  assert.deepEqual(writes, ['echo pump\r'])
})

// Given 泵写入被持续拒绝,When 工具 write,Then 返回 TERMINAL_ERROR 并提示接管语义
test('attach泵工具层_拒绝错误_映射TERMINAL_ERROR', async () => {
  const pumpFactory = { for: () => ({ write: async () => { throw Object.assign(new Error('terminal 写入被拒绝: read-only'), { code: 'terminal/write-refused', refusal: 'read-only' }) } }) }
  const controller = makeController({ list() { return [{ id: 'term-a' }] } })
  const tool = makeTool(controller, undefined, pumpFactory)
  const result = await tool.execute({ action: 'write', terminal_id: 'term-a', text: 'x' }, exec)
  assert.equal(result.ok, false)
  assert.equal(result.error.code, 'TERMINAL_ERROR')
  assert.match(result.error.message, /接管/)
})

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

// ── wait 动作 ─────────────────────────────────────────────────────────

const waitReadScreen = (screens) => {
  const calls = []
  const queue = screens.map((item) => (typeof item === 'function' ? item : () => item))
  const readScreen = async (...args) => {
    calls.push(args)
    const next = queue.length > 1 ? queue.shift() : queue[0]
    return next()
  }
  return { readScreen, calls }
}

const screen = (text, state = 'running') => ({ text, lines: text.split('\n').length, truncated: false, state, sequence: 7 })

test('Given needle already on screen, When waiting, Then found with elapsed and match-time screen', async () => {
  const controller = makeController()
  const { readScreen, calls } = waitReadScreen([() => screen('ready\nBuild successful')])
  const tool = makeTool(controller, readScreen)
  const result = await tool.execute({ action: 'wait', terminal_id: 'term-a', text: 'Build successful' }, exec)
  assert.equal(result.kind, 'found')
  assert.equal(result.ok, true)
  assert.equal(result.terminal_id, 'term-a')
  assert.equal(result.text, 'ready\nBuild successful')
  assert.equal(typeof result.elapsed_ms, 'number')
  assert.equal(calls.length, 1, '立即命中不得空转轮询')
  assert.deepEqual(calls[0], [controller, agent, 'term-a', MAX_SCREEN_LINES], 'wait 应以全 viewport 窗口扫描')
})

test('Given needle appears later, When waiting across polls, Then found carries the match-time screen', async () => {
  const { readScreen, calls } = waitReadScreen([screen('starting'), screen('compiling'), screen('Build successful\n$')])
  const tool = makeTool(makeController(), readScreen)
  const result = await tool.execute({ action: 'wait', terminal_id: 'term-a', text: 'Build successful' }, exec)
  assert.equal(result.kind, 'found')
  assert.equal(result.text, 'Build successful\n$')
  assert.equal(calls.length, 3)
})

test('Given needle absent for the whole budget, When waiting, Then timeout echoes budget with the last screen', async () => {
  const { readScreen } = waitReadScreen([() => screen('$')])
  const tool = makeTool(makeController(), readScreen)
  const result = await tool.execute({ action: 'wait', terminal_id: 'term-a', text: 'never', timeout_ms: 150 }, exec)
  assert.equal(result.kind, 'timeout')
  assert.equal(result.timeout_ms, 150)
  assert.equal(result.text, '$')
})

test('Given terminal exits before the needle, When waiting, Then exited short-circuits ahead of timeout', async () => {
  const { readScreen, calls } = waitReadScreen([screen('$'), screen('process exited', 'exited')])
  const tool = makeTool(makeController(), readScreen)
  const result = await tool.execute({ action: 'wait', terminal_id: 'term-a', text: 'never' }, exec)
  assert.equal(result.kind, 'exited')
  assert.equal(result.state, 'exited')
  assert.equal(calls.length, 2, '退出即返回,不得等满预算')
})

test('Given malformed wait arguments, When executing, Then closed schemas reject with distinct codes', async () => {
  const tool = makeTool(makeController())
  assert.equal((await tool.execute({ action: 'wait', terminal_id: 'term-a', text: '' }, exec)).error.code, 'INVALID_ARGS')
  assert.equal((await tool.execute({ action: 'wait', terminal_id: 'term-a', text: 'x', lines: 5 }, exec)).error.code, 'INVALID_ARGS')
  assert.equal((await tool.execute({ action: 'wait', terminal_id: 'term-a', text: 'x', timeout_ms: 99 }, exec)).error.code, 'INVALID_TIMEOUT')
  assert.equal((await tool.execute({ action: 'wait', terminal_id: 'term-a', text: 'x', timeout_ms: 55_001 }, exec)).error.code, 'INVALID_TIMEOUT')
  assert.equal((await tool.execute({ action: 'wait', terminal_id: 'term-a', text: 'x', timeout_ms: 10.5 }, exec)).error.code, 'INVALID_TIMEOUT')
  assert.equal((await tool.execute({ action: 'wait', terminal_id: '', text: 'x' }, exec)).error.code, 'INVALID_ARGS')
})

test('Given a wait result, When validated by Host output validator, Then all three kinds are closed-schema valid', async () => {
  for (const screens of [
    [() => screen('Build successful')],
    [() => screen('$')],
    [screen('$'), screen('done', 'exited')],
  ]) {
    const tool = makeTool(makeController(), waitReadScreen(screens).readScreen)
    const result = await tool.execute({ action: 'wait', terminal_id: 'term-a', text: 'Build successful', timeout_ms: 150 }, exec)
    assert.deepEqual(validateJsonSchemaValue(tool.output.schema, result), [])
  }
})

test('Given terminal closes mid-wait, When waiting, Then unavailable surfaces instead of spinning', async () => {
  let first = true
  const readScreen = async () => {
    if (first) { first = false; return screen('$') }
    throw { code: 'terminal/unavailable', message: 'Terminal no longer available' }
  }
  const result = await makeTool(makeController(), readScreen).execute({ action: 'wait', terminal_id: 'term-a', text: 'never', timeout_ms: 150 }, exec)
  assert.equal(result.ok, false)
  assert.equal(result.error.code, 'TERMINAL_UNAVAILABLE')
})

test('Given the turn aborts mid-wait, When waiting, Then the wait aborts cooperatively', async () => {
  const abort = new AbortController()
  const readScreen = async () => screen('$')
  const running = makeTool(makeController(), readScreen).execute({ action: 'wait', terminal_id: 'term-a', text: 'never', timeout_ms: 5000 }, { agent, signal: abort.signal })
  abort.abort()
  const result = await running
  assert.equal(result.ok, false)
  assert.match(result.error.message, /abort/i)
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

const makeTool = (controller, readScreen = async () => ({ text: 'screen', lines: 1, truncated: false, state: 'running', sequence: 3 }), pumpFactory) =>
  createTerminalTool({ controller, readScreen, defineTool, pumpFactory })

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
  assert.match(result.error.message, /侧边栏面板未打开/, '错误文案须引导用户打开面板')
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
