// executor 执行链 BDD:runner 拒绝的终态收尾与部分写失败下的历史保护。
// 场景对应 runUnit catch:补写不覆写已落库终态、补写失败经 logSystem 留痕。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createStore } from '../src/store.mjs'
import { createLogger } from '../src/logger.mjs'
import { createExecutor } from '../src/executor.mjs'
import { createSessionDriver } from '../src/session-driver.mjs'

async function makeExecutor(t, { jobsBroken = false, logLines = [], runner: runnerOverride } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'cron-board-exec-'))
  // Windows 下并行测试时 Defender/索引器短暂锁目录,rmdir 报瞬态 EBUSY,有界重试消解
  t.after(() => rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }))
  const store = await createStore({ dir: join(dir, 'data') })
  const logger = createLogger({ rootDir: join(dir, 'logs') })
  if (jobsBroken) {
    // 模拟 jobs 集合损坏(mutate 直接拒绝),runs 集合保持健康;
    // 任务卡回填走 updateRuntime,两处方法面都必须断掉才能覆盖回填失败路径
    const broken = async () => { throw new Error('数据文件已损坏已备份,已暂停写入以防数据丢失') }
    store.jobs.update = broken
    store.jobs.updateRuntime = broken
  }
  const runner = runnerOverride || {
    run: async () => ({ status: 'success', exitCode: 0 }),
  }
  const executor = createExecutor({
    store,
    logger,
    runner,
    readMaxConcurrent: () => 2,
    logSystem: (line) => logLines.push(line),
  })
  return { store, executor, logLines }
}

const JOB_BASE = { name: 't', kind: 'shell', command: 'echo hi', schedule: '* * * * *', enabled: true, timeoutMs: 60 * 1000 }

// 轮询至断言目标状态可见:执行链在 runs 终态后仍有任务卡回填/留痕等后台落定动作,单次读取存在竞态窗口
async function waitFor(predicate, timeoutMs = 2 * 1000) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (predicate()) return
    if (Date.now() > deadline) throw new Error('waitFor 超时')
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

async function dispatchAndSettle(executor, store, jobId) {
  const [runId] = await executor.dispatch({ ...JOB_BASE, id: jobId }, 'manual')
  // 等执行链完整落定:runs 终态内存生效早于写链持久化,任务卡回填在其后才可见,以回填为收尾信号
  // 信号为任务级(同名任务任一单元回填即满足),非特定 run 级;当前调用点无依赖特定 run 落定的断言
  await waitFor(() => store.jobs.get(jobId)?.lastStatus !== undefined)
  return runId
}

test('executor:正常路径终态 success 且任务卡回填', async (t) => {
  const { store, executor } = await makeExecutor(t)
  await store.jobs.create({ ...JOB_BASE, id: 'j1' })
  const runId = await dispatchAndSettle(executor, store, 'j1')
  assert.equal(store.runs.get(runId).status, 'success')
  assert.equal(store.jobs.get('j1').lastStatus, 'success')
})

test('executor:runOnce 任务入队即禁用', async (t) => {
  const { store, executor } = await makeExecutor(t)
  // Given 启用中的 runOnce 任务
  await store.jobs.create({ ...JOB_BASE, id: 'j-once', runOnce: true })
  // When dispatch(入队,不等终态)
  await executor.dispatch({ ...JOB_BASE, id: 'j-once', runOnce: true }, 'manual')
  // Then 任务立即禁用(封死 cron 连续触发的重复运行窗口)
  assert.equal(store.jobs.get('j-once').enabled, false)
  // 收尾:放行执行到终态,避免悬挂写与临时目录清理赛跑
  await dispatchAndSettle(executor, store, 'j-once')
})

test('executor:非 runOnce 任务运行后保持启用', async (t) => {
  const { store, executor } = await makeExecutor(t)
  await store.jobs.create({ ...JOB_BASE, id: 'j-keep' })
  await dispatchAndSettle(executor, store, 'j-keep')
  assert.equal(store.jobs.get('j-keep').enabled, true)
})

