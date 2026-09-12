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

async function dispatchAndSettle(executor, store, jobId) {
  const [runId] = await executor.dispatch({ ...JOB_BASE, id: jobId }, 'manual')
  // 等执行链收尾:pump 后单元在后台,轮询至终态或超时
  for (let i = 0; i < 200; i++) {
    const row = store.runs.get(runId)
    if (row && row.status !== 'queued' && row.status !== 'running') return runId
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  return runId
}

test('executor:正常路径终态 success 且任务卡回填', async (t) => {
  const { store, executor } = await makeExecutor(t)
  await store.jobs.create({ ...JOB_BASE, id: 'j1' })
  const runId = await dispatchAndSettle(executor, store, 'j1')
  assert.equal(store.runs.get(runId).status, 'success')
  assert.equal(store.jobs.get('j1').lastStatus, 'success')
})

test('executor:pinned 自愈回写 session.pinnedSessionId 且清除顶层孤立字段', async (t) => {
  const { store, executor } = await makeExecutor(t)
  // Given pinned 任务(session 子对象承载绑定),runner 返回 pinnedNewId 模拟自愈
  const executorWithPinned = createExecutor({
    store: await (async () => {
      await store.jobs.create({ ...JOB_BASE, kind: 'session', session: { mode: 'pinned', pinnedSessionId: '' }, id: 'j-pin' })
      return store
    })(),
    logger: createLogger({ rootDir: join(tmpdir(), 'cron-board-exec-pin-logs') }),
    sessionRunner: { run: async () => ({ status: 'success', sessionId: 's-new', pinnedNewId: 's-new', message: '首次运行已创建并绑定会话' }) },
    readMaxConcurrent: () => 2,
  })
  const [runId] = await executorWithPinned.dispatch({ ...JOB_BASE, kind: 'session', session: { mode: 'pinned', pinnedSessionId: '' }, id: 'j-pin' }, 'manual')
  for (let i = 0; i < 200; i++) {
    const row = store.runs.get(runId)
    if (row && row.status !== 'queued' && row.status !== 'running') break
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  // Then 绑定写入 session 子对象,顶层无孤立残留
  const job = store.jobs.get('j-pin')
  assert.equal(job.session.pinnedSessionId, 's-new')
  assert.equal(job.pinnedSessionId, undefined)
  assert.equal(store.runs.get(runId).message, '首次运行已创建并绑定会话')
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
  for (let i = 0; i < 200; i++) {
    const row = store.runs.get(runId)
    if (row && row.status === 'fail') break
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  const row = store.runs.get(runId)
  assert.equal(row.status, 'fail')
  assert.match(row.message, /会话服务爆炸/)
  assert.equal(store.jobs.get('j2').lastStatus, 'fail')
  assert.equal(logLines.length, 0, '补写成功不留痕')
})

test('executor:运行终态已落库而任务卡回填失败,历史不被覆写', async (t) => {
  const { store, executor, logLines } = await makeExecutor(t, { jobsBroken: true })
  await store.jobs.create({ ...JOB_BASE, id: 'j3' })
  const runId = await dispatchAndSettle(executor, store, 'j3')
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
  await new Promise((resolve) => setTimeout(resolve, 200))
  // Then 补写失败恰留痕一次,含 runId 与原始错误
  assert.equal(logLines.length, 1)
  assert.ok(logLines[0].includes(runId))
  assert.ok(logLines[0].includes('补写失败'))
})
