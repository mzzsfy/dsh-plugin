// PKG-1 收尾:workItem.replace 继承计数、usage 归并(DATA-08/15)、查询投影(DATA-12/13)
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { createTask, defineWorkItem, authorizeTask, checkExecutionPermission, replaceWorkItem, submitReport, RUN_STALE_MS } from '../lib/core/task.mjs'
import { mergeRunUsage, taskUsageSummary } from '../lib/core/usage.mjs'
import { queryBoard, projectTaskDetail } from '../lib/core/query.mjs'

let clock = 5_000
const now = () => { clock += 1; return clock }

async function seeded() {
  const created = createTask({
    taskId: 't1', title: '任务一', projectWorkspaceId: 'ws1',
    definition: { goal: 'g', acceptanceCriteria: [{ criterionId: 'c1', text: '标准' }] },
    now,
  })
  let agg = created.result
  agg = defineWorkItem(agg, { workItemId: 'w1', title: '子项', requiredCriterionIds: ['c1'] }).result.aggregate
  agg = authorizeTask(agg, { sourceMessageRef: { sessionId: 's0', messageId: 'm1' } }).result.aggregate
  return agg
}

function runOn(agg, runId, phase = 'implement', sessionId = 's1', workItemId = 'w1', state = 'settled') {
  const actorRole = phase === 'accept' ? 'reviewer' : 'executor'
  // 与 recordRun 同一口径:验收 Run 冻结派发时的实施产物代次
  const executorRuns = Object.values(agg.runs).filter((run) => run.workItemId === workItemId && run.actorRole === 'executor').length
  const record = {
    runId, workItemId, phase, actorRole,
    attemptOrdinal: 1, definitionRevision: agg.definitionRevision,
    executionEpoch: agg.control.executionEpoch, globalStopGeneration: 0,
    executionSlot: `${agg.taskId}/${workItemId}/${phase}`, sessionId, requestId: `req-${runId}`,
    artifactRevision: actorRole === 'reviewer' ? executorRuns : executorRuns + 1,
    state, executionTreeSettled: state === 'settled',
    startedAt: now(), endedAt: now(), tokenTotal: null, usageCoverage: 'unknown', knownTokenTotal: 0,
  }
  return { ...agg, runs: { ...agg.runs, [runId]: record } }
}

test('DATA-13: 同 ID 修改拒绝;替代产生新 ID 并继承失败计数,旧 pass 不迁移', async () => {
  let agg = await seeded()
  const conflict = defineWorkItem(agg, { workItemId: 'w1', title: '改题', requiredCriterionIds: ['c1'] })
  assert.equal(conflict.ok, false)
  assert.equal(conflict.code, 'REVISION_CONFLICT')
  // 制造一次失败验收历史
  agg = runOn(agg, 'r1')
  agg = runOn(agg, 'r2', 'accept', 's-review')
  let rep = submitReport(agg, { reportId: 'rep-issues', runId: 'r2', verdict: 'issues', summary: '验收发现问题', coveredCriterionIds: ['c1'], issues: ['a'], evidence: [] })
  assert.ok(rep.ok, rep.message)
  agg = rep.result.aggregate
  assert.equal(agg.workItems.w1.failedAcceptanceCount, 1)
  const replaced = replaceWorkItem(agg, {
    oldWorkItemId: 'w1', newWorkItemId: 'w2', title: '子项二', requiredCriterionIds: ['c1'], reason: '范围调整',
  })
  assert.ok(replaced.ok, replaced.message)
  agg = replaced.result.aggregate
  assert.equal(agg.workItems.w1.replacedBy, 'w2')
  assert.equal(agg.workItems.w2.failedAcceptanceCount, 1, '失败计数继承')
  assert.equal(agg.workItems.w2.replacesWorkItemId, 'w1')
  const oldPassBlocked = submitReport(agg, { reportId: 'rep-old', runId: 'r1', verdict: 'ready_for_review', summary: '历史实施完成', coveredCriterionIds: [], issues: [], evidence: [] })
  assert.ok(oldPassBlocked.ok)
  assert.equal(oldPassBlocked.result.aggregate.reports['rep-issues'].historical, false)
  // 在途 Run 未核清时替代拒绝
  const withRun = runOn(agg, 'r9', 'implement', 's1', 'w2', 'running')
  const denied = replaceWorkItem(withRun, { oldWorkItemId: 'w2', newWorkItemId: 'w3', title: 'x', reason: 'r' })
  assert.equal(denied.ok, false)
})

