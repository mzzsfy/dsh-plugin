// PKG-1 核心:BDD 覆盖 DATA-01/02/04/09/10/11/15 与生命周期停止/恢复/定义失效/失联收敛
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { applyEnvelope, ERROR_CODES } from '../lib/core/command.mjs'
import {
  createTask, defineWorkItem, authorizeTask, reviseDefinition, checkExecutionPermission,
  recordRun, submitReport, markSessionExecutor, closeTask, stopTask, confirmStopped,
  requestResume, confirmResume, replaceWorkItem, effectiveAcceptance, dependencyAccepted,
  expireStaleRuns, isStaleRun, RUN_STALE_MS, hasActiveRuns,
} from '../lib/core/task.mjs'
import { createGlobalControl, stopAll, resumeAll } from '../lib/core/global-control.mjs'

let clock = 1_000
const now = () => { clock += 1; return clock }
const tick = () => now()

async function makeReadyTask() {
  const created = createTask({
    taskId: 't1', title: '任务一', projectWorkspaceId: 'ws1',
    definition: {
      goal: 'g',
      acceptanceCriteria: [{ criterionId: 'c1', text: '标准一' }],
      dependencyTaskIds: [],
    },
    now,
  })
  assert.ok(created.ok, created.message)
  let agg = created.result
  const def = defineWorkItem(agg, { workItemId: 'w1', title: '子项一', requiredCriterionIds: ['c1'] })
  assert.ok(def.ok, def.message)
  agg = def.result.aggregate
  const auth = authorizeTask(agg, { sourceMessageRef: { sessionId: 's0', messageId: 'm1' } })
  assert.ok(auth.ok, auth.message)
  return auth.result.aggregate
}

function dispatchRun(agg, { runId = 'r1', workItemId = 'w1', phase = 'implement', actorRole = 'executor', sessionId = 's1' } = {}) {
  const control = { globalStopped: false, globalStopGeneration: 0 }
  const perm = checkExecutionPermission(agg, control, { workItemId, phase, actorRole })
  assert.ok(perm.ok, perm.message)
  const rec = recordRun(agg, {
    runId, workItemId, phase, actorRole, sessionId, requestId: `req-${runId}`,
    slotKey: perm.result.slotKey, globalControl: control,
  })
  assert.ok(rec.ok, rec.message)
  return rec.result.aggregate
}

test('DATA-01/02: 命令信封幂等与 IDEMPOTENCY_CONFLICT', () => {
  let state = { commandReceipts: {}, value: 0 }
  const first = applyEnvelope(state, { commandId: 'c1', payloadHash: 'h1' }, () => ({
    state: { ...state, value: 1, commandReceipts: { ...state.commandReceipts, c1: { payloadHash: 'h1', result: 'applied' } } },
    result: 'applied',
  }))
  assert.equal(first.ok, true)
  assert.equal(first.result.replayed, false)
  const retry = applyEnvelope(first.result.state, { commandId: 'c1', payloadHash: 'h1' }, () => { throw new Error('不应重放') })
  assert.equal(retry.ok, true)
  assert.equal(retry.result.replayed, true)
  const conflict = applyEnvelope(first.result.state, { commandId: 'c1', payloadHash: 'h2' }, () => ({}))
  assert.equal(conflict.ok, false)
  assert.equal(conflict.code, ERROR_CODES.IDEMPOTENCY_CONFLICT)
})

test('DATA-04: 不同 cause 争同一执行槽至多一个有效 Run', async () => {
  let agg = await makeReadyTask()
  agg = dispatchRun(agg, { runId: 'r1' })
  const control = { globalStopped: false, globalStopGeneration: 0 }
  const second = checkExecutionPermission(agg, control, { workItemId: 'w1', phase: 'implement', actorRole: 'executor' })
  assert.equal(second.ok, false)
  assert.equal(second.code, ERROR_CODES.EXECUTION_STILL_ACTIVE)
})

