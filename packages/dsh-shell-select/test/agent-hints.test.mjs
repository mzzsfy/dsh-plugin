// preset 自带的官方 pwsh 在会话作用域注册,own 优先覆盖本包全局注册的同名工具,
// 描述提示对模型不可见。agent/created 给到 agent 作用域后直接改定义对象:
// 只改 description,不动执行与注册;标记挂在定义上保证幂等。
// 前提与请求缝同条件:该 agent 作用域能看到 shell——看不到 shell 的会话把描述
// 改成"不要调用"等于抹掉唯一终端。
//
// 作用域键 = agent 对象本身(宿主 createScope(loopCtx, agent));用真 ToolRuntime
// + createScope 建夹具:桩掉 tools 的旧用例对错误实现是假绿——它既不区分作用域
// 键,也拿不到 dsh-tools 真实的分层视图派生(传 ctx 会静默落回全局视图)。
//
// 真机构形:官方 tool-pwsh 行在 preset 作用域注册(preset-registry 现造 {})键,
// agent 作用域以 preset 键为父),definition 由该 preset 下所有 agent 共享。
// 改写继承/全局 definition 会把"不要调用"泄漏给同 preset 的其它 agent 与 deny
// shell 的子作用域,故只有 agent 自有层才允许改写。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import { createScope } from '@deepseek-ai/dsh-scope'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { defineTool } from '@deepseek-ai/dsh-tools'
import { PWSH_REDIRECT_DESCRIPTION, describePwshDirective } from '../src/agent-hints.mjs'

const GLOBAL_PWSH_DESCRIPTION = 'Run PowerShell commands (global mirror)'
const PRESET_PWSH_DESCRIPTION = 'Run PowerShell commands'
const OWN_PWSH_DESCRIPTION = 'Session-local PowerShell'

function definitionOf(name, description) {
  return defineTool({
    name,
    description,
    parameters: {},
    output: { schema: { type: 'string' }, render: (value) => value },
    execute: async () => name,
  })
}

// 宿主形态:全局 shell + 全局 pwsh 镜像(本包执行器全局注册);preset 作用域注册
// 官方 pwsh(preset 的 tool-pwsh 行);agent 作用域以 preset 为父,可选自有注册
function hostFixture({ presetPwsh = true, ownPwsh = false, globalPwsh = true } = {}) {
  const ctx = new Context()
  new SystemPrompt(ctx, {})
  new ToolRuntime(ctx, {})
  ctx.tools.register(definitionOf('shell', 'multi client shell'))
  if (globalPwsh) ctx.tools.register(definitionOf('pwsh', GLOBAL_PWSH_DESCRIPTION))
  const presetKey = {}
  const presetScope = createScope(ctx, presetKey)
  if (presetPwsh) presetScope.ctx.tools.register(definitionOf('pwsh', PRESET_PWSH_DESCRIPTION))
  const agent = { id: 'session-1' }
  const agentScope = createScope(ctx, agent, { parent: presetKey })
  agent.ctx = agentScope.ctx
  if (ownPwsh) agentScope.ctx.tools.register(definitionOf('pwsh', OWN_PWSH_DESCRIPTION))
  return { ctx, agent, presetKey, presetScope, agentScope }
}

test('继承 preset 的官方 pwsh:共享定义零动作(不泄漏给同 preset 的其它 agent)', async () => {
  // Given 官方 pwsh 在 preset 层注册、该 preset 下有两个 agent
  const { ctx, agent, presetKey, presetScope } = hostFixture()
  const sibling = { id: 'session-2' }
  const siblingScope = createScope(ctx, sibling, { parent: presetKey })
  sibling.ctx = siblingScope.ctx
  // When 第一个 agent 创建触发描述改写
  assert.equal(describePwshDirective(agent), false)
  // Then 共享 definition 原样;兄弟 agent 解析到的还是同一份原始定义
  assert.equal(ctx.tools.get('pwsh', agent).description, PRESET_PWSH_DESCRIPTION)
  assert.equal(ctx.tools.get('pwsh', sibling).description, PRESET_PWSH_DESCRIPTION)
  await siblingScope.dispose()
  await presetScope.dispose()
})

test('继承全局镜像:零动作,全局定义原样', async () => {
  // Given 该会话没有 preset 自有 pwsh,只继承本包全局镜像
  const { ctx, agent, presetScope } = hostFixture({ presetPwsh: false })
  // When 触发改写;Then 零动作
  assert.equal(describePwshDirective(agent), false)
  assert.equal(ctx.tools.get('pwsh').description, GLOBAL_PWSH_DESCRIPTION)
  assert.equal(ctx.tools.get('pwsh', agent).description, GLOBAL_PWSH_DESCRIPTION)
  await presetScope.dispose()
})

