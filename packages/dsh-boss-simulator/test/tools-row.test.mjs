// tools-row 测试:唯一管理员 preset 身份验证与普通会话拒绝
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { registerToolRow } from '../lib/tools-row.mjs'

function makeCtx() {
  const registered = []
  const guards = []
  const ctx = {
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
    loadControl: async () => ({ globalStopped: false, globalStopGeneration: 0, taskAllows: {} }),
    updateControl: async (fn) => fn({ globalStopped: false, globalStopGeneration: 0, taskAllows: {} }),
  }
}

function executionFor(presetId, headerId = presetId) {
  const ctx = { get: (name) => name === 'agentPresets' ? { composedPreset: (scope) => scope === ctx ? presetId : undefined } : undefined }
  return { agent: { ctx, session: { header: { agentPreset: headerId } } } }
}
const adminExecution = executionFor('boss-simulator-admin')
const strangerExecution = executionFor('other-preset')
const standardExecution = executionFor('standard')
const prefixImpostorExecution = executionFor('boss-simulator-admin-rogue')

test('普通标准会话和其他预设调用工具均被拒绝', async () => {
  const { ctx, registered } = makeCtx()
  registerToolRow(ctx, { store: makeStore(), now: () => 0 })
  const tool = registered.find((definition) => definition.name === 'boss_simulator')
  const params = { tool: 'boss_simulator_create_task', args: { taskId: 't1', title: 't', projectWorkspaceId: 'w', definition: { goal: 'g' } } }
  await assert.rejects(() => tool.execute(params, standardExecution), /管理员工作台/)
  await assert.rejects(() => tool.execute(params, strangerExecution), /管理员工作台/)
})

test('管理员可以操作管理任务', async () => {
  const { ctx, registered } = makeCtx()
  registerToolRow(ctx, { store: makeStore(), now: () => 0 })
  const result = await registered.find((d) => d.name === 'boss_simulator').execute({ tool: 'boss_simulator_create_task', args: { taskId: 't1', title: 't', projectWorkspaceId: 'w', definition: { goal: 'g' } } }, adminExecution)
  assert.equal(result.ok, true)
})

test('管理员工具面不提供直接写报告入口', async () => {
  const { ctx, registered } = makeCtx()
  registerToolRow(ctx, { store: makeStore(), now: () => 0 })
  const tool = registered.find((definition) => definition.name === 'boss_simulator')
  await assert.rejects(
    () => tool.execute({ tool: 'boss_simulator_report_result', args: {} }, adminExecution),
    /无权调用/,
  )
})

test('guard 对非管理员会话拒绝公司管理工具', () => {
  const { ctx, guards } = makeCtx()
  registerToolRow(ctx, { store: makeStore(), now: () => 0 })
  assert.match(guards[0]({ name: 'boss_simulator', ...strangerExecution }), /仅限管理员工作台/)
  assert.match(guards[0]({ name: 'boss_simulator', ...standardExecution }), /仅限管理员工作台/)
  assert.equal(guards[0]({ name: 'boss_simulator', ...adminExecution }), undefined)
  assert.equal(guards[0]({ name: 'other_tool', ...strangerExecution }), undefined)
})

test('普通会话伪造 arguments.agentPreset 不获得角色', async () => {
  const { ctx, registered } = makeCtx()
  registerToolRow(ctx, { store: makeStore(), now: () => 0 })
  const forged = { ...strangerExecution, arguments: { args: { agentPreset: 'boss-simulator-admin' } } }
  await assert.rejects(() => registered[0].execute({ tool: 'boss_simulator_create_task', args: { taskId: 'forged', title: '伪造', projectWorkspaceId: 'w', definition: { goal: 'g' } } }, forged), /管理员工作台/)
})

test('当前预设组合而非 header 决定管理员工具访问', async () => {
  const { ctx, registered } = makeCtx()
  registerToolRow(ctx, { store: makeStore(), now: () => 0 })
  const tool = registered[0]
  const params = { tool: 'boss_simulator_create_task', args: { taskId: 'current', title: '当前', projectWorkspaceId: 'w', definition: { goal: 'g' } } }
  assert.equal((await tool.execute(params, executionFor('boss-simulator-admin', 'standard'))).ok, true)
  await assert.rejects(() => tool.execute(params, executionFor('standard', 'boss-simulator-admin')), /管理员工作台/)
  await assert.rejects(() => tool.execute(params, executionFor('boss-simulator-admin-rogue')), /管理员工作台/)
})

test('相似名称的其他预设不能冒充公司管理入口', async () => {
  const { ctx, registered } = makeCtx()
  registerToolRow(ctx, { store: makeStore(), now: () => 0 })
  await assert.rejects(
    () => registered.find((d) => d.name === 'boss_simulator').execute({ tool: 'boss_simulator_create_task', args: { taskId: 't1', title: 't', projectWorkspaceId: 'w', definition: { goal: 'g' } } }, prefixImpostorExecution),
    /管理员工作台/,
  )
})
