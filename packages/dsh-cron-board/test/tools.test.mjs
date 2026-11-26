// 看板工具 BDD:读取/写入与 HTTP 路由共用归一规则,错误码稳定可判别;
// 模型写面只允许当前顶层会话创建的 session 任务,既有 shell 任务保持只读。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'

import { createStore } from '../src/store.mjs'
import { normalizeJob } from '../src/job-fields.mjs'
import { createJobTools } from '../src/tools.mjs'

function makeAgent({ id = 'session-root', cwd = '/workspace/current', preset = 'coder', origin = 'user' } = {}) {
  const ctx = {
    get(name) {
      if (name !== 'agentPresets') return undefined
      return {
        preset,
        composedPreset(scope) { return scope === ctx ? this.preset : undefined },
      }
    },
  }
  return { ctx, session: { id, header: { cwd, origin } } }
}

async function makeTools(t, { sessionAvailable = true, agent: suppliedAgent, maxJobs = 0 } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'cron-board-tools-'))
  t.after(() => rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }))
  const store = await createStore({ dir })
  const removedJobs = []
  const logger = { removeJob: async (jobId) => { removedJobs.push(jobId) } }
  const executor = {
    dispatched: [],
    stopCalls: [],
    stopSettled: true,
    async stopJob(jobId) { this.stopCalls.push(jobId); return { settled: this.stopSettled } },
    releases: [],
    releaseJob(id) { this.releases.push(id) },
    async dispatch(job, trigger) { this.dispatched.push({ jobId: job.id, trigger }); return ['run-' + this.dispatched.length] },
  }
  const agent = suppliedAgent ?? makeAgent()
  let changes = 0
  const tools = createJobTools({
    notifyChange: () => { changes++ },
    getRuntime: async () => ({ store, logger, executor }),
    getSessionController: () => (sessionAvailable ? {} : undefined),
    readMaxJobs: () => maxJobs,
  })
  const byName = Object.fromEntries(tools.map((tool) => [tool.name, tool]))
  return { store, logger, executor, tools, byName, removedJobs, exec: { agent }, changes: () => changes }
}

async function seedShell(store, id = 'shell-1') {
  const fields = normalizeJob({
    name: '脚本 fixture',
    kind: 'shell',
    schedule: '* * * * *',
    command: 'echo fixture',
    workdir: '/shell',
  })
  return store.jobs.create({ ...fields, id })
}

async function createSession(byName, exec, name = '会话任务', extra = {}) {
  return byName.cron_board_create.execute({
    name,
    schedule: '* * * * *',
    kind: 'session',
    prompt: '执行会话任务',
    ...extra,
  }, exec)
}

test('S1: 宿主执行管线可写入和渲染停用的多计划会话任务', async (t) => {
  const { tools, store, exec } = await makeTools(t)
  const root = new Context()
  new SystemPrompt(root, {})
  new ToolRuntime(root, {})
  t.after(() => root.fiber.dispose())
  for (const definition of tools) root.tools.register(definition)
  const call = async (name, args) => {
    const invoke = () => root.tools.execute({
      name, arguments: args, callId: name, signal: new AbortController().signal, ...exec,
    })
    // 宿主执行器由其它测试进程共享的模块实例懒挂载:并行跑全量时偶发「executor 未就绪」,
    // 重试一次不影响断言(工具本身是幂等读/单次写)
    let result
    try {
      result = await invoke()
    } catch (error) {
      if (error?.code !== 'TOOL_EXECUTOR_UNAVAILABLE') throw error
      await new Promise((resolve) => setTimeout(resolve, 50))
      result = await invoke()
    }
    assert.equal(result.isError, false, JSON.stringify(result.error))
    assert.deepEqual(JSON.parse(result.content[0].text), result.value)
    return result.value
  }
  const created = await call('cron_board_create', {
    name: '序列化夹具', kind: 'session', schedule: '0 9 * * *T+0\n0 17 * * 1T+0', prompt: 'OK', enabled: false,
  })
  assert.ok(created.id)
  assert.equal(store.jobs.get(created.id).enabled, false)
  const viewed = await call('cron_board_view', { id: created.id })
  assert.equal(viewed.prompt, 'OK')
  assert.equal(viewed.schedule, '0 9 * * *T+0\n0 17 * * 1T+0')
  assert.equal(Object.hasOwn(viewed, 'timeoutMs'), false)
  const updated = await call('cron_board_edit', { action: 'update', id: created.id, name: '改名', expectedUpdatedAt: viewed.updatedAt })
  assert.equal(updated.name, '改名')
  assert.deepEqual(await call('cron_board_edit', { action: 'delete', id: created.id, expectedUpdatedAt: updated.updatedAt }), { id: created.id, deleted: true })
  assert.equal(store.jobs.get(created.id), undefined)
})

