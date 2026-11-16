// TaskAggregate v2 纯业务(数据与工具契约 + 生命周期与恢复):状态迁移、workItem、报告、停止/恢复、取消。
// 不触宿主;时间由 now() 注入;所有失败返回 { ok:false, code, message }。
import { ERROR_CODES as E, fail, pass, actionKeyOf } from './command.mjs'
import { convergeRunUsage } from './usage.mjs'

const PRIORITIES = ['high', 'normal', 'low']
const PHASES = ['implement', 'fix', 'accept', 'integrate']
const PHASE_ROLE = { implement: 'executor', fix: 'executor', accept: 'reviewer', integrate: 'executor|reviewer' }
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
  if (!PRIORITIES.includes(priority)) return fail(E.INVALID_ARGUMENT, `priority 非法: ${priority}`)
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
    control: { state: 'active', executionEpoch: 0, allowedGlobalGeneration: 0, stopDetail: null, resumeIntentId: null },
    workItems: {},
    runs: {},
    sessions: {},
    reports: {},
    resumeIntents: {},
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
  if (!Array.isArray(dependencyWorkItemIds) || !dependencyWorkItemIds.every((id) => typeof id === 'string' && id.trim())) {
    return fail(E.INVALID_ARGUMENT, 'dependencyWorkItemIds 须为工作项 ID 字符串数组')
  }
  if (!Array.isArray(requiredCriterionIds) || !requiredCriterionIds.every((id) => typeof id === 'string' && id.trim())) {
    return fail(E.INVALID_ARGUMENT, 'requiredCriterionIds 须为验收标准 ID 字符串数组')
  }
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
  // 允许前向声明(依赖项可稍后定义,F05 契约);已撤回的既有项不可再被依赖
  const withdrawnDeps = normalized.dependencyWorkItemIds.filter((id) => aggregate.workItems[id]?.replacedBy)
  if (withdrawnDeps.length > 0) return fail(E.INVALID_ARGUMENT, `依赖工作项已撤回: ${withdrawnDeps.join(', ')}`)
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