test('DATA-09: 旧定义 pass 标 historical,不可用于结案', async () => {
  let agg = await makeReadyTask()
  agg = dispatchRun(agg, { runId: 'r1', phase: 'accept', actorRole: 'reviewer', sessionId: 'sr1' })
  const pass1 = submitReport(agg, { reportId: 'rep1', runId: 'r1', verdict: 'pass', summary: '验收通过', coveredCriterionIds: ['c1'], issues: [], evidence: [] })
  assert.ok(pass1.ok, pass1.message)
  const revised = reviseDefinition(pass1.result.aggregate, { definition: { goal: 'g2', acceptanceCriteria: [{ criterionId: 'c1', text: '标准一' }] } })
  assert.ok(revised.ok, revised.message)
  const closed = closeTask(revised.result.aggregate, { passReportId: 'rep1' })
  assert.equal(closed.ok, false)
})

test('DATA-10: 实施 session 自验被拒绝', async () => {
  let agg = await makeReadyTask()
  agg = dispatchRun(agg, { runId: 'r1', sessionId: 's-exec' })
  const marked = markSessionExecutor(agg, { sessionId: 's-exec', runIds: ['r1'] })
  agg = marked.result.aggregate
  agg = dispatchRun(agg, { runId: 'r2', phase: 'accept', actorRole: 'reviewer', sessionId: 's-exec' })
  const selfAccept = submitReport(agg, { reportId: 'rep2', runId: 'r2', verdict: 'pass', summary: '验收通过', coveredCriterionIds: ['c1'], issues: [], evidence: [] })
  assert.equal(selfAccept.ok, false)
  assert.match(selfAccept.message, /自验|相同/)
})

test('Given 无 sessions 标记但实施 Run 已绑定 When 同 session 提交验收 Then 拒绝自验', async () => {
  let agg = await makeReadyTask()
  agg = dispatchRun(agg, { runId: 'implementation', sessionId: 'same' })
  agg = dispatchRun(agg, { runId: 'review', phase: 'accept', actorRole: 'reviewer', sessionId: 'same' })
  const result = submitReport(agg, { reportId: 'self', runId: 'review', summary: '自验', verdict: 'pass', coveredCriterionIds: ['c1'] })
  assert.equal(result.ok, false)
})

test('Given 一个工作项通过但另一个没有验收 When 结案 Then 拒绝遗漏工作项', async () => {
  let agg = await makeReadyTask()
  agg = defineWorkItem(agg, { workItemId: 'w2', title: '第二项', requiredCriterionIds: ['c1'] }).result.aggregate
  agg = dispatchRun(agg, { runId: 'review', phase: 'accept', actorRole: 'reviewer', sessionId: 'reviewer' })
  agg = submitReport(agg, { reportId: 'pass1', runId: 'review', summary: '部分通过', verdict: 'pass', coveredCriterionIds: ['c1'] }).result.aggregate
  assert.equal(closeTask(agg, { passReportId: 'pass1' }).ok, false)
})

test('Given 验收后又实施修复 When 引用旧 pass 结案 Then 拒绝旧产物报告', async () => {
  let agg = await makeReadyTask()
  agg = dispatchRun(agg, { runId: 'review', phase: 'accept', actorRole: 'reviewer', sessionId: 'reviewer' })
  agg = submitReport(agg, { reportId: 'pass1', runId: 'review', summary: '通过', verdict: 'pass', coveredCriterionIds: ['c1'] }).result.aggregate
  agg = dispatchRun(agg, { runId: 'fix', phase: 'fix', sessionId: 'fixer' })
  agg = submitReport(agg, { reportId: 'fixed', runId: 'fix', summary: '修复', verdict: 'ready_for_review' }).result.aggregate
  assert.equal(closeTask(agg, { passReportId: 'pass1' }).ok, false)
})

test('Given 有有效 pass 但存在回执未知验收 When 结案 Then 拒绝未核清执行', async () => {
  let agg = await makeReadyTask()
  agg = dispatchRun(agg, { runId: 'review', phase: 'accept', actorRole: 'reviewer', sessionId: 'reviewer' })
  agg = submitReport(agg, { reportId: 'pass1', runId: 'review', summary: '通过', verdict: 'pass', coveredCriterionIds: ['c1'] }).result.aggregate
  agg = dispatchRun(agg, { runId: 'unknown', phase: 'accept', actorRole: 'reviewer', sessionId: 'another' })
  agg.runs.unknown.state = 'unknown'
  assert.equal(closeTask(agg, { passReportId: 'pass1' }).ok, false)
})

