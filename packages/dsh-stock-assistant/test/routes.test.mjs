import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { registerRoutes } from '../src/routes.mjs'
import { fail } from '../src/market-model.mjs'
test('C03 HTTP刷新等待完成且同价不依赖WS回执，非法方法拒绝', async t => {
  const routes = new Map()
  const app = { snapshot: () => ({ snapshotSeq: 1 }), refresh: async () => ({ snapshotSeq: 2, samePrice: true }) }
  const stop = registerRoutes({ register: r => { routes.set(r.path, r.handler); return () => routes.delete(r.path) } }, app)
  const server = http.createServer((req, res) => { const handler = routes.get(new URL(req.url, 'http://local').pathname); if (handler) handler(req, res); else { res.statusCode = 404; res.end() } })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(async () => { stop(); await new Promise(resolve => server.close(resolve)) })
  const base = `http://127.0.0.1:${server.address().port}/api/stock-assistant`
  const JSON_HEADER = { 'Content-Type': 'application/json' }
  const response = await fetch(base + '/refresh', { method: 'POST', headers: JSON_HEADER, body: '{}' })
  assert.equal(response.status, 200)
  assert.equal((await response.json()).data.snapshotSeq, 2)
  assert.equal((await fetch(base + '/snapshot', { method: 'POST', headers: JSON_HEADER, body: '{}' })).status, 405)
  assert.equal(response.headers.get('cache-control'), 'no-store')
  assert.equal((await fetch(base + '/refresh', { method: 'POST', headers: JSON_HEADER, body: 'null' })).status, 400)
  assert.equal((await fetch(base + '/refresh', { method: 'POST', headers: JSON_HEADER, body: '[' })).status, 400)
  assert.equal((await fetch(base + '/refresh', { method: 'POST', headers: { ...JSON_HEADER, Origin: 'https://other.example' }, body: '{}' })).status, 403)
})

