// PKG-2 编排:事件归并、停止核对逃逸(P1-9)、失联在飞 Run(P2-22)与强制停止。
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { hasActiveRuns, RUN_STALE_MS } from '../lib/core/task.mjs'
import { parseRunReport, applySessionEvent, interruptTask, reconcileStoppedTask, forceStop } from '../lib/core/orchestrator.mjs'
import { GLOBAL_CONTROL, makeReadyTask, seedRun } from './fixtures/run-seed.mjs'

let clock = 9_000
const now = () => { clock += 1; return clock }

const memoryStore = (initial) => {
  let current = initial
  return {
    async loadAggregate() { return current },
    async updateAggregate(_taskId, update) { current = update(current); return current },
  }
}

function ready() { return makeReadyTask(now) }

test('结构化报告必须是严格 JSON 且符合运行阶段', () => {
  const implementationRun = { phase: 'implement', actorRole: 'executor' }
  const reviewerRun = { phase: 'accept', actorRole: 'reviewer' }
  const integrateExecutor = { phase: 'integrate', actorRole: 'executor' }
  const integrateReviewer = { phase: 'integrate', actorRole: 'reviewer' }
  const valid = JSON.stringify({ summary: 'done', verdict: 'ready_for_review', coveredCriterionIds: [], issues: [], evidence: [] })
  assert.equal(parseRunReport([{ type: 'text', text: valid }], implementationRun).ok, true)
  assert.equal(parseRunReport([{ type: 'text', text: '```json\n' + valid + '\n```' }], implementationRun).ok, false)
  assert.equal(parseRunReport([{ type: 'text', text: valid }], reviewerRun).ok, false)
  assert.equal(parseRunReport([{ type: 'text', text: valid }], integrateExecutor).ok, true)
  assert.equal(parseRunReport([{ type: 'text', text: valid }], integrateReviewer).ok, false)
  assert.equal(parseRunReport([{ type: 'text', text: JSON.stringify({ ...JSON.parse(valid), extra: true }) }], implementationRun).ok, false)
  const pass = JSON.stringify({ summary: 'pass', verdict: 'pass', coveredCriterionIds: ['c1'], issues: [], evidence: [] })
  assert.equal(parseRunReport([{ type: 'text', text: pass }], reviewerRun).ok, true)
})

test('Given 回合事件 When 归并 Then 只记录执行状态并推进事件时刻', () => {
  const seeded = seedRun(ready())
  const started = applySessionEvent(seeded, { runId: 'r1', type: 'turn.start', at: 100 })
  assert.equal(started.ok, true)
  assert.equal(started.aggregate.runs.r1.state, 'running')
  assert.equal(started.aggregate.runs.r1.lastEventAt, 100)
  const ended = applySessionEvent(started.aggregate, { runId: 'r1', type: 'turn.end', at: 200 })
  assert.equal(ended.aggregate.runs.r1.state, 'running', 'turn.end 不凭回复断言完成')
  assert.equal(ended.aggregate.runs.r1.lastEventAt, 200)
  const replay = applySessionEvent(ended.aggregate, { runId: 'r1', type: 'turn.end', at: 200 })
  assert.equal(replay.replayed, true)
  assert.equal(applySessionEvent(seeded, { runId: 'r1', type: 'bogus' }).ok, false)
  assert.equal(applySessionEvent(seeded, { runId: 'absent', type: 'turn.start' }).ok, false)
})

// ── B7:终态 Run 不被迟到回合事件复活 ─────────────────────────────────────────
test('B7: 终态 Run 的迟到事件只刷新 lastEventAt,不改状态不占执行槽', () => {
  for (const state of ['settled', 'interrupted', 'rejected']) {
    const seeded = seedRun(ready(), { state })
    for (const type of ['prompt.accepted', 'turn.start', 'turn.end']) {
      const applied = applySessionEvent(seeded, { runId: 'r1', type, at: 12_000 })
      assert.equal(applied.ok, true, `${state}/${type}`)
      assert.equal(applied.aggregate.runs.r1.state, state, '终态不得被迟到事件改写')
      assert.equal(applied.aggregate.runs.r1.lastEventAt, 12_000, '活体时间仍刷新')
      assert.equal(applied.aggregate.runs.r1.startedAt, null, '终态不补写启动时间')
      assert.equal(hasActiveRuns(applied.aggregate), false)
    }
  }
})