test('executor:pinned 自愈回写 session.pinnedSessionId 且清除顶层孤立字段', async (t) => {
  const { store, executor } = await makeExecutor(t)
  // Given pinned 任务,runner在准入期间发布绑定
  const executorWithPinned = createExecutor({
    store: await (async () => {
      await store.jobs.create({ ...JOB_BASE, kind: 'session', session: { mode: 'pinned', pinnedSessionId: '' }, id: 'j-pin' })
      return store
    })(),
    logger: createLogger({ rootDir: join(tmpdir(), 'cron-board-exec-pin-logs') }),
    sessionRunner: { run: async ({ updateBinding }) => { await updateBinding('s-new'); return { status: 'success', sessionId: 's-new', message: '首次运行已创建并绑定会话' } } },
    readMaxConcurrent: () => 2,
  })
  const [runId] = await executorWithPinned.dispatch({ ...JOB_BASE, kind: 'session', session: { mode: 'pinned', pinnedSessionId: '' }, id: 'j-pin' }, 'manual')
  // Then 绑定先发布,等待执行收尾后同时核对运行记录。
  await waitFor(() => executorWithPinned.status().active === 0)
  const job = store.jobs.get('j-pin')
  assert.equal(job.session.pinnedSessionId, 's-new')
  assert.equal(job.pinnedSessionId, undefined)
  assert.equal(store.runs.get(runId).message, '首次运行已创建并绑定会话')
})

test('C3 Given two queued pinned runs, When first persists a binding, Then second uses the current binding', async (t) => {
  const { store } = await makeExecutor(t)
  const seen = []
  const job = { ...JOB_BASE, id: 'j-queued-pin', kind: 'session', session: { mode: 'pinned', pinnedSessionId: '' } }
  await store.jobs.create(job)
  const entered = Promise.withResolvers(), release = Promise.withResolvers()
  const executor = createExecutor({
    store, logger: { prune: async () => {} }, readMaxConcurrent: () => 1,
    sessionRunner: { run: async ({ job, updateBinding }) => {
      seen.push(job.session.pinnedSessionId)
      if (seen.length === 1) { entered.resolve(); await release.promise; await updateBinding('new-session'); return { status: 'success' } }
      return { status: 'success' }
    } },
  })
  await executor.dispatch(job, 'manual')
  await entered.promise
  await executor.dispatch(job, 'cron')
  release.resolve()
  await waitFor(() => executor.status().active === 0 && executor.status().queued === 0)
  assert.deepEqual(seen, ['', 'new-session'])
})

for (const lost of [false, true]) {
test(`C${lost ? 6 : 5} Given accepted pinned run awaiting terminal record, When second dispatch starts (lost=${lost}), Then binding stays current`, async (t) => {
  const { store } = await makeExecutor(t)
  const sessions = new Map(), created = [], prompts = []
  const controller = {
    async create() { const sessionId = 's-' + (created.length + 1); created.push(sessionId); sessions.set(sessionId, { status: 'running' }); return { sessionId } },
    async prompt({ sessionId }) { prompts.push(sessionId); return { accepted: true } },
  }
  const driver = createSessionDriver({ getSessionController: () => controller, getAgents: () => ({ get: id => sessions.get(id) }), getSessionQuery: () => ({ listSessions: async () => [...sessions.keys()].map(id => ({ header: { id } })) }) })
  const entered = Promise.withResolvers(), release = Promise.withResolvers()
  const update = store.runs.update.bind(store.runs)
  let held = false
  store.runs.update = async (id, patch) => {
    if (!held && patch.status === 'success') { held = true; entered.resolve(); await release.promise }
    return update(id, patch)
  }
  const executor = createExecutor({ store, logger: {}, sessionRunner: driver, readMaxConcurrent: () => 2 })
  const job = { ...JOB_BASE, id: 'j-publish-gap', kind: 'session', session: { mode: 'pinned', pinnedSessionId: '' } }
  await store.jobs.create(job)
  await executor.dispatch(job, 'manual'); await entered.promise
  try {
    if (lost) sessions.delete('s-1')
    await executor.dispatch(job, 'cron')
    await waitFor(() => executor.status().active === 1)
    assert.deepEqual(created, lost ? ['s-1', 's-2'] : ['s-1'])
    assert.deepEqual(prompts, lost ? ['s-1', 's-2'] : ['s-1'])
  } finally {
    release.resolve()
    await waitFor(() => executor.status().active === 0)
  }
  assert.equal(store.jobs.get(job.id).session.pinnedSessionId, lost ? 's-2' : 's-1')
})
}

