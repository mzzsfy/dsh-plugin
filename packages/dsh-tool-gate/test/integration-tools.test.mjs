// 集成测试:真 cordis + dsh-tools + dsh-system-prompt,锁定官方 deferLoading
// 投影行为(SC-10):deferred 工具的 schema 产物带 deferLoading、白名单内不带、
// 可见性不变(defer 不改 view().visible,只改声明形态)。同时覆盖真 cordis
// 行挂载下的行模块(apply/Config)装载与本包收敛链路。

import test from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import { createScope } from '@deepseek-ai/dsh-scope'
import { SystemPrompt } from '@deepseek-ai/dsh-system-prompt'
import { ToolRuntime, defineTool } from '@deepseek-ai/dsh-tools'
import * as row from '../src/index.js'

function makeTool(name) {
  return defineTool({
    name,
    description: `${name} fixture`,
    parameters: {},
    output: { schema: { type: 'object', properties: {}, additionalProperties: false }, render: () => [{ type: 'text', text: name }] },
    async execute() {
      return {}
    },
  })
}

async function boot(toolNames, allowlist) {
  const root = new Context()
  await root.plugin(SystemPrompt)
  await root.plugin(ToolRuntime)
  const registered = new Map()
  for (const name of toolNames) {
    const definition = makeTool(name)
    root.tools.register(definition)
    registered.set(name, definition)
  }
  const fiber = await root.plugin(row, { allowlist })
  if (fiber?.state !== 2) {
    throw new Error(`tool-gate 行未激活 state=${fiber?.state}`)
  }
  return { root, registered, fiber }
}

test('SC-10 官方投影:deferred 带标,白名单内不带,可见性不变', async () => {
  const { root, registered } = await boot(['read', 'web_search'], ['read'])
  assert.equal(registered.get('web_search').deferLoading, true)
  assert.equal('deferLoading' in registered.get('read'), false)

  const schemaOf = (name) => root.tools.schemaOf(registered.get(name), false)
  assert.equal(schemaOf('web_search').deferLoading, true)
  assert.equal(schemaOf('read').deferLoading, undefined)

  assert.ok(root.tools.get('web_search'))
  assert.ok(root.tools.get('read'))

  const wire = root.tools.wireSchemas(undefined)
  assert.deepEqual([...wire.knownNames].sort(), ['read', 'tool_search', 'web_search'])
  assert.ok(wire.schemas.some((schema) => schema.name === 'web_search' && schema.deferLoading === true))
})

test('行模块在真 cordis 下装载并按 Config 收敛', async () => {
  const { root, registered } = await boot(['read', 'web_search', 'todo_write'], ['read'])
  assert.equal(registered.get('web_search').deferLoading, true)
  assert.equal(registered.get('todo_write').deferLoading, true)
  assert.equal('deferLoading' in registered.get('read'), false)
})

test('SC-6 行退场还原:真 cordis dispose 后回到原状', async () => {
  const { root, registered, fiber } = await boot(['read', 'web_search'], ['read'])
  assert.equal(registered.get('web_search').deferLoading, true)
  await fiber.dispose()
  assert.equal('deferLoading' in registered.get('web_search'), false)
  void root
})

test('SC-5 真宿主重注册:tools/change 驱动重收敛', async () => {
  const { root, registered } = await boot(['read'], ['read'])
  const replacement = makeTool('web_search')
  root.tools.register(replacement)
  assert.equal(replacement.deferLoading, true)
})

test('SC-22 真宿主:tool_search 注册于全局层,收敛不打标,退场注销', async () => {
  const { root, fiber } = await boot(['read', 'web_search'], ['read'])
  const definition = root.tools.get('tool_search')
  assert.ok(definition, 'tool_search 应注册于全局层')
  assert.equal('deferLoading' in definition, false)
  const executed = await definition.execute({ pattern: '^web' }, {})
  assert.ok(executed.text.includes('web_search'))
  assert.equal(executed.count, 1)
  await fiber.dispose()
  assert.ok(!root.tools.get('tool_search'), '行退场后 tool_search 应注销')
})

async function bootScopes(t) {
  const fixture = await boot(['read', 'global_hidden', 'shadowed'], ['read'])
  const preset = {}
  const agentA = {}
  const agentB = {}
  const presetScope = createScope(fixture.root, preset)
  const scopeA = createScope(fixture.root, agentA, { parent: preset })
  const scopeB = createScope(fixture.root, agentB)
  await presetScope.ctx.inject(['tools'], (ctx) => ctx.tools.register(makeTool('inherited')))
  await scopeA.ctx.inject(['tools'], (ctx) => {
    ctx.tools.register(makeTool('only_a'))
    const shadow = makeTool('shadowed')
    shadow.description = 'A scope definition'
    ctx.tools.register(shadow)
    ctx.tools.restrict({ deny: ['global_hidden'] })
  })
  await scopeB.ctx.inject(['tools'], (ctx) => ctx.tools.register(makeTool('only_b')))
  t.after(async () => {
    await scopeB.dispose()
    await scopeA.dispose()
    await presetScope.dispose()
    await fixture.fiber.dispose()
    await fixture.root.registry.delete(ToolRuntime)
    await fixture.root.registry.delete(SystemPrompt)
  })
  const search = (agent, pattern = '.') => fixture.root.tools.get('tool_search', agent).execute({ pattern }, { agent })
  return { ...fixture, agentA, agentB, search }
}

// Given 两个会话各有私有工具；When 各自搜索；Then 结果只含调用方可见定义。
test('SC-23 tool_search 隔离兄弟会话并遵守继承与 restrict', async (t) => {
  const { agentA, agentB, search } = await bootScopes(t)
  const names = (result) => result.text.match(/^### (.+)$/gm)?.map((line) => line.slice(4)).sort() ?? []
  assert.deepEqual(names(await search(agentA)), ['inherited', 'only_a', 'read', 'shadowed'])
  assert.deepEqual(names(await search(agentB)), ['global_hidden', 'only_b', 'read', 'shadowed'])
  assert.deepEqual(names(await search(undefined)), ['global_hidden', 'read', 'shadowed'])
})

// Given 局部定义遮蔽全局同名；When 搜索；Then 返回实际执行的局部定义。
test('SC-23 tool_search 同名解析与宿主执行视图一致', async (t) => {
  const { agentA, search } = await bootScopes(t)
  const result = await search(agentA, '^shadowed$')
  assert.equal(result.count, 1)
  assert.ok(result.text.includes('A scope definition'))
  assert.ok(!result.text.includes('shadowed fixture'))
})

// Given 会话均已组装工具；When A 检索定义；Then A/B 工具投影与 defer 态不变。
test('SC-24 tool_search 不改变其他会话或本会话的工具加载态', async (t) => {
  const { root, agentA, agentB, search } = await bootScopes(t)
  const beforeA = root.tools.schemas(agentA)
  const beforeB = root.tools.schemas(agentB)
  const outcome = await root.tools.execute({
    callId: 'scope-A-search', name: 'tool_search', arguments: { pattern: '^only_a$' },
    agent: agentA, signal: new AbortController().signal,
  })
  assert.equal(outcome.isError, false, JSON.stringify(outcome))
  assert.equal(outcome.value.count, 1)
  assert.ok(outcome.value.text.includes('only_a'))
  assert.deepEqual(root.tools.schemas(agentA), beforeA)
  assert.deepEqual(root.tools.schemas(agentB), beforeB)
  assert.equal(root.tools.get('only_a', agentA).deferLoading, true)
  assert.equal((await search(agentB, '^only_a$')).count, 0)
})
