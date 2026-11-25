// 覆盖模式 BDD:真实宿主 scope 语义下验证同名工具遮蔽与撤销恢复,以及转调 schedule 服务。
// 用真实 Context/ToolRuntime/SystemPrompt(与 boss-simulator 隔离用例同构),不 mock 作用域。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import { createScope } from '@deepseek-ai/dsh-scope'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'

import { registerOverlayTools, createOverlayManager, OVERLAY_TOOL_NAMES } from '../src/tools-overlay.mjs'

function makeHost() {
  const root = new Context()
  new SystemPrompt(root, {})
  new ToolRuntime(root, {})
  if (typeof root.tools.setExecutor === 'function') {
    root.tools.setExecutor({
      sections: [],
      describe: (definitions) => ({
        schemas: definitions.map((definition) => ({
          name: definition.name,
          description: definition.description,
          parameters: definition.parameters,
        })),
      }),
    })
  }
  return root
}

function makeSchedule() {
  const calls = []
  return {
    calls,
    async create(input, actor) { calls.push({ op: 'create', input, actor }); return { id: 't1', kind: 'rrule', ...input } },
    async list(query) { calls.push({ op: 'list', query }); return { items: [], shown: 0, total: 0, limit: 50, offset: 0 } },
    async view({ id }) { calls.push({ op: 'view', id }); return { id, kind: 'rrule' } },
    async edit(input, actor) { calls.push({ op: 'edit', input, actor }); return { id: input.id, kind: 'rrule' } },
  }
}

function makeAgent(root, { depth = 0 } = {}) {
  // 作用域键就是 agent 对象(宿主 createScope(loopCtx, agent) 的键语义)
  const agent = { delegationDepth: depth, session: { id: 's1', header: { cwd: 'C:/work' } } }
  agent.ctx = createScope(root, agent).ctx
  return { agent, key: agent }
}

async function visibleNames(root, scopeKey) {
  return (await root.systemPrompt.assemble({ scope: scopeKey })).tools.map((tool) => tool.name).sort()
}

test('overlay:agent 作用域同名工具遮蔽官方定义,撤销后官方恢复', async (t) => {
  const root = makeHost()
  t.after(() => root.fiber.dispose())
  // Given 官方工具在全局层(模拟 preset/官方行注册)
  const globalDispose = root.tools.register({
    name: 'schedule_create', description: 'official', parameters: {},
    output: { schema: { type: 'object', additionalProperties: true, properties: {} }, render: () => [] },
  })
  const { agent, key } = makeAgent(root)
  assert.deepEqual(await visibleNames(root, key), ['schedule_create'])
  // When 覆盖注册
  const dispose = registerOverlayTools(agent, makeSchedule())
  assert.ok(dispose)
  // Then agent 层看到四个覆盖工具
  const covered = await visibleNames(root, key)
  assert.deepEqual(covered, [...OVERLAY_TOOL_NAMES].sort())
  // When 撤销
  dispose()
  // Then 官方工具恢复
  assert.deepEqual(await visibleNames(root, key), ['schedule_create'])
  globalDispose()
})

test('overlay:create 转调 schedule.create,this_session 投递本会话', async (t) => {
  const root = makeHost()
  t.after(() => root.fiber.dispose())
  const schedule = makeSchedule()
  const { agent, key } = makeAgent(root)
  const dispose = registerOverlayTools(agent, schedule)
  t.after(() => dispose())
  const definition = root.tools.get('schedule_create', key)
  assert.ok(definition)
  const result = await definition.execute({
    title: 'x', prompt: 'p', rrule: 'DTSTART:20260101T000000Z\nRRULE:FREQ=DAILY;COUNT=1', target: 'this_session',
  }, { agent })
  assert.equal(result.id, 't1')
  assert.deepEqual(schedule.calls[0].input.target, { kind: 'session', sessionId: 's1' })
  assert.equal(schedule.calls[0].actor, 's1')
})

test('overlay:子代理被拒绝,delete 携带额外字段与空更新返回 invalid_selector', async (t) => {
  const root = makeHost()
  t.after(() => root.fiber.dispose())
  const { agent, key } = makeAgent(root, { depth: 2 })
  const schedule = makeSchedule()
  t.after(registerOverlayTools(agent, schedule))
  const create = root.tools.get('schedule_create', key)
  const refused = await create.execute({ title: 'x', prompt: 'p', rrule: 'r', target: 'new' }, { agent })
  assert.equal(refused.code, 'subagent_session')
  // Given 正常调用者
  const normal = makeAgent(root)
  t.after(registerOverlayTools(normal.agent, schedule))
  const edit = root.tools.get('schedule_edit', normal.key)
  const bad = await edit.execute({ id: 't1', action: 'delete', title: 'x' }, { agent: normal.agent })
  assert.equal(bad.code, 'invalid_selector')
  const empty = await edit.execute({ id: 't1', action: 'update' }, { agent: normal.agent })
  assert.equal(empty.code, 'invalid_selector')
})

test('overlay:manager 按开关挂载/撤销已有 agent,关闭后不留注册', async (t) => {
  const root = makeHost()
  t.after(() => root.fiber.dispose())
  const { agent, key } = makeAgent(root)
  const schedule = makeSchedule()
  const listeners = []
  const ctx = {
    get(name) { return name === 'agents' ? { list: () => [agent] } : undefined },
    on(event, fn) {
      listeners.push({ event, fn })
      return () => {
        const index = listeners.findIndex((listener) => listener.fn === fn)
        if (index >= 0) listeners.splice(index, 1)
      }
    },
  }
  let enabled = true
  const manager = createOverlayManager(ctx, { readEnabled: () => enabled, getSchedule: () => schedule })
  t.after(() => manager.dispose())
  manager.reconcile()
  assert.equal(manager.mounted.size, 1)
  assert.deepEqual(await visibleNames(root, key), [...OVERLAY_TOOL_NAMES].sort())
  // When 关闭
  enabled = false
  manager.reconcile()
  assert.equal(manager.mounted.size, 0)
  assert.deepEqual(await visibleNames(root, key), [])
  // When 打开后新 agent 经事件挂载
  enabled = true
  manager.reconcile()
  const created = makeAgent(root)
  listeners.find((listener) => listener.event === 'agent/created').fn({ agent: created.agent })
  assert.equal(manager.mounted.size, 2)
  assert.deepEqual(await visibleNames(root, created.key), [...OVERLAY_TOOL_NAMES].sort())
})
