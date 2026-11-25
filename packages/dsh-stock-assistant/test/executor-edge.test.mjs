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
test('分时来源限流不冻结同额度组的报价', async () => {
  let calls = 0, now = 1000
  const multi = { ...descriptor, capabilities: ['quotes', 'trend'] }
  const registry = createRegistry([{ descriptor: multi, probe() {}, async trend(_req, ctx) { await ctx.fetch('http://fixture'); throw new StockError('RATE_LIMIT', 'limited', 429, { retryAfterMs: 60 * 60 * 1000 }) }, async quotes() { calls++; return { items: [] } } }])
  const executor = createExecutor({ registry, budget: createBudget(() => now), env: { DSH_STOCK_TUSHARE_TOKEN: 'fake' }, now: () => now, fetch: async () => new Response('{}') })
  await assert.rejects(executor.run(provider('a', 'fake'), 'trend', {}), e => e.code === 'RATE_LIMIT')
  now += 1000
  await executor.run(provider('a', 'fake'), 'quotes', {})
  assert.equal(calls, 1, '分时冷却由分时窗口承接, 不拖住同组报价')
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

test('实例配置 proxy 时请求走 proxyFetch(undici.fetch)并携带 dispatcher', async () => {
  const proxied = [], direct = []
  const registry = createRegistry([{ descriptor, probe() {}, async quotes(req, ctx) { await ctx.fetch('http://fixture'); return { items: [] } } }])
  const executor = createExecutor({ registry, budget: { reserve() {} }, env: { DSH_STOCK_TUSHARE_TOKEN: 'fake' }, fetch: (url, opts) => { direct.push(opts?.dispatcher ?? null); return Promise.resolve({}) }, proxyFetch: (url, opts) => { proxied.push(opts?.dispatcher || null); return Promise.resolve({}) }, proxyFactory: url => ({ proxyUrl: url }) })
  await executor.run({ ...provider('a', 'fake'), proxy: 'http://127.0.0.1:7890' }, 'quotes', {})
  assert.equal(proxied[0]?.proxyUrl, 'http://127.0.0.1:7890', '代理请求必须走 undici 自己的 fetch, 并带 dispatcher')
  assert.equal(direct.length, 0, '带 dispatcher 的请求不得交给内置 fetch')
  await executor.run(provider('b', 'fake'), 'quotes', {})
  assert.equal(direct[0], null, '无代理实例改用内置 fetch 且不带 dispatcher')
  assert.equal(proxied.length, 1)
  executor.dispose()
})

test('P1-10 代理账号密码取自凭据服务并在运行时注入 URL', async () => {
  const seen = []
  const registry = createRegistry([{ descriptor, probe() {}, async quotes(req, ctx) { await ctx.fetch('http://fixture'); return { items: [] } } }])
  const secret = ['alice', 's3cret'].join(':')
  const resolveCredential = async ref => ref === 'DSH_STOCK_PROXY' ? secret : undefined
  const executor = createExecutor({ registry, budget: { reserve() {} }, env: {}, resolveCredential, fetch: (url, opts) => { seen.push(opts?.dispatcher || null); return Promise.resolve({}) }, proxyFetch: (url, opts) => { seen.push(opts?.dispatcher || null); return Promise.resolve({}) }, proxyFactory: url => ({ proxyUrl: url }) })
  await executor.run({ ...provider('a', 'fake'), credentialRef: null, proxy: 'http://proxy.corp:8080', proxyCredentialRef: 'DSH_STOCK_PROXY' }, 'quotes', {})
  const expected = new URL('http://proxy.corp:8080'); expected.username = 'alice'; expected.password = 's3cret'
  assert.equal(seen[0]?.proxyUrl, expected.toString(), '账号密码只在 dispatcher URL 中出现')
  // 凭据缺失时明确 AUTH, 不能悄悄直连
  await assert.rejects(() => executor.run({ ...provider('b', 'fake'), credentialRef: null, proxy: 'http://proxy.corp:8080', proxyCredentialRef: 'MISSING_PROXY' }, 'quotes', {}), e => e.code === 'AUTH')
  executor.dispose()
})

test('P2-63 成功请求后不残留超时定时器', async () => {
  const pending = new Map(); let seq = 0
  const timers = { setTimeout(fn, ms) { const id = ++seq; pending.set(id, { fn, ms }); return id }, clearTimeout(id) { pending.delete(id) } }
  const registry = createRegistry([{ descriptor, probe() {}, async quotes(req, ctx) { await ctx.fetch('http://fixture'); return { items: [] } } }])
  const executor = createExecutor({ registry, budget: { reserve() {} }, env: { DSH_STOCK_TUSHARE_TOKEN: 'fake' }, timers, fetch: async () => ({}) })
  await executor.run(provider('a', 'fake'), 'quotes', {})
  assert.equal(pending.size, 0, 'finally 必须清掉 controller 自己的 8 秒超时计时器')
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

test('组内节拍等待唤醒后时钟已推进满间隔(定时器截断与唤醒抖动下预算门恒过)', async () => {
  // 真实时钟形态:拍间处理耗时 ε>0 使 gap=1000-ε 为非整数,setTimeout 向下取整,
  // 醒来时 now-starts<1000 → budget 层误判 RATE_LIMIT(CI 双架构高发,50 连跑 3/50 复现)。
  // 契约:执行器守门的等待必须上取整加裕度,唤醒后 now-starts>=间隔恒成立。
  let now = 1_000_000
  const registry = createRegistry([{ descriptor, probe() {}, async quotes(req, ctx) { await ctx.fetch('http://fixture'); return { items: [] } } }])
  const timers = {
    // 复刻 Node 语义:节拍等待(间隔量级,<8s 超时臂)按 ms 向下取整并注入 4ms
    // 唤醒滞后,模拟"醒来时 now-starts<间隔"的真实竞态;超时臂(8s)按真实间隔
    setTimeout: (fn, ms) => ms >= 1000 && ms < 8000
      ? globalThis.setTimeout(() => { now += Math.max(0, Math.floor(ms) - 4); fn() }, 1)
      : globalThis.setTimeout(fn, ms),
    clearTimeout: id => globalThis.clearTimeout(id),
  }
  const executor = createExecutor({ registry, budget: createBudget(() => now), env: { DSH_STOCK_TUSHARE_TOKEN: 'fake' }, now: () => now, timers, fetch: async () => ({}) })
  await executor.run(provider('a', 'fake'), 'quotes', {})
  // 第二拍:无论注入多少时钟滞后,不应以 RATE_LIMIT 拒绝
  const result = await executor.run(provider('b', 'fake'), 'quotes', {})
  assert.deepEqual(result.items, [])
  executor.dispose()
})
