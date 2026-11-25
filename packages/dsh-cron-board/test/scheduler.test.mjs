// scheduler 测试:到期触发 / misfire / 孤儿收尾 / 重复触发防护(设计 §4.1、§7 BDD 调度组)。
// 虚拟时钟:now 注入,虚拟时间推进驱动 tick。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createStore } from '../src/store.mjs'
import { createLogger } from '../src/logger.mjs'
import { createExecutor } from '../src/executor.mjs'
import { createScheduler } from '../src/scheduler.mjs'
import { nextRunAtOf } from '../src/cron.mjs'

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

async function makeScheduler(t, { maxConcurrent = 2, logSystem } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'cron-board-sched-'))
  // Windows 下并行测试时 Defender/索引器短暂锁目录,rmdir 报瞬态 EBUSY,有界重试消解
  t.after(() => rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }))
  const store = await createStore({ dir })
  const logsDir = join(dir, 'logs')
  const logger = createLogger({ rootDir: logsDir })
  const runner = stubRunner()
  const executor = createExecutor({ store, logger, runner, readMaxConcurrent: () => maxConcurrent })
  let nowMs = Date.now()
  const scheduler = createScheduler({
    store,
    executor,
    readTickMs: () => TICK_MS,
    now: () => nowMs,
    logSystem,
  })
  return {
    store,
    runner,
    scheduler,
    executor,
    logsDir,
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

test('scheduler:推进 nextRunAt 后任务已被删除,不再 dispatch 已删任务', async (t) => {
  // Given 到期任务;模拟删除发生在 tick 的 await updateRuntime 之后、dispatch 之前
  const { store, runner, scheduler, executor, advance, now, logsDir } = await makeScheduler(t)
  const job = await store.jobs.create({
    name: '删除竞态', kind: 'shell', command: 'echo hi', schedule: '* * * * *',
    enabled: true, timeoutMs: 1000, nextRunAt: now() + 100,
  })
  advance(200)
  const rawUpdate = store.jobs.updateRuntime.bind(store.jobs)
  store.jobs.updateRuntime = async (id, patch) => {
    const row = await rawUpdate(id, patch)
    if (id === job.id) await store.jobs.remove(id)
    return row
  }
  // When tick
  await scheduler.tick()
  store.jobs.updateRuntime = rawUpdate
  // Then 不产生不可见 run、不创建日志目录、执行链无排队
  assert.equal(store.jobs.get(job.id), undefined)
  assert.equal(store.runs.list(job.id).length, 0)
  assert.equal(executor.status().queued, 0)
  assert.equal(runner.pending.length, 0)
  assert.equal(existsSync(join(logsDir, job.id)), false, '不得为已删任务重建日志目录')
})

test('scheduler:dispatch 失败落 cron fail 记录并告警,触发点不被静默消耗', async (t) => {
  // Given 到期任务与必定抛错的执行链
  const logs = []
  const { store, scheduler, executor, advance, now } = await makeScheduler(t, { logSystem: (line) => logs.push(line) })
  const job = await store.jobs.create({
    name: '调度失败', kind: 'shell', command: 'echo hi', schedule: '* * * * *',
    enabled: true, timeoutMs: 1000, nextRunAt: now() + 100,
  })
  const rawDispatch = executor.dispatch.bind(executor)
  executor.dispatch = async () => { throw new Error('执行链拒绝新运行') }
  advance(200)
  // When tick
  await scheduler.tick()
  executor.dispatch = rawDispatch
  // Then 有 fail 记录与告警,nextRunAt 仍推进(不会在同一触发点重试轰炸)
  const rows = store.runs.list(job.id)
  assert.equal(rows.length, 1)
  assert.equal(rows[0].status, 'fail')
  assert.match(rows[0].message, /调度失败/)
  assert.ok(logs.some((line) => line.includes('cron 调度失败') && line.includes(job.id)))
  assert.ok(store.jobs.get(job.id).nextRunAt > Date.now())
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

test('scheduler:recover 将遗留 queued/running 孤儿记录标 interrupted 并回填任务卡状态', async (t) => {
  // Given runs.json 遗留 queued 与 running 记录(上次进程遗留)
  const { store, scheduler } = await makeScheduler(t)
  const job = await store.jobs.create({
    name: 'j1', kind: 'shell', command: 'x', schedule: '* * * * *',
    enabled: true, timeoutMs: 1000, lastStatus: 'success',
  })
  const configVersion = job.updatedAt
  await store.runs.create({ runId: 'r-queued', jobId: job.id, trigger: 'cron', status: 'queued' })
  await store.runs.create({ runId: 'r-running', jobId: job.id, trigger: 'cron', status: 'running' })
  await store.runs.create({ runId: 'r-done', jobId: job.id, trigger: 'cron', status: 'success' })
  // When 重启恢复
  await scheduler.recover()
  // Then 孤儿标 interrupted(message=dsh 重启中断),终态记录不动
  assert.equal(store.runs.get('r-queued').status, 'interrupted')
  assert.equal(store.runs.get('r-queued').message, 'dsh 重启中断')
  assert.equal(store.runs.get('r-running').status, 'interrupted')
  assert.equal(store.runs.get('r-done').status, 'success')
  // Then 任务卡不再显示历史 success,而是中断;配置版本不被运行态回填推进
  assert.equal(store.jobs.get(job.id).lastStatus, 'interrupted')
  assert.equal(store.jobs.get(job.id).updatedAt, configVersion)
})

test('scheduler:recover 自愈残留触发点——nextRunAt 非当前表达式触发点即重算', async (t) => {
  // Given 旧版本编辑残留:工作日任务带着非工作日表达式的触发点(历史 bug 数据)
  const { store, scheduler } = await makeScheduler(t)
  const legal = nextRunAtOf('55 9 * * 1-5')
  const stale = nextRunAtOf('0 9 * * *')
  const jobStale = await store.jobs.create({
    name: '残留', kind: 'shell', command: 'x', schedule: '55 9 * * 1-5',
    enabled: true, timeoutMs: 1000, nextRunAt: stale,
  })
  const jobStaleDisabled = await store.jobs.create({
    name: '残留禁用', kind: 'shell', command: 'x', schedule: '55 9 * * 1-5',
    enabled: false, timeoutMs: 1000, nextRunAt: stale,
  })
  const jobLegal = await store.jobs.create({
    name: '合法', kind: 'shell', command: 'x', schedule: '55 9 * * 1-5',
    enabled: true, timeoutMs: 1000, nextRunAt: legal,
  })
  const jobNull = await store.jobs.create({
    name: '空值', kind: 'shell', command: 'x', schedule: '0 0 30 2 *',
    enabled: true, timeoutMs: 1000, nextRunAt: null,
  })
  // When 重启恢复
  await scheduler.recover()
  // Then 残留值(启用与禁用)按当前 schedule 重算为合法触发点;合法值与空值不动
  assert.equal(store.jobs.get(jobStale.id).nextRunAt, legal)
  assert.equal(store.jobs.get(jobStaleDisabled.id).nextRunAt, legal)
  assert.equal(store.jobs.get(jobLegal.id).nextRunAt, legal)
  assert.equal(store.jobs.get(jobNull.id).nextRunAt, null)
})

test('scheduler:recover 自愈幂等——修复后的数据再次恢复不再改写', async (t) => {
  const { store, scheduler } = await makeScheduler(t)
  const legal = nextRunAtOf('55 9 * * 1-5')
  const job = await store.jobs.create({
    name: '残留', kind: 'shell', command: 'x', schedule: '55 9 * * 1-5',
    enabled: true, timeoutMs: 1000, nextRunAt: nextRunAtOf('0 9 * * *'),
  })
  await scheduler.recover()
  assert.equal(store.jobs.get(job.id).nextRunAt, legal)
  // When 时钟推进后再次恢复
  await new Promise((resolve) => setTimeout(resolve, 1100))
  await scheduler.recover()
  // Then 已合法的触发点不被重算推迟
  assert.equal(store.jobs.get(job.id).nextRunAt, legal)
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

// 挂起 tick 内第一次推进 nextRunAt 的 update:把 dispose 精确投放在 tick 进行中
function suspendNextRunUpdate(store) {
  const original = store.jobs.updateRuntime.bind(store.jobs)
  let release
  let reached = false
  const gate = new Promise((resolve) => { release = resolve })
  store.jobs.updateRuntime = async (jobId, patch) => {
    if (!reached && patch && Object.prototype.hasOwnProperty.call(patch, 'nextRunAt')) {
      reached = true
      await gate
    }
    return original(jobId, patch)
  }
  return {
    release,
    async whenReached() { await waitFor(() => (reached ? true : null)) },
  }
}

test('scheduler:多表达式计划同刻合并为一次运行,推进取合并后的最早触发', async (t) => {
  const { store, runner, scheduler, advance, now } = await makeScheduler(t)
  // Given 计划 = 每分钟 + 每年 1 月 1 日,到期值取更早的那条(刚过期,在宽限内)
  const job = await store.jobs.create({
    name: '多计划', kind: 'shell', command: 'echo hi', schedule: '* * * * *\n0 0 1 1 *',
    enabled: true, timeoutMs: 1000, nextRunAt: now() + 100,
  })
  advance(200)
  // When tick
  await scheduler.tick()
  // Then 同刻合并只预占一次运行
  const rows = store.runs.list(job.id)
  assert.equal(rows.length, 1)
  // Then 推进后取每分钟表达式的下一次,而不是一年后那条
  const updated = store.jobs.get(job.id)
  assert.ok(updated.nextRunAt > now())
  assert.ok(updated.nextRunAt - now() <= 60 * 1000)
  runner.releaseAll()
})

test('scheduler:多表达式同刻命中时运行记录标注命中的计划行', async (t) => {
  const { store, runner, scheduler, advance, now } = await makeScheduler(t)
  // Given 每分钟与每两分钟两条表达式,到期点取偶数分钟(两条同刻命中)
  const dueAt = Math.ceil((now() + 1000) / 60000) * 60000
  const evenDue = dueAt % 120000 === 0 ? dueAt : dueAt + 60000
  const job = await store.jobs.create({
    name: '归因', kind: 'shell', command: 'echo hi', schedule: '* * * * *\n*/2 * * * *',
    enabled: true, timeoutMs: 1000, nextRunAt: evenDue,
  })
  advance(evenDue - now() + 100)
  // When tick
  await scheduler.tick()
  // Then 记录按书写顺序列出命中的两条表达式
  const rows = store.runs.list(job.id)
  assert.equal(rows.length, 1)
  assert.deepEqual(rows[0].schedules, ['* * * * *', '*/2 * * * *'])
  runner.releaseAll()
})

test('scheduler:misfire skipped 记录同样标注命中的计划行', async (t) => {
  const { store, scheduler, advance, now } = await makeScheduler(t)
  // Given 同一组同刻表达式,到期点已超出宽限(停机期间错过)
  const dueAt = Math.ceil((now() + 1000) / 60000) * 60000
  const evenDue = dueAt % 120000 === 0 ? dueAt : dueAt + 60000
  const job = await store.jobs.create({
    name: '错过归因', kind: 'shell', command: 'echo hi', schedule: '* * * * *\n*/2 * * * *',
    enabled: true, timeoutMs: 1000, nextRunAt: evenDue,
  })
  advance(evenDue - now() + 2 * TICK_MS)
  // When tick
  await scheduler.tick()
  // Then skipped 记录带命中的表达式,便于区分是哪个计划被错过
  const rows = store.runs.list(job.id)
  assert.equal(rows.length, 1)
  assert.equal(rows[0].status, 'skipped')
  assert.deepEqual(rows[0].schedules, ['* * * * *', '*/2 * * * *'])
})

test('scheduler:dispatch 失败记录同样带命中的计划行', async (t) => {
  const logs = []
  const { store, scheduler, executor, advance, now } = await makeScheduler(t, { logSystem: (line) => logs.push(line) })
  // Given 到期任务与必定抛错的执行链
  const dueAt = Math.ceil((now() + 1000) / 60000) * 60000
  const evenDue = dueAt % 120000 === 0 ? dueAt : dueAt + 60000
  const job = await store.jobs.create({
    name: '失败归因', kind: 'shell', command: 'echo hi', schedule: '* * * * *\n*/2 * * * *',
    enabled: true, timeoutMs: 1000, nextRunAt: evenDue,
  })
  const rawDispatch = executor.dispatch.bind(executor)
  executor.dispatch = async () => { throw new Error('执行链拒绝新运行') }
  advance(evenDue - now() + 100)
  // When tick
  await scheduler.tick()
  executor.dispatch = rawDispatch
  // Then fail 记录保留归因,调度失败也能定位计划行
  const rows = store.runs.list(job.id)
  assert.equal(rows.length, 1)
  assert.equal(rows[0].status, 'fail')
  assert.deepEqual(rows[0].schedules, ['* * * * *', '*/2 * * * *'])
})

test('scheduler:recover 保留属于任一表达式的残留触发点', async (t) => {
  const { store, scheduler } = await makeScheduler(t)
  // Given 计划两条,nextRunAt 落在较晚的「工作日 9:55」的固定历史触发点上(已过去):
  // 任何按计划重算都会得到未来值,判据不随运行时刻漂移
  const schedule = '0 9 * * *\n55 9 * * 1-5'
  const at = nextRunAtOf('55 9 * * 1-5', new Date('2026-09-17T08:00:00'))
  const job = await store.jobs.create({
    name: '多计划残留', kind: 'shell', command: 'x', schedule,
    enabled: true, timeoutMs: 1000, nextRunAt: at,
  })
  // When recover
  await scheduler.recover()
  // Then 该值合法保留(不被重算成更早那条表达式的触发点)
  assert.equal(store.jobs.get(job.id).nextRunAt, at)
})

test('S4: dispose 等待在飞 tick 收尾,停止后不写调度失败记录', async (t) => {
  const { store, scheduler } = await makeScheduler(t)
  const jobA = await store.jobs.create({
    name: 'a', kind: 'shell', command: 'echo a', schedule: '30 8 * * *',
    enabled: true, timeoutMs: 60 * 1000, nextRunAt: Date.now() - 1000,
  })
  const jobB = await store.jobs.create({
    name: 'b', kind: 'shell', command: 'echo b', schedule: '0 9 * * *',
    enabled: true, timeoutMs: 60 * 1000, nextRunAt: Date.now() - 1000,
  })
  const dueB = store.jobs.get(jobB.id).nextRunAt
  // Given tick 正挂在推进 A 的 nextRunAt 上
  const gate = suspendNextRunUpdate(store)
  const tickPromise = scheduler.tick()
  await gate.whenReached()
  // When 插件停止
  const disposePromise = scheduler.dispose()
  // Then dispose 必须等 tick 收尾(旧实现立即返回,tick 随后 dispatch 失败并写 fail 记录)
  const first = await Promise.race([
    disposePromise.then(() => 'disposed'),
    new Promise((resolve) => setTimeout(() => resolve('pending'), 100)),
  ])
  assert.equal(first, 'pending')
  gate.release()
  await disposePromise
  await tickPromise
  // And 停止后没有新运行记录,后续任务的 nextRunAt 也未被消耗
  assert.equal(store.runs.list().length, 0)
  assert.equal(store.jobs.get(jobB.id).nextRunAt, dueB)
  assert.deepEqual(scheduler.status(), { active: 0, queued: 0 })
  assert.ok(store.jobs.get(jobA.id))
})
