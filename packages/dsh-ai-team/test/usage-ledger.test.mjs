// D10(CAP-09)usage 权威合并对账:retry/重读/fork 继承不双计,chunk+message 双通道一致,缺 usage 走 unknown。
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { createTask, defineWorkItem, authorizeTask } from '../lib/core/task.mjs'
import { recordRun } from '../lib/core/task.mjs'
import { mergeRunUsage, taskUsageSummary } from '../lib/core/usage.mjs'

function seededAggregate() {
  const now = () => 1
  const created = createTask({ taskId: 't-u', title: 'usage', projectWorkspaceId: 'ws', definition: { goal: 'g', acceptanceCriteria: [{ criterionId: 'c1', text: 'c' }], dependencyTaskIds: [] }, now })
  let agg = created.result
  agg = defineWorkItem(agg, { workItemId: 'w1', title: 'w', requiredCriterionIds: ['c1'] }).result.aggregate
  agg = authorizeTask(agg, { sourceMessageRef: { sessionId: 's0', messageId: 'm0' } }).result.aggregate
  return agg
}

function withRun(agg) {
  return recordRun(agg, { runId: 'r1', workItemId: 'w1', phase: 'implement', sessionId: 's1', requestId: 'q1', presetId: 'ai-team-worker', slotKey: 'w1', globalControl: { globalStopped: false, globalStopGeneration: 0, taskAllows: {} } }).result.aggregate
}

const USAGE = { invocationKey: 'inv-1', inputTokens: 10, outputTokens: 5, model: 'm' }

test('retry 同 invocationKey 不双计,不一致拒绝', () => {
  const agg = mergeRunUsage(withRun(seededAggregate()), { runId: 'r1', usage: USAGE }).result.aggregate
  const replay = mergeRunUsage(agg, { runId: 'r1', usage: { ...USAGE } })
  assert.equal(replay.ok, true)
  assert.equal(replay.result.aggregate.runs.r1.tokenTotal, 15)
  const conflict = mergeRunUsage(agg, { runId: 'r1', usage: { ...USAGE, inputTokens: 99 } })
  assert.equal(conflict.ok, false)
  assert.equal(conflict.code, 'INVALID_ARGUMENT')
})

test('fork 继承同 key 归并到首 Run,跨 Run 不重复入总量', () => {
  let agg = withRun(seededAggregate())
  agg = recordRun(agg, { runId: 'r2', workItemId: 'w1', phase: 'implement', sessionId: 's2', requestId: 'q2', presetId: 'ai-team-worker', globalControl: { globalStopped: false, globalStopGeneration: 0, taskAllows: {} } }).result.aggregate
  agg = mergeRunUsage(agg, { runId: 'r1', usage: USAGE }).result.aggregate
  // fork 子 Run 回报同 invocationKey(继承父调用),不双计
  const merged = mergeRunUsage(agg, { runId: 'r2', usage: { ...USAGE } })
  assert.equal(merged.ok, true)
  assert.equal(merged.result.aggregate.runs.r1.tokenTotal, 15)
  assert.equal(merged.result.aggregate.runs.r2.knownTokenTotal ?? 0, 0)
})

test('chunk 与 message 双通道同 key 一致合并;缺 usage 计 unknown', () => {
  let agg = withRun(seededAggregate())
  agg = mergeRunUsage(agg, { runId: 'r1', usage: { ...USAGE, invocationKey: 'chunk-1', inputTokens: 3, outputTokens: 2 } }).result.aggregate
  agg = mergeRunUsage(agg, { runId: 'r1', usage: { ...USAGE, invocationKey: 'msg-1', inputTokens: 4, outputTokens: 1 } }).result.aggregate
  assert.equal(agg.runs.r1.tokenTotal, 10)
  assert.equal(agg.runs.r1.usageCoverage, 'complete')
  const unknown = mergeRunUsage(agg, { runId: 'r1' })
  assert.equal(unknown.ok, true)
  assert.equal(unknown.result.aggregate.runs.r1.unknownUsageCount, 1)
  assert.equal(unknown.result.aggregate.runs.r1.usageCoverage, 'partial')
  assert.equal(taskUsageSummary(unknown.result.aggregate).coverage, 'partial')
})

test('明确零调用 coverage=complete 且总量 0', () => {
  const agg = mergeRunUsage(withRun(seededAggregate()), { runId: 'r1', completeUsage: true }).result.aggregate
  assert.equal(agg.runs.r1.usageCoverage, 'complete')
  assert.equal(agg.runs.r1.tokenTotal, 0)
})
