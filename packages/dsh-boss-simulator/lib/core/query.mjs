// 查询投影:board 只读查询契约(envelope+cursor 分页+筛选+全量计数);
// 分页 limit 非法/时间窗口过大 → 可读校验错误,不静默少报(DATA-12)
import { createHash } from 'node:crypto'
import { fail, pass } from './command.mjs'
import { taskUsageSummary } from './usage.mjs'
import { ACTIVE_RUN_STATES, acceptedReportFor, artifactRevisionOf, currentArtifactRejected, effectiveAcceptance, expireStaleRuns } from './task.mjs'

const DEFAULT_PAGE_LIMIT = 50
const MAX_PAGE_LIMIT = 200
const MAX_TIME_WINDOW_MS = 31 * 24 * 60 * 60 * 1000

export function queryBoard(aggregates, globalControl, options = {}) {
  const { workspaceId, search, businessStates, cursor, limit = DEFAULT_PAGE_LIMIT, since, until, serverEpoch = 1, now = Date.now } = options
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_PAGE_LIMIT) {
    return fail('INVALID_ARGUMENT', `limit 须为 1..${MAX_PAGE_LIMIT} 的整数`)
  }
  if (since !== undefined && !Number.isFinite(since)) return fail('INVALID_ARGUMENT', 'since 须为毫秒时间戳')
  if (until !== undefined && !Number.isFinite(until)) return fail('INVALID_ARGUMENT', 'until 须为毫秒时间戳')
  if (since !== undefined && until !== undefined && until < since) return fail('INVALID_ARGUMENT', '时间窗口无效')
  if (since !== undefined && until !== undefined && until - since > MAX_TIME_WINDOW_MS) {
    return fail('INVALID_ARGUMENT', '时间窗口过大')
  }
  if (businessStates !== undefined) {
    const allowed = new Set(['draft', 'ready', 'implementing', 'awaiting_acceptance', 'completed', 'blocked', 'cancelled'])
    const bad = businessStates.filter((s) => !allowed.has(s))
    if (bad.length > 0) return fail('INVALID_ARGUMENT', `businessStates 非法: ${bad.join(', ')}`)
  }
  // 时间窗口按任务活跃期与窗口相交判定:createdAt <= until 且 updatedAt >= since。
  // 只看单个字段会把"窗口内创建但已更新到窗口后"或"窗口前创建但窗口内仍有活动"的任务误裁。
  const filtered = aggregates.filter((a) => (workspaceId ? a.projectWorkspaceId === workspaceId : true))
    .filter((a) => (search ? a.taskId.toLowerCase().includes(search.toLowerCase()) || a.title.toLowerCase().includes(search.toLowerCase()) : true))
    .filter((a) => (since !== undefined ? (Number.isFinite(a.updatedAt) ? a.updatedAt : a.createdAt) >= since : true))
    .filter((a) => (until !== undefined ? a.createdAt <= until : true))
  const priorityRank = { high: 0, normal: 1, low: 2 }
  const all = filtered.filter((a) => (businessStates ? businessStates.includes(a.businessState) : true))
    .sort((a, b) => (priorityRank[a.priority] ?? 1) - (priorityRank[b.priority] ?? 1) || a.createdAt - b.createdAt || a.taskId.localeCompare(b.taskId))
  const counts = {}
  for (const state of ['draft', 'ready', 'implementing', 'awaiting_acceptance', 'completed', 'blocked', 'cancelled']) {
    counts[state] = filtered.filter((a) => a.businessState === state).length
  }
  const viewRevision = createHash('sha256').update(JSON.stringify([globalControl, [...aggregates].sort((a, b) => a.taskId.localeCompare(b.taskId))])).digest('hex')
  const queryKey = JSON.stringify([workspaceId ?? null, search?.toLowerCase() ?? null, businessStates ?? null, since ?? null, until ?? null])
  let start = 0
  if (cursor) {
    let decoded
    try { decoded = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) } catch { return fail('INVALID_ARGUMENT', '分页游标无效') }
    if (!decoded || typeof decoded !== 'object' || typeof decoded.taskId !== 'string') return fail('INVALID_ARGUMENT', '分页游标无效')
    if (decoded.serverEpoch !== serverEpoch || decoded.viewRevision !== viewRevision || decoded.queryKey !== queryKey) return fail('REVISION_CONFLICT', '分页快照已改变，请从首页重新读取')
    const index = all.findIndex((a) => a.taskId === decoded.taskId)
    if (index < 0) return fail('REVISION_CONFLICT', '分页任务已改变，请从首页重新读取')
    start = index + 1
  }
  const page = all.slice(start, start + limit)
  const last = page.at(-1)
  return pass({
    envelope: { serverEpoch, viewRevision, generatedAt: now() },
    counts,
    workspaceIds: [...new Set(aggregates.map((task) => task.projectWorkspaceId))].sort(),
    modelTasks: projectModelTasks(filtered),
    globalControl: { globalStopped: Boolean(globalControl.globalStopped), globalStopGeneration: globalControl.globalStopGeneration },
    items: page.map(projectTaskSummary),
    nextCursor: last && start + limit < all.length ? Buffer.from(JSON.stringify({ serverEpoch, viewRevision, queryKey, taskId: last.taskId })).toString('base64url') : null,
  })
}

