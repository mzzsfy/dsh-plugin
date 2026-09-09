// scheduler 测试:到期触发 / misfire / 孤儿收尾 / 重复触发防护(设计 §4.1、§7 BDD 调度组)。
// 虚拟时钟:now 注入,虚拟时间推进驱动 tick。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createStore } from '../src/store.mjs'
import { createLogger } from '../src/logger.mjs'
import { createExecutor } from '../src/executor.mjs'
import { createScheduler } from '../src/scheduler.mjs'

const TICK_MS = 30 * 1000

// 可控 runner:执行挂起直到测试放行
function stubRunner() {
  const pending = []
  return {
    pending,
    releaseAll(status = 'success') {
      while (pending.length > 0) pending.shift()({ status, exitCode: 0 })
    },
    run() {
      return new Promise((resolve) => { pending.push(resolve) })
    },
  }
}

async function makeScheduler(t, { maxConcurrent = 2 } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'cron-board-sched-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const store = await createStore({ dir })
  const logger = createLogger({ rootDir: join(dir, 'logs') })
  const runner = stubRunner()
  const executor = createExecutor({ store, logger, runner, readMaxConcurrent: () => maxConcurrent })
  let nowMs = Date.now()
  const scheduler = createScheduler({
    store,
    executor,
    readTickMs: () => TICK_MS,
    now: () => nowMs,
  })
  return {
    store,
    runner,
    scheduler,
    advance: (ms) => { nowMs += ms },
    now: () => nowMs,
  }
}

test('scheduler:到期触发产生 cron RunRecord 且 nextRunAt 先推进', async (t) => {
  // Given 启用任务 nextRunAt 刚过期(宽限内)
  const { store, runner, scheduler, advance } = await makeScheduler(t)
  const job = await store.jobs.create({
    name: '签到', kind: 'shell', command: 'echo hi', schedule: '30 8 * * *',
    enabled: true, timeoutMs: 60 * 1000, nextRunAt: Date.now() + TICK_MS,
  })
  advance(TICK_MS + 1000)
  // When 时钟到达触发点后的首个 tick
  await scheduler.tick()
  // Then 记录预占且 nextRunAt 已推进到未来(先于执行完成)
  const rows = store.runs.list(job.id)
  assert.equal(rows.length, 1)
  assert.equal(rows[0].trigger, 'cron')
  const updated = store.jobs.get(job.id)
  assert.ok(updated.nextRunAt > Date.now())
  assert.ok(updated.lastRunAt > 0)
  // Then 执行放行后状态流转到 success(等执行单元真正开始再放行,终态写轮询等待)
  await waitFor(() => (runner.pending.length > 0 ? true : null))
  runner.releaseAll()
  const finished = await waitFor(() => {
    const record = store.runs.get(rows[0].runId)
    return record && record.status !== 'queued' && record.status !== 'running' ? record : null
  })
  assert.equal(finished.status, 'success')
})

test('scheduler:同一触发点连续两次 tick 不重复触发', async (t) => {
  const { store, runner, scheduler, advance } = await makeScheduler(t)
  const job = await store.jobs.create({
    name: 'j', kind: 'shell', command: 'x', schedule: '* * * * *',
    enabled: true, timeoutMs: 1000, nextRunAt: Date.now() + 100,
  })
  advance(200)
  // When 未再推进时钟连续两次 tick
  await scheduler.tick()
  await scheduler.tick()
  // Then 仅一次触发(nextRunAt 首次 tick 已推进)
  assert.equal(store.runs.list(job.id).length, 1)
  // 收尾:等执行单元开始并放行到终态,再删临时目录
  await waitFor(() => (runner.pending.length > 0 ? true : null))
  runner.releaseAll()
  await waitFor(() => {
    const rows2 = store.runs.list(job.id)
    return rows2.length === 1 && rows2[0].status !== 'queued' && rows2[0].status !== 'running' ? true : null
  })
})

test('scheduler:停机期间错过不补跑,记 skipped 且推进到未来', async (t) => {
  // Given nextRunAt 过期远超一个 tick 周期
  const { store, scheduler, advance } = await makeScheduler(t)
  const job = await store.jobs.create({
    name: 'j', kind: 'shell', command: 'x', schedule: '0 23 * * *',
    enabled: true, timeoutMs: 1000, nextRunAt: Date.now(),
  })
  advance(TICK_MS * 10)
  // When tick
  await scheduler.tick()
  // Then skipped(message=停机期间错过)且 nextRunAt 在未来,未执行
  const rows = store.runs.list(job.id)
  assert.equal(rows.length, 1)
  assert.equal(rows[0].status, 'skipped')
  assert.equal(rows[0].message, '停机期间错过')
  assert.ok(store.jobs.get(job.id).nextRunAt > Date.now())
})