test('executor:会话任务 outcome.model 写入运行记录', async (t) => {
  // Given 会话 runner 返回 model 标签
  const dir = await mkdtemp(join(tmpdir(), 'cron-board-exec-'))
  t.after(() => rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }))
  const store = await createStore({ dir: join(dir, 'data') })
  const logger = createLogger({ rootDir: join(dir, 'logs') })
  const executor = createExecutor({
    store,
    logger,
    sessionRunner: { run: async () => ({ status: 'success', sessionId: 's-x', model: 'p1/m1(high)' }) },
    readMaxConcurrent: () => 2,
  })
  await store.jobs.create({ ...JOB_BASE, kind: 'session', session: { mode: 'fresh' }, id: 'j-model' })
  // When 手动触发并等待任务卡回填(收尾信号)
  const [runId] = await executor.dispatch({ ...JOB_BASE, kind: 'session', session: { mode: 'fresh' }, id: 'j-model' }, 'manual')
  await waitFor(() => store.jobs.get('j-model')?.lastStatus !== undefined)
  // Then 运行记录带模型标签
  assert.equal(store.runs.get(runId).model, 'p1/m1(high)')
})

test('dispatch:cron 触发携带命中计划行时写入运行记录,manual 不写', async (t) => {
  // Given 执行链与任务
  const { store, executor } = await makeExecutor(t)
  const job = await store.jobs.create({ ...JOB_BASE, id: 'j-attr' })
  // When cron 触发传入命中的两条表达式
  const [cronId] = await executor.dispatch(job, 'cron', { schedules: ['* * * * *', '*/2 * * * *'] })
  // Then 预占记录带 schedules 原文
  const cronRow = store.runs.get(cronId)
  assert.deepEqual(cronRow.schedules, ['* * * * *', '*/2 * * * *'])
  // When 手动触发不传归因
  const [manualId] = await executor.dispatch(job, 'manual')
  // Then 手动记录不带该字段(不产生空数组噪声)
  assert.equal(store.runs.get(manualId).schedules, undefined)
})

test('executor:runner 拒绝时补写 fail 终态', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'cron-board-exec-'))
  t.after(() => rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }))
  const store = await createStore({ dir: join(dir, 'data') })
  const logger = createLogger({ rootDir: join(dir, 'logs') })
  const logLines = []
  const executor = createExecutor({
    store,
    logger,
    runner: { run: async () => { throw new Error('会话服务爆炸') } },
    readMaxConcurrent: () => 2,
    logSystem: (line) => logLines.push(line),
  })
  await store.jobs.create({ ...JOB_BASE, id: 'j2' })
  const [runId] = await executor.dispatch({ ...JOB_BASE, id: 'j2' }, 'manual')
  // catch 路径先补 runs 终态再回填任务卡,以回填可见为收尾信号
  await waitFor(() => store.jobs.get('j2')?.lastStatus === 'fail')
  const row = store.runs.get(runId)
  assert.equal(row.status, 'fail')
  assert.match(row.message, /会话服务爆炸/)
  assert.equal(store.jobs.get('j2').lastStatus, 'fail')
  assert.equal(logLines.length, 0, '补写成功不留痕')
})

test('executor:运行终态已落库而任务卡回填失败,历史不被覆写', async (t) => {
  const { store, executor, logLines } = await makeExecutor(t, { jobsBroken: true })
  await store.jobs.create({ ...JOB_BASE, id: 'j3' })
  const [runId] = await executor.dispatch({ ...JOB_BASE, id: 'j3' }, 'manual')
  // 任务卡回填被拒必留痕:留痕集合即 catch 路径收尾信号(此场景 lastStatus 永不可见)
  await waitFor(() => logLines.length === 1)
  // Then 事实成功保留,不被 catch 覆写为 fail;回填缺口留痕可观测
  assert.equal(store.runs.get(runId).status, 'success')
  assert.equal(logLines.length, 1)
  assert.ok(logLines[0].includes(runId))
  assert.ok(logLines[0].includes('任务卡回填失败'))
})

test('executor:运行终态补写失败经 logSystem 留痕', async (t) => {
  const { store, executor, logLines } = await makeExecutor(t)
  await store.jobs.create({ ...JOB_BASE, id: 'j4' })
  const [runId] = await executor.dispatch({ ...JOB_BASE, id: 'j4' }, 'manual')
  // dispatch 完成(记录已落库、runUnit 已入队)后再让 runs 集合损坏:终态写入必失败
  store.runs.update = async () => { throw new Error('数据文件已损坏已备份,已暂停写入以防数据丢失') }
  // 补写失败必留痕:以留痕可见替代固定等待,消除时序脆弱
  await waitFor(() => logLines.length === 1)
  // Then 补写失败恰留痕一次,含 runId 与原始错误
  assert.equal(logLines.length, 1)
  assert.ok(logLines[0].includes(runId))
  assert.ok(logLines[0].includes('补写失败'))
})

