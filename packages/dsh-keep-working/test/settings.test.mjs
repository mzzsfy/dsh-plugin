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

test('面板字段覆盖关键项', () => {
  for (const key of ['paused', 'graceMs', 'cooldownMs', 'maxConsecutive', 'closureText']) {
    assert.ok(PANEL_FIELDS.includes(key), `缺少 ${key}`)
  }
})

test('面板默认值来自 DEFAULTS', () => {
  assert.equal(panelDefaults().graceMs, DEFAULTS.graceMs)
  assert.equal(panelDefaults().continueText, DEFAULTS.continueText)
})
