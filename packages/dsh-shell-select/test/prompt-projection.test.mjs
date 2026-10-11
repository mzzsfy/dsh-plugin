import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import { createScope } from '@deepseek-ai/dsh-scope'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { defineTool, renderToolsSdk, renderToolsSdkPy } from '@deepseek-ai/dsh-tools'
import * as projection from '../src/prompt-projection.mjs'

function fixture() {
  const ctx = new Context()
  new SystemPrompt(ctx, {})
  new ToolRuntime(ctx, {})
  const preset = {}
  const scoped = createScope(ctx, preset)
  const register = (target, name, description) => target.tools.register(defineTool({
    name, description, parameters: {},
    output: { schema: { type: 'string' }, render: (value) => value },
    execute: async () => 'PowerShell',
  }))
  register(ctx, 'shell', 'multi client')
  register(ctx, 'pwsh', 'Do not call; use shell.')
  register(scoped.ctx, 'pwsh', 'official preset description')
  scoped.ctx.systemPrompt.section({ name: 'tool:pwsh', order: 1001, text: 'duplicate guidance' })
  ctx.systemPrompt.section({ name: 'tool:shell', order: 1000, text: 'shell guidance' })
  ctx.systemPrompt.context({ name: 'retained-context', order: 1, text: 'cwd' })
  return { ctx, scoped, preset }
}

// Given 官方预设遮蔽根描述；When 组装；Then 无pwsh展示但历史调用保持可执行。
test('native 投影穿过预设遮蔽且不影响调用', async () => {
  const { ctx, preset, scoped } = fixture()
  const agent = {}
  const child = createScope(ctx, agent, { parent: preset })
  const original = await ctx.systemPrompt.assemble({ scope: agent })
  assert.equal(original.tools.find((t) => t.name === 'pwsh').description, 'official preset description')
  projection.mountShellPromptProjection(ctx)
  const result = await ctx.systemPrompt.assemble({ scope: agent })
  assert.deepEqual(result.tools.map((t) => t.name), ['shell'])
  assert.deepEqual(result.sections.filter((s) => s.name.startsWith('tool:')).map((s) => s.name), ['tool:shell'])
  assert.deepEqual(result.contexts, original.contexts)
  assert.deepEqual(result.variables, original.variables)
  assert.equal(ctx.tools.get('pwsh', agent).description, 'official preset description')
  assert.equal(await ctx.tools.get('pwsh', agent).execute({}, {}), 'PowerShell')
  await child.dispose()
  await scoped.dispose()
})

// Given 监听卸载；When 再次组装；Then 原预设schema与提示段恢复。
test('投影卸载自然还原', async () => {
  const { ctx, preset, scoped } = fixture()
  const original = await ctx.systemPrompt.assemble({ scope: preset })
  const dispose = projection.mountShellPromptProjection(ctx)
  await ctx.systemPrompt.assemble({ scope: preset })
  dispose()
  assert.deepEqual(await ctx.systemPrompt.assemble({ scope: preset }), original)
  await scoped.dispose()
})

// Given 子代理排除shell；When 组装；Then 不移除其唯一终端。
test('shell 不可见时保留 pwsh', async () => {
  const { ctx, preset, scoped } = fixture()
  const agent = {}
  const child = createScope(ctx, agent, { parent: preset })
  child.ctx.tools.restrict({ deny: ['shell'] })
  const original = await ctx.systemPrompt.assemble({ scope: agent })
  projection.mountShellPromptProjection(ctx)
  assert.deepEqual(await ctx.systemPrompt.assemble({ scope: agent }), original)
  await child.dispose()
  await scoped.dispose()
})

for (const [language, render] of [['typescript', renderToolsSdk], ['python', renderToolsSdkPy]]) {
  for (const mode of ['ptc', 'both']) {
    // Given PTC SDK；When 组装；Then 仅删除pwsh声明，其他工具类型不变。
    test(`${language}/${mode} SDK 删除 pwsh 且保留其他输出类型`, async () => {
      const { ctx, preset, scoped } = fixture()
      const schemas = ctx.tools.schemas(preset).map((s) => ({ ...s, output: ctx.tools.get(s.name, preset).output.schema }))
      ctx.on('system-prompt/assemble', async (assembly, context, next) => {
        const result = await next()
        return { ...result, tools: mode === 'ptc' ? [{ name: 'run_code' }] : [...result.tools, { name: 'run_code' }],
          sections: [...result.sections, { name: 'tools:sdk', text: render(schemas), interpolate: false }] }
      })
      ctx.reflect.provide('ptcRuntime', { language })
      projection.mountShellPromptProjection(ctx)
      const result = await ctx.systemPrompt.assemble({ scope: preset })
      assert.deepEqual(result.tools.map((t) => t.name), mode === 'ptc' ? ['run_code'] : ['shell', 'run_code'])
      assert.equal(result.sections.find((s) => s.name === 'tools:sdk').text, render(schemas.filter((s) => s.name !== 'pwsh')))
      assert.equal(await ctx.tools.get('pwsh', preset).execute({}, {}), 'PowerShell')
      await scoped.dispose()
    })
  }
}

// Given 其他waterfall在next中添加pwsh；When投影；Then最终结果过滤而非入口快照。
test('投影过滤 next 返回的最终结果且不篡改输入', async () => {
  const handlers = []
  const warnings = []
  const ctx = { on: (name, handler) => { handlers.push(handler); return () => {} }, tools: { get: () => ({}) }, logger: { warn: (msg) => warnings.push(msg) } }
  projection.mountShellPromptProjection(ctx)
  const input = { tools: [], sections: [] }
  const final = { tools: [{ name: 'shell' }, { name: 'pwsh' }, { name: 'read' }], sections: [{ name: 'tool:pwsh' }, { name: 'policy' }], contexts: [], variables: {} }
  const result = await handlers[0](input, {}, async () => final)
  assert.deepEqual(result.tools.map((t) => t.name), ['shell', 'read'])
  assert.deepEqual(result.sections.map((s) => s.name), ['policy'])
  assert.equal(final.tools.length, 3)
  assert.equal(input.tools.length, 0)
  assert.deepEqual(warnings, [])
})

// Given 无法识别SDK语言；When投影；Then原样返回且告警，不做半完成SDK。
test('SDK 投影不可用时整体不改并告警', async () => {
  const handlers = []
  const warnings = []
  const ctx = { on: (name, handler) => { handlers.push(handler); return () => {} }, tools: { get: () => ({}) },
    get: () => ({ language: 'unsupported' }), logger: { warn: (msg) => warnings.push(msg) } }
  projection.mountShellPromptProjection(ctx)
  const final = { tools: [{ name: 'shell' }, { name: 'pwsh' }, { name: 'run_code' }], sections: [{ name: 'tools:sdk', text: 'pwsh sdk' }] }
  assert.equal(await handlers[0](final, {}, async () => final), final)
  assert.equal(warnings.length, 1)
})
