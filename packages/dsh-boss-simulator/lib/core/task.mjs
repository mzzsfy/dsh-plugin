// TaskAggregate v2 纯业务(数据与工具契约 + 生命周期与恢复):状态迁移、workItem、报告、停止/恢复、取消。
// 不触宿主;时间由 now() 注入;所有失败返回 { ok:false, code, message }。
import { ERROR_CODES as E, fail, pass, actionKeyOf } from './command.mjs'

const BUSINESS_STATES = ['draft', 'ready', 'implementing', 'awaiting_acceptance', 'completed', 'blocked', 'cancelled']
const PRIORITIES = ['high', 'normal', 'low']
const PHASES = ['implement', 'fix', 'accept', 'integrate']
const PHASE_ROLE = { implement: 'executor', fix: 'executor', accept: 'reviewer', integrate: 'executor|reviewer' }
const RUN_STATES = ['prepared', 'submitted', 'running', 'settled', 'interrupted', 'rejected', 'unknown']
const CONTROL_STATES = ['active', 'stopping', 'paused', 'reconciling']
const CRITERION_ID = /^[A-Za-z0-9_-]+$/

function bump(aggregate) {
  return { ...aggregate, recordRevision: aggregate.recordRevision + 1, updatedAt: aggregate.now() }
}

function withControl(aggregate, controlPatch, epochBump = false) {
  const control = { ...aggregate.control, ...controlPatch }
  if (epochBump) control.executionEpoch = control.executionEpoch + 1
  return { ...aggregate, control }
}

export function createTask({ taskId, title, projectWorkspaceId, definition, priority = 'normal', now }) {
  if (!taskId || !title || !projectWorkspaceId) return fail(E.INVALID_ARGUMENT, 'taskId/title/projectWorkspaceId 必填')
  if (!BUSINESS_STATES || !PRIORITIES.includes(priority)) return fail(E.INVALID_ARGUMENT, `priority 非法: ${priority}`)
  const def = normalizeDefinition(definition)
  if (!def.ok) return def
  const ts = now()
  return pass({
    taskId,
    title,
    projectWorkspaceId,
    definition: def.result,
    definitionRevision: 1,
    scheduleRevision: 1,
    recordRevision: 1,
    priority,
    authorization: null,
    businessState: 'draft',
    block: null,
    control: { state: 'active', executionEpoch: 0, allowedGlobalGeneration: 0, stopDetail: null, resumeIntentId: null, pendingCancel: null },
    workItems: {},
    runs: {},
    sessions: {},
    reports: {},
    resumeIntents: {},
    appliedActions: {},
    usageLedger: {},
    createdAt: ts,
    updatedAt: ts,
    now,
  })
}

function normalizeDefinition({ goal, scope = '', acceptanceCriteria = [], dependencyTaskIds = [] }) {
  if (!goal) return fail(E.INVALID_ARGUMENT, '目标不能为空')
  const bad = acceptanceCriteria.find((c) => !c?.criterionId || !CRITERION_ID.test(c.criterionId) || !c.text)
  if (bad) return fail(E.INVALID_ARGUMENT, '验收标准需要稳定 criterionId 与 text')
  const ids = acceptanceCriteria.map((c) => c.criterionId)
  if (new Set(ids).size !== ids.length) return fail(E.INVALID_ARGUMENT, 'criterionId 重复')
  if (dependencyTaskIds.includes(undefined)) return fail(E.INVALID_ARGUMENT, '依赖项缺失')
  return pass({ goal, scope, acceptanceCriteria, dependencyTaskIds })
}

