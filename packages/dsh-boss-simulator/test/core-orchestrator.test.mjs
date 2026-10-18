import { test } from 'node:test'
import assert from 'node:assert/strict'

import { createTask, defineWorkItem, authorizeTask, submitReport, closeTask } from '../lib/core/task.mjs'
import { dispatchRun, applySessionEvent, interruptTask, resumeTask, parseRunReport, reconcileStoppedTask } from '../lib/core/orchestrator.mjs'
import { createSessionAdapter } from '../lib/session-adapter.mjs'

let clock = 9_000
const now = () => { clock += 1; return clock }

function stubController({ rejectPrompt = false, failCancel = false, sessionPrefix = 'sess' } = {}) {
  const calls = { created: [], prompts: [], cancels: [] }
  const controller = {
    async create(request) { calls.created.push(request); return { sessionId: request.sessionId ?? `${sessionPrefix}-${calls.created.length}` } },
    async prompt({ sessionId, requestId, content }) {
      calls.prompts.push({ sessionId, requestId, content })
      if (rejectPrompt) return { accepted: false, code: 'PROMPT_REJECTED' }
      return { accepted: true, turnId: `turn-${calls.prompts.length}` }
    },
    async cancel({ sessionId }) {
      calls.cancels.push(sessionId)
      if (failCancel) throw new Error('cancel 不可用')
      return { accepted: true }
    },
    async projections() { return { asOfSeq: 10, values: { inbox: { 'next-turn': [], 'next-step': [] } } } },
    async list() { return { items: [{ sessionId: 'sess-1', running: calls.cancels.length === 0 || failCancel }] } },
    async updateQueue() { return { ok: true } },
  }
  return { calls, controller }
}

const memoryStore = (initial) => {
  let current = initial
  return {
    async loadAggregate() { return current },
    async updateAggregate(_taskId, update) { current = update(current); return current },
  }
}

const GLOBAL_CONTROL = { globalStopped: false, globalStopGeneration: 0 }

async function seeded({ rejected = false } = {}) {
  let agg = createTask({
    taskId: 't1', title: '任务一', projectWorkspaceId: 'ws1',
    definition: { goal: 'g', acceptanceCriteria: [{ criterionId: 'c1', text: '标准' }] },
    now,
  }).result
  agg = defineWorkItem(agg, { workItemId: 'w1', title: '子项', requiredCriterionIds: ['c1'] }).result.aggregate
  agg = authorizeTask(agg, { sourceMessageRef: { sessionId: 's0', messageId: 'm1' } }).result.aggregate
  const { calls, controller } = stubController({ rejectPrompt: rejected })
  return { agg, calls, controller, adapter: createSessionAdapter({ sessionController: controller }) }
}

test('执行和独立验收都使用标准会话且报告决定结案', async () => {
  const { agg, adapter, calls } = await seeded()
  const dispatch = await dispatchRun(null, agg, {
    runId: 'r1', workItemId: 'w1', phase: 'implement', actorRole: 'executor',
    requestId: 'req-1', content: '实施', sessionAdapter: adapter, globalControl: GLOBAL_CONTROL,
  })
  assert.ok(dispatch.ok, dispatch.message)
  assert.equal(dispatch.turnId, 'turn-1')
  assert.deepEqual(calls.created[0], { workspaceId: 'ws1' })
  assert.match(calls.prompts[0].content[0].text, /完成当前阶段后/)
  let current = applySessionEvent(dispatch.aggregate, { runId: 'r1', type: 'turn.start' }).aggregate
  current = applySessionEvent(current, { runId: 'r1', type: 'turn.end' }).aggregate
  assert.equal(current.runs.r1.state, 'running', 'turn.end 不凭回复断言完成')
  const report = submitReport(current, { reportId: 'rep-impl', runId: 'r1', verdict: 'ready_for_review', summary: '实施完成', evidence: ['diff:1'] })
  assert.ok(report.ok, report.message)
  let state = report.result.aggregate
  assert.equal(state.businessState, 'awaiting_acceptance')
  const reviewerStub = stubController({ sessionPrefix: 'review' })
  const review = await dispatchRun(null, state, {
    runId: 'r2', workItemId: 'w1', phase: 'accept', actorRole: 'reviewer',
    requestId: 'req-2', content: '验收', sessionAdapter: createSessionAdapter({ sessionController: reviewerStub.controller }), globalControl: GLOBAL_CONTROL,
  })
  assert.ok(review.ok, review.message)
  assert.deepEqual(reviewerStub.calls.created[0], { workspaceId: 'ws1' })
  state = { ...state, runs: review.aggregate.runs }
  const pass = submitReport(state, { reportId: 'rep-pass', runId: 'r2', verdict: 'pass', summary: '验收通过', coveredCriterionIds: ['c1'] })
  assert.ok(pass.ok, pass.message)
  const closed = closeTask(pass.result.aggregate, { passReportId: 'rep-pass', conclusion: '验收通过' })
  assert.ok(closed.ok, closed.message)
  assert.equal(closed.result.aggregate.businessState, 'completed')
})

