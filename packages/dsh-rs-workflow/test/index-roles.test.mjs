// index 行分发 BDD:五角色的激活路径与干净禁用;template-tool 四 action
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply, Config, registerTemplateTool, SETTINGS_SCHEMA, SPEC_TEXT } from '../lib/index.js'
import { createTemplateTool } from '../lib/template-tool.mjs'
import { SETTINGS_SCHEMA as SETTINGS_SCHEMA_DIRECT, NAMESPACE, normalizeConfig } from '../lib/settings-schema.mjs'

const makeCtx = ({ services = {}, logger } = {}) => {
  const injected = []
  const ctx = {
    injected,
    get: (name) => services[name],
    logger,
    // 门控语义:声明的服务存在才回调(缺失即干净禁用,fn 不执行)
    inject: (names, fn) => {
      injected.push(names)
      if (names.every((n) => services[n] !== undefined)) fn(services)
    },
  }
  return ctx
}

const settingsService = (store = {}) => ({
  get: () => store,
  update: async (ns, patch) => Object.assign(store, patch),
  registerCalls: [],
  register(ns, schema, opts) {
    this.registerCalls.push({ ns, schema, opts })
  },
})

test('Given settings 行 When apply Then 注册命名空间 schema 且 base 三节', () => {
  const settings = settingsService()
  const ctx = makeCtx({ services: { settings } })
  apply(ctx, { role: 'settings' })
  assert.equal(settings.registerCalls.length, 1)
  assert.equal(settings.registerCalls[0].ns, NAMESPACE)
  assert.equal(settings.registerCalls[0].schema, SETTINGS_SCHEMA)
  assert.deepEqual(Object.keys(settings.registerCalls[0].opts.base).sort(), ['budgets', 'slots', 'templates'])
})

test('Given settings 服务缺失 When settings 行 Then inject 声明后静默(干净禁用,不抛错)', () => {
  const ctx = makeCtx({})
  assert.doesNotThrow(() => apply(ctx, { role: 'settings' }))
})

test('Given board 行且 webServer 缺失 When apply Then 无异常(嵌套 inject 门控)', () => {
  const ctx = makeCtx({})
  assert.doesNotThrow(() => apply(ctx, { role: 'board' }))
})

test('Given Config When 非法 role Then 抛错;合法 role Then 通过', () => {
  assert.throws(() => Config({ role: 'ghost' }))
  assert.doesNotThrow(() => Config({ role: 'release' }))
})

test('Given SETTINGS_SCHEMA 导出 When 与 settings-schema 直连 Then 同一引用;SPEC_TEXT v4 契约', () => {
  assert.equal(SETTINGS_SCHEMA, SETTINGS_SCHEMA_DIRECT)
  assert.ok(SPEC_TEXT.includes('type: "approve"'))
  assert.ok(SPEC_TEXT.includes('inputs'))
  assert.equal(SPEC_TEXT.includes('<output'), false)
  assert.equal(SPEC_TEXT.includes('教学重问'), false)
})

test('Given template-tool 行且 tools 缺失 When apply Then 无异常', () => {
  const ctx = makeCtx({})
  assert.doesNotThrow(() => apply(ctx, { role: 'template-tool' }))
})

// ── template-tool 四 action(注入面直驱,不经宿主) ──────────────────────────
const toolHarness = ({ templates = [], settingsStore = {}, logger } = {}) => {
  const registered = []
  let value = { templates: [...templates] }
  const settings = {
    get: () => value,
    update: async (ns, patch) => Object.assign(value, patch),
  }
  const released = []
  const unreleased = []
  const tool = createTemplateTool({
    getTemplates: async () => value.templates ?? [],
    setTemplates: async (t) => {
      value.templates = t
    },
    removeTemplate: async (id) => {
      const raw = value.templates ?? []
      const next = raw.filter((t) => t.id !== id)
      if (next.length === raw.length) return { ok: false, error: '模板不存在: ' + id }
      value.templates = next
      unreleased.push(id)
      return { ok: true, templates: next }
    },
    releaseTemplate: async (entry) => {
      released.push(entry.id)
      return true
    },
    unreleaseTemplate: async (id) => {
      unreleased.push(id)
    },
    logger,
  })
  return { tool, registered, released, unreleased, value: () => value, settings }
}

const GOOD_TPL = { id: 't1', label: 'x', steps: [{ id: 'a', prompt: 'p', outputs: { o: 'o' } }] }

test('Given template-tool When spec Then 返回 v4 规范原文;When list Then 返回归一模板', async () => {
  const h = toolHarness({ templates: [{ id: 'a', json5: '' }] })
  const r1 = await h.tool.execute({ action: 'spec' })
  assert.equal(r1.ok, true)
  assert.ok(r1.spec.includes('DSL 规范'))
  const r2 = await h.tool.execute({ action: 'list' })
  assert.deepEqual(r2.templates, [{ id: 'a', label: '', description: '', enabled: true, json5: '' }])
})

