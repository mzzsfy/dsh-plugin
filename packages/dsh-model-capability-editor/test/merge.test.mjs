// BDD:整组写回基线合并 — 未编辑条目原样保留,settings 未声明的模型不被删除

import test from 'node:test'
import assert from 'node:assert/strict'
import { mergeBaselineModels, INPUT_TEXT_IMAGE } from '../src/logic.mjs'

const draft = (overrides) => ({
  checked: { off: true, high: true },
  spellings: { off: '', high: 'ultra' },
  baselineEfforts: { off: null },
  inputMode: INPUT_TEXT_IMAGE,
  ...overrides,
})

const baseline = [
  { id: 'auto', name: 'Auto', reasoningEfforts: { off: null }, input: [] },
  { id: 'plain', compat: { supportsTemperature: false } },
]

test('未编辑条目原样保留(同一引用)', () => {
  const merged = mergeBaselineModels(baseline, new Map())
  assert.equal(merged[1], baseline[1])
  assert.deepEqual(merged, baseline)
})

test('编辑条目仅写两字段,其余字段保留', () => {
  const merged = mergeBaselineModels(baseline, new Map([['auto', draft()]]))
  assert.equal(merged[0].name, 'Auto')
  assert.deepEqual(merged[0].reasoningEfforts, { off: null, high: 'ultra' })
  assert.deepEqual(merged[0].input, ['text', 'image'])
})

test('草稿三态为未声明时删除 input 字段', () => {
  const merged = mergeBaselineModels(baseline, new Map([['auto', draft({ inputMode: 'unset' })]]))
  assert.equal('input' in merged[0], false)
})

test('未编辑的模型条目数量与顺序不变', () => {
  const merged = mergeBaselineModels(baseline, new Map([['plain', draft()]]))
  assert.deepEqual(merged.map((model) => model.id), ['auto', 'plain'])
})
