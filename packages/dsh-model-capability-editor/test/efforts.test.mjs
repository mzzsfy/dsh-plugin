// BDD:档位勾选状态 ↔ reasoningEfforts 写回值的双向映射(四态判定表 + 拼写回填)

import test from 'node:test'
import assert from 'node:assert/strict'
import { effortsToDrafts, draftsToEfforts, OFF_LEVEL } from '../src/logic.mjs'

const NO_CHECKS = { checked: {}, spellings: {} }

const checks = (list, spellings = {}) => ({
  checked: Object.fromEntries(list.map((level) => [level, true])),
  spellings,
})

test('全不勾选 → 删除字段(undefined)', () => {
  assert.equal(draftsToEfforts(NO_CHECKS, { off: null }), undefined)
})

test('仅勾选 off 且拼写留空 → false(禁用推理)', () => {
  assert.equal(draftsToEfforts(checks([OFF_LEVEL]), undefined), false)
})

test('off 勾选拼写留空且存在其他勾选档 → 对象形态 off: null', () => {
  assert.deepEqual(
    draftsToEfforts(checks([OFF_LEVEL, 'low']), {}),
    { off: null, low: 'low' },
  )
})

test('off 勾选且拼写填值 → 对象形态 off 为拼写', () => {
  assert.deepEqual(
    draftsToEfforts(checks([OFF_LEVEL, 'high'], { off: 'none', high: 'ultra' }), {}),
    { off: 'none', high: 'ultra' },
  )
})

test('非 off 档拼写留空 → 写档位名', () => {
  assert.deepEqual(draftsToEfforts(checks(['low', 'medium']), {}), { low: 'low', medium: 'medium' })
})

test('非 off 档拼写填值 → 写拼写', () => {
  assert.deepEqual(
    draftsToEfforts(checks(['low'], { low: 'minimal' }), {}),
    { low: 'minimal' },
  )
})

test('对象形态保留基线中词汇表外的档位', () => {
  const baseline = { minimal: 'min', off: null }
  assert.deepEqual(
    draftsToEfforts(checks(['off', 'high'], { high: 'hi' }), baseline),
    { minimal: 'min', off: null, high: 'hi' },
  )
})

test('false 写回值回填为仅勾选 off', () => {
  assert.deepEqual(effortsToDrafts(false), checks([OFF_LEVEL]))
})

test('对象写回值回填勾选与拼写,null 拼写为空', () => {
  assert.deepEqual(
    effortsToDrafts({ off: null, high: 'ultra' }),
    { checked: { [OFF_LEVEL]: true, high: true }, spellings: { [OFF_LEVEL]: '', high: 'ultra' } },
  )
})

test('未声明回填为无任何勾选', () => {
  assert.deepEqual(effortsToDrafts(undefined), NO_CHECKS)
})
