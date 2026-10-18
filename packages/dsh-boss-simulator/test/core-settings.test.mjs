// 设置契约测试:乐观锁冲突/保存成功/字段校验(DATA-06/INT-16)
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { createSettings, saveSettings, validateSettingsValues } from '../lib/core/settings.mjs'

test('保存成功递增 revision;冲突返回 CONFIG_CONFLICT', () => {
  const s = createSettings(() => 1)
  const saved = saveSettings(s, { expectedConfigRevision: 1, values: { concurrencyReference: 3 } })
  assert.ok(saved.ok, saved.message)
  assert.equal(saved.result.configRevision, 2)
  assert.equal(saved.result.values.concurrencyReference, 3)
  const conflict = saveSettings(saved.result, { expectedConfigRevision: 1, values: { concurrencyReference: 4 } })
  assert.equal(conflict.ok, false)
  assert.equal(conflict.code, 'CONFIG_CONFLICT')
  assert.equal(saved.result.values.concurrencyReference, 3, '冲突不覆盖既有值')
})

test('字段校验: 非法值拒绝,null=跟随默认', () => {
  assert.equal(validateSettingsValues({ concurrencyReference: 0 }).ok, false)
  assert.equal(validateSettingsValues({ concurrencyReference: null }).ok, true)
  assert.equal(validateSettingsValues({ nope: 1 }).ok, false)
})