test('DATA-11: 全局停止同 commandId 不重复提升,新 commandId 使旧单项许可失效', () => {
  let control = createGlobalControl(now)
  const first = stopAll(control, { commandId: 'c1', payloadHash: 'p' })
  assert.equal(first.result.result.globalStopGeneration, 1)
  const retry = stopAll(first.result.state, { commandId: 'c1', payloadHash: 'p' })
  assert.equal(retry.result.result.globalStopGeneration, 1)
  const again = stopAll(retry.result.state, { commandId: 'c2', payloadHash: 'p2' })
  assert.equal(again.result.result.globalStopGeneration, 2)
  control = again.result.state
  // 甲持旧代次放行:checkExecutionPermission 拒绝
  const created = createTask({ taskId: 'tA', title: '甲', projectWorkspaceId: 'w', definition: { goal: 'g' }, now })
  let agg = authorizeTask(created.result, { sourceMessageRef: { sessionId: 's', messageId: 'm' } }).result.aggregate
  agg = { ...agg, control: { ...agg.control, state: 'active', allowedGlobalGeneration: 1 } }
  const denied = checkExecutionPermission(agg, control, { workItemId: 'w1', phase: 'implement', actorRole: 'executor' })
  assert.equal(denied.ok, false)
  assert.equal(denied.code, ERROR_CODES.TASK_PAUSED)
})

// ── B6:全局停止可解除,新任务恢复派发;recordRun 不再留不可达的自动放行 ──────
test('B6: 全局停止经 resumeAll 解除后新任务可派发,同命令幂等', async () => {
  let control = createGlobalControl(now)
  control = stopAll(control, { commandId: 'stop-b6', payloadHash: 'p' }).result.state
  assert.equal(control.globalStopped, true)
  const created = createTask({ taskId: 't-b6', title: '新任务', projectWorkspaceId: 'w-b6', definition: { goal: 'g' }, now })
  let agg = defineWorkItem(created.result, { workItemId: 'w1', title: '子项' }).result.aggregate
  agg = authorizeTask(agg, { sourceMessageRef: { sessionId: 's', messageId: 'm' } }).result.aggregate
  const denied = checkExecutionPermission(agg, control, { workItemId: 'w1', phase: 'implement', actorRole: 'executor' })
  assert.equal(denied.code, ERROR_CODES.TASK_PAUSED)
  // 许可检查拒绝后 recordRun 不得暗中提升放行代次(旧自动放行分支在许可之后不可达,已删除)
  const recorded = recordRun(agg, {
    runId: 'r-b6', workItemId: 'w1', phase: 'implement', actorRole: 'executor',
    sessionId: 's-b6', requestId: 'req-b6', slotKey: 'slot-b6', globalControl: control,
  })
  assert.ok(recorded.ok, recorded.message)
  assert.equal(recorded.result.aggregate.control.allowedGlobalGeneration, 0)
  const resumed = resumeAll(control, { commandId: 'resume-b6', payloadHash: 'p' })
  assert.ok(resumed.ok, resumed.message)
  assert.equal(resumed.result.state.globalStopped, false)
  assert.equal(resumed.result.result.globalStopGeneration, control.globalStopGeneration, '解除不新增停止代次')
  const allowed = checkExecutionPermission(agg, resumed.result.state, { workItemId: 'w1', phase: 'implement', actorRole: 'executor' })
  assert.ok(allowed.ok, allowed.message)
  const replay = resumeAll(resumed.result.state, { commandId: 'resume-b6', payloadHash: 'p' })
  assert.equal(replay.result.replayed, true)
  assert.equal(replay.result.result.globalStopGeneration, resumed.result.result.globalStopGeneration)
})

test('DATA-15: usageCoverage 语义字段存在于 Run 记录', async () => {
  let agg = await makeReadyTask()
  agg = dispatchRun(agg, { runId: 'r1' })
  assert.equal(agg.runs.r1.tokenTotal, null)
  assert.equal(agg.runs.r1.usageCoverage, 'unknown')
})

test('LIFE: 定义失效停止在途,新授权回 ready,控制暂停不自动解除', async () => {
  let agg = await makeReadyTask()
  agg = dispatchRun(agg, { runId: 'r1' })
  const revised = reviseDefinition(agg, { definition: { goal: 'g2', acceptanceCriteria: [{ criterionId: 'c1', text: '新标准' }] } })
  agg = revised.result.aggregate
  assert.equal(agg.businessState, 'blocked')
  assert.equal(agg.control.state, 'stopping')
  assert.equal(agg.authorization, null)
  const confirmed = confirmStopped(agg)
  assert.ok(confirmed.ok, confirmed.message)
  agg = confirmed.result.aggregate
  assert.equal(agg.control.state, 'paused')
  const reauth = authorizeTask(agg, { sourceMessageRef: { sessionId: 's', messageId: 'm2' } })
  assert.ok(reauth.ok, reauth.message)
  assert.equal(reauth.result.aggregate.businessState, 'ready')
  assert.equal(reauth.result.aggregate.control.state, 'paused', '新授权不清控制暂停')
})

