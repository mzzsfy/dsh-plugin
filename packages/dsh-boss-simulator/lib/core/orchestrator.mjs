// PKG-2 受管会话编排:执行/停止闭环。组合 core 状态机与 sessionAdapter;
// 入口驱动"实施→独立验收→结案→中断恢复"链,不做角色自主调度。
import { applyCommand, actionKeyOf } from './command.mjs'
import {
  checkExecutionPermission, recordRun, hasActiveRuns,
  stopTask, confirmStopped, requestResume, confirmResume,
} from './task.mjs'

// 派发:许可校验→会话确保→prompt 受理→Run 落盘;受理失败 Run 标 rejected
export async function dispatchRun(store, aggregate, { runId, workItemId, phase, actorRole, requestId, content, sessionAdapter, globalControl, sessionWorkspaceId, sessionCwd }) {
  const perm = checkExecutionPermission(aggregate, globalControl, { workItemId, phase, actorRole })
  if (!perm.ok) return perm
  // 会话落点:显式指定优先,缺省跟随任务工作区(CAP-01: 不改普通 workspace)
  const sessionTarget = sessionCwd !== undefined ? { cwd: sessionCwd } : { workspaceId: sessionWorkspaceId ?? aggregate.projectWorkspaceId }
  let prompt
  let sessionId
  try {
    const session = await sessionAdapter.ensureSession(sessionTarget)
    sessionId = session.sessionId
    const reportInstruction = JSON.stringify({
      runId,
      phase,
      actorRole,
      requiredCriterionIds: aggregate.workItems[workItemId]?.requiredCriterionIds ?? [],
      schema: { summary: 'non-empty string', verdict: actorRole === 'reviewer' ? ['pass', 'issues'] : ['ready_for_review', 'needs_help'], coveredCriterionIds: 'unique non-empty string[]', issues: 'string[] of non-empty items', evidence: 'string[] of non-empty items' },
    })
    const instruction = `完成当前阶段后，将最终结构化结果作为单独 JSON 文本消息提交，不要附加 Markdown。报告上下文：${reportInstruction}`
    const blocks = typeof content === 'string'
      ? [{ type: 'text', text: `${content}\n\n${instruction}` }]
      : [...content, { type: 'text', text: instruction }]
    prompt = await sessionAdapter.dispatchPrompt({ sessionId, requestId, content: blocks })
  } catch (error) {
    return { ok: false, code: 'DISPATCH_FAILED', message: String(error?.message ?? error), stack: error?.stack, runId }
  }
  if (!prompt?.accepted) {
    const rejected = recordRun(aggregate, { runId, workItemId, phase, actorRole, sessionId, requestId, slotKey: perm.result.slotKey, globalControl }).result.aggregate
    return { ok: false, code: prompt?.code ?? 'PROMPT_REJECTED', message: prompt?.message ?? '投递被拒绝', aggregate: { ...rejected, runs: markRun(rejected.runs, runId, 'rejected') } }
  }
  const outcome = applyCommand(
    aggregate,
    { causeId: requestId, actionKey: actionKeyOf(['run.dispatch', aggregate.taskId, workItemId, phase]), payloadHash: JSON.stringify({ runId, sessionId, requestId }) },
    (agg) => {
      const recorded = recordRun(agg, { runId, workItemId, phase, actorRole, sessionId, requestId, slotKey: perm.result.slotKey, globalControl })
      return { aggregate: { ...recorded.result.aggregate, runs: markRun(recorded.result.aggregate.runs, runId, 'submitted') }, result: { runId, sessionId, turnId: prompt.turnId ?? null } }
    },
  )
  return outcome.ok ? { ok: true, ...outcome.result.result, aggregate: outcome.result.aggregate } : outcome
}

