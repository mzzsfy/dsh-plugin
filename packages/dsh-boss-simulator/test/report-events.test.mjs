import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRunReportCollector } from '../lib/core/report-events.mjs'

const REPORT = JSON.stringify({ summary: '实现完成', verdict: 'ready_for_review', coveredCriterionIds: [], issues: [], evidence: [] })

function fixture({ state = 'submitted', requestId = 'req-1', sessionId = 's1' } = {}) {
  const aggregate = {
    taskId: 't1', now: () => 10,
    definitionRevision: 1,
    control: { executionEpoch: 1 },
    workItems: { w1: { requiredCriterionIds: [], failureSources: [], failedAcceptanceCount: 0 } },
    runs: { r1: { runId: 'r1', workItemId: 'w1', phase: 'implement', actorRole: 'executor', requestId, sessionId, state, executionEpoch: 1, definitionRevision: 1, requiredCriterionIds: [] } },
    reports: {}, sessions: {}, businessState: 'implementing',
  }
  let current = aggregate
  const writes = []
  const store = {
    async loadAggregate(taskId) { assert.equal(taskId, 't1'); return current },
    async saveAggregate(next) { current = next; writes.push(next); return next },
    async updateAggregate(taskId, update) { assert.equal(taskId, 't1'); current = update(current); writes.push(current); return current },
  }
  const collector = createRunReportCollector({ taskId: 't1', sessionId, store })
  collector.accept({ type: 'turn/start', seq: 0, time: 90, data: { turn: 7 } })
  return { collector, store, get aggregate() { return current }, writes }
}

const event = (type, turn, data, seq = 1, time = 100) => ({ type, data: { turn, ...data }, seq, time })
const user = (_turn = 7, rpcId = 'req-1') => ({ type: 'user/message', seq: 1, time: 100, data: { id: 'user1', role: 'user', content: [{ type: 'text', text: '任务' }], source: { kind: 'user', rpcId } } })
const assistant = (turn = 7, content = REPORT, interrupted = false) => event('assistant/message', turn, { message: { content: [{ type: 'text', text: content }] }, ...(interrupted ? { interrupted: true } : {}) }, 2, 200)
const ended = (turn = 7, kind = 'completed') => event('turn/end', turn, { reason: { kind } }, 3, 300)

test('Given 宿主真实扁平 user message 无 turn When 按前置 turn/start 归属 Then 通过 rpcId 采纳报告', async () => {
  const f = fixture()
  await f.collector.accept({ type: 'turn/start', seq: 1, time: 90, data: { turn: 7 } })
  await f.collector.accept({ type: 'user/message', seq: 2, time: 100, data: { id: 'message-user', source: { kind: 'user', rpcId: 'req-1' }, content: [{ type: 'text', text: '任务' }] } })
  await f.collector.accept({ ...assistant(), seq: 3 })
  await f.collector.accept({ ...ended(), seq: 4 })
  assert.equal(f.aggregate.runs.r1.state, 'settled')
  assert.ok(f.aggregate.reports['s1:3'])
})

test('Given 已派发 Run When durable 报告先于 turn/end 到达 Then 关联报告结算该 Run', async () => {
  const f = fixture()
  await f.collector.accept(user())
  await f.collector.accept({ type: 'turn/start', time: 90, data: { turn: 7 } })
  await f.collector.accept(assistant())
  assert.equal(f.aggregate.runs.r1.state, 'running')
  await f.collector.accept(ended())
  assert.equal(f.aggregate.runs.r1.state, 'settled')
  assert.equal(f.aggregate.reports['s1:2'].summary, '实现完成')
})

