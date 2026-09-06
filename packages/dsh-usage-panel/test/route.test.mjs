// host 路由层最小测试:settings GET 的 pollArmed 形态(定时软依赖两形态)+ 写路由守卫全覆盖
// + accounts 损坏守卫。数据目录经 env 注入临时路径,须在 import src/index.js 之前设置。
// 通知接线路由测试在 notify.route.test.mjs(独立进程独立数据目录)。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
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
          ? (intervalFn) => {
              void intervalFn
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
  return { ctx, routes }
}

function makeReq(method, { origin, contentType, body } = {}) {
  const req = new EventEmitter()
  req.method = method
  req.headers = { host: 'localhost:3000' }
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

test('accounts:损坏配置文件拒绝写入并备份(broken 守卫)', async () => {
  await writeFile(join(tempDir, 'accounts.json'), '{broken', 'utf8')
  const { ctx, routes } = makeCtx()
  apply(ctx)
  const res = await call(routes, '/api/usage-panel/accounts', makeReq('POST', {
    origin: 'http://localhost:3000',
    contentType: 'application/json',
    body: '{"accounts":[]}',
  }))
  assert.equal(res.status, 400)
  assert.match(res.payload.error, /损坏/)
  // 坏文件已备份移走;重读(解除路径)后 GET 得空配置,写入恢复
  const get = await call(routes, '/api/usage-panel/accounts', makeReq('GET'))
  assert.equal(get.status, 200)
  assert.deepEqual(get.payload.accounts, [])
  const save = await call(routes, '/api/usage-panel/accounts', makeReq('POST', {
    origin: 'http://localhost:3000',
    contentType: 'application/json',
    body: '{"accounts":[{"id":"acct-r","type":"custom"}]}',
  }))
  assert.equal(save.status, 200, '重读解除损坏后写入恢复')
})
