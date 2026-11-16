// 写请求体上限(BDD):超限必须回结构化 413,且连接不被撕 —— 同一 keep-alive 连接上的
// 下一个请求照常受理。用真实 http 服务 + keep-alive agent 验证:EventEmitter 桩测不出
// socket 生命周期,destroy / pause / 排空三种收尾在桩上完全同形。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { BODY_MAX_BYTES, createApi } from '../src/api.mjs'
import { createExecutor } from '../src/executor.mjs'
import { createLogger } from '../src/logger.mjs'
import { createStore } from '../src/store.mjs'
import { withRouteGate } from '../src/route-gate.mjs'

const CHUNK_BYTES = 8 * 1024
// 超限体的 prompt 长度:合法 JSON 形态的长 prompt(与真实触发场景一致:导入/编辑提交超大文本)
const OVERSIZE_PROMPT = BODY_MAX_BYTES + CHUNK_BYTES
const jobBody = (promptLength) => JSON.stringify({
  name: 'over', kind: 'shell', command: 'echo 1', schedule: '* * * * *', prompt: 'x'.repeat(promptLength),
})

async function makeServer(t, { tap } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'cron-board-body-'))
  const store = await createStore({ dir: join(dir, 'data') })
  t.after(async () => {
    await store.flush()
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  })
  const logger = createLogger({ rootDir: join(dir, 'logs') })
  const executor = createExecutor({
    store,
    logger,
    readMaxConcurrent: () => 2,
    runner: { run: async () => ({ status: 'success', exitCode: 0 }) },
  })
  const api = createApi({ store, logger, executor, getAgentPresets: () => null, getSessionController: () => undefined })
  // 生产装配同形:index.js 以 withRouteGate 包裹 api.handle;tap 供用例在处理器前后探针
  const server = http.createServer(withRouteGate({ get: () => undefined }, (req, res) => {
    if (tap) tap(req, res)
    return api.handle(req, res)
  }))
  const sockets = new Set()
  server.on('connection', (socket) => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise((resolve) => server.close(resolve)))
  return { server, port: server.address().port, store, sockets }
}

// 请求体相关监听自由量:收敛后必须回到进处理器时的基线(悬挂 Promise 的另一面是悬挂监听)
const BODY_EVENTS = ['data', 'end', 'error', 'aborted', 'close']
const countBodyListeners = (req) => Object.fromEntries(BODY_EVENTS.map((name) => [name, req.listenerCount(name)]))

function send(agent, port, { method = 'POST', path, headers = {}, body = '', paceMs = 0 }) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path, method, headers, agent }, (res) => {
      const parts = []
      res.on('data', (chunk) => parts.push(chunk))
      res.on('end', () => resolve({ status: res.statusCode, text: Buffer.concat(parts).toString('utf8'), socket: req.socket }))
    })
    req.on('error', reject)
    // 分块写出:强制多个 data 事件,覆盖「读到一半才超限」的分支;paceMs>0 时响应会先于体结束
    ;(async () => {
      for (let offset = 0; offset < body.length; offset += CHUNK_BYTES) {
        if (req.destroyed) return
        req.write(body.slice(offset, offset + CHUNK_BYTES))
        if (paceMs > 0) await new Promise((resolveDelay) => setTimeout(resolveDelay, paceMs))
      }
      req.end()
    })()
  })
}

// 连接若被拖死,后续请求会永久悬挂:用明确 deadline 把悬挂转成失败(胜出即清定时器,不拖慢进程退出)
function withDeadline(promise, ms) {
  let timer
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('跟随请求超时:连接被拖死')), ms)
  })
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer))
}

const newAgent = (t) => {
  const agent = new http.Agent({ keepAlive: true, maxSockets: 1 })
  t.after(() => agent.destroy())
  return agent
}

test('E1:未声明长度的分块超限体回 413+JSON,同连接下一请求照常受理', async (t) => {
  const { port, store, sockets } = await makeServer(t)
  const agent = newAgent(t)
  const body = jobBody(OVERSIZE_PROMPT)
  assert.ok(Buffer.byteLength(body) > BODY_MAX_BYTES)
  // When 无 content-length(chunked)提交超限体
  const over = await send(agent, port, { path: '/api/cron-board/jobs', headers: { 'content-type': 'application/json' }, body })
  // Then 结构化 413,不落库,不撕连接
  assert.equal(over.status, 413)
  assert.deepEqual(JSON.parse(over.text), { error: '请求体超过上限' })
  assert.equal(store.jobs.list().length, 0)
  assert.equal(over.socket.destroyed, false)
  // When 同一 agent 复用连接读状态
  const next = await send(agent, port, { method: 'GET', path: '/api/cron-board/status', body: '' })
  // Then 200 且复用同一 socket:多一条 TCP 连接都算 keep-alive 被撕
  assert.equal(next.status, 200)
  assert.equal(next.socket, over.socket)
  assert.equal(sockets.size, 1)
})

test('E1:已声明 content-length 超限同样 413 且不堆内存(连接可继续复用)', async (t) => {
  const { port, store } = await makeServer(t)
  const agent = newAgent(t)
  const body = jobBody(OVERSIZE_PROMPT)
  // When 声明真实长度的超限体(服务端据声明即可提前拒绝,不必收满)
  const over = await send(agent, port, {
    path: '/api/cron-board/jobs',
    headers: { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(body)) },
    body,
  })
  // Then 413 + JSON,未落库
  assert.equal(over.status, 413)
  assert.deepEqual(JSON.parse(over.text), { error: '请求体超过上限' })
  assert.equal(store.jobs.list().length, 0)
  // Then 后续请求仍走同一连接
  const next = await send(agent, port, { method: 'GET', path: '/api/cron-board/status', body: '' })
  assert.equal(next.status, 200)
  assert.equal(next.socket, over.socket)
})

