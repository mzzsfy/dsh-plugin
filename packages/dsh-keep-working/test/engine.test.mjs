import { test } from 'node:test'
import assert from 'node:assert/strict'

import { resolveConfig } from '../src/config.mjs'
import { createEngine } from '../src/engine.mjs'

const TURN = 1
const START_TIME = 1_000_000

const event = (seq, type, data) => ({ seq, time: seq, type, data })

const turnStart = (seq, turn, reason) =>
  event(seq, 'turn/start', reason === undefined ? { turn } : { turn, reason })

const turnEnd = (seq, turn, reason) => event(seq, 'turn/end', { turn, reason })

const assistant = (seq, turn, text) =>
  event(seq, 'assistant/message', {
    turn,
    step: 1,
    message: { role: 'assistant', content: [{ type: 'text', text }] },
    stream: [],
  })

const toolCall = (seq, turn, name) =>
  event(seq, 'tool/call', { turn, step: 1, callId: `c-${seq}`, name, arguments: '{}' })

const presented = (seq, turn) =>
  event(seq, 'deliverables/presented', { turn, callId: `c-${seq}`, files: [{ path: 'out.md' }] })

const userMessage = (seq, kind = 'user', id = `m-${seq}`) =>
  event(seq, 'user/message', { id, source: { kind }, content: [{ type: 'text', text: 'go' }] })

function createFakeTimers(clock) {
  let next = 0
  const pending = new Map()
  return {
    setTimeout(fn, ms) {
      const id = (next += 1)
      pending.set(id, { fn, at: clock() + ms })
      return id
    },
    clearTimeout(id) {
      pending.delete(id)
    },
    flush() {
      const jobs = [...pending.entries()].sort((left, right) => left[1].at - right[1].at)
      pending.clear()
      for (const [, job] of jobs) job.fn()
    },
    count: () => pending.size,
  }
}

function createHarness({ origin, header, config: overrides, probe } = {}) {
  let time = START_TIME
  const events = []
  const sent = []
  const handlers = new Map()
  const timers = createFakeTimers(() => time)
  const session = { id: 's1', header: header ?? (origin === undefined ? {} : { origin }), snapshotEvents: () => events }
  const agent = {
    id: 's1',
    session,
    inbox: { nextTurn: [] },
    followup: (message) => sent.push(message),
  }
  const ctx = {
    agents: {
      get: (id) => (id === 's1' ? agent : undefined),
      list: () => [agent],
    },
    logger: { info() {}, warn() {} },
    on: (name, handler) => {
      handlers.set(name, handler)
      return () => handlers.delete(name)
    },
  }
  const engine = createEngine({
    ctx,
    config: resolveConfig(overrides),
    timers,
    now: () => time,
    createUserMessage: (options) => ({ id: `auto-${sent.length + 1}`, ...options }),
    probe,
  })
  engine.attach()
  const emit = (item) => {
    events.push(item)
    handlers.get('session/event')?.(session, item)
  }
  return {
    engine,
    emit,
    sent,
    timers,
    session,
    advanceTo: (value) => {
      time = value
    },
    now: () => time,
  }
}

const textOf = (message) => message.content.map((block) => block.text).join('')

test('S1 有文件写入且无 present:登记一次并发送结案提醒', () => {
  const h = createHarness()
  h.emit(turnStart(0, TURN))
  h.emit(userMessage(1))
  h.emit(toolCall(2, TURN, 'write'))
  h.emit(assistant(3, TURN, '改好了'))
  h.emit(turnEnd(4, TURN, { kind: 'completed' }))
  assert.equal(h.timers.count(), 1)
  h.timers.flush()
  assert.equal(h.sent.length, 1)
  assert.match(textOf(h.sent[0]), /TASK_DONE/)
})

test('S2 末行 TASK_DONE:不发送', () => {
  const h = createHarness()
  h.emit(turnStart(0, TURN))
  h.emit(userMessage(1))
  h.emit(assistant(2, TURN, '结论\n(TASK_DONE)'))
  h.emit(turnEnd(3, TURN, { kind: 'completed' }))
  assert.equal(h.timers.count(), 0)
  h.timers.flush()
  assert.equal(h.sent.length, 0)
})

test('S3 子会话:不发送', () => {
  const h = createHarness({ origin: 'subagent' })
  h.emit(turnStart(0, TURN))
  h.emit(userMessage(1))
  h.emit(assistant(2, TURN, '没结案'))
  h.emit(turnEnd(3, TURN, { kind: 'completed' }))
  assert.equal(h.timers.count(), 0)
})