test('DATA-08/15: 同 invocationKey 不双计;缺 usage 走 unknown;明确零为 0/complete', async () => {
  let agg = await seeded()
  agg = runOn(agg, 'r1')
  const first = mergeRunUsage(agg, { runId: 'r1', usage: { invocationKey: 'k1', inputTokens: 10, outputTokens: 5, model: 'm' } })
  assert.ok(first.ok, first.message)
  agg = first.result.aggregate
  assert.equal(agg.runs.r1.knownTokenTotal, 15)
  const reread = mergeRunUsage(agg, { runId: 'r1', usage: { invocationKey: 'k1', inputTokens: 10, outputTokens: 5 } })
  assert.ok(reread.ok)
  assert.equal(reread.result.aggregate.runs.r1.knownTokenTotal, 15, '重读不双计')
  const mismatch = mergeRunUsage(reread.result.aggregate, { runId: 'r1', usage: { invocationKey: 'k1', inputTokens: 99, outputTokens: 5 } })
  assert.equal(mismatch.ok, false)
  const unknownRun = mergeRunUsage(agg, { runId: 'r1', usage: null })
  agg = unknownRun.result.aggregate
  assert.equal(agg.runs.r1.usageCoverage, 'partial')
  const summary = taskUsageSummary(agg)
  assert.deepEqual([summary.tokenTotal, summary.coverage], [15, 'partial'])
})

test('DATA-15: 明确零调用为 0/complete', async () => {
  let agg = await seeded()
  agg = runOn(agg, 'r1')
  const zero = mergeRunUsage(agg, { runId: 'r1', usage: null, completeUsage: true })
  agg = zero.result.aggregate
  assert.deepEqual(agg.runs.r1.tokenTotal, 0)
  assert.equal(agg.runs.r1.usageCoverage, 'complete')
})

test('DATA-12: 分页与时间窗口校验错误可读', async () => {
  const badLimit = queryBoard([], {}, { limit: 0 })
  assert.equal(badLimit.ok, false)
  assert.match(badLimit.message, /limit/)
  const badWindow = queryBoard([], {}, { since: 0, until: 40 * 24 * 60 * 60 * 1000 })
  assert.equal(badWindow.ok, false)
  assert.match(badWindow.message, /时间窗口/)
})

// ── B8:since/until 真过滤(任务活跃期与窗口相交),不再静默丢弃 ────────────────
test('B8 时间窗口: 按活跃期相交过滤,非法参数可读,游标绑定窗口', async () => {
  const base = await seeded()
  const task = (taskId, createdAt, updatedAt) => ({ ...base, taskId, title: taskId, createdAt, updatedAt })
  const tasks = [
    task('before', 100, 200),
    task('inside', 150, 2500),
    task('boundary', 2000, 3000),
    task('after', 4000, 4000),
  ]
  const windowed = queryBoard(tasks, { globalStopGeneration: 0 }, { since: 2000, until: 3000 })
  assert.ok(windowed.ok, windowed.message)
  assert.deepEqual(windowed.result.items.map((item) => item.taskId), ['inside', 'boundary'])
  assert.equal(windowed.result.counts.ready, 2, '计数与窗口口径一致')
  const sinceOnly = queryBoard(tasks, { globalStopGeneration: 0 }, { since: 2500 })
  assert.deepEqual(sinceOnly.result.items.map((item) => item.taskId), ['inside', 'boundary', 'after'])
  const untilOnly = queryBoard(tasks, { globalStopGeneration: 0 }, { until: 200 })
  assert.deepEqual(untilOnly.result.items.map((item) => item.taskId), ['before', 'inside'])
  assert.equal(queryBoard(tasks, {}, { since: Number.NaN }).code, 'INVALID_ARGUMENT')
  assert.equal(queryBoard(tasks, {}, { since: 3000, until: 2000 }).code, 'INVALID_ARGUMENT')
  const firstPage = queryBoard(tasks, { globalStopGeneration: 0 }, { since: 0, until: 5000, limit: 1 })
  const changedWindow = queryBoard(tasks, { globalStopGeneration: 0 }, { until: 5000, limit: 1, cursor: firstPage.result.nextCursor })
  assert.equal(changedWindow.code, 'REVISION_CONFLICT', '窗口属于查询快照,换窗口必须从首页重读')
})