// workItem.define:同 ID 同内容幂等返回;同 ID 不同内容 REVISION_CONFLICT;子依赖无环
export function defineWorkItem(aggregate, { workItemId, title, scope = '', dependencyWorkItemIds = [], requiredCriterionIds = [] }) {
  const existing = aggregate.workItems[workItemId]
  const normalized = {
    title, scope,
    dependencyWorkItemIds: [...dependencyWorkItemIds],
    requiredCriterionIds: [...requiredCriterionIds],
  }
  if (existing) {
    const same = existing.title === title && existing.scope === scope
      && JSON.stringify(existing.dependencyWorkItemIds) === JSON.stringify(normalized.dependencyWorkItemIds)
      && JSON.stringify(existing.requiredCriterionIds) === JSON.stringify(normalized.requiredCriterionIds)
    return same
      ? pass({ aggregate, replayed: true })
      : fail(E.REVISION_CONFLICT, `workItem 已存在且内容不同: ${workItemId},替代请用 workItem.replace`)
  }
  if (dependencyWorkItemIds.includes(workItemId)) return fail(E.INVALID_ARGUMENT, 'workItem 自依赖')
  if (hasCycle(normalized.dependencyWorkItemIds, workItemId, aggregate)) return fail(E.DEPENDENCY_BLOCKED, 'workItem 依赖成环')
  const missing = requiredCriterionIds.filter((id) => !aggregate.definition.acceptanceCriteria.some((c) => c.criterionId === id))
  if (missing.length > 0) return fail(E.INVALID_ARGUMENT, `requiredCriterionIds 引用不存在的验收标准: ${missing.join(', ')}`)
  const next = bump(aggregate)
  next.workItems = { ...aggregate.workItems, [workItemId]: { workItemId, ...normalized, failedAcceptanceCount: 0, replacedBy: null, failureSources: [] } }
  return pass({ aggregate: next })
}

// 判环:新增边成环 ⇔ 从依赖沿依赖边可达 workItemId 自身;共同前置的合法菱形
// 依赖两条路径汇于起点而非回到自身,不触发。全局重复访问不当回边
function hasCycle(dependencyIds, workItemId, aggregate) {
  const seen = new Set()
  const queue = [...dependencyIds]
  while (queue.length > 0) {
    const id = queue.pop()
    if (id === workItemId) return true
    if (seen.has(id)) continue
    seen.add(id)
    queue.push(...(aggregate.workItems[id]?.dependencyWorkItemIds ?? []))
  }
  return false
}

// task.authorize:绑定当前 definitionRevision;blocked(授权失效)回 ready,旧验收标历史,不虚增定义版本
export function authorizeTask(aggregate, { sourceMessageRef, now: at }) {
  if (aggregate.businessState === 'cancelled' || aggregate.businessState === 'completed') {
    return fail(E.INVALID_ARGUMENT, `终态任务不可授权: ${aggregate.businessState}`)
  }
  if (aggregate.control.pendingCancel) return fail(E.TASK_PAUSED, '任务处于取消流程,不可授权')
  let next = bump(aggregate)
  next = withControl(next, {})
  const historical = markReportsHistorical(aggregate)
  const revivedBlocked = aggregate.businessState === 'blocked' && aggregate.block?.invalidatesAuthorization
  next = {
    ...next,
    reports: historical,
    authorization: { definitionRevision: aggregate.definitionRevision, sourceMessageRef, authorizedAt: at ?? next.updatedAt },
    businessState: revivedBlocked ? 'ready' : next.businessState === 'draft' ? 'draft' : 'ready',
    block: revivedBlocked ? null : next.block,
  }
  if (next.businessState === 'draft') next.businessState = 'ready'
  return pass({ aggregate: next })
}

function markReportsHistorical(aggregate) {
  const reports = {}
  for (const [id, report] of Object.entries(aggregate.reports)) reports[id] = { ...report, historical: true }
  return reports
}

// task.reviseDefinition:新定义、作废旧授权;有在途执行则进入 stopping 并递增 epoch
export function reviseDefinition(aggregate, { definition }) {
  if (aggregate.businessState === 'completed' || aggregate.businessState === 'cancelled') {
    return fail(E.INVALID_ARGUMENT, '终态任务不可修改定义')
  }
  const def = normalizeDefinition(definition)
  if (!def.ok) return def
  let next = bump(aggregate)
  next = {
    ...next,
    definition: def.result,
    definitionRevision: aggregate.definitionRevision + 1,
    authorization: null,
    reports: markReportsHistorical(aggregate),
    businessState: 'blocked',
    block: { reason: 'definition_changed', blockedFrom: aggregate.businessState, invalidatesAuthorization: true },
  }
  if (next.control.state === 'active' && hasActiveRuns(aggregate)) {
    next = withControl(next, { state: 'stopping', stopDetail: 'requesting' }, true)
  }
  return pass({ aggregate: next })
}

