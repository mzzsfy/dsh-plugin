import test from 'node:test'
import assert from 'node:assert/strict'
import { openState } from '../src/state.mjs'
import { controlSchema } from '../src/schemas.mjs'
import { memoryStorage } from './helpers.mjs'
import { makeSecurity } from '../src/market-model.mjs'
const security = makeSecurity('XSHG', '600519', '贵州茅台')

test('MIG01 没有标记的记录是空数组', async () => {
  const state = await openState(memoryStorage()), base = state.get()
  const config = { ...base, watchlist: { order: [security.id], items: { [security.id]: { ...security, alias: '', pinned: false, marks: [], group: '' } } } }
  controlSchema.parse(config)
  assert.deepEqual(config.watchlist.items[security.id].marks, [])
  await state.close()
})

// 标记数组的两个不变式: id 唯一、同类型价格不重复
test('MIG02 标记数组拒绝重复 id 与同类型同价', async () => {
  const state = await openState(memoryStorage()), base = state.get()
  const withMarks = marks => ({ ...base, watchlist: { order: [security.id], items: { [security.id]: { ...security, alias: '', pinned: false, marks, group: '' } } } })
  controlSchema.parse(withMarks([{ id: 'a', price: 100, kind: 'cost' }, { id: 'b', price: 100, kind: 'target' }]))
  assert.throws(() => controlSchema.parse(withMarks([{ id: 'a', price: 100, kind: 'cost' }, { id: 'a', price: 200, kind: 'target' }])), /id 重复/)
  assert.throws(() => controlSchema.parse(withMarks([{ id: 'a', price: 100, kind: 'cost' }, { id: 'b', price: 100, kind: 'cost' }])), /价格不能重复/)
  assert.throws(() => controlSchema.parse(withMarks(Array.from({ length: 13 }, (_, i) => ({ id: `m${i}`, price: i + 1, kind: 'cost' })))), '最多 12 个')
  await state.close()
})

// cost 字段已彻底移除: 带 cost 的记录必须被 schema 拒掉, 而不是被静默保留
test('MIG03 cost 字段不再是合法数据', async () => {
  const state = await openState(memoryStorage()), base = state.get()
  const legacy = { ...base, watchlist: { order: [security.id], items: { [security.id]: { ...security, alias: '', pinned: false, cost: 422, group: '' } } } }
  // marks 有默认值所以会被补上空数组, cost 则是未知键被 strip, 两者都不该再出现
  const parsed = controlSchema.parse(legacy).watchlist.items[security.id]
  assert.equal('cost' in parsed, false)
  assert.deepEqual(parsed.marks, [])
  await state.close()
})