test('P2-15: stop 落在 dispatch 的预占 await 之间,排队记录补 cancelled 且队列不残留', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'cron-board-p215-'))
  t.after(() => rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }))
  const store = await createStore({ dir: join(dir, 'data') })
  const logger = createLogger({ rootDir: join(dir, 'logs') })
  // 闸门只放 1 个单元:其余组合停在内存队列,便于观察停止窗口
  const executor = createExecutor({ store, logger, runner: { run: () => new Promise(() => {}) }, readMaxConcurrent: () => 1 })
  // Given 启用 multi env 3 值 → 3 个预占记录,第 2 次预占时触发停止(等价卸载/HMR 落在 await 间隙)
  await store.envs.create({ name: 'X', value: '1\n2\n3', multi: true, remarks: '', enabled: true })
  await store.jobs.create({ ...JOB_BASE, id: 'j-stop-gap' })
  const rawCreate = store.runs.create.bind(store.runs)
  let created = 0
  let stopping = null
  store.runs.create = (data) => {
    const result = rawCreate(data)
    created += 1
    if (created === 2) stopping = executor.stop()
    return result
  }
  // When dispatch 继续跑完剩余组合
  const runIds = await executor.dispatch({ ...JOB_BASE, id: 'j-stop-gap' }, 'manual')
  await stopping
  store.runs.create = rawCreate
  // Then 全部预占记录终态化,队列零残留(旧实现会留下永不执行的 queued 孤儿)
  assert.equal(runIds.length, 3)
  assert.equal(executor.status().queued, 0)
  for (const runId of runIds) {
    const row = store.runs.get(runId)
    assert.ok(row.status === 'cancelled' || row.status === 'running', `记录 ${runId} 停在 ${row.status}`)
    if (row.status === 'cancelled') assert.match(row.message, /执行链停止/)
  }
})

test('P2-15: 停止窗口不落 runOnce 自动禁用(真实运行从未开始)', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'cron-board-p215b-'))
  t.after(() => rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }))
  const store = await createStore({ dir: join(dir, 'data') })
  const logger = createLogger({ rootDir: join(dir, 'logs') })
  const executor = createExecutor({ store, logger, runner: { run: () => new Promise(() => {}) }, readMaxConcurrent: () => 1 })
  await store.jobs.create({ ...JOB_BASE, id: 'j-once-stop', runOnce: true })
  const rawCreate = store.runs.create.bind(store.runs)
  let stopping = null
  store.runs.create = (data) => {
    stopping = executor.stop()
    return rawCreate(data)
  }
  const runIds = await executor.dispatch({ ...JOB_BASE, id: 'j-once-stop', runOnce: true }, 'manual')
  await stopping
  store.runs.create = rawCreate
  // Then 记录被取消,任务保持启用(下次启动仍会跑一次),不留「已禁用 + 无记录」
  assert.equal(store.runs.get(runIds[0]).status, 'cancelled')
  assert.equal(store.jobs.get('j-once-stop').enabled, true)
})

test('P2-16: stopJob 复用 settle deadline,无取消句柄的在途运行不永久挂起删除', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'cron-board-p216-'))
  t.after(() => rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }))
  const store = await createStore({ dir: join(dir, 'data') })
  const job = { ...JOB_BASE, kind: 'session', session: { mode: 'fresh' }, id: 'j-hang' }
  // Given 会话运行确实已进入 runner 且无取消句柄(宿主 prompt 无中止面),deadline 缩到 50ms 便于断言
  let markStarted
  const runnerStarted = new Promise((resolve) => { markStarted = resolve })
  const executor = createExecutor({
    store,
    logger: { prune: async () => {} },
    sessionRunner: { run: () => { markStarted(); return { promise: new Promise(() => {}) } } },
    readMaxConcurrent: () => 2,
    settleTimeoutMs: 50,
  })
  await store.jobs.create(job)
  const [runId] = await executor.dispatch(job, 'manual')
  await runnerStarted
  await waitFor(() => executor.status().active === 1)
  // When 删除任务前置清场
  const started = Date.now()
  const outcome = await executor.stopJob(job.id)
  // Then 在 deadline 附近放行(3s 是宽松上限,旧实现无限等待),返回未终止状态供删除路由拒绝
  assert.ok(Date.now() - started < 3000, 'stopJob 必须有界返回')
  assert.deepEqual(outcome, { settled: false, active: 1 })
  assert.equal(store.runs.get(runId).status, 'running')
})

test('C3: 任务不存在时 dispatch 拒绝且不创建记录/日志目录', async (t) => {
  const { store, executor } = await makeExecutor(t)
  // Given 任务已被删除(调度快照失效)
  // When dispatch
  await assert.rejects(() => executor.dispatch({ ...JOB_BASE, id: 'j-missing' }, 'cron'), /不存在|已删除/)
  // Then 零记录、零排队
  assert.equal(store.runs.list('j-missing').length, 0)
  assert.equal(executor.status().queued, 0)
})

