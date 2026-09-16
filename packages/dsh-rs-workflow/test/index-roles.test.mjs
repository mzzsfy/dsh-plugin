// index 行分发 BDD:settings/board 两角色的激活路径与干净禁用
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { apply, Config, SETTINGS_SCHEMA, SPEC_TEXT } from '../lib/index.js'
import { SETTINGS_SCHEMA as SETTINGS_SCHEMA_DIRECT, NAMESPACE } from '../lib/settings-schema.mjs'

const makeCtx = ({ services = {} } = {}) => {
  const injected = []
  const ctx = {
    injected,
    get: (name) => services[name],
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
  assert.doesNotThrow(() => Config({ role: 'settings' }))
  assert.doesNotThrow(() => Config({ role: 'board' }))
})

test('Given SETTINGS_SCHEMA 导出 When 与 settings-schema 直连 Then 同一引用;SPEC_TEXT v4 契约', () => {
  assert.equal(SETTINGS_SCHEMA, SETTINGS_SCHEMA_DIRECT)
  assert.ok(SPEC_TEXT.includes('type: "approve"'))
  assert.ok(SPEC_TEXT.includes('inputs'))
  assert.equal(SPEC_TEXT.includes('<output'), false)
  assert.equal(SPEC_TEXT.includes('教学重问'), false)
})