// Run 模型归因:唯一事实源为 usageLedger(mergeRunUsage 写入);同 Run 多调用一致才归因,分歧不猜测
function runModelAttribution(aggregate) {
  const byRun = new Map()
  for (const entry of Object.values(aggregate.usageLedger ?? {})) {
    if (!entry.runId || !entry.model) continue
    const known = byRun.get(entry.runId)
    if (known === null) continue
    if (known === undefined) byRun.set(entry.runId, entry.model)
    else if (known !== entry.model) byRun.set(entry.runId, null)
  }
  return byRun
}

function projectModelTasks(aggregates) {
  const groups = new Map()
  for (const task of aggregates) {
    const models = new Set(Object.values(task.usageLedger ?? {}).map((entry) => entry.model).filter(Boolean))
    for (const model of models) {
      const group = groups.get(model) ?? { provider: null, model, taskCount: 0, tasks: [] }
      group.tasks.push({ taskId: task.taskId, title: task.title, createdAt: task.createdAt })
      group.taskCount += 1
      groups.set(model, group)
    }
  }
  return [...groups.values()].sort((a, b) => a.model.localeCompare(b.model)).map((group) => ({
    ...group,
    tasks: group.tasks.sort((a, b) => b.createdAt - a.createdAt || a.taskId.localeCompare(b.taskId)),
  }))
}

// 读面 stale 收敛(纯内存,不写盘):超过失联阈值的在飞 Run 按已断投影。
// 不收敛时同一份数据在"刚刷新"与"任何写动作触发 expire 后"给出两套事实。
function converged(aggregate) {
  return expireStaleRuns(aggregate).result?.aggregate ?? aggregate
}

export function projectTaskSummary(raw) {
  const aggregate = converged(raw)
  const attribution = runModelAttribution(aggregate)
  return {
    taskId: aggregate.taskId,
    title: aggregate.title,
    projectWorkspaceId: aggregate.projectWorkspaceId,
    priority: aggregate.priority,
    businessState: aggregate.businessState,
    controlState: aggregate.control.state,
    stopDetail: aggregate.control.stopDetail,
    stopErrors: aggregate.control.stopErrors ?? [],
    block: aggregate.block,
    definitionRevision: aggregate.definitionRevision,
    authorized: aggregate.authorization !== null,
    workItemCount: Object.keys(aggregate.workItems).length,
    activeRunCount: Object.values(aggregate.runs).filter((r) => ACTIVE_RUN_STATES.has(r.state)).length,
    runs: Object.values(aggregate.runs).map((r) => ({
      runId: r.runId, phase: r.phase, state: r.state,
      startedAt: r.startedAt, endedAt: r.endedAt, tokenTotal: r.tokenTotal, usageCoverage: r.usageCoverage,
      actualModel: attribution.get(r.runId) ?? null,
    })),
    usage: taskUsageSummary(aggregate),
    modelTaskCount: new Set([...attribution.values()].filter(Boolean)).size,
    updatedAt: aggregate.updatedAt,
  }
}

// 单任务详情投影:含 workItems/runs/报告摘要/用量汇总;查询无副作用
export function projectTaskDetail(raw, globalControl) {
  const aggregate = converged(raw)
  const usage = taskUsageSummary(aggregate)
  const attribution = runModelAttribution(aggregate)
  return {
    ...projectTaskSummary(aggregate),
    definition: aggregate.definition,
    authorization: aggregate.authorization,
    block: aggregate.block,
    workItems: Object.values(aggregate.workItems).map((w) => ({
      workItemId: w.workItemId,
      title: w.title,
      state: deriveWorkItemState(aggregate, w),
      failedAcceptanceCount: w.failedAcceptanceCount,
      dependencyWorkItemIds: w.dependencyWorkItemIds,
      requiredCriterionIds: w.requiredCriterionIds,
      replacedBy: w.replacedBy,
    })),
    // 推进目标由服务端给出:面板按子项派生态选择,不再盲取第一个子项
    nextDispatch: nextDispatchOf(aggregate),
    runs: Object.values(aggregate.runs).map((r) => ({
      runId: r.runId, workItemId: r.workItemId, phase: r.phase, state: r.state,
      attemptOrdinal: r.attemptOrdinal, executionEpoch: r.executionEpoch,
      globalStopGeneration: r.globalStopGeneration, sessionId: r.sessionId,
      startedAt: r.startedAt, endedAt: r.endedAt,
      tokenTotal: r.tokenTotal, usageCoverage: r.usageCoverage,
      actualModel: attribution.get(r.runId) ?? null,
      stopObserved: r.stopObserved ?? null,
      reportDiagnostic: r.reportDiagnostic ?? null,
      usageDiagnostic: r.usageDiagnostic ?? null,
      dispatchError: r.dispatchError ?? null,
    })),
    reports: Object.values(aggregate.reports).map((r) => ({
      reportId: r.reportId, runId: r.runId, verdict: r.verdict, historical: r.historical,
      effective: effectiveAcceptance(aggregate, r),
      issues: r.issues, definitionRevision: r.definitionRevision,
    })),
    usage,
    globalStopGeneration: globalControl.globalStopGeneration,
  }
}

