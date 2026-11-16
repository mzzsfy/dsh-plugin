import { test } from 'node:test'
import assert from 'node:assert/strict'

import { DEFAULTS, resolveConfig } from '../src/config.mjs'
import { NAMESPACE, PANEL_FIELDS, panelDefaults } from '../src/settings.mjs'

test('面板值覆盖 cordis 配置', () => {
  const resolved = resolveConfig({ graceMs: 1_000 }, { graceMs: 7_000 })
  assert.equal(resolved.graceMs, 7_000)
})

test('面板缺字段时回落 cordis 配置', () => {
  const resolved = resolveConfig({ graceMs: 1_000, cooldownMs: 5_000 }, { graceMs: 7_000 })
  assert.equal(resolved.graceMs, 7_000)
  assert.equal(resolved.cooldownMs, 5_000)
})

test('面板与 cordis 都缺时回落默认值', () => {
  const resolved = resolveConfig({}, {})
  assert.equal(resolved.graceMs, DEFAULTS.graceMs)
  assert.equal(resolved.closureText, DEFAULTS.closureText)
})

test('面板的布尔值 false 不被 cordis 值顶掉', () => {
  const resolved = resolveConfig({ scanOnBoot: true }, { scanOnBoot: false })
  assert.equal(resolved.scanOnBoot, false)
})

test('面板的 paused 生效', () => {
  const resolved = resolveConfig({}, { paused: true })
  assert.equal(resolved.paused, true)
})

test('面板未暴露的字段仍由 cordis 配置决定', () => {
  const resolved = resolveConfig({ backoffFactor: 3 }, { graceMs: 1_000 })
  assert.equal(resolved.backoffFactor, 3)
})

test('设置命名空间稳定', () => {
  assert.equal(NAMESPACE, 'keep-working')
})

test('默认不区分永久错误:全部重试', () => {
  assert.equal(DEFAULTS.classify, false)
  assert.equal(resolveConfig({}, {}).classify, false)
  assert.equal(resolveConfig({}, { classify: true }).classify, true)
})

test('结案强制开关默认开启且可关闭', () => {
  assert.equal(DEFAULTS.enforceClosure, true)
  assert.equal(resolveConfig({}, {}).enforceClosure, true)
  assert.equal(resolveConfig({}, { enforceClosure: false }).enforceClosure, false)
  assert.equal(resolveConfig({ enforceClosure: false }, {}).enforceClosure, false)
})

test('面板字段覆盖关键项', () => {
  for (const key of ['paused', 'enforceClosure', 'graceMs', 'cooldownMs', 'maxConsecutive', 'closureText', 'restartText']) {
    assert.ok(PANEL_FIELDS.includes(key), `缺少 ${key}`)
  }
})

test('面板默认值来自 DEFAULTS', () => {
  assert.equal(panelDefaults().graceMs, DEFAULTS.graceMs)
  assert.equal(panelDefaults().continueText, DEFAULTS.continueText)
  assert.equal(panelDefaults().restartText, DEFAULTS.restartText)
})

test('重启恢复文案与实时中断文案相互独立', () => {
  assert.notEqual(DEFAULTS.restartText, DEFAULTS.continueTextInterrupted)
  const resolved = resolveConfig({}, { restartText: '继续,dsh 刚重启' })
  assert.equal(resolved.restartText, '继续,dsh 刚重启')
  assert.equal(resolved.continueTextInterrupted, DEFAULTS.continueTextInterrupted, '改重启文案不得带动实时中断文案')
})

test('重启恢复文案留空时回落默认而不是发空消息', () => {
  const resolved = resolveConfig({}, { restartText: '   ' })
  assert.equal(resolved.restartText, DEFAULTS.restartText)
})
