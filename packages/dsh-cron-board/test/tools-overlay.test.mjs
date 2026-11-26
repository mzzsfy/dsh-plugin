import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import { bindScopeParent, createScope } from '@deepseek-ai/dsh-scope'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'

import { createOverlayManager } from '../src/tools-overlay.mjs'

function fixture(t) {
  const root = new Context()
  new SystemPrompt(root, {})
  new ToolRuntime(root, {})
  t.after(() => root.fiber.dispose())
  const presetKey = {}
  const preset = createScope(root, presetKey)
  const original = {}
  const calls = []
  const register = (operation, title, value) => {
    const name = 'schedule_' + operation
    const execute = async (args, exec) => {
      calls.push({ operation, args, exec })
      return value
    }
    const definition = {
      name,
      description: title + '.',
      parameters: { type: 'object', properties: {} },
      output: { schema: { type: 'object', additionalProperties: true, properties: {} }, render: () => [] },
      presentCall: () => ({ card: 'generic', title }),
      execute,
    }
    original[operation] = { definition, execute }
    return preset.ctx.tools.register(definition)
  }
  const nextTask = { id: 't1', kind: 'rrule', scheduledAtLocal: '2099-01-01T08:00:00+08:00' }
  register('create', 'Create a scheduled task', nextTask)
  register('list', 'List scheduled tasks', { items: [nextTask] })
  register('view', 'View one scheduled task', nextTask)
  register('edit', 'Update, pause, resume, or delete one scheduled task', { code: 'schedule_conflict' })
  const agents = []
  const makeAgent = (withSchedule = true) => {
    const agent = {}
    agent.ctx = createScope(root, agent).ctx
    if (withSchedule) agent.presetBinding = bindScopeParent(agent, presetKey)
    agents.push(agent)
    return agent
  }
  let enabled = false
  let changes = 0
  const manager = createOverlayManager(root, {
    readEnabled: () => enabled, listAgents: () => agents,
    notifyChange: () => { changes++ },
  })
  t.after(manager.dispose)
  return {
    root, original, calls, makeAgent, manager, presetKey,
    get changes() { return changes },
    setEnabled(value) { enabled = value; manager.reconcile() },
  }
}

test('S2: 覆盖保留官方工具输入输出及展示契约，关闭时撤销执行包装', async (t) => {
  const f = fixture(t)
  const agent = f.makeAgent()
  const { definition, execute } = f.original.create
  const args = { title: '测试任务' }
  const exec = { agent, signal: new AbortController().signal }
  assert.equal(f.root.tools.get('schedule_create', agent).execute, execute)
  f.setEnabled(true)
  const wrapped = f.root.tools.get('schedule_create', agent)
  assert.equal(wrapped, definition)
  assert.notEqual(wrapped.execute, execute)
  assert.deepEqual(await wrapped.execute(args, exec), {
    id: 't1', kind: 'rrule', scheduledAtLocal: '2099-01-01T08:00:00+08:00',
  })
  assert.deepEqual(f.calls, [{ operation: 'create', args, exec }])
  assert.equal(f.changes, 1)
  await f.root.tools.get('schedule_list', agent).execute({}, exec)
  await f.root.tools.get('schedule_edit', agent).execute({}, exec)
  assert.equal(f.changes, 1, '查询和未落库的编辑不发布变更')
  f.setEnabled(false)
  assert.equal(f.root.tools.get('schedule_create', agent).execute, execute)
})

test('S2: 无官方工具的预设与被限制的 agent 不获得额外工具', (t) => {
  const f = fixture(t)
  const normal = f.makeAgent()
  const restricted = f.makeAgent()
  const minimal = f.makeAgent(false)
  f.setEnabled(true)
  restricted.ctx.tools.restrict({ deny: ['schedule_create'] })
  assert.equal(f.root.tools.get('schedule_create', minimal), undefined)
  assert.equal(f.root.tools.get('schedule_create', restricted), undefined)
  assert.notEqual(f.root.tools.get('schedule_create', normal).execute, f.original.create.execute)
  f.manager.dispose()
  assert.equal(f.root.tools.get('schedule_create', normal).execute, f.original.create.execute)
})

