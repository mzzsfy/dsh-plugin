import { test } from 'node:test'
import assert from 'node:assert/strict'

import { resolveConfig } from '../src/config.mjs'
import { createEngine, MAX_SESSION_STATES } from '../src/engine.mjs'

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

const reasoningOnly = (seq, turn) =>
  event(seq, 'assistant/message', {
    turn,
    step: 1,
    message: { role: 'assistant', content: [{ type: 'reasoning', text: '还在想' }] },
    stream: [],
  })

const toolCall = (seq, turn, name, args = '{}') =>
  event(seq, 'tool/call', { turn, step: 1, callId: `c-${seq}`, name, arguments: args })

const presented = (seq, turn) =>
  event(seq, 'deliverables/presented', { turn, callId: `c-${seq}`, files: [{ path: 'out.md' }] })

const userMessage = (seq, kind = 'user', id = `m-${seq}`) =>
  event(seq, 'user/message', { id, source: { kind }, content: [{ type: 'text', text: 'go' }] })

// 宿主把排队输入写成 agent/inbox/spliced;空队列上 start=0 等价于追加
const queueAppend = (seq, target, text = '然后就修复 直到整个逻辑没有问题为止') =>
  event(seq, 'agent/inbox/spliced', {
    target,
    start: 0,
    inserted: [{ id: `q-${seq}`, source: { kind: 'user' }, content: [{ type: 'text', text }] }],
  })

const contextAppend = (seq) =>
  event(seq, 'agent/inbox/spliced', {
    target: 'next-step',
    start: 0,
    inserted: [
      { id: `c-${seq}`, source: { kind: 'runtime-context' }, content: [{ type: 'text', text: '上下文' }] },
    ],
  })

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
    nextAt() {
      return [...pending.values()].map((job) => job.at).sort((left, right) => left - right)[0]
    },
    count: () => pending.size,
  }
}

function createHarness({ origin, header, config: overrides, probe, observe, onObserve, goals, archived = [] } = {}) {
  let time = START_TIME
  const events = []
  const sent = []
  const steered = []
  const handlers = new Map()
  const timers = createFakeTimers(() => time)
  // 故意不提供 deprecated 的 snapshotEvents:实时判定必须走 sessionQuery 观察面
  const session = { id: 's1', header: header ?? (origin === undefined ? {} : { origin }), events }
  const agent = {
    id: 's1',
    session,
    inbox: { nextTurn: [] },
    followup: (message) => sent.push(message),
    steer: (message) => steered.push(message),
  }
  const query = {
    observeSession: async (id, options) => {
      onObserve?.(id, options)
      if (observe !== undefined) return observe(id, options, events)
      return { header: session.header, events: [...events], [Symbol.dispose]() {} }
    },
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
    get: (name) => {
      if (name === 'sessionQuery') return query
      if (name === 'goals') return goals
      if (name === 'workspaceRegistry') return { archivedSessionIds: archived }
      return undefined
    },
  }
  const engine = createEngine({
    ctx,
    config: resolveConfig(overrides),
    timers,
    now: () => time,
    createUserMessage: (options) => ({ id: `auto-${sent.length + steered.length + 1}`, ...options }),
    probe,
  })
  engine.attach()
  const emit = (item) => {
    events.push(item)
    return handlers.get('session/event')?.(session, item)
  }
  // 插件 followup 启动的回合,首条 user/message 就是它投递的那条;
  // 夹具按真实事件序复用它,human=true 才模拟真人新回合
  const runTurn = async (seq, turn, text = '没结案', { human = false } = {}) => {
    await emit(turnStart(seq, turn))
    const lastId = sent.at(-1)?.id
    await emit(userMessage(seq + 1, 'user', human || lastId === undefined ? `m-${seq + 1}` : lastId))
    await emit(assistant(seq + 2, turn, text))
    await emit(turnEnd(seq + 3, turn, { kind: 'completed' }))
    timers.flush()
  }
  return {
    engine,
    emit,
    sent,
    steered,
    timers,
    runTurn,
    session,
    query,
    advanceTo: (value) => {
      time = value
    },
    now: () => time,
  }
}

const textOf = (message) => message.content.map((block) => block.text).join('')

test('S1 有文件写入且无 present:登记一次并发送结案提醒', async () => {
  const h = createHarness()
  h.emit(turnStart(0, TURN))
  h.emit(userMessage(1))
  h.emit(toolCall(2, TURN, 'write'))
  h.emit(assistant(3, TURN, '改好了'))
  await h.emit(turnEnd(4, TURN, { kind: 'completed' }))
  assert.equal(h.timers.count(), 1)
  h.timers.flush()
  assert.equal(h.sent.length, 1)
  assert.match(textOf(h.sent[0]), /TASK_DONE/)
})

test('S2 末行 TASK_DONE:不发送', async () => {
  const h = createHarness()
  h.emit(turnStart(0, TURN))
  h.emit(userMessage(1))
  h.emit(assistant(2, TURN, '结论\nTASK_DONE'))
  await h.emit(turnEnd(3, TURN, { kind: 'completed' }))
  assert.equal(h.timers.count(), 0)
  h.timers.flush()
  assert.equal(h.sent.length, 0)
})