export function hasActiveRuns(aggregate) {
  return Object.values(aggregate.runs).some((r) => ['prepared', 'submitted', 'running', 'unknown'].includes(r.state))
}

// 执行许可十条(生命周期"全局与局部停止代次" + 依赖准入);宿主能力就绪由适配层另行检查
export function checkExecutionPermission(aggregate, globalControl, { workItemId, phase, actorRole }) {
  if (!PHASES.includes(phase)) return fail(E.INVALID_ARGUMENT, `phase 非法: ${phase}`)
  if (!(aggregate.control.state === 'active')) return fail(E.TASK_PAUSED, `控制状态 ${aggregate.control.state} 不允许派发`)
  if (aggregate.control.pendingCancel) return fail(E.TASK_PAUSED, '任务处于取消流程')
  if (!aggregate.authorization || aggregate.authorization.definitionRevision !== aggregate.definitionRevision) {
    return fail(E.AUTHORIZATION_REQUIRED, '当前定义无有效授权')
  }
  if (globalControl.globalStopped && aggregate.control.allowedGlobalGeneration !== globalControl.globalStopGeneration) {
    return fail(E.TASK_PAUSED, '全局停止中且无当前代次单项放行')
  }
  if (!aggregate.workItems[workItemId]) return fail(E.NOT_FOUND, `workItem 不存在: ${workItemId}`)
  // 依赖准入:缺失/已替换/未验收的依赖一律拒绝派发——依赖声明是调度承诺,
  // 与查询面 deriveWorkItemState 的 blocked 展示同一语义,不产生"显示 blocked 却获准"的分叉
  const unmet = aggregate.workItems[workItemId].dependencyWorkItemIds.filter((id) => {
    const dep = aggregate.workItems[id]
    if (dep === undefined || dep.replacedBy !== null) return true
    return !dependencyAccepted(aggregate, id)
  })
  if (unmet.length > 0) return fail(E.DEPENDENCY_BLOCKED, `依赖未就绪: ${unmet.join(', ')}(缺失/已替换/未验收)`)
  const roles = PHASE_ROLE[phase].split('|')
  if (!roles.includes(actorRole)) return fail(E.INVALID_ARGUMENT, `phase ${phase} 不允许角色 ${actorRole}`)
  if (!DISPATCHABLE_BUSINESS.has(aggregate.businessState)) return fail(E.INVALID_ARGUMENT, `业务状态 ${aggregate.businessState} 不可派发`)
  const slotKey = actionKeyOf([aggregate.taskId, workItemId, phase, actorRole])
  const slotTaken = Object.values(aggregate.runs).some((r) => r.executionSlot === slotKey && ['prepared', 'submitted', 'running', 'unknown'].includes(r.state))
  if (slotTaken) return fail(E.EXECUTION_STILL_ACTIVE, '同一执行槽存在未核清 Run')
  return pass({ slotKey })
}

// 依赖项已验收:存在非历史 pass 报告;历史报告(authorize 重置/定义修订)不算数
function dependencyAccepted(aggregate, workItemId) {
  return Object.values(aggregate.reports).some((report) => {
    if (report.historical || report.workItemId !== workItemId) return false
    return report.verdict === 'pass'
  })
}

const DISPATCHABLE_BUSINESS = new Set(['ready', 'implementing', 'awaiting_acceptance'])

