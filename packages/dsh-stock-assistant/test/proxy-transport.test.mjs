// 代理出口契约: userland undici 的 Dispatcher 不能交给 Node 内置 fetch(接口版本错位直接 502),
// 配了代理必须用同一份 undici.fetch; 缺 undici 时明确 NETWORK/502, 不能静默直连。
import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { readFile } from 'node:fs/promises'
import { createExecutor } from '../src/executor.mjs'

const descriptor = { adapterId: 'fake', capabilities: ['quotes'], markets: ['XSHG'], instruments: ['equity'], maxQuoteBatch: 20 }
const budget = () => ({ reserve() {}, block() {} })
const proxyInstance = url => ({ id: 'px', adapterId: 'fake', credentialRef: null, quotaGroup: 'px', proxy: url, budget: { requestsPerMinute: null, dailyRequestLimit: null, billingUnit: 'request', symbolCreditsPerMinute: null, capabilityLimits: {} } })
const quotingAdapter = (url, seen) => ({ descriptor, probe() {}, async quotes(req, ctx) { const response = await ctx.fetch(url); seen.push(response); return { items: (await response.json()).items } } })
const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)))

// 真实链路: 本地 HTTP 代理收到绝对 URL, 响应经 undici.fetch 回到适配器; 内置 fetch 一次都不碰
test('代理实例走 ProxyAgent+undici.fetch 真实出数据, 内置 fetch 不接手', async t => {
  const requests = []
  const proxy = http.createServer((req, res) => {
    requests.push({ method: req.method, url: req.url, host: req.headers.host })
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ items: [{ id: 'XSHG:equity:600519', last: 12.5 }] }))
  })
  const port = await listen(proxy)
  t.after(() => new Promise(resolve => proxy.close(resolve)))
  const undici = await import('undici')
  let builtinCalls = 0
  const builtinFetch = (...args) => { builtinCalls++; return globalThis.fetch(...args) }
  const responses = []
  const executor = createExecutor({
    registry: { get: () => quotingAdapter('http://upstream.invalid/quotes', responses) },
    budget: budget(), fetch: builtinFetch,
    proxyFactory: url => new undici.ProxyAgent(url),
    proxyFetch: (...args) => undici.fetch(...args),
  })
  const result = await executor.run(proxyInstance(`http://127.0.0.1:${port}`), 'quotes', {})
  assert.deepEqual(result.items, [{ id: 'XSHG:equity:600519', last: 12.5 }], '代理响应要能正常解析')
  assert.equal(builtinCalls, 0, '带 userland undici dispatcher 的请求不能交给 Node 内置 fetch')
  assert.equal(requests.length, 1)
  assert.equal(requests[0].url, 'http://upstream.invalid/quotes', 'HTTP 目标应作为绝对 URL 交给代理')
  assert.equal(responses.length, 1)
  executor.dispose()
})

// 缺 undici: 代理实例必须显式失败并落 NETWORK/502, 不能退回直连
test('代理已配置但 undici 不可用: NETWORK/502, 不静默直连', async () => {
  let fetchCalls = 0
  const executor = createExecutor({
    registry: { get: () => quotingAdapter('http://upstream.invalid/quotes', []) },
    budget: budget(), fetch: () => { fetchCalls++; return Promise.resolve({ json: async () => ({ items: [] }) }) },
    proxyFactory: null, proxyFetch: null,
  })
  await assert.rejects(executor.run(proxyInstance('http://127.0.0.1:1'), 'quotes', {}), error => error.code === 'NETWORK' && error.status === 502 && /代理出口不可用/.test(error.message))
  assert.equal(fetchCalls, 0, '代理配置失败时不得回落直连')
  executor.dispose()
})

// application 必须成对注入 ProxyAgent 与同一份 undici.fetch; engines 与 undici 8 对齐
test('application 成对注入代理工厂与 undici.fetch, engines 对齐 undici 8', async () => {
  const source = await readFile(new URL('../src/application.mjs', import.meta.url), 'utf8')
  assert.match(source, /proxyFactory = url => new undici\.ProxyAgent\(url\); proxyFetch = \(\.\.\.args\) => undici\.fetch\(\.\.\.args\)/)
  assert.match(source, /createExecutor\(\{[^\n]*proxyFetch[^\n]*proxyFactory/, 'createExecutor 必须同时拿到 proxyFetch')
  const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
  assert.equal(manifest.engines.node, '>=22.19.0', 'undici 8 声明 node >=22.19.0, engines 不能只写 >=22')
})
