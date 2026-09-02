// 路由层 BDD(mock ctx):删除路由的运行中守卫与资格拒绝,不需要真实 host。
// peer 依赖未安装的仓库环境(禁止 install)下整文件跳过。

import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'

const indexModule = await import('../src/index.js').catch((error) => error)
const apply = indexModule.apply
const dependencyReady = typeof apply === 'function'
const skipMissingDeps = { skip: dependencyReady ? false : 'peer 依赖未安装,路由层测试跳过' }

function makeCtx({ archivedIds, headers, agents }) {
  const routes = []
  const ctx = {
    effect: (fn) => fn(),
    inject: (_deps, fn) => fn({ settings: { register: () => ({ resolved: undefined }) } }),
    get: (name) => ({ agents }[name]),
    on: () => {},
    logger: undefined,
    workspaceRegistry: { archivedSessionIds, list: () => [] },
    sessionQuery: { listSessions: async () => headers.map((header) => ({ header })) },
  }
  ctx.webServer = { register: (route) => routes.push(route) }
  apply(ctx, undefined)
  return new Map(routes.map((route) => [route.path, route.handler]))
}

function request(sessionId) {
  const req = new EventEmitter()
  req.method = 'POST'
  process.nextTick(() => {
    req.emit('data', Buffer.from(JSON.stringify({ sessionId })))
    req.emit('end')
  })
  return req
}

function response() {
  const state = { status: undefined, body: undefined }
  state.writeHead = (status) => { state.status = status }
  state.end = (text) => { state.body = JSON.parse(text) }
  return state
}

const HEADER = { id: 's1', cwd: 'C:\\x', createdAt: 0 }

test('删除路由:运行中会话被守卫拒绝,不触发 locate 与 trash', skipMissingDeps, async () => {
  const handlers = makeCtx({
    archivedIds: ['s1'],
    headers: [HEADER],
    agents: new Map([['s1', { status: 'running' }]]),
  })
  const res = response()
  await handlers.get('/api/session-manager/delete')(request('s1'), res)
  assert.equal(res.status, 400)
  assert.equal(res.body.error, '运行中的会话不可删除')
})

test('删除路由:非运行中的已归档会话因 locate 缺失拒绝(守卫未误拦)', skipMissingDeps, async () => {
  const handlers = makeCtx({
    archivedIds: ['s1'],
    headers: [HEADER],
    agents: new Map([['s1', { status: 'idle' }]]),
  })
  const res = response()
  await handlers.get('/api/session-manager/delete')(request('s1'), res)
  assert.equal(res.status, 400)
  assert.equal(res.body.error, '当前存储后端不支持按会话删除')
})

test('删除路由:未归档会话在守卫前即拒绝', skipMissingDeps, async () => {
  const handlers = makeCtx({
    archivedIds: [],
    headers: [HEADER],
    agents: new Map([['s1', { status: 'running' }]]),
  })
  const res = response()
  await handlers.get('/api/session-manager/delete')(request('s1'), res)
  assert.equal(res.status, 400)
  assert.equal(res.body.error, '仅已归档会话可删除')
})
