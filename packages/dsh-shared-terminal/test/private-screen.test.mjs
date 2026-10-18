import test from 'node:test'
import assert from 'node:assert/strict'
import { readControllerViewport, resolvePrivateTerminal } from '../src/lib/private-screen.mjs'

const makeTerminal = ({ rows = 3, viewportY = 0, values = ['one', 'two', 'three'], cursorY = Math.min(values.length - 1, rows - 1), baseY = viewportY, type = 'normal' } = {}) => {
  const buffer = {
    type,
    viewportY,
    baseY,
    cursorY,
    getLine(index) {
      const value = values[index - viewportY]
      return value === undefined ? undefined : { translateToString: () => value }
    },
  }
  const terminal = {
    info: { state: 'running' },
    screen: { rows, buffer: { active: buffer } },
    operations: Promise.resolve(),
    sequence: 9,
    enqueue(operation) {
      const pending = this.operations.then(operation)
      this.operations = pending.catch(() => {})
      return pending
    },
  }
  return terminal
}

const makeController = (terminal) => {
  const agent = { id: 'agent-a' }
  const id = 'term-a'
  const owner = { terminals: new Map([[id, terminal]]) }
  const controller = {
    owners: new Map([[agent.id, owner]]),
    terminal(actualAgent, actualId) {
      if (actualAgent !== agent || actualId !== id) throw Object.assign(new Error('terminal owner unavailable'), { code: 'terminal/unavailable' })
      return terminal
    },
  }
  return { controller, agent, id, owner }
}

test('Given an owned active terminal, When reading the last N viewport rows, Then it returns physical rows without scrollback', async () => {
  const terminal = makeTerminal({ rows: 3, viewportY: 2, values: ['a', 'b', 'c'] })
  const { controller, agent, id } = makeController(terminal)

  const result = await readControllerViewport(controller, agent, id, 2)

  assert.deepEqual(result, { text: 'b\nc', lines: 2, truncated: true, state: 'running', sequence: 9 })
})

test('Given a request larger than the viewport, When reading, Then the window stops at the newest content line', async () => {
  const terminal = makeTerminal({ rows: 3, values: ['first', '', ''] })
  const { controller, agent, id } = makeController(terminal)

  const result = await readControllerViewport(controller, agent, id, 20)

  assert.deepEqual(result, { text: 'first', lines: 1, truncated: false, state: 'running', sequence: 9 })
})

test('Given alternate buffer, When reading, Then the full viewport rectangle is returned', async () => {
  const terminal = makeTerminal({ rows: 3, values: ['', 'mid', ''], type: 'alternate', cursorY: 2 })
  const { controller, agent, id } = makeController(terminal)

  const result = await readControllerViewport(controller, agent, id, 3)

  assert.deepEqual(result, { text: '\nmid\n', lines: 3, truncated: false, state: 'running', sequence: 9 })
})

test('Given the viewport is scrolled up away from the cursor, When reading, Then the off-screen cursor does not stretch the window', async () => {
  const terminal = makeTerminal({ rows: 3, viewportY: 0, baseY: 5, cursorY: 2, values: ['a', '', ''] })
  const { controller, agent, id } = makeController(terminal)

  const result = await readControllerViewport(controller, agent, id, 3)

  assert.deepEqual(result, { text: 'a', lines: 1, truncated: false, state: 'running', sequence: 9 })
})

test('Given an invalid line count, When reading, Then it rejects before accessing a terminal', async () => {
  const { controller, agent, id } = makeController(makeTerminal())

  await assert.rejects(async () => readControllerViewport(controller, agent, id, 1.5), (error) => error instanceof RangeError && error.message === 'lines must be an integer between 1 and 200')
})

test('Given a foreign owner, When resolving a terminal, Then Controller ownership validation rejects access', () => {
  const { controller, id } = makeController(makeTerminal())
  assert.throws(() => resolvePrivateTerminal(controller, { id: 'agent-b' }, id), /terminal owner unavailable/)
})

test('Given output is queued before the read, When rows are read, Then the snapshot waits for xterm parsing to finish', async () => {
  const terminal = makeTerminal()
  const { controller, agent, id } = makeController(terminal)
  let finishOutput
  const output = terminal.enqueue(() => new Promise((resolve) => { finishOutput = resolve }))
  const snapshot = readControllerViewport(controller, agent, id, 3)
  await Promise.resolve()
  assert.equal(finishOutput instanceof Function, true)
  finishOutput()
  await output
  assert.equal((await snapshot).text, 'one\ntwo\nthree')
})

test('Given the private structure is missing, When resolving, Then it fails closed', () => {
  assert.throws(() => resolvePrivateTerminal({}, { id: 'agent-a' }, 'term-a'), /private API unavailable/)
})

