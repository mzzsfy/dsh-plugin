// BDD:input 多模态三态映射

import test from 'node:test'
import assert from 'node:assert/strict'
import { inputToMode, modeToInput, INPUT_UNSET, INPUT_TEXT, INPUT_TEXT_IMAGE } from '../src/logic.mjs'

test('未声明 / null / 空数组 → 未声明', () => {
  for (const value of [undefined, null, []]) assert.equal(inputToMode(value), INPUT_UNSET)
})

test('仅文本 → text 态', () => {
  assert.equal(inputToMode(['text']), INPUT_TEXT)
})

test('含 image → 文本+图像态', () => {
  assert.equal(inputToMode(['text', 'image']), INPUT_TEXT_IMAGE)
})

test('三态 → 写回值,未声明为 undefined(删除字段)', () => {
  assert.deepEqual(modeToInput(INPUT_TEXT), ['text'])
  assert.deepEqual(modeToInput(INPUT_TEXT_IMAGE), ['text', 'image'])
  assert.equal(modeToInput(INPUT_UNSET), undefined)
})
