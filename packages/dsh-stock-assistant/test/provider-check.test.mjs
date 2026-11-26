import test from 'node:test'
import assert from 'node:assert/strict'
import { createApplication } from '../src/application.mjs'
import { memoryStorage, provider, route, operation } from './helpers.mjs'
import { CAPABILITIES } from '../src/schemas.mjs'
import { MARKET_META } from '../src/market-model.mjs'

// 免凭据实例: 声明保守额度即可, 探针不读环境变量
// 每个实例独立额度组: 组内串行、组间并行, 这正是探针并行度的切分口径
const instance = (id, adapterId) => ({ ...provider(id, adapterId), credentialRef: null, quotaGroup: id, budget: { ...provider().budget, requestsPerMinute: 60 } })
const routeOf = (id, primary, market = 'XSHG', capability = 'quotes') => ({ ...route(primary, market, capability), id })

// 探针适配器: 声明全部能力与市场(预算推导要按能力算目标数), 调用走 probe, 不需要真实网络
const probeAdapter = (adapterId, hooks = {}) => ({
  descriptor: { adapterId, capabilities: CAPABILITIES, markets: Object.keys(MARKET_META), instruments: ['equity'], maxQuoteBatch: 20 },
  async probe(request) { return (await hooks.probe?.(request)) ?? { status: 'ready', capability: request.capability } },
  // 合同要求每个声明的能力都有同名方法
  ...Object.fromEntries(CAPABILITIES.map(capability => [capability, async () => ({ items: [], status: 'ready', capability })])),
})

test('探针预算按待测目标数推导, 并受封顶约束', async () => {
  const app = await createApplication({ storageDomain: memoryStorage(), providers: [probeAdapter('fake'), probeAdapter('fake2')], now: () => 1000 })
  const config = { providers: [instance('a', 'fake')], routes: [routeOf('ra', 'a')], capabilities: ['quotes'] }
  const single = app.providerCheckTimeoutMs(config)
  assert.equal(single, 11 * 1000, '单探针: 一次组内间隔 + 一次上游预算 + 收尾裕度')
  const many = app.providerCheckTimeoutMs({ providers: [instance('a', 'fake')], routes: ['XSHG', 'XSHE'].map(market => routeOf(`r-${market.toLowerCase()}`, 'a', market)), capabilities: ['quotes'] })
  // 同组 2 个探针要排两次组内间隔 + 两次上游预算
  assert.equal(many, 20 * 1000, '目标变多预算必须跟着变大')
  // 四个额度组各一个探针: 组间并行但要抢执行器的两个并发槽, 预算必须按槽位数摊总工作量
  const markets = ['XSHG', 'XSHE', 'XNAS', 'XNYS']
  // 额度组按账号引用划分: 各实例给独立凭据引用才能分到四个组
  const spreadInstances = markets.map((_, index) => ({ ...instance(`g${index}`, index % 2 ? 'fake2' : 'fake'), credentialRef: `REF_${index}` }))
  const spread = app.providerCheckTimeoutMs({ providers: spreadInstances, routes: markets.map((market, index) => routeOf(`rg${index}`, `g${index}`, market)), capabilities: ['quotes'] })
  // 最长一组 9 秒独占一个槽, 另外 27 秒由剩下的槽位摊: 9 + 13.5 + 2
  assert.equal(spread, 24.5 * 1000, '多组要按并发槽摊工作量, 不是只取最长一组')
  const routes = ['XSHG', 'XSHE', 'XNAS', 'XNYS', 'XHKG'].flatMap(market => ['quotes', 'catalog', 'kline', 'trend', 'calendar', 'search'].map(capability => routeOf(`${market}-${capability}`.toLowerCase(), 'a', market, capability)))
  const huge = app.providerCheckTimeoutMs({ providers: [instance('a', 'fake')], routes, capabilities: ['quotes', 'catalog', 'kline', 'trend', 'calendar', 'search'] })
  // 30 个目标排在同组: 推导值会超过封顶, 请求时限不能无限长
  assert.equal(huge, 2 * 60 * 1000, '预算不得超过封顶值')
  await app.close()
})

