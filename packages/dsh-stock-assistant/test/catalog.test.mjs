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
// M2: Given无目录缓存 When浏览 Then返回syncing态并触发后台同步(不再甩422给用户)
test('浏览接口无目录缓存时返回同步中态', async () => {
  const storage = memoryStorage(), state = await openState(storage)
  // 同步走闭包, 不能在返回对象上打桩: 数上游调用次数才是后台同步真的跑了
  let runs = 0
  const catalog = createCatalog({ state, getControl: () => state.get(), router: { select: () => ({ instance: { id: 'd' }, route: {} }) }, executor: { run: async () => { runs++; return { items: [], complete: true } } }, now: () => 100 })
  const page = await catalog.browse({ market: 'XSHG', offset: 0, limit: 50 })
  assert.equal(page.syncing, true, 'syncing 态')
  assert.equal(page.items.length, 0)
  // 谓词等待: 固定 sleep 在并行负载下会抢跑, 这条用例真的红过一次
  for (let tries = 0; tries < 100 && runs < 1; tries++) await new Promise(r => setTimeout(r, 10))
  assert.ok(runs >= 1, '后台同步已触发')
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

// 回归: 缓存表里混进 undefined 记录时, 市场状态查询不能整轮崩掉
test('缓存表混入空记录时市场状态照常返回', async () => {
  const storage = memoryStorage(), state = await openState(storage)
  await state.cache.put('kline_broken', undefined)
  const catalog = createCatalog({ state, getControl: () => state.get(), router: { select: () => ({ instance: { id: 'd' }, route: {} }) }, executor: { run: async () => ({ items: [] }) }, now: () => Date.parse('2026-11-09T02:00:00Z') })
  const status = catalog.marketState('XSHG')
  assert.equal(status.state, 'trading', '2026-11-09 10:00 CST 沪深交易中')
  assert.equal(status.nextAt, undefined, '交易中不排唤醒时刻, 交给周期刷新')
})

// K7: 无目录且同步失败时, 浏览接口必须给出失败原因(不能永远"首次同步中"), 且自动重试要节流
test('K7 目录同步失败可从浏览出口拿到原因, 30 秒内不重复打上游', async () => {
  const storage = memoryStorage(), state = await openState(storage)
  let now = 1_000_000, selects = 0
  const catalog = createCatalog({
    state, getControl: () => ({ ...state.get(), routingRevision: 1 }), now: () => now,
    router: { select: () => { selects += 1; throw Object.assign(new Error('未配置该市场的数据来源'), { code: 'NO_ROUTE' }) } },
    executor: { run: async () => ({ items: [] }) },
  })
  const first = await catalog.browse({ market: 'XSHG', offset: 0, limit: 50 })
  assert.equal(first.syncing, true)
  assert.equal(first.syncError, null, '首次尝试进行中: 无错误可报')
  await new Promise(resolve => setTimeout(resolve, 30))
  const second = await catalog.browse({ market: 'XSHG', offset: 0, limit: 50 })
  assert.equal(second.syncing, true)
  assert.equal(second.syncError?.code, 'NO_ROUTE', '失败原因随 syncing 响应返回, 界面有出口')
  assert.equal(selects, 1, '失败后 30 秒内再次浏览不重复打上游')
  now += 30 * 1000
  await catalog.browse({ market: 'XSHG', offset: 0, limit: 50 })
  await new Promise(resolve => setTimeout(resolve, 30))
  assert.equal(selects, 2, '超过重试间隔后允许再次尝试')
})

// S4: 路由版本变化后旧版本的失败原因必须失效, 并重新尝试同步
test('S4 路由版本变化后不再回显上一次失败原因', async () => {
  const storage = memoryStorage(), state = await openState(storage)
  let revision = 1, selects = 0
  const catalog = createCatalog({
    state, getControl: () => ({ ...state.get(), routingRevision: revision }), now: () => 1000,
    router: { select: () => { selects += 1; throw Object.assign(new Error('未配置该市场的数据来源'), { code: 'NO_ROUTE' }) } },
    executor: { run: async () => ({ items: [] }) },
  })
  await catalog.browse({ market: 'XSHG', offset: 0, limit: 50 })
  await new Promise(resolve => setTimeout(resolve, 30))
  const failed = await catalog.browse({ market: 'XSHG', offset: 0, limit: 50 })
  assert.equal(failed.syncError?.code, 'NO_ROUTE')
  assert.equal(selects, 1, '同版本失败后 30 秒内不重复打上游')
  revision = 2
  const afterRevision = await catalog.browse({ market: 'XSHG', offset: 0, limit: 50 })
  assert.equal(afterRevision.syncError, null, '新路由版本不得回显旧版本的失败')
  await new Promise(resolve => setTimeout(resolve, 30))
  assert.equal(selects, 2, '新路由版本要重新尝试同步')
  await catalog.browse({ market: 'XSHG', offset: 0, limit: 50 })
  await new Promise(resolve => setTimeout(resolve, 30))
  assert.equal(selects, 2, '新版本的失败原因照常回显且节流')
})

// S6: 目录超过一天仍是已有记录, 旧实现永远不刷新; 现在先展示旧数据再后台同步
test('S6 已有目录超过一天自动后台刷新', async () => {
  const DAY = 24 * 60 * 60 * 1000, now = 10 * DAY
  const storage = memoryStorage(), state = await openState(storage)
  const security = makeSecurity('XSHG', '600001', '甲')
  await state.cache.put('catalog:seed:XSHG', { kind: 'catalog', source: 'seed', fetchedAt: now - 2 * DAY, payload: { routingRevision: state.get().routingRevision, market: 'XSHG', complete: true, items: [security] } })
  let calls = 0
  const catalog = createCatalog({
    state, getControl: () => state.get(), now: () => now,
    router: { select: () => ({ instance: { id: 'fresh' }, route: { id: 'catalog-sh' } }) },
    executor: { run: async () => { calls += 1; return { items: [security], errors: [], complete: true } } },
  })
  const page = await catalog.browse({ market: 'XSHG', offset: 0, limit: 50 })
  assert.deepEqual([...page.items.map(item => item.code)], ['600001'], '过期目录照常展示, 不空窗')
  await new Promise(resolve => setTimeout(resolve, 30))
  assert.equal(calls, 1, '过期目录触发后台同步')
  const refreshed = [...state.cache.entries()].find(([, cache]) => cache.kind === 'catalog' && cache.fetchedAt === now)
  assert.ok(refreshed, '新目录已写入缓存')
  await catalog.browse({ market: 'XSHG', offset: 0, limit: 50 })
  await new Promise(resolve => setTimeout(resolve, 30))
  assert.equal(calls, 1, '刷新后一天内不重复同步')
})