test('Given 在飞会话仍在运行 When 中断 Then 先取消再核对并确认停止', async () => {
  const seeded = seedRun(ready())
  const running = applySessionEvent(seeded, { runId: 'r1', type: 'turn.start', at: 300 }).aggregate
  const calls = { cancelled: 0, inspected: 0 }
  const adapter = {
    async inspectSession() { calls.inspected += 1; return { running: calls.cancelled === 0, pendingItemIds: [] } },
    async cancelSession() { calls.cancelled += 1; return { accepted: true } },
  }
  const result = await interruptTask(memoryStore(running), running, { sessionAdapter: adapter })
  assert.equal(result.stopConfirmed, true)
  assert.equal(calls.cancelled, 1)
  assert.equal(result.aggregate.control.state, 'paused')
  assert.equal(result.aggregate.runs.r1.state, 'interrupted')
  assert.equal(result.aggregate.runs.r1.stopObserved, 'confirmed')
  assert.equal(hasActiveRuns(result.aggregate), false)
})

test('cancel 适配失败不伪造已停', async () => {
  const seeded = seedRun(ready())
  const running = applySessionEvent(seeded, { runId: 'r1', type: 'turn.start', at: 300 }).aggregate
  const adapter = {
    async inspectSession() { return { running: true, pendingItemIds: [] } },
    async cancelSession() { throw new Error('cancel 不可用') },
  }
  const interrupted = await interruptTask(memoryStore(running), running, { sessionAdapter: adapter })
  assert.equal(interrupted.cancelErrors.length, 1)
  assert.equal(interrupted.aggregate.runs.r1.stopObserved, 'pending')
  assert.equal(interrupted.aggregate.control.state, 'stopping')
  assert.equal(interrupted.aggregate.control.stopDetail, 'unconfirmed')
  assert.equal(interrupted.aggregate.runs.r1.state, 'running')
})

test('Given idle但队列未清 When reconcileStoppedTask Then 保留stopping且不改epoch', async () => {
  const initial = { ...ready(), control: { ...ready().control, state: 'stopping', executionEpoch: 4 }, runs: { r1: { runId: 'r1', sessionId: 's1', state: 'running', recordedAt: now() } } }
  const store = memoryStore(initial)
  const pending = await reconcileStoppedTask(store, 't1', { inspectSession: async () => ({ running: false, pendingItemIds: ['q1'] }) })
  assert.equal(pending.stopConfirmed, false)
  assert.equal(pending.aggregate.control.state, 'stopping')
  assert.equal(pending.aggregate.runs.r1.state, 'running')
  const settled = await reconcileStoppedTask(store, 't1', { inspectSession: async () => ({ running: false, pendingItemIds: [] }) })
  assert.equal(settled.stopConfirmed, true)
  assert.equal(settled.aggregate.control.state, 'paused')
  assert.equal(settled.aggregate.control.executionEpoch, 4)
  assert.equal(settled.aggregate.runs.r1.state, 'interrupted')
})

test('Given 已settled的会话已被删除 When 停止核对 Then 视为已停而不卡死', async () => {
  const initial = { ...ready(), control: { ...ready().control, state: 'stopping' }, runs: { r1: { runId: 'r1', sessionId: 's1', state: 'settled' } } }
  const result = await reconcileStoppedTask(memoryStore(initial), 't1', { inspectSession: async () => { throw new Error('会话不存在') } })
  assert.equal(result.stopConfirmed, true)
  assert.equal(result.aggregate.control.state, 'paused')
  assert.deepEqual(result.reconcileErrors, [])
})

test('Given 在飞 Run 的会话被宿主删除 When 中断 Then 按已停收敛并可继续删除任务', async () => {
  const seeded = seedRun(ready())
  const running = applySessionEvent(seeded, { runId: 'r1', type: 'turn.start', at: 300 }).aggregate
  const store = memoryStore(running)
  const gone = () => { throw Object.assign(new Error('session not found'), { code: 'SESSION_NOT_FOUND' }) }
  let cancelCalls = 0
  const adapter = { async inspectSession() { gone() }, async cancelSession() { cancelCalls += 1; gone() } }
  const result = await interruptTask(store, running, { sessionAdapter: adapter })
  assert.equal(result.stopConfirmed, true)
  assert.deepEqual(result.cancelErrors, [])
  assert.equal(cancelCalls, 0, '会话已不存在时不必再取消')
  assert.equal(result.aggregate.control.state, 'paused')
  assert.equal(result.aggregate.runs.r1.state, 'interrupted')
  assert.equal(hasActiveRuns(result.aggregate), false, '收敛后不再占执行槽')
})