// task.authorize:绑定当前 definitionRevision;blocked(授权失效)回 ready,旧验收标历史,不虚增定义版本。
// 定义未变且已有授权时幂等返回:重复授权(超时重试)不得把已通过的验收标为历史。
export function authorizeTask(aggregate, { sourceMessageRef, now: at }) {
  // 幂等优先于终态判断:授权命令的重试可能晚于任务结案,不得因状态前进而报错
  if (aggregate.authorization && aggregate.authorization.definitionRevision === aggregate.definitionRevision) {
    return pass({ aggregate, replayed: true })
  }
  if (aggregate.businessState === 'cancelled' || aggregate.businessState === 'completed') {
    return fail(E.INVALID_ARGUMENT, `终态任务不可授权: ${aggregate.businessState}`)
  }
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

// 未核清的 Run 状态:interrupted 与 settled/rejected 同属终态,不占执行槽
export const ACTIVE_RUN_STATES = new Set(['prepared', 'submitted', 'running', 'unknown'])

// 失联阈值:在飞 Run 超过该时长无任何事件即视为已断(prepared/unknown 也不例外),
// 否则一次从未创建成功的会话就会永久占住执行槽与停止核对。
export const RUN_STALE_MS = 15 * 60 * 1000

function staleSince(run) {
  return run.lastEventAt ?? run.recordedAt ?? run.startedAt
}

export function isStaleRun(run, { now, staleMs = RUN_STALE_MS } = {}) {
  if (!ACTIVE_RUN_STATES.has(run?.state)) return false
  const since = staleSince(run)
  if (!Number.isFinite(since) || !Number.isFinite(now)) return false
  return now - since > staleMs
}

// 时间基准:核心不读墙钟,由调用方(或聚合自带时钟)注入
function clockOf(aggregate, now) {
  if (Number.isFinite(now)) return now
  return typeof aggregate.now === 'function' ? aggregate.now() : undefined
}

// 终态 Run 的结束时刻:启动过就以收敛时刻为结束,从未启动则为 null(显式键,
// undefined 会在 JSON 落盘时整键消失,读面无法区分"未开始"与"字段缺失")
function endedAtOf(run, at) {
  if (!run.startedAt) return null
  return Number.isFinite(at) ? at : null
}

// 失联在飞 Run 收敛为 interrupted;队列事实不可观测,标 stopObserved=unreachable
export function expireStaleRuns(aggregate, options = {}) {
  const now = clockOf(aggregate, options.now)
  const stale = Object.entries(aggregate.runs).filter(([, run]) => isStaleRun(run, { now, staleMs: options.staleMs }))
  if (stale.length === 0) return pass({ aggregate, expired: [] })
  let next = bump(aggregate)
  next = { ...next, runs: { ...aggregate.runs } }
  for (const [runId, run] of stale) next.runs[runId] = { ...run, state: 'interrupted', stopObserved: 'unreachable', endedAt: endedAtOf(run, now) }
  // 终态收敛即结算已观察用量:失联不代表没花掉
  for (const [runId] of stale) next = settleRunUsage(next, runId)
  return pass({ aggregate: next, expired: stale.map(([runId]) => runId) })
}

export function hasActiveRuns(aggregate) {
  return Object.values(aggregate.runs).some((r) => ACTIVE_RUN_STATES.has(r.state))
}

// 会话不可达(删除/从未创建)或跟随器放弃:该会话的在飞 Run 立即按已断收敛,不等失联阈值。
// 与 expireStaleRuns 共用收敛口径,区别只在判据是"会话没了"而非"时间到了"。
export function abandonSessionRuns(aggregate, sessionId) {
  const targets = Object.entries(aggregate.runs).filter(([, run]) => run.sessionId === sessionId && ACTIVE_RUN_STATES.has(run.state))
  if (targets.length === 0) return pass({ aggregate, expired: [] })
  const at = clockOf(aggregate)
  let next = bump(aggregate)
  next = { ...next, runs: { ...aggregate.runs } }
  for (const [runId, run] of targets) next.runs[runId] = { ...run, state: 'interrupted', stopObserved: 'unreachable', endedAt: endedAtOf(run, at) }
  for (const [runId] of targets) next = settleRunUsage(next, runId)
  return pass({ aggregate: next, expired: targets.map(([runId]) => runId) })
}

// 当前实施产物代次:该工作项执行者 Run 数;验收 Run 记录派发时刻的代次,不一致即陈旧验收
export function artifactRevisionOf(aggregate, workItemId) {
  return Object.values(aggregate.runs).filter((run) => run.workItemId === workItemId && run.actorRole === 'executor').length
}

// 当前实施产物已被独立验收驳回:该代次存在非历史 issues 报告。必须产生新实施产物后才能再验收,
// 否则对同一份被驳回产物重复验收会绕过"驳回→修复"的推进规则。
export function currentArtifactRejected(aggregate, workItemId) {
  const artifactRevision = artifactRevisionOf(aggregate, workItemId)
  return Object.values(aggregate.reports).some((report) => report.workItemId === workItemId
    && !report.historical
    && report.definitionRevision === aggregate.definitionRevision
    && report.artifactRevision === artifactRevision
    && report.verdict === 'issues')
}

// 有效验收:派发准入、工作项状态派生与结案共用同一判据。
// 条件:当前定义、非历史、验收 Run、独立会话、覆盖当前实施产物代次。
export function effectiveAcceptance(aggregate, report) {
  if (!report || report.verdict !== 'pass' || report.historical) return false
  if (report.definitionRevision !== aggregate.definitionRevision) return false
  const run = aggregate.runs[report.runId]
  if (!run || run.actorRole !== 'reviewer') return false
  if (report.artifactRevision !== artifactRevisionOf(aggregate, report.workItemId)) return false
  return !Object.values(aggregate.runs).some((execution) => execution.sessionId === run.sessionId && execution.actorRole === 'executor')
}

export function acceptedReportFor(aggregate, workItemId) {
  return Object.values(aggregate.reports).find((report) => report.workItemId === workItemId && effectiveAcceptance(aggregate, report))
}

// 执行许可九条(生命周期"全局与局部停止代次" + 依赖准入);宿主能力就绪由适配层另行检查
export function checkExecutionPermission(aggregate, globalControl, { workItemId, phase, actorRole }) {
  if (!PHASES.includes(phase)) return fail(E.INVALID_ARGUMENT, `phase 非法: ${phase}`)
  if (!(aggregate.control.state === 'active')) return fail(E.TASK_PAUSED, `控制状态 ${aggregate.control.state} 不允许派发`)
  if (!aggregate.authorization || aggregate.authorization.definitionRevision !== aggregate.definitionRevision) {
    return fail(E.AUTHORIZATION_REQUIRED, '当前定义无有效授权')
  }
  if (globalControl.globalStopped && aggregate.control.allowedGlobalGeneration !== globalControl.globalStopGeneration) {
    return fail(E.TASK_PAUSED, '全局停止中且无当前代次单项放行')
  }
  if (!aggregate.workItems[workItemId]) return fail(E.NOT_FOUND, `workItem 不存在: ${workItemId}`)
  if (aggregate.workItems[workItemId].replacedBy) return fail(E.INVALID_ARGUMENT, `工作项已撤回: ${workItemId}`)
  // 依赖准入:缺失/已替换/未有效验收的依赖一律拒绝派发——依赖声明是调度承诺,
  // 与查询面 deriveWorkItemState 的 blocked 展示同一语义,不产生"显示 blocked 却获准"的分叉
  const unmet = aggregate.workItems[workItemId].dependencyWorkItemIds.filter((id) => {
    const dep = aggregate.workItems[id]
    if (dep === undefined || dep.replacedBy !== null) return true
    return !dependencyAccepted(aggregate, id)
  })
  if (unmet.length > 0) return fail(E.DEPENDENCY_BLOCKED, `依赖未就绪: ${unmet.join(', ')}(缺失/已替换/未验收)`)
  const roles = PHASE_ROLE[phase].split('|')
  if (!roles.includes(actorRole)) return fail(E.INVALID_ARGUMENT, `phase ${phase} 不允许角色 ${actorRole}`)
  // 已有效验收的工作项不得重复实施:再次实施会推进产物代次,把已有验收整体作废
  if (phase === 'implement' && acceptedReportFor(aggregate, workItemId)) {
    return fail(E.INVALID_ARGUMENT, '工作项已有当前产物的有效验收,无需重复实施')
  }
  // 被驳回的同一份产物不得重复验收:必须先修复产生新的实施产物代次
  if (phase === 'accept' && currentArtifactRejected(aggregate, workItemId)) {
    return fail(E.INVALID_ARGUMENT, '当前实施产物已被验收驳回,须先修复后再验收')
  }
  if (!DISPATCHABLE_BUSINESS.has(aggregate.businessState)) return fail(E.INVALID_ARGUMENT, `业务状态 ${aggregate.businessState} 不可派发`)
  const slotKey = actionKeyOf([aggregate.taskId, workItemId, phase, actorRole])
  const slotTaken = Object.values(aggregate.runs).some((r) => r.executionSlot === slotKey && ACTIVE_RUN_STATES.has(r.state))
  if (slotTaken) return fail(E.EXECUTION_STILL_ACTIVE, '同一执行槽存在未核清 Run')
  return pass({ slotKey })
}

// 依赖项已有效验收(与结案同一判据):历史报告、旧产物代次的 pass 都不算数
export function dependencyAccepted(aggregate, workItemId) {
  return acceptedReportFor(aggregate, workItemId) !== undefined
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
    recordedAt: ts,
    lastEventAt: null,
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
    next = settleRunUsage(next, runId)
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

// Run 终态收敛处的用量归并:把跟随期观察到的调用并入 usageLedger 与 tokenTotal。
// 归并失败不阻断业务终态(Ledger 自相矛盾时保留诊断),否则报告会永远提交不上。
function settleRunUsage(aggregate, runId) {
  const converged = convergeRunUsage(aggregate, runId)
  if (converged.ok) return converged.result.aggregate
  return {
    ...aggregate,
    runs: { ...aggregate.runs, [runId]: { ...aggregate.runs[runId], usageDiagnostic: { code: converged.code, message: converged.message } } },
  }
}

// task.close:调度员结案;须有当前定义下独立 pass
export function closeTask(aggregate, { passReportId, conclusion }) {
  // 失联 Run 不再占执行槽:结案前先按已断收敛(与本函数同一事务返回,由调用方落盘)
  const settled = expireStaleRuns(aggregate).result?.aggregate ?? aggregate
  if (hasActiveRuns(settled)) return fail(E.EXECUTION_STILL_ACTIVE, '存在在途执行,不可结案')
  const report = settled.reports[passReportId]
  if (!report || report.historical) return fail(E.INVALID_ARGUMENT, '结案须引用当前有效的独立 pass 报告')
  if (report.verdict !== 'pass') return fail(E.INVALID_ARGUMENT, '结案须引用 pass 报告')
  if (!effectiveAcceptance(settled, report)) return fail(E.INVALID_ARGUMENT, 'pass 报告不覆盖当前实施产物')
  // 已撤回项由替代项承接验收责任,不再要求自身有 pass;未撤回项必须全部通过
  const openWorkItems = Object.values(settled.workItems).filter((workItem) => !workItem.replacedBy)
  if (openWorkItems.some((workItem) => !acceptedReportFor(settled, workItem.workItemId))) return fail(E.INVALID_ARGUMENT, '所有未撤回工作项须有当前产物的独立验收通过报告')
  const next = bump(settled)
  next.businessState = 'completed'
  // 结案即终态:作废待恢复意图并收敛控制面,避免 completed 被 resume 流程重新激活
  next.resumeIntents = voidIntents(settled.resumeIntents)
  next.control = {
    ...next.control,
    state: 'paused',
    stopDetail: null,
    resumeIntentId: null,
    closeConclusion: conclusion ?? null,
  }
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

// 停止确认:全部执行体确认终止 → paused;在飞 Run 收敛为 interrupted 并结算已观察用量
export function confirmStopped(aggregate) {
  if (aggregate.control.state !== 'stopping') return fail(E.INVALID_ARGUMENT, `控制状态 ${aggregate.control.state} 无停止待确认`)
  let next = bump(aggregate)
  next = withControl(next, { state: 'paused', stopDetail: null })
  const activeRunIds = activeRunIdsOf(aggregate)
  next.runs = settleActiveRuns(next.runs, 'interrupted', 'confirmed', clockOf(aggregate))
  for (const runId of activeRunIds) next = settleRunUsage(next, runId)
  return pass({ aggregate: next })
}

// 强制停止/放弃:宿主会话不可达(删除或从未创建)且常规核对无出口时的显式动作。
// 在飞 Run 一律 interrupted + stopObserved=unreachable,队列事实不再声称已核对。
export function forceStopTask(aggregate, { reason = 'force_stop' } = {}) {
  if (['completed', 'cancelled'].includes(aggregate.businessState)) return fail(E.INVALID_ARGUMENT, '终态任务无需停止')
  let next = bump(aggregate)
  next = withControl(next, { state: 'paused', stopDetail: null, resumeIntentId: null }, true)
  next.resumeIntents = voidIntents(aggregate.resumeIntents)
  const activeRunIds = activeRunIdsOf(aggregate)
  next.runs = settleActiveRuns(next.runs, 'interrupted', 'unreachable', clockOf(aggregate))
  for (const runId of activeRunIds) next = settleRunUsage(next, runId)
  next.lastStopReason = reason
  return pass({ aggregate: next })
}

function activeRunIdsOf(aggregate) {
  return Object.keys(aggregate.runs).filter((runId) => ACTIVE_RUN_STATES.has(aggregate.runs[runId].state))
}

function settleActiveRuns(runs, state, stopObserved, at) {
  const next = { ...runs }
  for (const [id, run] of Object.entries(runs)) {
    if (ACTIVE_RUN_STATES.has(run.state)) next[id] = { ...run, state, stopObserved, endedAt: endedAtOf(run, at) }
  }
  return next
}

// resume.request:登记意图,不直接放行;终态任务不得再进入恢复流程
export function requestResume(aggregate, { resumeIntentId, sourceMessageRef, expectedExecutionEpoch, globalStopGeneration }) {
  if (['completed', 'cancelled'].includes(aggregate.businessState)) return fail(E.INVALID_ARGUMENT, `终态任务不可恢复: ${aggregate.businessState}`)
  if (expectedExecutionEpoch !== aggregate.control.executionEpoch) return fail(E.STALE_EPOCH, '恢复意图基于旧执行代次')
  // 同 ID 同来源幂等;同 ID 不同来源/代次必须冲突,禁止静默覆盖已登记的恢复依据
  const existing = aggregate.resumeIntents?.[resumeIntentId]
  if (existing) {
    const same = existing.expectedExecutionEpoch === expectedExecutionEpoch
      && existing.globalStopGeneration === globalStopGeneration
      && JSON.stringify(existing.sourceMessageRef) === JSON.stringify(sourceMessageRef)
    return same
      ? pass({ aggregate, replayed: true })
      : fail(E.IDEMPOTENCY_CONFLICT, `恢复意图已存在且内容不同: ${resumeIntentId}`)
  }
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

// resume.confirm:核对通过 → active;新 epoch、当前全局代次单项许可,原子写入。
// 终态任务即使残留意图也不得恢复,防止结案后被旧意图重新激活。
export function confirmResume(aggregate, { resumeIntentId, globalStopGeneration }) {
  if (['completed', 'cancelled'].includes(aggregate.businessState)) return fail(E.INVALID_ARGUMENT, `终态任务不可恢复: ${aggregate.businessState}`)
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

// workItem.replace:单次聚合 update 内撤销旧项并创建新 ID;旧执行树须已核清;
// failedAcceptanceCount 继承(不借换 ID 清零),旧 pass 只属旧 ID
export function replaceWorkItem(aggregate, { oldWorkItemId, newWorkItemId, title, scope = '', dependencyWorkItemIds = [], requiredCriterionIds = [], reason }) {
  const old = aggregate.workItems[oldWorkItemId]
  if (!old) return fail(E.NOT_FOUND, `workItem 不存在: ${oldWorkItemId}`)
  if (aggregate.workItems[newWorkItemId]) return fail(E.INVALID_ARGUMENT, `新 workItem ID 已存在: ${newWorkItemId}`)
  // 替代发生在既有图上:依赖必须已存在且未撤回,不允许把替代项挂到缺失/撤回项下
  if (!Array.isArray(dependencyWorkItemIds) || !dependencyWorkItemIds.every((id) => typeof id === 'string' && id.trim())) {
    return fail(E.INVALID_ARGUMENT, 'dependencyWorkItemIds 须为工作项 ID 字符串数组')
  }
  const missingDeps = dependencyWorkItemIds.filter((id) => aggregate.workItems[id] === undefined)
  if (missingDeps.length > 0) return fail(E.INVALID_ARGUMENT, `依赖工作项不存在: ${missingDeps.join(', ')}`)
  const inFlight = Object.values(aggregate.runs).some((r) => r.workItemId === oldWorkItemId && ACTIVE_RUN_STATES.has(r.state))
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