// K1: 写路由统一接共享闸门(withRouteGate) —— 浏览器简单请求(text/plain)不触发预检,
// 必须显式 400; 同源比较大小写不敏感; GET 无写副作用只过宿主闸门, 不受 Origin/CT 限制。
// 用原始 http.request 精确控制 Origin/Host(浏览器与 fetch 都不允许改 Host)
function rawRequest(port, path, { method = 'GET', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const request = http.request({ hostname: '127.0.0.1', port, path, method, headers }, response => {
      const chunks = []
      response.on('data', chunk => chunks.push(chunk))
      response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, text: Buffer.concat(chunks).toString('utf8') }))
    })
    request.on('error', reject)
    if (body !== undefined) request.write(body)
    request.end()
  })
}
test('K1 写路由闸门: text/plain 400、Host 大小写同源、GET 只过宿主闸门', async t => {
  const routes = new Map()
  const seen = []
  const app = { snapshot: () => ({ snapshotSeq: 1 }), refresh: async () => { seen.push('refresh'); return { snapshotSeq: 2 } } }
  const stop = registerRoutes({ register: r => { routes.set(r.path, r.handler); return () => routes.delete(r.path) } }, app)
  const server = http.createServer((req, res) => { const handler = routes.get(new URL(req.url, 'http://local').pathname); if (handler) handler(req, res); else { res.statusCode = 404; res.end() } })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(async () => { stop(); await new Promise(resolve => server.close(resolve)) })
  const port = server.address().port, prefix = '/api/stock-assistant'
  // 跨站表单可用的三种简单请求 content-type 都必须被拒, 且不触达业务
  for (const contentType of ['text/plain', 'application/jsonp', 'application/x-www-form-urlencoded']) {
    const plain = await rawRequest(port, `${prefix}/refresh`, { method: 'POST', headers: { 'content-type': contentType }, body: '{}' })
    assert.equal(plain.status, 400, `${contentType} 必须 400`)
    assert.equal(JSON.parse(plain.text).error, 'content-type 须为 application/json')
  }
  assert.deepEqual(seen, [], '被闸门拒绝的请求不得触达业务')
  // 带 charset 的 JSON 是合法 essence
  const json = await rawRequest(port, `${prefix}/refresh`, { method: 'POST', headers: { 'content-type': 'application/json; charset=utf-8' }, body: '{}' })
  assert.equal(json.status, 200)
  // Host 大小写不同仍是同源(Origin host 与 Host 都按小写比较)
  const mixed = await rawRequest(port, `${prefix}/refresh`, { method: 'POST', headers: { host: 'Example.COM:3080', origin: 'http://example.com:3080', 'content-type': 'application/json' }, body: '{}' })
  assert.equal(mixed.status, 200, 'Host 大小写不影响同源判定')
  const reverse = await rawRequest(port, `${prefix}/refresh`, { method: 'POST', headers: { host: 'example.com:3080', origin: 'http://EXAMPLE.com:3080', 'content-type': 'application/json' }, body: '{}' })
  assert.equal(reverse.status, 200, 'Origin host 大小写不影响同源判定')
  const cross = await rawRequest(port, `${prefix}/refresh`, { method: 'POST', headers: { host: 'example.com:3080', origin: 'http://other.example:3080', 'content-type': 'application/json' }, body: '{}' })
  assert.equal(cross.status, 403)
  // GET 无写副作用: 跨源与非 JSON 都不拦, 只回问宿主闸门
  const get = await rawRequest(port, `${prefix}/snapshot`, { headers: { origin: 'http://other.example', 'content-type': 'text/plain' } })
  assert.equal(get.status, 200)
  const getJson = JSON.parse(get.text)
  assert.equal(getJson.data.snapshotSeq, 1)
})
// P1-12/P3: 12 条业务路由都必须首行回问宿主闸门; 漏调一条即无 cookie 直达业务面
test('全部 /api/stock-assistant 路由在宿主拒绝时 401 且不触达业务', async t => {
  const routes = new Map(), calls = []
  const app = new Proxy({}, { get: (_, key) => (...args) => { calls.push(key); return { args } } })
  const stop = registerRoutes({ register: route => { routes.set(route.path, route.handler); return () => routes.delete(route.path) } }, app, { get: name => name === 'connection' ? { requestRejection: () => 401 } : undefined })
  const server = http.createServer((req, res) => { const handler = routes.get(new URL(req.url, 'http://local').pathname); if (handler) handler(req, res); else { res.statusCode = 404; res.end() } })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(async () => { stop(); await new Promise(resolve => server.close(resolve)) })
  const base = `http://127.0.0.1:${server.address().port}/api/stock-assistant`
  // 闸门覆盖率靠「注册了什么就查什么」: 写死清单会让新增路由逃过这条用例
  const names = [...routes.keys()].map(path => path.split('/').at(-1))
  for (const name of names) {
    const response = await fetch(`${base}/${name}`)
    assert.equal(response.status, 401, `${name} 必须先过宿主闸门`)
    assert.equal(await response.text(), 'unauthorized')
  }
  assert.deepEqual(calls, [], '闸门拒绝时不得调用应用层')
})