test('Given 停止落盘失败 When 中断 Then 不调用宿主cancel', async () => {
  let cancelled = false
  await assert.rejects(() => interruptTask({ updateAggregate: async () => { throw new Error('durability failed') } }, ready(), { sessionAdapter: { cancelSession: async () => { cancelled = true } } }), /durability failed/)
  assert.equal(cancelled, false)
})

test('Given 相同停止命令已确认 When 重试 Then epoch不再增长且unknown运行必须核对', async () => {
  const seeded = ready()
  const store = memoryStore({ ...seeded, runs: { r1: { runId: 'r1', sessionId: 's1', state: 'unknown', recordedAt: now() } } })
  const inspected = []
  const adapter = { inspectSession: async ({ sessionId }) => { inspected.push(sessionId); return { running: false, pendingItemIds: [] } }, cancelSession: async () => ({ accepted: true }) }
  const first = await interruptTask(store, seeded, { sessionAdapter: adapter, commandId: 'stop-1' })
  assert.equal(first.stopConfirmed, true)
  assert.ok(inspected.length > 0)
  const again = await interruptTask(store, first.aggregate, { sessionAdapter: adapter, commandId: 'stop-1' })
  assert.equal(again.aggregate.control.executionEpoch, 1)
})

test('Given stop1之后已恢复并有新Run When 重放stop1 Then 返回receipt且不取消新执行', async () => {
  const seeded = ready()
  const store = memoryStore({ ...seeded, runs: { r1: { runId: 'r1', sessionId: 's1', state: 'running', recordedAt: now() } } })
  const cancelled = []
  let inspections = 0
  const adapter = { inspectSession: async () => ({ running: inspections++ === 0, pendingItemIds: [] }), cancelSession: async ({ sessionId }) => { cancelled.push(sessionId); return { accepted: true } } }
  const stopped = await interruptTask(store, seeded, { sessionAdapter: adapter, commandId: 'stop-1' })
  await store.updateAggregate('t1', current => ({ ...current, control: { ...current.control, state: 'active', executionEpoch: 2 }, runs: { ...current.runs, r2: { runId: 'r2', sessionId: 's2', state: 'running', recordedAt: now() } } }))
  const replay = await interruptTask(store, stopped.aggregate, { sessionAdapter: adapter, commandId: 'stop-1' })
  assert.deepEqual(cancelled, ['s1'])
  assert.equal(replay.replayed, true)
  assert.equal(replay.aggregate.control.state, 'active')
  assert.equal(replay.aggregate.runs.r2.state, 'running')
})

test('Given 停止receipt已落盘但取消前崩溃 When 同epoch重放 Then 继续取消而不增epoch', async () => {
  const seeded = ready()
  const current = { ...seeded, control: { ...seeded.control, state: 'stopping', executionEpoch: 1, stopCommandIds: { stop1: { executionEpoch: 1 } } }, runs: { r1: { runId: 'r1', sessionId: 's1', state: 'running', recordedAt: now() } } }
  const store = memoryStore(current)
  let cancelled = 0
  const result = await interruptTask(store, current, { commandId: 'stop1', sessionAdapter: {
    inspectSession: async () => ({ running: cancelled === 0, pendingItemIds: [] }),
    cancelSession: async () => { cancelled++; return { accepted: true } },
  } })
  assert.equal(cancelled, 1)
  assert.equal(result.stopConfirmed, true)
  assert.equal(result.aggregate.control.executionEpoch, 1)
})

test('Given cold会话已idle且队列空 When 中断 Then 不cancel冷会话且确认停止', async () => {
  const seeded = ready()
  const store = memoryStore({ ...seeded, runs: { r1: { runId: 'r1', sessionId: 'cold', state: 'unknown', recordedAt: now() } } })
  let cancelled = false
  const result = await interruptTask(store, seeded, { sessionAdapter: {
    inspectSession: async () => ({ running: false, pendingItemIds: [], stopped: true }),
    cancelSession: async () => { cancelled = true; throw new Error('cold agent unavailable') },
  } })
  assert.equal(cancelled, false)
  assert.equal(result.stopConfirmed, true)
})