test('S2c 任何写入后标记结案:仍提醒', async () => {
  const h = createHarness()
  h.emit(turnStart(0, TURN))
  h.emit(userMessage(1))
  h.emit(toolCall(2, TURN, 'write', JSON.stringify({ file_path: 'C:/tmp/restart-watchdog.ps1' })))
  h.emit(assistant(3, TURN, '完成\nTASK_DONE'))
  await h.emit(turnEnd(4, TURN, { kind: 'completed' }))
  assert.equal(h.timers.count(), 1)
  h.timers.flush()
  assert.equal(h.sent.length, 1)
})

test('S2d enforceClosure 关闭:正常结束即结案,不补结案提醒', async () => {
  const h = createHarness({ config: { enforceClosure: false } })
  h.emit(turnStart(0, TURN))
  h.emit(userMessage(1))
  h.emit(assistant(2, TURN, '结论如上,没有标记'))
  await h.emit(turnEnd(3, TURN, { kind: 'completed' }))
  assert.equal(h.timers.count(), 0)
  h.timers.flush()
  assert.equal(h.sent.length, 0)
})

test('S2e enforceClosure 关闭:写文件后没有 present 也不提醒', async () => {
  const h = createHarness({ config: { enforceClosure: false } })
  h.emit(turnStart(0, TURN))
  h.emit(userMessage(1))
  h.emit(toolCall(2, TURN, 'write'))
  h.emit(assistant(3, TURN, '改好了'))
  await h.emit(turnEnd(4, TURN, { kind: 'completed' }))
  assert.equal(h.timers.count(), 0)
  h.timers.flush()
  assert.equal(h.sent.length, 0)
})

test('S2e enforceClosure 关闭:末条只剩思考仍按空回合恢复', async () => {
  const h = createHarness({ config: { enforceClosure: false } })
  h.emit(turnStart(0, TURN))
  h.emit(userMessage(1))
  h.emit(assistant(2, TURN, '先说明在查什么'))
  h.emit(reasoningOnly(3, TURN))
  await h.emit(turnEnd(4, TURN, { kind: 'completed' }))
  h.timers.flush()
  assert.equal(h.sent.length, 1, '末步没交代就不算完成')
  assert.match(textOf(h.sent[0]), /没有可见输出/)
})

test('S2f enforceClosure 关闭:空回合仍由空回合开关决定', async () => {
  const on = createHarness({ config: { enforceClosure: false } })
  on.emit(turnStart(0, TURN))
  on.emit(userMessage(1))
  await on.emit(turnEnd(2, TURN, { kind: 'completed' }))
  on.timers.flush()
  assert.equal(on.sent.length, 1, '静默回合仍按空回合开关恢复')

  const off = createHarness({ config: { enforceClosure: false, resumeSilentTurns: false } })
  off.emit(turnStart(0, TURN))
  off.emit(userMessage(1))
  await off.emit(turnEnd(2, TURN, { kind: 'completed' }))
  assert.equal(off.timers.count(), 0)
})

test('S2g enforceClosure 关闭:present-only 回合仍算结案', async () => {
  const h = createHarness({ config: { enforceClosure: false } })
  h.emit(turnStart(0, TURN))
  h.emit(userMessage(1))
  h.emit(presented(2, TURN))
  await h.emit(turnEnd(3, TURN, { kind: 'completed' }))
  assert.equal(h.timers.count(), 0)
  h.timers.flush()
  assert.equal(h.sent.length, 0, '已交付的回合不得被当成空回合补发')
})

test('S3 子会话:不发送', async () => {
  const h = createHarness({ origin: 'subagent' })
  h.emit(turnStart(0, TURN))
  h.emit(userMessage(1))
  h.emit(assistant(2, TURN, '没结案'))
  await h.emit(turnEnd(3, TURN, { kind: 'completed' }))
  assert.equal(h.timers.count(), 0)
})

test('S3b 旧格式子会话(parentSession + delegationDepth):不发送;普通 fork 照常', async () => {
  for (const header of [
    { parentSession: 'root', delegationDepth: 1 },
    { parentSession: 'root', delegationDepth: 2 },
  ]) {
    const h = createHarness({ header })
    h.emit(turnStart(0, TURN))
    h.emit(userMessage(1))
    h.emit(assistant(2, TURN, '没结案'))
    await h.emit(turnEnd(3, TURN, { kind: 'completed' }))
    assert.equal(h.timers.count(), 0)
  }
  const fork = createHarness({ header: { parentSession: 'root', delegationDepth: 0 } })
  fork.emit(turnStart(0, TURN))
  fork.emit(userMessage(1))
  fork.emit(assistant(2, TURN, '没结案'))
  await fork.emit(turnEnd(3, TURN, { kind: 'completed' }))
  assert.ok(fork.timers.count() > 0, 'depth 0 是普通 fork,不得按子会话跳过')
})

test('S4 连续上限:达到 maxConsecutive 后不再发送', async () => {
  const h = createHarness({ config: { maxConsecutive: 2 } })
  // 回合号必须逐轮递增:turnSlice 按首个匹配回合切片,复用 id 会读到上一轮事件
  await h.runTurn(0, 1)
  assert.equal(h.sent.length, 1)
  h.advanceTo(h.now() + 60_000)
  await h.runTurn(10, 2)
  assert.equal(h.sent.length, 2)
  h.advanceTo(h.now() + 600_000)
  await h.runTurn(20, 3)
  assert.equal(h.sent.length, 2)
})

