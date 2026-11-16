import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRunReportCollector, HEARTBEAT_MIN_WRITE_MS } from '../lib/core/report-events.mjs'
import { RUN_STALE_MS, isStaleRun } from '../lib/core/task.mjs'

const REPORT = JSON.stringify({ summary: '实现完成', verdict: 'ready_for_review', coveredCriterionIds: [], issues: [], evidence: [] })

function fixture({ state = 'submitted', requestId = 'req-1', sessionId = 's1', runPatch = {}, controlPatch = {}, reports = {} } = {}) {
  const aggregate = {
    taskId: 't1', now: () => 10,
    definitionRevision: 1,
    control: { executionEpoch: 1, state: 'active', ...controlPatch },
    workItems: { w1: { requiredCriterionIds: [], failureSources: [], failedAcceptanceCount: 0 } },
    runs: { r1: { runId: 'r1', workItemId: 'w1', phase: 'implement', actorRole: 'executor', requestId, sessionId, state, executionEpoch: 1, definitionRevision: 1, requiredCriterionIds: [], ...runPatch } },
    reports: { ...reports }, sessions: {}, businessState: 'implementing',
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

test('Given Run 已中断(失联收敛) When 迟到回合的 completed 报告到达 Then 不复活但落可采纳诊断', async () => {
  const f = fixture({ state: 'interrupted', runPatch: { stopObserved: 'unreachable', definitionRevision: 1 } })
  await f.collector.accept(user())
  await f.collector.accept(assistant())
  await f.collector.accept(ended())
  assert.equal(f.aggregate.runs.r1.state, 'interrupted', '已中断的 Run 不得被迟到报告复活')
  assert.equal(Object.keys(f.aggregate.reports).length, 0, '不得为已中断 Run 落报告')
  const diagnostic = f.aggregate.runs.r1.reportDiagnostic
  assert.equal(diagnostic.kind, 'late_report', '迟到报告必须有出口而非静默丢弃')
  assert.equal(diagnostic.eventSeq, 2)
  assert.equal(diagnostic.adoptable, true, '失联收敛且任务未被停止时报告可采纳')
  assert.equal(diagnostic.report.summary, '实现完成')
  assert.equal(diagnostic.report.verdict, 'ready_for_review')
})

test('Given Run 已被用户停止 When 迟到报告到达 Then 诊断仍落账但标记不可采纳', async () => {
  const f = fixture({ state: 'interrupted', runPatch: { stopObserved: 'confirmed' }, controlPatch: { state: 'paused' } })
  await f.collector.accept(user())
  await f.collector.accept(assistant())
  await f.collector.accept(ended())
  const diagnostic = f.aggregate.runs.r1.reportDiagnostic
  assert.equal(diagnostic.kind, 'late_report')
  assert.equal(diagnostic.adoptable, false, '用户已停止的任务不得采纳迟到报告')
})

test('Given 已结算 Run When 同一报告重放 Then 不再写诊断(幂等)', async () => {
  const f = fixture({ state: 'interrupted', runPatch: { stopObserved: 'unreachable' } })
  await f.collector.accept(user())
  await f.collector.accept(assistant())
  await f.collector.accept(ended())
  const writesAfterFirst = f.writes.length
  await f.collector.accept({ ...assistant(), seq: 2 })
  await f.collector.accept({ ...ended(), seq: 3 })
  assert.equal(f.writes.length, writesAfterFirst, '重放不得重复刷写诊断')
  assert.equal(f.aggregate.runs.r1.reportDiagnostic.kind, 'late_report')
})

test('Given 已中断 Run When 迟到用量事件到达 Then 仍并入台账(不静默丢弃)', async () => {
  const f = fixture({ state: 'interrupted', runPatch: { stopObserved: 'unreachable' } })
  await f.collector.accept(user())
  await f.collector.accept({ ...assistant(), seq: 4, data: { turn: 7, usage: { inputTokens: 11, outputTokens: 7 }, message: { content: [{ type: 'text', text: REPORT }] } } })
  assert.equal(f.aggregate.runs.r1.tokenTotal, 18)
  assert.equal(f.aggregate.runs.r1.usageCoverage, 'complete')
  assert.equal(f.aggregate.runs.r1.observedUsage, undefined, '终态 Run 不写观察区,直接入台账')
})

test('Given 长工具调用无 assistant 事件 When tool 事件持续到达 Then lastEventAt 刷新且不被失联收敛', async () => {
  const f = fixture({ state: 'running', runPatch: { startedAt: 100, lastEventAt: 100 } })
  await f.collector.accept(user())
  const longTool = 100 + 10 * 60 * 1000
  await f.collector.accept({ type: 'tool/call', seq: 3, time: longTool, data: { turn: 7, toolName: 'bash' } })
  assert.equal(f.aggregate.runs.r1.lastEventAt, longTool, 'tool 事件也是活体证据')
  // 10 分钟后仍不足 15 分钟失联阈值:不得被收敛为 interrupted
  const { isStaleRun } = await import('../lib/core/task.mjs')
  assert.equal(isStaleRun(f.aggregate.runs.r1, { now: longTool + 60 * 1000 }), false)
})

test('Given 重复 turn/start When 到达 Then 刷新在飞 Run 的 lastEventAt(不误判失联)', async () => {
  const f = fixture({ state: 'running', runPatch: { startedAt: 100, lastEventAt: 100 } })
  await f.collector.accept(user())
  await f.collector.accept({ type: 'turn/start', seq: 4, time: 900, data: { turn: 7 } })
  assert.equal(f.aggregate.runs.r1.lastEventAt, 900)
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

// ── R15 回合中间态回收:非 completed 结束立即清理,重放不得补出陈旧报告 ──────
test('Given turn 以 aborted 结束 When 同 turn 的 completed 结束重放 Then 不补出报告', async () => {
  const f = fixture()
  await f.collector.accept(user())
  await f.collector.accept(assistant())
  await f.collector.accept(ended(7, 'aborted'))
  await f.collector.accept(ended())
  assert.deepEqual(f.aggregate.reports, {}, '回收后重放结束事件不得从陈旧中间态补报告')
  assert.equal(f.aggregate.runs.r1.state, 'running')
})

// ── R2 复检:节流不得丢事件时间。长工具调用期间没有后续事件时,补写必须用真实事件时间 ──
// 直接驱动 turn/start + user/message(逐条 await),节流基准可确定
async function heartbeatFixture() {
  let current = {
    taskId: 't1', now: () => 10, definitionRevision: 1,
    control: { executionEpoch: 1, state: 'active' },
    workItems: { w1: { requiredCriterionIds: [], failureSources: [], failedAcceptanceCount: 0 } },
    runs: { r1: { runId: 'r1', workItemId: 'w1', phase: 'implement', actorRole: 'executor', requestId: 'req-1', sessionId: 's1', state: 'running', executionEpoch: 1, definitionRevision: 1, startedAt: 1, lastEventAt: 1, requiredCriterionIds: [] } },
    reports: {}, sessions: {}, businessState: 'implementing',
  }
  const store = {
    async loadAggregate() { return current },
    async updateAggregate(taskId, update) { current = update(current); return current },
  }
  const collector = createRunReportCollector({ taskId: 't1', sessionId: 's1', store })
  await collector.accept({ type: 'turn/start', seq: 0, time: 90, data: { turn: 7 } })
  await collector.accept(user())
  return { collector, get aggregate() { return current } }
}

test('Given 工具事件落在心跳节流窗口内 When 窗口结束 Then 补写用真实事件时间且不被误判失联', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const f = await heartbeatFixture()
  assert.equal(f.aggregate.runs.r1.lastEventAt, 100)
  const toolAt = 100 + 120 * 1000
  await f.collector.accept({ type: 'tool/call', seq: 3, time: toolAt, data: { turn: 7, toolName: 'bash' } })
  assert.equal(f.aggregate.runs.r1.lastEventAt, 100, '窗口内落盘可推迟')
  assert.equal(HEARTBEAT_MIN_WRITE_MS > toolAt - 100, true, '本用例必须落在节流窗口内')
  t.mock.timers.tick(HEARTBEAT_MIN_WRITE_MS)
  await new Promise((resolve) => setImmediate(resolve))
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(f.aggregate.runs.r1.lastEventAt, toolAt, '补写必须是事件时间,不是节流起点')
  const now = toolAt + 13 * 60 * 1000
  assert.equal(now - toolAt < RUN_STALE_MS, true, '13 分钟仍不足失联阈值')
  assert.equal(isStaleRun(f.aggregate.runs.r1, { now }), false, '距真实工具事件 13 分钟不得判失联')
  t.mock.timers.reset()
  f.collector.dispose()
})

test('Given 长工具事件持续落在窗口内 When 跨过窗口的事件到达 Then 一次落盘取最新观测时间', async () => {
  const f = await heartbeatFixture()
  try {
    await f.collector.accept({ type: 'tool/call', seq: 3, time: 100 + 120 * 1000, data: { turn: 7 } })
    assert.equal(f.aggregate.runs.r1.lastEventAt, 100, '窗口内只推进内存基准')
    const later = 100 + 200 * 1000
    await f.collector.accept({ type: 'tool/call', seq: 4, time: later, data: { turn: 7 } })
    assert.equal(f.aggregate.runs.r1.lastEventAt, later, '跨窗口时必须一次补到最新事件时间')
    assert.equal(isStaleRun(f.aggregate.runs.r1, { now: later + 14 * 60 * 1000 }), false)
  } finally {
    f.collector.dispose()
  }
})

// ── B2:同 turn steer 的 user/message 不得覆盖回合绑定 ──────────────────────────
test('Given 回合内出现 steer 消息 When 报告与用量到达 Then 仍按原派发 Run 采纳', async () => {
  const f = fixture()
  await f.collector.accept(user())
  // steer:同 turn、新的 rpcId,匹配不到任何 Run
  await f.collector.accept({ type: 'user/message', seq: 4, time: 150, data: { id: 'user2', role: 'user', content: [{ type: 'text', text: '顺便调整' }], source: { kind: 'user', rpcId: 'steer-1' } } })
  await f.collector.accept(assistant())
  await f.collector.accept(ended())
  assert.equal(f.aggregate.runs.r1.state, 'settled', 'steer 不得切断回合绑定')
  assert.ok(f.aggregate.reports['s1:2'], '报告必须仍能落到原 Run')
})

test('Given 已绑定回合 When 同 turn 再收到 steer 的用户消息 Then 绑定不变', async () => {
  const f = fixture()
  await f.collector.accept(user())
  await f.collector.accept({ type: 'user/message', seq: 4, time: 150, data: { source: { kind: 'user', rpcId: 'steer-1' } } })
  // 心跳仍按已绑定 Run 推进(若绑定被 steer 覆盖,这里不会落盘)
  await f.collector.accept({ type: 'tool/call', seq: 5, time: 100 + 200 * 1000, data: { turn: 7 } })
  assert.equal(f.aggregate.runs.r1.lastEventAt, 100 + 200 * 1000, '心跳必须仍落到原 Run')
})