test('C3: stopJob 未终止期间拒绝同任务 dispatch,releaseJob 后恢复', async (t) => {
  const { store } = await makeExecutor(t)
  const job = { ...JOB_BASE, id: 'j-stop-block', kind: 'session', prompt: 'x', session: { mode: 'fresh' } }
  await store.jobs.create(job)
  let markStarted
  const started = new Promise((resolve) => { markStarted = resolve })
  const executor = createExecutor({
    store,
    logger: { prune: async () => {} },
    readMaxConcurrent: () => 2,
    settleTimeoutMs: 30,
    sessionRunner: { run: () => { markStarted(); return { promise: new Promise(() => {}) } } },
  })
  await executor.dispatch(job, 'manual')
  await started
  await waitFor(() => executor.status().active === 1)
  // When 超时未终止
  const outcome = await executor.stopJob(job.id)
  assert.deepEqual(outcome, { settled: false, active: 1 })
  // Then 删除窗口内拒绝新 dispatch
  await assert.rejects(() => executor.dispatch(job, 'manual'), /删除中/)
  // When 删除被取消,解除拒绝态
  executor.releaseJob(job.id)
  const runIds = await executor.dispatch(job, 'manual')
  // Then 恢复受理(新记录 queued/running 由仍未完成的会话承载)
  assert.equal(runIds.length, 1)
})

// ── E2: 删除窗口与预占并发 ──────────────────────────────────────────────────
test('E2: 删除落在首次预占的 await 之间,dispatch 409 且不留孤儿 run', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'cron-board-e2a-'))
  t.after(() => rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }))
  const store = await createStore({ dir: join(dir, 'data') })
  const logger = createLogger({ rootDir: join(dir, 'logs') })
  const executor = createExecutor({ store, logger, runner: { run: async () => ({ status: 'success', exitCode: 0 }) }, readMaxConcurrent: () => 2 })
  await store.jobs.create({ ...JOB_BASE, id: 'j-e2-window' })
  // Given 预占被挂起在 create 的 await 内(入口校验已通过)
  const rawCreate = store.runs.create.bind(store.runs)
  let release
  let markEntered
  const entered = new Promise((resolve) => { markEntered = resolve })
  const gate = new Promise((resolve) => { release = resolve })
  store.runs.create = async (data) => {
    markEntered()
    await gate
    return rawCreate(data)
  }
  const dispatching = executor.dispatch({ ...JOB_BASE, id: 'j-e2-window' }, 'manual')
  await entered
  // When 删除在同一窗口内完成(清场 + 持久化删除)
  assert.deepEqual(await executor.stopJob('j-e2-window'), { settled: true, active: 0 })
  await store.jobs.remove('j-e2-window')
  release()
  // Then 业务冲突 409,运行行整行清除(任务已不可见,取消终态同样是孤儿)
  await assert.rejects(dispatching, (error) => error.status === 409 && /删除中/.test(error.message))
  assert.deepEqual(store.runs.list('j-e2-window'), [])
  assert.equal(executor.status().queued, 0)
  store.runs.create = rawCreate
})

test('E2: 多组合预占中途删除,已落库记录整行清除', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'cron-board-e2b-'))
  t.after(() => rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }))
  const store = await createStore({ dir: join(dir, 'data') })
  const logger = createLogger({ rootDir: join(dir, 'logs') })
  const executor = createExecutor({ store, logger, runner: { run: async () => ({ status: 'success', exitCode: 0 }) }, readMaxConcurrent: () => 2 })
  // Given 3 个环境变量组合,第 2 次预占挂起(首条记录已落库)
  await store.envs.create({ name: 'X', value: '1\n2\n3', multi: true, remarks: '', enabled: true })
  await store.jobs.create({ ...JOB_BASE, id: 'j-e2-mid' })
  const rawCreate = store.runs.create.bind(store.runs)
  let calls = 0
  let release
  let markEntered
  const entered = new Promise((resolve) => { markEntered = resolve })
  const gate = new Promise((resolve) => { release = resolve })
  store.runs.create = async (data) => {
    calls += 1
    if (calls === 2) {
      markEntered()
      await gate
    }
    return rawCreate(data)
  }
  const dispatching = executor.dispatch({ ...JOB_BASE, id: 'j-e2-mid' }, 'manual')
  await entered
  // When 删除在两次预占之间完成
  assert.equal((await executor.stopJob('j-e2-mid')).settled, true)
  await store.jobs.remove('j-e2-mid')
  release()
  // Then 拒绝为 409,首条与第 2 条记录都不留库
  await assert.rejects(dispatching, (error) => error.status === 409)
  assert.deepEqual(store.runs.list('j-e2-mid'), [])
  assert.equal(executor.status().queued, 0)
  store.runs.create = rawCreate
})

