// index 行分发 BDD:board 角色激活路径;配置存自有文件,无 settings 行
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { apply, Config, SPEC_TEXT } from '../lib/index.js'

test('Given Config When 非法 role Then 抛错;board Then 通过', () => {
  assert.throws(() => Config({ role: 'ghost' }))
  assert.throws(() => Config({ role: 'settings' }))
  assert.doesNotThrow(() => Config({ role: 'board' }))
})

test('Given SPEC_TEXT 导出 When 检查契约 Then v5 契约与 JSON 口径齐备', () => {
  assert.ok(SPEC_TEXT.includes('"type": "approve"'))
  assert.ok(SPEC_TEXT.includes('inputs'))
  assert.ok(SPEC_TEXT.includes('严格 JSON'))
  assert.ok(SPEC_TEXT.includes('autoApprove'))
  assert.ok(SPEC_TEXT.includes('(v5)'))
  assert.equal(SPEC_TEXT.includes('<output'), false)
  assert.equal(SPEC_TEXT.includes('教学重问'), false)
  assert.equal(SPEC_TEXT.includes('json5'), false)
})

test('Given board 行且 webServer 缺失 When apply Then 无异常(嵌套 inject 门控)', () => {
  const ctx = { get: () => undefined, inject: () => {} }
  assert.doesNotThrow(() => apply(ctx, { role: 'board' }))
})