test('结构化报告必须是严格 JSON 且符合运行阶段', () => {
  const implementationRun = { phase: 'implement', actorRole: 'executor' }
  const reviewerRun = { phase: 'accept', actorRole: 'reviewer' }
  const integrateExecutor = { phase: 'integrate', actorRole: 'executor' }
  const integrateReviewer = { phase: 'integrate', actorRole: 'reviewer' }
  const valid = JSON.stringify({ summary: 'done', verdict: 'ready_for_review', coveredCriterionIds: [], issues: [], evidence: [] })
  assert.equal(parseRunReport([{ type: 'text', text: valid }], implementationRun).ok, true)
  assert.equal(parseRunReport([{ type: 'text', text: '```json\n' + valid + '\n```' }], implementationRun).ok, false)
  assert.equal(parseRunReport([{ type: 'text', text: valid }], reviewerRun).ok, false)
  assert.equal(parseRunReport([{ type: 'text', text: valid }], integrateExecutor).ok, true)
  assert.equal(parseRunReport([{ type: 'text', text: valid }], integrateReviewer).ok, false)
  assert.equal(parseRunReport([{ type: 'text', text: JSON.stringify({ ...JSON.parse(valid), extra: true }) }], implementationRun).ok, false)
  const pass = JSON.stringify({ summary: 'pass', verdict: 'pass', coveredCriterionIds: ['c1'], issues: [], evidence: [] })
  assert.equal(parseRunReport([{ type: 'text', text: pass }], reviewerRun).ok, true)
})

test('投递被拒时执行槽可重新派发', async () => {
  const { agg, adapter } = await seeded({ rejected: true })
  const denied = await dispatchRun(null, agg, {
    runId: 'r1', workItemId: 'w1', phase: 'implement', actorRole: 'executor',
    requestId: 'req-1', content: 'x', sessionAdapter: adapter, globalControl: GLOBAL_CONTROL,
  })
  assert.equal(denied.ok, false)
  assert.equal(denied.code, 'PROMPT_REJECTED')
  assert.equal(denied.aggregate.runs.r1.state, 'rejected')
})

test('中断后核对恢复', async () => {
  const { agg, adapter, calls } = await seeded()
  const dispatched = await dispatchRun(null, agg, {
    runId: 'r1', workItemId: 'w1', phase: 'implement', actorRole: 'executor',
    requestId: 'req-1', content: 'x', sessionAdapter: adapter, globalControl: GLOBAL_CONTROL,
  })
  const running = applySessionEvent(dispatched.aggregate, { runId: 'r1', type: 'turn.start' }).aggregate
  const interrupted = await interruptTask(memoryStore(running), running, { sessionAdapter: adapter })
  assert.ok(interrupted.ok)
  assert.deepEqual(interrupted.cancelErrors, [])
  assert.equal(interrupted.aggregate.control.state, 'paused')
  assert.equal(calls.cancels.length, 1)
  const stale = await resumeTask(interrupted.aggregate, {
    resumeIntentId: 'ri1', sourceMessageRef: {}, globalStopGeneration: 0, sessionAdapter: adapter,
    expectedExecutionEpoch: interrupted.aggregate.control.executionEpoch - 1,
  })
  assert.equal(stale.ok, false)
  const epoch = interrupted.aggregate.control.executionEpoch
  const resumed = await resumeTask({ ...interrupted.aggregate, control: { ...interrupted.aggregate.control, state: 'paused' } }, {
    resumeIntentId: 'ri2', sourceMessageRef: {}, globalStopGeneration: 0,
    sessionAdapter: adapter, sessionId: 'sess-1', probePrompt: '只读核对:当前进度', expectedExecutionEpoch: epoch,
  })
  assert.ok(resumed.ok, resumed.message)
  assert.equal(resumed.result.aggregate.control.state, 'active')
  assert.equal(calls.prompts.length, 1, '恢复核对不得发送probe prompt')
})