// ── F03: 停止生命周期 ───────────────────────────────────────────────────────
test('F03: stop 后 dispatch 拒绝,排队记录取消,在途运行杀树,活跃归零', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'cron-board-f03-'))
  t.after(() => rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }))
  const store = await createStore({ dir: join(dir, 'data') })
  const logger = createLogger({ rootDir: join(dir, 'logs') })
  // 慢 runner:首个调用挂起在闸门,后续调用立即完成(停止后取消的单元直接终态)
  let firstStarted
  const firstGate = new Promise((resolve) => { firstStarted = resolve })
  let cancelled = 0
  let first = true
  let releaseFirst
  const runner = {
    run: () => {
      if (first) {
        first = false
        firstStarted()
        const promise = new Promise((resolve) => {
          releaseFirst = () => resolve({ status: 'cancelled', exitCode: null })
        })
        return { promise, cancel: () => { cancelled += 1; releaseFirst() } }
      }
      return { promise: Promise.resolve({ status: 'cancelled', exitCode: null }), cancel: () => {} }
    },
  }
  const executor = createExecutor({ store, logger, runner, readMaxConcurrent: () => 1 })
  // shell 展开:启用 multi env 3 值 → 3 组合(首单元在途,余 2 排队)
  await store.envs.create({ name: 'X', value: '1\n2\n3', multi: true, remarks: '', enabled: true })
  await store.jobs.create({ ...JOB_BASE, id: 'j-a' })
  const runIds = await executor.dispatch({ ...JOB_BASE, id: 'j-a' }, 'manual')
  assert.equal(runIds.length, 3)
  await firstGate
  await waitFor(() => executor.status().active === 1 && executor.status().queued === 2)
  await executor.stop()
  // 排队 → cancelled;在途 → cancel 被调用且终态落 cancelled;活跃归零
  assert.equal(cancelled, 1, '在途运行句柄必须被取消')
  assert.equal(executor.status().active, 0)
  assert.equal(executor.status().queued, 0)
  const statuses = runIds.map((runId) => store.runs.get(runId).status)
  assert.ok(statuses.every((s) => ['cancelled', 'fail'].includes(s)), `全部终态: ${statuses.join(',')}`)
  // 停止态拒新
  await assert.rejects(() => executor.dispatch({ ...JOB_BASE, id: 'j-b' }, 'manual'), /执行链已停止/)
})

test('F03: stopJob 只清目标任务,其余任务继续', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'cron-board-f03b-'))
  t.after(() => rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }))
  const store = await createStore({ dir: join(dir, 'data') })
  const logger = createLogger({ rootDir: join(dir, 'logs') })
  // 两任务各自闸门独立放行;取消即以 cancelled 终态收敛
  const gates = new Map()
  const cancelledJobs = []
  const runner = {
    run: ({ job }) => {
      const promise = new Promise((resolve) => {
        gates.set(job.id, (outcome) => resolve(outcome))
      })
      return { promise, cancel: () => { cancelledJobs.push(job.id); gates.get(job.id)({ status: 'cancelled', exitCode: null }) } }
    },
  }
  const executor = createExecutor({ store, logger, runner, readMaxConcurrent: () => 2 })
  await store.jobs.create({ ...JOB_BASE, id: 'j-del' })
  await store.jobs.create({ ...JOB_BASE, id: 'j-keep' })
  const delRun = (await executor.dispatch({ ...JOB_BASE, id: 'j-del' }, 'manual'))[0]
  const keepRun = (await executor.dispatch({ ...JOB_BASE, id: 'j-keep' }, 'manual'))[0]
  await waitFor(() => executor.status().active === 2)
  await executor.stopJob('j-del')
  assert.deepEqual(cancelledJobs, ['j-del'], '只杀目标任务')
  assert.equal(store.runs.get(delRun).status, 'cancelled')
  // 其余任务不受影响:放行后正常终态,执行链未停
  gates.get('j-keep')({ status: 'success', exitCode: 0 })
  await waitFor(() => store.runs.get(keepRun)?.status === 'success')
  const [extra] = await executor.dispatch({ ...JOB_BASE, id: 'j-keep' }, 'manual')
  await waitFor(() => store.runs.get(extra)?.status !== undefined)
})

