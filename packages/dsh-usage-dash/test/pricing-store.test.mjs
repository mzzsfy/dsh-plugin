// 定价规则存储:usage_pricing 域单行读写、读入归一、revision 单调、
// 存量导入不覆盖、域打开失败降级。零宿主依赖:facility 桩为内存表。

import test from 'node:test'
import assert from 'node:assert/strict'

import { PricingStore, pricingDomain, sharedPricingStore, __resetSharedPricingStoreForTests } from '../src/pricing-store.js'

const RULE = {
  model: 'default/deepseek-chat',
  currency: '¥',
  price: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
  conditions: [],
}

const tableHandle = (rows) => ({
  get: (key) => rows.get(key),
  entries: () => rows.entries(),
  keys: () => rows.keys(),
  get size() { return rows.size },
  put: async (key, value) => { rows.set(key, value) },
  delete: async (key) => rows.delete(key),
  update: async (key, fn) => {
    if (!rows.has(key)) throw new Error(`no record ${key} to update`)
    const next = fn(rows.get(key))
    rows.set(key, next)
    return next
  },
})

function makeFacility({ failOpen = false } = {}) {
  const tables = new Map()
  const opened = []
  const rows = (name) => {
    if (!tables.has(name)) tables.set(name, new Map())
    return tables.get(name)
  }
  return {
    opened,
    rows,
    async open(spec) {
      opened.push(spec.name)
      if (failOpen) throw new Error('backend-not-found')
      return { name: spec.name, table: (name) => tableHandle(rows(`${spec.name}.${name}`)) }
    },
  }
}

test('域声明:usage_pricing 单表 rules', () => {
  assert.equal(pricingDomain.name, 'usage_pricing')
  assert.deepEqual(Object.keys(pricingDomain.tables), ['rules'])
})

test('打开即读:存量行进内存快照,读入按归一顺序整理', async () => {
  const facility = makeFacility()
  const globalOne = { ...RULE, model: '*/*', price: { ...RULE.price, input: 1 } }
  const globalTwo = { ...RULE, model: '*/*', price: { ...RULE.price, input: 9 } }
  const exact = { ...RULE, model: 'p/m', price: { ...RULE.price, input: 3 } }
  facility.rows('usage_pricing.rules').set('current', {
    rules: [globalOne, exact, globalTwo],
    revision: 4,
    updatedAt: 0,
  })
  const store = new PricingStore(facility)
  await store.readyPromise()
  assert.equal(store.degradation, undefined)
  assert.equal(store.revision(), 4)
  assert.deepEqual(store.rules().map((rule) => [rule.model, rule.price.input]), [['p/m', 3], ['*/*', 1]])
  assert.equal(store.hasRecord(), true)
})

test('replace:整表替换落盘,revision 自增,回读为归一后的规则', async () => {
  const facility = makeFacility()
  const store = new PricingStore(facility)
  await store.readyPromise()
  const globalOne = { ...RULE, model: '*/*', price: { ...RULE.price, input: 1 } }
  const exact = { ...RULE, model: 'p/m', price: { ...RULE.price, input: 3 } }
  const saved = await store.replace([globalOne, exact])
  assert.deepEqual(saved.map((rule) => rule.model), ['p/m', '*/*'])
  const row = facility.rows('usage_pricing.rules').get('current')
  assert.ok(row.revision > 0, '首次写入 revision 为正数')
  assert.deepEqual(row.rules.map((rule) => rule.model), ['p/m', '*/*'])
  const firstRevision = row.revision
  await store.replace([exact])
  assert.equal(store.revision(), firstRevision + 1)
  assert.equal(facility.rows('usage_pricing.rules').get('current').revision, firstRevision + 1)
})

test('并发 replace 串行:revision 不丢号', async () => {
  const facility = makeFacility()
  const store = new PricingStore(facility)
  await store.readyPromise()
  await Promise.all([store.replace([RULE]), store.replace([RULE]), store.replace([RULE])])
  assert.equal(store.revision(), 3)
  assert.equal(facility.rows('usage_pricing.rules').get('current').revision, 3)
})

test('importLegacy:空域导入一次,已有记录不覆盖', async () => {
  const facility = makeFacility()
  const store = new PricingStore(facility)
  await store.readyPromise()
  assert.equal(await store.importLegacy([RULE]), true)
  const importedRevision = store.revision()
  assert.ok(importedRevision > 0)
  const newer = { ...RULE, price: { ...RULE.price, input: 9 } }
  assert.equal(await store.importLegacy([newer]), false)
  assert.deepEqual(store.rules(), [RULE])
  assert.equal(store.revision(), importedRevision)
})

test('域打开失败:ready 不拒绝,读为空、写抛降级错误', async () => {
  const facility = makeFacility({ failOpen: true })
  const store = new PricingStore(facility)
  await store.readyPromise()
  assert.ok(store.degradation instanceof Error)
  assert.deepEqual(store.rules(), [])
  assert.equal(store.revision(), 0)
  assert.equal(store.hasRecord(), false)
  await assert.rejects(() => store.replace([RULE]), /pricing store degraded/)
  await assert.rejects(() => store.importLegacy([RULE]), /pricing store degraded/)
})

test('sharedPricingStore:同 facility 复用,异 facility 新建,降级实例重建', async () => {
  __resetSharedPricingStoreForTests()
  const facility = makeFacility()
  const first = sharedPricingStore(facility)
  assert.equal(sharedPricingStore(facility), first)
  assert.notEqual(sharedPricingStore(makeFacility()), first)
  // 降级实例(打开失败)不缓存:下次同 facility 重建
  const broken = makeFacility({ failOpen: true })
  const degraded = sharedPricingStore(broken)
  await degraded.readyPromise()
  assert.notEqual(sharedPricingStore(broken), degraded)
  __resetSharedPricingStoreForTests()
})