test('停止→恢复核对→确认放行:新 epoch 与当前全局代次单项许可', async () => {
  let agg = await makeReadyTask()
  const stopped = stopTask(agg)
  agg = stopped.result.aggregate
  assert.equal(agg.control.state, 'paused')
  const req = requestResume(agg, { resumeIntentId: 'ri1', sourceMessageRef: { sessionId: 's', messageId: 'm4' }, expectedExecutionEpoch: agg.control.executionEpoch, globalStopGeneration: 0 })
  assert.ok(req.ok, req.message)
  agg = req.result.aggregate
  assert.equal(agg.control.state, 'reconciling')
  const confirmed = confirmResume(agg, { resumeIntentId: 'ri1', globalStopGeneration: 0 })
  assert.ok(confirmed.ok, confirmed.message)
  agg = confirmed.result.aggregate
  assert.equal(agg.control.state, 'active')
  assert.equal(agg.control.executionEpoch, (stopped.result.aggregate.control.executionEpoch) + 1)
  assert.equal(agg.control.allowedGlobalGeneration, 0)
})

// ── F05: 依赖准入与判环 ─────────────────────────────────────────────────────
test('Given 实施后又修复 When 依赖项用旧 pass 准入 Then 拒绝;重新验收后放行', async () => {
  let agg = await makeReadyTask()
  agg = defineWorkItem(agg, { workItemId: 'w2', title: '后继项', requiredCriterionIds: ['c1'], dependencyWorkItemIds: ['w1'] }).result.aggregate
  // w1 实施 → 独立验收 pass(artRevision=1)
  agg = dispatchRun(agg, { runId: 'impl1', sessionId: 's-impl-1' })
  agg = submitReport(agg, { reportId: 'rep-impl-1', runId: 'impl1', summary: '实施', verdict: 'ready_for_review' }).result.aggregate
  agg = dispatchRun(agg, { runId: 'review1', phase: 'accept', actorRole: 'reviewer', sessionId: 's-review-1' })
  agg = submitReport(agg, { reportId: 'rep-review-1', runId: 'review1', summary: '通过', verdict: 'pass', coveredCriterionIds: ['c1'] }).result.aggregate
  assert.equal(dependencyAccepted(agg, 'w1'), true)
  const control = { globalStopped: false, globalStopGeneration: 0 }
  assert.equal(checkExecutionPermission(agg, control, { workItemId: 'w2', phase: 'implement', actorRole: 'executor' }).ok, true)
  // 再执行一次修复(artRevision=2):旧 pass 变成陈旧验收
  agg = dispatchRun(agg, { runId: 'fix1', phase: 'fix', sessionId: 's-fix-1' })
  agg = submitReport(agg, { reportId: 'rep-fix-1', runId: 'fix1', summary: '修复', verdict: 'ready_for_review' }).result.aggregate
  assert.equal(dependencyAccepted(agg, 'w1'), false, '旧产物代次的 pass 不算有效验收')
  assert.equal(effectiveAcceptance(agg, agg.reports['rep-review-1']), false)
  const blocked = checkExecutionPermission(agg, control, { workItemId: 'w2', phase: 'implement', actorRole: 'executor' })
  assert.equal(blocked.ok, false)
  assert.equal(blocked.code, ERROR_CODES.DEPENDENCY_BLOCKED)
  assert.equal(closeTask(agg, { passReportId: 'rep-review-1' }).ok, false, '结案与准入同一判据')
  // 对当前产物重新独立验收后放行
  agg = dispatchRun(agg, { runId: 'review2', phase: 'accept', actorRole: 'reviewer', sessionId: 's-review-2' })
  agg = submitReport(agg, { reportId: 'rep-review-2', runId: 'review2', summary: '复审通过', verdict: 'pass', coveredCriterionIds: ['c1'] }).result.aggregate
  assert.equal(dependencyAccepted(agg, 'w1'), true)
  assert.equal(effectiveAcceptance(agg, agg.reports['rep-review-2']), true)
  assert.equal(checkExecutionPermission(agg, control, { workItemId: 'w2', phase: 'implement', actorRole: 'executor' }).ok, true)
})

