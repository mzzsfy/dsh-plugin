// preset 自带的官方 pwsh 在会话作用域注册,own 优先覆盖本包全局注册的同名工具,
// 描述提示对模型不可见。agent/created 给到 agent 作用域后直接改定义对象:
// 只改 description,不动执行与注册;标记挂在定义上保证幂等。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { PWSH_REDIRECT_DESCRIPTION, describePwshDirective } from '../src/agent-hints.mjs'

function agentOf(definition) {
  return { ctx: { tools: { get: (name) => name === 'pwsh' ? definition : undefined } }, id: 'a1' }
}

test('agent 创建后改写会话作用域 pwsh 的描述', () => {
  // Given preset 挂载了官方 pwsh;When agent 创建;Then 描述换成改用 shell 的提示。
  const definition = { name: 'pwsh', description: 'Run PowerShell commands' }
  assert.equal(describePwshDirective(agentOf(definition)), true)
  assert.equal(definition.description, PWSH_REDIRECT_DESCRIPTION)
})

test('重复调用保持幂等,不重复改写', () => {
  const definition = { name: 'pwsh', description: 'x' }
  const agent = agentOf(definition)
  describePwshDirective(agent)
  definition.description = 'someone else'
  assert.equal(describePwshDirective(agent), false)
  assert.equal(definition.description, 'someone else')
})

test('无 pwsh 定义、tools 缺失或定义不可改:零动作', () => {
  assert.equal(describePwshDirective({ ctx: { tools: { get: () => undefined } } }), false)
  assert.equal(describePwshDirective({ ctx: {} }), false)
  assert.equal(describePwshDirective(undefined), false)
  const frozen = Object.freeze({ name: 'pwsh', description: 'frozen' })
  assert.equal(describePwshDirective(agentOf(frozen)), false)
  assert.equal(frozen.description, 'frozen')
})
