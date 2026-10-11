// 查询投影:board 只读查询契约(envelope+cursor 分页+筛选+全量计数);
// 分页 limit 非法/时间窗口过大 → 可读校验错误,不静默少报(DATA-12)
import { fail, pass } from './command.mjs'

const DEFAULT_PAGE_LIMIT = 50
const MAX_PAGE_LIMIT = 200
const MAX_TIME_WINDOW_MS = 31 * 24 * 60 * 60 * 1000

export function queryBoard(aggregates, globalControl, options = {}) {
  const { workspaceId, search, businessStates, cursor, limit = DEFAULT_PAGE_LIMIT, since, until, serverEpoch = 1 } = options
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_PAGE_LIMIT) {
    return fail('INVALID_ARGUMENT', `limit 须为 1..${MAX_PAGE_LIMIT} 的整数`)
  }
  if (since !== undefined && until !== undefined && until - since > MAX_TIME_WINDOW_MS) {
    return fail('INVALID_ARGUMENT', '时间窗口过大')
  }
  if (businessStates !== undefined) {
    const allowed = new Set(['draft', 'ready', 'implementing', 'awaiting_acceptance', 'completed', 'blocked', 'cancelled'])
    const bad = businessStates.filter((s) => !allowed.has(s))
    if (bad.length > 0) return fail('INVALID_ARGUMENT', `businessStates 非法: ${bad.join(', ')}`)
  }
  const all = aggregates.filter((a) => (workspaceId ? a.projectWorkspaceId === workspaceId : true))
    .filter((a) => (businessStates ? businessStates.includes(a.businessState) : true))
    .filter((a) => (search ? a.taskId.includes(search) || a.title.includes(search) : true))
    .sort((a, b) => a.createdAt - b.createdAt || (a.taskId < b.taskId ? -1 : 1))
  const counts = {}
  for (const state of ['draft', 'ready', 'implementing', 'awaiting_acceptance', 'completed', 'blocked', 'cancelled']) {
    counts[state] = aggregates.filter((a) => a.businessState === state).length
  }
  const start = cursor ? all.findIndex((a) => a.taskId === cursor) + 1 : 0
  const page = all.slice(start, start + limit)
  const last = page.at(-1)
  return pass({
    envelope: { serverEpoch, viewRevision: globalControl.globalStopGeneration, generatedAt: Date.now() },
    counts,
    items: page.map(projectTaskSummary),
    nextCursor: last && start + limit < all.length ? last.taskId : null,
  })
}

export function projectTaskSummary(aggregate) {
  return {
    taskId: aggregate.taskId,
    title: aggregate.title,
    projectWorkspaceId: aggregate.projectWorkspaceId,
    priority: aggregate.priority,
    businessState: aggregate.businessState,
    controlState: aggregate.control.state,
    stopDetail: aggregate.control.stopDetail,
    pendingCancel: aggregate.control.pendingCancel !== null,
    definitionRevision: aggregate.definitionRevision,
    authorized: aggregate.authorization !== null,
    workItemCount: Object.keys(aggregate.workItems).length,
    activeRunCount: Object.values(aggregate.runs).filter((r) => ['prepared', 'submitted', 'running'].includes(r.state)).length,
    runs: Object.values(aggregate.runs).map((r) => ({
      runId: r.runId, phase: r.phase, state: r.state, presetId: r.presetId,
      startedAt: r.startedAt, endedAt: r.endedAt,
    })),
    modelTaskCount: new Set(Object.values(aggregate.runs).map((r) => r.presetId).filter(Boolean)).size,
    updatedAt: aggregate.updatedAt,
  }
}

// 单任务详情投影:含 workItems/runs/报告摘要/用量汇总;查询无副作用
export function projectTaskDetail(aggregate, globalControl) {
  const usage = taskUsageSummaryOf(aggregate)
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
    runs: Object.values(aggregate.runs).map((r) => ({
      runId: r.runId, workItemId: r.workItemId, phase: r.phase, state: r.state,
      attemptOrdinal: r.attemptOrdinal, executionEpoch: r.executionEpoch,
      globalStopGeneration: r.globalStopGeneration, sessionId: r.sessionId,
      tokenTotal: r.tokenTotal, usageCoverage: r.usageCoverage,
    })),
    reports: Object.values(aggregate.reports).map((r) => ({
      reportId: r.reportId, runId: r.runId, verdict: r.verdict, historical: r.historical,
      issues: r.issues, definitionRevision: r.definitionRevision,
    })),
    usage,
    globalStopGeneration: globalControl.globalStopGeneration,
  }
}

function taskUsageSummaryOf(aggregate) {
  const runs = Object.values(aggregate.runs)
  let knownTotal = 0
  let unknown = 0
  for (const run of runs) {
    if (run.usageCoverage === 'unknown' || run.usageCoverage === 'partial') unknown += 1
    knownTotal += run.knownTokenTotal ?? 0
  }
  const coverage = runs.length === 0 ? 'unknown' : unknown > 0 ? (knownTotal > 0 ? 'partial' : 'unknown') : 'complete'
  return { tokenTotal: coverage === 'unknown' && knownTotal === 0 ? null : knownTotal, coverage }
}

// WorkItem.state 派生(只读,不落盘):planned/executing/awaitingReview/accepted/blocked/withdrawn
export function deriveWorkItemState(aggregate, workItem) {
  if (workItem.replacedBy) return 'withdrawn'
  const runs = Object.values(aggregate.runs).filter((r) => r.workItemId === workItem.workItemId)
  const inFlight = runs.find((r) => ['prepared', 'submitted', 'running'].includes(r.state))
  if (inFlight) return 'executing'
  const depsMissing = workItem.dependencyWorkItemIds.some((id) => {
    const dep = aggregate.workItems[id]
    return dep === undefined || dep.replacedBy !== null
  })
  const blockedByAuth = !aggregate.authorization || aggregate.authorization.definitionRevision !== aggregate.definitionRevision
  if ((depsMissing || blockedByAuth) && aggregate.businessState !== 'completed') return 'blocked'
  const accepted = runs.some((r) => {
    const report = aggregate.reports[r.workItemId + ':' + r.runId] ?? Object.values(aggregate.reports).find((rep) => rep.runId === r.runId)
    return report?.verdict === 'pass' && !report.historical
  })
  if (accepted) return 'accepted'
  const awaiting = runs.some((r) => {
    const report = Object.values(aggregate.reports).find((rep) => rep.runId === r.runId)
    return report && ['ready_for_review'].includes(report.verdict) && !report.historical
  })
  if (awaiting) return 'awaitingReview'
  return 'planned'
}
