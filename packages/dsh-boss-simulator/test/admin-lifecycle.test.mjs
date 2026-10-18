import { test } from 'node:test'
import assert from 'node:assert/strict'
import { registerToolRow } from '../lib/tools-row.mjs'
import { createRunReportCollector } from '../lib/core/report-events.mjs'
import { createTaskStore } from '../lib/store.mjs'
import { createRunService } from '../lib/run-service.mjs'
import * as runServices from '../lib/run-service.mjs'

function fixture() {
  const records = new Map()
  const serialize = value => JSON.parse(JSON.stringify(value))
  const table = {
    get(key) { const value = records.get(key); return value === undefined ? undefined : serialize(value) },
    async put(key, value) { records.set(key, serialize(value)) },
    async update(key, fn) { if (!records.has(key)) throw Object.assign(new Error(`missing-key ${key}`), { code: 'missing-key' }); const next = fn(serialize(records.get(key))); records.set(key, serialize(next)); return serialize(next) },
    entries() { return records.entries() },
  }
  const store = createTaskStore(table, { now: () => 100 })
  const creates = [], prompts = []
  const runtime = {
    store,
    now: () => 100,
    sessionAdapter: {
      async ensureSession(args) { creates.push(args); return { sessionId: args.sessionId } },
      async dispatchPrompt(args) { prompts.push(args); return { accepted: true } },
    },
    followRuns() {},
  }
  const registered = []
  registerToolRow({ tools: { register(tool) { registered.push(tool); return () => {} }, guard() { return () => {} } } }, runtime)
  const ctx = { get: () => ({ composedPreset: () => 'boss-simulator-admin' }) }
  const execute = (tool, args) => registered[0].execute({ tool, args }, { agent: { ctx } })
  return { store, creates, prompts, execute, runtime }
}

async function ready(f) {
  await f.execute('boss_simulator_create_task', { taskId: 't1', title: '任务', projectWorkspaceId: 'ws1', definition: { goal: '目标', acceptanceCriteria: [{ criterionId: 'c1', text: '标准' }] } })
  await f.execute('boss_simulator_define_workitem', { taskId: 't1', workItemId: 'w1', title: '实施项', requiredCriterionIds: ['c1'] })
  await f.execute('boss_simulator_authorize_task', { taskId: 't1', sourceMessageRef: { sessionId: 'admin', eventSeq: 1 } })
}

async function report(f, run, verdict) {
  const collector = createRunReportCollector({ taskId: 't1', sessionId: run.sessionId, store: f.store })
  const event = (type, data, seq) => ({ type, data: { turn: 1, ...data }, seq, time: seq * 100 })
  await collector.accept(event('turn/start', {}, 0))
  await collector.accept({ type: 'user/message', seq: 1, time: 100, data: { id: 'user1', role: 'user', source: { kind: 'user', rpcId: run.requestId }, content: [{ type: 'text', text: '任务' }] } })
  await collector.accept(event('assistant/message', { message: { content: [{ type: 'text', text: JSON.stringify({ summary: '结果', verdict, coveredCriterionIds: ['c1'], issues: [], evidence: ['检查证据'] }) }] } }, 2))
  await collector.accept(event('turn/end', { reason: { kind: 'completed' } }, 3))
}

test('Given 唯一管理员工具入口 When 派发实施并从 durable 报告验收结案 Then 无额外 preset 且落盘闭环完整', async () => {
  const f = fixture()
  await ready(f)
  const implementation = await f.execute('boss_simulator_dispatch_run', { taskId: 't1', workItemId: 'w1', runId: 'implementation', requestId: 'implement-1', phase: 'implement', content: '实施授权目标' })
  assert.equal(implementation.ok, true)
  await report(f, { ...implementation, requestId: 'implement-1' }, 'ready_for_review')
  assert.equal((await f.store.loadAggregate('t1')).businessState, 'awaiting_acceptance')
  const review = await f.execute('boss_simulator_dispatch_run', { taskId: 't1', workItemId: 'w1', runId: 'review', requestId: 'review-1', phase: 'accept', content: '独立检查产物' })
  assert.notEqual(review.sessionId, implementation.sessionId)
  assert.ok(f.creates.every(request => !Object.hasOwn(request, 'agentPreset')))
  await report(f, { ...review, requestId: 'review-1' }, 'pass')
  const closed = await f.execute('boss_simulator_close_task', { taskId: 't1', passReportId: `${review.sessionId}:2`, conclusion: '验收通过' })
  assert.equal(closed.businessState, 'completed')
  assert.equal((await f.store.loadAggregate('t1')).businessState, 'completed')
})

test('Given 同一管理员派发命令 When 重试 Then 不创建第二会话或重复投递', async () => {
  const f = fixture()
  await ready(f)
  const args = { taskId: 't1', workItemId: 'w1', runId: 'r1', requestId: 'rpc1', phase: 'implement', content: '执行' }
  const first = await f.execute('boss_simulator_dispatch_run', args)
  const second = await f.execute('boss_simulator_dispatch_run', args)
  assert.equal(second.sessionId, first.sessionId)
  assert.equal(f.creates.length, 1)
  assert.equal(f.prompts.length, 1)
})

