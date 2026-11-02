import test from 'node:test'
import assert from 'node:assert/strict'
import { createExecutor } from '../src/executor.mjs'
import { createRegistry } from '../src/provider-registry.mjs'
import { createBudget } from '../src/budget.mjs'
import { StockError } from '../src/market-model.mjs'
import { provider } from './helpers.mjs'
const descriptor = { adapterId: 'fake', capabilities: ['quotes'], markets: ['XSHG'], instruments: ['equity'], maxQuoteBatch: 20 }
test('请求执行器在超时后释放并发槽位，后续请求仍可执行', async () => {
  const waits = new Map(); let timerId = 0, calls = 0
  const timers = { setTimeout(fn) { waits.set(++timerId, fn); return timerId }, clearTimeout(id) { waits.delete(id) } }
  const registry = createRegistry([{ descriptor, probe() {}, async quotes() { calls++; if (calls === 1) return new Promise(() => {}); return { items: ['ok'] } } }])
  let now = 1000
  const executor = createExecutor({ registry, budget: createBudget(() => now), env: { DSH_STOCK_TUSHARE_TOKEN: 'fake' }, now: () => now, timers })
  const a = executor.run(provider('a', 'fake'), 'quotes', {})
  await new Promise(resolve => setImmediate(resolve)); for (const fn of [...waits.values()]) fn()
  await assert.rejects(a, e => e.code === 'TIMEOUT')
  now += 1000
  assert.deepEqual((await executor.run(provider('a', 'fake'), 'quotes', {})).items, ['ok'])
  executor.dispose()
})
test('上游返回429后同额度组后续调用不触达网络', async () => {
  let calls = 0, now = 1000
  const registry = createRegistry([{ descriptor, probe() {}, async quotes(req, ctx) { await ctx.fetch('http://fixture'); throw new StockError('RATE_LIMIT', 'limited', 429, { retryAfterMs: 20000 }) } }])
  const executor = createExecutor({ registry, budget: createBudget(() => now), env: { DSH_STOCK_TUSHARE_TOKEN: 'fake' }, now: () => now, fetch: async () => { calls++; return {} } })
  await assert.rejects(executor.run(provider('a', 'fake'), 'quotes', {}), e => e.code === 'RATE_LIMIT')
  now += 1000
  await assert.rejects(executor.run(provider('b', 'fake'), 'quotes', {}), e => e.code === 'RATE_LIMIT')
  assert.equal(calls, 1)
  executor.dispose()
})

test('实例配置 proxy 时 fetch 选项携带该代理 dispatcher', async () => {
  const seen = []
  const registry = createRegistry([{ descriptor, probe() {}, async quotes(req, ctx) { await ctx.fetch('http://fixture'); return { items: [] } } }])
  const executor = createExecutor({ registry, budget: { reserve() {} }, env: { DSH_STOCK_TUSHARE_TOKEN: 'fake' }, fetch: (url, opts) => { seen.push(opts?.dispatcher || null); return Promise.resolve({}) }, proxyFactory: url => ({ proxyUrl: url }) })
  await executor.run({ ...provider('a', 'fake'), proxy: 'http://127.0.0.1:7890' }, 'quotes', {})
  assert.equal(seen[0]?.proxyUrl, 'http://127.0.0.1:7890', 'fetch option 带 dispatcher(内含代理 URL)')
  await executor.run(provider('b', 'fake'), 'quotes', {})
  assert.equal(seen[1], null, '无代理实例不带 dispatcher')
  executor.dispose()
})

test('每次上游请求记入实例环形日志(20条封顶,最近在前)', async () => {
  const registry = createRegistry([{ descriptor, probe() {}, async quotes(req, ctx) { await ctx.fetch('http://fixture/quotes'); return { items: [1] } } }])
  const executor = createExecutor({ registry, budget: { reserve() {} }, env: { DSH_STOCK_TUSHARE_TOKEN: 'fake' }, fetch: async () => ({}) })
  for (let i = 0; i < 22; i++) await executor.run({ ...provider('a', 'fake'), id: 'a' }, 'quotes', {})
  const log = executor.recentRequests('a')
  assert.equal(log.length, 20, '环形封顶 20 条')
  assert.equal(log[0].status, 'ok')
  assert.ok(log[0].at >= log[19].at, '最近在前')
  assert.match(log[0].url, /quotes fake/, '条目含能力与适配器描述')
  assert.deepEqual(executor.recentRequests('missing'), [])
  executor.dispose()
})

test('失败请求也入日志并标错误码', async () => {
  const registry = createRegistry([{ descriptor, probe() {}, async quotes(req, ctx) { await ctx.fetch('http://fixture'); throw new StockError('RATE_LIMIT', 'limited', 429) } }])
  const executor = createExecutor({ registry, budget: { reserve() {} }, env: { DSH_STOCK_TUSHARE_TOKEN: 'fake' }, fetch: async () => ({}) })
  await assert.rejects(executor.run(provider('a', 'fake'), 'quotes', {}), e => e.code === 'RATE_LIMIT')
  const log = executor.recentRequests('a')
  assert.equal(log.length, 1)
  assert.equal(log[0].status, 'RATE_LIMIT')
  executor.dispose()
})
