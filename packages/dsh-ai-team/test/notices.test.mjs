// D1 通知编排对账:记录幂等/暂停积压/投递去重。
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { createTask, defineWorkItem, authorizeTask, recordRun } from '../lib/core/task.mjs'
import { recordNotice, deliverable, planDelivery } from '../lib/core/notices.mjs'

function seeded() {
  const now = () => 1
  let agg = createTask({ taskId: 't-n', title: 'n', projectWorkspaceId: 'ws', definition: { goal: 'g', acceptanceCriteria: [{ criterionId: 'c1', text: 'c' }], dependencyTaskIds: [] }, now }).result
  agg = defineWorkItem(agg, { workItemId: 'w1', title: 'w', requiredCriterionIds: ['c1'] }).result.aggregate
  agg = authorizeTask(agg, { sourceMessageRef: { sessionId: 's0', messageId: 'm0' } }).result.aggregate
  return recordRun(agg, { runId: 'r1', workItemId: 'w1', phase: 'implement', sessionId: 's1', requestId: 'q1', presetId: 'ai-team-worker', slotKey: 'w1', globalControl: { globalStopped: false, globalStopGeneration: 0, taskAllows: {} } }).result.aggregate
}

test('notice 记录幂等:同 noticeId 重放不产生第二条', () => {
  const first = recordNotice(seeded(), { noticeId: 'n1', kind: 'run_settled', detail: { runId: 'r1' } })
  const replay = recordNotice(first.result.aggregate, { noticeId: 'n1', kind: 'run_settled' })
  assert.equal(replay.result.replayed, true)
  assert.equal(Object.keys(replay.result.aggregate.notices).length, 1)
})

test('暂停/在途积压不投,恢复后投递且 requestId 去重', () => {
  const agg = recordNotice(seeded(), { noticeId: 'n1', kind: 'run_settled' }).result.aggregate
  // 在途 Run:积压
  assert.equal(deliverable(agg, agg.notices.n1), false)
  const plan0 = planDelivery(agg, { send: () => { throw new Error('不应投递') } })
  assert.equal(plan0.result.results[0].delivered, false)

  // 在途消除后投递;send 收到的 requestId 即 notice 去重键
  const drained = { ...agg, runs: { ...agg.runs, r1: { ...agg.runs.r1, state: 'settled' } } }
  const seen = []
  const plan1 = planDelivery(drained, { send: ({ requestId }) => { seen.push(requestId); return { accepted: true } } })
  assert.deepEqual(seen, ['notice-n1'])
  assert.equal(plan1.result.aggregate.notices.n1.state, 'delivered')
  // 已投递不再投
  const plan2 = planDelivery(plan1.result.aggregate, { send: () => { throw new Error('不应重复投递') } })
  assert.equal(plan2.result.results[0].delivered, false)
})
