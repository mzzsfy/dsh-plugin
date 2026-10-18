// PKG-1 收尾:workItem.replace 继承计数、usage 归并(DATA-08/15)、查询投影(DATA-12/13)
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { createTask, defineWorkItem, authorizeTask, replaceWorkItem, submitReport } from '../lib/core/task.mjs'
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
  const record = {
    runId, workItemId, phase, actorRole: phase === 'accept' ? 'reviewer' : 'executor',
    attemptOrdinal: 1, definitionRevision: agg.definitionRevision,
    executionEpoch: agg.control.executionEpoch, globalStopGeneration: 0,
    executionSlot: `${agg.taskId}/${workItemId}/${phase}`, sessionId, requestId: `req-${runId}`,
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