test('Given 已派发 Run When turn/end 先于 assistant 报告到达 Then 等待最终消息后才结算', async () => {
  const f = fixture()
  await f.collector.accept(user())
  await f.collector.accept({ type: 'turn/start', time: 90, data: { turn: 7 } })
  assert.equal(f.aggregate.runs.r1.startedAt, 90)
  await f.collector.accept(ended())
  assert.equal(f.aggregate.runs.r1.state, 'running')
  await f.collector.accept(assistant())
  assert.equal(f.aggregate.runs.r1.state, 'settled')
  assert.equal(f.aggregate.reports['s1:2'].verdict, 'ready_for_review')
  assert.equal(f.aggregate.runs.r1.startedAt, 90)
})

test('Given turn/end 无 assistant 报告 When 事件流结束 Then Run 不结算', async () => {
  const f = fixture()
  await f.collector.accept(user())
  await f.collector.accept(ended())
  assert.equal(f.aggregate.runs.r1.state, 'running')
  assert.deepEqual(f.aggregate.reports, {})
})

test('Given assistant JSON 不符合报告契约 When turn 正常结束 Then 不写报告', async () => {
  const f = fixture()
  await f.collector.accept(user())
  await f.collector.accept(assistant(7, '{bad'))
  await f.collector.accept(ended())
  assert.equal(f.aggregate.runs.r1.state, 'running')
  assert.deepEqual(f.aggregate.reports, {})
})

test('Given turn 被中断 When assistant 带 partial 标记并结束 Then 不采纳部分文本', async () => {
  const f = fixture()
  await f.collector.accept(user())
  await f.collector.accept(assistant(7, REPORT, true))
  await f.collector.accept(ended(7, 'aborted'))
  assert.equal(f.aggregate.runs.r1.state, 'running')
  assert.deepEqual(f.aggregate.reports, {})
})

test('Given 同 session 的其他 RPC When 收到合法报告 Then 不匹配 Run 而保持不变', async () => {
  const f = fixture()
  await f.collector.accept(user(7, 'unrelated-rpc'))
  await f.collector.accept(assistant())
  await f.collector.accept(ended())
  assert.equal(f.aggregate.runs.r1.state, 'submitted')
  assert.deepEqual(f.aggregate.reports, {})
})

test('Given 非 completed turn When 收到看似有效的最终 JSON Then 报告不落库且 Run 保持未结', async () => {
  const f = fixture()
  await f.collector.accept(user())
  await f.collector.accept(assistant())
  await f.collector.accept(ended(7, 'max-tokens'))
  assert.equal(f.aggregate.runs.r1.state, 'running')
  assert.deepEqual(f.aggregate.reports, {})
})

test('Given assistant partial event When turn 正常结束 Then interrupted 标志仍阻止报告采纳', async () => {
  const f = fixture()
  await f.collector.accept(user())
  await f.collector.accept(assistant(7, REPORT, true))
  await f.collector.accept(ended())
  assert.equal(f.aggregate.runs.r1.state, 'running')
  assert.deepEqual(f.aggregate.reports, {})
})

test('Given turn 被 aborted When 部分 assistant 内容存在 Then 不结算 Run', async () => {
  const f = fixture()
  await f.collector.accept(user())
  await f.collector.accept(assistant())
  await f.collector.accept(ended(7, 'aborted'))
  assert.equal(f.aggregate.runs.r1.state, 'running')
  assert.deepEqual(f.aggregate.reports, {})
})
test('Given snapshot assistant message 先于匹配 user/message When 后续事件补齐 Then 按 RPC 关联并提交报告', async () => {
  const f = fixture()
  await f.collector.accept(assistant())
  await f.collector.accept(ended())
  await f.collector.accept(user())
  await f.collector.accept(ended())
  assert.equal(Object.keys(f.aggregate.reports).length, 1)
  assert.equal(f.aggregate.runs.r1.state, 'settled')
})

