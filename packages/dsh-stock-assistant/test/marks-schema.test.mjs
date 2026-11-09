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

// 数据源实例的凭据字段曾叫 credentialEnv;不做这步, 存量配置会因为缺 credentialRef 且多出未知键而读不出来
test('MIG04 存量 credentialEnv 改名成 credentialRef 后仍可读', async () => {
  const storage = memoryStorage()
  const legacyProvider = { id: 'ts-one', adapterId: 'tushare', enabled: true, credentialEnv: 'DSH_STOCK_TUSHARE_TOKEN', quotaGroup: 'account-one', budget: { requestsPerMinute: 50, dailyRequestLimit: null, billingUnit: 'request', symbolCreditsPerMinute: null, capabilityLimits: { quotes: 50 } } }
  const root = storage.maps.control.get('root')
  storage.maps.control.set('root', { ...root, providers: [legacyProvider], routes: [] })
  const state = await openState(storage)
  const provider = state.get().providers[0]
  assert.equal(provider.credentialRef, 'DSH_STOCK_TUSHARE_TOKEN', '引用名原样搬过去')
  assert.equal('credentialEnv' in provider, false, '旧字段不再留着')
  assert.equal(storage.maps.control.get('root').providers[0].credentialRef, 'DSH_STOCK_TUSHARE_TOKEN', '改名结果落盘')
  await state.close()
})

test('MIG05 免凭据实例的 credentialEnv=null 同样迁移为 null', async () => {
  const storage = memoryStorage()
  const root = storage.maps.control.get('root')
  storage.maps.control.set('root', { ...root, providers: [{ id: 'em', adapterId: 'eastmoney', enabled: true, credentialEnv: null, quotaGroup: 'free', budget: { requestsPerMinute: 60, dailyRequestLimit: null, billingUnit: 'request', symbolCreditsPerMinute: null, capabilityLimits: {} } }], routes: [] })
  const state = await openState(storage)
  assert.equal(state.get().providers[0].credentialRef, null)
  await state.close()
})