test('Given 无时钟注入 When 失联判定 Then 不猜测为已断', () => {
  const run = { runId: 'r1', state: 'running', recordedAt: 0 }
  assert.equal(isStaleRun(run, {}), false)
  assert.equal(isStaleRun(run, { now: RUN_STALE_MS + 1 }), true)
  assert.equal(isStaleRun({ ...run, lastEventAt: RUN_STALE_MS }, { now: RUN_STALE_MS + 1 }), false)
  assert.equal(isStaleRun({ ...run, state: 'settled' }, { now: RUN_STALE_MS + 1 }), false)
})

test('Given 失联 Run When 收敛 Then 只收敛在飞 Run 且清空执行槽', async () => {
  let agg = await makeReadyTask()
  agg = dispatchRun(agg, { runId: 'r1', sessionId: 's1' })
  agg = { ...agg, runs: { ...agg.runs, r1: { ...agg.runs.r1, state: 'running', recordedAt: 0, lastEventAt: 1 }, r2: { ...agg.runs.r1, runId: 'r2', state: 'settled' } } }
  const expired = expireStaleRuns(agg, { now: RUN_STALE_MS + 2 })
  assert.ok(expired.ok)
  assert.deepEqual(expired.result.expired, ['r1'])
  assert.equal(expired.result.aggregate.runs.r1.state, 'interrupted')
  assert.equal(expired.result.aggregate.runs.r1.stopObserved, 'unreachable')
  assert.equal(expired.result.aggregate.runs.r2.state, 'settled')
  assert.equal(hasActiveRuns(expired.result.aggregate), false)
  const fresh = expireStaleRuns(agg, { now: 2 })
  assert.deepEqual(fresh.result.expired, [])
})

test('Given 失联 Run 有已观察用量 When 收敛 Then 用量并入台账不丢失', async () => {
  let agg = await makeReadyTask()
  agg = dispatchRun(agg, { runId: 'r1', sessionId: 's1' })
  agg = { ...agg, runs: { ...agg.runs, r1: { ...agg.runs.r1, state: 'running', recordedAt: 0, lastEventAt: 1, observedUsage: { 's1:3': { inputTokens: 100, outputTokens: 20, cacheReadTokens: 0, cacheWriteTokens: 0, model: 'm' } } } } }
  const expired = expireStaleRuns(agg, { now: RUN_STALE_MS + 2 })
  const run = expired.result.aggregate.runs.r1
  assert.equal(run.tokenTotal, 120)
  assert.equal(run.usageCoverage, 'complete')
  assert.equal(run.observedUsage, undefined)
  assert.equal(expired.result.aggregate.usageLedger['s1:3'].tokens, 120)
})

test('F05: 缺失/未验收依赖拒绝派发;依赖验收后放行', async () => {
  let agg = await makeReadyTask()
  // 依赖引用可前向声明(缺失不拒定义),但派发时拒绝
  const w2 = defineWorkItem(agg, { workItemId: 'w2', title: '前置项', requiredCriterionIds: ['c1'] })
  assert.ok(w2.ok, w2.message)
  agg = w2.result.aggregate
  const w1 = defineWorkItem(agg, { workItemId: 'w1d', title: '后继项', requiredCriterionIds: ['c1'], dependencyWorkItemIds: ['w2'] })
  assert.ok(w1.ok, w1.message)
  agg = w1.result.aggregate
  const control = { globalStopped: false, globalStopGeneration: 0 }
  // w1 的依赖 w2 未验收:拒绝派发
  const denied = checkExecutionPermission(agg, control, { workItemId: 'w1d', phase: 'implement', actorRole: 'executor' })
  assert.equal(denied.ok, false)
  assert.equal(denied.code, 'DEPENDENCY_BLOCKED')
  // 替换 w2 → 依赖已替换,同样拒绝
  const replaced = replaceWorkItem(agg, { oldWorkItemId: 'w2', newWorkItemId: 'w2r', title: '前置项二', requiredCriterionIds: ['c1'], reason: '重构' })
  assert.ok(replaced.ok, replaced.message)
  const deniedReplaced = checkExecutionPermission(replaced.result.aggregate, control, { workItemId: 'w1d', phase: 'implement', actorRole: 'executor' })
  assert.equal(deniedReplaced.ok, false)
  assert.equal(deniedReplaced.code, 'DEPENDENCY_BLOCKED')
})