test('agent 自有 scoped layer:改写自有定义,preset 共享定义原样', async () => {
  // Given agent 作用域自己注册了 pwsh(自有层遮蔽 preset 层)
  const { ctx, agent, presetKey, presetScope } = hostFixture({ ownPwsh: true })
  // When 触发改写;Then 只有自有定义被改,preset 共享定义不动
  assert.equal(describePwshDirective(agent), true)
  assert.equal(ctx.tools.get('pwsh', agent).description, PWSH_REDIRECT_DESCRIPTION)
  assert.equal(ctx.tools.schemas(agent).find((schema) => schema.name === 'pwsh').description, PWSH_REDIRECT_DESCRIPTION)
  assert.equal(ctx.tools.get('pwsh', presetKey).description, PRESET_PWSH_DESCRIPTION)
  await presetScope.dispose()
})

test('自有层重复调用保持幂等,不重复改写', async () => {
  const { ctx, agent, presetScope } = hostFixture({ ownPwsh: true })
  assert.equal(describePwshDirective(agent), true)
  const definition = ctx.tools.get('pwsh', agent)
  definition.description = 'someone else'
  assert.equal(describePwshDirective(agent), false)
  assert.equal(definition.description, 'someone else')
  await presetScope.dispose()
})

test('子作用域 deny shell(仅保留 pwsh 的子代理):继承定义原样,不抹唯一终端', async () => {
  // Given preset 下 agent 有子作用域显式 deny shell
  const { ctx, agent, presetScope } = hostFixture()
  const childAgent = { id: 'sub-1' }
  const child = createScope(ctx, childAgent, { parent: agent })
  childAgent.ctx = child.ctx
  child.ctx.tools.restrict({ deny: ['shell'] })
  // When 子 agent 创建触发改写
  assert.equal(describePwshDirective(childAgent), false)
  // Then 子作用域仍能解析 pwsh(继承),但 shell 被限制 → 不改写
  assert.equal(ctx.tools.get('pwsh', childAgent).description, PRESET_PWSH_DESCRIPTION)
  assert.equal(ctx.tools.get('shell', childAgent), undefined)
  await child.dispose()
  await presetScope.dispose()
})

test('作用域解析不到 pwsh(无 own 也无继承):零动作', async () => {
  // Given 会话作用域既没有 preset 注册的 pwsh,也没有本包全局镜像
  const { ctx, agent, presetScope } = hostFixture({ presetPwsh: false, globalPwsh: false })
  // When 触发改写;Then 零动作
  assert.equal(ctx.tools.get('pwsh', agent), undefined)
  assert.equal(describePwshDirective(agent), false)
  await presetScope.dispose()
})

test('tools 服务未注入:不抛错(属性直读会抛),零动作', async () => {
  // Given agent 的 ctx 上没有任何 tools 提供者(宿主服务缺失/上下文停用形态)
  const bare = new Context()
  const agent = { id: 'session-naked' }
  const scope = createScope(bare, agent)
  agent.ctx = scope.ctx
  // cordis 属性访问在服务未注入时抛错——agent/created 是 serial 事件,这里必须零抛出
  assert.throws(() => agent.ctx.tools, /without inject/)
  assert.equal(describePwshDirective(agent), false)
  await scope.dispose()
})

test('agent/ctx 形态缺失或定义不可改:零动作', async () => {
  assert.equal(describePwshDirective(undefined), false)
  assert.equal(describePwshDirective({}), false)
  assert.equal(describePwshDirective({ ctx: {} }), false)
  // 自有层可见 shell 但定义被冻结:标记写不进,描述原样
  const ctx = new Context()
  new SystemPrompt(ctx, {})
  new ToolRuntime(ctx, {})
  ctx.tools.register(definitionOf('shell', 'multi client shell'))
  const agent = { id: 'session-frozen' }
  const scope = createScope(ctx, agent)
  agent.ctx = scope.ctx
  const frozen = Object.freeze(definitionOf('pwsh', 'frozen'))
  scope.ctx.tools.register(frozen)
  assert.equal(describePwshDirective(agent), false)
  assert.equal(ctx.tools.get('pwsh', agent).description, 'frozen')
  await scope.dispose()
})
