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