// run.dispatch 落 Run:executionSlot 保证至多一个有效 Run;代次冻结进 Run
export function recordRun(aggregate, { runId, workItemId, phase, actorRole, sessionId, requestId, slotKey, globalControl, attemptOrdinal = 1 }) {
  const ts = aggregate.now()
  const run = {
    runId,
    workItemId,
    phase,
    actorRole,
    attemptOrdinal,
    definitionRevision: aggregate.definitionRevision,
    executionEpoch: aggregate.control.executionEpoch,
    globalStopGeneration: globalControl.globalStopGeneration,
    executionSlot: slotKey,
    sessionId,
    requestId,
    requiredCriterionIds: [...(aggregate.workItems[workItemId]?.requiredCriterionIds ?? [])],
    artifactRevision: actorRole === 'reviewer'
      ? Object.values(aggregate.runs).filter(candidate => candidate.workItemId === workItemId && candidate.actorRole === 'executor').length
      : Object.values(aggregate.runs).filter(candidate => candidate.workItemId === workItemId && candidate.actorRole === 'executor').length + 1,
    requestedModel: null,
    state: 'prepared',
    executionTreeSettled: false,
    startedAt: null,
    endedAt: null,
    tokenTotal: null,
    usageCoverage: 'unknown',
  }
  let next = bump(aggregate)
  next.runs = { ...aggregate.runs, [runId]: run }
  if (phase === 'implement' || phase === 'fix' || phase === 'integrate') {
    if (next.businessState === 'ready') next.businessState = 'implementing'
  }
  if (aggregate.control.state === 'active' && aggregate.control.allowedGlobalGeneration < globalControl.globalStopGeneration && globalControl.globalStopped) {
    next = withControl(next, { allowedGlobalGeneration: globalControl.globalStopGeneration })
  }
  return pass({ aggregate: next, run })
}

// 受管会话角色登记:验收 session 独立性检查依据(executorOf=其实施 runId 集合)
export function markSessionExecutor(aggregate, { sessionId, runIds }) {
  const next = bump(aggregate)
  next.sessions = { ...aggregate.sessions, [sessionId]: { sessionId, executorOf: [...runIds] } }
  return pass({ aggregate: next })
}

// 报告提交:executor=ready_for_review/needs_help;reviewer=pass/issues;旧定义/旧 epoch 报告标 historical
export function submitReport(aggregate, { reportId, runId, sessionId, eventSeq, summary, verdict, coveredCriterionIds = [], issues = [], evidence = [] }) {
  const run = aggregate.runs[runId]
  if (!run) return fail(E.NOT_FOUND, `Run 不存在: ${runId}`)
  if (sessionId !== undefined && run.sessionId !== sessionId) return fail(E.INVALID_ARGUMENT, '报告 session 与 Run 绑定不一致')
  if (eventSeq !== undefined && (!Number.isSafeInteger(eventSeq) || eventSeq < 0)) return fail(E.INVALID_ARGUMENT, '报告缺少有效的宿主事件序号')
  if (eventSeq !== undefined && Object.values(aggregate.reports).some((report) => report.sourceMessageRef?.sessionId === sessionId && report.sourceMessageRef?.eventSeq === eventSeq)) {
    return fail(E.IDEMPOTENCY_CONFLICT, 'assistant 消息已被采纳为报告')
  }
  if (!Array.isArray(coveredCriterionIds) || !Array.isArray(issues) || !Array.isArray(evidence) || !coveredCriterionIds.every((id) => typeof id === 'string' && id.trim()) || !issues.every((issue) => typeof issue === 'string' && issue.trim()) || !evidence.every((item) => typeof item === 'string' && item.trim()) || new Set(coveredCriterionIds).size !== coveredCriterionIds.length) return fail(E.INVALID_ARGUMENT, '报告列表字段必须为无重复非空字符串数组')
  if (typeof reportId !== 'string' || !reportId || reportId.length > 160) return fail(E.INVALID_ARGUMENT, 'reportId 非法')
  if (typeof summary !== 'string' || !summary.trim()) return fail(E.INVALID_ARGUMENT, '报告 summary 必填')

  const isReviewer = run.phase === 'accept' || (run.phase === 'integrate' && actorRoleIs(run, 'reviewer'))
  if (Object.hasOwn(aggregate.reports, reportId)) return fail(E.IDEMPOTENCY_CONFLICT, `报告 ID 已存在: ${reportId}`)
  const requiredCriteria = run.requiredCriterionIds ?? aggregate.workItems[run.workItemId]?.requiredCriterionIds ?? []
  if (isReviewer && coveredCriterionIds.some((id) => !requiredCriteria.includes(id))) return fail(E.INVALID_ARGUMENT, '验收报告引用了未知标准')
  if (isReviewer && verdict === 'pass' && requiredCriteria.some((id) => !coveredCriterionIds.includes(id))) return fail(E.INVALID_ARGUMENT, 'pass 报告未覆盖全部必需标准')
  if (verdict === 'pass' && issues.length > 0) return fail(E.INVALID_ARGUMENT, 'pass 报告不允许携带 issues')
  if (isReviewer) {
    if (!['pass', 'issues'].includes(verdict)) return fail(E.INVALID_ARGUMENT, `验收结论非法: ${verdict}`)
    if (aggregate.sessions[run.sessionId]?.executorOf || Object.values(aggregate.runs).some(candidate => candidate.sessionId === run.sessionId && candidate.actorRole === 'executor')) return fail(E.INVALID_ARGUMENT, '验收 session 与实施 session 相同,拒绝自验')
    if (verdict === 'pass' && issues.length > 0) return fail(E.INVALID_ARGUMENT, 'pass 报告不允许携带 issues')
  } else if (!['ready_for_review', 'needs_help'].includes(verdict)) {
    return fail(E.INVALID_ARGUMENT, `实施结论非法: ${verdict}`)
  }
  const historical = run.definitionRevision !== aggregate.definitionRevision || run.executionEpoch !== aggregate.control.executionEpoch
  const workItem = aggregate.workItems[run.workItemId]
  let failedAcceptanceCount = workItem?.failedAcceptanceCount ?? 0
  if (!historical && isReviewer && verdict === 'issues' && !workItem.failureSources.includes(reportId)) {
    failedAcceptanceCount += 1
  }
  let next = bump(aggregate)
  next.reports = {
    ...aggregate.reports,
    [reportId]: {
      reportId, taskId: aggregate.taskId, workItemId: run.workItemId, runId,
      ...(summary !== undefined ? { summary } : {}),
      ...(eventSeq !== undefined ? { sourceMessageRef: { sessionId, eventSeq } } : {}),
      definitionRevision: run.definitionRevision,
      artifactRef: run.artifactRef ?? null,
      artifactRevision: run.artifactRevision ?? 0,
      verdict, coveredCriterionIds, issues, evidence,
      historical,
      createdAt: next.updatedAt,
    },
  }
  if (!historical) {
    next.workItems = {
      ...next.workItems,
      [run.workItemId]: { ...workItem, failedAcceptanceCount, failureSources: [...workItem.failureSources, ...(isReviewer && verdict === 'issues' ? [reportId] : [])] },
    }
    next.runs = { ...next.runs, [runId]: { ...run, state: 'settled', endedAt: next.updatedAt, executionTreeSettled: true } }
    if (run.phase === 'implement' || run.phase === 'fix' || run.phase === 'integrate') {
      if (verdict === 'ready_for_review' && next.businessState === 'implementing') next.businessState = 'awaiting_acceptance'
    }
    if (isReviewer && verdict === 'issues' && next.businessState === 'awaiting_acceptance') {
      next.businessState = 'implementing'
    }
  }
  return pass({ aggregate: next })
}

