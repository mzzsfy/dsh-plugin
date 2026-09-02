// 路由层 BDD(mock ctx 强制 cordis 注入语义):宿主上下文上任何未声明 inject 的
// 服务属性访问一律抛 cannot get property ... without inject,与 cordis reflect 行为
// 一致,防止 inject 声明缺失回归。peer 依赖未安装的仓库环境(禁止 install)下整文件跳过。

import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtemp, writeFile, utimes } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

// 仅 peer 依赖缺失允许整文件跳过;其余加载失败(src 自身损坏)直接失败,禁止静默 skip
const indexModule = await import('../src/index.js').catch((error) => {
  const missingPeer = error && error.code === 'ERR_MODULE_NOT_FOUND'
    && error.message.includes("'@deepseek-ai/")
  if (missingPeer) return error
  throw error
})
const apply = indexModule.apply
const declaredInject = Array.isArray(indexModule.inject) ? indexModule.inject : []
const dependencyReady = typeof apply === 'function'
const skipMissingDeps = { skip: dependencyReady ? false : 'peer 依赖未安装,路由层测试跳过' }

function makeRegistry(initialIds) {
  // 真实注册表契约:archivedSessionIds 是进程内快照的 getter,官方读路径全部经快照
  const registry = {
    state: { initialized: true, workspaceIds: [], archivedSessionIds: initialIds },
    list: () => [],
    archiveCalls: [],
    archiveSession: async (id) => { registry.archiveCalls.push(String(id)) },
  }
  Object.defineProperty(registry, 'archivedSessionIds', {
    get: () => registry.state.archivedSessionIds,
  })
  return registry
}

// workspace 域句柄:null 表示域未打开(get 返回 undefined)
function makeDomain(initialIds) {
  const domain = {
    state: { archivedSessionIds: initialIds },
    writes: 0,
    global: {
      get: () => domain.state,
      set: async (next) => {
        domain.state = { ...next }
        domain.writes += 1
      },
    },
  }
  return domain
}

function makeCtx({ archivedIds, headers, agents, domain, sessionPersistence }) {
  const routes = []
  const eventHandlers = {}
  const services = {
    webServer: { register: (route) => routes.push(route) },
    workspaceRegistry: makeRegistry(archivedIds),
    sessionQuery: { listSessions: async () => headers.map((header) => ({ header })) },
    ...(domain === undefined ? {} : { storageDomain: { get: (name) => name === 'workspace' ? (domain || undefined) : undefined } }),
  }
  const base = {
    effect: (fn) => fn(),
    inject: (_deps, fn) => fn({ settings: { register: () => ({ resolved: undefined }) } }),
    get: (name) => ({ agents, sessionPersistence }[name]),
    on: (event, handler) => { eventHandlers[event] = handler },
    logger: undefined,
  }
  const ctx = new Proxy(base, {
    get(target, prop) {
      if (typeof prop === 'symbol') return undefined
      if (prop in target) return target[prop]
      if (!declaredInject.includes(prop)) {
        throw new Error(`cannot get property "${String(prop)}" without inject`)
      }
      return services[prop]
    },
  })
  apply(ctx, undefined)
  return {
    handlers: new Map(routes.map((route) => [route.path, route.handler])),
    eventHandlers,
    domain,
    registry: services.workspaceRegistry,
  }
}

