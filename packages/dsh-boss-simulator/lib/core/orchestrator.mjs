// PKG-2 受管会话编排:执行/停止闭环。组合 core 状态机与 sessionAdapter;
// 入口驱动"实施→独立验收→结案→中断恢复"链,不做角色自主调度。
import {
  ACTIVE_RUN_STATES, expireStaleRuns, forceStopTask as forceStopAggregate, isStaleRun,
  stopTask, confirmStopped,
} from './task.mjs'
import { isSessionGoneError } from './session-errors.mjs'

// 报告解析:只接受纯 JSON 文本且字段与阶段角色严格匹配,不做容错 stripping。
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
  // 事件时间是失联(stale)判定的唯一依据:无论状态是否变化都要推进
  const lastEventAt = Number.isFinite(at) && at > (run.lastEventAt ?? -Infinity) ? at : run.lastEventAt
  // 终态 Run 只接受活体时间刷新:迟到回合事件不得把 settled/interrupted/rejected 复活成在飞
  if (!ACTIVE_RUN_STATES.has(run.state)) {
    if (lastEventAt === run.lastEventAt) return { ok: true, replayed: true, aggregate }
    return { ok: true, aggregate: { ...aggregate, runs: { ...aggregate.runs, [runId]: { ...run, lastEventAt } } } }
  }
  if (next === run.state && lastEventAt === run.lastEventAt) return { ok: true, replayed: true, aggregate }
  return { ok: true, aggregate: { ...aggregate, runs: { ...aggregate.runs, [runId]: { ...run, state: next, lastEventAt, startedAt: type === 'turn.start' ? (at ?? run.startedAt) : run.startedAt } } } }
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
    // 失联 Run 不需要核对会话:先按已断收敛,停止核对只剩仍新鲜的在飞会话
    const expired = expireStaleRuns(outcome.result.aggregate)
    const settled = expired.result?.aggregate ?? outcome.result.aggregate
    // 即使报告已落库,关联会话仍须核对队列与运行状态。
    const needsInspection = sessionIdsForStop(settled).length > 0
    return { ...settled, control: { ...settled.control, ...(commandId ? { stopCommandIds: { ...current.control.stopCommandIds, [commandId]: { executionEpoch: settled.control.executionEpoch } } } : {}), ...(needsInspection ? { state: 'stopping', stopDetail: 'requesting' } : {}) } }
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
    const observed = await inspectStopState(sessionAdapter, sessionId)
    if (observed.stopped) continue
    if (observed.error) cancelErrors.push(observed.error)
    try { await sessionAdapter.cancelSession({ sessionId, pendingItemIds: observed.pendingItemIds }) }
    catch (error) {
      // 会话在取消瞬间被删除:目标状态已达成,不记为失败
      if (!isSessionGoneError(error)) cancelErrors.push({ sessionId, message: String(error?.message ?? error) })
    }
  }
  if (cancelErrors.length) {
    const updated = await store.updateAggregate(aggregate.taskId, (current) => ({ ...current, control: { ...current.control, stopDetail: 'unconfirmed', stopErrors: cancelErrors }, runs: Object.fromEntries(Object.entries(current.runs).map(([id, run]) => [id, ACTIVE_RUN_STATES.has(run.state) ? { ...run, stopObserved: 'pending' } : run])) }))
    return finish({ ok: true, aggregate: updated, cancelErrors, stopConfirmed: false })
  }
  const reconciled = await reconcileStoppedTask(store, aggregate.taskId, sessionAdapter)
  return finish({ ...reconciled, cancelErrors })
}

// 核对一次会话事实:会话已不存在(宿主删除/从未创建)按"已停"返回——
// 会话不存在即不存在在飞执行体,不是待核对状态;其余错误原样上报,不伪造已停。
async function inspectStopState(sessionAdapter, sessionId) {
  let observed
  try {
    observed = await sessionAdapter.inspectSession({ sessionId })
  } catch (error) {
    if (isSessionGoneError(error)) return { stopped: true, pendingItemIds: [], gone: true }
    return { stopped: false, pendingItemIds: [], error: { sessionId, message: String(error?.message ?? error) } }
  }
  const pendingItemIds = Array.isArray(observed?.pendingItemIds) ? observed.pendingItemIds : []
  return { stopped: observed?.running === false && pendingItemIds.length === 0, pendingItemIds, gone: false }
}

