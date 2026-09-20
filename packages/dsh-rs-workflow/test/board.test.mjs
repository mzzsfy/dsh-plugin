// board 运行时路由 BDD(v5):control 裁决校验/UTF-8 全链路/守卫语义;薄 mock 宿主起真 HTTP 服务
// store 走真实单例(裁决分支读 sessionId),故全程 DSH_RS_WORKFLOW_DATA_DIR 指临时目录防污染
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { createServer, request as httpRequest } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { registerBoardRoutes } from '../lib/board.mjs'
import { registry, unregisterDriver, registerResumer, unregisterResumer } from '../lib/driver/control.mjs'
import { reportStore } from '../lib/store.mjs'

process.env.DSH_RS_WORKFLOW_DATA_DIR = mkdtempSync(join(tmpdir(), 'rsww-board-'))
const cleanDataDir = () => rmSync(process.env.DSH_RS_WORKFLOW_DATA_DIR, { recursive: true, force: true })

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

const postJsonHost = (base, path, body, host) => new Promise((resolve, reject) => {
  // undici fetch 忽略手动 Host 头;node:http 可伪造(等价 rebinding 场景)
  const url = new URL(base + path)
  const req = httpRequest({ hostname: url.hostname, port: url.port, path, method: 'POST', headers: { 'content-type': 'application/json; charset=utf-8', host } }, (res) => {
    let raw = ''
    res.on('data', (c) => { raw += c })
    res.on('end', () => resolve({ status: res.statusCode, json: async () => JSON.parse(raw) }))
  })
  req.on('error', reject)
  req.end(JSON.stringify(body))
})

// 桩 driver:注册进 registry,handlePost 回显受理(control 裁决通路走 post(runId, event));
// 同步向真实 store 注入 run 记录(handleControl 裁决分支要读 sessionId)
function stubDriver(runId, sessionId = 'session-stub') {
  const received = []
  reportStore().start({ runId, sessionId, request: 'R', templateId: 't' })
  registry.drivers.set(runId, {
    handlePost: (event) => { received.push(event); return true },
    cancel: () => {}, pause: () => {}, tabResume: () => false,
  })
  return { received, dispose: () => unregisterDriver(runId) }
}

test('Given 伪造 Host(rebinding 形态) When POST control Then 403 拒绝(Host fence 自守)', async () => {
  const board = await startBoard()
  const stub = stubDriver('r-board-fence')
  try {
    // 插件 exact 路由早于宿主 /api 前缀路由命中,宿主 fence 拦不到,须自守
    const res = await postJsonHost(board.base, '/api/rsww/control', { runId: 'r-board-fence', kind: 'approve', by: 'user', reason: 'x' }, 'evil.example.com')
    assert.equal(res.status, 403)
    assert.equal(stub.received.length, 0)
    // 回环名照常放行
    const ok = await postJson(board.base, '/api/rsww/control', { runId: 'r-board-fence', kind: 'approve', by: 'user', reason: 'x' })
    assert.equal(ok.status, 200)
  } finally {
    stub.dispose()
    await board.close()
  }
})

after(() => cleanDataDir())

test('Given UTF-8 中文裁决(页签驳回带意见) When POST control Then 受理且 reason 全文无损', async () => {
  const board = await startBoard()
  const stub = stubDriver('r-board-1')
  try {
    const reason = '口径偏差:需含「验收口径」节——中文标点与引号"测试"'
    const res = await postJson(board.base, '/api/rsww/control', { runId: 'r-board-1', kind: 'reject', by: 'user', reason })
    assert.equal(res.status, 200)
    assert.deepEqual(await res.json(), { ok: true, resumed: false })
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
    assert.deepEqual(await res.json(), { ok: true, resumed: false })
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

test('Given 页签裁决受理且无活跃段 When POST control Then 按会话挂靠拉起下一段(一次)', async () => {
  const board = await startBoard()
  const stub = stubDriver('r-board-4', 'session-4')
  const pulls = []
  registry.drivers.get('r-board-4').active = false
  registerResumer('session-4', (runId) => { pulls.push(runId); return true })
  try {
    const res = await postJson(board.base, '/api/rsww/control', { runId: 'r-board-4', kind: 'reject', by: 'user', reason: '重做' })
    assert.equal(res.status, 200)
    assert.deepEqual(await res.json(), { ok: true, resumed: true })
    assert.deepEqual(pulls, ['r-board-4'])
  } finally {
    unregisterResumer('session-4')
    stub.dispose()
    await board.close()
  }
})

test('Given 无会话挂靠(重启后) When 页签裁决 Then 受理但不拉段,响应 resumed:false', async () => {
  const board = await startBoard()
  const stub = stubDriver('r-board-5')
  try {
    const res = await postJson(board.base, '/api/rsww/control', { runId: 'r-board-5', kind: 'approve', by: 'user' })
    assert.equal(res.status, 200)
    assert.deepEqual(await res.json(), { ok: true, resumed: false })
  } finally {
    stub.dispose()
    await board.close()
  }
})