function actorRoleIs(run, role) {
  return run.actorRole === role
}

// task.close:调度员结案;须有当前定义下独立 pass
export function closeTask(aggregate, { passReportId, conclusion }) {
  if (aggregate.control.pendingCancel) return fail(E.TASK_PAUSED, '任务处于取消流程')
  if (hasActiveRuns(aggregate)) return fail(E.EXECUTION_STILL_ACTIVE, '存在在途执行,不可结案')
  const report = aggregate.reports[passReportId]
  if (!report || report.historical) return fail(E.INVALID_ARGUMENT, '结案须引用当前有效的独立 pass 报告')
  if (report.verdict !== 'pass') return fail(E.INVALID_ARGUMENT, '结案须引用 pass 报告')
  if (report.definitionRevision !== aggregate.definitionRevision) return fail(E.INVALID_ARGUMENT, 'pass 报告不覆盖当前定义')
  const effectivePass = candidate => {
    const run = aggregate.runs[candidate.runId]
    const artifactRevision = Object.values(aggregate.runs).filter(execution => execution.workItemId === candidate.workItemId && execution.actorRole === 'executor').length
    return candidate.verdict === 'pass' && !candidate.historical && candidate.definitionRevision === aggregate.definitionRevision
      && run?.actorRole === 'reviewer' && candidate.artifactRevision === artifactRevision
      && !Object.values(aggregate.runs).some(execution => execution.sessionId === run.sessionId && execution.actorRole === 'executor')
  }
  if (!effectivePass(report)) return fail(E.INVALID_ARGUMENT, 'pass 报告不覆盖当前实施产物')
  if (Object.keys(aggregate.workItems).some(workItemId => !Object.values(aggregate.reports).some(candidate => candidate.workItemId === workItemId && effectivePass(candidate)))) return fail(E.INVALID_ARGUMENT, '所有工作项须有当前产物的独立验收通过报告')
  const next = bump(aggregate)
  next.businessState = 'completed'
  next.control = { ...next.control, state: 'paused', closeConclusion: conclusion ?? null }
  return pass({ aggregate: next })
}

