import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRunFollowers } from '../lib/run-followers.mjs'
import { createTask, defineWorkItem, authorizeTask, recordRun } from '../lib/core/task.mjs'

function setup() {
  let current = createTask({ taskId: 't1', title: '任务', projectWorkspaceId: 'ws1', definition: { goal: '目标' }, now: () => 100 }).result
  current = defineWorkItem(current, { workItemId: 'w1', title: '子项' }).result.aggregate
  current = authorizeTask(current, { sourceMessageRef: { sessionId: 'admin', eventSeq: 1 } }).result.aggregate
  current = recordRun(current, { runId: 'r1', workItemId: 'w1', phase: 'implement', actorRole: 'executor', sessionId: 's1', requestId: 'rpc1', slotKey: 'slot', globalControl: { globalStopGeneration: 0 } }).result.aggregate
  current = { ...current, runs: { ...current.runs, r1: { ...current.runs.r1, state: 'submitted' } } }
  const store = {
    async listAggregates() { return [current] },
    async loadAggregate() { return current },
    async updateAggregate(_id, fn) { current = fn(current); return current },
  }
  const events = [
    { type: 'turn/start', seq: 0, time: 90, data: { turn: 1 } },
    { type: 'user/message', seq: 1, time: 100, data: { id: 'user1', role: 'user', content: [{ type: 'text', text: '任务' }], source: { kind: 'user', rpcId: 'rpc1' } } },
    { type: 'assistant/message', seq: 2, time: 200, data: { turn: 1, message: { content: [{ type: 'text', text: JSON.stringify({ summary: '完成', verdict: 'ready_for_review', coveredCriterionIds: [], issues: [], evidence: [] }) }] } } },
    { type: 'turn/end', seq: 3, time: 300, data: { turn: 1, reason: { kind: 'completed' } } },
  ]
  return { store, events, get current() { return current } }
}

test('Given 重启前未结 Run When 恢复 follower Then 只读 durable 历史提交报告而不发 prompt', async () => {
  const f = setup()
  let consumed
  const finished = new Promise(resolve => { consumed = resolve })
  const adapter = { async *followSessionEvents() { yield* f.events; consumed() } }
  const followers = createRunFollowers({ store: f.store, sessionAdapter: adapter })
  await followers.restore()
  await finished
  await followers.dispose()
  assert.equal(f.current.runs.r1.state, 'settled')
  assert.equal(f.current.businessState, 'awaiting_acceptance')
})

test('Given 采集时存储写失败 When follower 重连重放 Then 不丢报告且释放订阅', async () => {
  const f = setup()
  let attempts = 0
  const original = f.store.updateAggregate
  let fail = true
  f.store.updateAggregate = async (...args) => {
    if (fail && args[1](await f.store.loadAggregate()).reports['s1:2']) { fail = false; throw new Error('disk unavailable') }
    return original(...args)
  }
  let consumed
  const finished = new Promise(resolve => { consumed = resolve })
  const adapter = { async *followSessionEvents() { attempts++; yield* f.events; consumed() } }
  const errors = []
  const followers = createRunFollowers({ store: f.store, sessionAdapter: adapter, retryMs: 1, onError: error => errors.push(error) })
  await followers.restore()
  await finished
  await followers.dispose()
  assert.equal(attempts, 2)
  assert.equal(errors.length, 1)
  assert.equal(Object.keys(f.current.reports).length, 1)
})

test('Given 会话流自然结束且已无活跃 Run When 重连 Then 退到长间隔而非每秒重放整段历史', async () => {
  const f = setup()
  const waits = []
  let attempts = 0
  const adapter = { async *followSessionEvents() { attempts += 1; yield* f.events } }
  const followers = createRunFollowers({
    store: f.store,
    sessionAdapter: adapter,
    retryMs: 1000,
    idleRetryMs: 30000,
    wait: async (ms) => { waits.push(ms); throw new Error('stop') },
  })
  await followers.follow('t1', 's1')
  assert.equal(f.current.runs.r1.state, 'settled')
  assert.deepEqual(waits, [30000], 'run 落定后应按空闲间隔等待,不再按每秒重订阅')
})

test('Given 会话流持续抛错 When 连续失败达到上限 Then 按指数退避有限次重连后停止告警', async () => {
  let attempts = 0
  const waits = []
  const errors = []
  const adapter = { async *followSessionEvents() { attempts += 1; throw new Error('stream broken') } }
  const followers = createRunFollowers({
    store: { async listAggregates() { return [] } },
    sessionAdapter: adapter,
    retryMs: 100,
    maxRetryMs: 1000,
    maxFailures: 4,
    onError: error => errors.push(error),
    wait: async (ms) => { waits.push(ms) },
  })
  await followers.follow('t1', 's1')
  assert.equal(attempts, 4)
  assert.deepEqual(waits, [100, 200, 400])
  assert.match(errors.at(-1), /连续失败 4 次,停止跟随/)
  assert.equal(errors.filter(error => /stream broken/.test(error)).length, 4)
})

test('Given 会话不存在或已删除 When 跟随 Then 不重连直接停止', async () => {
  for (const failure of [
    Object.assign(new Error('会话不存在'), { code: 'SESSION_NOT_FOUND' }),
    new Error('session has been deleted'),
  ]) {
    let attempts = 0
    const waits = []
    const errors = []
    const followers = createRunFollowers({
      store: { async listAggregates() { return [] } },
      sessionAdapter: { async *followSessionEvents() { attempts += 1; throw failure } },
      onError: error => errors.push(error),
      wait: async (ms) => { waits.push(ms) },
    })
    await followers.follow('t1', 's1')
    assert.equal(attempts, 1)
    assert.deepEqual(waits, [])
    assert.match(errors.at(-1), /会话不存在或已删除,停止跟随/)
  }
})