test('tools:create 只创建 session,继承当前调用会话 cwd 与组合 preset 并记录来源,list 仍可读 shell fixture', async (t) => {
  const { byName, store, exec } = await makeTools(t)
  const created = await createSession(byName, exec, '巡检')
  assert.ok(created.id)
  assert.equal(created.kind, 'session')
  assert.equal(created.enabled, true)
  assert.equal(store.jobs.get(created.id).workdir, '/workspace/current')
  assert.deepEqual(store.jobs.get(created.id).session, { mode: 'fresh', pinnedSessionId: '', agentPreset: 'coder' })
  assert.equal(store.jobs.get(created.id).createdBySessionId, 'session-root')

  await createSession(byName, exec, '停用', { enabled: false })
  await seedShell(store)
  const list = await byName.cron_board_list.execute({})
  assert.equal(list.total, 3)
  assert.deepEqual(list.items.map((item) => item.kind).sort(), ['session', 'session', 'shell'])
  assert.equal((await byName.cron_board_list.execute({ kind: 'shell' })).total, 1)
  assert.equal(store.jobs.list().length, 3)
  await assert.rejects(
    byName.cron_board_create.execute({ name: '脚本', schedule: '* * * * *', kind: 'shell', command: 'echo unsafe' }, exec),
    (error) => error.code === 'INVALID_ARGS',
  )
})

test('S1: list 分页返回总数和游标，超过单页上限仍可读完整集合', async (t) => {
  const { byName, store } = await makeTools(t)
  const fields = normalizeJob({ name: '分页任务', kind: 'shell', schedule: '* * * * *', command: 'echo page', workdir: '/page' })
  for (let i = 0; i < 501; i++) await store.jobs.create({ ...fields, id: 'page-' + i, name: '分页任务-' + i })
  const first = await byName.cron_board_list.execute({ limit: 500 })
  const second = await byName.cron_board_list.execute({ limit: 500, offset: first.offset + first.shown })
  assert.deepEqual({ shown: first.shown, total: first.total, limit: first.limit, offset: first.offset }, { shown: 500, total: 501, limit: 500, offset: 0 })
  assert.deepEqual({ shown: second.shown, total: second.total, limit: second.limit, offset: second.offset }, { shown: 1, total: 501, limit: 500, offset: 500 })
  assert.equal(new Set([...first.items, ...second.items].map((item) => item.id)).size, 501)
})

test('tools:create 错误码稳定——空名称/非法表达式/无未来触发点/会话服务缺失', async (t) => {
  const { byName, exec } = await makeTools(t, { sessionAvailable: false })
  assert.equal((await createSession(byName, exec, ' ')).code, 'invalid_name')
  assert.equal((await createSession(byName, exec, 'n', { schedule: 'not-a-cron' })).code, 'invalid_schedule')
  assert.equal((await createSession(byName, exec, 'n', { schedule: '0 0 30 2 *' })).code, 'not_future')
  assert.equal((await createSession(byName, exec, 'n')).code, 'session_unavailable')
  assert.equal((await byName.cron_board_create.execute({ name: 'n', schedule: '* * * * *', kind: 'session', prompt: 'p' })).code, 'agent_required')
})

test('tools:view 返回 session 正文与最近运行,可选 shell 字段不输出 undefined,未知 id 返回 job_not_found', async (t) => {
  const { byName, store, exec } = await makeTools(t)
  const created = await createSession(byName, exec, '查看')
  await store.runs.create({ jobId: created.id, trigger: 'cron', status: 'success', schedules: ['* * * * *'] })
  const view = await byName.cron_board_view.execute({ id: created.id })
  assert.equal(view.prompt, '执行会话任务')
  assert.equal(view.workdir, '/workspace/current')
  assert.equal(view.recentRuns.length, 1)
  assert.equal(view.recentRuns[0].status, 'success')
  assert.equal(Object.hasOwn(view, 'command'), false)
  assert.equal((await byName.cron_board_view.execute({ id: 'missing' })).code, 'job_not_found')
})