test('C2: runOnce 禁用写失败时回滚 queued 记录且不残留内存队列', async (t) => {
  const { store, executor } = await makeExecutor(t)
  await store.jobs.create({ ...JOB_BASE, id: 'j-once-fail', runOnce: true })
  // Given 运行记录已预占,禁用写失败
  store.jobs.update = async () => { throw new Error('任务文件写失败') }
  // When dispatch
  await assert.rejects(() => executor.dispatch({ ...JOB_BASE, id: 'j-once-fail', runOnce: true }, 'manual'), /任务文件写失败/)
  // Then 已落库记录收敛 cancelled,队列不残留
  const rows = store.runs.list('j-once-fail')
  assert.equal(rows.length, 1)
  assert.equal(rows[0].status, 'cancelled')
  assert.equal(executor.status().queued, 0)
})

test('N14: dispatch 预占中途失败,已落库 queued 记录回滚为 cancelled 且队列不残留', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'cron-board-n14-'))
  t.after(() => rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }))
  const store = await createStore({ dir: join(dir, 'data') })
  const logger = createLogger({ rootDir: join(dir, 'logs') })
  const executor = createExecutor({ store, logger, runner: { run: () => new Promise(() => {}) }, readMaxConcurrent: () => 1 })
  await store.envs.create({ name: 'X', value: '1\n2\n3', multi: true, remarks: '', enabled: true })
  await store.jobs.create({ ...JOB_BASE, id: 'j-preempt-fail' })
  // Given 第 2 条预占写入抛错(磁盘/损坏等)
  const rawCreate = store.runs.create.bind(store.runs)
  let created = 0
  store.runs.create = (data) => {
    created += 1
    if (created === 2) return Promise.reject(new Error('磁盘写失败'))
    return rawCreate(data)
  }
  // When dispatch
  await assert.rejects(() => executor.dispatch({ ...JOB_BASE, id: 'j-preempt-fail' }, 'manual'), /磁盘写失败/)
  store.runs.create = rawCreate
  // Then 已落库的第 1 条不是永久 queued,而是 cancelled;内存队列零残留
  const rows = store.runs.list('j-preempt-fail')
  assert.equal(rows.length, 1)
  assert.equal(rows[0].status, 'cancelled')
  assert.match(rows[0].message, /执行预占失败/)
  assert.equal(executor.status().queued, 0)
})

test('N14: create 成功后补写 logFile 失败,该记录同样纳入回滚', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'cron-board-n14b-'))
  t.after(() => rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }))
  const store = await createStore({ dir: join(dir, 'data') })
  const logger = createLogger({ rootDir: join(dir, 'logs') })
  const executor = createExecutor({ store, logger, runner: { run: () => new Promise(() => {}) }, readMaxConcurrent: () => 1 })
  await store.jobs.create({ ...JOB_BASE, id: 'j-preempt-fail2' })
  // Given 记录 create 成功,紧随其后的 logFile 补写失败(仅失败一次,回滚写恢复正常)
  const rawUpdate = store.runs.update.bind(store.runs)
  let failures = 1
  store.runs.update = (id, patch) => {
    if (failures > 0) { failures -= 1; return Promise.reject(new Error('补写失败')) }
    return rawUpdate(id, patch)
  }
  // When dispatch
  await assert.rejects(() => executor.dispatch({ ...JOB_BASE, id: 'j-preempt-fail2' }, 'manual'), /补写失败/)
  store.runs.update = rawUpdate
  // Then create 出的那条记录也被回滚,不是永久 queued
  const rows = store.runs.list('j-preempt-fail2')
  assert.equal(rows.length, 1)
  assert.equal(rows[0].status, 'cancelled')
  assert.match(rows[0].message, /执行预占失败/)
})

test('N17: logSink.append 写入失败被吸收并留痕,不产生未处理 rejection', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'cron-board-n17-'))
  t.after(() => rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }))
  const store = await createStore({ dir: join(dir, 'data') })
  const logLines = []
  const logger = { append: async () => { throw new Error('磁盘已满') }, prune: async () => {} }
  const executor = createExecutor({
    store,
    logger,
    runner: {
      run: async ({ logSink }) => {
        // runner 按现有契约 fire-and-forget 调 append,不 await
        logSink.append('hello')
        await new Promise((resolve) => setImmediate(resolve))
        return { status: 'success', exitCode: 0 }
      },
    },
    readMaxConcurrent: () => 2,
    logSystem: (line) => logLines.push(line),
  })
  await store.jobs.create({ ...JOB_BASE, id: 'j-log-fail' })
  // When 执行并写日志失败
  const [runId] = await executor.dispatch({ ...JOB_BASE, id: 'j-log-fail' }, 'manual')
  await waitFor(() => logLines.length === 1)
  // Then 运行本身成功,日志失败经 logSystem 留痕
  assert.equal(store.runs.get(runId).status, 'success')
  assert.match(logLines[0], /日志写入失败/)
  assert.match(logLines[0], /磁盘已满/)
})

