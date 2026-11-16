// host 路由层最小测试:settings GET 的 pollArmed 形态(定时软依赖两形态)+ 写路由守卫全覆盖
// + accounts 损坏守卫。数据目录经 env 注入临时路径,须在 import src/index.js 之前设置。
// 通知接线路由测试在 notify.route.test.mjs(独立进程独立数据目录)。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { createServer } from 'node:http'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const tempDir = await mkdtemp(join(tmpdir(), 'usage-route-'))
process.env.DSH_USAGE_PANEL_DATA_DIR = tempDir

const { apply } = await import('../src/index.js')

test.after(async () => {
  delete process.env.DSH_USAGE_PANEL_DATA_DIR
  await rm(tempDir, { recursive: true, force: true })
})

function makeCtx({ timerAvailable = true, settingsValue = {}, dshIm = undefined } = {}) {
  let value = settingsValue
  const routes = new Map()
  // 真实 tick 驱动:timer 桩捕获 interval 回调与周期,供用例手动触发;
  // 旧桩只 void 回调,导致 tick 零覆盖(A1 假绿)
  const intervals = []
  const settingsService = {
    register() {},
    get: () => value,
    update: async (_ns, patch) => {
      value = { ...value, ...patch }
    },
  }
  const ctx = {
    get(name) {
      if (name === 'settings') return settingsService
      if (name === 'dshIm') return dshIm
      return undefined
    },
    effect(fn) {
      fn()
    },
    inject(deps, fn) {
      // timer 服务桩:模拟宿主 timer 激活后的 interval(返回 disposer 同官方契约)
      fn({
        settings: settingsService,
        interval: timerAvailable
          ? (intervalFn, ms) => {
              intervals.push({ fn: intervalFn, ms })
              return () => {}
            }
          : undefined,
      })
    },
    webServer: {
      register(route) {
        routes.set(route.path, route.handler)
      },
    },
  }
  return { ctx, routes, intervals }
}