// 单任务停止:关闭许可并递增 epoch(旧命令失效),作废恢复意图
export function stopTask(aggregate, { reason = 'user_interrupt' } = {}) {
  if (['completed', 'cancelled'].includes(aggregate.businessState)) return fail(E.INVALID_ARGUMENT, '终态任务无需停止')
  let next = bump(aggregate)
  const wasActive = next.control.state === 'active'
  const noActive = !hasActiveRuns(aggregate)
  next = withControl(next, {
    state: 'stopping',
    stopDetail: noActive && wasActive ? null : 'requesting',
    resumeIntentId: null,
  }, true)
  next.resumeIntents = voidIntents(aggregate.resumeIntents)
  if (wasActive && noActive) next = withControl(next, { state: 'paused', stopDetail: null })
  next.lastStopReason = reason
  return pass({ aggregate: next })
}

function voidIntents(intents) {
  const next = {}
  for (const [id, intent] of Object.entries(intents)) {
    next[id] = intent.status === 'pending' || intent.status === 'reconciling' ? { ...intent, status: 'void' } : intent
  }
  return next
}

// 停止确认:全部执行体确认终止 → paused;pendingCancel 存在则原子结为 cancelled+paused
export function confirmStopped(aggregate) {
  if (aggregate.control.state !== 'stopping') return fail(E.INVALID_ARGUMENT, `控制状态 ${aggregate.control.state} 无停止待确认`)
  let next = bump(aggregate)
  next = withControl(next, { state: 'paused', stopDetail: null })
  if (next.control.pendingCancel) {
    next.businessState = 'cancelled'
    next.control = { ...next.control, pendingCancel: null }
    next.resumeIntents = voidIntents(next.resumeIntents)
  }
  next.runs = settleActiveRuns(next.runs, 'interrupted')
  return pass({ aggregate: next })
}

function settleActiveRuns(runs, state) {
  const next = { ...runs }
  for (const [id, run] of Object.entries(runs)) {
    if (['prepared', 'submitted', 'running', 'unknown'].includes(run.state)) next[id] = { ...run, state, endedAt: run.startedAt ? undefined : null }
  }
  return next
}

// resume.request:登记意图,不直接放行;pendingCancel 期间拒绝
export function requestResume(aggregate, { resumeIntentId, sourceMessageRef, expectedExecutionEpoch, globalStopGeneration }) {
  if (aggregate.control.pendingCancel) return fail(E.TASK_PAUSED, '取消流程中拒绝恢复请求')
  if (expectedExecutionEpoch !== aggregate.control.executionEpoch) return fail(E.STALE_EPOCH, '恢复意图基于旧执行代次')
  let next = bump(aggregate)
  next.resumeIntents = {
    ...aggregate.resumeIntents,
    [resumeIntentId]: {
      resumeIntentId, sourceMessageRef, expectedExecutionEpoch, globalStopGeneration,
      status: 'pending', createdAt: next.updatedAt,
    },
  }
  if (next.control.state === 'paused') next = withControl(next, { state: 'reconciling', resumeIntentId })
  return pass({ aggregate: next })
}