// M4: Givenbrowse端点 When越界参数 Then钳制返回200空页不抛错
test('browse端点HTTP层钳制越界参数并返回分页结构', async t => {
  const routes = new Map()
  const app = { browse: async ({ market, offset, limit }) => { if (!['XSHG', 'XSHE'].includes(market)) fail('INVALID_REQUEST', '市场参数无效'); return { market, offset, limit, total: 0, items: [] } } }
  const stop = registerRoutes({ register: r => { routes.set(r.path, r.handler); return () => routes.delete(r.path) } }, app)
  const server = http.createServer((req, res) => { const handler = routes.get(new URL(req.url, 'http://local').pathname); if (handler) handler(req, res); else { res.statusCode = 404; res.end() } })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(async () => { stop(); await new Promise(resolve => server.close(resolve)) })
  const base = `http://127.0.0.1:${server.address().port}/api/stock-assistant`
  const ok = await (await fetch(base + '/browse?market=XSHG&offset=-5&limit=99999')).json()
  assert.equal(ok.ok, true)
  assert.deepEqual(ok.data.items, [])
  const bad = await (await fetch(base + '/browse?market=NYSE&offset=0&limit=50')).json()
  assert.equal(bad.ok, false)
  assert.equal(bad.error.code, 'INVALID_REQUEST')
})
// B-1保存回路: Given未做探针的配置提交 When直接保存 Then成功;探针独立为诊断接口
test('configuration无需checkId即可保存,探针独立可调用', async t => {  const routes = new Map()
  const providers = [{ id: 'p1', adapterId: 'fake', enabled: true, credentialRef: null, quotaGroup: 'g', budget: { requestsPerMinute: 60, dailyRequestLimit: null, billingUnit: 'request', symbolCreditsPerMinute: null, capabilityLimits: {} } }]
  const routesCfg = [{ id: 'sh-quotes', capability: 'quotes', market: 'XSHG', instrument: 'equity', primaryInstanceId: 'p1', fallbackInstanceIds: [], failoverMode: 'off', maxDelaySeconds: null, acceptUnknownDelay: true }]
  const app = {
    providerCheck: async () => ({ checkId: 'ck-1', checks: [{ key: 'p1:quotes:XSHG', providerInstanceId: 'p1', capability: 'quotes', market: 'XSHG', status: 'ready', ms: 42 }] }),
    configuration: async () => ({ revision: 2, unchanged: false }),
  }
  const stop = registerRoutes({ register: r => { routes.set(r.path, r.handler); return () => routes.delete(r.path) } }, app)
  const server = http.createServer((req, res) => { const handler = routes.get(new URL(req.url, 'http://local').pathname); if (handler) handler(req, res); else { res.statusCode = 404; res.end() } })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(async () => { stop(); await new Promise(resolve => server.close(resolve)) })
  const base = `http://127.0.0.1:${server.address().port}/api/stock-assistant`
  const saved = await (await fetch(base + '/configuration', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ operationId: crypto.randomUUID(), expectedRevision: 1, providers, routes: routesCfg }) })).json()
  assert.equal(saved.ok, true)
  const check = await (await fetch(base + '/provider-check', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ providers, routes: routesCfg, capabilities: ['quotes'] }) })).json()
  assert.equal(check.ok, true)
  assert.equal(check.data.checks[0].ms, 42, '探针回传耗时')
})

// ---- Step 1.6: kline HTTP 接线 ----

