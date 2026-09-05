// host 路由层最小测试:settings GET 的 pollArmed 形态(定时软依赖两形态)。
// 防回归:pollArmed 被误改回在途互斥标志或字段名回退时,此处变红。
// apply 顶层无 IO(historyStore 惰性加载),minimal ctx 即可装配。
// 通知接线路由测试在 notify.route.test.mjs(数据目录经 env 注入)。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { apply } from '../src/index.js'

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

function makeReq(method) {
  const req = new EventEmitter()
  req.method = method
  req.headers = { host: 'localhost:3000' }
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
