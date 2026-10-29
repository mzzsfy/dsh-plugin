import test from 'node:test'
import assert from 'node:assert/strict'
import { PassThrough } from 'node:stream'
import { pathToFileURL } from 'node:url'
import { createPumpFactory } from '../src/lib/attach-pump.mjs'
import { createTerminalTool } from '../src/lib/tool.mjs'
import { waitForScreenText } from '../src/lib/wait-screen.mjs'
import { readControllerViewport } from '../src/lib/private-screen.mjs'
import { hostRequire, defineTool } from './host.mjs'

const entry = pathToFileURL(hostRequire.resolve('@deepseek-ai/dsh-api-terminal-controller'))
const { default: Controller } = await import(entry.href)
const { BrowserTerminal } = await import(new URL('./types/terminal.js', entry).href)
// 旧根桥没有 attach 协议;这些集成场景须在支持 attach 的真实宿主运行。
const attachHost = { skip: typeof BrowserTerminal.prototype.attach !== 'function' ? 'Controller lacks attach; verified with rc4 host runner' : false }
const agent = { id: 'session', session: { id: 'session' } }
const deferred = () => Promise.withResolvers()
const turn = () => new Promise((resolve) => setImmediate(resolve))
async function bounded(promise) {
  let timer
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('operation did not settle')), 300) })]) }
  finally { clearTimeout(timer) }
}
function captured(t) {
  const inputs = []
  const signals = []
  const attachment = { attach(input, _config, signal) {
    const iterator = input[Symbol.asyncIterator]()
    inputs.push(iterator)
    signals.push(signal)
    return (async function* () { await new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true })) })()
  } }
  const factory = createPumpFactory({ terminal: () => attachment, config: {} })
  t.after(() => factory.dispose())
  return { factory, pump: factory.for(agent, 'term'), inputs, signals }
}

// PUMP-RETURN：挂起 next 时 return 必须结束读；已排队帧随关闭丢弃。
test('Given a pending input next, When return is called, Then the read wakes done', async (t) => {
  const { pump, inputs } = captured(t)
  void pump.write('warm').catch(() => {})
  await inputs[0].next()
  const pending = inputs[0].next()
  await inputs[0].return()
  assert.equal((await bounded(pending)).done, true)
})
test('Given queued input, When return is called, Then stale queued writes are discarded', async (t) => {
  const { pump, inputs } = captured(t)
  void pump.write('queued').catch(() => {})
  await inputs[0].return()
  assert.equal((await bounded(inputs[0].next())).done, true)
})
test('Given old pending next, When stop and restart occur, Then the old iterator cannot read the new lifetime', async (t) => {
  const { pump, inputs } = captured(t)
  void pump.write('old').catch(() => {})
  await inputs[0].next()
  const pending = inputs[0].next()
  pump.stop()
  void pump.write('new').catch(() => {})
  assert.equal((await bounded(pending)).done, true)
  assert.equal((await inputs[1].next()).value.sequence, 1)
})
test('Given an unacknowledged write, When factory disposes, Then it rejects immediately without reacquiring', async (t) => {
  const { factory, pump, inputs } = captured(t)
  const pending = pump.write('queued')
  const rejected = assert.rejects(pending, /disposed/i)
  factory.dispose()
  await bounded(rejected)
  assert.equal(inputs.length, 1)
  await assert.rejects(pump.write('late'), /disposed/i)
  assert.throws(() => factory.for(agent, 'term'), /disposed/i)
})
test('Given an evicted pump reference, When writing again, Then that reference is permanently disposed', async (t) => {
  const { factory, pump } = captured(t)
  factory.evict(agent, 'term')
  await bounded(assert.rejects(pump.write('late'), /disposed/i))
  assert.notEqual(factory.for(agent, 'term'), pump)
})
test('Given a pre-aborted write, When invoking pump, Then no attachment or frame is created', async (t) => {
  const { pump, inputs } = captured(t)
  await bounded(assert.rejects(pump.write('cancelled', AbortSignal.abort()), { name: 'AbortError' }))
  assert.equal(inputs.length, 0)
})
test('Given queued write, When its signal aborts, Then it rejects and its input is discarded without retry', async (t) => {
  const { pump, inputs } = captured(t)
  const abort = new AbortController()
  const pending = pump.write('cancelled', abort.signal)
  const rejected = assert.rejects(pending, { name: 'AbortError' })
  abort.abort()
  await bounded(rejected)
  assert.equal((await bounded(inputs[0].next())).done, true)
  assert.equal(inputs.length, 1)
})

for (const state of ['found', 'exited', 'skipped']) {
  test(`Given read in flight with ${state}, When turn aborts before read completes, Then abort wins`, async () => {
    const read = deferred()
    const abort = new AbortController()
    const skip = new AbortController()
    const pending = waitForScreenText({ readScreen: () => read.promise, needle: 'ready', timeoutMs: 5000, signal: abort.signal, skipSignal: skip.signal })
    abort.abort()
    skip.abort()
    read.resolve({ text: state === 'found' ? 'ready' : '', state: state === 'exited' ? 'exited' : 'running' })
    await assert.rejects(pending, { name: 'AbortError' })
  })
}
test('Given a long polling sleep, When turn aborts, Then cancellation wakes the wait', async () => {
  const read = deferred()
  const abort = new AbortController()
  const pending = waitForScreenText({ readScreen: () => { read.resolve(); return { text: '', state: 'running' } }, needle: 'ready', timeoutMs: 5000, intervalMs: 1000, signal: abort.signal })
  await read.promise
  await turn()
  const rejected = assert.rejects(pending, { name: 'AbortError' })
  abort.abort()
  await bounded(rejected)
})