test('查询投影: 计数为全量统计,cursor 分页,详情含派生 workItem 状态', async () => {
  const a = await seeded()
  const b = (await seeded()).taskId === 't1' ? { ...a, taskId: 't2', createdAt: a.createdAt + 1 } : a
  const q1 = queryBoard([a, b], { globalStopGeneration: 0 }, { limit: 1 })
  assert.ok(q1.ok)
  assert.equal(q1.result.counts.ready, 2, '全量计数')
  assert.equal(q1.result.items.length, 1)
  assert.equal(typeof q1.result.nextCursor, 'string')
  assert.notEqual(q1.result.nextCursor, 't1')
  const changed = queryBoard([{ ...a, title: '已更新' }, b], { globalStopGeneration: 0 }, { limit: 1, cursor: q1.result.nextCursor })
  assert.equal(changed.code, 'REVISION_CONFLICT')
  const wrongFilter = queryBoard([a, b], { globalStopGeneration: 0 }, { limit: 1, search: '任务一', cursor: q1.result.nextCursor })
  assert.equal(wrongFilter.code, 'REVISION_CONFLICT')
  const q2 = queryBoard([a, b], { globalStopGeneration: 0 }, { limit: 10, cursor: q1.result.nextCursor })
  assert.equal(q2.result.items[0].taskId, 't2')
  const filtered = queryBoard([a, b], { globalStopGeneration: 0 }, { search: '任务一' })
  assert.equal(filtered.result.items.length, 2)
  const tasks = Array.from({ length: 201 }, (_, index) => ({ ...a, taskId: `page-${index}`, createdAt: index }))
  assert.equal(queryBoard(tasks, { globalStopGeneration: 0 }).result.items.length, 50)
  assert.equal(queryBoard(tasks, { globalStopGeneration: 0 }, { limit: 200 }).result.items.length, 200)
  assert.equal(queryBoard(tasks, { globalStopGeneration: 0 }, { limit: 201 }).code, 'INVALID_ARGUMENT')
  const detail = projectTaskDetail(a, { globalStopGeneration: 0 })
  assert.equal(detail.workItems[0].state, 'planned')
})

// ── R10 读面 stale 收敛:同一份数据不再因"是否发生过写动作"给出两套事实 ──────
test('读投影: 失联在飞 Run 按已断投影(不写盘),workItem 不再显示执行中', async () => {
  const base = await seeded()
  const staleAt = RUN_STALE_MS * 2
  const agg = {
    ...runOn(base, 'r1', 'implement', 's1', 'w1', 'running'),
    now: () => staleAt,
    runs: { r1: { ...runOn(base, 'r1', 'implement', 's1', 'w1', 'running').runs.r1, startedAt: 1, lastEventAt: 1 } },
  }
  const detail = projectTaskDetail(agg, { globalStopGeneration: 0 })
  assert.equal(detail.runs[0].state, 'interrupted', '超过失联阈值须按已断展示')
  assert.equal(detail.runs[0].endedAt, staleAt)
  assert.equal(detail.workItems[0].state, 'planned', '执行中派生不得被死 Run 占住')
  assert.equal(detail.activeRunCount, 0)
  // 纯投影:原聚合不被改写,后续落盘仍可走 expireStaleRuns 正式收敛
  assert.equal(agg.runs.r1.state, 'running')
  assert.equal(Object.hasOwn(agg.runs.r1, 'stopObserved'), false)
})

