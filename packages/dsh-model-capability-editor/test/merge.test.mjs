// BDD:整组写回基线合并 — 未编辑条目原样保留;settings 未声明的模型不被删除;
// 孤儿草稿(模型已被他方删除)可观测,不静默丢弃。
import test from 'node:test'
import assert from 'node:assert/strict'
import { mergeBaselineModels, INPUT_TEXT_IMAGE } from '../src/logic.mjs'

const draft = (overrides) => ({
  checked: { off: true, high: true },
  spellings: { off: '', high: 'ultra' },
  inputMode: INPUT_TEXT_IMAGE,
  ...overrides,
})

const baseline = [
  { id: 'auto', name: 'Auto', reasoningEfforts: { off: null }, input: [] },
  { id: 'plain', compat: { supportsTemperature: false } },
]

test('未编辑条目原样保留(同一引用)', () => {
  const { models } = mergeBaselineModels(baseline, new Map())
  assert.equal(models[1], baseline[1])
  assert.deepEqual(models, baseline)
})

test('编辑条目仅写两字段,其余字段保留;词汇表外档位按最新条目基线透传', () => {
  const { models } = mergeBaselineModels(baseline, new Map([['auto', draft()]]))
  assert.equal(models[0].name, 'Auto')
  assert.deepEqual(models[0].reasoningEfforts, { off: null, high: 'ultra' })
  assert.deepEqual(models[0].input, ['text', 'image'])
})

test('草稿三态为未声明时删除 input 字段', () => {
  const { models } = mergeBaselineModels(baseline, new Map([['auto', draft({ inputMode: 'unset' })]]))
  assert.equal('input' in models[0], false)
})

test('未编辑的模型条目数量与顺序不变', () => {
  const { models } = mergeBaselineModels(baseline, new Map([['plain', draft()]]))
  assert.deepEqual(models.map((model) => model.id), ['auto', 'plain'])
})

test('冲突重放:透传基线取最新条目值,他方新增词汇表外档位不丢', () => {
  // 他方在草稿加载后给 auto 新增词汇表外档位 custom64k
  const latest = [
    { id: 'auto', name: 'Auto', reasoningEfforts: { off: null, custom64k: 'thinking-64k' }, input: [] },
  ]
  const drafts = new Map([['auto', draft({ checked: { high: true }, spellings: { high: 'ultra' } })]])
  const { models } = mergeBaselineModels(latest, drafts)
  // 词汇表内键由勾选决定(off 未勾不写回);词汇表外键从写回时点最新条目透传
  assert.deepEqual(
    models[0].reasoningEfforts,
    { custom64k: 'thinking-64k', high: 'ultra' },
    '外档位必须来自写回时点最新条目,而非草稿快照',
  )
})

test('孤儿草稿:模型已被他方删除时草稿不落盘且 droppedDraftIds 可观测', () => {
  const drafts = new Map([
    ['auto', draft()],
    ['ghost', draft({ checked: { low: true }, spellings: {} })],
  ])
  const { models, droppedDraftIds } = mergeBaselineModels(baseline, drafts)
  assert.deepEqual(models.map((model) => model.id), ['auto', 'plain'])
  assert.deepEqual(droppedDraftIds, ['ghost'])
})

test('无孤儿草稿时 droppedDraftIds 为空数组', () => {
  const { droppedDraftIds } = mergeBaselineModels(baseline, new Map([['auto', draft()]]))
  assert.deepEqual(droppedDraftIds, [])
})

test('基线为不可表达形态(字符串)的条目跳过档位重写,其余字段照常', () => {
  const weird = [{ id: 'str', reasoningEfforts: 'high', input: ['text'] }]
  const { models } = mergeBaselineModels(weird, new Map([['str', draft({ checked: { low: true }, spellings: {} })]]))
  assert.equal(models[0].reasoningEfforts, 'high', '字符串形态基线原样保留')
  assert.deepEqual(models[0].input, ['text', 'image'], 'input 照常重写')
})
