import test from 'node:test'
import assert from 'node:assert/strict'
import { openState } from '../src/state.mjs'
import { controlSchema, storedControlSchema, initialControl } from '../src/schemas.mjs'
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

// 数据源实例的凭据字段曾叫 credentialEnv。迁移放在数据域的 valueSchema 上, 因为
// storageDomain.open 就先按它校验存量记录, 应用层 openState 里做的事到那一步已经来不及。
const legacyProvider = extra => ({ id: 'ts-one', adapterId: 'tushare', enabled: true, credentialEnv: 'DSH_STOCK_TUSHARE_TOKEN', quotaGroup: 'account-one', budget: { requestsPerMinute: 50, dailyRequestLimit: null, billingUnit: 'request', symbolCreditsPerMinute: null, capabilityLimits: { quotes: 50 } }, ...extra })
const legacyRoot = providers => ({ ...initialControl(), providers, routes: [] })

test('MIG04 存量 credentialEnv 记录在数据域读入时归一为 credentialRef', () => {
  const parsed = storedControlSchema.parse(legacyRoot([legacyProvider()]))
  assert.equal(parsed.providers[0].credentialRef, 'DSH_STOCK_TUSHARE_TOKEN', '引用名原样搬过去')
  assert.equal('credentialEnv' in parsed.providers[0], false, '旧字段不再留着')
})

test('MIG05 免凭据实例的 credentialEnv=null 同样迁移为 null', () => {
  const parsed = storedControlSchema.parse(legacyRoot([legacyProvider({ credentialEnv: null })]))
  assert.equal(parsed.providers[0].credentialRef, null)
})

// 同一份记录新旧字段并存时旧值不能反过来盖掉新值, 只带新字段的条目也不能被顺手清空
test('MIG06 新旧字段并存以新字段为准, 且不牵连其他条目', () => {
  const fresh = { ...legacyProvider(), id: 'em', adapterId: 'eastmoney', credentialRef: null, quotaGroup: 'free' }
  delete fresh.credentialEnv
  const parsed = storedControlSchema.parse(legacyRoot([legacyProvider({ credentialRef: 'DSH_STOCK_NEW_TOKEN' }), fresh]))
  assert.equal(parsed.providers[0].credentialRef, 'DSH_STOCK_NEW_TOKEN')
  assert.equal(parsed.providers[1].credentialRef, null)
  assert.equal('credentialEnv' in parsed.providers[0], false)
})

// 归一函数遇到非对象条目原样放行, 由 schema 拒绝: 不能在这里抛 TypeError 把整个域打成 invalid-record 之外的错误
test('MIG07 providers 含非对象条目时由 schema 拒绝而不是抛 TypeError', () => {
  const legacy = legacyRoot([legacyProvider(), null])
  assert.throws(() => storedControlSchema.parse(legacy))
})