export function parseRunReport(content, run) {
  const text = Array.isArray(content) ? content.filter((block) => block?.type === 'text').map((block) => block.text).join('\n').trim() : ''
  if (!text) return { ok: false, message: 'assistant 消息没有文本报告' }
  if (!run || typeof run !== 'object') return { ok: false, message: 'Run 上下文缺失' }
  let report
  try { report = JSON.parse(text) } catch { return { ok: false, message: 'assistant 报告不是合法 JSON' } }
  if (!report || typeof report !== 'object' || Array.isArray(report)) return { ok: false, message: '报告必须为 JSON 对象' }
  const keys = Object.keys(report).sort()
  const expected = ['coveredCriterionIds', 'evidence', 'issues', 'summary', 'verdict']
  if (JSON.stringify(keys) !== JSON.stringify(expected)) return { ok: false, message: '报告字段不符合 schema' }
  if (typeof report.summary !== 'string' || !report.summary.trim()) return { ok: false, message: '报告 summary 必填' }
  if (!Array.isArray(report.coveredCriterionIds) || !report.coveredCriterionIds.every((id) => typeof id === 'string' && id.trim()) || new Set(report.coveredCriterionIds).size !== report.coveredCriterionIds.length) return { ok: false, message: 'coveredCriterionIds 必须为无重复非空字符串数组' }
  if (!Array.isArray(report.issues) || !report.issues.every((issue) => typeof issue === 'string' && issue.trim())) return { ok: false, message: 'issues 必须为非空字符串数组' }
  if (!Array.isArray(report.evidence) || !report.evidence.every((item) => typeof item === 'string' && item.trim())) return { ok: false, message: 'evidence 必须为非空字符串数组' }
  const reviewer = run.phase === 'accept' || (run.phase === 'integrate' && run.actorRole === 'reviewer')
  const executor = run.actorRole === 'executor' && ['implement', 'fix', 'integrate'].includes(run.phase)
  const validPhaseRole = reviewer ? run.actorRole === 'reviewer' : executor
  if (!validPhaseRole) return { ok: false, message: 'Run 阶段与角色不匹配' }
  const requiredCriteria = run.requiredCriterionIds ?? []
  const allowedVerdicts = reviewer ? ['pass', 'issues'] : ['ready_for_review', 'needs_help']
  if (!allowedVerdicts.includes(report.verdict)) return { ok: false, message: 'verdict 与运行阶段不匹配' }
  if (report.verdict === 'pass' && report.issues.length) return { ok: false, message: 'pass 报告不能包含 issues' }
  if (reviewer && requiredCriteria.length > 0 && requiredCriteria.some((id) => !report.coveredCriterionIds.includes(id))) return { ok: false, message: '验收报告必须覆盖全部必需标准' }
  return { ok: true, report }
}

function markRun(runs, runId, state) {
  return { ...runs, [runId]: { ...runs[runId], state } }
}

// 事件归并:回合边界只记录执行状态,不推导报告或业务验收事实。
export function applySessionEvent(aggregate, { runId, type, at }) {
  const run = aggregate.runs[runId]
  if (!run) return { ok: false, code: 'NOT_FOUND', message: `Run 不存在: ${runId}` }
  const transitions = {
    'prompt.accepted': 'submitted',
    'turn.start': 'running',
    'turn.end': run.state === 'running' ? 'running' : run.state,
  }
  const next = transitions[type]
  if (next === undefined) return { ok: false, code: 'INVALID_ARGUMENT', message: `未知事件类型: ${type}` }
  if (next === run.state) return { ok: true, replayed: true, aggregate }
  return { ok: true, aggregate: { ...aggregate, runs: { ...aggregate.runs, [runId]: { ...run, state: next, startedAt: type === 'turn.start' ? (at ?? run.startedAt) : run.startedAt } } } }
}

// 停止许可先落盘;取消受理与运行体停止分别记录。
export async function interruptTask(store, aggregate, { sessionAdapter, reason = 'user_interrupt', commandId } = {}) {
  let failure
  let replayReceipt
  const stopped = await store.updateAggregate(aggregate.taskId, (current) => {
    if (commandId && current.control.stopCommandIds?.[commandId]) {
      replayReceipt = current.control.stopCommandIds[commandId]
      return current
    }
    if (!commandId && current.control.state === 'stopping') return current
    const outcome = stopTask(current, { reason })
    if (!outcome.ok) { failure = outcome; return current }
    // 即使报告已落库,关联会话仍须核对队列与运行状态。
    const needsInspection = Object.values(current.runs).some((run) => run.state !== 'rejected')
    return { ...outcome.result.aggregate, control: { ...outcome.result.aggregate.control, ...(commandId ? { stopCommandIds: { ...current.control.stopCommandIds, [commandId]: { executionEpoch: outcome.result.aggregate.control.executionEpoch } } } : {}), ...(needsInspection ? { state: 'stopping', stopDetail: 'requesting' } : {}) } }
  })
  if (failure) return failure
  if (replayReceipt && (replayReceipt.stopConfirmed === true || replayReceipt.executionEpoch !== stopped.control.executionEpoch)) return { ok: true, aggregate: stopped, replayed: true, receipt: replayReceipt, stopConfirmed: replayReceipt.stopConfirmed === true, cancelErrors: [] }
  const finish = async (result) => {
    if (!commandId) return result
    const updated = await store.updateAggregate(aggregate.taskId, (current) => ({ ...current, control: { ...current.control, stopCommandIds: { ...current.control.stopCommandIds, [commandId]: { ...current.control.stopCommandIds[commandId], stopConfirmed: result.stopConfirmed, cancelErrors: result.cancelErrors ?? [], reconcileErrors: result.reconcileErrors ?? [] } } } }))
    return { ...result, aggregate: updated }
  }
  const cancelErrors = []
  for (const sessionId of sessionIdsForStop(stopped)) {
    let pendingItemIds = []
    try {
      const inspected = await sessionAdapter.inspectSession({ sessionId })
      pendingItemIds = inspected.pendingItemIds
      if (inspected.running === false && Array.isArray(pendingItemIds) && pendingItemIds.length === 0) continue
    }
    catch (error) { cancelErrors.push({ sessionId, message: String(error?.message ?? error) }) }
    try { await sessionAdapter.cancelSession({ sessionId, pendingItemIds }) }
    catch (error) { cancelErrors.push({ sessionId, message: String(error?.message ?? error) }) }
  }
  if (cancelErrors.length) {
    const updated = await store.updateAggregate(aggregate.taskId, (current) => ({ ...current, control: { ...current.control, stopDetail: 'unconfirmed', stopErrors: cancelErrors }, runs: Object.fromEntries(Object.entries(current.runs).map(([id, run]) => [id, { ...run, stopObserved: 'pending' }])) }))
    return finish({ ok: true, aggregate: updated, cancelErrors, stopConfirmed: false })
  }
  const reconciled = await reconcileStoppedTask(store, aggregate.taskId, sessionAdapter)
  return finish({ ...reconciled, cancelErrors })
}