test('tools:view 脚本任务返回命令与超时,不返回会话正文', async (t) => {
  const { byName, store } = await makeTools(t)
  const shell = await seedShell(store)
  const view = await byName.cron_board_view.execute({ id: shell.id })
  assert.equal(view.kind, 'shell')
  assert.equal(typeof view.command, 'string')
  assert.equal(typeof view.timeoutMs, 'number')
  assert.equal(Object.hasOwn(view, 'prompt'), false)
  assert.equal(view.session, null)
})

test('tools:edit update 只允许来源 session 的安全字段并以读到的版本 CAS,禁止改执行边界', async (t) => {
  const { byName, store, exec } = await makeTools(t)
  const created = await createSession(byName, exec, '旧名')
  const renamed = await byName.cron_board_edit.execute({ id: created.id, action: 'update', name: '新名', expectedUpdatedAt: created.updatedAt }, exec)
  assert.equal(renamed.name, '新名')
  assert.equal(renamed.schedule, '* * * * *')
  const rescheduled = await byName.cron_board_edit.execute({ id: created.id, action: 'update', schedule: '30 8 * * *', expectedUpdatedAt: renamed.updatedAt }, exec)
  assert.equal(rescheduled.schedule, '30 8 * * *')
  assert.ok(rescheduled.nextRunAt)
  const version = rescheduled.updatedAt
  assert.equal((await byName.cron_board_edit.execute({ id: created.id, action: 'update', workdir: '/escape', expectedUpdatedAt: version }, exec)).code, 'invalid_selector')
  assert.equal((await byName.cron_board_edit.execute({ id: created.id, action: 'update', agentPreset: 'admin', expectedUpdatedAt: version }, exec)).code, 'invalid_selector')
  assert.equal((await byName.cron_board_edit.execute({ id: created.id, action: 'update', expectedUpdatedAt: version }, exec)).code, 'invalid_selector')
  assert.equal((await byName.cron_board_edit.execute({ id: created.id, action: 'update', name: 'x', expectedUpdatedAt: 1 }, exec)).code, 'job_conflict')
  assert.equal((await byName.cron_board_edit.execute({ id: created.id, action: 'update', schedule: 'bad', expectedUpdatedAt: version }, exec)).code, 'invalid_schedule')
  await assert.rejects(
    byName.cron_board_edit.execute({ id: created.id, action: 'run', expectedUpdatedAt: version }, exec),
    (error) => error.code === 'INVALID_ARGS',
  )
  assert.equal(store.jobs.get(created.id).workdir, '/workspace/current')
})

test('S1: 写操作必须带读到的版本,缺失即拒绝且不改数据', async (t) => {
  const { byName, store, exec } = await makeTools(t)
  const created = await createSession(byName, exec, '无版本')
  await assert.rejects(
    byName.cron_board_edit.execute({ id: created.id, action: 'update', name: '偷改' }, exec),
    (error) => error.code === 'INVALID_ARGS',
  )
  await assert.rejects(
    byName.cron_board_edit.execute({ id: created.id, action: 'delete' }, exec),
    (error) => error.code === 'INVALID_ARGS',
  )
  assert.equal(store.jobs.get(created.id).name, '无版本')
})

test('S1: 读后被看板改写,模型按旧版本写返回 job_conflict 而不静默覆盖', async (t) => {
  const { byName, store, exec } = await makeTools(t)
  const created = await createSession(byName, exec, '并发')
  await store.jobs.update(created.id, { prompt: '用户改过' })
  const written = await byName.cron_board_edit.execute({ id: created.id, action: 'update', prompt: '模型旧快照', expectedUpdatedAt: created.updatedAt }, exec)
  assert.equal(written.code, 'job_conflict')
  assert.equal(store.jobs.get(created.id).prompt, '用户改过')
})

