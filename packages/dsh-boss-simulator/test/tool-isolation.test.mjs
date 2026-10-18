import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import { createScope } from '@deepseek-ai/dsh-scope'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { registerControl } from '../lib/control.mjs'
import { registerToolRow } from '../lib/tools-row.mjs'

const store = { loadControl: async () => ({ globalStopped: false }), loadAggregate: async () => null }

test('控制室装配不得向全局工具面注册业务工具', async () => {
  const registered = []
  const disposers = []
  let opening
  let presetReady
  const table = { get: () => undefined }
  const services = {
    storageDomain: { open: async () => ({ table: () => table, close() {} }) },
    webServer: { register: () => () => {} },
    tools: { register: (definition) => { registered.push(`tool:${definition.name}`); return () => {} }, guard: () => () => {} },
    agentPresets: {
      async register(definition) { registered.push(`preset:${definition.id}`); return async () => {} },
      async list() { return [] },
      async resolve() { return { broken: undefined } },
    },
  }
  const ctx = {
    async inject(names, activate) {
      if (names.every((name) => services[name])) {
        const result = await activate(services)
        if (names.includes('storageDomain')) opening = Promise.resolve(result)
        if (names.includes('agentPresets')) presetReady = Promise.resolve(result)
      }
    },
    effect(effect) { if (typeof effect === 'function') { const dispose = effect(); if (typeof dispose === 'function') disposers.push(dispose) } },
    provide() {}, on() {},
  }
  registerControl(ctx)
  await opening
  await presetReady
  assert.deepEqual(registered, ['preset:boss-simulator-admin'], '注册只暴露单个工作台 preset，标准聊天不继承公司管理 schema')
  disposers.reverse().forEach((dispose) => dispose())
})

test('真实宿主scope仅受管agent继承业务schema且释放后消失', async () => {
  const root = new Context()
  new SystemPrompt(root, {})
  new ToolRuntime(root, {})
  const ordinary = {}
  const preset = {}
  const admin = {}
  const ordinaryScope = createScope(root, ordinary)
  const presetScope = createScope(root, preset)
  const adminScope = createScope(root, admin, { parent: preset })
  const release = registerToolRow(presetScope.ctx, { store, now: () => 0 })
  try {
    assert.deepEqual(root.tools.schemas().map((tool) => tool.name), [])
    assert.deepEqual((await root.systemPrompt.assemble({ scope: ordinary })).tools.map((tool) => tool.name), [])
    assert.deepEqual((await root.systemPrompt.assemble({ scope: admin })).tools.map((tool) => tool.name), ['boss_simulator'])
    release()
    assert.deepEqual((await root.systemPrompt.assemble({ scope: admin })).tools.map((tool) => tool.name), [])
  } finally {
    await adminScope.dispose()
    await ordinaryScope.dispose()
    await presetScope.dispose()
  }
})