function sessionIdsForStop(aggregate) {
  return [...new Set(Object.values(aggregate.runs).filter((run) => run.state !== 'rejected').map((run) => run.sessionId))]
}

export async function reconcileStoppedTask(store, taskId, sessionAdapter) {
  const snapshot = await store.loadAggregate(taskId)
  if (!snapshot) return { ok: false, code: 'NOT_FOUND', message: `任务不存在: ${taskId}` }
  if (!['stopping', 'paused', 'reconciling'].includes(snapshot.control.state)) return { ok: false, code: 'TASK_PAUSED', message: '任务尚未进入停止或恢复核对状态', aggregate: snapshot, stopConfirmed: false }
  const inspections = new Map()
  const reconcileErrors = []
  for (const sessionId of sessionIdsForStop(snapshot)) {
    try {
      const observed = await sessionAdapter.inspectSession({ sessionId })
      inspections.set(sessionId, observed)
      if (observed.running !== false || !Array.isArray(observed.pendingItemIds) || observed.pendingItemIds.length) reconcileErrors.push({ sessionId, message: '会话仍运行或队列未清空' })
    } catch (error) { reconcileErrors.push({ sessionId, message: String(error?.message ?? error) }) }
  }
  let stopConfirmed = false
  const aggregate = await store.updateAggregate(taskId, (current) => {
    if (current.control.executionEpoch !== snapshot.control.executionEpoch || !['stopping', 'paused', 'reconciling'].includes(current.control.state) || Object.keys(current.runs).some((id) => !snapshot.runs[id])) return current
    const next = { ...current, control: { ...current.control, stopErrors: reconcileErrors, stopDetail: reconcileErrors.length ? 'unconfirmed' : null }, runs: Object.fromEntries(Object.entries(current.runs).map(([id, run]) => {
      const observed = inspections.get(run.sessionId)
      return [id, { ...run, stopObserved: observed?.running === false && observed.pendingItemIds?.length === 0 ? 'confirmed' : 'pending' }]
    })) }
    if (reconcileErrors.length) return next
    stopConfirmed = true
    if (next.control.state === 'stopping') return confirmStopped(next).result.aggregate
    return next
  })
  return { ok: true, aggregate, stopConfirmed, reconcileErrors }
}

// 只读核对会话事实;恢复核对不得投递新的执行输入。
export async function resumeTask(aggregate, { resumeIntentId, sourceMessageRef, globalStopGeneration, expectedExecutionEpoch, sessionAdapter }) {
  const requested = requestResume(aggregate, { resumeIntentId, sourceMessageRef, expectedExecutionEpoch: expectedExecutionEpoch ?? aggregate.control.executionEpoch, globalStopGeneration })
  if (!requested.ok) return requested
  let current = requested.result.aggregate
  const localStore = { loadAggregate: async () => current, updateAggregate: async (_id, update) => (current = update(current)) }
  const reconciled = await reconcileStoppedTask(localStore, current.taskId, sessionAdapter)
  if (!reconciled.stopConfirmed) return { ok: false, code: 'RECONCILE_FAILED', message: '旧执行会话或队列尚未核清', aggregate: current }
  return confirmResume(current, { resumeIntentId, globalStopGeneration })
}