// 挂起「running 落库」这一次 await:用于把停止请求精确投放在 runUnit 的首个等待窗口内
function suspendRunningUpdate(store) {
  const original = store.runs.update.bind(store.runs)
  let release
  let reached = false
  const gate = new Promise((resolve) => { release = resolve })
  store.runs.update = async (runId, patch) => {
    if (!reached && patch && patch.status === 'running') {
      reached = true
      await gate
    }
    return original(runId, patch)
  }
  return {
    release,
    async whenReached() { await waitFor(() => (reached ? true : null)) },
  }
}

test('S1: stop 落在 runUnit 首个 await 窗口内,runner 不启动且记录收敛为 cancelled', async (t) => {
  let runnerCalls = 0
  const { store, executor } = await makeExecutor(t, {
    runner: { run: async () => { runnerCalls++; return { status: 'success', exitCode: 0 } } },
  })
  await store.jobs.create({ ...JOB_BASE, id: 'j-s1' })
  // Given runUnit 已把 activeTotal 加一,但 running 落库仍挂在 await 上
  const gate = suspendRunningUpdate(store)
  const dispatched = executor.dispatch({ ...JOB_BASE, id: 'j-s1' }, 'manual')
  await gate.whenReached()
  // When 停止请求恰好落在这个窗口内
  const stopPromise = executor.stop()
  gate.release()
  const [runId] = await dispatched
  await stopPromise
  // Then runner 从未启动(旧实现 cancelByRunId 尚无条目,stop 等满 deadline 后仍会启动)
  assert.equal(runnerCalls, 0)
  // And 预占记录以 cancelled 收敛,活跃清零,stop 返回后没有可取消的 shell 需要兜底
  assert.equal(store.runs.get(runId).status, 'cancelled')
  assert.match(store.runs.get(runId).message, /执行链停止/)
  assert.deepEqual(executor.status(), { active: 0, queued: 0 })
})

test('S1: stopJob 落在同一窗口内同样阻止 runner 启动', async (t) => {
  let runnerCalls = 0
  const { store, executor } = await makeExecutor(t, {
    runner: { run: async () => { runnerCalls++; return { status: 'success', exitCode: 0 } } },
  })
  await store.jobs.create({ ...JOB_BASE, id: 'j-s1b' })
  const gate = suspendRunningUpdate(store)
  const dispatched = executor.dispatch({ ...JOB_BASE, id: 'j-s1b' }, 'manual')
  await gate.whenReached()
  // When 删除清场(任务级)落在同一窗口内
  const stopping = executor.stopJob('j-s1b')
  gate.release()
  const [runId] = await dispatched
  const outcome = await stopping
  // Then 单元不会在清场返回后启动
  assert.equal(runnerCalls, 0)
  assert.equal(outcome.settled, true)
  assert.equal(store.runs.get(runId).status, 'cancelled')
  assert.match(store.runs.get(runId).message, /任务已删除/)
})

test('S1: 停止窗口内不启动 shell,stop 无需等满 settle deadline', async (t) => {
  let cancelled = 0
  const { store, executor } = await makeExecutor(t, {
    // 可取消但会悬挂的 shell:一旦启动,旧实现只能等满 deadline 才能返回
    runner: { run: () => ({ promise: new Promise(() => {}), cancel: () => { cancelled++; } }) },
  })
  await store.jobs.create({ ...JOB_BASE, id: 'j-s1c' })
  const gate = suspendRunningUpdate(store)
  const dispatched = executor.dispatch({ ...JOB_BASE, id: 'j-s1c' }, 'manual')
  await gate.whenReached()
  // When 停止
  const startedAt = Date.now()
  const stopPromise = executor.stop()
  gate.release()
  const [runId] = await dispatched
  await stopPromise
  // Then 未启动的单元直接收敛,stop 立即可返回(旧实现需等满 5s 且之后 runner 才启动)
  assert.equal(cancelled, 0)
  assert.ok(Date.now() - startedAt < 3000, 'stop 不应等满 settle deadline')
  assert.equal(store.runs.get(runId).status, 'cancelled')
  assert.deepEqual(executor.status(), { active: 0, queued: 0 })
})