test('Given cancel仅受理且会话仍running When 中断 Then 先持久化且保留stopping', async () => {
  const seeded = seedRun(ready())
  const running = applySessionEvent(seeded, { runId: 'r1', type: 'turn.start', at: 300 }).aggregate
  const store = memoryStore(running)
  const observed = []
  const adapter = {
    async inspectSession() { return { running: true, pendingItemIds: ['queued-1'], stopped: false } },
    async cancelSession(request) { observed.push((await store.loadAggregate()).control); assert.deepEqual(request.pendingItemIds, ['queued-1']); return { accepted: true } },
  }
  const result = await interruptTask(store, running, { sessionAdapter: adapter })
  assert.equal(observed[0].state, 'stopping')
  assert.equal(observed[0].executionEpoch, 1)
  assert.equal(result.aggregate.control.state, 'stopping')
  assert.equal(result.stopConfirmed, false)
})

test('Given 失联在飞 Run When 停止核对 Then 按已断收敛不再等待不可达会话', async () => {
  const seeded = ready()
  const stale = { ...seeded, runs: { r1: { runId: 'r1', sessionId: 'gone', state: 'prepared', recordedAt: now() - RUN_STALE_MS - 1, lastEventAt: null } } }
  let inspections = 0
  const result = await reconcileStoppedTask(memoryStore({ ...stale, control: { ...stale.control, state: 'stopping' } }), 't1', {
    inspectSession: async () => { inspections += 1; return { running: true, pendingItemIds: [] } },
  })
  assert.equal(inspections, 0)
  assert.equal(result.stopConfirmed, true)
  assert.equal(result.aggregate.runs.r1.state, 'interrupted')
  assert.equal(result.aggregate.runs.r1.stopObserved, 'unreachable')
})

test('Given 会话核对与取消都不可用 When 强制停止 Then 需显式确认且 Run 标 interrupted/unreachable', async () => {
  const seeded = seedRun(ready())
  const running = applySessionEvent(seeded, { runId: 'r1', type: 'turn.start', at: 300 }).aggregate
  const store = memoryStore(running)
  const adapter = {
    async inspectSession() { throw new Error('宿主接口超时') },
    async cancelSession() { throw new Error('宿主接口超时') },
  }
  const blocked = await interruptTask(store, running, { sessionAdapter: adapter })
  assert.equal(blocked.stopConfirmed, false)
  assert.equal(blocked.aggregate.control.state, 'stopping')
  const unconfirmed = await forceStop(store, 't1', { confirm: false })
  assert.equal(unconfirmed.ok, false)
  assert.equal(unconfirmed.code, 'CONFIRMATION_REQUIRED')
  assert.equal((await store.loadAggregate()).runs.r1.state, 'running', '未确认不得改动')
  const forced = await forceStop(store, 't1', { reason: 'unreachable_session', confirm: true })
  assert.equal(forced.ok, true)
  assert.equal(forced.stopConfirmed, true)
  assert.equal(forced.aggregate.control.state, 'paused')
  assert.equal(forced.aggregate.runs.r1.state, 'interrupted')
  assert.equal(forced.aggregate.runs.r1.stopObserved, 'unreachable')
  assert.equal(hasActiveRuns(forced.aggregate), false)
})

// ── W1:forceStop commandId 回执:同内容重放,异内容冲突 ──────────────────────
test('W1: forceStop 同 commandId 同 payload 不二次 pause,异 payload 冲突', async () => {
  const store = memoryStore(ready())
  const first = await forceStop(store, 't1', { confirm: true, commandId: 'force-1', payloadHash: 'payload-a' })
  assert.equal(first.ok, true)
  assert.equal(first.replayed, false)
  const epoch = (await store.loadAggregate()).control.executionEpoch
  const replay = await forceStop(store, 't1', { confirm: true, commandId: 'force-1', payloadHash: 'payload-a' })
  assert.equal(replay.ok, true)
  assert.equal(replay.replayed, true)
  assert.equal((await store.loadAggregate()).control.executionEpoch, epoch, '重放不得再次 pause/提升 epoch')
  const conflict = await forceStop(store, 't1', { confirm: true, commandId: 'force-1', payloadHash: 'payload-b' })
  assert.equal(conflict.ok, false)
  assert.equal(conflict.code, 'IDEMPOTENCY_CONFLICT')
  assert.equal((await store.loadAggregate()).control.executionEpoch, epoch)
})

test('Given 终态任务 When 强制停止 Then 拒绝', async () => {
  const seeded = { ...ready(), businessState: 'completed' }
  const outcome = await forceStop(memoryStore(seeded), 't1', { confirm: true })
  assert.equal(outcome.ok, false)
  assert.match(outcome.message, /终态/)
})