test('cancel 适配失败不伪造已停', async () => {
  const { agg } = await seeded()
  const failingStub = stubController({ failCancel: true })
  const failing = createSessionAdapter({ sessionController: failingStub.controller })
  const dispatchStub = stubController()
  const dispatched = await dispatchRun(null, agg, {
    runId: 'r1', workItemId: 'w1', phase: 'implement', actorRole: 'executor',
    requestId: 'req-1', content: 'x', sessionAdapter: createSessionAdapter({ sessionController: dispatchStub.controller }), globalControl: GLOBAL_CONTROL,
  })
  const running = applySessionEvent(dispatched.aggregate, { runId: 'r1', type: 'turn.start' }).aggregate
  const interrupted = await interruptTask(memoryStore(running), running, { sessionAdapter: failing })
  assert.equal(interrupted.cancelErrors.length, 1)
  assert.equal(interrupted.aggregate.runs.r1.stopObserved, 'pending')
  assert.equal(interrupted.aggregate.control.state, 'stopping')
  assert.equal(interrupted.aggregate.runs.r1.state, 'running')
})

test('Given idle但队列未清 When reconcileStoppedTask Then 保留stopping且不改epoch', async () => {
  const { agg } = await seeded()
  const initial = { ...agg, control: { ...agg.control, state: 'stopping', executionEpoch: 4 }, runs: { r1: { runId: 'r1', sessionId: 's1', state: 'running' } } }
  const store = memoryStore(initial)
  const pending = await reconcileStoppedTask(store, 't1', { inspectSession: async () => ({ running: false, pendingItemIds: ['q1'] }) })
  assert.equal(pending.stopConfirmed, false)
  assert.equal(pending.aggregate.control.state, 'stopping')
  assert.equal(pending.aggregate.runs.r1.state, 'running')
  const settled = await reconcileStoppedTask(store, 't1', { inspectSession: async () => ({ running: false, pendingItemIds: [] }) })
  assert.equal(settled.stopConfirmed, true)
  assert.equal(settled.aggregate.control.state, 'paused')
  assert.equal(settled.aggregate.control.executionEpoch, 4)
  assert.equal(settled.aggregate.runs.r1.state, 'interrupted')
})

test('Given 停止落盘失败 When 中断 Then 不调用宿主cancel', async () => {
  const { agg } = await seeded()
  let cancelled = false
  await assert.rejects(() => interruptTask({ updateAggregate: async () => { throw new Error('durability failed') } }, agg, { sessionAdapter: { cancelSession: async () => { cancelled = true } } }), /durability failed/)
  assert.equal(cancelled, false)
})

test('Given 相同停止命令已确认 When 重试 Then epoch不再增长且unknown运行必须核对', async () => {
  const { agg } = await seeded()
  const store = memoryStore({ ...agg, runs: { r1: { runId: 'r1', sessionId: 's1', state: 'unknown' } } })
  const inspected = []
  const adapter = { inspectSession: async ({ sessionId }) => { inspected.push(sessionId); return { running: false, pendingItemIds: [] } }, cancelSession: async () => ({ accepted: true }) }
  const first = await interruptTask(store, agg, { sessionAdapter: adapter, commandId: 'stop-1' })
  assert.equal(first.stopConfirmed, true)
  assert.ok(inspected.length > 0)
  const again = await interruptTask(store, first.aggregate, { sessionAdapter: adapter, commandId: 'stop-1' })
  assert.equal(again.aggregate.control.executionEpoch, 1)
})

