// BDD:模型页注入的纯判定逻辑——标题标记匹配、锚点破坏判定、行展开区定位。

import test from 'node:test'
import assert from 'node:assert/strict'
import { isModelsTitle, anchorsBroken, advancedAreaChild } from '../src/logic.mjs'

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

test('行展开区定位:箭头点开(行头后有展开块)→ 返回展开块', () => {
  const modelRow = { tag: 'modelRow' }
  const advanced = { tag: 'modelAdvanced' }
  assert.equal(advancedAreaChild([modelRow, advanced], modelRow), advanced)
})

test('行展开区定位:箭头未点开(官方条件渲染,DOM 无展开块)→ null,面板不得注入', () => {
  const modelRow = { tag: 'modelRow' }
  assert.equal(advancedAreaChild([modelRow], modelRow), null)
  assert.equal(advancedAreaChild([], modelRow), null)
})

test('行展开区定位:展开块在行头之前仍按非行头判定;多子元素取首个非行头', () => {
  const modelRow = { tag: 'modelRow' }
  const advanced = { tag: 'modelAdvanced' }
  assert.equal(advancedAreaChild([advanced, modelRow], modelRow), advanced)
  assert.equal(advancedAreaChild([modelRow, advanced, { tag: 'x' }], modelRow), advanced)
})