test('S4b 正常结案清零连续计数:封顶后仍可再次恢复', async () => {
  const h = createHarness({ config: { maxConsecutive: 2 } })
  const run = (seq, turn, text = '没结案') => h.runTurn(seq, turn, text)
  await run(0, 1)
  h.advanceTo(h.now() + 60_000)
  await run(10, 2)
  assert.equal(h.sent.length, 2)
  h.advanceTo(h.now() + 600_000)
  await run(20, 3)
  assert.equal(h.sent.length, 2, '达到上限后不再发送')
  await run(30, 4, '结论\nTASK_DONE')
  assert.equal(h.sent.length, 2, '结案本身不发送')
  h.advanceTo(h.now() + 600_000)
  await run(40, 5)
  assert.equal(h.sent.length, 3, '结案已清零计数,下一轮重新获得额度')
})

test('S4c 封顶后用户重新发起回合:额度恢复', async () => {
  const h = createHarness({ config: { maxConsecutive: 1 } })
  await h.runTurn(0, 1)
  assert.equal(h.sent.length, 1)
  h.advanceTo(h.now() + 60_000)
  await h.runTurn(10, 2)
  assert.equal(h.sent.length, 1, '插件自己 followup 启动的回合不得重置')
  // 封顶后用户手动开新回合:没有待消费的插件回合,视为接管
  await h.runTurn(20, 3, '没结案', { human: true })
  assert.equal(h.sent.length, 2, '用户接管后恢复一次额度')
})

test('S4d 自投递回合未真正开始:用户回合仍恢复额度', async () => {
  const h = createHarness({ config: { maxConsecutive: 1 } })
  await h.runTurn(0, 1)
  assert.equal(h.sent.length, 1)
  // followup 被宿主吞掉、没有新回合:下一轮真人回合不得被当成插件自己的回合
  h.advanceTo(h.now() + 600_000)
  await h.runTurn(10, 2, '没结案', { human: true })
  assert.equal(h.sent.length, 2)
})

test('S5 用户中途插话:回合仍未结案,照常补提醒', async () => {
  const h = createHarness()
  h.emit(turnStart(0, TURN))
  h.emit(userMessage(1))
  h.emit(assistant(2, TURN, '先看看'))
  h.emit(userMessage(3, 'user'))
  h.emit(assistant(4, TURN, '好的'))
  await h.emit(turnEnd(5, TURN, { kind: 'completed' }))
  h.timers.flush()
  assert.equal(h.sent.length, 1, '人的插话不改变回合未结案这一事实')
  assert.match(textOf(h.sent[0]), /TASK_DONE/)
})

test('S5a 插话后末条只剩思考:写入过就要 present', async () => {
  const h = createHarness()
  h.emit(turnStart(0, TURN))
  h.emit(userMessage(1))
  h.emit(toolCall(2, TURN, 'edit'))
  h.emit(userMessage(3, 'user'))
  h.emit(assistant(4, TURN, '按你说的改'))
  h.emit(reasoningOnly(5, TURN))
  await h.emit(turnEnd(6, TURN, { kind: 'completed' }))
  h.timers.flush()
  assert.equal(h.sent.length, 1)
  assert.match(textOf(h.sent[0]), /TASK_DONE/)
})

test('S5b 插话且回合无可见输出:按空回合补发', async () => {
  const h = createHarness()
  h.emit(turnStart(0, TURN))
  h.emit(userMessage(1))
  h.emit(toolCall(2, TURN, 'read'))
  h.emit(userMessage(3, 'user'))
  await h.emit(turnEnd(4, TURN, { kind: 'completed' }))
  h.timers.flush()
  assert.equal(h.sent.length, 1)
  assert.match(textOf(h.sent[0]), /没有可见输出/)
})

test('S5c 末条只剩思考:前面交代过也不算回答,写入后仍要 present', async () => {
  const h = createHarness()
  h.emit(turnStart(0, TURN))
  h.emit(userMessage(1))
  h.emit(toolCall(2, TURN, 'write'))
  h.emit(assistant(3, TURN, '先说明在改什么'))
  h.emit(reasoningOnly(4, TURN))
  await h.emit(turnEnd(5, TURN, { kind: 'completed' }))
  h.timers.flush()
  assert.equal(h.sent.length, 1)
  assert.match(textOf(h.sent[0]), /TASK_DONE/)
})

test('S5d 末条只剩思考且没写文件:按空回合补发', async () => {
  const h = createHarness()
  h.emit(turnStart(0, TURN))
  h.emit(userMessage(1))
  h.emit(assistant(2, TURN, '先说明在查什么'))
  h.emit(reasoningOnly(3, TURN))
  await h.emit(turnEnd(4, TURN, { kind: 'completed' }))
  h.timers.flush()
  assert.equal(h.sent.length, 1)
  assert.match(textOf(h.sent[0]), /没有可见输出/)
})

test('S6 可重试错误:发送继续文案', async () => {
  const h = createHarness()
  h.emit(turnStart(0, TURN))
  h.emit(userMessage(1))
  await h.emit(turnEnd(2, TURN, { kind: 'error', error: { code: 'UPSTREAM', message: 'bad gateway', status: 502 } }))
  h.timers.flush()
  assert.equal(h.sent.length, 1)
  assert.match(textOf(h.sent[0]), /结果未知/)
})