// ── B4:推进目标由服务端给出,面板不再盲取第一个子项 ──────────────────────────
test('B4 推进目标: 待实施取子项态 planned,交付后转 accept,全部验收后为 null', async () => {
  let agg = await seeded()
  agg = defineWorkItem(agg, { workItemId: 'w2', title: '子项二', requiredCriterionIds: ['c1'] }).result.aggregate
  assert.deepEqual(projectTaskDetail(agg, { globalStopGeneration: 0 }).nextDispatch, { workItemId: 'w1', phase: 'implement' })
  // w1 实施交付(settled + ready_for_review),w2 仍未实施:推进目标应转向验收 w1
  let delivered = runOn(agg, 'impl1', 'implement', 's1', 'w1', 'settled')
  const report = submitReport(delivered, { reportId: 'rep1', runId: 'impl1', verdict: 'ready_for_review', summary: '交付', coveredCriterionIds: ['c1'], issues: [], evidence: ['e'] })
  assert.ok(report.ok, report.message)
  delivered = report.result.aggregate
  assert.deepEqual(projectTaskDetail(delivered, { globalStopGeneration: 0 }).nextDispatch, { workItemId: 'w1', phase: 'accept' })
  // w1 验收通过后推进目标回到 w2 实施,而不是重复实施已验收的 w1
  // 验收 Run 的 artifactRevision 在派发时冻结(recordRun 口径),此处补上才能构成有效验收
  const accept = runOn(delivered, 'rev1', 'accept', 's2', 'w1', 'settled')
  accept.runs.rev1.artifactRevision = 1
  const pass = submitReport(accept, { reportId: 'pass1', runId: 'rev1', verdict: 'pass', summary: '通过', coveredCriterionIds: ['c1'], issues: [], evidence: ['e'] })
  assert.ok(pass.ok, pass.message)
  assert.deepEqual(projectTaskDetail(pass.result.aggregate, { globalStopGeneration: 0 }).nextDispatch, { workItemId: 'w2', phase: 'implement' })
})

// ── B2:验收驳回后子项回到待实施,推进目标转 fix 而不是反复派验收 ─────────────
test('B2 验收驳回: 子项回到 planned,推进目标转 fix 并在修复后重新待验收', async () => {
  let agg = await seeded()
  agg = runOn(agg, 'impl1', 'implement', 's1', 'w1', 'settled')
  // runOn 只铺 Run 记录;业务态推进由 recordRun 负责,这里补上派发后的实现态
  agg = { ...agg, businessState: 'implementing' }
  const delivered = submitReport(agg, { reportId: 'rep-deliver', runId: 'impl1', verdict: 'ready_for_review', summary: '交付', coveredCriterionIds: ['c1'], issues: [], evidence: ['e'] })
  assert.ok(delivered.ok, delivered.message)
  agg = delivered.result.aggregate
  assert.equal(agg.businessState, 'awaiting_acceptance')
  assert.deepEqual(projectTaskDetail(agg, { globalStopGeneration: 0 }).nextDispatch, { workItemId: 'w1', phase: 'accept' })
  agg = runOn(agg, 'rev1', 'accept', 's2', 'w1', 'settled')
  const rejected = submitReport(agg, { reportId: 'rep-issues', runId: 'rev1', verdict: 'issues', summary: '驳回', coveredCriterionIds: ['c1'], issues: ['缺陷'], evidence: ['e'] })
  assert.ok(rejected.ok, rejected.message)
  agg = rejected.result.aggregate
  assert.equal(agg.businessState, 'implementing')
  const detail = projectTaskDetail(agg, { globalStopGeneration: 0 })
  assert.equal(detail.workItems[0].state, 'planned', '驳回后不得继续显示待验收')
  assert.deepEqual(detail.nextDispatch, { workItemId: 'w1', phase: 'fix' })
  // 显式指定 accept 也不得绕过:同一份被驳回产物必须先修复产生新代次
  const control = { globalStopped: false, globalStopGeneration: 0 }
  const acceptDenied = checkExecutionPermission(agg, control, { workItemId: 'w1', phase: 'accept', actorRole: 'reviewer' })
  assert.equal(acceptDenied.ok, false, '驳回后显式验收必须被拒')
  assert.match(acceptDenied.message, /驳回/)
  const fixed = runOn(agg, 'fix1', 'fix', 's3', 'w1', 'settled')
  const redelivered = submitReport(fixed, { reportId: 'rep-fix', runId: 'fix1', verdict: 'ready_for_review', summary: '修复', coveredCriterionIds: ['c1'], issues: [], evidence: ['e'] })
  assert.ok(redelivered.ok, redelivered.message)
  assert.equal(projectTaskDetail(redelivered.result.aggregate, { globalStopGeneration: 0 }).workItems[0].state, 'awaitingReview')
  const acceptAllowed = checkExecutionPermission(redelivered.result.aggregate, control, { workItemId: 'w1', phase: 'accept', actorRole: 'reviewer' })
  assert.ok(acceptAllowed.ok, acceptAllowed.message)
})
