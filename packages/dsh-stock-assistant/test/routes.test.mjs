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
  const response = await fetch(base + '/refresh', { method: 'POST', body: '{}' })
  assert.equal(response.status, 200)
  assert.equal((await response.json()).data.snapshotSeq, 2)
  assert.equal((await fetch(base + '/snapshot', { method: 'POST', body: '{}' })).status, 405)
  assert.equal(response.headers.get('cache-control'), 'no-store')
  assert.equal((await fetch(base + '/refresh', { method: 'POST', body: 'null' })).status, 400)
  assert.equal((await fetch(base + '/refresh', { method: 'POST', body: '[' })).status, 400)
  assert.equal((await fetch(base + '/refresh', { method: 'POST', body: '{}', headers: { Origin: 'https://other.example' } })).status, 403)
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
  const providers = [{ id: 'p1', adapterId: 'fake', enabled: true, credentialEnv: null, quotaGroup: 'g', budget: { requestsPerMinute: 60, dailyRequestLimit: null, billingUnit: 'request', symbolCreditsPerMinute: null, capabilityLimits: {} } }]
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
  assert.equal((await fetch(base + '/kline?securityId=XSHG%3Aequity%3A600519&period=1d', { method: 'POST', body: '{}' })).status, 405)
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