test('Given stop1之后已恢复并有新Run When 重放stop1 Then 返回receipt且不取消新执行', async () => {
  const { agg } = await seeded()
  const store = memoryStore({ ...agg, runs: { r1: { runId: 'r1', sessionId: 's1', state: 'running' } } })
  const cancelled = []
  let inspections = 0
  const adapter = { inspectSession: async () => ({ running: inspections++ === 0, pendingItemIds: [] }), cancelSession: async ({ sessionId }) => { cancelled.push(sessionId); return { accepted: true } } }
  const stopped = await interruptTask(store, agg, { sessionAdapter: adapter, commandId: 'stop-1' })
  await store.updateAggregate('t1', current => ({ ...current, control: { ...current.control, state: 'active', executionEpoch: 2 }, runs: { ...current.runs, r2: { runId: 'r2', sessionId: 's2', state: 'running' } } }))
  const replay = await interruptTask(store, stopped.aggregate, { sessionAdapter: adapter, commandId: 'stop-1' })
  assert.deepEqual(cancelled, ['s1'])
  assert.equal(replay.replayed, true)
  assert.equal(replay.aggregate.control.state, 'active')
  assert.equal(replay.aggregate.runs.r2.state, 'running')
})

test('Given 停止receipt已落盘但取消前崩溃 When 同epoch重放 Then 继续取消而不增epoch', async () => {
  const { agg } = await seeded()
  const current = { ...agg, control: { ...agg.control, state: 'stopping', executionEpoch: 1, stopCommandIds: { stop1: { executionEpoch: 1 } } }, runs: { r1: { runId: 'r1', sessionId: 's1', state: 'running' } } }
  const store = memoryStore(current)
  let cancelled = 0
  const result = await interruptTask(store, current, { commandId: 'stop1', sessionAdapter: {
    inspectSession: async () => ({ running: cancelled === 0, pendingItemIds: [] }),
    cancelSession: async () => { cancelled++; return { accepted: true } },
  } })
  assert.equal(cancelled, 1)
  assert.equal(result.stopConfirmed, true)
  assert.equal(result.aggregate.control.executionEpoch, 1)
})

test('Given cold会话已idle且队列空 When 中断 Then 不cancel冷会话且确认停止', async () => {
  const { agg } = await seeded()
  const store = memoryStore({ ...agg, runs: { r1: { runId: 'r1', sessionId: 'cold', state: 'unknown' } } })
  let cancelled = false
  const result = await interruptTask(store, agg, { sessionAdapter: {
    inspectSession: async () => ({ running: false, pendingItemIds: [], stopped: true }),
    cancelSession: async () => { cancelled = true; throw new Error('cold agent unavailable') },
  } })
  assert.equal(cancelled, false)
  assert.equal(result.stopConfirmed, true)
})

test('Given cancel仅受理且会话仍running When 中断 Then 先持久化且保留stopping', async () => {
  const { agg, adapter } = await seeded()
  const dispatched = await dispatchRun(null, agg, { runId: 'r1', workItemId: 'w1', phase: 'implement', actorRole: 'executor', requestId: 'req-1', content: 'x', sessionAdapter: adapter, globalControl: GLOBAL_CONTROL })
  const store = memoryStore(dispatched.aggregate)
  const observed = []
  const inspecting = {
    async inspectSession() { return { running: true, pendingItemIds: ['queued-1'], stopped: false } },
    async cancelSession(request) { observed.push((await store.loadAggregate()).control); assert.deepEqual(request.pendingItemIds, ['queued-1']); return { accepted: true } },
  }
  const result = await interruptTask(store, dispatched.aggregate, { sessionAdapter: inspecting })
  assert.equal(observed[0].state, 'stopping')
  assert.equal(observed[0].executionEpoch, 1)
  assert.equal(result.aggregate.control.state, 'stopping')
  assert.equal(result.stopConfirmed, false)
})