test('不同额度组的探针并行, 同组仍串行', { timeout: 5000 }, async () => {
  // 两个组各自的首个探针必须同时起跑才能互相解锁: 串行实现会在这里死等
  let arrived = 0
  let release
  const barrier = new Promise(resolve => { release = resolve })
  const adapter = adapterId => probeAdapter(adapterId, {
    probe: async () => { arrived += 1; if (arrived === 2) release(); await barrier; return { status: 'ready', capability: 'quotes' } },
  })
  const app = await createApplication({ storageDomain: memoryStorage(), providers: [adapter('a'), adapter('b')], now: () => 1000 })
  const checked = await app.providerCheck({ providers: [instance('a', 'a'), instance('b', 'b')], routes: [{ ...routeOf('ra', 'a'), fallbackInstanceIds: ['b'] }], capabilities: ['quotes'] })
  assert.deepEqual(checked.checks.map(c => c.status), ['ready', 'ready'])
  assert.equal(arrived, 2)
  await app.close()
})

test('预算用完时交出已完成的部分诊断, 不再无限探下去', async () => {
  let now = 1000
  let calls = 0
  const adapter = probeAdapter('fake', {
    // 首拍把时钟推过预算: 剩下的目标只能报"未执行", 但已完成的那条必须留在结果里
    probe: async () => { calls += 1; now += 60 * 1000; return { status: 'ready', capability: 'quotes' } },
  })
  const app = await createApplication({ storageDomain: memoryStorage(), providers: [adapter], now: () => now })
  const checked = await app.providerCheck({ providers: [instance('a', 'fake')], routes: [routeOf('r1', 'a', 'XSHG'), routeOf('r2', 'a', 'XSHE')], capabilities: ['quotes'] })
  assert.equal(checked.checks[0].status, 'ready', '已完成的诊断必须保留')
  assert.equal(checked.checks[1].status, 'skipped')
  assert.equal(checked.checks[1].error.code, 'CHECK_DEADLINE')
  assert.equal(checked.partial, true)
  assert.equal(calls, 1, '预算用完不再发上游请求')
  await app.close()
})

test('检查请求按窗口节流, 结果不驻留内存', async () => {
  let now = 1000
  const app = await createApplication({ storageDomain: memoryStorage(), providers: [probeAdapter('fake')], now: () => now })
  const config = { providers: [instance('a', 'fake')], routes: [routeOf('ra', 'a')], capabilities: ['quotes'] }
  for (let index = 0; index < 64; index += 1) { now += 1000; await app.providerCheck(config) }
  now += 1000
  await assert.rejects(app.providerCheck(config), e => e.code === 'CHECK_LIMIT')
  // 窗口滑过之后重新放行
  now += 5 * 60 * 1000
  assert.equal((await app.providerCheck(config)).checks[0].status, 'ready')
  await app.close()
})

test('保存配置时引用过期的检查标识也不拦人', async () => {
  const app = await createApplication({ storageDomain: memoryStorage(), providers: [probeAdapter('fake')], now: () => 1000 })
  const config = { providers: [instance('a', 'fake')], routes: [routeOf('ra', 'a')] }
  const saved = await app.configuration({ ...operation(), payload: config, checkIds: ['00000000-0000-4000-8000-000000000000'] })
  assert.equal(saved.revision, 1)
  await app.close()
})

test('到点会打断在途探针, 记未执行而不是不可用', { timeout: 10000 }, async () => {
  // 探针卡在上游时预算必须能截断它: 到点的探针是"没验过", 报不可用会让客户端把好路由剪掉。
  // 这里只把预算的截止定时器提前, 上游超时仍走真实延时, 保证先到的是检查截止
  const patched = []
  const timers = {
    setTimeout: (fn, ms) => { const shorten = ms === 9000; if (shorten) patched.push(ms); const handle = setTimeout(fn, shorten ? 0 : ms); return handle },
    clearTimeout: handle => clearTimeout(handle),
  }
  const adapter = probeAdapter('fake', { probe: () => new Promise(resolve => setTimeout(() => resolve({ status: 'ready', capability: 'quotes' }), 100)) })
  const app = await createApplication({ storageDomain: memoryStorage(), providers: [adapter], timers })
  const input = { providers: [instance('a', 'fake')], routes: [routeOf('r', 'a')], capabilities: ['quotes'] }
  // 预算 11 秒, 自查截止早 2 秒
  assert.equal(app.providerCheckTimeoutMs(input) - 2 * 1000, 9000)
  const checked = await app.providerCheck(input)
  assert.deepEqual(checked.checks.map(c => c.status), ['skipped'], '到点的探针记未执行')
  assert.equal(checked.checks[0].error.code, 'CHECK_DEADLINE')
  assert.equal(checked.partial, true)
  assert.deepEqual(patched, [9000], '确实命中截止定时器')
  await app.close()
})
