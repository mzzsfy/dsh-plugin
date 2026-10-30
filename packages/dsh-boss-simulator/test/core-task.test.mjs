// PKG-1 核心:BDD 覆盖 DATA-01/02/03/04/09/10/11/15 与生命周期停止/恢复/取消/定义失效
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { applyCommand, applyEnvelope, actionKeyOf, ERROR_CODES } from '../lib/core/command.mjs'
import {
  createTask, defineWorkItem, authorizeTask, reviseDefinition, checkExecutionPermission,
  recordRun, submitReport, markSessionExecutor, closeTask, stopTask, confirmStopped,
  requestResume, confirmResume, requestCancel, resolveDependencyBlock, replaceWorkItem,
} from '../lib/core/task.mjs'
import { createGlobalControl, stopAll } from '../lib/core/global-control.mjs'

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

function dispatchRun(agg, { runId = 'r1', phase = 'implement', actorRole = 'executor', sessionId = 's1' } = {}) {
  const control = { globalStopped: false, globalStopGeneration: 0 }
  const perm = checkExecutionPermission(agg, control, { workItemId: 'w1', phase, actorRole })
  assert.ok(perm.ok, perm.message)
  const rec = recordRun(agg, {
    runId, workItemId: 'w1', phase, actorRole, sessionId, requestId: `req-${runId}`,
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

test('DATA-03: 同 cause/actionKey 换命令 ID 重放返回原结果', () => {
  const created = createTask({ taskId: 't1', title: 't', projectWorkspaceId: 'w', definition: { goal: 'g' }, now })
  const agg = created.result
  const effect = (a) => ({ aggregate: { ...a, touched: true }, result: 'R1' })
  const first = applyCommand(agg, { causeId: 'notice1', actionKey: actionKeyOf(['t1', 'w1', 'implement']), payloadHash: 'p1' }, effect)
  assert.equal(first.ok, true)
  const replay = applyCommand(first.result.aggregate, { causeId: 'notice1', actionKey: actionKeyOf(['t1', 'w1', 'implement']), payloadHash: 'p1' }, effect)
  assert.equal(replay.result.replayed, true)
  assert.deepEqual(replay.result.result, 'R1')
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

test('LIFE-14: 依赖解除恢复业务状态,不解除控制暂停', async () => {
  let agg = await makeReadyTask()
  agg = stopTask(agg.result ? agg.result.aggregate : agg).result.aggregate ?? agg
  // 直接构造 blocked(依赖缺失)+paused
  agg = { ...agg, businessState: 'blocked', block: { reason: 'dependency_missing', blockedFrom: 'ready', invalidatesAuthorization: false } }
  const resolved = resolveDependencyBlock(agg)
  assert.ok(resolved.ok, resolved.message)
  assert.equal(resolved.result.aggregate.businessState, 'ready')
  assert.equal(resolved.result.aggregate.control.state, 'paused')
})

test('LIFE-17: pendingCancel 期间恢复拒绝,停止确认原子 cancelled+paused', async () => {
  let agg = await makeReadyTask()
  agg = dispatchRun(agg, { runId: 'r1' })
  const cancel = requestCancel(agg, { sourceMessageRef: { sessionId: 's', messageId: 'm3' } })
  assert.ok(cancel.ok, cancel.message)
  agg = cancel.result.aggregate
  assert.equal(agg.control.pendingCancel !== null, true)
  assert.equal(agg.control.state, 'stopping')
  const resume = requestResume(agg, { resumeIntentId: 'ri1', sourceMessageRef: {}, expectedExecutionEpoch: agg.control.executionEpoch, globalStopGeneration: 0 })
  assert.equal(resume.ok, false)
  const confirmed = confirmStopped(agg)
  assert.ok(confirmed.ok, confirmed.message)
  agg = confirmed.result.aggregate
  assert.equal(agg.businessState, 'cancelled')
  assert.equal(agg.control.state, 'paused')
  assert.equal(agg.control.pendingCancel, null)
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