test('F05: 合法菱形可定义,真回边拒绝', async () => {
  let agg = await makeReadyTask()
  // 菱形:b、c 共依赖 a,d 依赖 b/c — 定义过程不触发判环
  for (const [id, deps] of [['a', []], ['b', ['a']], ['c', ['a']], ['d', ['b', 'c']]]) {
    const r = defineWorkItem(agg, { workItemId: id, title: '菱形' + id, requiredCriterionIds: ['c1'], dependencyWorkItemIds: deps })
    assert.ok(r.ok, `${id} 定义失败: ${r.message}`)
    agg = r.result.aggregate
  }
  // 真回边:新项依赖 d 不成环(前向合法);但依赖链已含 d→b→a 的图里,
  // 再定义 e 依赖 a 且让 d 依赖 e 不可表达(defineWorkItem 只创建不修改);
  // 回边判定以"新边经依赖链可达自身"验证:q 依赖 d 且 d 已依赖链回 q 不可能,
  // 改以闭环创建验证:p1 依赖 p2、p2 依赖 p1 中第二条定义时 p1 已在图内,可达自身
  const p1 = defineWorkItem(agg, { workItemId: 'p1', title: '环一', requiredCriterionIds: ['c1'], dependencyWorkItemIds: ['p2'] })
  assert.ok(p1.ok, 'p2 未定义时 p1 前向声明合法')
  agg = p1.result.aggregate
  const p2 = defineWorkItem(agg, { workItemId: 'p2', title: '环二', requiredCriterionIds: ['c1'], dependencyWorkItemIds: ['p1'] })
  assert.equal(p2.ok, false, 'p2→p1→p2 闭环在第二条定义时判环拒绝')
  assert.equal(p2.code, 'DEPENDENCY_BLOCKED')
})

// ── R11 终态 Run 的 endedAt:启动过记收口时刻,从未启动显式 null ──────────────
test('Given 失联 Run 已有 startedAt When 收敛 Then endedAt 为收口观测时刻(非 undefined)', async () => {
  let agg = await makeReadyTask()
  agg = dispatchRun(agg, { runId: 'r1', sessionId: 's1' })
  agg = { ...agg, runs: { ...agg.runs, r1: { ...agg.runs.r1, state: 'running', startedAt: 500, lastEventAt: 600 } } }
  const at = RUN_STALE_MS + 700
  const expired = expireStaleRuns(agg, { now: at })
  const run = expired.result.aggregate.runs.r1
  assert.equal(run.endedAt, at, '收口时刻须可读,否则墙钟与"已结束"状态自相矛盾')
  assert.equal(Object.hasOwn(run, 'endedAt'), true, '键必须存在(undefined 落盘会整键消失)')
})

test('Given 失联 Run 从未启动 When 收敛 Then endedAt 显式为 null', async () => {
  let agg = await makeReadyTask()
  agg = dispatchRun(agg, { runId: 'r1', sessionId: 's1' })
  agg = { ...agg, runs: { ...agg.runs, r1: { ...agg.runs.r1, state: 'prepared', startedAt: undefined, lastEventAt: 1 } } }
  const expired = expireStaleRuns(agg, { now: RUN_STALE_MS + 2 })
  assert.equal(expired.result.aggregate.runs.r1.endedAt, null)
  assert.equal(Object.hasOwn(expired.result.aggregate.runs.r1, 'endedAt'), true)
})

