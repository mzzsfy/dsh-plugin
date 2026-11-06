// 请求缝集成:真 cordis + ToolRuntime + tool-gate 行,LLM adapter 原型链上验证
// 影子工具剔除(BDD SC-19):registry 有 shell 时,pwsh 不出现在请求 tools 里;
// 没有 shell 时恢复可见。同时确认折叠仍作用于其余 deferred 工具。

import test from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import { SystemPrompt } from '@deepseek-ai/dsh-system-prompt'
import { ToolRuntime, defineTool } from '@deepseek-ai/dsh-tools'
import { PI_AI_ROW_ID } from '../src/decorator.mjs'
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

class FakeAdapter {
  async streamWithSnapshot(options) {
    return options
  }
}

async function boot(toolNames, allowlist) {
  const root = new Context()
  await root.plugin(SystemPrompt)
  await root.plugin(ToolRuntime)
  for (const name of toolNames) root.tools.register(makeTool(name))
  const adapter = new FakeAdapter()
  const llm = {
    adapters: new Map([['fake', { adapter, provider: { id: 'fake' } }]]),
    directory: new Map([['fake', { settingsNs: PI_AI_ROW_ID, provider: 'fake' }]]),
  }
  root.provide('llm', llm)
  const fiber = await root.plugin(row, { allowlist })
  assert.equal(fiber?.state, 2, `tool-gate 行未激活 state=${fiber?.state}`)
  // inject(['llm']) 的回调在服务就绪后异步落定,patch 装上原型前不能发请求
  await new Promise((resolve) => setTimeout(resolve, 30))
  return { root, adapter }
}

const requestTools = (names) => names.map((name) => ({ name, description: `${name} real`, parameters: { type: 'object', properties: {} } }))

test('SC-19 集成:registry 有 shell 时请求里没有 pwsh', async () => {
  const { adapter } = await boot(['read', 'shell', 'pwsh', 'glob', 'grep', 'todo_write'], ['read', 'shell', 'glob', 'grep', 'todo_write'])
  const out = await adapter.streamWithSnapshot({ tools: requestTools(['read', 'shell', 'pwsh']) })
  assert.deepEqual(out.tools.map((tool) => tool.name), ['read', 'shell'])
})

test('SC-19c 集成:没有 shell 时 pwsh 保留(仅折叠为占位)', async () => {
  const { adapter } = await boot(['read', 'pwsh', 'glob', 'grep', 'todo_write'], ['read', 'glob', 'grep', 'todo_write'])
  const out = await adapter.streamWithSnapshot({ tools: requestTools(['read', 'pwsh']) })
  assert.deepEqual(out.tools.map((tool) => tool.name), ['read', 'pwsh'])
  assert.match(out.tools[1].description, /tool_search/)
})

test('SC-19d 集成:其余 deferred 工具仍走折叠,不被剔除', async () => {
  const { root, adapter } = await boot(['read', 'shell', 'web_search', 'glob', 'grep', 'todo_write'], ['read', 'shell', 'glob', 'grep', 'todo_write'])
  assert.equal(root.tools.get('web_search')?.deferLoading, true, 'registry 未打 deferred 标')
  const out = await adapter.streamWithSnapshot({ tools: requestTools(['read', 'shell', 'web_search']) })
  assert.deepEqual(out.tools.map((tool) => tool.name), ['read', 'shell', 'web_search'])
  assert.match(out.tools[2].description, /tool_search/)
})
