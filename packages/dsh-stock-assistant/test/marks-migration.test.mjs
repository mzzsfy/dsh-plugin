import test from 'node:test'
import assert from 'node:assert/strict'
import { openState } from '../src/state.mjs'
import { controlSchema } from '../src/schemas.mjs'
import { memoryStorage } from './helpers.mjs'
import { makeSecurity } from '../src/market-model.mjs'
const security = makeSecurity('XSHG', '600519', '贵州茅台')

// 成本价曾是单值字段, 现在是带语义的价格标记列表; 升级在加载时一次完成
test('MIG01 旧的 cost 字段升级成一条 cost 标记', async () => {
  const storage = memoryStorage()
  // 直接写入旧形状: schema 已经不认识 cost 了, 所以绕开校验手工落盘
  const legacy = { revision: 7, routingRevision: 0, watchlist: { order: [security.id], items: { [security.id]: { ...security, alias: '', pinned: false, cost: 422, group: '' } } }, preferences: { refreshSeconds: 15, colorMode: 'red-up' }, providers: [], routes: [], operations: [] }
  const domain = await storage.open({ id: 'stock-assistant', version: 1, migrations: [] })
  await domain.table('control').put('root', legacy)
  await domain.close()
  const state = await openState(storage)
  const item = state.get().watchlist.items[security.id]
  assert.equal('cost' in item, false, 'cost 字段必须彻底消失')
  assert.deepEqual(item.marks, [{ id: 'm-legacy', price: 422, kind: 'cost' }], '旧值要变成一条成本标记')
  await state.close()
})

test('MIG02 没有 cost 的记录不会被塞上标记', async () => {
  const state = await openState(memoryStorage()), base = state.get()
  const config = { ...base, watchlist: { order: [security.id], items: { [security.id]: { ...security, alias: '', pinned: false, marks: [], group: '' } } } }
  controlSchema.parse(config)
  assert.deepEqual(config.watchlist.items[security.id].marks, [])
  await state.close()
})

// 标记数组的两个不变式: id 唯一、同类型价格不重复
test('MIG03 标记数组拒绝重复 id 与同类型同价', async () => {
  const state = await openState(memoryStorage()), base = state.get()
  const withMarks = marks => ({ ...base, watchlist: { order: [security.id], items: { [security.id]: { ...security, alias: '', pinned: false, marks, group: '' } } } })
  controlSchema.parse(withMarks([{ id: 'a', price: 100, kind: 'cost' }, { id: 'b', price: 100, kind: 'target' }]))
  assert.throws(() => controlSchema.parse(withMarks([{ id: 'a', price: 100, kind: 'cost' }, { id: 'a', price: 200, kind: 'target' }])), /id 重复/)
  assert.throws(() => controlSchema.parse(withMarks([{ id: 'a', price: 100, kind: 'cost' }, { id: 'b', price: 100, kind: 'cost' }])), /价格不能重复/)
  assert.throws(() => controlSchema.parse(withMarks(Array.from({ length: 13 }, (_, i) => ({ id: `m${i}`, price: i + 1, kind: 'cost' })))), '最多 12 个')
  await state.close()
})
