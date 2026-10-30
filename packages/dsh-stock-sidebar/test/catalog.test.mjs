import test from 'node:test'
import assert from 'node:assert/strict'
import { createCatalog } from '../src/catalog.mjs'
import { openState } from '../src/state.mjs'
import { makeSecurity } from '../src/market-model.mjs'
import { memoryStorage } from './helpers.mjs'
test('目录按标准ID检索、代码精确优先，缓存不跨来源代次混用', async () => {
  const storage = memoryStorage(), state = await openState(storage)
  const config = { ...state.get(), routingRevision: 1 }
  const securities = [makeSecurity('XSHE', '000001', '平安银行', { cnspell: 'payh' }), makeSecurity('XSHG', '600001', '000001示例')]
  const catalog = createCatalog({ state, getControl: () => config, router: { select: () => ({ instance: { id: 'directory' }, route: { id: 'catalog-sh' } }) }, executor: { run: async (instance, capability, request) => ({ items: securities.filter(s => s.exchange === request.market), errors: [], complete: true }) }, now: () => 100 })
  await catalog.sync('XSHG', ['catalog']); await catalog.sync('XSHE', ['catalog'])
  assert.equal(catalog.search('000001')[0].id, securities[0].id)
  assert.equal(catalog.search('PAYH')[0].id, securities[0].id)
  assert.equal(catalog.resolve(securities[0].id).officialName, '平安银行')
  config.routingRevision++
  assert.equal(catalog.search('PAYH').length, 0)
})
// M1: Given目录缓存有沪深数据 When浏览接口分页拉取 Then按市场过滤、代码升序返回total
test('浏览接口按市场分页返回代码升序目录', async () => {
  const storage = memoryStorage(), state = await openState(storage)
  const securities = [makeSecurity('XSHG', '600001', '甲'), makeSecurity('XSHG', '600002', '乙'), makeSecurity('XSHE', '000001', '丙')]
  const catalog = createCatalog({ state, getControl: () => ({ ...state.get(), routingRevision: 1 }), router: { select: () => ({ instance: { id: 'd' }, route: {} }) }, executor: { run: async (i, c, request) => ({ items: securities.filter(s => s.exchange === request.market), errors: [], complete: true }) }, now: () => 100 })
  await catalog.sync('XSHG', ['catalog']); await catalog.sync('XSHE', ['catalog'])
  const sh = await catalog.browse({ market: 'XSHG', offset: 0, limit: 50 })
  assert.deepEqual(sh.items.map(s => s.code), ['600001', '600002'])
  assert.equal(sh.total, 2)
  const page2 = await catalog.browse({ market: 'XSHG', offset: 1, limit: 1 })
  assert.deepEqual(page2.items.map(s => s.code), ['600002'])
})
// M2: Given无目录缓存 When浏览 Then明确未就绪
test('浏览接口无目录缓存时报未就绪', async () => {
  const storage = memoryStorage(), state = await openState(storage)
  const catalog = createCatalog({ state, getControl: () => state.get(), router: { select: () => ({ instance: { id: 'd' }, route: {} }) }, executor: { run: async () => ({ items: [] }) }, now: () => 100 })
  await assert.rejects(catalog.browse({ market: 'XSHG', offset: 0, limit: 50 }), e => e.code === 'CATALOG_NOT_READY')
})
// M4: Given越界分页参数 When浏览 Then钳制不抛错
test('浏览接口钳制越界分页参数', async () => {
  const storage = memoryStorage(), state = await openState(storage)
  const catalog = createCatalog({ state, getControl: () => state.get(), router: { select: () => ({ instance: { id: 'd' }, route: {} }) }, executor: { run: async () => ({ items: [makeSecurity('XSHG', '600001', '甲')], errors: [], complete: true }) }, now: () => 100 })
  await catalog.sync('XSHG', ['catalog'])
  const under = await catalog.browse({ market: 'XSHG', offset: -5, limit: 0 })
  assert.equal(under.items.length, 1)
  assert.equal(under.total, 1)
  const over = await catalog.browse({ market: 'XSHG', offset: 0, limit: 99999 })
  assert.equal(over.items.length, 1)
  assert.equal(over.total, 1)
})