// WorkItem.state 派生(只读,不落盘):planned/executing/awaitingReview/accepted/blocked/withdrawn
export function deriveWorkItemState(rawAggregate, workItem) {
  const aggregate = converged(rawAggregate)
  if (workItem.replacedBy) return 'withdrawn'
  const runs = Object.values(aggregate.runs).filter((r) => r.workItemId === workItem.workItemId)
  const inFlight = runs.find((r) => ACTIVE_RUN_STATES.has(r.state))
  if (inFlight) return 'executing'
  const depsMissing = workItem.dependencyWorkItemIds.some((id) => {
    const dep = aggregate.workItems[id]
    return dep === undefined || dep.replacedBy !== null
  })
  const blockedByAuth = !aggregate.authorization || aggregate.authorization.definitionRevision !== aggregate.definitionRevision
  if ((depsMissing || blockedByAuth) && aggregate.businessState !== 'completed') return 'blocked'
  // 与派发准入/结案同一判据:旧产物代次的 pass 不显示为已通过
  if (acceptedReportFor(aggregate, workItem.workItemId)) return 'accepted'
  if (awaitingAcceptance(aggregate, workItem.workItemId)) return 'awaitingReview'
  return 'planned'
}

// 待验收的唯一判据与 Run 服务派发验收同一条件:当前定义、当前实施产物代次、
// 该代次的实施 Run 已结算且提交了 ready_for_review。该代次已被验收(issues)时
// 交付物已被驳回,子项回到待实施,不再反复派验收。
function awaitingAcceptance(aggregate, workItemId) {
  const artifactRevision = artifactRevisionOf(aggregate, workItemId)
  const reports = Object.values(aggregate.reports).filter((report) => report.workItemId === workItemId
    && !report.historical
    && report.definitionRevision === aggregate.definitionRevision
    && report.artifactRevision === artifactRevision)
  if (!reports.some((report) => report.verdict === 'ready_for_review' && aggregate.runs[report.runId]?.state === 'settled')) return false
  return !currentArtifactRejected(aggregate, workItemId)
}

// 子项缺省派发阶段:显式 workItemId 派发与 nextDispatchOf 共用同一派生口径。
// 已有实施产物(被驳回或求助)时下一动作是修复;从未实施过的子项才从 implement 开始。
export function defaultPhaseFor(rawAggregate, workItemId) {
  const aggregate = converged(rawAggregate)
  const workItem = aggregate.workItems[workItemId]
  if (!workItem) return null
  const state = deriveWorkItemState(aggregate, workItem)
  if (state === 'awaitingReview') return 'accept'
  if (state === 'planned') return artifactRevisionOf(aggregate, workItemId) > 0 ? 'fix' : 'implement'
  return null
}

// 推进目标:按子项派生态选下一个可派发目标(验收优先于实施,均按子项声明序)。
// 面板不再固定派发第一个子项:重复实施已验收项会推进产物代次,作废既有验收。
export function nextDispatchOf(rawAggregate) {
  const aggregate = converged(rawAggregate)
  const items = Object.values(aggregate.workItems).filter((item) => !item.replacedBy)
  const states = items.map((item) => ({ item, state: deriveWorkItemState(aggregate, item) }))
  const awaiting = states.find(({ state }) => state === 'awaitingReview')
  if (awaiting) return { workItemId: awaiting.item.workItemId, phase: defaultPhaseFor(aggregate, awaiting.item.workItemId) }
  const planned = states.find(({ state }) => state === 'planned')
  if (planned) return { workItemId: planned.item.workItemId, phase: defaultPhaseFor(aggregate, planned.item.workItemId) }
  return null
}