// ── B4:已有效验收的子项不得重复实施(重复实施会推进产物代次、作废验收) ──────
test('B4: 已有效验收 When 再次派发 implement Then 显式拒绝', async () => {
  let agg = await makeReadyTask()
  agg = dispatchRun(agg, { runId: 'impl', phase: 'implement', actorRole: 'executor', sessionId: 's1' })
  agg = dispatchRun(agg, { runId: 'rev', phase: 'accept', actorRole: 'reviewer', sessionId: 's2' })
  const reviewed = submitReport(agg, { reportId: 'pass1', runId: 'rev', verdict: 'pass', summary: '通过', coveredCriterionIds: ['c1'], issues: [], evidence: ['e'] })
  assert.ok(reviewed.ok, reviewed.message)
  agg = reviewed.result.aggregate
  assert.ok(acceptedReportForProbe(agg), '前置:子项应有有效验收')
  const again = checkExecutionPermission(agg, { globalStopped: false, globalStopGeneration: 0 }, { workItemId: 'w1', phase: 'implement', actorRole: 'executor' })
  assert.equal(again.ok, false)
  assert.equal(again.code, ERROR_CODES.INVALID_ARGUMENT)
  assert.match(again.message, /已.*验收.*无需重复实施/)
})

function acceptedReportForProbe(agg) {
  return Object.values(agg.reports).some((report) => effectiveAcceptance(agg, report))
}

// ── W2:workItem 依赖类型、存在性与撤回校验 ──────────────────────────────────
test('W2: 依赖须为字符串数组且存在未撤回,replace 不得依赖已撤回项', async () => {
  let agg = await makeReadyTask()
  const stringDeps = defineWorkItem(agg, { workItemId: 'w2', title: '字符串依赖', dependencyWorkItemIds: 'w1' })
  assert.equal(stringDeps.ok, false)
  assert.equal(stringDeps.code, ERROR_CODES.INVALID_ARGUMENT)
  assert.match(stringDeps.message, /字符串数组/)
  const forward = defineWorkItem(agg, { workItemId: 'w2', title: '前向声明', dependencyWorkItemIds: ['later'] })
  assert.ok(forward.ok, '定义阶段允许前向声明依赖(F05 契约)')
  const replaced = replaceWorkItem(agg, { oldWorkItemId: 'w1', newWorkItemId: 'w3', title: '替代项', reason: '范围调整' })
  assert.ok(replaced.ok, replaced.message)
  agg = replaced.result.aggregate
  const missing = replaceWorkItem(agg, {
    oldWorkItemId: 'w3', newWorkItemId: 'w6', title: '缺失依赖的替代', dependencyWorkItemIds: ['nope'], reason: 'r1',
  })
  assert.equal(missing.ok, false)
  assert.equal(missing.code, ERROR_CODES.INVALID_ARGUMENT)
  assert.match(missing.message, /不存在/)
  const withdrawn = defineWorkItem(agg, { workItemId: 'w4', title: '撤回依赖', dependencyWorkItemIds: ['w1'] })
  assert.equal(withdrawn.ok, false)
  assert.equal(withdrawn.code, ERROR_CODES.INVALID_ARGUMENT)
  assert.match(withdrawn.message, /已撤回/)
  const replaceWithWithdrawn = replaceWorkItem(agg, {
    oldWorkItemId: 'w3', newWorkItemId: 'w5', title: '带撤回依赖的替代', dependencyWorkItemIds: ['w1'], reason: 'r2',
  })
  assert.equal(replaceWithWithdrawn.ok, false)
  assert.equal(replaceWithWithdrawn.code, ERROR_CODES.INVALID_ARGUMENT)
  assert.match(replaceWithWithdrawn.message, /已撤回/)
})

// ── W6:resumeIntent 同 ID 指纹冲突 ──────────────────────────────────────────
test('W6: resumeIntent 同 ID 同内容重放,异 source 冲突', async () => {
  const agg = await makeReadyTask()
  const args = {
    resumeIntentId: 'ri-w6', sourceMessageRef: { sessionId: 's', messageId: 'm1' },
    expectedExecutionEpoch: agg.control.executionEpoch, globalStopGeneration: 0,
  }
  const first = requestResume(agg, args)
  assert.ok(first.ok, first.message)
  const revision = first.result.aggregate.recordRevision
  const replay = requestResume(first.result.aggregate, args)
  assert.ok(replay.ok, replay.message)
  assert.equal(replay.result.replayed, true)
  assert.equal(replay.result.aggregate.recordRevision, revision, '同内容重放不得改写记录')
  const conflict = requestResume(first.result.aggregate, { ...args, sourceMessageRef: { sessionId: 's', messageId: 'm2' } })
  assert.equal(conflict.ok, false)
  assert.equal(conflict.code, ERROR_CODES.IDEMPOTENCY_CONFLICT)
})