// 只核对仍新鲜的在飞 Run:失联 Run 由 expireStaleRuns 收敛,不再等待不可达会话
function sessionIdsForStop(aggregate) {
  const now = typeof aggregate.now === 'function' ? aggregate.now() : undefined
  // 只核在飞状态:settled/interrupted/rejected 已是终态,会话被删/归档不应
  // 让停止核对永远停在 unconfirmed。
  return [...new Set(Object.values(aggregate.runs)
    .filter((run) => ACTIVE_RUN_STATES.has(run.state) && !isStaleRun(run, { now }))
    .map((run) => run.sessionId))]
}

export async function reconcileStoppedTask(store, taskId, sessionAdapter) {
  const snapshot = await store.loadAggregate(taskId)
  if (!snapshot) return { ok: false, code: 'NOT_FOUND', message: `任务不存在: ${taskId}` }
  if (!['stopping', 'paused', 'reconciling'].includes(snapshot.control.state)) return { ok: false, code: 'TASK_PAUSED', message: '任务尚未进入停止或恢复核对状态', aggregate: snapshot, stopConfirmed: false }
  const inspections = new Map()
  const reconcileErrors = []
  for (const sessionId of sessionIdsForStop(snapshot)) {
    const observed = await inspectStopState(sessionAdapter, sessionId)
    if (observed.error) { reconcileErrors.push(observed.error); continue }
    if (observed.stopped) { inspections.set(sessionId, { running: false, pendingItemIds: [] }); continue }
    inspections.set(sessionId, { running: true, pendingItemIds: observed.pendingItemIds })
    reconcileErrors.push({ sessionId, message: '会话仍运行或队列未清空' })
  }
  let stopConfirmed = false
  const aggregate = await store.updateAggregate(taskId, (current) => {
    if (current.control.executionEpoch !== snapshot.control.executionEpoch || !['stopping', 'paused', 'reconciling'].includes(current.control.state) || Object.keys(current.runs).some((id) => !snapshot.runs[id])) return current
    const expired = expireStaleRuns(current)
    const base = expired.result?.aggregate ?? current
    const next = { ...base, control: { ...base.control, stopErrors: reconcileErrors, stopDetail: reconcileErrors.length ? 'unconfirmed' : null }, runs: Object.fromEntries(Object.entries(base.runs).map(([id, run]) => {
      // 已收敛的终态 Run 保留自己的核对结论(失联收敛的 unreachable 不被覆盖)
      if (!ACTIVE_RUN_STATES.has(run.state)) return [id, run]
      const observed = inspections.get(run.sessionId)
      return [id, { ...run, stopObserved: observed?.running === false && observed.pendingItemIds.length === 0 ? 'confirmed' : 'pending' }]
    })) }
    if (reconcileErrors.length) return next
    stopConfirmed = true
    if (next.control.state === 'stopping') return confirmStopped(next).result.aggregate
    return next
  })
  return { ok: true, aggregate, stopConfirmed, reconcileErrors }
}

// 强制停止/放弃入口:必须显式确认;用于会话不可达且常规核对无出口的任务。
// commandId 走任务内回执:同命令同内容重放不二次 pause/提升 epoch,异内容冲突。
export async function forceStop(store, taskId, { reason = 'force_stop', confirm = false, commandId, payloadHash } = {}) {
  if (confirm !== true) return { ok: false, code: 'CONFIRMATION_REQUIRED', message: '强制停止必须显式确认(confirm: true)' }
  const snapshot = await store.loadAggregate(taskId)
  if (!snapshot) return { ok: false, code: 'NOT_FOUND', message: `任务不存在: ${taskId}` }
  let failure
  let replayed = false
  const aggregate = await store.updateAggregate(taskId, (current) => {
    if (commandId !== undefined) {
      const receipt = current.forceStopReceipts?.[commandId]
      if (receipt) {
        if (receipt.payloadHash !== payloadHash) {
          failure = { ok: false, code: 'IDEMPOTENCY_CONFLICT', message: `相同 commandId 对应不同内容: ${commandId}` }
          return current
        }
        replayed = true
        return current
      }
    }
    const outcome = forceStopAggregate(current, { reason })
    if (!outcome.ok) { failure = outcome; return current }
    let next = outcome.result.aggregate
    if (commandId !== undefined) {
      const result = { accepted: true, forceStopped: true, controlState: next.control.state, pendingStop: false, cancelErrors: [], reconcileErrors: [] }
      next = { ...next, forceStopReceipts: { ...(current.forceStopReceipts ?? {}), [commandId]: { payloadHash, result } } }
    }
    return next
  })
  if (failure) return failure
  return { ok: true, aggregate, stopConfirmed: true, cancelErrors: [], replayed }
}
