// 配置归一化:面板可填任意正整数,时长没有上界等于把恢复实际关掉
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { resolveConfig } from '../src/config.mjs'

test('时长字段超上界按上界截断', () => {
  const config = resolveConfig({
    graceMs: 999_999_999,
    cooldownMs: 999_999_999,
    backoffMaxMs: 999_999_999,
    freshMs: 999_999_999,
  })
  assert.equal(config.graceMs, 5 * 60 * 1000)
  assert.equal(config.cooldownMs, 60 * 60 * 1000)
  assert.equal(config.backoffMaxMs, 24 * 60 * 60 * 1000)
  assert.equal(config.freshMs, 7 * 24 * 60 * 60 * 1000)
})

test('非法时长回落默认而不是归零', () => {
  const config = resolveConfig({ graceMs: -1, freshMs: Number.NaN })
  assert.ok(config.graceMs >= 0)
  assert.ok(config.freshMs > 0)
})