test('S2: 仅同名的第三方工具保持原执行函数', (t) => {
  const f = fixture(t)
  const agent = f.makeAgent(false)
  const execute = async () => ({ items: [] })
  agent.ctx.tools.register({
    name: 'schedule_list', description: 'List external tasks.', parameters: {},
    output: { schema: { type: 'object', additionalProperties: true, properties: {} }, render: () => [] },
    execute,
  })
  f.setEnabled(true)
  assert.equal(f.root.tools.get('schedule_list', agent).execute, execute)
})

test('S2: 其他插件替换执行入口后，后续对账不重新包装', (t) => {
  const f = fixture(t)
  f.makeAgent()
  f.setEnabled(true)
  const { definition } = f.original.create
  const replacement = async () => ({ id: 'replacement' })
  definition.execute = replacement
  f.manager.reconcile()
  f.manager.reconcile()
  assert.equal(definition.execute, replacement)
  f.setEnabled(false)
  assert.equal(definition.execute, replacement)
})

test('S2: 其他插件恢复原执行入口后重新接管', (t) => {
  const f = fixture(t)
  f.makeAgent()
  f.setEnabled(true)
  const { definition, execute } = f.original.create
  const wrapped = definition.execute
  definition.execute = async () => ({ id: 'replacement' })
  f.manager.reconcile()
  definition.execute = execute
  f.manager.reconcile()
  assert.notEqual(definition.execute, execute)
  assert.notEqual(definition.execute, wrapped)
})

test('S2: 对账抛错不外泄到宿主事件', (t) => {
  const warnings = []
  const root = new Context()
  new SystemPrompt(root, {})
  new ToolRuntime(root, {})
  t.after(() => root.fiber.dispose())
  let explode = false
  const manager = createOverlayManager(root, {
    readEnabled: () => true,
    listAgents: () => { if (explode) throw new Error('agents 不可用'); return [] },
    notifyChange: () => {},
    logger: { warn: (message) => warnings.push(message) },
  })
  t.after(manager.dispose)
  explode = true
  assert.doesNotThrow(() => root.emit('tools/change'))
  assert.doesNotThrow(() => root.emit('agent/created', { agent: {} }))
  assert.equal(warnings.length, 2)
  assert.match(warnings[0], /自动化工具对账失败/)
})

test('S2: 切换预设后仅包装仍可见的官方定义', (t) => {
  const f = fixture(t)
  const agent = f.makeAgent()
  const { definition, execute } = f.original.create
  f.setEnabled(true)
  assert.notEqual(definition.execute, execute)
  agent.presetBinding.rebind({})
  f.root.emit('tools/change')
  assert.equal(f.root.tools.get('schedule_create', agent), undefined)
  assert.equal(definition.execute, execute)
  agent.presetBinding.rebind(f.presetKey)
  f.root.emit('tools/change')
  assert.notEqual(definition.execute, execute)
})

test('S2: 开启后发现新 agent，销毁后撤销无人使用的包装', (t) => {
  const f = fixture(t)
  f.setEnabled(true)
  const { definition, execute } = f.original.list
  const agent = f.makeAgent()
  f.root.emit('agent/created', { agent })
  assert.notEqual(definition.execute, execute)
  f.root.emit('agent/disposed', { agent })
  assert.equal(definition.execute, execute)
})

test('S2: 诊断现场记录开关、agent 数与命中数,失效态只告警一次', (t) => {
  const warnings = []
  const root = new Context()
  new SystemPrompt(root, {})
  new ToolRuntime(root, {})
  t.after(() => root.fiber.dispose())
  let enabled = false
  const agents = []
  const manager = createOverlayManager(root, {
    readEnabled: () => enabled,
    listAgents: () => agents,
    notifyChange: () => {},
    logger: { warn: (message) => warnings.push(message) },
  })
  t.after(manager.dispose)
  // 关闭态与「开启但无 agent」必须可区分,否则卡片无法定位原因
  manager.reconcile()
  assert.deepEqual(manager.debug, { enabled: false, agents: 0, wanted: 0, error: null })
  enabled = true
  manager.reconcile()
  assert.deepEqual(manager.debug, { enabled: true, agents: 0, wanted: 0, error: null })
  assert.deepEqual(warnings, [])
  // 有 agent 但宿主工具表里没有官方定义:告警一次,重复对账不再刷
  agents.push({ ctx: createScope(root, {}).ctx })
  manager.reconcile()
  assert.deepEqual(manager.debug, { enabled: true, agents: 1, wanted: 0, error: null })
  assert.equal(warnings.length, 1)
  manager.reconcile()
  manager.reconcile()
  assert.equal(warnings.length, 1)
})
