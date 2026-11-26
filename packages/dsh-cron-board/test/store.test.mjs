// store 测试:envs/jobs/runs 三集合的原子持久化(场景嵌入各测试注释)。
// 数据目录经 io 注入临时目录,不触碰真实 ~/.dsh。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createStore } from '../src/store.mjs'

async function makeStore(t) {
  const dir = await mkdtemp(join(tmpdir(), 'cron-board-store-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  return { dir, store: await createStore({ dir }) }
}

test('store:环境变量增改删持久化,新实例重开同目录数据仍在', async (t) => {
  // Given 空数据目录
  const { dir, store } = await makeStore(t)
  // When 创建一条环境变量并更新
  const created = await store.envs.create({ name: 'WX_KEY', value: 'v1', remarks: '', enabled: true })
  await store.envs.update(created.id, { value: 'v2' })
  // Then 内存读回一致
  const listed = store.envs.list()
  assert.equal(listed.length, 1)
  assert.equal(listed[0].name, 'WX_KEY')
  assert.equal(listed[0].value, 'v2')
  assert.equal(listed[0].enabled, true)
  assert.ok(listed[0].createdAt > 0)
  // Then 新实例重开同目录(模拟重启)数据仍在
  const reopened = await createStore({ dir })
  assert.equal(reopened.envs.list().length, 1)
  assert.equal(reopened.envs.list()[0].value, 'v2')
})

test('store:任务创建携带运行态字段且 nextRunAt 可更新', async (t) => {
  // Given 空数据目录
  const { store } = await makeStore(t)
  // When 创建任务并推进 nextRunAt
  const job = await store.jobs.create({
    name: '签到', kind: 'shell', command: 'echo hi', schedule: '30 8 * * *',
    enabled: true, timeoutMs: 60 * 1000,
  })
  await store.jobs.update(job.id, { nextRunAt: 1750000000000 })
  // Then 读回运行态字段
  const [row] = store.jobs.list()
  assert.equal(row.name, '签到')
  assert.equal(row.nextRunAt, 1750000000000)
  assert.equal(row.enabled, true)
})

test('store:运行记录追加与按任务过滤,删除任务连带删除其记录', async (t) => {
  // Given 一条任务
  const { store } = await makeStore(t)
  const job = await store.jobs.create({ name: 'j', kind: 'shell', command: 'x', schedule: '* * * * *', enabled: true, timeoutMs: 1000 })
  // When 追加两条运行记录(分属两任务)并删除任务
  await store.runs.create({ runId: 'r1', jobId: job.id, trigger: 'manual', status: 'success' })
  await store.runs.create({ runId: 'r2', jobId: 'other', trigger: 'cron', status: 'fail' })
  assert.equal(store.runs.list(job.id).length, 1)
  await store.jobs.remove(job.id)
  // Then 该任务记录连带清除,他任务记录保留
  assert.equal(store.runs.list(job.id).length, 0)
  assert.equal(store.runs.list('other').length, 1)
})

test('store:同名环境变量多条合法', async (t) => {
  // Given 已有一条 WX_KEY
  const { store } = await makeStore(t)
  await store.envs.create({ name: 'WX_KEY', value: 'a', remarks: '', enabled: true })
  // When 再创建同名不同值
  await store.envs.create({ name: 'WX_KEY', value: 'b', remarks: '', enabled: true })
  // Then 两条并存(多账号语义)
  const same = store.envs.list().filter((row) => row.name === 'WX_KEY')
  assert.equal(same.length, 2)
})

test('store:数据文件损坏时备份 .bak 并拒绝写入,他集合不受影响', async (t) => {
  // Given envs.json 内容非法
  const { dir, store } = await makeStore(t)
  const { writeFile } = await import('node:fs/promises')
  await writeFile(join(dir, 'envs.json'), 'not-json', 'utf8')
  const reopened = await createStore({ dir })
  // When 重开实例后尝试写入 envs
  await assert.rejects(() => reopened.envs.create({ name: 'X', value: '1', enabled: true }))
  // Then 坏文件已备份为 .bak,其余集合读写正常
  const backup = await import('node:fs/promises').then((fs) => fs.readFile(join(dir, 'envs.json.bak'), 'utf8'))
  assert.equal(backup, 'not-json')
  await reopened.jobs.create({ name: 'j', kind: 'shell', command: 'x', schedule: '* * * * *', enabled: true, timeoutMs: 1000 })
  assert.equal(reopened.jobs.list().length, 1)
  void store
})

test('store:合法 JSON 但非数组同属损坏,备份 .bak 并拒绝写入防覆盖', async (t) => {
  // Given jobs.json 是合法 JSON 对象(旧实现只认数组,会静默留空并在下次写覆盖)
  const { dir } = await makeStore(t)
  const { readFile, writeFile } = await import('node:fs/promises')
  const original = '{"name":"旧数据"}'
  await writeFile(join(dir, 'jobs.json'), original, 'utf8')
  const reopened = await createStore({ dir })
  // When 重开实例后尝试写入 jobs
  await assert.rejects(() => reopened.jobs.create({ name: 'j', kind: 'shell', command: 'x', schedule: '* * * * *', enabled: true, timeoutMs: 1000 }))
  // Then 原文件被完整备份,内容未丢
  assert.equal(await readFile(join(dir, 'jobs.json.bak'), 'utf8'), original)
})

test('store:配置版本与运行时版本分离,运行回填不推进 updatedAt', async (t) => {
  // Given 一个任务,记录配置版本基线
  const { store } = await makeStore(t)
  const created = await store.jobs.create({ name: 'j', kind: 'shell', command: 'x', schedule: '* * * * *', enabled: true, timeoutMs: 1000 })
  const baseline = created.updatedAt
  // When 调度/执行回填 nextRunAt/lastStatus
  await store.jobs.updateRuntime(created.id, { nextRunAt: 1750000000000, lastRunAt: 1750000000000, lastStatus: 'success' })
  // Then 运行字段生效但配置版本基线不动
  assert.equal(store.jobs.get(created.id).lastStatus, 'success')
  assert.equal(store.jobs.get(created.id).updatedAt, baseline)
  assert.equal(typeof store.jobs.get(created.id).runtimeUpdatedAt, 'number')
  // When 携带原基线保存编辑
  const outcome = await store.jobs.updateIf(created.id, baseline, { name: '改名' })
  // Then CAS 受理(运行回填不产生 409)
  assert.equal(outcome.ok, true)
  assert.equal(outcome.row.name, '改名')
  assert.ok(outcome.row.updatedAt > baseline, '配置写必须推进配置版本')
})

test('store:updateIf 在临界区内比较并写入,并发同基线仅一个成功', async (t) => {
  // Given 同一配置版本基线
  const { store } = await makeStore(t)
  const created = await store.jobs.create({ name: 'j', kind: 'shell', command: 'x', schedule: '* * * * *', enabled: true, timeoutMs: 1000 })
  // When 两个 CAS 更新并发提交
  const [first, second] = await Promise.all([
    store.jobs.updateIf(created.id, created.updatedAt, { name: 'A' }),
    store.jobs.updateIf(created.id, created.updatedAt, { name: 'B' }),
  ])
  // Then 恰一个成功、另一个冲突,最终值属于成功方
  assert.deepEqual([first.ok, second.ok].sort(), [false, true])
  assert.equal([first, second].find((item) => item.ok).row.name, store.jobs.get(created.id).name)
  assert.equal([first, second].find((item) => !item.ok).reason, 'conflict')
})

test('D08: 启动时回收 jobId 指向已删任务的孤儿运行记录', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'cron-board-orphan-'))
  t.after(() => rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }))
  const first = await createStore({ dir })
  const job = await first.jobs.create({ name: 't', kind: 'shell', command: 'x', schedule: '* * * * *', enabled: true, timeoutMs: 1000 })
  await first.runs.create({ jobId: job.id, trigger: 'manual', status: 'success', logFile: 'a' })
  await first.runs.create({ jobId: 'ghost-job', trigger: 'manual', status: 'success', logFile: 'b' })
  await first.flush()
  // When 重启(重新加载两个集合文件)
  const second = await createStore({ dir })
  // Then 无主记录被丢弃,活任务的历史保留
  assert.equal(second.orphanRunsPruned, 1)
  assert.deepEqual(second.runs.list('ghost-job'), [])
  assert.equal(second.runs.list(job.id).length, 1)
})

