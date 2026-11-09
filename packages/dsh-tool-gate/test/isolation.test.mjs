// 会话隔离矩阵(真 cordis + 官方 ToolRuntime + dsh-scope):锁定工具门在
// 「兄弟会话 / 父链继承 / restrict / 同名 shadow / 动态层 / 行退场 / 请求折叠」
// 六个隔离面上的可观察行为。隔离正确性的观测面 = 宿主 tools 投影与请求缝
// 改写产物,不读工具门内部状态。
import test from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import { createScope } from '@deepseek-ai/dsh-scope'
import { SystemPrompt } from '@deepseek-ai/dsh-system-prompt'
import { ToolRuntime, defineTool } from '@deepseek-ai/dsh-tools'
import * as row from '../src/index.js'
import { DEFERRED_PLACEHOLDER_DESCRIPTION, TOOL_SEARCH_NAME } from '../src/fallback.mjs'
import { HOST_SKIP } from './host-form.mjs'

const makeTool = (name, description = `${name} fixture`) => defineTool({
  name,
  description,
  parameters: {},
  output: { schema: { type: 'object', properties: {}, additionalProperties: false }, render: () => [{ type: 'text', text: name }] },
  async execute() { return {} },
})

/** pi-ai 授权 adapter 类:记录每次请求的 options,原型每次新建防串扰。 */
function makeAdapter(calls) {
  return new (class Adapter {
    streamWithSnapshot(options) { calls.push(options); return 'stream' }
  })()
}

function makeLlm(adapter) {
  return {
    adapters: new Map([['pi', { provider: { id: 'pi' }, adapter }]]),
    directory: new Map([['pi', { settingsNs: 'llm-pi-ai', provider: 'pi' }]]),
  }
}

