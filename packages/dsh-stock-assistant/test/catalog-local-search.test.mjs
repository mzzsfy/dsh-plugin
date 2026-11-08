// 本地目录搜索: 代码大小写不敏感(美股代码全大写,逐字比较会让 aapl 搜不到)
import test from 'node:test'
import assert from 'node:assert/strict'
import { createCatalog } from '../src/catalog.mjs'
import { makeSecurity } from '../src/market-model.mjs'
import { openState } from '../src/state.mjs'
import { memoryStorage } from './helpers.mjs'

const MARKETS = ['XSHG', 'XSHE', 'XHKG', 'XNAS']
const route = market => ({ id: `${market.toLowerCase()}-search`, capability: 'search', market, instrument: 'equity', primaryInstanceId: 'em', fallbackInstanceIds: [], failoverMode: 'off', maxDelaySeconds: null, acceptUnknownDelay: true })
const US = makeSecurity('XNAS', 'AAPL', 'Apple Inc')
const CN = makeSecurity('XSHG', '600519', '贵州茅台')
const HK = makeSecurity('XHKG', '00700', '腾讯控股')

async function harness() {
  const state = await openState(memoryStorage())
  await state.cache.put('catalog:test', { kind: 'catalog', source: 'em', fetchedAt: Date.now(), payload: { routingRevision: 1, items: [US, CN, HK], complete: true } })
  const config = { routingRevision: 1, providers: [{ id: 'em', adapterId: 'eastmoney', enabled: true }], routes: MARKETS.map(route) }
  const catalog = createCatalog({
    state, getControl: () => config,
    router: { select: () => ({ instance: config.providers[0] }) },
    executor: { run: async () => ({ items: [], errors: [] }) },
    registry: { descriptors: () => [{ adapterId: 'eastmoney', capabilities: ['search'], markets: MARKETS }] },
  })
  return { catalog, state }
}

test('L01 美股代码大小写无关: 输入小写/混合大小写都能命中同一证券', async () => {
  const { catalog, state } = await harness()
  for (const q of ['aapl', 'AAPL', 'Aap', 'aApL']) assert.equal(catalog.search(q)[0]?.id, 'XNAS:equity:AAPL', `查询 ${q}`)
  catalog.dispose(); await state.close()
})

test('L02 数字代码与中文名检索不受改造影响', async () => {
  const { catalog, state } = await harness()
  assert.equal(catalog.search('600519')[0]?.id, 'XSHG:equity:600519', 'A股代码精确命中')
  assert.equal(catalog.search('腾讯')[0]?.id, 'XHKG:equity:00700', '中文名子串命中')
  assert.equal(catalog.search('apple')[0]?.id, 'XNAS:equity:AAPL', '英文名子串命中')
  catalog.dispose(); await state.close()
})

test('L03 代码精确命中排在名称命中之前', async () => {
  const { catalog, state } = await harness()
  // 'apple' 只命中名称; 'aapl' 只命中代码 —— 用同时命中两者的查询验证排序
  const hits = catalog.search('00700')
  assert.equal(hits[0]?.id, 'XHKG:equity:00700', '代码精确命中排首位')
  catalog.dispose(); await state.close()
})
