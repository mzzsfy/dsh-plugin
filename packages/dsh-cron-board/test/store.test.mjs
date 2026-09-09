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
  // Then 两条并存(青龙多账号语义)
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