test('scheduler:禁用任务不触发', async (t) => {
  const { store, scheduler, advance } = await makeScheduler(t)
  const job = await store.jobs.create({
    name: 'j', kind: 'shell', command: 'x', schedule: '* * * * *',
    enabled: false, timeoutMs: 1000, nextRunAt: Date.now() - 1000,
  })
  advance(TICK_MS + 1000)
  await scheduler.tick()
  assert.equal(store.runs.list(job.id).length, 0)
})

test('scheduler:recover 将遗留 queued/running 孤儿记录标 interrupted', async (t) => {
  // Given runs.json 遗留 queued 与 running 记录(上次进程遗留)
  const { store, scheduler } = await makeScheduler(t)
  await store.runs.create({ runId: 'r-queued', jobId: 'j1', trigger: 'cron', status: 'queued' })
  await store.runs.create({ runId: 'r-running', jobId: 'j1', trigger: 'cron', status: 'running' })
  await store.runs.create({ runId: 'r-done', jobId: 'j1', trigger: 'cron', status: 'success' })
  // When 重启恢复
  await scheduler.recover()
  // Then 孤儿标 interrupted(message=dsh 重启中断),终态记录不动
  assert.equal(store.runs.get('r-queued').status, 'interrupted')
  assert.equal(store.runs.get('r-queued').message, 'dsh 重启中断')
  assert.equal(store.runs.get('r-running').status, 'interrupted')
  assert.equal(store.runs.get('r-done').status, 'success')
})

test('scheduler:并发闸门——maxConcurrent=1 时第二个单元排队,首个完成后推进', async (t) => {
  // Given 两个任务同时到期,全局并发 1
  const { store, runner, scheduler, advance } = await makeScheduler(t, { maxConcurrent: 1 })
  const j1 = await store.jobs.create({
    name: 'j1', kind: 'shell', command: 'x', schedule: '* * * * *',
    enabled: true, timeoutMs: 1000, nextRunAt: Date.now() + 100,
  })
  const j2 = await store.jobs.create({
    name: 'j2', kind: 'shell', command: 'x', schedule: '* * * * *',
    enabled: true, timeoutMs: 1000, nextRunAt: Date.now() + 100,
  })
  await advance(200)
  await scheduler.tick()
  // 等第一组真正开始(链上写排空后才调 runner.run)
  await waitFor(() => (runner.pending.length > 0 ? true : null))
  // Then 仅第一个进入 running,第二个 queued
  assert.equal(runner.pending.length, 1)
  assert.equal(store.runs.list(j1.id)[0].status, 'running')
  assert.equal(store.runs.list(j2.id)[0].status, 'queued')
  // When 首个放行
  runner.releaseAll()
  await waitFor(() => (runner.pending.length > 0 ? true : null))
  // Then 第二个获得许可进入 running
  assert.equal(runner.pending.length, 1)
  assert.equal(store.runs.list(j2.id)[0].status, 'running')
  // 收尾:等终态写落定再删临时目录
  runner.releaseAll()
  await waitFor(() => {
    const rows2 = [...store.runs.list(j1.id), ...store.runs.list(j2.id)]
    return rows2.every((row) => row.status !== 'queued' && row.status !== 'running') ? true : null
  })
})

test('scheduler:任务级 concurrency 收紧全局上限', async (t) => {
  // Given 单任务同名多值两组展开,全局并发 2,任务级 concurrency=1
  const { store, runner, scheduler, advance } = await makeScheduler(t, { maxConcurrent: 2 })
  await store.envs.create({ name: 'A', value: '1', enabled: true })
  await store.envs.create({ name: 'A', value: '2', enabled: true })
  const job = await store.jobs.create({
    name: 'j', kind: 'shell', command: 'x', schedule: '* * * * *',
    enabled: true, timeoutMs: 1000, concurrency: 1, nextRunAt: Date.now() + 100,
  })
  advance(200)
  await scheduler.tick()
  // 等第一组真正开始(链上写排空后才调 runner.run)
  await waitFor(() => (runner.pending.length > 0 ? true : null))
  // Then 同任务仅一组并行
  assert.equal(runner.pending.length, 1)
  assert.equal(store.runs.list(job.id).length, 2)
  runner.releaseAll()
  await waitFor(() => (runner.pending.length > 0 ? true : null))
  assert.equal(runner.pending.length, 1)
  // 收尾:等终态写落定再删临时目录
  runner.releaseAll()
  await waitFor(() => {
    const rows2 = store.runs.list(job.id)
    return rows2.every((row) => row.status !== 'queued' && row.status !== 'running') ? true : null
  })
})