test('S6b 可重试错误但已 present:不发送', async () => {
  const h = createHarness()
  h.emit(turnStart(0, TURN))
  h.emit(userMessage(1))
  h.emit(presented(2, TURN))
  await h.emit(turnEnd(3, TURN, { kind: 'error', error: { code: 'UPSTREAM', message: 'bad gateway', status: 502 } }))
  assert.equal(h.timers.count(), 0)
  h.timers.flush()
  assert.equal(h.sent.length, 0)
})

test('S6d 网关断流包装成 INVALID_REQUEST:仍发送继续文案', async () => {
  const h = createHarness({ config: { classify: true } })
  h.emit(turnStart(0, TURN))
  h.emit(userMessage(1))
  await h.emit(
    turnEnd(2, TURN, {
      kind: 'error',
      error: {
        code: 'INVALID_REQUEST',
        message:
          "litellm.APIConnectionError: Response payload is not completed: <TransferEncodingError: 400>. ConnectionResetError(104, 'Connection reset by peer')",
      },
    }),
  )
  h.timers.flush()
  assert.equal(h.sent.length, 1)
  assert.match(textOf(h.sent[0]), /结果未知/)
})

test('S6c 墙钟回拨:冷却差值不得放大定时器延迟', async () => {
  const h = createHarness({ config: { backoffFactor: 1 } })
  await h.runTurn(0, 1, '没结案')
  h.advanceTo(h.now() + 10_000)
  await h.runTurn(10, 2, '没结案')

  // 回拨 1h:now() - lastAttemptAt 为负,负差值必须按 0 处理
  h.advanceTo(h.now() - 3_600_000)
  h.emit(turnStart(20, 3))
  h.emit(userMessage(21))
  await h.emit(turnEnd(22, 3, { kind: 'max-tokens' }))
  assert.equal(h.timers.nextAt() - h.now(), 20_000, '冷却延迟不得被负时间差放大')
  h.timers.flush()
})

test('S7 开启区分永久错误:请求结构错误不发送', async () => {
  const h = createHarness({ config: { classify: true } })
  h.emit(turnStart(0, TURN))
  h.emit(userMessage(1))
  await h.emit(turnEnd(2, TURN, { kind: 'error', error: { code: 'CONTEXT_WINDOW_EXCEEDED', message: 'context length exceeded' } }))
  assert.equal(h.timers.count(), 0)
})

test('S7c 开启区分永久错误时 AUTH 仍重试', async () => {
  const h = createHarness({ config: { classify: true } })
  h.emit(turnStart(0, TURN))
  h.emit(userMessage(1))
  await h.emit(turnEnd(2, TURN, { kind: 'error', error: { code: 'AUTH', message: 'invalid api key' } }))
  h.timers.flush()
  assert.equal(h.sent.length, 1, '鉴权失败可能只是某条上游通道')
})

test('S7b 默认不区分永久错误:上下文超限也重试', async () => {
  const h = createHarness()
  h.emit(turnStart(0, TURN))
  h.emit(userMessage(1))
  await h.emit(turnEnd(2, TURN, { kind: 'error', error: { code: 'CONTEXT_WINDOW_EXCEEDED', message: 'the request failed' } }))
  h.timers.flush()
  assert.equal(h.sent.length, 1, '默认全部重试,连续上限负责收敛')
})

test('S8 max-tokens:发送截断文案', async () => {
  const h = createHarness()
  h.emit(turnStart(0, TURN))
  h.emit(userMessage(1))
  await h.emit(turnEnd(2, TURN, { kind: 'max-tokens' }))
  h.timers.flush()
  assert.equal(h.sent.length, 1)
  assert.match(textOf(h.sent[0]), /输出上限/)
})

test('S8b max-tokens 但已 present:不发送', async () => {
  const h = createHarness()
  h.emit(turnStart(0, TURN))
  h.emit(userMessage(1))
  h.emit(presented(2, TURN))
  await h.emit(turnEnd(3, TURN, { kind: 'max-tokens' }))
  assert.equal(h.timers.count(), 0)
  h.timers.flush()
  assert.equal(h.sent.length, 0)
})

test('S9 interrupted:发送重启文案', async () => {
  const h = createHarness()
  h.emit(turnStart(0, TURN))
  h.emit(userMessage(1))
  await h.emit(turnEnd(2, TURN, { kind: 'interrupted' }))
  h.timers.flush()
  assert.equal(h.sent.length, 1)
  assert.match(textOf(h.sent[0]), /结果未知/)
})

test('S9b interrupted 即使末行 TASK_DONE:仍发送', async () => {
  const h = createHarness()
  h.emit(turnStart(0, TURN))
  h.emit(userMessage(1))
  h.emit(assistant(2, TURN, '完成\nTASK_DONE'))
  await h.emit(turnEnd(3, TURN, { kind: 'interrupted' }))
  assert.equal(h.timers.count(), 1)
  h.timers.flush()
  assert.equal(h.sent.length, 1)
  assert.match(textOf(h.sent[0]), /结果未知/)
})

test('S10 用户取消:不发送', async () => {
  const h = createHarness()
  h.emit(turnStart(0, TURN))
  h.emit(userMessage(1))
  await h.emit(turnEnd(2, TURN, { kind: 'aborted', reason: { kind: 'user' } }))
  assert.equal(h.timers.count(), 0)
})