async function waitFor(check, timeoutMs = 3000) {
  const startedAt = Date.now()
  while (Date.now() - startedAt < timeoutMs) {
    const value = await check()
    if (value) return value
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error('waitFor timeout')
}

// kimi 形态读数:5 小时窗 95% 已用 / 7 天窗 50%
const KIMI_BODY = {
  limits: [{ detail: { limit: 100, remaining: 5, resetTime: 'T1' } }],
  usage: { limit: 200, remaining: 100, resetTime: 'T2' },
}

function stubUpstream() {
  const control = { calls: 0, release: null }
  const original = globalThis.fetch
  control.restore = () => { globalThis.fetch = original }
  globalThis.fetch = () => {
    control.calls += 1
    return new Promise((resolve) => {
      control.release = () => resolve({
        ok: true,
        status: 200,
        text: async () => JSON.stringify(KIMI_BODY),
      })
    })
  }
  return control
}

function makeReq(method, { origin, contentType, body, host } = {}) {
  const req = new EventEmitter()
  req.method = method
  req.headers = { host: host ?? 'localhost:3000' }
  if (origin !== undefined) req.headers.origin = origin
  if (contentType !== undefined) req.headers['content-type'] = contentType
  if (body !== undefined) {
    process.nextTick(() => {
      req.emit('data', Buffer.from(typeof body === 'string' ? body : JSON.stringify(body)))
      req.emit('end')
    })
  }
  return req
}

async function call(routes, path, req) {
  const res = { status: null, payload: null }
  res.writeHead = (status) => { res.status = status }
  res.end = (text) => { res.payload = JSON.parse(text) }
  await routes.get(path)(req, res)
  return res
}

test('settings:timer 服务激活时 pollArmed 为 true', async () => {
  const { ctx, routes } = makeCtx({ timerAvailable: true })
  apply(ctx)
  const res = await call(routes, '/api/usage-panel/settings', makeReq('GET'))
  assert.equal(res.status, 200)
  assert.equal(res.payload.pollArmed, true)
})

// 启动即预载配置:tick 驱动自动查询的先决条件——懒加载形态下宿主重启后
// 到首个面板请求之间 config 为 null,tick 空转,自动查询静默停摆
test('settings:timer 激活即预载配置(tick 不因 config 空窗停摆)', async () => {
  const { ctx, routes } = makeCtx({ timerAvailable: true })
  apply(ctx)
  // ensureConfig 异步读盘;await 一拍微任务让它完成
  await new Promise((resolve) => setImmediate(resolve))
  const res = await call(routes, '/api/usage-panel/accounts', makeReq('GET'))
  assert.equal(res.status, 200)
  assert.ok(Array.isArray(res.payload.accounts), '配置已载入内存,轮询具备调度对象')
})

test('A1 tick 真实回调:到点查询命中上游、queriedAt 落盘、history 生成,在途重入被拦', async () => {
  // Given 启动前已有配置(验证 apply 预载路径,而非面板请求后才懒加载)
  await writeFile(join(tempDir, 'accounts.json'), JSON.stringify({
    version: 1,
    accounts: [{ id: 'acct-tick', name: '轮询账号', type: 'kimi', apiKey: 'sk-test' }],
  }), 'utf8')
  const { ctx, routes, intervals } = makeCtx({ timerAvailable: true })
  apply(ctx)
  assert.equal(intervals.length, 1, 'timer 激活必须武装一个轮询 interval')
  const fetchControl = stubUpstream()
  try {
    // When 手动触发真实 tick:配置预载完成前空转,完成后必须到点查询
    await waitFor(() => {
      intervals[0].fn()
      return fetchControl.calls > 0
    })
    assert.equal(fetchControl.calls, 1, 'tick 必须真的发起上游查询,而非空转')
    // 首个 tick 仍在途:再次触发必须被 pollInFlight 拦住
    intervals[0].fn()
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal(fetchControl.calls, 1, '在途重入不得再次打上游')

    fetchControl.release()
    const saved = await waitFor(async () => {
      try {
        const parsed = JSON.parse(await readFile(join(tempDir, 'accounts.json'), 'utf8'))
        return parsed.accounts[0].last?.queriedAt ? parsed : null
      } catch {
        return null
      }
    })
    // Then last.queriedAt 随配置持久化(重启后调度不丢基线)
    assert.equal(typeof saved.accounts[0].last.queriedAt, 'number')
    assert.equal(saved.accounts[0].last.ok, true)
    // Then 成功读数生成历史序列(历史落盘先于配置落盘发生,此处必已存在)
    const historyRes = await call(routes, '/api/usage-panel/history', makeReq('GET'))
    assert.equal(historyRes.status, 200)
    assert.ok(
      Object.keys(historyRes.payload.sequences).some((key) => key.startsWith('acct-tick:')),
      'tick 查询成功必须生成历史序列',
    )
  } finally {
    fetchControl.restore()
  }
})

test('settings:timer 服务缺失时 pollArmed 为 false(降级可见)', async () => {
  const { ctx, routes } = makeCtx({ timerAvailable: false })
  apply(ctx)
  const res = await call(routes, '/api/usage-panel/settings', makeReq('GET'))
  assert.equal(res.status, 200)
  assert.equal(res.payload.pollArmed, false)
})

test('settings:写方法已收缩,POST 405 不再接受间隔设置', async () => {
  const { ctx, routes } = makeCtx()
  apply(ctx)
  const res = await call(routes, '/api/usage-panel/settings', makeReq('POST', {
    contentType: 'application/json',
    origin: 'http://localhost:3000',
    body: '{"pollIntervalSec":60}',
  }))
  assert.equal(res.status, 405)
})

// 写路由守卫全覆盖:POST 路由的跨源与 content-type 守卫逐路由验证,
// 防 drive-by 简单请求改写账号配置(含注入攻击者端点账号);POST-only 路由 GET 必须 405
// (GET 无守卫,放行即给跨站 <img src> 驱动测试通道外发的面)。
test('守卫:全部 POST 路由拒绝跨源与非 JSON,POST-only 路由拒绝 GET', async () => {
  const { ctx, routes } = makeCtx()
  apply(ctx)
  const dualPaths = [
    '/api/usage-panel/accounts',
    '/api/usage-panel/notify-config',
  ]
  const postOnlyPaths = [
    '/api/usage-panel/query',
    '/api/usage-panel/test-webhook',
    '/api/usage-panel/test-im',
  ]
  for (const path of [...dualPaths, ...postOnlyPaths]) {
    const cross = await call(routes, path, makeReq('POST', {
      origin: 'http://evil.example',
      contentType: 'application/json',
      body: '{"accounts":[]}',
    }))
    assert.equal(cross.status, 403, path + ' 跨源未拒')
    const nonJson = await call(routes, path, makeReq('POST', {
      origin: 'http://localhost:3000',
      contentType: 'text/plain',
      body: '{"accounts":[]}',
    }))
    assert.equal(nonJson.status, 400, path + ' 非 JSON 未拒')
    assert.match(nonJson.payload.error, /content-type/, path + ' 400 须出自守卫层而非业务校验')
  }
  for (const path of postOnlyPaths) {
    const get = await call(routes, path, makeReq('GET'))
    assert.equal(get.status, 405, path + ' POST-only 路由放行了 GET')
  }
  const read = await call(routes, '/api/usage-panel/accounts', makeReq('GET'))
  assert.equal(read.status, 200, 'GET 读路由放行')
})

test('accounts:损坏配置文件拒绝一切写入,放回合法文件后才恢复', async () => {
  await writeFile(join(tempDir, 'accounts.json'), '{broken', 'utf8')
  const { ctx, routes } = makeCtx()
  apply(ctx)
  const first = await call(routes, '/api/usage-panel/accounts', makeReq('POST', {
    origin: 'http://localhost:3000',
    contentType: 'application/json',
    body: '{"accounts":[]}',
  }))
  assert.equal(first.status, 400)
  assert.match(first.payload.error, /损坏/)
  // 坏文件已备份;损坏态保持,不因备份移走(ENOENT)自动解除
  const get = await call(routes, '/api/usage-panel/accounts', makeReq('GET'))
  assert.equal(get.status, 200)
  assert.deepEqual(get.payload.accounts, [])
  const second = await call(routes, '/api/usage-panel/accounts', makeReq('POST', {
    origin: 'http://localhost:3000',
    contentType: 'application/json',
    body: '{"accounts":[]}',
  }))
  assert.equal(second.status, 400, '损坏态必须拒写一切写入,不只挡一次')
  // 用户放回合法文件:重读成功解除损坏,写入恢复
  await writeFile(join(tempDir, 'accounts.json'), JSON.stringify({ version: 1, accounts: [] }), 'utf8')
  const save = await call(routes, '/api/usage-panel/accounts', makeReq('POST', {
    origin: 'http://localhost:3000',
    contentType: 'application/json',
    body: '{"accounts":[{"id":"acct-r","type":"custom"}]}',
  }))
  assert.equal(save.status, 200, '合法文件恢复后写入恢复')
})

test('守卫:content-type 精确匹配,JSON.parse 错误回固定中文', async () => {
  const { ctx, routes } = makeCtx()
  apply(ctx)
  // 子串包含 application/json 但媒体类型不是 JSON:必须拒绝
  const trick = await call(routes, '/api/usage-panel/accounts', makeReq('POST', {
    origin: 'http://localhost:3000',
    contentType: 'text/plain; application/json',
    body: '{"accounts":[]}',
  }))
  assert.equal(trick.status, 400)
  assert.match(trick.payload.error, /content-type/)
  // 合法 JSON 媒体类型但体损坏:固定中文,不回传 JSON.parse 英文原文
  const malformed = await call(routes, '/api/usage-panel/accounts', makeReq('POST', {
    origin: 'http://localhost:3000',
    contentType: 'application/json; charset=utf-8',
    body: '{"accounts": [',
  }))
  assert.equal(malformed.status, 400)
  assert.equal(malformed.payload.error, '请求体必须是合法 JSON')
})

// U5:写路由接入共享 withRouteGate —— 同源比对大小写不敏感(旧本地实现比较原始 host 串)
test('守卫:Host 头部大写仍按同源放行(共享网关大小写不敏感)', async () => {
  const { ctx, routes } = makeCtx()
  apply(ctx)
  const res = await call(routes, '/api/usage-panel/query', makeReq('POST', {
    origin: 'http://localhost:3000',
    contentType: 'application/json',
    body: '{"id":"missing"}',
  }))
  // 业务侧账号不存在 → 400;关键是不被跨源守卫误拒为 403
  assert.equal(res.status, 400)
  const upper = await call(routes, '/api/usage-panel/notify-config', makeReq('POST', {
    origin: 'http://LOCALHOST:3000',
    contentType: 'application/json',
    body: '{}',
    host: 'LOCALHOST:3000',
  }))
  assert.equal(upper.status, 200)
})

// U8:读体超限不 destroy 连接,413 经真实 socket 送回(旧实现 destroy 后连接重置)
test('读体超限:真实 socket 收到 413 而非连接重置', async () => {
  const { ctx, routes } = makeCtx()
  apply(ctx)
  const server = createServer((req, res) => {
    const handler = routes.get(new URL(req.url, 'http://localhost').pathname)
    if (!handler) {
      res.writeHead(404)
      res.end()
      return
    }
    handler(req, res)
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const origin = 'http://127.0.0.1:' + server.address().port
  try {
    const oversized = 'x'.repeat(300 * 1024)
    const response = await fetch(origin + '/api/usage-panel/query', {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin },
      body: JSON.stringify({ id: 'acct-body', pad: oversized }),
    })
    assert.equal(response.status, 413)
    assert.match((await response.json()).error, /超过上限/)
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
})

test('读体被客户端中断:以 400 结束,不悬挂', async () => {
  const { ctx, routes } = makeCtx()
  apply(ctx)
  const req = makeReq('POST', { origin: 'http://localhost:3000', contentType: 'application/json' })
  const res = { status: null, payload: null }
  res.writeHead = (status) => { res.status = status }
  res.end = (text) => { res.payload = JSON.parse(text) }
  const settled = routes.get('/api/usage-panel/query')(req, res)
  process.nextTick(() => req.emit('aborted'))
  await settled
  assert.equal(res.status, 400)
  assert.match(res.payload.error, /中断/)
})
