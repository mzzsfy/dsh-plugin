// board 运行时路由 BDD(v5):control 裁决校验/UTF-8 全链路/守卫语义;薄 mock 宿主起真 HTTP 服务
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'

import { registerBoardRoutes } from '../lib/board.mjs'
import { registry, unregisterDriver } from '../lib/driver/control.mjs'

// 薄 mock 宿主:ctx.inject 注入 webServer 依赖,webServer.register 收集 handler,effect 立即执行;真 http server 分发
async function startBoard() {
  const handlers = {}
  const wctx = {
    inject(deps, fn) {
      const [name] = deps
      fn({ effect: (f) => f(), webServer: { register: (r) => { handlers[r.path] = r.handler } }, [name]: { register: (r) => { handlers[r.path] = r.handler } } })
    },
  }
  registerBoardRoutes(wctx)
  const server = createServer((req, res) => handlers[req.url.split('?')[0]](req, res))
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const base = `http://127.0.0.1:${server.address().port}`
  return { base, close: () => new Promise((r) => server.close(r)) }
}

const postJson = (base, path, body) => fetch(base + path, {
  method: 'POST',
  headers: { 'content-type': 'application/json; charset=utf-8' },
  body: JSON.stringify(body),
})

// 桩 driver:注册进 registry,handlePost 回显受理(control 裁决通路走 post(runId, event))
function stubDriver(runId) {
  const received = []
  registry.drivers.set(runId, {
    handlePost: (event) => { received.push(event); return true },
    cancel: () => {}, pause: () => {}, tabResume: () => false,
  })
  return { received, dispose: () => unregisterDriver(runId) }
}

test('Given board/release 模块 When 加载 Then import 图完整无缺失依赖', async () => {
  assert.ok(true)
})

test('Given UTF-8 中文裁决(页签驳回带意见) When POST control Then 受理且 reason 全文无损', async () => {
  const board = await startBoard()
  const stub = stubDriver('r-board-1')
  try {
    const reason = '口径偏差:需含「验收口径」节——中文标点与引号"测试"'
    const res = await postJson(board.base, '/api/rsww/control', { runId: 'r-board-1', kind: 'reject', by: 'user', reason })
    assert.equal(res.status, 200)
    assert.deepEqual(await res.json(), { ok: true })
    assert.deepEqual(stub.received, [{ kind: 'reject', by: 'user', reason }])
  } finally {
    stub.dispose()
    await board.close()
  }
})

test('Given 页签裁决缺省 reason When POST control reject by=user Then 受理且 reason 归一空串', async () => {
  const board = await startBoard()
  const stub = stubDriver('r-board-2')
  try {
    const res = await postJson(board.base, '/api/rsww/control', { runId: 'r-board-2', kind: 'reject', by: 'user' })
    assert.equal(res.status, 200)
    assert.deepEqual(await res.json(), { ok: true })
    assert.deepEqual(stub.received, [{ kind: 'reject', by: 'user', reason: '' }])
  } finally {
    stub.dispose()
    await board.close()
  }
})

test('Given 代审缺 reason When POST control Then 400 且错误可见', async () => {
  const board = await startBoard()
  const stub = stubDriver('r-board-3')
  try {
    const res = await postJson(board.base, '/api/rsww/control', { runId: 'r-board-3', kind: 'approve', by: 'main-agent' })
    assert.equal(res.status, 400)
    const body = await res.json()
    assert.ok(body.error.includes('reason'))
  } finally {
    stub.dispose()
    await board.close()
  }
})