async function waitFor(predicate) {
  const deadline = Date.now() + 2000
  while (Date.now() < deadline) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  assert.ok(predicate(), 'waitFor 超时')
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

test('inject 声明覆盖路由层触及的全部宿主服务(cordis 未声明即抛 cannot get property)', skipMissingDeps, () => {
  for (const service of ['webServer', 'workspaceRegistry', 'sessionQuery', 'storageDomain']) {
    assert.ok(declaredInject.includes(service), `inject 缺少 "${service}"`)
  }
})

test('取消归档路由:从域集合移除目标 id 并写回', skipMissingDeps, async () => {
  const domain = makeDomain(['s1', 's2'])
  const { handlers, registry } = makeCtx({ archivedIds: ['s1'], headers: [HEADER], agents: new Map(), domain })
  const res = response()
  await handlers.get('/api/session-manager/unarchive')(request('s1'), res)
  assert.equal(res.status, 200)
  assert.deepEqual(res.body, { ok: true })
  assert.deepEqual(domain.state.archivedSessionIds, ['s2'])
  assert.equal(domain.writes, 1)
  // 复活守卫:注册表进程内快照必须同步移除,否则官方全量写回与 list 基线会恢复该 id
  assert.deepEqual(registry.state.archivedSessionIds, ['s2'])
  assert.deepEqual(registry.archivedSessionIds, ['s2'])
})

test('取消归档路由:workspace 域未打开时拒绝', skipMissingDeps, async () => {
  const { handlers } = makeCtx({ archivedIds: ['s1'], headers: [HEADER], agents: new Map(), domain: null })
  const res = response()
  await handlers.get('/api/session-manager/unarchive')(request('s1'), res)
  assert.equal(res.status, 400)
  assert.equal(res.body.error, 'workspace 域未打开')
})

test('取消归档路由:未归档 id 幂等跳过,不产生写回', skipMissingDeps, async () => {
  const domain = makeDomain(['s1'])
  const { handlers, registry } = makeCtx({ archivedIds: ['s1'], headers: [HEADER], agents: new Map(), domain })
  const res = response()
  await handlers.get('/api/session-manager/unarchive')(request('s9'), res)
  assert.equal(res.status, 200)
  assert.deepEqual(res.body, { ok: true })
  assert.deepEqual(domain.state.archivedSessionIds, ['s1'])
  assert.equal(domain.writes, 0)
  assert.deepEqual(registry.state.archivedSessionIds, ['s1'])
})

test('取消归档路由:快照领先域时补全清理(重试路径)', skipMissingDeps, async () => {
  const domain = makeDomain([])
  const { handlers, registry } = makeCtx({ archivedIds: ['s1'], headers: [HEADER], agents: new Map(), domain })
  const res = response()
  await handlers.get('/api/session-manager/unarchive')(request('s1'), res)
  assert.equal(res.status, 200)
  assert.deepEqual(res.body, { ok: true })
  assert.deepEqual(domain.state.archivedSessionIds, [])
  assert.equal(domain.writes, 1)
  assert.deepEqual(registry.state.archivedSessionIds, [])
})

test('info 路由:会话不存在拒绝', skipMissingDeps, async () => {
  const { handlers } = makeCtx({ archivedIds: [], headers: [], agents: new Map() })
  const res = response()
  await handlers.get('/api/session-manager/info')(request('s1'), res)
  assert.equal(res.status, 400)
  assert.equal(res.body.error, '会话不存在')
})

test('info 路由:locate 缺失按不支持返回', skipMissingDeps, async () => {
  const { handlers } = makeCtx({ archivedIds: [], headers: [HEADER], agents: new Map() })
  const res = response()
  await handlers.get('/api/session-manager/info')(request('s1'), res)
  assert.equal(res.status, 200)
  assert.deepEqual(res.body, { supported: false })
})

test('删除路由:运行中会话被守卫拒绝,不触发 locate 与 trash', skipMissingDeps, async () => {
  const { handlers } = makeCtx({
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
  const { handlers } = makeCtx({
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
  const { handlers } = makeCtx({
    archivedIds: [],
    headers: [HEADER],
    agents: new Map([['s1', { status: 'running' }]]),
  })
  const res = response()
  await handlers.get('/api/session-manager/delete')(request('s1'), res)
  assert.equal(res.status, 400)
  assert.equal(res.body.error, '仅已归档会话可删除')
})

test('自动归档评估:产物不可读的会话不参与归档(防删除后复活)', skipMissingDeps, async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'sm-eval-'))
  const alivePath = path.join(dir, 'alive.jsonl')
  await writeFile(alivePath, '{"header":1}\n{"event":0}\n')
  const DAY_MS = 24 * 60 * 60 * 1000
  const stale = Date.now() - 30 * DAY_MS
  await utimes(alivePath, stale / 1000, stale / 1000)
  const cwd = 'C:\\x'
  const headers = [
    { id: 's1', cwd, createdAt: stale },
    { id: 's2', cwd, createdAt: stale },
  ]
  const sessionPersistence = {
    locate: (header) => header.id === 's1' ? { path: alivePath } : { path: path.join(dir, 'gone.jsonl') },
  }
  const { eventHandlers, registry } = makeCtx({
    archivedIds: [],
    headers,
    agents: new Map(),
    sessionPersistence,
  })
  eventHandlers['session/created']({ header: { id: 'trigger', cwd } })
  await waitFor(() => registry.archiveCalls.length > 0)
  // s2 产物缺失必须被守卫跳过:否则已删除会话会被重新归档而在面板复活
  assert.deepEqual(registry.archiveCalls, ['s1'])
})
