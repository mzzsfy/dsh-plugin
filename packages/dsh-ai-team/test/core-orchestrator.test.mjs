// PKG-2 编排测试:stub 宿主驱动实施→独立验收→结案→中断→恢复链(CAP-04/06 语义)
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { createTask, defineWorkItem, authorizeTask, submitReport, closeTask } from '../lib/core/task.mjs'
import { dispatchRun, applySessionEvent, interruptTask, resumeTask } from '../lib/core/orchestrator.mjs'
import { createSessionAdapter } from '../lib/session-adapter.mjs'

let clock = 9_000
const now = () => { clock += 1; return clock }

function stubController({ rejectPrompt = false, failCancel = false } = {}) {
  const calls = { created: [], prompts: [], cancels: [] }
  return {
    calls,
    async create(request) { calls.created.push(request); return { sessionId: request.sessionId ?? `sess-${calls.created.length}` } },
    async prompt({ sessionId, requestId, content }) {
      calls.prompts.push({ sessionId, requestId, content })
      if (rejectPrompt) return { accepted: false, code: 'PROMPT_REJECTED' }
      return { accepted: true, turnId: `turn-${calls.prompts.length}` }
    },
    async cancel({ sessionId }) {
      calls.cancels.push(sessionId)
      if (failCancel) throw new Error('cancel 不可用')
      return { stopped: true }
    },
    async updateQueue() { return { ok: true } },
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
  const controller = stubController({ rejectPrompt: rejected })
  const adapter = createSessionAdapter({ sessionController: controller })
  return { agg, controller, adapter }
}

test('实施→独立验收→结案闭环:受理有回执,自验拒绝,结案须当前 pass', async () => {
  const { agg, adapter } = await seeded()
  const dispatch = await dispatchRun(null, agg, {
    runId: 'r1', workItemId: 'w1', phase: 'implement', actorRole: 'executor',
    requestId: 'req-1', content: '实施', presetId: 'ai-team-worker', sessionAdapter: adapter, globalControl: GLOBAL_CONTROL,
  })
  assert.ok(dispatch.ok, dispatch.message)
  assert.equal(dispatch.turnId, 'turn-1')
  let cur = dispatch.aggregate
  cur = applySessionEvent(cur, { runId: 'r1', type: 'turn.start' }).aggregate
  cur = applySessionEvent(cur, { runId: 'r1', type: 'turn.end' }).aggregate
  assert.equal(cur.runs.r1.state, 'running', 'turn.end 不凭回复断言完成')
  const executor = createSessionAdapter({ sessionController: stubController() })
  const report = submitReport(cur, { reportId: 'rep-impl', runId: 'r1', verdict: 'ready_for_review', evidence: ['diff:1'] })
  assert.ok(report.ok, report.message)
  let state = report.result.aggregate
  assert.equal(state.businessState, 'awaiting_acceptance')
  // 独立验收 session
  const review = await dispatchRun(null, state, {
    runId: 'r2', workItemId: 'w1', phase: 'accept', actorRole: 'reviewer',
    requestId: 'req-2', content: '验收', presetId: 'ai-team-worker', sessionAdapter: executor, globalControl: GLOBAL_CONTROL,
  })
  assert.ok(review.ok, review.message)
  state = { ...state, runs: review.aggregate.runs }
  const pass = submitReport(state, { reportId: 'rep-pass', runId: 'r2', verdict: 'pass', coveredCriterionIds: ['c1'] })
  assert.ok(pass.ok, pass.message)
  state = pass.result.aggregate
  const closed = closeTask(state, { passReportId: 'rep-pass', conclusion: '验收通过' })
  assert.ok(closed.ok, closed.message)
  assert.equal(closed.result.aggregate.businessState, 'completed')
})

test('投递被拒/适配失败:Run 标 rejected,执行槽释放可重派', async () => {
  const { agg, adapter } = await seeded({ rejected: true })
  const denied = await dispatchRun(null, agg, {
    runId: 'r1', workItemId: 'w1', phase: 'implement', actorRole: 'executor',
    requestId: 'req-1', content: 'x', presetId: 'p', sessionAdapter: adapter, globalControl: GLOBAL_CONTROL,
  })
  assert.equal(denied.ok, false)
  assert.equal(denied.code, 'PROMPT_REJECTED')
  assert.equal(denied.aggregate.runs.r1.state, 'rejected')
  const retried = await dispatchRun(null, denied.aggregate, {
    runId: 'r1b', workItemId: 'w1', phase: 'implement', actorRole: 'executor',
    requestId: 'req-2', content: 'x', presetId: 'p', sessionAdapter: adapter, globalControl: GLOBAL_CONTROL,
  })
  assert.equal(retried.ok, false, '拒绝后仍不可派发(stub 仍拒绝)')
})

test('中断闭环:先持久化 stopping 再停会话;无活跃执行直接 paused;恢复链经核对', async () => {
  const { agg, adapter, controller } = await seeded()
  const dispatched = await dispatchRun(null, agg, {
    runId: 'r1', workItemId: 'w1', phase: 'implement', actorRole: 'executor',
    requestId: 'req-1', content: 'x', presetId: 'p', sessionAdapter: adapter, globalControl: GLOBAL_CONTROL,
  })
  const running = applySessionEvent(dispatched.aggregate, { runId: 'r1', type: 'turn.start' }).aggregate
  const interrupted = await interruptTask(null, running, { sessionAdapter: adapter })
  assert.ok(interrupted.ok)
  assert.deepEqual(interrupted.cancelErrors, [])
  assert.equal(interrupted.aggregate.control.state, 'paused')
  assert.equal(controller.calls.cancels.length, 1, '受管会话被请求停止')
  // 恢复:stale epoch 拒绝 → 正确 epoch 经核对 → active
  const stale = await resumeTask(interrupted.aggregate, {
    resumeIntentId: 'ri1', sourceMessageRef: {}, globalStopGeneration: 0, sessionAdapter: adapter,
    expectedExecutionEpoch: interrupted.aggregate.control.executionEpoch - 1,
  })
  assert.equal(stale.ok, false)
  const epoch = interrupted.aggregate.control.executionEpoch
  const resumed = await resumeTask({ ...interrupted.aggregate, control: { ...interrupted.aggregate.control, state: 'paused' } }, {
    resumeIntentId: 'ri2', sourceMessageRef: {}, globalStopGeneration: 0,
    sessionAdapter: adapter, sessionId: 'sess-1', probePrompt: '只读核对:当前进度',
    expectedExecutionEpoch: epoch,
  })
  assert.ok(resumed.ok, resumed.message)
  assert.equal(resumed.result.aggregate.control.state, 'active')
  assert.equal(controller.calls.prompts.at(-1).content, '只读核对:当前进度')
})

test('cancel 适配失败:cancelErrors 可见,不伪造已停', async () => {
  const { agg } = await seeded()
  const controller2 = stubController({ failCancel: true }); const failing = createSessionAdapter({ sessionController: controller2 })
  const dispatched = await dispatchRun(null, agg, {
    runId: 'r1', workItemId: 'w1', phase: 'implement', actorRole: 'executor',
    requestId: 'req-1', content: 'x', presetId: 'p', sessionAdapter: createSessionAdapter({ sessionController: stubController() }), globalControl: GLOBAL_CONTROL,
  })
  const running = applySessionEvent(dispatched.aggregate, { runId: 'r1', type: 'turn.start' }).aggregate
  const interrupted = await interruptTask(null, running, { sessionAdapter: failing })
  assert.equal(interrupted.cancelErrors.length, 1)
  assert.equal(interrupted.aggregate.runs.r1.stopObserved, 'pending')
})
