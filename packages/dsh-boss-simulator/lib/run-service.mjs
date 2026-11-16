import { randomUUID } from 'node:crypto'
import { ACTIVE_RUN_STATES, checkExecutionPermission, recordRun, markSessionExecutor, confirmResume, expireStaleRuns } from './core/task.mjs'
import { defaultPhaseFor } from './core/query.mjs'
import { convergeRunUsage } from './core/usage.mjs'
import { reconcileStoppedTask } from './core/orchestrator.mjs'

function requireOk(outcome) {
  if (!outcome.ok) throw Object.assign(new Error(outcome.message), { code: outcome.code })
  return outcome.result
}

export function createExecutionGate() {
  let pending = Promise.resolve()
  return action => {
    const result = pending.then(action)
    pending = result.catch(() => {})
    return result
  }
}

export function createRunService({ store, sessionAdapter, followRuns = () => {}, withExecution = action => action() }) {
  async function dispatch(args) {
    const { taskId, workItemId, runId, requestId, content } = args
    if (![taskId, workItemId, runId, requestId].every(value => typeof value === 'string' && value.trim())) throw new Error('taskId/workItemId/runId/requestId 必填')
    if (typeof content !== 'string' || !content.trim()) throw new Error('派发 content 必须为非空任务说明')
    const globalControl = await store.loadControl()
    const sessionId = randomUUID()
    // 缺省阶段与 nextDispatch 同源:awaitingReview 派验收、已有产物派 fix,不得退回 implement 推进产物代次
    let phase = args.phase
    let actorRole = args.actorRole
    let created = false
    const prepared = await store.updateAggregate(taskId, raw => {
      // 失联 Run 不再占执行槽与工作项:先收敛,再按最新事实判许可
      const current = expireStaleRuns(raw).result?.aggregate ?? raw
      const existing = current.runs[runId]
      if (existing) {
        // 重放按原 Run 还原缺省阶段/角色,避免子项状态前进后指纹漂移
        const replayPhase = phase ?? existing.phase
        const replayRole = actorRole ?? existing.actorRole
        const replayFingerprint = JSON.stringify({ workItemId, phase: replayPhase, actorRole: replayRole, content })
        if (existing.requestId !== requestId || existing.dispatchFingerprint !== replayFingerprint) throw new Error('派发标识已被其他内容使用')
        phase = replayPhase
        actorRole = replayRole
        return current
      }
      if (Object.values(current.runs).some(run => run.requestId === requestId)) throw new Error('requestId 已绑定其他 Run')
      if (Object.values(current.runs).some(run => run.workItemId === workItemId && ACTIVE_RUN_STATES.has(run.state))) throw new Error('工作项存在未核清 Run')
      phase = phase ?? defaultPhaseFor(current, workItemId)
      if (!phase) throw new Error(`无法从子项状态推导派发阶段: ${workItemId}`)
      actorRole = actorRole ?? (phase === 'accept' ? 'reviewer' : 'executor')
      const fingerprint = JSON.stringify({ workItemId, phase, actorRole, content })
      const permission = requireOk(checkExecutionPermission(current, globalControl, { workItemId, phase, actorRole }))
      const currentArtifactRevision = Object.values(current.runs).filter(candidate => candidate.workItemId === workItemId && candidate.actorRole === 'executor').length
      if (actorRole === 'reviewer' && !Object.values(current.reports).some(report => report.workItemId === workItemId && !report.historical && report.verdict === 'ready_for_review' && report.artifactRevision === currentArtifactRevision && current.runs[report.runId]?.state === 'settled')) throw new Error('独立验收须先有当前最新实施产物的有效报告')
      const recorded = requireOk(recordRun(current, { runId, workItemId, phase, actorRole, sessionId, requestId, slotKey: permission.slotKey, globalControl }))
      let next = recorded.aggregate
      next = { ...next, runs: { ...next.runs, [runId]: { ...next.runs[runId], dispatchFingerprint: fingerprint, requiredCriterionIds: [...current.workItems[workItemId].requiredCriterionIds] } } }
      if (actorRole === 'executor') next = requireOk(markSessionExecutor(next, { sessionId, runIds: [runId] })).aggregate
      created = true
      return next
    })
    const run = prepared.runs[runId]
    if (!created) return { ok: true, runId, sessionId: run.sessionId, requestId, state: run.state, replayed: true }
    let prompted = false
    try {
      const session = await sessionAdapter.ensureSession({ sessionId, workspaceId: prepared.projectWorkspaceId })
      if (session.sessionId !== sessionId) throw new Error('宿主返回的 sessionId 与已登记 Run 不一致')
      const latestControl = await store.loadControl()
      const current = await store.loadAggregate(taskId)
      requireOk(checkExecutionPermission({ ...current, runs: Object.fromEntries(Object.entries(current.runs).filter(([id]) => id !== runId)) }, latestControl, { workItemId, phase, actorRole }))
      if (current.control.executionEpoch !== run.executionEpoch || latestControl.globalStopGeneration !== run.globalStopGeneration) throw new Error('派发期间执行代次发生变化')
      const verdicts = actorRole === 'reviewer' ? ['pass', 'issues'] : ['ready_for_review', 'needs_help']
      const context = { runId, phase, actorRole, requiredCriterionIds: run.requiredCriterionIds, schema: { summary: '非空字符串', verdict: verdicts, coveredCriterionIds: '标准ID字符串数组', issues: '问题字符串数组', evidence: '证据字符串数组' } }
      const instruction = `${content}\n\n目标：${prepared.definition.goal}\n范围：${prepared.definition.scope}\n验收标准：${JSON.stringify(prepared.definition.acceptanceCriteria)}\n仅将最终结果作为包含以下五个字段的独立 JSON 文本提交，不附加 Markdown。报告上下文：${JSON.stringify(context)}`
      prompted = true
      const receipt = await sessionAdapter.dispatchPrompt({ sessionId, requestId, content: [{ type: 'text', text: instruction }] })
      if (!receipt?.accepted) throw Object.assign(new Error('宿主拒绝派发输入'), { rejected: true })
      const updated = await store.updateAggregate(taskId, latest => {
        const active = latest.runs[runId]
        if (active.state !== 'prepared') return latest
        return { ...latest, runs: { ...latest.runs, [runId]: { ...active, state: 'submitted' } } }
      })
      followRuns(taskId, sessionId)
      return { ok: true, runId, sessionId, requestId, state: updated.runs[runId].state }
    } catch (error) {
      await store.updateAggregate(taskId, current => {
        const active = current.runs[runId]
        if (!['prepared', 'submitted'].includes(active.state)) return current
        const terminal = { ...active, state: prompted && !error.rejected ? 'unknown' : 'rejected', dispatchError: String(error.message) }
        const next = { ...current, runs: { ...current.runs, [runId]: terminal } }
        // 终态收敛处结算已观察用量;unknown 仍属在飞,等跟随器收敛。
        // rejected = prompt 未被受理,模型零调用确有证据,按明确零入账(coverage 才可能 complete)
        if (terminal.state !== 'rejected') return next
        const converged = convergeRunUsage(next, runId, { completeUsage: true })
        return converged.ok ? converged.result.aggregate : next
      })
      if (prompted && !error.rejected) followRuns(taskId, sessionId)
      throw error
    }
  }
  async function confirmResumeIntent({ taskId, resumeIntentId }) {
    if (!sessionAdapter) throw new Error('标准会话适配未就绪')
    // 终态先拒绝,避免对 completed/cancelled 先做停止核对等副作用
    const snapshot = await store.loadAggregate(taskId)
    if (!snapshot) throw new Error(`任务不存在: ${taskId}`)
    if (['completed', 'cancelled'].includes(snapshot.businessState)) throw new Error(`终态任务不可恢复: ${snapshot.businessState}`)
    const reconciled = await reconcileStoppedTask(store, taskId, sessionAdapter)
    if (!reconciled.stopConfirmed) throw new Error('旧执行会话或队列尚未核清')
    const global = await store.loadControl()
    const epoch = reconciled.aggregate.control.executionEpoch
    const updated = await store.updateAggregate(taskId, current => {
      if (current.control.executionEpoch !== epoch) throw new Error('恢复核对期间执行代次变化')
      const intent = current.resumeIntents[resumeIntentId]
      if (intent?.globalStopGeneration !== global.globalStopGeneration) throw new Error('恢复意图已被新的全局停止代次作废')
      return requireOk(confirmResume(current, { resumeIntentId, globalStopGeneration: global.globalStopGeneration })).aggregate
    })
    return { ok: true, controlState: updated.control.state, executionEpoch: updated.control.executionEpoch }
  }
  return { dispatch: args => withExecution(() => dispatch(args)), confirmResume: args => withExecution(() => confirmResumeIntent(args)) }
}
