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

async function makeExecutor(t, { jobsBroken = false, logLines = [] } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'cron-board-exec-'))
  // Windows 下并行测试时 Defender/索引器短暂锁目录,rmdir 报瞬态 EBUSY,有界重试消解
  t.after(() => rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }))
  const store = await createStore({ dir: join(dir, 'data') })
  const logger = createLogger({ rootDir: join(dir, 'logs') })
  if (jobsBroken) {
    // 模拟 jobs 集合损坏(mutate 直接拒绝),runs 集合保持健康
    store.jobs.update = async () => { throw new Error('数据文件已损坏已备份,已暂停写入以防数据丢失') }
  }
  const runner = {
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
  const driver = createSessionDriver({ getSessionController: () => controller, agents: { get: id => sessions.get(id) }, sessionQuery: { listSessions: async () => [...sessions.keys()].map(id => ({ header: { id } })) } })
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
