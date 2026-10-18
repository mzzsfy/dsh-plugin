// PAGE-20 管理员会话入口服务端契约:创建空会话不发送消息,绑定幂等,能力缺失诚实降级。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { createBoardApi } from '../lib/board.mjs'

function jsonRes() {
  const r = { status: 0, raw: undefined, writeHead(s) { this.status = s }, end(b) { this.raw = b } }
  Object.defineProperty(r, 'payload', { get() { return JSON.parse(this.raw) } })
  return r
}

function streamReq({ method, headers, url = '/api/boss-simulator/admin', body }) {
  return {
    method, headers, url,
    on(event, cb) {
      if (event === 'data' && body !== undefined) cb(Buffer.from(JSON.stringify(body)))
      if (event === 'end') cb()
    },
  }
}

function makeStore({ binding } = {}) {
  const records = new Map()
  if (binding) records.set('adminBinding', binding)
  return {
    records,
    listAggregates: async () => [],
    loadControl: async () => ({ globalStopped: false, globalStopGeneration: 0, taskAllows: {} }),
    updateControl: async (fn) => fn(),
    loadAdminBinding: async () => records.get('adminBinding') ?? null,
    updateAdminBinding: (fn) => { const next = fn(records.get('adminBinding') ?? null); records.set('adminBinding', next); return next },
  }
}

function adminApi(store, { sessions = 1 } = {}) {
  let created = 0
  const sessionAdapter = {
    async ensureSession(request) {
      created += 1
      if (sessions === 0) return {}
      return { sessionId: `admin-session-${created}`, agentPreset: request.agentPreset }
    },
    async dispatchPrompt() { throw new Error('管理员入口禁止发送消息') },
  }
  return { api: createBoardApi({ store, drive: { sessionAdapter }, now: () => 1000 }), createdCount: () => created }
}

test('POST admin create:首次创建空管理员会话并落账,不发送 prompt', async () => {
  const store = makeStore()
  const { api, createdCount } = adminApi(store)
  const r = jsonRes()
  await api.handleAdmin(streamReq({ method: 'POST', headers: { host: 'h', origin: 'http://h' }, body: { action: 'create', commandId: randomUUID() } }), r)
  assert.equal(r.status, 200)
  assert.equal(r.payload.created, true)
  assert.equal(r.payload.sessionId, 'admin-session-1')
  assert.equal(createdCount(), 1)
  assert.equal(store.records.get('adminBinding').sessionId, 'admin-session-1')
})

test('POST admin create:绑定已存在时收养不重建', async () => {
  const store = makeStore({ binding: { sessionId: 'admin-session-1', createdAt: 1 } })
  const { api, createdCount } = adminApi(store)
  const r = jsonRes()
  await api.handleAdmin(streamReq({ method: 'POST', headers: { host: 'h', origin: 'http://h' }, body: { action: 'create', commandId: randomUUID() } }), r)
  assert.equal(r.status, 200)
  assert.equal(r.payload.created, false)
  assert.equal(r.payload.sessionId, 'admin-session-1')
  assert.equal(createdCount(), 0)
})

test('POST admin create:并发双击只建一次', async () => {
  const store = makeStore()
  const { api, createdCount } = adminApi(store)
  const results = await Promise.all([0, 1].map(() => {
    const r = jsonRes()
    return api.handleAdmin(streamReq({ method: 'POST', headers: { host: 'h', origin: 'http://h' }, body: { action: 'create', commandId: randomUUID() } }), r).then(() => r)
  }))
  assert.deepEqual(results.map((r) => r.payload.sessionId), ['admin-session-1', 'admin-session-1'])
  assert.equal(createdCount(), 1)
})

test('POST admin create:会话适配未装配 501,创建未返回 sessionId 500', async () => {
  const noDrive = createBoardApi({ store: makeStore() })
  const missing = jsonRes()
  await noDrive.handleAdmin(streamReq({ method: 'POST', headers: { host: 'h', origin: 'http://h' }, body: { action: 'create' } }), missing)
  assert.equal(missing.status, 501)
  const { api } = adminApi(makeStore(), { sessions: 0 })
  const empty = jsonRes()
  await api.handleAdmin(streamReq({ method: 'POST', headers: { host: 'h', origin: 'http://h' }, body: { action: 'create' } }), empty)
  assert.equal(empty.status, 500)
})

test('POST admin create:replace 重建覆盖不可达绑定,旧收养不生效', async () => {
  const store = makeStore({ binding: { sessionId: 'session-gone', createdAt: 1 } })
  const { api, createdCount } = adminApi(store)
  const r = jsonRes()
  await api.handleAdmin(streamReq({ method: 'POST', headers: { host: 'h', origin: 'http://h' }, body: { action: 'create', replace: true, commandId: randomUUID() } }), r)
  assert.equal(r.status, 200)
  assert.equal(r.payload.created, true)
  assert.equal(r.payload.sessionId, 'admin-session-1')
  assert.equal(createdCount(), 1)
  assert.equal(store.records.get('adminBinding').sessionId, 'admin-session-1', '重建必须覆盖旧绑定')
})

test('POST admin:跨源拒绝 403,非法 action 400(均未创建)', async () => {
  const store = makeStore()
  const { api, createdCount } = adminApi(store)
  const cross = jsonRes()
  await api.handleAdmin(streamReq({ method: 'POST', headers: { host: 'h', origin: 'http://evil' }, body: { action: 'create', commandId: randomUUID() } }), cross)
  assert.equal(cross.status, 403)
  const badAction = jsonRes()
  await api.handleAdmin(streamReq({ method: 'POST', headers: { host: 'h', origin: 'http://h' }, body: { action: 'prompt', commandId: randomUUID() } }), badAction)
  assert.equal(badAction.status, 400)
  assert.equal(createdCount(), 0, '拒绝路径不触碰会话适配')
  assert.equal(store.records.get('adminBinding'), undefined)
})

test('GET board 投影携带 administrator 绑定;缺失为 null', async () => {
  const empty = createBoardApi({ store: makeStore() })
  const r1 = jsonRes()
  await empty.handleBoard(streamReq({ method: 'GET', headers: { host: 'h' } }), r1)
  assert.equal(r1.payload.administrator, null)
  const store = makeStore({ binding: { sessionId: 'admin-session-9', createdAt: 1 } })
  const bound = createBoardApi({ store })
  const r2 = jsonRes()
  await bound.handleBoard(streamReq({ method: 'GET', headers: { host: 'h' } }), r2)
  assert.equal(r2.payload.administrator, 'admin-session-9')
})