test('Given 已按前置 start 关联 user When start 重放 Then 保留宿主 turn start 时间', async () => {
  const f = fixture()
  await f.collector.accept(user())
  assert.equal(f.aggregate.runs.r1.startedAt, 90)
  await f.collector.accept({ type: 'turn/start', seq: 0, time: 90, data: { turn: 7 } })
  assert.equal(f.aggregate.runs.r1.startedAt, 90)
  await f.collector.accept(assistant())
  await f.collector.accept(ended())
  assert.equal(f.aggregate.runs.r1.startedAt, 90)
})

test('Given 报告原子更新首次失败 When durable 事件重放 Then 报告可成功提交', async () => {
  const f = fixture()
  const originalUpdate = f.store.updateAggregate
  let failOnce = false
  f.store.updateAggregate = async (...args) => {
    if (failOnce) { failOnce = false; throw new Error('temporary storage failure') }
    return originalUpdate(...args)
  }
  await f.collector.accept(user())
  await f.collector.accept(assistant())
  failOnce = true
  await assert.rejects(f.collector.accept(ended()), /temporary storage failure/)
  await f.collector.accept(ended())
  assert.equal(Object.keys(f.aggregate.reports).length, 1)
})
test('Given executor 收到非法 pass When 后续更高序号最终报告到达 Then 采纳有效实施报告', async () => {
  const f = fixture()
  const invalidPass = JSON.stringify({ summary: '验收', verdict: 'pass', coveredCriterionIds: [], issues: [], evidence: [] })
  await f.collector.accept(user())
  await f.collector.accept(assistant(7, invalidPass))
  await f.collector.accept(ended())
  assert.equal(f.aggregate.runs.r1.state, 'running')
  assert.deepEqual(f.aggregate.reports, {})
  await f.collector.accept({ ...assistant(), seq: 4 })
  await f.collector.accept({ ...ended(), seq: 5 })
  assert.equal(f.aggregate.runs.r1.state, 'settled')
})
test('Given 多条 assistant durable 消息乱序 When 完成 turn Then 采纳最大 seq 最终消息', async () => {
  const f = fixture()
  await f.collector.accept(user())
  await f.collector.accept({ ...assistant(), seq: 5 })
  await f.collector.accept({ ...assistant(7, '{bad'), seq: 2 })
  await f.collector.accept({ ...ended(), seq: 6 })
  assert.equal(f.aggregate.runs.r1.state, 'settled')
  assert.ok(f.aggregate.reports['s1:5'])
})

test('Given 报告 JSON 非法 When turn 完成 Then Run 持久记录可查询诊断', async () => {
  const f = fixture()
  await f.collector.accept(user())
  await f.collector.accept(assistant(7, '{bad'))
  await f.collector.accept(ended())
  assert.equal(f.aggregate.runs.r1.reportDiagnostic.kind, 'invalid_report')
  assert.equal(f.aggregate.runs.r1.reportDiagnostic.eventSeq, 2)
})

test('Given 非法报告诊断首次写盘失败 When 事件重放 Then 补写持久诊断', async () => {
  const f = fixture()
  const update = f.store.updateAggregate
  let fail = true
  f.store.updateAggregate = async (id, transform) => {
    const next = transform(await f.store.loadAggregate(id))
    if (fail && next.runs.r1.reportDiagnostic) { fail = false; throw new Error('diagnostic disk failure') }
    return update(id, transform)
  }
  await f.collector.accept(user())
  await f.collector.accept(assistant(7, '{bad'))
  await assert.rejects(f.collector.accept(ended()), /diagnostic disk failure/)
  await f.collector.accept(ended())
  assert.equal(f.aggregate.runs.r1.reportDiagnostic.kind, 'invalid_report')
})

test('Given 同一 durable assistant event 重复消费 When 完成事件重放 Then 只持久化一份报告', async () => {
  const f = fixture()
  await f.collector.accept(user())
  await f.collector.accept(assistant())
  await f.collector.accept(ended())
  assert.equal(Object.keys(f.aggregate.reports).length, 1)
  assert.equal(f.aggregate.runs.r1.state, 'settled')
})