test('E1:慢速超限体(响应先于请求体结束)不拖死连接,下一请求照常受理', async (t) => {
  const { port, store } = await makeServer(t)
  const agent = newAgent(t)
  // Given 体量远超上限且带节奏写出:服务端在体尚未结束时就必须回 413
  const body = jobBody(OVERSIZE_PROMPT * 2)
  const over = await send(agent, port, { path: '/api/cron-board/jobs', headers: { 'content-type': 'application/json' }, body, paceMs: 2 })
  assert.equal(over.status, 413)
  // Then 剩余体被排空丢弃(不 pause 停读):同连接下一请求有响应,不是悬挂
  const next = await withDeadline(send(agent, port, { method: 'GET', path: '/api/cron-board/status' }), 5000)
  assert.equal(next.status, 200)
  assert.equal(next.socket, over.socket)
  assert.equal(store.jobs.list().length, 0)
})

test('M3-1:客户端声明上限内体量后中途断开,readBody 以 400 收敛且监听无残留', async (t) => {
  const captured = { status: null, body: null, baseline: null, req: null }
  let markSettled
  const settledSignal = new Promise((resolve) => { markSettled = resolve })
  const { port, store } = await makeServer(t, {
    tap: (req, res) => {
      captured.req = req
      captured.baseline = countBodyListeners(req)
      const rawWriteHead = res.writeHead.bind(res)
      res.writeHead = (status, headers) => {
        if (captured.status === null) captured.status = status
        return rawWriteHead(status, headers)
      }
      // 收敛信号取 res.end:无论 socket 是否已被对端撕掉,处理链写响应即视为收敛
      const rawEnd = res.end.bind(res)
      res.end = (...args) => {
        if (captured.body === null && typeof args[0] === 'string') captured.body = args[0]
        markSettled()
        return rawEnd(...args)
      }
    },
  })
  // Given 声明上限内长度(content-length 走 data/end 路径,不被声明提前拒绝)只发 1KB 就断连
  const client = http.request({
    host: '127.0.0.1',
    port,
    path: '/api/cron-board/jobs',
    method: 'POST',
    headers: { 'content-type': 'application/json', 'content-length': String(BODY_MAX_BYTES) },
  })
  client.on('error', () => {})
  client.write('{"name":"x"')
  await new Promise((resolve) => setTimeout(resolve, 50))
  client.destroy()
  // Then 处理链收敛为 400 且归因为读取中断(旧实现只认 data/end,连接没了就永久悬挂)
  await withDeadline(settledSignal, 3000)
  assert.equal(captured.status, 400)
  assert.deepEqual(JSON.parse(captured.body), { error: '请求体读取中断' })
  assert.equal(store.jobs.list().length, 0)
  // And 请求体监听回到进处理器时的基线:悬挂 Promise 的另一面就是悬挂监听
  assert.deepEqual(countBodyListeners(captured.req), captured.baseline)
})

test('M1:413 写出时排空消费者已在场(真实 socket 收到 413+JSON,连接可复用)', async (t) => {
  const captured = { consumers: null }
  const { port, store } = await makeServer(t, {
    tap: (req, res) => {
      const rawWriteHead = res.writeHead.bind(res)
      res.writeHead = (status, headers) => {
        // 响应写出瞬间采样:readBody 已摘业务监听,排空消费者必须已接力
        if (captured.consumers === null) captured.consumers = req.listenerCount('data')
        return rawWriteHead(status, headers)
      }
    },
  })
  const agent = newAgent(t)
  // Given 2MB 超限体(远大于内核缓冲,客户端仍在持续上传时服务端就要回 413)
  const body = jobBody(2 * 1024 * 1024)
  // When 提交
  const over = await send(agent, port, { path: '/api/cron-board/jobs', headers: { 'content-type': 'application/json' }, body })
  // Then 客户端拿到真实 HTTP 413 + JSON(不是 ECONNRESET),且排空消费者已在场;
  // 删掉 drainRest 的显式消费者时此处为 0(只剩 Node 内部 dump 的偶然行为)
  assert.equal(over.status, 413)
  assert.deepEqual(JSON.parse(over.text), { error: '请求体超过上限' })
  assert.ok(captured.consumers >= 1, '超限后必须保留显式排空消费者')
  // And 同连接下一请求照常受理
  const next = await send(agent, port, { method: 'GET', path: '/api/cron-board/status', body: '' })
  assert.equal(next.status, 200)
  assert.equal(next.socket, over.socket)
  assert.equal(store.jobs.list().length, 0)
})

test('E1:上限内的大体量请求正常受理(413 不误伤合法长 prompt)', async (t) => {
  const { port, store } = await makeServer(t)
  const agent = newAgent(t)
  const promptLength = BODY_MAX_BYTES - 4 * CHUNK_BYTES
  const body = jobBody(promptLength)
  assert.ok(Buffer.byteLength(body) < BODY_MAX_BYTES)
  const ok = await send(agent, port, { path: '/api/cron-board/jobs', headers: { 'content-type': 'application/json' }, body })
  // Then 正常建任务,请求体被完整消费(不是被截断后的半 JSON)
  assert.equal(ok.status, 200)
  assert.equal(store.jobs.list().length, 1)
  assert.equal(store.jobs.list()[0].prompt, 'x'.repeat(promptLength))
})