test('scheduler:status 报告活跃与队列深度', async (t) => {
  const { scheduler } = await makeScheduler(t)
  assert.deepEqual(scheduler.status(), { active: 0, queued: 0 })
})

test('scheduler:窗口内正常发起,窗口外 skip 记录且节奏不变', async (t) => {
  // Given 会话任务窗口 09:00-23:00,onMiss=skip,注入会话 runner 桩
  const dir = await mkdtemp(join(tmpdir(), 'cron-board-win-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const store = await createStore({ dir })
  const logger = createLogger({ rootDir: join(dir, 'logs') })
  const sessionRuns = []
  const sessionRunner = { run: async () => { sessionRuns.push(1); return { status: 'success' } } }
  const executor = createExecutor({ store, logger, sessionRunner, readMaxConcurrent: () => 2 })
  // 虚拟时钟锚定今日 08:00(窗口外)
  const base = new Date(); base.setHours(8, 0, 0, 0)
  let nowMs = base.getTime()
  const scheduler = createScheduler({ store, executor, readTickMs: () => TICK_MS, now: () => nowMs })
  const job = await store.jobs.create({
    name: 'w', kind: 'session', prompt: '早报', schedule: '0 8 * * *', enabled: true,
    timeoutMs: 60 * 1000, session: { mode: 'fresh', windowStart: '09:00', windowEnd: '23:00', onMiss: 'skip' },
  })
  await store.jobs.update(job.id, { nextRunAt: nowMs })
  // When tick(触发点 08:00,窗口外)
  await scheduler.tick()
  // Then skipped(窗口外跳过),未发起,节奏正常推进(明日 08:00)
  const rows = store.runs.list(job.id)
  assert.equal(rows.length, 1)
  assert.equal(rows[0].status, 'skipped')
  assert.equal(rows[0].message, '窗口外跳过')
  assert.equal(sessionRuns.length, 0)
  const tomorrow8 = new Date(base); tomorrow8.setDate(tomorrow8.getDate() + 1)
  assert.equal(store.jobs.get(job.id).nextRunAt, tomorrow8.getTime())
})

test('scheduler:窗口外 defer 挂起至窗口起点后发起', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'cron-board-defer-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const store = await createStore({ dir })
  const logger = createLogger({ rootDir: join(dir, 'logs') })
  const sessionRuns = []
  const sessionRunner = { run: async () => { sessionRuns.push(1); return { status: 'success' } } }
  const executor = createExecutor({ store, logger, sessionRunner, readMaxConcurrent: () => 2 })
  // defer 定时桩:捕获 (at, fn),测试手动放行
  const deferred = []
  const base = new Date(); base.setHours(8, 0, 0, 0)
  let nowMs = base.getTime()
  const scheduler = createScheduler({
    store, executor, readTickMs: () => TICK_MS, now: () => nowMs,
    scheduleAt: (at, fn) => { deferred.push({ at, fn }) },
  })
  const job = await store.jobs.create({
    name: 'w', kind: 'session', prompt: '早报', schedule: '0 8 * * *', enabled: true,
    timeoutMs: 60 * 1000, session: { mode: 'fresh', windowStart: '09:00', windowEnd: '23:00', onMiss: 'defer' },
  })
  await store.jobs.update(job.id, { nextRunAt: nowMs })
  // When tick(窗口外 defer)
  await scheduler.tick()
  // Then 立即不发起,挂起点 = 今日 09:00
  assert.equal(sessionRuns.length, 0)
  assert.equal(deferred.length, 1)
  const at = new Date(deferred[0].at)
  assert.equal(at.getHours(), 9)
  assert.equal(at.getMinutes(), 0)
  // When 挂起到点放行(真实时钟推进到窗口起点,重读后窗口内才发起)
  nowMs = at.getTime()
  deferred[0].fn()
  await tickMillis(50)
  // Then 发起会话
  assert.equal(sessionRuns.length, 1)
  // 且 cron 节奏不变(明日 08:00)
  const tomorrow8 = new Date(base); tomorrow8.setDate(tomorrow8.getDate() + 1)
  assert.equal(store.jobs.get(job.id).nextRunAt, tomorrow8.getTime())
})

test('scheduler:窗口外 defer 到点重读任务——已禁用任务放弃发起(不吃旧快照)', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'cron-board-defer2-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const store = await createStore({ dir })
  const logger = createLogger({ rootDir: join(dir, 'logs') })
  const sessionRuns = []
  const sessionRunner = { run: async () => { sessionRuns.push(1); return { status: 'success' } } }
  const executor = createExecutor({ store, logger, sessionRunner, readMaxConcurrent: () => 2 })
  const deferred = []
  const base = new Date(); base.setHours(8, 0, 0, 0)
  let nowMs = base.getTime()
  const scheduler = createScheduler({
    store, executor, readTickMs: () => TICK_MS, now: () => nowMs,
    scheduleAt: (at, fn) => { deferred.push({ at, fn }); return () => {} },
  })
  const job = await store.jobs.create({
    name: 'w', kind: 'session', prompt: '早报', schedule: '0 8 * * *', enabled: true,
    timeoutMs: 60 * 1000, session: { mode: 'fresh', windowStart: '09:00', windowEnd: '23:00', onMiss: 'defer' },
  })
  await store.jobs.update(job.id, { nextRunAt: nowMs })
  await scheduler.tick()
  assert.equal(deferred.length, 1)
  // When 挂起期间任务被禁用,到点放行
  await store.jobs.update(job.id, { enabled: false })
  deferred[0].fn()
  await tickMillis(50)
  // Then 不发起
  assert.equal(sessionRuns.length, 0)
})

