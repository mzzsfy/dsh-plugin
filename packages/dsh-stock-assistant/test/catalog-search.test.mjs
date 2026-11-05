import test from 'node:test'
import assert from 'node:assert/strict'
import { createCatalog, setBounded } from '../src/catalog.mjs'
import { makeSecurity } from '../src/market-model.mjs'
import { openState } from '../src/state.mjs'
import { memoryStorage } from './helpers.mjs'

const MARKETS = ['XSHG', 'XSHE', 'XHKG', 'XNAS']
const route = market => ({ id: `${market.toLowerCase()}-search`, capability: 'search', market, instrument: 'equity', primaryInstanceId: 'em', fallbackInstanceIds: [], failoverMode: 'off', maxDelaySeconds: null, acceptUnknownDelay: true })

async function harness({ items = [makeSecurity('XSHG', '600519', '贵州茅台')], run } = {}) {
  const state = await openState(memoryStorage())
  const config = { routingRevision: 1, providers: [{ id: 'em', adapterId: 'eastmoney', enabled: true }], routes: MARKETS.map(route) }
  const calls = []
  const registry = { descriptors: () => [{ adapterId: 'eastmoney', capabilities: ['search'], markets: MARKETS }], get: () => ({ descriptor: { adapterId: 'eastmoney', maxQuoteBatch: 60 } }) }
  const executor = { run: run || (async (instance, capability, request) => { calls.push({ instance: instance.id, capability, market: request.market, q: request.q }); return { items, errors: [] } }) }
  const catalog = createCatalog({ state, getControl: () => config, router: { select: () => ({ instance: config.providers[0] }) }, executor, registry })
  return { catalog, calls, state }
}

test('S01 全市场搜索每个实例只调用一次远端且不限市场', async () => {
  const { catalog, calls, state } = await harness()
  const items = await catalog.remote('茅台')
  assert.equal(calls.length, 1, '四市场合成一次远端调用')
  assert.equal(calls[0].market, null, '不限市场取全量候选')
  assert.equal(calls[0].capability, 'search')
  assert.equal(items.length, 1)
  assert.equal(items[0].id, 'XSHG:equity:600519')
  catalog.dispose(); await state.close()
})

test('S02 同查询走结果缓存不再打远端', async () => {
  const { catalog, calls, state } = await harness()
  await catalog.remote('茅台')
  const first = calls.length
  const again = await catalog.remote('茅台')
  assert.equal(calls.length, first, '缓存命中零远端调用')
  assert.equal(again[0].id, 'XSHG:equity:600519')
  await catalog.remote('茅台 ')
  assert.equal(calls.length, first, '空白归一后仍命中')
  await catalog.remote('五粮液')
  assert.equal(calls.length, first + 1, '不同查询重新远端')
  catalog.dispose(); await state.close()
})

test('S03 同查询并发合并为一次远端调用', async () => {
  const pending = []
  const { catalog, calls, state } = await harness({ run: (instance, capability, request) => { calls.push(request.q); return new Promise(resolve => pending.push(() => resolve({ items: [makeSecurity('XSHG', '600519', '贵州茅台')], errors: [] }))) } })
  const both = Promise.all([catalog.remote('茅台'), catalog.remote('茅台')])
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(calls.length, 1, '在途请求合并')
  pending.forEach(fn => fn())
  const [a, b] = await both
  assert.equal(a[0].id, b[0].id)
  catalog.dispose(); await state.close()
})

test('S04 单实例限流不终止整个搜索', async () => {
  const rateLimited = () => { const e = new Error('限流'); e.code = 'RATE_LIMIT'; return e }
  const { catalog, state } = await harness({ run: async () => { throw rateLimited() } })
  const items = await catalog.remote('茅台')
  assert.deepEqual(items, [], '限流时不抛错且返回已有本地结果')
  catalog.dispose(); await state.close()
})

test('S05 缓存有界: 大量不同查询后缓存与在途表不越界', async () => {
  const map = new Map()
  for (let i = 0; i < 100; i++) setBounded(map, `k${i}`, i, 16)
  assert.equal(map.size, 16, '写入超限即淘汰最早条目')
  assert.equal(map.has('k99'), true, '保留最新条目')
  assert.equal(map.has('k0'), false, '淘汰最早条目')
  const { catalog, state } = await harness()
  for (let i = 0; i < 100; i++) await catalog.remote(`查询${i}`)
  const stats = catalog.stats()
  assert.ok(stats.searchCache <= 64, `结果缓存不越界(${stats.searchCache})`)
  assert.ok(stats.candidates <= 200, `候选表不越界(${stats.candidates})`)
  assert.equal(stats.searchFlights, 0, '在途表在完成后清空')
  catalog.dispose(); await state.close()
})