// resume.confirm:核对通过 → active;新 epoch、当前全局代次单项许可,原子写入
export function confirmResume(aggregate, { resumeIntentId, globalStopGeneration }) {
  const intent = aggregate.resumeIntents[resumeIntentId]
  if (!intent || intent.status !== 'pending') return fail(E.INVALID_ARGUMENT, '恢复意图不存在或已失效')
  if (aggregate.control.state !== 'reconciling' && aggregate.control.state !== 'paused') {
    return fail(E.TASK_PAUSED, `控制状态 ${aggregate.control.state} 不允许恢复确认`)
  }
  if (hasActiveRuns(aggregate)) return fail(E.EXECUTION_STILL_ACTIVE, '旧执行树未核清')
  if (!aggregate.authorization || aggregate.authorization.definitionRevision !== aggregate.definitionRevision) {
    return fail(E.AUTHORIZATION_REQUIRED, '恢复须当前定义有效授权')
  }
  let next = bump(aggregate)
  next.resumeIntents = { ...aggregate.resumeIntents, [resumeIntentId]: { ...intent, status: 'confirmed' } }
  next = withControl(next, {
    state: 'active',
    executionEpoch: aggregate.control.executionEpoch + 1,
    allowedGlobalGeneration: globalStopGeneration,
    resumeIntentId: null,
    stopDetail: null,
  })
  return pass({ aggregate: next })
}

// task.cancel:执行树未停先 pendingCancel+stopping;确认时原子 cancelled+paused
export function requestCancel(aggregate, { sourceMessageRef }) {
  if (aggregate.businessState === 'cancelled') return fail(E.INVALID_ARGUMENT, '任务已取消')
  if (aggregate.businessState === 'completed') return fail(E.INVALID_ARGUMENT, '任务已结案')
  let next = bump(aggregate)
  if (hasActiveRuns(aggregate)) {
    next = withControl(next, { state: 'stopping', stopDetail: 'requesting', pendingCancel: { sourceMessageRef }, resumeIntentId: null }, true)
    next.resumeIntents = voidIntents(aggregate.resumeIntents)
  } else {
    next.businessState = 'cancelled'
    next = withControl(next, { state: 'paused', pendingCancel: null })
    next.resumeIntents = voidIntents(aggregate.resumeIntents)
  }
  return pass({ aggregate: next })
}

// workItem.replace:单次聚合 update 内撤销旧项并创建新 ID;旧执行树须已核清;
// failedAcceptanceCount 继承(不借换 ID 清零),旧 pass 只属旧 ID
export function replaceWorkItem(aggregate, { oldWorkItemId, newWorkItemId, title, scope = '', dependencyWorkItemIds = [], requiredCriterionIds = [], reason }) {
  const old = aggregate.workItems[oldWorkItemId]
  if (!old) return fail(E.NOT_FOUND, `workItem 不存在: ${oldWorkItemId}`)
  if (aggregate.workItems[newWorkItemId]) return fail(E.INVALID_ARGUMENT, `新 workItem ID 已存在: ${newWorkItemId}`)
  const inFlight = Object.values(aggregate.runs).some((r) => r.workItemId === oldWorkItemId && ['prepared', 'submitted', 'running', 'unknown'].includes(r.state))
  if (inFlight) return fail(E.EXECUTION_STILL_ACTIVE, '旧执行树存在未核清 Run,不可替代')
  if (!reason) return fail(E.INVALID_ARGUMENT, '替代必须给出解释')
  const draft = { ...aggregate, workItems: { ...aggregate.workItems, [oldWorkItemId]: { ...old, replacedBy: newWorkItemId } } }
  const created = defineWorkItem(draft, { workItemId: newWorkItemId, title, scope, dependencyWorkItemIds, requiredCriterionIds })
  if (!created.ok) return created
  let next = created.result.aggregate
  next = bump(next)
  next.workItems = {
    ...next.workItems,
    [newWorkItemId]: {
      ...next.workItems[newWorkItemId],
      failedAcceptanceCount: old.failedAcceptanceCount,
      failureSources: [...old.failureSources],
      replacesWorkItemId: oldWorkItemId,
      replacementReason: reason,
    },
  }
  return pass({ aggregate: next })
}

// 依赖解除:仅 blocked(依赖缺失)回 blockedFrom 业务状态;不解除控制暂停
export function resolveDependencyBlock(aggregate) {
  if (aggregate.businessState !== 'blocked' || aggregate.block?.reason !== 'dependency_missing') {
    return fail(E.INVALID_ARGUMENT, '任务不处于依赖受阻')
  }
  const next = bump(aggregate)
  next.businessState = aggregate.block.blockedFrom
  next.block = null
  return pass({ aggregate: next })
}