test('Given 并发重复派发 When 原子预留 Run Then 只创建并投递一个标准会话', async () => {
  const f = fixture()
  await ready(f)
  const args = { taskId: 't1', workItemId: 'w1', runId: 'r1', requestId: 'rpc1', phase: 'implement', content: '执行' }
  const [first, second] = await Promise.all([f.execute('boss_simulator_dispatch_run', args), f.execute('boss_simulator_dispatch_run', args)])
  assert.equal(first.sessionId, second.sessionId)
  assert.equal(f.creates.length, 1)
  assert.equal(f.prompts.length, 1)
})

test('Given 宿主 prompt 已执行但回执抛错 When 重试管理员命令 Then 保留 unknown 且不重发', async () => {
  const f = fixture()
  await ready(f)
  f.runtime.sessionAdapter.dispatchPrompt = async args => { f.prompts.push(args); throw new Error('receipt lost') }
  const args = { taskId: 't1', workItemId: 'w1', runId: 'r1', requestId: 'rpc1', phase: 'implement', content: '执行' }
  await assert.rejects(f.execute('boss_simulator_dispatch_run', args), /receipt lost/)
  assert.equal((await f.store.loadAggregate('t1')).runs.r1.state, 'unknown')
  const retry = await f.execute('boss_simulator_dispatch_run', args)
  assert.equal(retry.state, 'unknown')
  assert.equal(f.prompts.length, 1)
})

test('Given 最新修复需要帮助而旧实施可验收 When 再派验收 Then 拒绝旧实施报告', async () => {
  const f = fixture()
  await ready(f)
  const dispatch = args => f.execute('boss_simulator_dispatch_run', { taskId: 't1', workItemId: 'w1', ...args })
  const first = await dispatch({ runId: 'i1', requestId: 'i1', phase: 'implement', content: '实施' })
  await report(f, first, 'ready_for_review')
  const fix = await dispatch({ runId: 'f2', requestId: 'f2', phase: 'fix', content: '修复' })
  await report(f, fix, 'needs_help')
  await assert.rejects(dispatch({ runId: 'a3', requestId: 'a3', phase: 'accept', content: '验收' }), /当前.*实施|最新/)
})

test('Given 派发与全局停止并发 When 共用执行临界区 Then 停止不穿过已在检查投递的派发', async () => {
  assert.equal(typeof runServices.createExecutionGate, 'function')
  const f = fixture()
  await ready(f)
  const gate = runServices.createExecutionGate()
  f.runtime.withExecution = gate
  let release
  const blocked = new Promise(resolve => { release = resolve })
  let entered
  const started = new Promise(resolve => { entered = resolve })
  f.runtime.sessionAdapter.ensureSession = async args => { entered(); await blocked; return { sessionId: args.sessionId } }
  const dispatch = f.execute('boss_simulator_dispatch_run', { taskId: 't1', workItemId: 'w1', runId: 'r1', requestId: 'rpc1', phase: 'implement', content: '执行' })
  await started
  let stopped = false
  const stop = gate(async () => { stopped = true; await f.store.updateControl(control => ({ ...control, globalStopped: true, globalStopGeneration: 1 })) })
  assert.equal(stopped, false)
  release()
  await dispatch
  await stop
  assert.equal(f.prompts.length, 1)
  assert.equal(stopped, true)
})

test('Given 正式恢复工具 When 旧会话已停且明确意图有效 Then 核对后恢复', async () => {
  const f = fixture()
  await ready(f)
  await f.store.updateAggregate('t1', current => ({ ...current, control: { ...current.control, state: 'paused' } }))
  f.runtime.confirmResume = args => createRunService(f.runtime).confirmResume(args)
  await f.execute('boss_simulator_request_resume', { taskId: 't1', resumeIntentId: 'resume1', sourceMessageRef: { sessionId: 'admin', eventSeq: 2 } })
  const result = await f.execute('boss_simulator_confirm_resume', { taskId: 't1', resumeIntentId: 'resume1' })
  assert.equal(result.controlState, 'active')
  assert.equal(result.executionEpoch, 1)
})

test('Given 未授权草稿 When 管理员派发 Then 拒绝且不创建宿主会话', async () => {
  const f = fixture()
  await f.execute('boss_simulator_create_task', { taskId: 't1', title: '任务', projectWorkspaceId: 'ws1', definition: { goal: '目标' } })
  await f.execute('boss_simulator_define_workitem', { taskId: 't1', workItemId: 'w1', title: '子项' })
  await assert.rejects(f.execute('boss_simulator_dispatch_run', { taskId: 't1', workItemId: 'w1', runId: 'r1', requestId: 'rpc1', phase: 'implement', content: '执行' }), /授权/)
  assert.equal(f.creates.length, 0)
})