test('S11 宿主重启取消:按 interrupted 恢复', async () => {
  const h = createHarness()
  h.emit(turnStart(0, TURN))
  h.emit(userMessage(1))
  await h.emit(turnEnd(2, TURN, { kind: 'aborted', reason: { kind: 'disposed' } }))
  h.timers.flush()
  assert.equal(h.sent.length, 1)
})

test('S11b 宿主重启取消即使末行 TASK_DONE:仍发送', async () => {
  const h = createHarness()
  h.emit(turnStart(0, TURN))
  h.emit(userMessage(1))
  h.emit(assistant(2, TURN, '完成\nTASK_DONE'))
  await h.emit(turnEnd(3, TURN, { kind: 'aborted', reason: { kind: 'disposed' } }))
  assert.equal(h.timers.count(), 1)
  h.timers.flush()
  assert.equal(h.sent.length, 1)
})

test('S11c 宿主预检拒绝(blocked):按中断补消息', async () => {
  const h = createHarness()
  h.emit(turnStart(0, TURN))
  h.emit(userMessage(1))
  h.emit(assistant(2, TURN, '做到一半'))
  await h.emit(turnEnd(3, TURN, { kind: 'blocked' }))
  h.timers.flush()
  assert.equal(h.sent.length, 1)
  assert.match(textOf(h.sent[0]), /结果未知/)
})

test('S11d blocked 但末行已结案:不发送', async () => {
  const h = createHarness()
  h.emit(turnStart(0, TURN))
  h.emit(userMessage(1))
  h.emit(assistant(2, TURN, '结论\nTASK_DONE'))
  await h.emit(turnEnd(3, TURN, { kind: 'blocked' }))
  assert.equal(h.timers.count(), 0)
  h.timers.flush()
  assert.equal(h.sent.length, 0)
})

test('S11e blocked 且目标被预检拒绝:交回 driver,不补消息', async () => {
  const resumed = []
  const goals = {
    get: () => ({ id: 'g1', revision: 3, phase: 'blocked', blockedReason: { code: 'prompt-rejected', message: 'x' } }),
    resume: (agent, ref) => resumed.push(ref),
  }
  const h = createHarness({ goals })
  h.emit(turnStart(0, TURN))
  h.emit(userMessage(1))
  await h.emit(turnEnd(2, TURN, { kind: 'blocked' }))
  assert.deepEqual(resumed, [{ id: 'g1', revision: 3 }])
  assert.equal(h.timers.count(), 0)
  h.timers.flush()
  assert.equal(h.sent.length, 0)
})

test('S11f 目标接回冷却:先补消息,冷却到点自动再接一次', async () => {
  const goal = { id: 'g1', revision: 3, phase: 'blocked', blockedReason: { code: 'prompt-rejected', message: 'x' } }
  let resumes = 0
  const goals = {
    get: () => ({ ...goal }),
    resume: () => {
      resumes += 1
    },
  }
  const h = createHarness({ goals })
  const blockedTurn = async (turn) => {
    await h.emit(turnStart(turn * 10, turn))
    await h.emit(userMessage(turn * 10 + 1))
    await h.emit(turnEnd(turn * 10 + 2, turn, { kind: 'blocked' }))
  }
  await blockedTurn(1)
  assert.equal(resumes, 1)
  assert.equal(h.sent.length, 0, '接回成功时不补消息')
  // 冷却期内再次被拒:不重复武装,但必须补消息,不能停在无人驱动的状态
  h.advanceTo(h.now() + 1_000)
  await blockedTurn(2)
  assert.equal(resumes, 1, '冷却期内不得反复重新武装')
  h.timers.flush()
  assert.equal(h.sent.length, 1, '冷却期内的 blocked 必须回落补消息')
  assert.equal(resumes, 2, '冷却到点必须自动再接一次,不等下一次阻塞事件')
})

test('S11n 目标仍由 driver 驱动:不接管也不补消息', async () => {
  const goals = {
    get: () => ({ id: 'g1', revision: 3, phase: 'active', activation: 'armed' }),
    resume: () => assert.fail('driver 已在驱动,不得重复武装'),
  }
  const h = createHarness({ goals })
  h.emit(turnStart(0, TURN))
  h.emit(userMessage(1))
  await h.emit(turnEnd(2, TURN, { kind: 'blocked' }))
  assert.equal(h.timers.count(), 0)
  assert.equal(h.sent.length, 0)
})

test('S11o goals 服务缺失:回落补消息', async () => {
  const h = createHarness()
  h.emit(turnStart(0, TURN))
  h.emit(userMessage(1))
  await h.emit(turnEnd(2, TURN, { kind: 'blocked' }))
  h.timers.flush()
  assert.equal(h.sent.length, 1)
})

test('S11p goals.get 抛错:回落补消息', async () => {
  const goals = {
    get: () => {
      throw new Error('projection failed')
    },
    resume: () => assert.fail('读不到目标时不得武装'),
  }
  const h = createHarness({ goals })
  h.emit(turnStart(0, TURN))
  h.emit(userMessage(1))
  await h.emit(turnEnd(2, TURN, { kind: 'blocked' }))
  h.timers.flush()
  assert.equal(h.sent.length, 1)
})