test('S3b 旧格式子会话(parentSession + delegationDepth):不发送;普通 fork 照常', () => {
  for (const header of [
    { parentSession: 'root', delegationDepth: 1 },
    { parentSession: 'root', delegationDepth: 2 },
  ]) {
    const h = createHarness({ header })
    h.emit(turnStart(0, TURN))
    h.emit(userMessage(1))
    h.emit(assistant(2, TURN, '没结案'))
    h.emit(turnEnd(3, TURN, { kind: 'completed' }))
    assert.equal(h.timers.count(), 0)
  }
  const fork = createHarness({ header: { parentSession: 'root', delegationDepth: 0 } })
  fork.emit(turnStart(0, TURN))
  fork.emit(userMessage(1))
  fork.emit(assistant(2, TURN, '没结案'))
  fork.emit(turnEnd(3, TURN, { kind: 'completed' }))
  assert.ok(fork.timers.count() > 0, 'depth 0 是普通 fork,不得按子会话跳过')
})

test('S4 连续上限:达到 maxConsecutive 后不再发送', () => {
  const h = createHarness({ config: { maxConsecutive: 2 } })
  const run = (seq) => {
    h.emit(turnStart(seq, TURN + 1))
    h.emit(userMessage(seq + 1))
    h.emit(assistant(seq + 2, TURN + 1, '没结案'))
    h.emit(turnEnd(seq + 3, TURN + 1, { kind: 'completed' }))
    h.timers.flush()
  }
  run(0)
  assert.equal(h.sent.length, 1)
  h.advanceTo(h.now() + 60_000)
  run(10)
  assert.equal(h.sent.length, 2)
  h.advanceTo(h.now() + 600_000)
  run(20)
  assert.equal(h.sent.length, 2)
})

test('S4b 正常结案清零连续计数:封顶后仍可再次恢复', () => {
  const h = createHarness({ config: { maxConsecutive: 2 } })
  const run = (seq, turn, text = '没结案') => {
    h.emit(turnStart(seq, turn))
    h.emit(userMessage(seq + 1))
    h.emit(assistant(seq + 2, turn, text))
    h.emit(turnEnd(seq + 3, turn, { kind: 'completed' }))
    h.timers.flush()
  }
  run(0, 1)
  h.advanceTo(h.now() + 60_000)
  run(10, 2)
  assert.equal(h.sent.length, 2)
  h.advanceTo(h.now() + 600_000)
  run(20, 3)
  assert.equal(h.sent.length, 2, '达到上限后不再发送')
  run(30, 4, '结论\n(TASK_DONE)')
  assert.equal(h.sent.length, 2, '结案本身不发送')
  h.advanceTo(h.now() + 600_000)
  run(40, 5)
  assert.equal(h.sent.length, 3, '结案已清零计数,下一轮重新获得额度')
})

test('S5 用户中途插话:让路,不发送', () => {
  const h = createHarness()
  h.emit(turnStart(0, TURN))
  h.emit(userMessage(1))
  h.emit(assistant(2, TURN, '先看看'))
  h.emit(userMessage(3, 'user'))
  h.emit(assistant(4, TURN, '好的'))
  h.emit(turnEnd(5, TURN, { kind: 'completed' }))
  assert.equal(h.timers.count(), 0)
})

test('S6 可重试错误:发送继续文案', () => {
  const h = createHarness()
  h.emit(turnStart(0, TURN))
  h.emit(userMessage(1))
  h.emit(turnEnd(2, TURN, { kind: 'error', error: { code: 'UPSTREAM', message: 'bad gateway', status: 502 } }))
  h.timers.flush()
  assert.equal(h.sent.length, 1)
  assert.match(textOf(h.sent[0]), /结果未知/)
})

test('S7 永久错误:不发送', () => {
  const h = createHarness()
  h.emit(turnStart(0, TURN))
  h.emit(userMessage(1))
  h.emit(turnEnd(2, TURN, { kind: 'error', error: { code: 'AUTH', message: 'invalid api key' } }))
  assert.equal(h.timers.count(), 0)
})

test('S8 max-tokens:发送截断文案', () => {
  const h = createHarness()
  h.emit(turnStart(0, TURN))
  h.emit(userMessage(1))
  h.emit(turnEnd(2, TURN, { kind: 'max-tokens' }))
  h.timers.flush()
  assert.equal(h.sent.length, 1)
  assert.match(textOf(h.sent[0]), /输出上限/)
})

test('S9 interrupted:发送重启文案', () => {
  const h = createHarness()
  h.emit(turnStart(0, TURN))
  h.emit(userMessage(1))
  h.emit(turnEnd(2, TURN, { kind: 'interrupted' }))
  h.timers.flush()
  assert.equal(h.sent.length, 1)
  assert.match(textOf(h.sent[0]), /结果未知/)
})

