import test from 'node:test'
import assert from 'node:assert/strict'
import { hostRequire as require } from './host.mjs'
import { pathToFileURL } from 'node:url'
import { PassThrough } from 'node:stream'
import { readControllerViewport } from '../src/lib/private-screen.mjs'

const entry = pathToFileURL(require.resolve('@deepseek-ai/dsh-api-terminal-controller'))
const { default: TerminalController } = await import(entry.href)
const { BrowserTerminal } = await import(new URL('./types/terminal.js', entry).href)

function fixture(t, { cols = 12, rows = 3 } = {}) {
  const output = new PassThrough()
  let complete
  const handle = {
    output,
    done: new Promise((resolve) => { complete = resolve }),
    async terminate() { output.end(); complete({ exitCode: 0 }) },
    async write() {},
    async resize() {},
  }
  const info = { id: 'term', title: 'test', cwd: '/work', cols, rows, state: 'running', exitCode: null }
  const terminal = new BrowserTerminal(handle, info, 100, 1024 * 1024)
  const controller = Object.create(TerminalController.prototype)
  const owner = { terminals: new Map([['term', terminal]]), closedIds: new Set() }
  controller.owners = new Map([['session', owner]])
  const agent = { id: 'session' }
  t.after(() => terminal.dispose())
  return { terminal, controller, owner, agent, handle }
}

test('Given real xterm CJK and combining cells, When reading bottom physical rows, Then text and blank rows are preserved', async (t) => {
  const { terminal, controller, agent } = fixture(t)
  await terminal.output('top\r\n中文 e\u0301\r\n')
  assert.deepEqual(await readControllerViewport(controller, agent, 'term', 2), {
    text: 'top\n中文 e\u0301', lines: 2, truncated: false, state: 'running', sequence: 1,
  })
})

test('Given scrollback and soft wrapping, When reading, Then only viewport physical rows are returned', async (t) => {
  const { terminal, controller, agent } = fixture(t, { cols: 6, rows: 3 })
  await terminal.output('history\r\n123456789\r\nlast')
  assert.equal((await readControllerViewport(controller, agent, 'term', 20)).text, '123456\n789\nlast')
})

test('Given alternate buffer is active, When reading then returning to normal buffer, Then current active screen is used', async (t) => {
  const { terminal, controller, agent } = fixture(t)
  await terminal.output('normal\x1b[?1049h\x1b[2J\x1b[Halternate')
  assert.equal((await readControllerViewport(controller, agent, 'term', 3)).text, 'alternate\n\n')
  await terminal.output('\x1b[?1049l')
  assert.equal((await readControllerViewport(controller, agent, 'term', 3)).text, 'normal')
})

async function attachUI(t, terminal) {
  const signal = new AbortController()
  const input = typeof terminal.attach === 'function' ? new PassThrough({ objectMode: true }) : undefined
  const follow = input
    ? terminal.attach(input, { maxCols: terminal.info.cols, maxRows: terminal.info.rows }, signal.signal)
    : terminal.follow('ui', signal.signal)
  t.after(async () => { signal.abort(); input?.end(); await follow.return() })
  const { value: snapshot } = await follow.next()
  assert.equal(snapshot.type, 'snapshot')
  const assertWritable = () => input
    ? assert.equal(terminal.writable(terminal.controller), true)
    : assert.equal(terminal.info.controllerId, 'ui')
  if (input) assert.equal(snapshot.writable, true)
  assertWritable()
  let sequence = 0
  return {
    assertWritable,
    async resize(cols, rows) {
      if (!input) return terminal.resize('ui', cols, rows)
      input.write({ type: 'resize', sequence: ++sequence, cols, rows })
      while (true) {
        const { value: frame, done } = await follow.next()
        assert.equal(done, false, 'UI attachment ended before resize acknowledgement')
        if (frame.type !== 'ack') continue
        assert.equal(frame.sequence, sequence)
        assert.equal(frame.refusal, undefined)
        return
      }
    },
  }
}

test('Given official UI has writable attachment, When reading and resizing in queue, Then no follower or control is replaced', async (t) => {
  const { terminal, controller, agent, handle } = fixture(t)
  const ui = await attachUI(t, terminal)
  const originalController = terminal.controller
  const originalFollowers = [...terminal.followers]
  assert.equal(originalFollowers.length, 1)
  await terminal.output('shared')
  let releaseResize
  const resizeGate = new Promise((resolve) => { releaseResize = resolve })
  let startResize
  const resizeStarted = new Promise((resolve) => { startResize = resolve })
  handle.resize = async () => { startResize(); await resizeGate }
  const resize = ui.resize(10, 2)
  await resizeStarted
  const read = readControllerViewport(controller, agent, 'term', 20).then((snapshot) => {
    assert.deepEqual([terminal.screen.cols, terminal.screen.rows], [10, 2])
    return snapshot
  })
  releaseResize()
  await resize
  assert.equal((await read).text, 'shared')
  assert.deepEqual([terminal.screen.cols, terminal.screen.rows], [10, 2])
  assert.equal(terminal.controller, originalController)
  assert.deepEqual([...terminal.followers], originalFollowers)
  ui.assertWritable()
})

test('Given foreign or closed terminal identity, When reading through actual Controller lookup, Then unavailable is returned', async (t) => {
  const { controller, owner, agent } = fixture(t)
  await assert.rejects(async () => readControllerViewport(controller, { id: 'other' }, 'term', 3), { code: 'terminal/unavailable' })
  owner.closedIds.add('term')
  await assert.rejects(async () => readControllerViewport(controller, agent, 'term', 3), { code: 'terminal/unavailable' })
})

test('Given terminal is closed while read waits for queue, When read executes, Then stale screen cannot be read', async (t) => {
  const { terminal, controller, owner, agent } = fixture(t)
  let release
  terminal.enqueue(() => new Promise((resolve) => { release = resolve }))
  const read = Promise.resolve().then(() => readControllerViewport(controller, agent, 'term', 3))
  await Promise.resolve()
  owner.closedIds.add('term')
  release()
  await assert.rejects(read, { code: 'terminal/unavailable' })
})

test('Given a tall viewport with output near the top, When reading more rows than content, Then the window ends at the newest content instead of blank rows', async (t) => {
  const { terminal, controller, agent } = fixture(t, { rows: 10 })
  await terminal.output('one\r\ntwo\r\n')
  assert.deepEqual(await readControllerViewport(controller, agent, 'term', 10), {
    text: 'one\ntwo', lines: 2, truncated: false, state: 'running', sequence: 1,
  })
})

test('Given more content lines than requested, When reading, Then the newest lines win and older viewport rows stay truncated', async (t) => {
  const { terminal, controller, agent } = fixture(t, { rows: 10 })
  await terminal.output('r1\r\nr2\r\nr3\r\nr4\r\n')
  assert.deepEqual(await readControllerViewport(controller, agent, 'term', 2), {
    text: 'r3\nr4', lines: 2, truncated: true, state: 'running', sequence: 1,
  })
})

test('Given a non-empty prompt line under the cursor, When reading, Then the cursor line is included in the window', async (t) => {
  const { terminal, controller, agent } = fixture(t, { rows: 10 })
  await terminal.output('done\r\n')
  await terminal.output('user@host $ ')
  assert.deepEqual(await readControllerViewport(controller, agent, 'term', 10), {
    text: 'done\nuser@host $ ', lines: 2, truncated: false, state: 'running', sequence: 2,
  })
})
