// tools-row 测试:唯一管理员 preset 身份验证与普通会话拒绝
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { registerToolRow } from '../lib/tools-row.mjs'

function makeCtx(runtime) {
  const registered = []
  const guards = []
  const ctx = {
    get(name) { return name === 'bossSimulatorControl' ? runtime : undefined },
    tools: {
      register(definition) {
        registered.push(definition)
        return () => {}
      },
      guard(fn) {
        guards.push(fn)
        return () => {}
      },
    },
  }
  return { ctx, registered, guards }
}

function makeStore() {
  const aggregates = new Map()
  return {
    async loadAggregate(id) { return aggregates.get(id) },
    async saveAggregate(agg) { aggregates.set(agg.taskId, agg); return agg },
    async updateAggregate(id, fn) { const n = fn(aggregates.get(id)); aggregates.set(id, n); return n },
    async deleteAggregate(id) { aggregates.delete(id); return true },
    records: aggregates,
    loadControl: async () => ({ globalStopped: false, globalStopGeneration: 0, taskAllows: {} }),
    updateControl: async (fn) => fn({ globalStopped: false, globalStopGeneration: 0, taskAllows: {} }),
  }
}

// 控制运行时由控制室经 ctx 服务发布;工具行在使用点取
function runtime(store) { return { store, now: () => 0 } }

function executionFor(presetId, headerId = presetId) {
  const ctx = { get: (name) => name === 'agentPresets' ? { composedPreset: (scope) => scope === ctx ? presetId : undefined } : undefined }
  return { agent: { ctx, session: { header: { agentPreset: headerId } } } }
}
const adminExecution = executionFor('boss-simulator-admin')
const strangerExecution = executionFor('other-preset')
const standardExecution = executionFor('standard')
const prefixImpostorExecution = executionFor('boss-simulator-admin-rogue')

test('普通标准会话和其他预设调用工具均被拒绝', async () => {
  const store = makeStore()
  const { ctx, registered } = makeCtx(runtime(store))
  registerToolRow(ctx)
  const tool = registered.find((definition) => definition.name === 'boss_simulator')
  const params = { tool: 'boss_simulator_create_task', args: { taskId: 't1', title: 't', projectWorkspaceId: 'w', definition: { goal: 'g' } } }
  await assert.rejects(() => tool.execute(params, standardExecution), /管理员工作台/)
  await assert.rejects(() => tool.execute(params, strangerExecution), /管理员工作台/)
})

test('管理员可以操作管理任务', async () => {
  const store = makeStore()
  const { ctx, registered } = makeCtx(runtime(store))
  registerToolRow(ctx)
  const result = await registered.find((d) => d.name === 'boss_simulator').execute({ tool: 'boss_simulator_create_task', args: { taskId: 't1', title: 't', projectWorkspaceId: 'w', definition: { goal: 'g' } } }, adminExecution)
  assert.equal(result.ok, true)
})

test('管理员工具面不提供直接写报告入口', async () => {
  const store = makeStore()
  const { ctx, registered } = makeCtx(runtime(store))
  registerToolRow(ctx)
  const tool = registered.find((definition) => definition.name === 'boss_simulator')
  await assert.rejects(
    () => tool.execute({ tool: 'boss_simulator_report_result', args: {} }, adminExecution),
    /无权调用/,
  )
})

test('子会话继承管理员预设也不得调用管理工具', async () => {
  const store = makeStore()
  const { ctx, registered, guards } = makeCtx(runtime(store))
  registerToolRow(ctx)
  const tool = registered.find((definition) => definition.name === 'boss_simulator')
  const params = { tool: 'boss_simulator_create_task', args: { taskId: 't1', title: 't', projectWorkspaceId: 'w', definition: { goal: 'g' } } }
  // Given 子会话:宿主把父会话预设写进 child agentPreset,preset 判定会误放行
  for (const header of [
    { agentPreset: 'boss-simulator-admin', origin: 'subagent', parentSession: 'root', delegationDepth: 1 },
    { agentPreset: 'boss-simulator-admin', parentSession: 'root', delegationDepth: 2 },
    { agentPreset: 'boss-simulator-admin', origin: 'subagent', parentSession: 'root' },
  ]) {
    const execution = executionFor('boss-simulator-admin')
    execution.agent.session.header = header
    await assert.rejects(() => tool.execute(params, execution), /子会话/)
    assert.match(guards[0]({ name: 'boss_simulator', ...execution }), /子会话/)
  }
  // Then 普通 fork(depth 0)仍按预设判定,不误伤
  const fork = executionFor('boss-simulator-admin')
  fork.agent.session.header = { agentPreset: 'boss-simulator-admin', parentSession: 'root', delegationDepth: 0 }
  assert.equal(guards[0]({ name: 'boss_simulator', ...fork }), undefined)
})

test('guard 对非管理员会话拒绝公司管理工具', () => {
  const store = makeStore()
  const { ctx, guards } = makeCtx(runtime(store))
  registerToolRow(ctx)
  assert.match(guards[0]({ name: 'boss_simulator', ...strangerExecution }), /仅限管理员工作台/)
  assert.match(guards[0]({ name: 'boss_simulator', ...standardExecution }), /仅限管理员工作台/)
  assert.equal(guards[0]({ name: 'boss_simulator', ...adminExecution }), undefined)
  assert.equal(guards[0]({ name: 'other_tool', ...strangerExecution }), undefined)
})