test('S11g 目标已暂停:不接管也不补消息', async () => {
  let resumes = 0
  const goals = {
    get: () => ({ id: 'g1', revision: 3, phase: 'paused' }),
    resume: () => {
      resumes += 1
    },
  }
  const h = createHarness({ goals })
  h.emit(turnStart(0, TURN))
  h.emit(userMessage(1))
  await h.emit(turnEnd(2, TURN, { kind: 'blocked' }))
  h.timers.flush()
  assert.equal(resumes, 0)
  assert.equal(h.sent.length, 0, '暂停是人的决定,不得补消息')
})

test('S11h 非预检拒绝的阻塞码:不接管也不补消息', async () => {
  let resumes = 0
  const goals = {
    get: () => ({ id: 'g1', revision: 3, phase: 'blocked', blockedReason: { code: 'model-reported', message: '缺凭据' } }),
    resume: () => {
      resumes += 1
    },
  }
  const h = createHarness({ goals })
  h.emit(turnStart(0, TURN))
  h.emit(userMessage(1))
  await h.emit(turnEnd(2, TURN, { kind: 'blocked' }))
  h.timers.flush()
  assert.equal(resumes, 0)
  assert.equal(h.sent.length, 0, '模型自述受阻等人处理')
})

test('S11i 全局暂停:blocked 不接回也不补消息', async () => {
  let resumes = 0
  const goals = {
    get: () => ({ id: 'g1', revision: 3, phase: 'blocked', blockedReason: { code: 'prompt-rejected', message: 'x' } }),
    resume: () => {
      resumes += 1
    },
  }
  const h = createHarness({ goals, config: { paused: true } })
  h.emit(turnStart(0, TURN))
  h.emit(userMessage(1))
  await h.emit(turnEnd(2, TURN, { kind: 'blocked' }))
  assert.equal(resumes, 0)
  assert.equal(h.timers.count(), 0)
  assert.equal(h.sent.length, 0)
})

test('S11j 子会话:blocked 不接回目标', async () => {
  let resumes = 0
  const goals = {
    get: () => ({ id: 'g1', revision: 3, phase: 'blocked', blockedReason: { code: 'prompt-rejected', message: 'x' } }),
    resume: () => {
      resumes += 1
    },
  }
  const h = createHarness({ goals, origin: 'subagent' })
  h.emit(turnStart(0, TURN))
  h.emit(userMessage(1))
  await h.emit(turnEnd(2, TURN, { kind: 'blocked' }))
  assert.equal(resumes, 0)
  assert.equal(h.timers.count(), 0)
})

test('S11k 会话已归档:blocked 不接回也不补消息', async () => {
  let resumes = 0
  const goals = {
    get: () => ({ id: 'g1', revision: 3, phase: 'blocked', blockedReason: { code: 'prompt-rejected', message: 'x' } }),
    resume: () => {
      resumes += 1
    },
  }
  const h = createHarness({ goals, archived: ['s1'] })
  h.emit(turnStart(0, TURN))
  h.emit(userMessage(1))
  await h.emit(turnEnd(2, TURN, { kind: 'blocked' }))
  assert.equal(resumes, 0)
  assert.equal(h.timers.count(), 0)
  assert.equal(h.sent.length, 0)
})

test('S11l 目标已完结:blocked 按普通中断补消息', async () => {
  const goals = { get: () => ({ id: 'g1', revision: 9, phase: 'complete' }), resume: () => assert.fail('不得接管') }
  const h = createHarness({ goals })
  h.emit(turnStart(0, TURN))
  h.emit(userMessage(1))
  await h.emit(turnEnd(2, TURN, { kind: 'blocked' }))
  h.timers.flush()
  assert.equal(h.sent.length, 1)
})

test('S11m 接回抛错:回落补消息', async () => {
  const goals = {
    get: () => ({ id: 'g1', revision: 3, phase: 'blocked', blockedReason: { code: 'prompt-rejected', message: 'x' } }),
    resume: () => {
      throw new Error('round budget exhausted')
    },
  }
  const h = createHarness({ goals })
  h.emit(turnStart(0, TURN))
  h.emit(userMessage(1))
  await h.emit(turnEnd(2, TURN, { kind: 'blocked' }))
  h.timers.flush()
  assert.equal(h.sent.length, 1, '接回失败不得留在无人驱动的状态')
})

test('S12 维护轮:不发送', async () => {
  const h = createHarness()
  h.emit(turnStart(0, TURN, 'message-ops'))
  h.emit(assistant(1, TURN, '压缩完成'))
  await h.emit(turnEnd(2, TURN, { kind: 'completed' }))
  assert.equal(h.timers.count(), 0)
})

test('S13 宽限期内开启新回合:取消待发送', async () => {
  const h = createHarness()
  h.emit(turnStart(0, TURN))
  h.emit(userMessage(1))
  h.emit(assistant(2, TURN, '没结案'))
  await h.emit(turnEnd(3, TURN, { kind: 'completed' }))
  assert.equal(h.timers.count(), 1)
  h.emit(turnStart(4, TURN + 1))
  assert.equal(h.timers.count(), 0)
})

test('S14 非用户发起回合:不发送结案提醒', async () => {
  const h = createHarness()
  h.emit(turnStart(0, TURN))
  h.emit(userMessage(1, 'goal'))
  h.emit(assistant(2, TURN, '没结案'))
  await h.emit(turnEnd(3, TURN, { kind: 'completed' }))
  assert.equal(h.timers.count(), 0)
})

