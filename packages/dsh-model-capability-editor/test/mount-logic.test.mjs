// BDD:模型页注入的纯判定逻辑——标题标记匹配、锚点破坏判定。

import test from 'node:test'
import assert from 'node:assert/strict'
import { isModelsTitle, anchorsBroken, resolveTargetId } from '../src/logic.mjs'

test('标题标记:官方模型页标题中英匹配,其余分区不匹配', () => {
  assert.equal(isModelsTitle('模型'), true)
  assert.equal(isModelsTitle('Models'), true)
  assert.equal(isModelsTitle('模型能力'), false)
  assert.equal(isModelsTitle('通用设置'), false)
  assert.equal(isModelsTitle(''), false)
  assert.equal(isModelsTitle(undefined), false)
})

test('锚点破坏:标题匹配且官方编辑器存在,但找不到任何模型ID输入', () => {
  assert.equal(anchorsBroken({ titleMatched: true, hasEditor: true, modelIdInputCount: 0 }), true)
})

test('未破坏:找到了模型ID输入', () => {
  assert.equal(anchorsBroken({ titleMatched: true, hasEditor: true, modelIdInputCount: 2 }), false)
})

test('未破坏:标题不匹配(用户在其他分区)', () => {
  assert.equal(anchorsBroken({ titleMatched: false, hasEditor: true, modelIdInputCount: 0 }), false)
})

test('未破坏:官方编辑器尚未打开(无 details 折叠区)', () => {
  assert.equal(anchorsBroken({ titleMatched: true, hasEditor: false, modelIdInputCount: 0 }), false)
})

test('目标解析:官方行内活动 ID 已在基线 → 以活动 ID 为准(用户已保存改名)', () => {
  assert.equal(resolveTargetId('auto-v2', 'auto', new Set(['auto', 'auto-v2'])), 'auto-v2')
})

test('目标解析:活动 ID 不在基线(改名未落盘)→ 回落原 ID,写回必然命中', () => {
  assert.equal(resolveTargetId('auto-v2', 'auto', new Set(['auto'])), 'auto')
})

test('目标解析:活动 ID 为空或输入已脱离文档 → 回落原 ID', () => {
  assert.equal(resolveTargetId('', 'auto', new Set(['auto'])), 'auto')
  assert.equal(resolveTargetId(undefined, 'auto', new Set(['auto'])), 'auto')
})