test('D08: updateRuntime 支持函数补丁,读改写同临界区', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'cron-board-runtime-'))
  t.after(() => rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }))
  const store = await createStore({ dir })
  const job = await store.jobs.create({
    name: 't', kind: 'session', schedule: '0 9 * * *', prompt: 'x', enabled: false,
    session: { mode: 'fresh', pinnedSessionId: '', agentPreset: 'standard' },
  })
  // When 并发「配置改名」与「绑定回填」同时发生
  const [renamed] = await Promise.all([
    store.jobs.update(job.id, { name: '改名' }),
    store.jobs.updateRuntime(job.id, (row) => ({ session: { ...row.session, pinnedSessionId: 's-1' } })),
  ])
  // Then 两个字段都保留(旧实现用外部快照写回会覆盖其中一处)
  const row = store.jobs.get(job.id)
  assert.equal(renamed.name, '改名')
  assert.equal(row.session.pinnedSessionId, 's-1')
})

test('D08: 函数补丁不会覆盖并发配置写(会话子字段各自保留)', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'cron-board-runtime2-'))
  t.after(() => rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }))
  const store = await createStore({ dir })
  const job = await store.jobs.create({
    name: 't', kind: 'session', schedule: '0 9 * * *', prompt: 'x', enabled: false,
    session: { mode: 'pinned', pinnedSessionId: '', agentPreset: 'standard' },
  })
  // When 配置侧改预设与执行侧回填绑定同时发生
  await Promise.all([
    store.jobs.update(job.id, { session: { mode: 'pinned', pinnedSessionId: '', agentPreset: 'reviewer' } }),
    store.jobs.updateRuntime(job.id, (row) => ({ session: { ...row.session, pinnedSessionId: 's-9' } })),
  ])
  // Then 两处改动都在:旧实现用外部快照写回会丢掉其中一个
  const row = store.jobs.get(job.id)
  assert.equal(row.session.agentPreset, 'reviewer')
  assert.equal(row.session.pinnedSessionId, 's-9')
})

test('D08: 任务集合为空而运行记录非空时跳过孤儿回收(防误清历史)', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'cron-board-orphan2-'))
  t.after(() => rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }))
  const first = await createStore({ dir })
  await first.runs.create({ jobId: 'ghost', trigger: 'manual', status: 'success', logFile: 'a' })
  await first.flush()
  // When 任务文件缺失后重启(集合为空,运行记录仍在)
  const second = await createStore({ dir })
  // Then 不清空历史
  assert.equal(second.orphanRunsPruned, 0)
  assert.equal(second.runs.list('ghost').length, 1)
})