test('S1: 名称超长按 invalid_name 拒绝,存量超长名称仍可停用', async (t) => {
  const { byName, store, exec } = await makeTools(t)
  const created = await createSession(byName, exec, 'x'.repeat(121))
  assert.equal(created.code, 'invalid_name')
  const legacy = await createSession(byName, exec, '短名')
  await store.jobs.update(legacy.id, { name: 'x'.repeat(121) })
  const version = store.jobs.get(legacy.id).updatedAt
  const disabled = await byName.cron_board_edit.execute({ id: legacy.id, action: 'update', enabled: false, expectedUpdatedAt: version }, exec)
  assert.equal(disabled.enabled, false)
})

test('S1: delete 携带可更新字段按 invalid_selector 拒绝且不删任务', async (t) => {
  const { byName, store, exec, executor } = await makeTools(t)
  const created = await createSession(byName, exec, '删除夹带')
  const refused = await byName.cron_board_edit.execute({
    id: created.id, action: 'delete', name: '夹带改名', expectedUpdatedAt: created.updatedAt,
  }, exec)
  assert.equal(refused.code, 'invalid_selector')
  assert.ok(store.jobs.get(created.id))
  assert.deepEqual(executor.stopCalls, [])
})

test('S1: pinned 创建钉住调用方会话,首跑前后都可写', async (t) => {
  const { byName, store, exec } = await makeTools(t)
  const created = await createSession(byName, exec, '固定会话', { sessionMode: 'pinned' })
  assert.equal(created.kind, 'session')
  // 绑定必须落在调用方会话上,否则首跑后模型再也写不了自己建的任务
  assert.equal(store.jobs.get(created.id).session.pinnedSessionId, 'session-root')
  const renamed = await byName.cron_board_edit.execute({ id: created.id, action: 'update', name: '固定会话改名', expectedUpdatedAt: created.updatedAt }, exec)
  assert.equal(renamed.name, '固定会话改名')
})

test('S1: 无工作目录的会话不能创建任务', async (t) => {
  const { byName, store, exec } = await makeTools(t, { agent: makeAgent({ cwd: '  ' }) })
  const created = await createSession(byName, exec, '空目录')
  assert.equal(created.code, 'cwd_required')
  assert.equal(store.jobs.list().length, 0)
})

test('S1: 投递目标改为其他会话后收回写权限', async (t) => {
  const { byName, store, exec } = await makeTools(t)
  const created = await createSession(byName, exec, '改绑')
  await store.jobs.update(created.id, { session: { mode: 'pinned', pinnedSessionId: 'session-other', agentPreset: 'coder' } })
  const version = store.jobs.get(created.id).updatedAt
  const written = await byName.cron_board_edit.execute({ id: created.id, action: 'update', prompt: '塞进别人会话', expectedUpdatedAt: version }, exec)
  assert.equal(written.code, 'job_context_mismatch')
  assert.equal(store.jobs.get(created.id).prompt, '执行会话任务')
})

test('S1: 调用会话中途换预设,仍可管理自己创建的任务', async (t) => {
  const { byName, store, exec } = await makeTools(t)
  const created = await createSession(byName, exec, '换预设')
  // Given 会话改为另一个组合预设(任务仍记录创建时的预设)
  const switched = { agent: makeAgent({ preset: 'reviewer' }) }
  // When 用新预设的会话改名
  const renamed = await byName.cron_board_edit.execute({ id: created.id, action: 'update', name: '换预设改名', expectedUpdatedAt: created.updatedAt }, switched)
  // Then 受理;任务记录的投递预设不被模型改写
  assert.equal(renamed.name, '换预设改名')
  assert.equal(store.jobs.get(created.id).session.agentPreset, 'coder')
})

test('tools:edit 拒绝其他调用 session 修改或删除,既有 shell 始终只读', async (t) => {
  const { byName, store, exec, executor } = await makeTools(t)
  const created = await createSession(byName, exec, '他会话')
  const version = created.updatedAt
  const other = { agent: makeAgent({ id: 'session-other' }) }
  assert.equal((await byName.cron_board_edit.execute({ id: created.id, action: 'update', prompt: '越权', expectedUpdatedAt: version }, other)).code, 'job_context_mismatch')
  assert.equal((await byName.cron_board_edit.execute({ id: created.id, action: 'delete', expectedUpdatedAt: version }, other)).code, 'job_context_mismatch')
  const shell = await seedShell(store)
  assert.equal((await byName.cron_board_edit.execute({ id: shell.id, action: 'update', enabled: false, expectedUpdatedAt: shell.updatedAt }, exec)).code, 'shell_read_only')
  assert.equal((await byName.cron_board_edit.execute({ id: shell.id, action: 'delete', expectedUpdatedAt: shell.updatedAt }, exec)).code, 'shell_read_only')
  await assert.rejects(
    byName.cron_board_edit.execute({ id: shell.id, action: 'run', expectedUpdatedAt: shell.updatedAt }, exec),
    (error) => error.code === 'INVALID_ARGS',
  )
  assert.deepEqual(executor.stopCalls, [])
  assert.ok(store.jobs.get(shell.id))
})