// ── W3-3:结案收敛恢复意图与控制面,completed 不可再恢复 ──────────────────────
test('W3-3: 结案作废恢复意图并收敛控制态,终态拒绝 request/confirm resume', async () => {
  let agg = await makeReadyTask()
  agg = dispatchRun(agg, { runId: 'impl', sessionId: 's-impl' })
  agg = submitReport(agg, { reportId: 'rep-impl', runId: 'impl', verdict: 'ready_for_review', summary: '交付', coveredCriterionIds: ['c1'], issues: [], evidence: [] }).result.aggregate
  agg = dispatchRun(agg, { runId: 'rev', phase: 'accept', actorRole: 'reviewer', sessionId: 's-rev' })
  agg = submitReport(agg, { reportId: 'pass1', runId: 'rev', verdict: 'pass', summary: '通过', coveredCriterionIds: ['c1'], issues: [], evidence: [] }).result.aggregate
  const requested = requestResume(agg, {
    resumeIntentId: 'ri1', sourceMessageRef: { sessionId: 's', messageId: 'm' },
    expectedExecutionEpoch: agg.control.executionEpoch, globalStopGeneration: 0,
  })
  assert.ok(requested.ok, requested.message)
  agg = requested.result.aggregate
  assert.equal(agg.resumeIntents.ri1.status, 'pending')
  assert.equal(agg.control.state, 'active', '活动任务的恢复意图只登记,不改控制态')
  const closed = closeTask(agg, { passReportId: 'pass1', conclusion: '验收通过' })
  assert.ok(closed.ok, closed.message)
  const done = closed.result.aggregate
  assert.equal(done.businessState, 'completed')
  assert.equal(done.control.state, 'paused')
  assert.equal(done.control.stopDetail, null)
  assert.equal(done.control.resumeIntentId, null)
  assert.equal(done.resumeIntents.ri1.status, 'void', '结案须作废待恢复意图')
  const revived = confirmResume(done, { resumeIntentId: 'ri1', globalStopGeneration: 0 })
  assert.equal(revived.ok, false, 'completed 不得被旧意图恢复')
  assert.match(revived.message, /终态/)
  const lateRequest = requestResume(done, {
    resumeIntentId: 'ri2', sourceMessageRef: { sessionId: 's', messageId: 'm2' },
    expectedExecutionEpoch: done.control.executionEpoch, globalStopGeneration: 0,
  })
  assert.equal(lateRequest.ok, false, 'completed 不得再登记恢复意图')
  assert.match(lateRequest.message, /终态/)
})

// ── B4:replace 后结案只要求未撤回项;撤回项不得派发 ──────────────────────────
test('B4: 替代后结案只要求未撤回项,撤回项拒绝派发', async () => {
  let agg = await makeReadyTask()
  const replaced = replaceWorkItem(agg, {
    oldWorkItemId: 'w1', newWorkItemId: 'w2', title: '替代项', requiredCriterionIds: ['c1'], reason: '范围调整',
  })
  assert.ok(replaced.ok, replaced.message)
  agg = replaced.result.aggregate
  const control = { globalStopped: false, globalStopGeneration: 0 }
  const denied = checkExecutionPermission(agg, control, { workItemId: 'w1', phase: 'implement', actorRole: 'executor' })
  assert.equal(denied.ok, false, '撤回项不得通过派发许可')
  assert.equal(denied.code, ERROR_CODES.INVALID_ARGUMENT)
  assert.match(denied.message, /已撤回/)
  agg = dispatchRun(agg, { runId: 'impl2', workItemId: 'w2', sessionId: 's-impl' })
  agg = submitReport(agg, { reportId: 'rep-impl2', runId: 'impl2', verdict: 'ready_for_review', summary: '交付', coveredCriterionIds: ['c1'], issues: [], evidence: [] }).result.aggregate
  agg = dispatchRun(agg, { runId: 'rev2', workItemId: 'w2', phase: 'accept', actorRole: 'reviewer', sessionId: 's-review' })
  const pass = submitReport(agg, { reportId: 'pass2', runId: 'rev2', verdict: 'pass', summary: '通过', coveredCriterionIds: ['c1'], issues: [], evidence: [] })
  assert.ok(pass.ok, pass.message)
  const closed = closeTask(pass.result.aggregate, { passReportId: 'pass2' })
  assert.ok(closed.ok, closed.message)
  assert.equal(closed.result.aggregate.businessState, 'completed')
})
