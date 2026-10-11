// PKG-2 受管会话编排:执行/停止闭环。组合 core 状态机与 sessionAdapter;
// 入口驱动"实施→独立验收→结案→中断恢复"链,不做角色自主调度。
import { applyCommand, actionKeyOf } from './command.mjs'
import {
  checkExecutionPermission, recordRun, hasActiveRuns,
  stopTask, confirmStopped, requestResume, confirmResume,
} from './task.mjs'

// 派发:许可校验→会话确保→prompt 受理→Run 落盘;受理失败 Run 标 rejected
export async function dispatchRun(store, aggregate, { runId, workItemId, phase, actorRole, requestId, content, presetId, sessionAdapter, globalControl, sessionWorkspaceId, sessionCwd }) {
  const perm = checkExecutionPermission(aggregate, globalControl, { workItemId, phase, actorRole })
  if (!perm.ok) return perm
  // 会话落点:显式指定优先,缺省跟随任务工作区(CAP-01: 不改普通 workspace)
  const sessionTarget = sessionCwd !== undefined ? { cwd: sessionCwd, agentPreset: presetId }
    : { workspaceId: sessionWorkspaceId ?? aggregate.projectWorkspaceId, agentPreset: presetId }
  let prompt
  let sessionId
  try {
    const session = await sessionAdapter.ensureSession(sessionTarget)
    sessionId = session.sessionId
    // prompt content 契约:块数组形态(dsh prompt hasPromptContent)
    const blocks = typeof content === 'string' ? [{ type: 'text', text: content }] : content
    prompt = await sessionAdapter.dispatchPrompt({ sessionId, requestId, content: blocks })
  } catch (error) {
    return { ok: false, code: 'DISPATCH_FAILED', message: String(error?.message ?? error), stack: error?.stack, runId }
  }
  if (!prompt?.accepted) {
    const rejected = recordRun(aggregate, { runId, workItemId, phase, actorRole, sessionId, requestId, presetId, slotKey: perm.result.slotKey, globalControl }).result.aggregate
    return { ok: false, code: prompt?.code ?? 'PROMPT_REJECTED', message: prompt?.message ?? '投递被拒绝', aggregate: { ...rejected, runs: markRun(rejected.runs, runId, 'rejected') } }
  }
  const outcome = applyCommand(
    aggregate,
    { causeId: requestId, actionKey: actionKeyOf(['run.dispatch', aggregate.taskId, workItemId, phase]), payloadHash: JSON.stringify({ runId, sessionId, requestId }) },
    (agg) => {
      const recorded = recordRun(agg, { runId, workItemId, phase, actorRole, sessionId, requestId, presetId, slotKey: perm.result.slotKey, globalControl })
      return { aggregate: { ...recorded.result.aggregate, runs: markRun(recorded.result.aggregate.runs, runId, 'submitted') }, result: { runId, sessionId, turnId: prompt.turnId ?? null } }
    },
  )
  return outcome.ok ? { ok: true, ...outcome.result.result, aggregate: outcome.result.aggregate } : outcome
}

function markRun(runs, runId, state) {
  return { ...runs, [runId]: { ...runs[runId], state } }
}

// 事件归并:turn/end 事件驱动 Run 状态(accepted/running/settled),不凭最终回复断言完成
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

// 单任务中断:先持久化 stopping(epoch+1,旧命令失效),再停会话与队列,确认后 paused;
// cancel accepted 不等于停完,observed 由核对证据填写
export async function interruptTask(store, aggregate, { sessionAdapter, reason = 'user_interrupt' } = {}) {
  const stopped = stopTask(aggregate, { reason })
  if (!stopped.ok) return stopped
  let agg = stopped.result.aggregate
  const activeSessions = [...new Set(Object.values(agg.runs).filter((r) => ['prepared', 'submitted', 'running'].includes(r.state)).map((r) => r.sessionId))]
  for (const run of Object.values(agg.runs)) {
    if (activeSessions.includes(run.sessionId)) agg = markObserved(agg, run.runId, { stopped: false })
  }
  const cancelErrors = []
  for (const sessionId of activeSessions) {
    try {
      const cancel = await sessionAdapter.cancelSession({ sessionId })
      for (const run of Object.values(agg.runs)) {
        if (run.sessionId === sessionId) agg = markObserved(agg, run.runId, cancel)
      }
    } catch (error) {
      cancelErrors.push({ sessionId, message: String(error?.message ?? error) })
    }
  }
  const settled = !hasActiveRuns(agg) || cancelErrors.length === 0
  const confirmed = confirmStopped(agg)
  agg = confirmed.ok ? confirmed.result.aggregate : agg
  return { ok: true, aggregate: agg, cancelErrors, stopConfirmed: confirmed.ok && settled }
}

function markObserved(aggregate, runId, cancel) {
  const run = aggregate.runs[runId]
  return { ...aggregate, runs: { ...aggregate.runs, [runId]: { ...run, stopObserved: cancel?.stopped === true ? 'confirmed' : 'pending' } } }
}// 恢复链:请求→核对入口(只读)→确认放行;核对由控制方在暂停态执行,此处仅状态迁移
export async function resumeTask(aggregate, { resumeIntentId, sourceMessageRef, globalStopGeneration, expectedExecutionEpoch, sessionAdapter, sessionId, probePrompt }) {
  const requested = requestResume(aggregate, { resumeIntentId, sourceMessageRef, expectedExecutionEpoch: expectedExecutionEpoch ?? aggregate.control.executionEpoch, globalStopGeneration })
  if (!requested.ok) return requested
  let agg = requested.result.aggregate
  let reconciliation = { ok: true, sessionId }
  if (probePrompt && sessionId) {
    try {
      await sessionAdapter.dispatchPrompt({ sessionId, requestId: `reconcile-${resumeIntentId}`, content: probePrompt })
    } catch (error) {
      reconciliation = { ok: false, message: String(error?.message ?? error) }
    }
  }
  if (!reconciliation.ok) return { ok: false, code: 'RECONCILE_FAILED', message: reconciliation.message, aggregate: agg }
  return confirmResume(agg, { resumeIntentId, globalStopGeneration })
}