test('S1: 停止期间看板更新任务时，模型删除失败并解除执行限制', async (t) => {
  const { byName, executor, store, exec, changes } = await makeTools(t)
  const created = await createSession(byName, exec)
  assert.equal(changes(), 1)
  executor.stopJob = async () => {
    await store.jobs.update(created.id, { name: '看板编辑' })
    return { settled: true }
  }
  const deleted = await byName.cron_board_edit.execute({ id: created.id, action: 'delete', expectedUpdatedAt: created.updatedAt }, exec)
  assert.equal(deleted.code, 'job_conflict')
  assert.equal(store.jobs.get(created.id).name, '看板编辑')
  assert.deepEqual(executor.releases, [created.id])
  assert.equal(changes(), 1)
})

test('S1: 子会话不能创建或删除任务', async (t) => {
  const { byName, store, exec, executor } = await makeTools(t)
  const created = await createSession(byName, exec)
  const delegated = { agent: makeAgent({ origin: 'subagent' }) }
  assert.equal((await createSession(byName, delegated)).code, 'subagent_session')
  assert.equal((await byName.cron_board_edit.execute({ id: created.id, action: 'delete', expectedUpdatedAt: created.updatedAt }, delegated)).code, 'subagent_session')
  assert.equal(store.jobs.list().length, 1)
  assert.deepEqual(executor.stopCalls, [])
})

test('tools:edit delete 仅删除当前调用 session 创建的任务并先停执行面', async (t) => {
  const { byName, executor, removedJobs, store, exec } = await makeTools(t)
  const created = await createSession(byName, exec, '删除')
  executor.stopSettled = false
  const refused = await byName.cron_board_edit.execute({ id: created.id, action: 'delete', expectedUpdatedAt: created.updatedAt }, exec)
  assert.equal(refused.code, 'job_not_terminated')
  assert.ok(store.jobs.get(created.id))
  executor.stopSettled = true
  const deleted = await byName.cron_board_edit.execute({ id: created.id, action: 'delete', expectedUpdatedAt: created.updatedAt }, exec)
  assert.deepEqual(deleted, { id: created.id, deleted: true })
  assert.equal(store.jobs.get(created.id), undefined)
  assert.deepEqual(removedJobs, [created.id])
  // 删除成功后也解除删除窗口的拒绝态,不残留永久 id
  assert.deepEqual(executor.releases, [created.id, created.id])
})

test('S1: 会话配额达上限后拒绝再建,0 表示不限制', async (t) => {
  const limited = await makeTools(t, { maxJobs: 2 })
  assert.ok((await createSession(limited.byName, limited.exec, '配额一')).id)
  assert.ok((await createSession(limited.byName, limited.exec, '配额二')).id)
  const refused = await createSession(limited.byName, limited.exec, '配额三')
  assert.equal(refused.code, 'quota_exceeded')
  assert.equal(limited.store.jobs.list().length, 2)
  // 删除后可再建
  const first = limited.store.jobs.list()[0]
  await limited.byName.cron_board_edit.execute({ id: first.id, action: 'delete', expectedUpdatedAt: first.updatedAt }, limited.exec)
  assert.ok((await createSession(limited.byName, limited.exec, '配额三补')).id)
  // 0 = 不限制
  const unlimited = await makeTools(t, { maxJobs: 0 })
  for (let i = 0; i < 5; i++) assert.ok((await createSession(unlimited.byName, unlimited.exec, '不限' + i)).id)
})

