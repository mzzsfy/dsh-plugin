import test from 'node:test'
import assert from 'node:assert/strict'
import { createExecutor, routeTimeoutMs, maxTickWaitMs, UPSTREAM_TIMEOUT_MS } from '../src/executor.mjs'
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
  assert.match(log[0].label, /quotes fake/, '条目含能力与适配器描述')
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

test('请求日志里带凭据的地址一律掩码', async () => {
  // 适配器错误文案可能带请求地址: 这条日志随快照进设置页, 明文等于把密钥摆到 DOM 里
  const registry = createRegistry([{ descriptor, probe() {}, async quotes() { throw new StockError('NETWORK', 'https://finnhub.io/api/v1/quote?symbol=AAPL&token=secret-value 请求失败', 502) } }])
  const executor = createExecutor({ registry, budget: { reserve() {} }, env: { DSH_STOCK_TUSHARE_TOKEN: 'fake' }, fetch: async () => ({}) })
  await assert.rejects(executor.run(provider('a', 'fake'), 'quotes', {}), e => e.code === 'NETWORK')
  const [entry] = executor.recentRequests('a')
  assert.doesNotMatch(JSON.stringify(entry), /secret-value/, '密钥不得出现在日志里')
  assert.match(entry.message, /token=\*\*\*/)
  assert.match(entry.message, /symbol=AAPL/, '非敏感参数保留')
  assert.equal(entry.label, 'quotes fake', '标签只记能力与适配器, 不含地址')
  executor.dispose()
})

test('文案里嵌地址时同一套掩码仍生效', async () => {
  // 整串不是 URL 时 new URL 会失败: 没有第二层正则, 密钥就跟着中文句子进快照
  const registry = createRegistry([{ descriptor, probe() {}, async quotes() { throw new StockError('NETWORK', '请求 https://finnhub.io/api/v1/quote?symbol=AAPL&token=secret-value 失败', 502) } }])
  const executor = createExecutor({ registry, budget: { reserve() {} }, env: { DSH_STOCK_TUSHARE_TOKEN: 'fake' }, fetch: async () => ({}) })
  await assert.rejects(executor.run(provider('a', 'fake'), 'quotes', {}), e => e.code === 'NETWORK')
  const [entry] = executor.recentRequests('a')
  assert.doesNotMatch(entry.message, /secret-value/)
  assert.match(entry.message, /token=\*\*\*/)
  assert.match(entry.message, /symbol=AAPL/, '非敏感参数保留')
  executor.dispose()
})

test('路由超时盖住最坏节拍等待 + 上游预算', () => {
  // 最慢档位: 列表与浮窗都 30 秒 → 节拍 27 秒, 拍后半段的请求要等半拍
  const worst = routeTimeoutMs({ refreshSeconds: 30, floatRefreshSeconds: 30 })
  assert.ok(worst > maxTickWaitMs({ refreshSeconds: 30, floatRefreshSeconds: 30 }) + UPSTREAM_TIMEOUT_MS, '路由超时必须大于「等半拍 + 上游超时」')
  assert.equal(maxTickWaitMs({ refreshSeconds: 30, floatRefreshSeconds: 30 }), 13500)
  assert.equal(worst, 13500 + 10 * 1000 + 8000 + 2000)
  const fast = routeTimeoutMs({ refreshSeconds: 15, floatRefreshSeconds: 3 })
  assert.ok(fast < worst, '档位越快, 超时越短')
  assert.ok(fast > 0)
})

test('请求截止时刻到点即按超时收尾, 不把整条请求拖到路由层超时', async () => {
  let calls = 0
  const registry = createRegistry([{ descriptor, probe() {}, async quotes() { calls++; return { items: [] } } }])
  let now = 1000
  const executor = createExecutor({ registry, budget: createBudget(() => now), env: { DSH_STOCK_TUSHARE_TOKEN: 'fake' }, now: () => now })
  // 截止时刻已过: 分批/备源的后续段直接超时, 已成功的段照常保留
  await assert.rejects(executor.run(provider('a', 'fake'), 'quotes', {}, { deadline: now - 1 }), e => e.code === 'TIMEOUT' && e.retryable)
  assert.equal(calls, 0, '预算耗尽后不得再打上游')
  await executor.run(provider('a', 'fake'), 'quotes', {}, { deadline: now + 60 * 1000 })
  assert.equal(calls, 1, '预算充足时照常发请求')
  executor.dispose()
})

test('rpm 未声明时组内间隔不吃掉上游计时窗口', async () => {
  // 未声明每分钟上限的来源按 10 秒排队, 而单次上游活动只给 8 秒:
  // 排队期间不停表, 第二次 fetch 还没发出去就必然超时
  let now = 1000, calls = 0
  const alarms = new Map()
  let seq = 0
  const timers = {
    setTimeout(fn, ms) {
      // 上游超时(8 秒)是闹钟: 按虚拟时钟到点才响, 排队等待则直接把时钟推过去
      if (ms === UPSTREAM_TIMEOUT_MS) { alarms.set(++seq, { at: now + ms, fn }); return seq }
      now += ms
      for (const [id, alarm] of [...alarms]) if (alarm.at <= now) { alarms.delete(id); alarm.fn() }
      queueMicrotask(fn)
      return -1
    },
    clearTimeout(id) { alarms.delete(id) },
  }
  const registry = createRegistry([{ descriptor, probe() {}, async quotes(_req, ctx) {
    await ctx.fetch('http://fixture/one'); calls++
    await ctx.fetch('http://fixture/two'); calls++
    return { items: [] }
  } }])
  const noRpm = { ...provider('a', 'fake'), budget: { requestsPerMinute: null } }
  const executor = createExecutor({ registry, budget: { reserve() {} }, env: { DSH_STOCK_TUSHARE_TOKEN: 'fake' }, now: () => now, timers, fetch: async () => ({}) })
  await executor.run(noRpm, 'quotes', {})
  assert.equal(calls, 2, '两次上游活动都发得出去')
  executor.dispose()
})