test('scheduler:dispose 清除未到点的 defer 挂起(生命周期外零触发)', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'cron-board-defer3-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const store = await createStore({ dir })
  const logger = createLogger({ rootDir: join(dir, 'logs') })
  const sessionRuns = []
  const sessionRunner = { run: async () => { sessionRuns.push(1); return { status: 'success' } } }
  const executor = createExecutor({ store, logger, sessionRunner, readMaxConcurrent: () => 2 })
  const deferred = []
  const cancels = []
  const base = new Date(); base.setHours(8, 0, 0, 0)
  let nowMs = base.getTime()
  const scheduler = createScheduler({
    store, executor, readTickMs: () => TICK_MS, now: () => nowMs,
    scheduleAt: (at, fn) => { deferred.push({ at, fn }); cancels.push(0); return () => { cancels[cancels.length - 1] = 1 } },
  })
  const job = await store.jobs.create({
    name: 'w', kind: 'session', prompt: '早报', schedule: '0 8 * * *', enabled: true,
    timeoutMs: 60 * 1000, session: { mode: 'fresh', windowStart: '09:00', windowEnd: '23:00', onMiss: 'defer' },
  })
  await store.jobs.update(job.id, { nextRunAt: nowMs })
  await scheduler.tick()
  // When dispose 后再放行挂起回调
  scheduler.dispose()
  assert.equal(cancels[0], 1)
  deferred[0].fn()
  await tickMillis(50)
  // Then 不发起
  assert.equal(sessionRuns.length, 0)
})

test('scheduler:tick 重入闸门——上一轮未完成时下一轮直接跳过(防同点双触发)', async (t) => {
  const { store, runner, scheduler, advance } = await makeScheduler(t)
  await store.jobs.create({
    name: '单发', kind: 'shell', command: 'echo hi', schedule: '*/5 * * * *',
    enabled: true, timeoutMs: 60 * 1000, nextRunAt: Date.now() + TICK_MS,
  })
  advance(TICK_MS + 1000)
  // When 同一 tick 未完成时并发发起第二次 tick(store 写链让首 tick 至少跨越一个微任务)
  const first = scheduler.tick()
  const second = scheduler.tick()
  await Promise.all([first, second])
  // Then 仅预占一条运行记录
  const rows = store.runs.list()
  assert.equal(rows.length, 1)
  await waitFor(() => (runner.pending.length > 0 ? true : null))
  runner.releaseAll()
})

async function tickMillis(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms))
}

// 轮询等待:超时抛错(链上写时长不定,固定 sleep 不可靠)
function waitFor(pick, timeoutMs = 10 * 1000) {
  return new Promise((resolve, reject) => {
    const started = Date.now()
    const tick = () => {
      const value = pick()
      if (value) {
        resolve(value)
        return
      }
      if (Date.now() - started > timeoutMs) {
        reject(new Error('waitFor 超时'))
        return
      }
      setTimeout(tick, 20)
    }
    tick()
  })
}