const tplIds = (h) => (h.value().templates ?? []).map((t) => t.id)

test('Given 合法模板 When save release:true Then 落盘并创建;dryRun:true Then 不落盘', async () => {
  const h = toolHarness()
  const r1 = await h.tool.execute({ action: 'save', template: { id: 't1', json5: JSON.stringify(GOOD_TPL) }, dryRun: true })
  assert.equal(r1.ok, true)
  assert.equal(tplIds(h).includes('t1'), false)
  const r2 = await h.tool.execute({ action: 'save', template: { id: 't1', json5: JSON.stringify(GOOD_TPL) }, release: true })
  assert.equal(r2.ok, true)
  assert.deepEqual(h.released, ['t1'])
  assert.deepEqual(tplIds(h), ['t1'])
})

test('Given 模板含未知字段 When save Then errors 逐条且不落盘', async () => {
  const h = toolHarness()
  const bad = { ...GOOD_TPL, steps: [{ ...GOOD_TPL.steps[0], ghostField: 1 }] }
  const r = await h.tool.execute({ action: 'save', template: { id: 't1', json5: JSON.stringify(bad) } })
  assert.equal(r.ok, false)
  assert.ok(r.errors.length > 0)
  assert.equal(tplIds(h).includes('t1'), false)
})

test('Given id 不一致 When save Then errors 提示;Given remove 存在 id Then 删除并移除模式', async () => {
  const h = toolHarness({ templates: [{ id: 't1', json5: JSON.stringify(GOOD_TPL) }] })
  const r1 = await h.tool.execute({ action: 'save', template: { id: 'other', json5: JSON.stringify(GOOD_TPL) } })
  assert.equal(r1.ok, false)
  const r2 = await h.tool.execute({ action: 'remove', id: 't1' })
  assert.equal(r2.ok, true)
  assert.deepEqual(h.unreleased, ['t1'])
  const r3 = await h.tool.execute({ action: 'remove', id: 'nope' })
  assert.equal(r3.ok, false)
})

test('Given takeover 行且 workflowEngine 缺失 When apply Then 干净禁用:inject 声明存在但门控未回调', () => {
  const home = mkdtempSync(join(tmpdir(), 'rsww-roles-takeover-'))
  const flowFile = join(home, 'flow.json5')
  writeFileSync(flowFile, JSON.stringify({ id: 't-role', label: 'x', steps: [{ id: 'a', prompt: 'p', outputs: { o: 'o' } }] }))
  const ctx = makeCtx({})
  // 服务缺失:不抛错,engine 挂接与 agent/pre-step 注册均未发生(门控语义:fn 未执行)
  assert.doesNotThrow(() => apply(ctx, { role: 'takeover', kind: 'flow', flowFile }))
  assert.deepEqual(ctx.injected, [['workflowEngine']])
})

test('Given release 行且存在旧版遗留模式 When apply Then logger.info 播报移除清单;sweep 空则不播报', () => {
  const home = mkdtempSync(join(tmpdir(), 'rsww-sweep-'))
  // sweepLegacyReleases 播报裸 id(目录 rs-legacy-x → id legacy-x)
  mkdirSync(join(home, '.agent-presets', 'rs-legacy-x'), { recursive: true })
  writeFileSync(join(home, '.agent-presets', 'rs-legacy-x', '.dsh-rs-workflow-source.json'), JSON.stringify({ package: '@mzzsfy/dsh-rs-workflow', kind: 'flow', version: '0.9.0' }))
  const empty = mkdtempSync(join(tmpdir(), 'rsww-sweep-empty-'))
  const prev = process.env.DSH_RS_WORKFLOW_PRESET_ROOT
  const infos = []
  const logger = { info: (m) => infos.push(m), warn: () => {} }
  try {
    // sweep.removed 非空:播报且消息含移除清单条目
    process.env.DSH_RS_WORKFLOW_PRESET_ROOT = home
    apply(makeCtx({ logger }), { role: 'release' })
    assert.equal(infos.length, 1)
    assert.ok(infos[0].includes('移除'))
    assert.ok(infos[0].includes('legacy-x'))
    assert.ok(infos[0].includes('移除'))
    // sweep.removed 为空:钉住 removed.length 判定,不播报
    process.env.DSH_RS_WORKFLOW_PRESET_ROOT = empty
    apply(makeCtx({ logger }), { role: 'release' })
    assert.equal(infos.length, 1)
  } finally {
    if (prev === undefined) delete process.env.DSH_RS_WORKFLOW_PRESET_ROOT
    else process.env.DSH_RS_WORKFLOW_PRESET_ROOT = prev
  }
})
