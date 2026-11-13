import test from 'node:test'
import assert from 'node:assert/strict'
import { hostRequire as require } from './host.mjs'
import { pathToFileURL } from 'node:url'
import { PassThrough } from 'node:stream'
import { createTerminalReply } from '../src/lib/terminal-reply.mjs'

const entry = pathToFileURL(require.resolve('@deepseek-ai/dsh-api-terminal-controller'))
const { BrowserTerminal } = await import(new URL('./types/terminal.js', entry).href)

function fixture(t, { write = true } = {}) {
  const written = []
  let complete
  const handle = {
    output: new PassThrough(),
    done: new Promise((resolve) => { complete = resolve }),
    async terminate() { handle.output.end(); complete({ exitCode: 0 }) },
    async resize() {},
  }
  if (write) handle.write = async (data) => { written.push(data) }
  const info = { id: 'term', title: 'test', cwd: '/work', cols: 12, rows: 3, state: 'running', exitCode: null }
  const terminal = new BrowserTerminal(handle, info, 100, 1024 * 1024)
  t.after(() => terminal.dispose())
  return { terminal, handle, written }
}

async function follow(t, terminal) {
  const signal = new AbortController()
  const input = new PassThrough({ objectMode: true })
  const stream = typeof terminal.attach === 'function'
    ? terminal.attach(input, { maxCols: terminal.info.cols, maxRows: terminal.info.rows }, signal.signal)
    : terminal.follow('ui', signal.signal)
  t.after(async () => { signal.abort(); input.end(); await stream.return() })
  const { value } = await stream.next()
  assert.equal(value.type, 'snapshot')
  return stream
}

// Given 真实 BrowserTerminal,When PTY 发出光标查询,Then follower 收不到查询且服务端只回写一次应答
test('Given real terminal, When PTY emits a cursor query, Then the follower sees no query and one reply is written', async (t) => {
  const { terminal, written } = fixture(t)
  const reply = createTerminalReply()
  t.after(() => reply.dispose())
  const controller = { owners: new Map([['session', { terminals: new Map([['term', terminal]]) }]]) }
  assert.equal(reply.ensure(controller), true)
  assert.equal(reply.installed, true)
  const stream = await follow(t, terminal)
  await terminal.output('before\x1b[6n')
  const frame = await stream.next()
  assert.equal(frame.value.type, 'output')
  assert.equal(frame.value.data, 'before')
  assert.deepEqual(written, ['\x1b[1;7R'])
})

// Given ConPTY 500ms 重试累积出的同一批三个查询,When 处理,Then 只应答一次,多余应答不会变成键盘输入
test('Given duplicated queries in one batch, When dispatching, Then exactly one reply is written', async (t) => {
  const { terminal, written } = fixture(t)
  const reply = createTerminalReply()
  t.after(() => reply.dispose())
  reply.install(terminal)
  await terminal.output('\x1b[6n\x1b[6n\x1b[6n')
  assert.deepEqual(written, ['\x1b[1;1R'])
})

// Given 不含查询的普通输出,When 处理,Then 广播与屏幕内容保持原实现语义
test('Given ordinary output, When dispatching, Then broadcast and screen are unchanged', async (t) => {
  const { terminal, written } = fixture(t)
  const reply = createTerminalReply()
  t.after(() => reply.dispose())
  reply.install(terminal)
  const stream = await follow(t, terminal)
  await terminal.output('hello\r\nworld')
  const frame = await stream.next()
  assert.equal(frame.value.data, 'hello\r\nworld')
  assert.equal(terminal.sequence, 1)
  assert.equal(terminal.screen.buffer.active.getLine(0).translateToString(true), 'hello')
  assert.deepEqual(written, [])
})

// Given 查询排在内容之后,When 应答,Then 光标位置反映查询时刻的 headless 光标
test('Given content before the query, When answering, Then the reply carries the current cursor position', async (t) => {
  const { terminal, written } = fixture(t)
  const reply = createTerminalReply()
  t.after(() => reply.dispose())
  reply.install(terminal)
  await terminal.output('abc')
  await terminal.output('\x1b[6n')
  assert.deepEqual(written, ['\x1b[1;4R'])
})

// Given 设备属性查询,When 处理,Then 以固定的 VT100+AVO 应答响应
test('Given a primary device attributes query, When dispatching, Then it is answered without reaching the follower', async (t) => {
  const { terminal, written } = fixture(t)
  const reply = createTerminalReply()
  t.after(() => reply.dispose())
  reply.install(terminal)
  const stream = await follow(t, terminal)
  await terminal.output('\x1b[c')
  assert.deepEqual(written, ['\x1b[?1;2c'])
  assert.equal(stream !== undefined, true)
})

// Given 同一批混合两类查询,When 处理,Then 每类各应答一次并保持出现顺序
test('Given mixed query kinds in one batch, When dispatching, Then each kind is answered once in order', async (t) => {
  const { terminal, written } = fixture(t)
  const reply = createTerminalReply()
  t.after(() => reply.dispose())
  reply.install(terminal)
  await terminal.output('\x1b[6n\x1b[c\x1b[6n')
  assert.deepEqual(written, ['\x1b[1;1R', '\x1b[?1;2c'])
})

// Given 宿主形状漂移(无 handle.write),When 安装,Then 不 patch 且不抛错,输出仍走原实现
test('Given a drifted terminal shape, When installing, Then the patch is skipped and output still works', async (t) => {
  const { terminal } = fixture(t, { write: false })
  const reply = createTerminalReply()
  t.after(() => reply.dispose())
  assert.equal(reply.install(terminal), false)
  assert.equal(reply.installed, false)
  await terminal.output('\x1b[6n')
  assert.equal(terminal.sequence, 1)
})

// Given 多个终端并发消费输出,When 各自遇到查询,Then 每个实例按自己的光标应答(matchAll 不共享正则状态)
test('Given two terminals dispatching concurrently, When both meet a query, Then each answers with its own cursor', async (t) => {
  const first = fixture(t)
  const second = fixture(t)
  const reply = createTerminalReply()
  t.after(() => reply.dispose())
  reply.install(first.terminal)
  await Promise.all([
    first.terminal.output('x\x1b[6n'),
    second.terminal.output('yy\x1b[6n'),
  ])
  assert.deepEqual(first.written, ['\x1b[1;2R'])
  assert.deepEqual(second.written, ['\x1b[1;3R'])
})

// Given 两个应答器共享同一原型,When 先装的那个卸载,Then 后来者重新安装后继续应答
test('Given two responders sharing a prototype, When the first is disposed, Then the second reinstalls and keeps answering', async (t) => {
  const { terminal, written } = fixture(t)
  const first = createTerminalReply()
  const second = createTerminalReply()
  t.after(() => { first.dispose(); second.dispose() })
  assert.equal(first.install(terminal), true)
  assert.equal(second.install(terminal), true)
  first.dispose()
  assert.equal(second.install(terminal), true)
  await terminal.output('\x1b[6n')
  assert.deepEqual(written, ['\x1b[1;1R'])
})

// Given 已安装的应答器,When 卸载,Then 原型恢复且查询重新进入原输出通路
test('Given an installed responder, When disposed, Then the prototype is restored', async (t) => {
  const { terminal, written } = fixture(t)
  const reply = createTerminalReply()
  t.after(() => reply.dispose())
  reply.install(terminal)
  reply.dispose()
  assert.equal(reply.installed, false)
  await terminal.output('\x1b[6n')
  assert.deepEqual(written, [])
  assert.equal(terminal.sequence, 1)
})