test('S1: 写入后立刻被取消时 create 补偿删除,不留重复任务', async (t) => {
  const { byName, store } = await makeTools(t)
  const controller = new AbortController()
  const exec = { agent: makeAgent(), signal: controller.signal }
  // 写落库后信号已中断:模拟宿主在 await 窗口内取消
  const originalCreate = store.jobs.create.bind(store.jobs)
  store.jobs.create = async (data) => {
    const row = await originalCreate(data)
    controller.abort()
    return row
  }
  await assert.rejects(() => createSession(byName, exec, '取消补偿'))
  store.jobs.create = originalCreate
  assert.equal(store.jobs.list().length, 0)
})

test('S1: 写入后立刻被取消时 update 回滚原字段', async (t) => {
  const { byName, store, exec } = await makeTools(t)
  const created = await createSession(byName, exec, '原名')
  const controller = new AbortController()
  const abortedExec = { agent: makeAgent(), signal: controller.signal }
  const originalUpdateIf = store.jobs.updateIf.bind(store.jobs)
  store.jobs.updateIf = async (...args) => {
    const outcome = await originalUpdateIf(...args)
    controller.abort()
    return outcome
  }
  await assert.rejects(() => byName.cron_board_edit.execute({ id: created.id, action: 'update', name: '改名', expectedUpdatedAt: created.updatedAt }, abortedExec))
  store.jobs.updateIf = originalUpdateIf
  assert.equal(store.jobs.get(created.id).name, '原名')
})

test('S1: 同会话并发 create 不会越过配额上限', async (t) => {
  const { byName, store, exec } = await makeTools(t, { maxJobs: 2 })
  // When 三个并发创建同时发出
  const results = await Promise.all([
    createSession(byName, exec, '并发一'),
    createSession(byName, exec, '并发二'),
    createSession(byName, exec, '并发三'),
  ])
  // Then 恰好两个成功,一个配额拒绝
  assert.equal(results.filter((row) => row.id).length, 2)
  assert.equal(results.filter((row) => row.code === 'quota_exceeded').length, 1)
  assert.equal(store.jobs.list().length, 2)
})

test('S1: 取消补偿同时还原 schedule 与 nextRunAt', async (t) => {
  const { byName, store, exec } = await makeTools(t)
  const created = await createSession(byName, exec, '改期任务')
  const before = store.jobs.get(created.id)
  const controller = new AbortController()
  const abortedExec = { agent: makeAgent(), signal: controller.signal }
  const originalUpdateIf = store.jobs.updateIf.bind(store.jobs)
  store.jobs.updateIf = async (...args) => {
    const outcome = await originalUpdateIf(...args)
    controller.abort()
    return outcome
  }
  await assert.rejects(() => byName.cron_board_edit.execute({
    id: created.id, action: 'update', schedule: '0 3 1 1 *', expectedUpdatedAt: created.updatedAt,
  }, abortedExec))
  store.jobs.updateIf = originalUpdateIf
  const after = store.jobs.get(created.id)
  assert.equal(after.schedule, before.schedule)
  assert.equal(after.nextRunAt, before.nextRunAt)
})

test('S1: 配额按会话独立,禁用任务仍计入', async (t) => {
  const limited = await makeTools(t, { maxJobs: 1 })
  assert.ok((await createSession(limited.byName, limited.exec, '停用占用', { enabled: false })).id)
  assert.equal((await createSession(limited.byName, limited.exec, '第二条')).code, 'quota_exceeded')
  // 另一个会话单独计数
  const other = { agent: makeAgent({ id: 'session-other' }) }
  assert.ok((await createSession(limited.byName, other, '他会话')).id)
})

test('S1: 补偿删除失败时留痕且不掩盖取消原因', async (t) => {
  const { byName, store } = await makeTools(t)
  const controller = new AbortController()
  const exec = { agent: makeAgent(), signal: controller.signal }
  const originalCreate = store.jobs.create.bind(store.jobs)
  const originalRemove = store.jobs.remove.bind(store.jobs)
  store.jobs.create = async (data) => {
    const row = await originalCreate(data)
    controller.abort()
    return row
  }
  store.jobs.remove = async () => { throw new Error('磁盘只读') }
  try {
    await assert.rejects(() => createSession(byName, exec, '补偿失败'), (error) => error.name === 'AbortError')
  } finally {
    store.jobs.create = originalCreate
    store.jobs.remove = originalRemove
  }
  // 补偿失败时任务仍残留(不做静默丢失),取消身份仍是 AbortError
  assert.equal(store.jobs.list().length, 1)
})
