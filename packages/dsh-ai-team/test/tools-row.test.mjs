// tools-row 测试:受管角色解析(预设 id→角色)与未受管拒绝,安全边界直测
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

const adminExecution = { agent: { agentPreset: { id: 'ai-team-admin' } } }
const strangerExecution = { agent: { agentPreset: { id: 'other-preset' } } }
const workerExecution = { agent: { agentPreset: { id: 'ai-team-worker' } } }
const prefixImpostorExecution = { agent: { agentPreset: { id: 'ai-team-worker-rogue' } } }

test('未受管预设调用业务工具被拒绝', async () => {
  const { ctx, registered } = makeCtx()
  registerToolRow(ctx, { store: makeStore(), now: () => 0 })
  await assert.rejects(
    () => registered.find((d) => d.name === 'ai_team').execute({ tool: 'ai_team_create_task', args: { taskId: 't1', title: 't', projectWorkspaceId: 'w', definition: { goal: 'g' } } }, strangerExecution),
    /未受管/,
  )
})

test('管理员前缀映射为 admin 角色并可创建任务', async () => {
  const { ctx, registered } = makeCtx()
  registerToolRow(ctx, { store: makeStore(), now: () => 0 })
  const result = await registered.find((d) => d.name === 'ai_team').execute({ tool: 'ai_team_create_task', args: { taskId: 't1', title: 't', projectWorkspaceId: 'w', definition: { goal: 'g' } } }, adminExecution)
  assert.equal(result.ok, true)
})

test('worker 前缀映射为 worker 角色:可报告,不可派发', async () => {
  const { ctx, registered } = makeCtx()
  registerToolRow(ctx, { store: makeStore(), now: () => 0 })
  await registered.find((d) => d.name === 'ai_team').execute({ tool: 'ai_team_create_task', args: { taskId: 't1', title: 't', projectWorkspaceId: 'w', definition: { goal: 'g' } } }, adminExecution)
  await assert.rejects(
    () => registered.find((d) => d.name === 'ai_team').execute({ tool: 'ai_team_dispatch', args: { taskId: 't1', workItemId: 'w1' } }, workerExecution),
    /角色 worker 无权/,
  )
})

test('guard 对未受管会话的本工具调用给出拒绝理由', () => {
  const { ctx, guards } = makeCtx()
  registerToolRow(ctx, { store: makeStore(), now: () => 0 })
  assert.match(guards[0]({ name: 'ai_team', ...strangerExecution }), /仅限受管/)
  assert.equal(guards[0]({ name: 'ai_team', ...adminExecution }), undefined)
  assert.equal(guards[0]({ name: 'other_tool', ...strangerExecution }), undefined)
})

test('同名前缀 impostor 预设不获得角色', async () => {
  const { ctx, registered } = makeCtx()
  registerToolRow(ctx, { store: makeStore(), now: () => 0 })
  await assert.rejects(
    () => registered.find((d) => d.name === 'ai_team').execute({ tool: 'ai_team_create_task', args: { taskId: 't1', title: 't', projectWorkspaceId: 'w', definition: { goal: 'g' } } }, prefixImpostorExecution),
    /未受管/,
  )
})