test('S15 无可见输出的回合:发送 silent 文案', async () => {
  const h = createHarness()
  h.emit(turnStart(0, TURN))
  h.emit(userMessage(1))
  await h.emit(turnEnd(2, TURN, { kind: 'completed' }))
  h.timers.flush()
  assert.equal(h.sent.length, 1)
  assert.match(textOf(h.sent[0]), /没有可见输出/)
})

test('S17 present 之后又写文件:仍需提醒', async () => {
  const h = createHarness()
  h.emit(turnStart(0, TURN))
  h.emit(userMessage(1))
  h.emit(toolCall(2, TURN, 'write'))
  h.emit(presented(3, TURN))
  h.emit(toolCall(4, TURN, 'edit'))
  h.emit(assistant(5, TURN, '又改了'))
  await h.emit(turnEnd(6, TURN, { kind: 'completed' }))
  assert.equal(h.timers.count(), 1)
  h.timers.flush()
  assert.equal(h.sent.length, 1)
})

test('S16 自己发出的消息不算用户接管', async () => {
  const h = createHarness()
  h.emit(turnStart(0, TURN))
  h.emit(userMessage(1))
  h.emit(assistant(2, TURN, '没结案'))
  await h.emit(turnEnd(3, TURN, { kind: 'completed' }))
  h.timers.flush()
  const autoId = h.sent[0].id

  h.advanceTo(h.now() + 60_000)
  h.emit(turnStart(4, TURN + 1))
  h.emit(userMessage(5, 'user', autoId))
  h.emit(assistant(6, TURN + 1, '仍然没结案'))
  await h.emit(turnEnd(7, TURN + 1, { kind: 'completed' }))
  h.timers.flush()
  assert.equal(h.sent.length, 2)
})

test('卸载后不再响应事件', async () => {
  const h = createHarness()
  h.engine.dispose()
  h.emit(turnStart(0, TURN))
  h.emit(userMessage(1))
  await h.emit(turnEnd(2, TURN, { kind: 'max-tokens' }))
  assert.equal(h.timers.count(), 0)
})

test('实时判定走 sessionQuery.observeSession,不读 deprecated 的 snapshotEvents', async () => {
  const seen = []
  const h = createHarness({ onObserve: (id, options) => seen.push({ id, options }) })
  h.emit(turnStart(0, TURN))
  h.emit(userMessage(1))
  await h.emit(turnEnd(2, TURN, { kind: 'max-tokens' }))
  assert.deepEqual(seen, [{ id: 's1', options: { projectionMode: 'none' } }], '每回合只观察一次且不计算投影')
})

test('观察返回空值时不抛错也不发送', async () => {
  const h = createHarness({ observe: () => undefined })
  h.emit(turnStart(0, TURN))
  h.emit(userMessage(1))
  await h.emit(turnEnd(2, TURN, { kind: 'max-tokens' }))
  assert.equal(h.timers.count(), 0)
  assert.equal(h.sent.length, 0)
})

test('会话状态表有界:闲置会话超过上限后回收最旧条目', () => {
  const h = createHarness()
  for (let index = 0; index <= MAX_SESSION_STATES; index += 1) {
    h.engine.onSessionEvent({ id: `session-${index}`, header: {} }, turnStart(index, 1))
  }
  assert.equal(h.engine.stateCount(), MAX_SESSION_STATES, '闲置状态不得无界增长')
})

test('观察在途时开启新回合:旧回合判定作废', async () => {
  let release
  const h = createHarness({
    observe: () => new Promise((resolve) => {
      release = () => resolve({ events: [...h.session.events], [Symbol.dispose]() {} })
    }),
  })
  h.emit(turnStart(0, TURN))
  h.emit(userMessage(1))
  const ending = h.emit(turnEnd(2, TURN, { kind: 'max-tokens' }))
  h.emit(turnStart(3, TURN + 1))
  release()
  await ending
  assert.equal(h.timers.count(), 0, '观察期间开了新回合,旧判定不得再排恢复')
})

test('离线时挂起,联网后补发', async () => {
  let online = false
  const h = createHarness({ probe: async () => online })
  h.emit(turnStart(0, TURN))
  h.emit(userMessage(1))
  await h.emit(turnEnd(2, TURN, { kind: 'max-tokens' }))
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
  await h.emit(turnEnd(2, TURN, { kind: 'max-tokens' }))
  h.timers.flush()
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(h.sent.length, 1)
})

test('P2-40 离线探测在途时开启新回合:探测完成后不补发', async () => {
  let resolveProbe
  const h = createHarness({
    probe: () => new Promise((resolve) => {
      resolveProbe = resolve
    }),
  })
  h.emit(turnStart(0, TURN))
  h.emit(userMessage(1))
  await h.emit(turnEnd(2, TURN, { kind: 'max-tokens' }))
  h.timers.flush()
  assert.equal(typeof resolveProbe, 'function', '宽限期到点后应发起探测')

  // 探测在途,用户已开新回合:取消必须能作废在途结果
  h.emit(turnStart(3, TURN + 1))
  resolveProbe(true)
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(h.sent.length, 0)
  assert.equal(h.timers.count(), 0)
})