test('kline端点 GET 接线 参数校验与透传', async t => {
  const routes = new Map()
  const seen = []
  const app = { kline: async (input, signal) => { seen.push({ input, signalType: typeof signal }); return { candles: [], source: 'em-default' } } }
  const stop = registerRoutes({ register: r => { routes.set(r.path, r.handler); return () => routes.delete(r.path) } }, app)
  const server = http.createServer((req, res) => { const handler = routes.get(new URL(req.url, 'http://local').pathname); if (handler) handler(req, res); else { res.statusCode = 404; res.end() } })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(async () => { stop(); await new Promise(resolve => server.close(resolve)) })
  const base = `http://127.0.0.1:${server.address().port}/api/stock-assistant`
  const ok = await (await fetch(base + '/kline?securityId=XSHG%3Aequity%3A600519&period=1d')).json()
  assert.equal(ok.ok, true)
  assert.equal(seen[0].input.limit, undefined, 'limit 默认值由 application 层 schema 补齐,HTTP 层透传原文')
  assert.equal(seen[0].signalType, 'object')
  // 参数校验在 application 层(见 kline-app.test); HTTP 层 stub 不校验, 200 透传
  assert.equal((await (await fetch(base + '/kline?period=1d')).json()).ok, true)
  assert.equal((await fetch(base + '/kline?securityId=XSHG%3Aequity%3A600519&period=1d', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status, 405)
})

test('kline端点错误码→HTTP状态与error体透传(client重试与引导判据依赖)', async t => {
  const routes = new Map()
  const app = { kline: async () => fail('NO_ROUTE', '未配置该市场的数据来源', 422) }
  const stop = registerRoutes({ register: r => { routes.set(r.path, r.handler); return () => routes.delete(r.path) } }, app)
  const server = http.createServer((req, res) => { const handler = routes.get(new URL(req.url, 'http://local').pathname); if (handler) handler(req, res); else { res.statusCode = 404; res.end() } })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(async () => { stop(); await new Promise(resolve => server.close(resolve)) })
  const base = `http://127.0.0.1:${server.address().port}/api/stock-assistant`
  const noRoute = await (await fetch(base + '/kline?securityId=XSHG%3Aequity%3A600519&period=1d')).json()
  assert.equal(noRoute.ok, false)
  assert.equal(noRoute.error.code, 'NO_ROUTE', 'error.code 必须透传, client 引导按钮按 code 判')
  app.kline = async () => fail('RATE_LIMIT', '数据源额度受限，请稍后重试', 429, { retryable: true, retryAfterMs: 58000 })
  const res = await fetch(base + '/kline?securityId=XSHG%3Aequity%3A600519&period=1d')
  const rate = await res.json()
  assert.equal(res.status, 429, 'HTTP 状态随 StockError.status 透传')
  assert.equal(rate.error.code, 'RATE_LIMIT')
  assert.equal(rate.error.retryAfterMs, 58000, 'retryAfterMs 透传供 client 退避')
})

// C3-1: 服务端超时 timer 会先 abort 再 reject, abort 监听同步抢走 Promise.race 会把超时报成 CANCELLED;
// 必须让超时错误走 abort reason 或先于 abort 落定, 客户端才能按 TIMEOUT 退避重试
test('C3-1 三类路由超时都返回 TIMEOUT 而不是 CANCELLED', async t => {
  const routes = new Map()
  // 永不返回的业务动作: 只能由路由层超时收尾
  const never = () => new Promise(() => {})
  const app = { snapshot: never, providerCheck: never, sync: never }
  const stop = registerRoutes({ register: r => { routes.set(r.path, r.handler); return () => routes.delete(r.path) } }, app)
  t.after(() => stop())
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const cases = [
    ['snapshot', 'GET', undefined, 10 * 1000],
    ['provider-check', 'POST', '{}', 60 * 1000],
    ['catalog-sync', 'POST', '{}', 120 * 1000],
  ]
  for (const [name, method, payload, timeout] of cases) {
    const chunks = []
    const res = {
      statusCode: 0, headers: {}, destroyed: false, writableEnded: false,
      writeHead(status, headers) { this.statusCode = status; Object.assign(this.headers, headers) },
      setHeader(name, value) { this.headers[name.toLowerCase()] = value },
      end(text) { this.writableEnded = true; chunks.push(text) },
      on() {}, removeListener() {},
    }
    const req = {
      method,
      url: `/api/stock-assistant/${name}`,
      headers: method === 'POST' ? { 'content-type': 'application/json' } : {},
      async *[Symbol.asyncIterator]() { if (payload !== undefined) yield Buffer.from(payload) },
    }
    const flight = routes.get(`/api/stock-assistant/${name}`)(req, res)
    // 等请求体读取与 timer 注册完成(只 mock 了 setTimeout, setImmediate 仍是真实的)
    await new Promise(resolve => setImmediate(resolve))
    t.mock.timers.tick(timeout)
    await flight
    const body = JSON.parse(chunks.join(''))
    assert.equal(res.statusCode, 504, `${name} 超时状态`)
    assert.equal(body.ok, false, `${name} 超时体`)
    assert.equal(body.error.code, 'TIMEOUT', `${name} 超时必须可退避, 不能被 abort 监听抢先报取消`)
  }
})