/** 真宿主装配:全局 read/web_fetch,A(父链预设 + restrict)、B 私有工具。 */
async function boot(t, options = {}) {
  const calls = []
  const adapter = makeAdapter(calls)
  const root = new Context()
  await root.plugin(SystemPrompt)
  await root.plugin(ToolRuntime)
  const readTool = makeTool('read')
  const fetchTool = makeTool('web_fetch')
  root.tools.register(readTool)
  root.tools.register(fetchTool)
  root.provide('llm', makeLlm(adapter))

  const presetKey = {}
  const agentA = {}
  const agentB = {}
  const presetScope = createScope(root, presetKey)
  const scopeA = createScope(root, agentA, { parent: presetKey })
  const scopeB = createScope(root, agentB)
  const presetTool = makeTool('inherited')
  const onlyA = makeTool('only_a')
  const onlyB = makeTool('only_b')
  const shadowA = makeTool('web_fetch', 'A scope definition')
  await presetScope.ctx.inject(['tools'], (ctx) => ctx.tools.register(presetTool))
  await scopeA.ctx.inject(['tools'], (ctx) => {
    ctx.tools.register(onlyA)
    ctx.tools.register(shadowA)
    ctx.tools.restrict({ deny: ['read'] })
  })
  await scopeB.ctx.inject(['tools'], (ctx) => ctx.tools.register(onlyB))

  const fiber = await root.plugin(row, options.config ?? { allowlist: ['read'] })
  assert.equal(fiber?.state, 2, 'tool-gate 行应激活')

  // 生产路径:模型步先 resolve 出准入 toolSet(条件注册 when 与 restrict 已解析),
  // 检索面吃同一 toolSet;用完即 dispose(与 agent-loop 语义一致)
  const search = async (agent, pattern = '.') => {
    const toolSet = await root.tools.resolve({ agent, signal: t.signal })
    try {
      return await root.tools.get(TOOL_SEARCH_NAME, agent).execute({ pattern }, { agent, toolSet })
    } finally {
      toolSet.dispose()
    }
  }
  const namesOf = (result) => result.text.match(/^### (.+)$/gm)?.map((line) => line.slice(4)).sort() ?? []

  t.after(async () => {
    await fiber.dispose()
    await scopeB.dispose()
    await scopeA.dispose()
    await presetScope.dispose()
    await root.registry.delete(ToolRuntime)
    await root.registry.delete(SystemPrompt)
  })
  return { root, fiber, calls, adapter, agentA, agentB, readTool, fetchTool, presetTool, onlyA, onlyB, shadowA, search, namesOf }
}

test('I1 兄弟会话检索隔离:继承父层、restrict 遮蔽、私有工具互不可见', { skip: HOST_SKIP }, async (t) => {
  const { agentA, agentB, search, namesOf } = await boot(t)
  assert.deepEqual(namesOf(await search(agentA)), ['inherited', 'only_a', 'web_fetch'])
  assert.deepEqual(namesOf(await search(agentB)), ['only_b', 'read', 'web_fetch'])
  const globalView = await search(undefined)
  assert.deepEqual(namesOf(globalView), ['read', 'web_fetch'])
  assert.equal((await search(agentB, '^only_a$')).count, 0, 'B 不得检索到 A 的私有工具')
  assert.equal((await search(agentA, '^only_b$')).count, 0, 'A 不得检索到 B 的私有工具')
})

test('I2 同名 shadow:检索返回调用方实际定义,会话间互不串', { skip: HOST_SKIP }, async (t) => {
  const { agentA, agentB, search } = await boot(t)
  const a = await search(agentA, '^web_fetch$')
  assert.equal(a.count, 1)
  assert.ok(a.text.includes('A scope definition'), 'A 命中自己的 shadow 定义')
  const b = await search(agentB, '^web_fetch$')
  assert.equal(b.count, 1)
  assert.ok(b.text.includes('web_fetch fixture'), 'B 命中全局定义')
  assert.ok(!b.text.includes('A scope definition'), 'B 不得看到 A 的 shadow')
})

test('I3 加载态隔离:同名 shadow 与全局按同一白名单收敛,私有工具不影响兄弟会话', { skip: HOST_SKIP }, async (t) => {
  const { root, agentA, agentB, readTool, fetchTool, shadowA, onlyA } = await boot(t)
  assert.equal(fetchTool.deferLoading, true, '全局 web_fetch 白名单外打标')
  assert.equal(shadowA.deferLoading, true, 'A 的 shadow 同名同态')
  assert.equal(onlyA.deferLoading, true, 'A 私有工具白名单外打标')
  const onlyB = root.tools.get('only_b', agentB)
  assert.equal(onlyB.deferLoading, true)
  assert.equal('deferLoading' in readTool, false, 'restrict 掉的全局 read 仍按白名单清标')
  assert.equal(root.tools.get('read', agentA), undefined, 'A restrict 后投影不含 read')
  assert.equal(root.tools.get('only_a', agentB), undefined, 'B 投影不含 A 私有工具')
})

test('I4 动态会话层:新 agent 注册即收敛,退场不改变兄弟会话状态', { skip: HOST_SKIP }, async (t) => {
  const { root, agentA, agentB } = await boot(t)
  const beforeA = root.tools.schemas(agentA)
  const agentC = {}
  const scopeC = createScope(root, agentC)
  await scopeC.ctx.inject(['tools'], (ctx) => ctx.tools.register(makeTool('only_c')))
  assert.equal(root.tools.get('only_c', agentC).deferLoading, true, '动态层由 tools/change 触发收敛')
  assert.deepEqual(root.tools.schemas(agentA), beforeA, 'C 的出现不改变 A 的投影')
  await scopeC.dispose()
  assert.equal(root.tools.get('only_c', agentC), undefined, 'C 退场后不可见')
  assert.deepEqual(root.tools.schemas(agentA), beforeA, 'C 退场不改变 A 的投影')
  assert.ok(root.tools.get('only_b', agentB), 'B 不受影响')
})

test('I5 请求折叠隔离:各会话请求按各自 visible 折叠,注册态与请求对象不被变异', { skip: HOST_SKIP }, async (t) => {
  const { root, calls, adapter, agentA, agentB, fetchTool } = await boot(t)
  const toolsOf = (scope) => root.tools.schemas(scope).map((schema) => ({ name: schema.name, description: schema.description, parameters: schema.parameters }))
  const requestA = { tools: toolsOf(agentA) }
  const requestB = { tools: toolsOf(agentB) }
  const frozenA = JSON.stringify(requestA)
  const before = [fetchTool.deferLoading, root.tools.get('only_a', agentA).deferLoading]
  adapter.streamWithSnapshot(requestA, {})
  adapter.streamWithSnapshot(requestB, {})
  const folded = (index) => calls[index].tools.filter((tool) => tool.description === DEFERRED_PLACEHOLDER_DESCRIPTION).map((tool) => tool.name).sort()
  assert.deepEqual(folded(0), ['inherited', 'only_a', 'web_fetch'], 'A 请求只折叠 A 可见的白名单外工具')
  assert.deepEqual(folded(1), ['only_b', 'web_fetch'], 'B 请求只折叠 B 可见的白名单外工具,不含 A 私有工具')
  assert.equal(calls[0].tools.some((tool) => tool.name === 'only_b'), false, 'A 请求不含 B 私有工具')
  assert.equal(calls[1].tools.some((tool) => tool.name === 'only_a'), false, 'B 请求不含 A 私有工具')
  assert.equal(JSON.stringify(requestA), frozenA, '请求对象零变异')
  assert.deepEqual([fetchTool.deferLoading, root.tools.get('only_a', agentA).deferLoading], before, '折叠不改变注册态')
})

test('I6 请求折叠零命中零拷贝:白名单工具请求原引用透传', { skip: HOST_SKIP }, async (t) => {
  const { calls, adapter, readTool } = await boot(t)
  const request = { tools: [{ name: 'read', description: readTool.description, parameters: {} }] }
  adapter.streamWithSnapshot(request, {})
  assert.equal(calls[0], request, '无 deferred 命中时返回原 options 引用')
})

test('I7 行退场隔离:各会话层全部还原,tool_search 注销', { skip: HOST_SKIP }, async (t) => {
  const { root, agentA, agentB, fetchTool, presetTool, shadowA, onlyA, onlyB, fiber } = await boot(t)
  assert.equal(fetchTool.deferLoading, true)
  assert.equal(presetTool.deferLoading, true)
  await fiber.dispose()
  assert.equal('deferLoading' in fetchTool, false)
  assert.equal('deferLoading' in presetTool, false, '父链预设层同样还原')
  assert.equal('deferLoading' in shadowA, false)
  assert.equal('deferLoading' in onlyA, false)
  assert.equal('deferLoading' in onlyB, false)
  assert.equal('deferLoading' in root.tools.get('only_a', agentA), false)
  assert.equal(root.tools.get('tool_search'), undefined, 'tool_search 随行注销')
  assert.equal(root.tools.get('only_b', agentB), onlyB)
})

test('I8 停用/恢复隔离:重挂 enabled=false 全层还原,恢复后兄弟会话同态', { skip: HOST_SKIP }, async (t) => {
  const { root, fiber, fetchTool, presetTool, onlyA, onlyB } = await boot(t)
  await fiber.dispose()
  const offFiber = await root.plugin(row, { allowlist: ['read'], enabled: false })
  assert.equal(offFiber?.state, 2)
  assert.equal('deferLoading' in fetchTool, false, '停用后还原')
  assert.equal('deferLoading' in presetTool, false)
  assert.equal('deferLoading' in onlyA, false)
  assert.equal('deferLoading' in onlyB, false)
  await offFiber.dispose()
  const onFiber = await root.plugin(row, { allowlist: ['read'], enabled: true })
  assert.equal(onFiber?.state, 2)
  assert.equal(fetchTool.deferLoading, true)
  assert.equal(presetTool.deferLoading, true, '父链预设层恢复打标')
  assert.equal(onlyA.deferLoading, true)
  assert.equal(onlyB.deferLoading, true)
  await onFiber.dispose()
})

test('I9 并发:多会话同时检索与他层注册交错,隔离终态一致', { skip: HOST_SKIP }, async (t) => {
  const { root, agentA, agentB, search } = await boot(t)
  const scopes = Array.from({ length: 6 }, () => ({}))
  const created = scopes.map((key) => createScope(root, key))
  await Promise.all(created.map((scope, index) => scope.ctx.inject(['tools'], (ctx) => ctx.tools.register(makeTool(`bulk_${index}`)))))
  const results = await Promise.all([
    search(agentA), search(agentB),
    ...created.map((_, index) => search(scopes[index])),
  ])
  const aNames = results[0].text
  assert.ok(aNames.includes('only_a'))
  assert.ok(!aNames.includes('only_b'), '并发检索不串会话')
  for (const [index, result] of results.slice(2).entries()) {
    assert.ok(result.text.includes(`bulk_${index}`), `bulk_${index} 对所属会话可见`)
    assert.ok(!result.text.includes('only_a'), '并发下私有工具不越界')
  }
  for (const scope of created) await scope.dispose()
})

// Given 条件注册工具(when)准入未满足;When 模型步内检索;Then 不返回本步不可执行的工具。
test('I10 准入隔离:检索面跟随本步 toolSet,未准入的条件工具不返回', { skip: HOST_SKIP }, async (t) => {  const { root, agentA, agentB } = await boot(t)
  root.tools.register(makeTool('always_ready'))
  root.tools.register(makeTool('plan_exit'), { when: () => false })
  const signal = new AbortController().signal
  const denied = await root.tools.resolve({ agent: agentA, signal })
  const search = (toolSet) => root.tools.get(TOOL_SEARCH_NAME, agentA).execute({ pattern: 'plan_exit|always_ready' }, { agent: agentA, toolSet })
  const admitted = await search(denied)
  assert.ok(admitted.text.includes('always_ready'), '无条件工具在准入面')
  assert.ok(!admitted.text.includes('plan_exit'), 'when 未满足的工具不得出现在检索结果')
  denied.dispose()
  const unadmitted = await root.tools.get(TOOL_SEARCH_NAME, agentA).execute({ pattern: 'plan_exit' }, { agent: agentA })
  assert.ok(unadmitted.text.includes('plan_exit'), '无 toolSet 的程序化调用退回注册视图')
  const closed = await search(denied)
  assert.equal(closed.count, 0, 'toolSet 关闭后准入面为空')
  const foreign = await root.tools.resolve({ agent: agentA, signal })
  const crossScope = await root.tools.get(TOOL_SEARCH_NAME, agentB).execute({ pattern: 'always_ready' }, { agent: agentB, toolSet: foreign })
  assert.equal(crossScope.count, 0, '他会话的 toolSet 不对本会话生效')
  foreign.dispose()
})

// Given 某 scope 层注册工具并被 gate 打标;When 层退场(宿主表换代)后同一
// definition 在新 scope 重建,行退场;Then journal 仍能还原到无标原状(INV-2)。
test('I11 journal 跨层换代还原:层清空后同 definition 重建仍可还原', { skip: HOST_SKIP }, async (t) => {
  const { root, fiber } = await boot(t)
  const churnTool = makeTool('churn_tool')
  const first = createScope(root, {})
  await first.ctx.inject(['tools'], (ctx) => { ctx.tools.register(churnTool) })
  assert.equal(churnTool.deferLoading, true, '新层注册即收敛打标')
  await first.dispose()
  assert.equal(churnTool.deferLoading, true, '层退场不还原对象(无人观察),债务现场保留')
  const second = createScope(root, {})
  await second.ctx.inject(['tools'], (ctx) => { ctx.tools.register(churnTool) })
  await fiber.dispose()
  assert.equal('deferLoading' in churnTool, false, '行退场按 definition 还原,不因层换代失联')
  await second.dispose()
})

// Given 8 个会话并发注册各自私有工具;When 并发检索、并发折叠请求交错执行;
// Then 检索与请求各按自己的会话面处理,打标正确,退场全部还原。
test('I12 多会话并发:注册/检索/折叠互不串,退场全还原', { skip: HOST_SKIP }, async (t) => {
  const { root, fiber, adapter, calls, search, namesOf } = await boot(t)
  const sessions = await Promise.all(Array.from({ length: 8 }, async (_, index) => {
    const agent = {}
    const scope = createScope(root, agent)
    const privateTool = makeTool(`private_${index}`, `session ${index} private`)
    await scope.ctx.inject(['tools'], (ctx) => { ctx.tools.register(privateTool) })
    return { agent, scope, privateTool }
  }))
  assert.deepEqual(sessions.map(({ privateTool }) => privateTool.deferLoading), Array(8).fill(true))
  const hits = await Promise.all(sessions.map(({ agent }) => search(agent, '^private_')))
  hits.forEach((result, index) => {
    assert.deepEqual(namesOf(result), [`private_${index}`], `会话 ${index} 只见私有工具`)
  })
  const requests = sessions.map(({ privateTool }) => ({ tools: [
    { name: privateTool.name, description: 'private', parameters: {} },
    { name: 'read', description: 'read', parameters: {} },
  ] }))
  requests.forEach((request) => adapter.streamWithSnapshot(request, {}))
  calls.forEach((options, index) => {
    assert.deepEqual(options.tools.map((tool) => tool.name), [sessions[index].privateTool.name, 'read'])
    assert.equal(options.tools[0].description, DEFERRED_PLACEHOLDER_DESCRIPTION, '白名单外折叠为占位')
    assert.equal(options.tools[1].description, 'read', '白名单内原样')
  })
  assert.equal(new Set(requests).size, 8, '请求对象各自独立不被共享变异')
  for (const { scope } of sessions) await scope.dispose()
  await fiber.dispose()
  for (const { privateTool } of sessions) assert.equal('deferLoading' in privateTool, false, '退场还原')
  assert.equal(root.tools.get(TOOL_SEARCH_NAME), undefined)
})

// Given 行此前已收敛并可检索;When 行全量退场(模拟停机)后同一批定义重新装载
// (模拟重启);Then 白名单收敛、投影带标、检索入口与还原链全部恢复。
test('I13 重启恢复:退场后重新装载,收敛/投影/检索入口恢复', { skip: HOST_SKIP }, async (t) => {
  const { root, fiber, readTool, fetchTool } = await boot(t)
  await fiber.dispose()
  assert.equal('deferLoading' in fetchTool, false, '停机后无标')
  const restarted = await root.plugin(row, { allowlist: ['read'] })
  assert.equal(restarted?.state, 2)
  assert.equal('deferLoading' in readTool, false, '白名单内无标')
  assert.equal(readTool.deferLoading, undefined)
  assert.equal(fetchTool.deferLoading, true, '白名单外重新打标')
  assert.ok(root.tools.get(TOOL_SEARCH_NAME), '检索入口随行重挂')
  const schemas = new Map(root.tools.schemas(undefined).map((schema) => [schema.name, schema]))
  assert.equal(schemas.get('read').deferLoading, undefined)
  assert.equal(schemas.get('web_fetch').deferLoading, true)
  await restarted.dispose()
  assert.equal('deferLoading' in fetchTool, false, '再次退场仍还原')
})

// Given 归档会话(scope 退场)前后有活跃兄弟会话与共享 definition;When 归档、
// 再在新会话重建同一 definition;Then 活跃会话投影不变、私有工具不可见、
// 共享对象仍受白名单控制且最终可还原。
test('I14 归档会话:层退场不影响活跃会话,共享定义重建仍受控', { skip: HOST_SKIP }, async (t) => {
  const { root, agentA, agentB, fiber } = await boot(t)
  const beforeA = root.tools.schemas(agentA)
  const beforeB = root.tools.schemas(agentB)
  const archivedScope = createScope(root, {})
  const archivedTool = makeTool('archived_tool')
  await archivedScope.ctx.inject(['tools'], (ctx) => { ctx.tools.register(archivedTool) })
  assert.equal(archivedTool.deferLoading, true)
  assert.deepEqual(root.tools.schemas(agentA), beforeA, '归档候选层不改变活跃会话投影')
  assert.deepEqual(root.tools.schemas(agentB), beforeB)
  await archivedScope.dispose()
  assert.deepEqual(root.tools.schemas(agentA), beforeA, '归档后活跃会话投影不变')
  assert.equal(root.tools.get('archived_tool', agentA), undefined, '归档工具对兄弟会话不可见')
  const revivedScope = createScope(root, {})
  await revivedScope.ctx.inject(['tools'], (ctx) => { ctx.tools.register(archivedTool) })
  assert.equal(archivedTool.deferLoading, true, '共享定义在新会话重建仍按白名单打标')
  await fiber.dispose()
  assert.equal('deferLoading' in archivedTool, false, '归档后重建的共享定义最终可还原')
  await revivedScope.dispose()
})

// Given 全局层在 apply 后继续注册/注销工具;When 收敛;Then 新注册仍被打标,
// 退场全部还原(层表由 layers() 现读,不缓存旧表)。
test('I15 全局层注册退场与重注册:新工具继续收敛', { skip: HOST_SKIP }, async (t) => {
  const root = new Context()
  await root.plugin(SystemPrompt)
  await root.plugin(ToolRuntime)
  const first = makeTool('churn_global_a')
  const undoFirst = root.tools.register(first)
  const fiber = await root.plugin(row, { allowlist: [] })
  assert.equal(first.deferLoading, true)
  undoFirst()
  const second = makeTool('churn_global_b')
  root.tools.register(second)
  assert.equal(second.deferLoading, true, '全局层换代后新注册仍被打标')
  await fiber.dispose()
  assert.equal('deferLoading' in second, false, '退场还原')
  await root.registry.delete(ToolRuntime)
  await root.registry.delete(SystemPrompt)
})