test('S18 插件补发的回合里用户插话:未结案仍补提醒', async () => {
  const h = createHarness({ config: { maxConsecutive: 5 } })
  await h.runTurn(0, 1, '没结案', { human: true })
  assert.equal(h.sent.length, 1)
  h.advanceTo(h.now() + 60_000)
  // 第二回合由 auto-1 发起,真人随后插了一条
  const autoId = h.sent.at(-1).id
  h.emit(turnStart(10, 2))
  h.emit(userMessage(11, 'user', autoId))
  h.emit(userMessage(12, 'user', 'm-12'))
  h.emit(assistant(13, 2, '没结案'))
  await h.emit(turnEnd(14, 2, { kind: 'completed' }))
  h.timers.flush()
  assert.equal(h.sent.length, 2, '插话不是结案凭据,提醒照发')
})

test('S19 空回合开关关闭但有有效写入:仍要求 present', async () => {
  const h = createHarness({ config: { resumeSilentTurns: false } })
  h.emit(turnStart(0, TURN))
  h.emit(userMessage(1))
  h.emit(toolCall(2, TURN, 'write'))
  await h.emit(turnEnd(4, TURN, { kind: 'completed' }))
  h.timers.flush()
  assert.equal(h.sent.length, 1, '文件已改就不能被空回合开关跳过')
  assert.match(textOf(h.sent[0]), /TASK_DONE/)
})

// 排队输入面:失败类终态不唤醒 durable inbox,队列里排着的是人的指令,必须插队跑掉

test('E-Q1 报错回合有排队输入:插队唤醒「继续」,不发错误文案', async () => {
  const h = createHarness()
  h.emit(turnStart(0, TURN))
  h.emit(userMessage(1))
  h.emit(queueAppend(2, 'next-turn'))
  await h.emit(turnEnd(3, TURN, { kind: 'error', error: { code: 'UNKNOWN', message: 'socket hang up' } }))
  h.timers.flush()
  assert.equal(h.sent.length, 0, '有排队输入时不得先发错误文案')
  assert.equal(h.steered.length, 1, '排队输入必须插队唤醒,不能追加到队尾')
  assert.equal(textOf(h.steered[0]), '继续')
})

test('E-Q2 连续上限用尽后排队输入仍插队唤醒', async () => {
  const h = createHarness({ config: { maxConsecutive: 1 } })
  const failure = { kind: 'error', error: { code: 'UNKNOWN', message: 'socket hang up' } }
  h.emit(turnStart(0, 1))
  h.emit(userMessage(1))
  await h.emit(turnEnd(2, 1, failure))
  h.timers.flush()
  assert.equal(h.sent.length, 1, '首次报错按上限内恢复')
  h.advanceTo(h.now() + 60 * 60_000)

  h.emit(turnStart(10, 2))
  h.emit(userMessage(11))
  h.emit(queueAppend(12, 'next-turn'))
  await h.emit(turnEnd(13, 2, failure))
  h.timers.flush()
  assert.equal(h.sent.length, 1, '封顶只封自动恢复')
  assert.equal(h.steered.length, 1, '人的排队指令不能被连续上限锁死在队列里')
  assert.equal(textOf(h.steered[0]), '继续')
})

test('E-Q3 next-step 只有运行时上下文:不算排队,仍发错误文案', async () => {
  const h = createHarness()
  h.emit(turnStart(0, TURN))
  h.emit(userMessage(1))
  h.emit(contextAppend(2))
  await h.emit(turnEnd(3, TURN, { kind: 'error', error: { code: 'UNKNOWN', message: 'socket hang up' } }))
  h.timers.flush()
  assert.equal(h.steered.length, 0)
  assert.equal(h.sent.length, 1)
  assert.match(textOf(h.sent[0]), /^继续。/)
})

test('E-Q4 中断回合有排队输入:插队「继续」而不是中断文案', async () => {
  const h = createHarness()
  h.emit(turnStart(0, TURN))
  h.emit(userMessage(1))
  h.emit(queueAppend(2, 'next-step'))
  await h.emit(turnEnd(3, TURN, { kind: 'interrupted' }))
  h.timers.flush()
  assert.equal(h.sent.length, 0)
  assert.equal(h.steered.length, 1)
  assert.equal(textOf(h.steered[0]), '继续')
})

test('E-Q5 用户主动取消 + 排队输入:不拉起', async () => {
  const h = createHarness()
  h.emit(turnStart(0, TURN))
  h.emit(userMessage(1))
  h.emit(queueAppend(2, 'next-turn'))
  await h.emit(turnEnd(3, TURN, { kind: 'aborted', reason: { kind: 'user' } }))
  h.timers.flush()
  assert.equal(h.sent.length, 0, '用户取消是人的决定,不能被队列改写')
  assert.equal(h.steered.length, 0)
})

test('E-Q6 正常结案 + 排队输入:宿主自己会续跑,不重复唤醒', async () => {
  const h = createHarness()
  h.emit(turnStart(0, TURN))
  h.emit(userMessage(1))
  h.emit(queueAppend(2, 'next-turn'))
  h.emit(assistant(3, TURN, '已交付\nTASK_DONE'))
  await h.emit(turnEnd(4, TURN, { kind: 'completed' }))
  h.timers.flush()
  assert.equal(h.sent.length, 0)
  assert.equal(h.steered.length, 0)
})