test('S10 用户取消:不发送', () => {
  const h = createHarness()
  h.emit(turnStart(0, TURN))
  h.emit(userMessage(1))
  h.emit(turnEnd(2, TURN, { kind: 'aborted', reason: { kind: 'user' } }))
  assert.equal(h.timers.count(), 0)
})

test('S11 宿主重启取消:按 interrupted 恢复', () => {
  const h = createHarness()
  h.emit(turnStart(0, TURN))
  h.emit(userMessage(1))
  h.emit(turnEnd(2, TURN, { kind: 'aborted', reason: { kind: 'disposed' } }))
  h.timers.flush()
  assert.equal(h.sent.length, 1)
})

test('S12 维护轮:不发送', () => {
  const h = createHarness()
  h.emit(turnStart(0, TURN, 'message-ops'))
  h.emit(assistant(1, TURN, '压缩完成'))
  h.emit(turnEnd(2, TURN, { kind: 'completed' }))
  assert.equal(h.timers.count(), 0)
})

test('S13 宽限期内开启新回合:取消待发送', () => {
  const h = createHarness()
  h.emit(turnStart(0, TURN))
  h.emit(userMessage(1))
  h.emit(assistant(2, TURN, '没结案'))
  h.emit(turnEnd(3, TURN, { kind: 'completed' }))
  assert.equal(h.timers.count(), 1)
  h.emit(turnStart(4, TURN + 1))
  assert.equal(h.timers.count(), 0)
})

test('S14 非用户发起回合:不发送结案提醒', () => {
  const h = createHarness()
  h.emit(turnStart(0, TURN))
  h.emit(userMessage(1, 'goal'))
  h.emit(assistant(2, TURN, '没结案'))
  h.emit(turnEnd(3, TURN, { kind: 'completed' }))
  assert.equal(h.timers.count(), 0)
})

test('S15 无可见输出的回合:发送 silent 文案', () => {
  const h = createHarness()
  h.emit(turnStart(0, TURN))
  h.emit(userMessage(1))
  h.emit(turnEnd(2, TURN, { kind: 'completed' }))
  h.timers.flush()
  assert.equal(h.sent.length, 1)
  assert.match(textOf(h.sent[0]), /没有可见输出/)
})

test('S17 present 之后又写文件:仍需提醒', () => {
  const h = createHarness()
  h.emit(turnStart(0, TURN))
  h.emit(userMessage(1))
  h.emit(toolCall(2, TURN, 'write'))
  h.emit(presented(3, TURN))
  h.emit(toolCall(4, TURN, 'edit'))
  h.emit(assistant(5, TURN, '又改了'))
  h.emit(turnEnd(6, TURN, { kind: 'completed' }))
  assert.equal(h.timers.count(), 1)
  h.timers.flush()
  assert.equal(h.sent.length, 1)
})

test('S16 自己发出的消息不算用户接管', () => {
  const h = createHarness()
  h.emit(turnStart(0, TURN))
  h.emit(userMessage(1))
  h.emit(assistant(2, TURN, '没结案'))
  h.emit(turnEnd(3, TURN, { kind: 'completed' }))
  h.timers.flush()
  const autoId = h.sent[0].id

  h.advanceTo(h.now() + 60_000)
  h.emit(turnStart(4, TURN + 1))
  h.emit(userMessage(5, 'user', autoId))
  h.emit(assistant(6, TURN + 1, '仍然没结案'))
  h.emit(turnEnd(7, TURN + 1, { kind: 'completed' }))
  h.timers.flush()
  assert.equal(h.sent.length, 2)
})

test('卸载后不再响应事件', () => {
  const h = createHarness()
  h.engine.dispose()
  h.emit(turnStart(0, TURN))
  h.emit(userMessage(1))
  h.emit(turnEnd(2, TURN, { kind: 'max-tokens' }))
  assert.equal(h.timers.count(), 0)
})

test('离线时挂起,联网后补发', async () => {
  let online = false
  const h = createHarness({ probe: async () => online })
  h.emit(turnStart(0, TURN))
  h.emit(userMessage(1))
  h.emit(turnEnd(2, TURN, { kind: 'max-tokens' }))
  h.timers.flush()
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(h.sent.length, 0)
  assert.equal(h.timers.count(), 1)

  online = true
  h.timers.flush()
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(h.sent.length, 1)
})

test('离线探测抛错时按在线处理', async () => {
  const h = createHarness({
    probe: async () => {
      throw new Error('probe failed')
    },
  })
  h.emit(turnStart(0, TURN))
  h.emit(userMessage(1))
  h.emit(turnEnd(2, TURN, { kind: 'max-tokens' }))
  h.timers.flush()
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(h.sent.length, 1)
})
