// 看板工具 BDD:读取/写入与 HTTP 路由共用归一规则,错误码稳定可判别;
// 工具默认不注册由 index.js 的设置开关承担,这里验证定义与执行面。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createStore } from '../src/store.mjs'
import { createJobTools } from '../src/tools.mjs'

async function makeTools(t, { sessionAvailable = false } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'cron-board-tools-'))
  t.after(() => rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }))
  const store = await createStore({ dir })
  const removedJobs = []
  const logger = { removeJob: async (jobId) => { removedJobs.push(jobId) } }
  const executor = {
    dispatched: [],
    stopSettled: true,
    async stopJob() { return { settled: this.stopSettled } },
    releaseJob() {},
    async dispatch(job, trigger) { this.dispatched.push({ jobId: job.id, trigger }); return ['run-' + this.dispatched.length] },
  }
  const tools = createJobTools({
    getRuntime: async () => ({ store, logger, executor }),
    getSessionController: () => (sessionAvailable ? {} : undefined),
  })
  const byName = Object.fromEntries(tools.map((tool) => [tool.name, tool]))
  return { store, logger, executor, tools, byName, removedJobs }
}

test('tools:create 归一计划并落库,list 按启用与下次触发排序', async (t) => {
  const { byName, store } = await makeTools(t)
  // When 创建两条计划的任务
  const created = await byName.cron_board_create.execute({
    name: '巡检', schedule: '* * * * *\n*/2 * * * *T+8', command: 'echo hi',
  })
  // Then 返回任务形态,摘要与触发点已算好
  assert.ok(created.id)
  assert.equal(created.kind, 'shell')
  assert.equal(created.schedule, '* * * * *\n*/2 * * * *T+8')
  assert.match(created.summary, /·/)
  assert.ok(created.nextRunAt)
  assert.equal(created.enabled, true)
  // When 创建一个停用任务与一个会话任务
  await byName.cron_board_create.execute({ name: '停用', schedule: '0 9 * * *', command: 'x', enabled: false })
  // Then list 启用在前,总数正确
  const list = await byName.cron_board_list.execute({})
  assert.equal(list.total, 2)
  assert.equal(list.items[0].name, '巡检')
  assert.equal(list.items[1].enabled, false)
  // Then kind 过滤生效
  const shellOnly = await byName.cron_board_list.execute({ kind: 'shell' })
  assert.equal(shellOnly.total, 2)
  assert.equal(store.jobs.list().length, 2)
})

test('tools:create 错误码稳定——空名称/非法表达式/无未来触发点/会话服务缺失', async (t) => {
  const { byName } = await makeTools(t)
  assert.equal((await byName.cron_board_create.execute({ name: ' ', schedule: '0 9 * * *', command: 'x' })).code, 'invalid_name')
  assert.equal((await byName.cron_board_create.execute({ name: 'n', schedule: 'not-a-cron', command: 'x' })).code, 'invalid_schedule')
  assert.equal((await byName.cron_board_create.execute({ name: 'n', schedule: '0 0 30 2 *', command: 'x' })).code, 'not_future')
  assert.equal((await byName.cron_board_create.execute({ name: 'n', schedule: '0 9 * * *' })).code, 'invalid_command')
  const session = await byName.cron_board_create.execute({ name: 'n', schedule: '0 9 * * *', kind: 'session', prompt: 'p' })
  assert.equal(session.code, 'session_unavailable')
})

test('tools:view 返回正文与最近运行,未知 id 返回 job_not_found', async (t) => {
  const { byName, store } = await makeTools(t)
  const created = await byName.cron_board_create.execute({ name: '查看', schedule: '0 9 * * *', command: 'echo hi', prompt: 'p' })
  await store.runs.create({ jobId: created.id, trigger: 'cron', status: 'success', schedules: ['0 9 * * *'] })
  const view = await byName.cron_board_view.execute({ id: created.id })
  assert.equal(view.command, 'echo hi')
  assert.equal(view.prompt, 'p')
  assert.equal(view.recentRuns.length, 1)
  assert.equal(view.recentRuns[0].status, 'success')
  assert.equal((await byName.cron_board_view.execute({ id: 'missing' })).code, 'job_not_found')
})

test('tools:edit update 只改显式字段并重算触发点,乐观锁冲突返回 job_conflict', async (t) => {
  const { byName } = await makeTools(t)
  const created = await byName.cron_board_create.execute({ name: '旧名', schedule: '0 9 * * *', command: 'echo hi' })
  // When 只改名
  const renamed = await byName.cron_board_edit.execute({ id: created.id, action: 'update', name: '新名' })
  assert.equal(renamed.name, '新名')
  assert.equal(renamed.schedule, '0 9 * * *')
  // When 改计划
  const rescheduled = await byName.cron_board_edit.execute({ id: created.id, action: 'update', schedule: '30 8 * * *' })
  assert.equal(rescheduled.schedule, '30 8 * * *')
  assert.ok(rescheduled.nextRunAt)
  // When 用过期基线更新
  const conflict = await byName.cron_board_edit.execute({ id: created.id, action: 'update', name: 'x', expectedUpdatedAt: 1 })
  assert.equal(conflict.code, 'job_conflict')
  // Then 非法计划整份拒绝
  assert.equal((await byName.cron_board_edit.execute({ id: created.id, action: 'update', schedule: 'bad' })).code, 'invalid_schedule')
})

test('tools:edit delete 先停执行面,未能终止时保留任务并返回 job_not_terminated', async (t) => {
  const { byName, executor, removedJobs, store } = await makeTools(t)
  const created = await byName.cron_board_create.execute({ name: '删除', schedule: '0 9 * * *', command: 'echo hi' })
  // When 在途运行无法终止
  executor.stopSettled = false
  const refused = await byName.cron_board_edit.execute({ id: created.id, action: 'delete' })
  assert.equal(refused.code, 'job_not_terminated')
  assert.ok(store.jobs.get(created.id))
  // When 可终止后删除
  executor.stopSettled = true
  const deleted = await byName.cron_board_edit.execute({ id: created.id, action: 'delete' })
  assert.deepEqual(deleted, { id: created.id, deleted: true })
  assert.equal(store.jobs.get(created.id), undefined)
  assert.deepEqual(removedJobs, [created.id])
})

test('tools:edit run 立即运行并返回 runIds', async (t) => {
  const { byName, executor } = await makeTools(t)
  const created = await byName.cron_board_create.execute({ name: '运行', schedule: '0 9 * * *', command: 'echo hi' })
  const run = await byName.cron_board_edit.execute({ id: created.id, action: 'run' })
  assert.deepEqual(run.runIds, ['run-1'])
  assert.deepEqual(executor.dispatched, [{ jobId: created.id, trigger: 'manual' }])
})