function realFixture(t) {
  const output = new PassThrough()
  const done = deferred()
  const writes = []
  const handle = { output, done: done.promise, async terminate() { output.end(); done.resolve({ exitCode: 0 }) }, async write(text) { writes.push(text) }, async resize() {} }
  const terminal = new BrowserTerminal(handle, { id: 'term', cols: 12, rows: 3, title: 'test', cwd: '/work', state: 'running' }, 100, 1024 * 1024)
  const controller = Object.create(Controller.prototype)
  controller.config = { maxInputBytes: 1024, maxCols: 100, maxRows: 100 }
  const owner = { terminals: new Map([['term', terminal]]), pending: new Map(), allocations: new Map(), closedIds: new Set() }
  controller.owners = new Map([['session', owner]])
  const factory = createPumpFactory(controller)
  const tool = createTerminalTool({ controller, pumpFactory: factory, defineTool, readScreen: async () => ({}) })
  const terminate = handle.terminate
  t.after(async () => { factory.dispose(); handle.terminate = terminate; await terminal.dispose() })
  return { terminal, controller, owner, factory, handle, writes, tool }
}
test('Given real BrowserTerminal pending input, When the attachment aborts, Then host command cleanup joins', attachHost, async (t) => {
  const { terminal, factory } = realFixture(t)
  const original = terminal.attach.bind(terminal)
  const cleanup = deferred()
  terminal.attach = async function* (...args) { try { yield* original(...args) } finally { cleanup.resolve() } }
  await factory.for(agent, 'term').write('warm')
  factory.dispose()
  await bounded(cleanup.promise)
  assert.equal(terminal.followers.size, 0)
})
test('Given real BrowserTerminal write awaiting provider, When disposed, Then pending rejects before provider returns and never retries', attachHost, async (t) => {
  const { factory, handle, writes } = realFixture(t)
  const started = deferred()
  const release = deferred()
  handle.write = async (text) => { writes.push(text); started.resolve(); await release.promise }
  const pending = factory.for(agent, 'term').write('already-dispatched')
  const rejected = assert.rejects(pending, /disposed/i)
  await started.promise
  factory.dispose()
  try { await bounded(rejected) } finally { release.resolve() }
  await turn()
  assert.deepEqual(writes, ['already-dispatched'])
})
test('P1 Given B already dispatched, When concurrent A aborts, Then B is never replayed', attachHost, async (t) => {
  const { factory, handle, writes } = realFixture(t)
  const started = deferred(), release = deferred()
  handle.write = async (text) => { writes.push(text); started.resolve(); await release.promise }
  const pump = factory.for(agent, 'term'), cancel = new AbortController()
  const b = pump.write('B')
  const bRejected = assert.rejects(b, { code: 'terminal/write-unknown' })
  await started.promise
  const a = pump.write('A', cancel.signal)
  const aRejected = assert.rejects(a, { name: 'AbortError' })
  cancel.abort()
  try { await bounded(aRejected) } finally { release.resolve() }
  await bounded(bRejected)
  await turn()
  assert.deepEqual(writes, ['B'])
})

test('T3 Given real terminal queue blocked, When turn aborts, Then wait rejects before provider queue releases', attachHost, async (t) => {
  const { terminal, controller } = realFixture(t)
  const release = deferred(), started = deferred()
  const blocked = terminal.enqueue(async () => { started.resolve(); await release.promise })
  await started.promise
  const abort = new AbortController()
  const pending = waitForScreenText({ readScreen: readControllerViewport, controller, agent, id: 'term', needle: 'never', timeoutMs: 5000, signal: abort.signal })
  const rejected = assert.rejects(pending, { name: 'AbortError' })
  abort.abort()
  try { await bounded(rejected) } finally { release.resolve(); await blocked; await rejected }
})

test('Given real failed close with warm pump, When writing closed identity, Then unavailable and no after-closed input while close stays retryable', attachHost, async (t) => {
  const { factory, tool, handle, writes, owner, controller } = realFixture(t)
  const pump = factory.for(agent, 'term')
  await pump.write('warm')
  const terminate = handle.terminate
  handle.terminate = async () => { throw new Error('terminate failed') }
  const result = await tool.execute({ action: 'close', terminal_id: 'term' }, { agent })
  assert.equal(result.ok, false)
  assert.equal(owner.closedIds.has('term'), true)
  assert.throws(() => controller.terminal(agent, 'term'), { code: 'terminal/unavailable' })
  const write = await tool.execute({ action: 'write', terminal_id: 'term', text: 'after-closed' }, { agent })
  assert.equal(write.error?.code, 'TERMINAL_UNAVAILABLE')
  assert.deepEqual(writes, ['warm'])
  await assert.rejects(pump.write('old-reference'), /disposed/i)
  handle.terminate = terminate
  assert.equal((await tool.execute({ action: 'close', terminal_id: 'term' }, { agent })).ok, true)
})
test('Given real warm pump and externally closed identity, When writing, Then Controller lookup prevents stale reuse', attachHost, async (t) => {
  const { factory, owner, writes } = realFixture(t)
  const pump = factory.for(agent, 'term')
  await pump.write('warm')
  owner.closedIds.add('term')
  await assert.rejects(pump.write('after-closed'), { code: 'terminal/unavailable' })
  assert.deepEqual(writes, ['warm'])
})