test('普通会话伪造 arguments.agentPreset 不获得角色', async () => {
  const store = makeStore()
  const { ctx, registered } = makeCtx(runtime(store))
  registerToolRow(ctx)
  const forged = { ...strangerExecution, arguments: { args: { agentPreset: 'boss-simulator-admin' } } }
  await assert.rejects(() => registered[0].execute({ tool: 'boss_simulator_create_task', args: { taskId: 'forged', title: '伪造', projectWorkspaceId: 'w', definition: { goal: 'g' } } }, forged), /管理员工作台/)
})

test('当前预设组合而非 header 决定管理员工具访问', async () => {
  const store = makeStore()
  const { ctx, registered } = makeCtx(runtime(store))
  registerToolRow(ctx)
  const tool = registered[0]
  const params = { tool: 'boss_simulator_create_task', args: { taskId: 'current', title: '当前', projectWorkspaceId: 'w', definition: { goal: 'g' } } }
  assert.equal((await tool.execute(params, executionFor('boss-simulator-admin', 'standard'))).ok, true)
  await assert.rejects(() => tool.execute(params, executionFor('standard', 'boss-simulator-admin')), /管理员工作台/)
  await assert.rejects(() => tool.execute(params, executionFor('boss-simulator-admin-rogue')), /管理员工作台/)
})

test('相似名称的其他预设不能冒充公司管理入口', async () => {
  const store = makeStore()
  const { ctx, registered } = makeCtx(runtime(store))
  registerToolRow(ctx)
  await assert.rejects(
    () => registered.find((d) => d.name === 'boss_simulator').execute({ tool: 'boss_simulator_create_task', args: { taskId: 't1', title: 't', projectWorkspaceId: 'w', definition: { goal: 'g' } } }, prefixImpostorExecution),
    /管理员工作台/,
  )
})

test('Given 控制室未启动 When 装配工具行 Then 不注册工具(干净禁用)', () => {
  const registered = []
  const ctx = { get: () => undefined, tools: { register: (definition) => { registered.push(definition); return () => {} }, guard: () => () => {} } }
  const dispose = registerToolRow(ctx)
  assert.deepEqual(registered, [])
  dispose()
})

test('Given 控制室已卸载 When 调用工具 Then 报告未启动且不触碰旧运行时', async () => {
  let current = runtime(makeStore())
  const registered = []
  const ctx = {
    get: (name) => (name === 'bossSimulatorControl' ? current : undefined),
    tools: { register: (definition) => { registered.push(definition); return () => {} }, guard: () => () => {} },
  }
  registerToolRow(ctx)
  const tool = registered[0]
  const params = { tool: 'boss_simulator_create_task', args: { taskId: 't1', title: 't', projectWorkspaceId: 'w', definition: { goal: 'g' } } }
  assert.equal((await tool.execute(params, adminExecution)).ok, true)
  // 控制室卸载:服务随 fiber 撤销
  current = undefined
  await assert.rejects(() => tool.execute(params, adminExecution), /控制室未启动/)
  // 控制室重载:工具行转用新运行时,而不是装配时缓存的旧 store
  const reloaded = makeStore()
  current = runtime(reloaded)
  const created = await tool.execute({ tool: 'boss_simulator_create_task', args: { taskId: 't2', title: '重载后', projectWorkspaceId: 'w', definition: { goal: 'g' } } }, adminExecution)
  assert.equal(created.ok, true)
  assert.ok(await reloaded.loadAggregate('t2'))
})

test('Given 未核清 Run When 管理员删除任务 Then 显式确认后才删且拒绝在飞执行', async () => {
  const store = makeStore()
  const { ctx, registered } = makeCtx(runtime(store))
  registerToolRow(ctx)
  const tool = registered[0]
  const created = await tool.execute({ tool: 'boss_simulator_create_task', args: { taskId: 't1', title: 't', projectWorkspaceId: 'w', definition: { goal: 'g' } } }, adminExecution)
  assert.equal(created.ok, true)
  await assert.rejects(() => tool.execute({ tool: 'boss_simulator_delete_task', args: { taskId: 't1' } }, adminExecution), /显式确认/)
  const aggregate = await store.loadAggregate('t1')
  store.records.set('t1', { ...aggregate, runs: { r1: { runId: 'r1', workItemId: 'w1', state: 'running', sessionId: 's1' } } })
  await assert.rejects(() => tool.execute({ tool: 'boss_simulator_delete_task', args: { taskId: 't1', confirm: 'delete' } }, adminExecution), /未核清 Run/)
  store.records.set('t1', { ...aggregate, runs: { r1: { runId: 'r1', workItemId: 'w1', state: 'interrupted', sessionId: 's1' } } })
  const removed = await tool.execute({ tool: 'boss_simulator_delete_task', args: { taskId: 't1', confirm: 'delete' } }, adminExecution)
  assert.deepEqual([removed.ok, removed.deleted], [true, true])
  assert.equal(await store.loadAggregate('t1'), undefined)
})
