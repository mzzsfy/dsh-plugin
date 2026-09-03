// 路由层 BDD(mock ctx 强制 cordis 注入语义):宿主上下文上任何未声明 inject 的
// 服务属性访问一律抛 cannot get property ... without inject,与 cordis reflect 行为
// 一致,防止 inject 声明缺失回归。peer 依赖未安装的仓库环境(禁止 install)下整文件跳过。

import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtemp, writeFile, utimes, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

// 仅 peer 依赖缺失允许整文件跳过;其余加载失败(src 自身损坏)直接失败,禁止静默 skip
const indexModule = await import('../src/index.js').catch((error) => {
  const missingPeer = error && error.code === 'ERR_MODULE_NOT_FOUND'
    && (error.message.includes("'@deepseek-ai/") || error.message.includes("'zod"))
  if (missingPeer) return error
  throw error
})
const apply = indexModule.apply
const declaredInject = Array.isArray(indexModule.inject) ? indexModule.inject : []
const dependencyReady = typeof apply === 'function'
const skipMissingDeps = { skip: dependencyReady ? false : 'peer 依赖未安装,路由层测试跳过' }
const MESSAGES = indexModule.MESSAGES
// 台账/重挂载夹具路径仅作数据,不落盘;形态与实现一致(会话目录)
const LEDGER_FIXTURE_PATH = 'C:\\store\\s1'

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

// 台账域句柄;openRejected 模拟台账域打开失败
function makeLedgerDomain(entries) {
  const domain = {
    state: { deleted: entries },
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

// workspace 注册表实体桩:detach/attach 均为官方实体契约,供删除与重挂载断言
function makeWorkspace(path, sessionIds, options = {}) {
  const workspace = {
    path,
    sessionIds,
    attachCalls: [],
    attachSession: async (id) => {
      if (options.attachError) throw options.attachError
      workspace.attachCalls.push(String(id))
      workspace.sessionIds = [String(id), ...workspace.sessionIds.filter((existing) => existing !== id)]
    },
    detachSession: async (id) => {
      if (options.detachError) throw options.detachError
      workspace.sessionIds = workspace.sessionIds.filter((existing) => String(existing) !== String(id))
    },
  }
  return workspace
}

function makeCtx({
  archivedIds,
  headers,
  agents,
  domain,
  sessionPersistence,
  ledger,
  openRejected,
  workspaces,
}) {
  const routes = []
  const eventHandlers = {}
  const ledgerDomain = ledger === undefined ? makeLedgerDomain([]) : ledger
  const workspaceList = workspaces || []
  const services = {
    webServer: { register: (route) => routes.push(route) },
    workspaceRegistry: Object.assign(makeRegistry(archivedIds), { list: () => workspaceList }),
    sessionQuery: { listSessions: async () => headers.map((header) => ({ header })) },
    storageDomain: {
      get: (name) => name === 'workspace' ? (domain || undefined) : undefined,
      open: openRejected ? () => Promise.reject(openRejected) : async () => ledgerDomain,
    },
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
    ledger: ledgerDomain,
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

function request(sessionId, method = 'POST') {
  const req = new EventEmitter()
  req.method = method
  if (method !== 'GET') {
    process.nextTick(() => {
      req.emit('data', Buffer.from(JSON.stringify({ sessionId })))
      req.emit('end')
    })
  }
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

test('info 路由:产物已缺失按 missing 返回,不裸抛', skipMissingDeps, async () => {
  const { handlers } = makeCtx({
    archivedIds: [],
    headers: [HEADER],
    agents: new Map(),
    sessionPersistence: { locate: (header) => header.id === 's1' ? { path: 'C:\\gone\\s1\\session.jsonl.zstd' } : undefined },
  })
  const res = response()
  await handlers.get('/api/session-manager/info')(request('s1'), res)
  assert.equal(res.status, 200)
  assert.deepEqual(res.body, { supported: true, sizeBytes: 0, missing: true })
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

test('删除路由:未归档会话拒绝(运行守卫优先于资格)', skipMissingDeps, async () => {
  const { handlers } = makeCtx({
    archivedIds: [],
    headers: [HEADER],
    agents: new Map([['s1', { status: 'running' }]]),
  })
  const res = response()
  await handlers.get('/api/session-manager/delete')(request('s1'), res)
  assert.equal(res.status, 400)
  assert.equal(res.body.error, '运行中的会话不可删除')
})

test('删除路由:未归档且空闲的会话拒绝', skipMissingDeps, async () => {
  const artifact = await makeLocatedArtifact()
  try {
    const { handlers } = makeCtx({
      archivedIds: [],
      headers: [HEADER],
      agents: new Map([['s1', { status: 'idle' }]]),
      sessionPersistence: { locate: (header) => header.id === 's1' ? { path: artifact.locatedPath } : undefined },
    })
    const res = response()
    await handlers.get('/api/session-manager/delete')(request('s1'), res)
    assert.equal(res.status, 400)
    assert.equal(res.body.error, '仅已归档会话可删除')
  } finally {
    await artifact.cleanup()
  }
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

// 执行器桩替:trash 为进程级唯一 OS 副作用出口,经 executor 注册表注入(README 已知测试缺口的基建扩展)
async function withTrashStub(stub, run) {
  const original = indexModule.executor.trashPath
  indexModule.executor.trashPath = stub
  try {
    await run()
  } finally {
    indexModule.executor.trashPath = original
  }
}

const IDLE_S1 = new Map([['s1', { status: 'idle' }]])

// locate 契约实证:返回会话目录下的日志文件;stat 为真实 fs,产物以临时文件承载
async function makeLocatedArtifact() {
  const root = await mkdtemp(path.join(tmpdir(), 'sm-del-'))
  const locatedDir = path.join(root, 's1')
  const locatedPath = path.join(locatedDir, 'session.jsonl.zstd')
  await mkdir(locatedDir, { recursive: true })
  await writeFile(locatedPath, 'log-bytes')
  return {
    locatedDir,
    locatedPath,
    cleanup: () => rm(root, { recursive: true, force: true }),
  }
}

test('删除成功:trash 目标为会话目录,台账记录目录路径', skipMissingDeps, async () => {
  const artifact = await makeLocatedArtifact()
  try {
    const domain = makeDomain(['s1'])
    const workspace = makeWorkspace('C:\\x', ['s1'])
    const { handlers, ledger } = makeCtx({
      archivedIds: ['s1'],
      headers: [HEADER],
      agents: IDLE_S1,
      domain,
      sessionPersistence: { locate: (header) => header.id === 's1' ? { path: artifact.locatedPath } : undefined },
      workspaces: [workspace],
    })
    const trashed = []
    const res = response()
    await withTrashStub(async (p) => { trashed.push(p) }, async () => {
      await handlers.get('/api/session-manager/delete')(request('s1'), res)
    })
    assert.equal(res.status, 200)
    assert.deepEqual(res.body, { ok: true })
    // locate 给的是日志文件,trash 必须上移到会话目录,否则残留空目录
    assert.deepEqual(trashed, [artifact.locatedDir])
    assert.equal(ledger.state.deleted.length, 1)
    assert.equal(ledger.state.deleted[0].sessionId, 's1')
    assert.equal(ledger.state.deleted[0].path, artifact.locatedDir)
    assert.deepEqual(domain.state.archivedSessionIds, [])
    assert.deepEqual(workspace.sessionIds, [])
  } finally {
    await artifact.cleanup()
  }
})

test('删除成功:同 id 残留台账被替换,无重复条目', skipMissingDeps, async () => {
  const artifact = await makeLocatedArtifact()
  try {
    const { handlers, ledger } = makeCtx({
      archivedIds: ['s1'],
      headers: [HEADER],
      agents: IDLE_S1,
      domain: makeDomain(['s1']),
      sessionPersistence: { locate: (header) => header.id === 's1' ? { path: artifact.locatedPath } : undefined },
      ledger: makeLedgerDomain([{ sessionId: 's1', path: 'old', deletedAt: 1 }]),
    })
    const res = response()
    await withTrashStub(async () => {}, async () => {
      await handlers.get('/api/session-manager/delete')(request('s1'), res)
    })
    assert.equal(res.status, 200)
    assert.deepEqual(res.body, { ok: true })
    assert.deepEqual(ledger.state.deleted.map((item) => item.sessionId), ['s1'])
    assert.equal(ledger.state.deleted[0].path, artifact.locatedDir)
  } finally {
    await artifact.cleanup()
  }
})

test('删除:产物已缺失时跳过 trash 与台账,完成列表清理', skipMissingDeps, async () => {
  const domain = makeDomain([])
  const workspace = makeWorkspace('C:\\x', ['s1'])
  const { handlers, ledger } = makeCtx({
    // 幽灵会话已不在归档集合:残留清理不要求归档资格
    archivedIds: [],
    headers: [HEADER],
    agents: IDLE_S1,
    domain,
    sessionPersistence: { locate: (header) => header.id === 's1' ? { path: 'C:\\gone\\s1\\session.jsonl.zstd' } : undefined },
    workspaces: [workspace],
  })
  const trashed = []
  const res = response()
  await withTrashStub(async (p) => { trashed.push(p) }, async () => {
    await handlers.get('/api/session-manager/delete')(request('s1'), res)
  })
  assert.equal(res.status, 200)
  assert.deepEqual(res.body, { ok: true, message: MESSAGES.ghostCleanup })
  assert.deepEqual(trashed, [])
  assert.deepEqual(ledger.state.deleted, [])
  assert.equal(ledger.writes, 0)
  // 残留清理仍解除工作区关联与归档集合(幂等)
  assert.deepEqual(workspace.sessionIds, [])
  assert.deepEqual(domain.state.archivedSessionIds, [])
})

test('删除:产物已缺失时运行中守卫仍然生效', skipMissingDeps, async () => {
  const { handlers } = makeCtx({
    archivedIds: [],
    headers: [HEADER],
    agents: new Map([['s1', { status: 'running' }]]),
    domain: makeDomain([]),
    sessionPersistence: { locate: (header) => header.id === 's1' ? { path: 'C:\\gone\\s1\\session.jsonl.zstd' } : undefined },
  })
  const res = response()
  await withTrashStub(async () => {}, async () => {
    await handlers.get('/api/session-manager/delete')(request('s1'), res)
  })
  assert.equal(res.status, 400)
  assert.equal(res.body.error, MESSAGES.running)
})

test('删除:产物已缺失且清理半失败时聚合失败点', skipMissingDeps, async () => {
  const workspace = makeWorkspace('C:\\x', ['s1'], { detachError: new Error('detach boom') })
  const { handlers } = makeCtx({
    archivedIds: [],
    headers: [HEADER],
    agents: IDLE_S1,
    domain: null,
    sessionPersistence: { locate: (header) => header.id === 's1' ? { path: 'C:\\gone\\s1\\session.jsonl.zstd' } : undefined },
    workspaces: [workspace],
  })
  const res = response()
  await withTrashStub(async () => {}, async () => {
    await handlers.get('/api/session-manager/delete')(request('s1'), res)
  })
  assert.equal(res.status, 200)
  assert.equal(res.body.partial, true)
  assert.equal(res.body.message, '产物已不存在,但移除列表记录失败,且移除归档记录失败')
})

test('删除:workspace 域未打开时归档清理失败,响应 partial 且台账已记录', skipMissingDeps, async () => {
  const artifact = await makeLocatedArtifact()
  try {
    const { handlers, ledger } = makeCtx({
      archivedIds: ['s1'],
      headers: [HEADER],
      agents: IDLE_S1,
      domain: null,
      sessionPersistence: { locate: (header) => header.id === 's1' ? { path: artifact.locatedPath } : undefined },
    })
    const res = response()
    await withTrashStub(async () => {}, async () => {
      await handlers.get('/api/session-manager/delete')(request('s1'), res)
    })
    assert.equal(res.status, 200)
    assert.equal(res.body.partial, true)
    assert.equal(res.body.message, '已移入回收站,但移除归档记录失败')
    // detach 已完成、台账已记录:仅归档集合清理半失败
    assert.deepEqual(ledger.state.deleted.map((item) => item.sessionId), ['s1'])
  } finally {
    await artifact.cleanup()
  }
})

test('删除:detach 与台账同时失败时,partial 消息聚合两个失败点', skipMissingDeps, async () => {
  const artifact = await makeLocatedArtifact()
  try {
    const brokenLedger = makeLedgerDomain([])
    brokenLedger.global.set = async () => { throw new Error('medium broken') }
    const workspace = makeWorkspace('C:\\x', ['s1'], { detachError: new Error('detach boom') })
    const { handlers } = makeCtx({
      archivedIds: ['s1'],
      headers: [HEADER],
      agents: IDLE_S1,
      domain: makeDomain(['s1']),
      sessionPersistence: { locate: (header) => header.id === 's1' ? { path: artifact.locatedPath } : undefined },
      ledger: brokenLedger,
      workspaces: [workspace],
    })
    const res = response()
    await withTrashStub(async () => {}, async () => {
      await handlers.get('/api/session-manager/delete')(request('s1'), res)
    })
    assert.equal(res.status, 200)
    assert.equal(res.body.partial, true)
    assert.equal(res.body.message, '已移入回收站,但移除列表记录失败,且重挂载记录失败')
  } finally {
    await artifact.cleanup()
  }
})

test('trash 失败:整体中止,台账不写', skipMissingDeps, async () => {
  const artifact = await makeLocatedArtifact()
  try {
    const { handlers, ledger } = makeCtx({
      archivedIds: ['s1'],
      headers: [HEADER],
      agents: IDLE_S1,
      domain: makeDomain(['s1']),
      sessionPersistence: { locate: (header) => header.id === 's1' ? { path: artifact.locatedPath } : undefined },
    })
    const res = response()
    await withTrashStub(async () => { throw new Error('no trash') }, async () => {
      await handlers.get('/api/session-manager/delete')(request('s1'), res)
    })
    assert.equal(res.status, 400)
    assert.deepEqual(ledger.state.deleted, [])
    assert.equal(ledger.writes, 0)
  } finally {
    await artifact.cleanup()
  }
})

test('台账域打开失败:删除其余成功仍响应 partial', skipMissingDeps, async () => {
  const artifact = await makeLocatedArtifact()
  try {
    const domain = makeDomain(['s1'])
    const { handlers } = makeCtx({
      archivedIds: ['s1'],
      headers: [HEADER],
      agents: IDLE_S1,
      domain,
      sessionPersistence: { locate: (header) => header.id === 's1' ? { path: artifact.locatedPath } : undefined },
      openRejected: new Error('ledger down'),
    })
    const res = response()
    await withTrashStub(async () => {}, async () => {
      await handlers.get('/api/session-manager/delete')(request('s1'), res)
    })
    assert.equal(res.status, 200)
    assert.equal(res.body.partial, true)
    assert.equal(res.body.message, '已移入回收站,但重挂载记录失败')
    // 台账失败不阻断删除主链路:归档清理照常完成
    assert.deepEqual(domain.state.archivedSessionIds, [])
  } finally {
    await artifact.cleanup()
  }
})

test('台账写入失败:删除其余成功仍响应 partial', skipMissingDeps, async () => {
  const artifact = await makeLocatedArtifact()
  try {
    const brokenLedger = makeLedgerDomain([])
    brokenLedger.global.set = async () => { throw new Error('medium broken') }
    const { handlers } = makeCtx({
      archivedIds: ['s1'],
      headers: [HEADER],
      agents: IDLE_S1,
      domain: makeDomain(['s1']),
      sessionPersistence: { locate: (header) => header.id === 's1' ? { path: artifact.locatedPath } : undefined },
      ledger: brokenLedger,
    })
    const res = response()
    await withTrashStub(async () => {}, async () => {
      await handlers.get('/api/session-manager/delete')(request('s1'), res)
    })
    assert.equal(res.status, 200)
    assert.equal(res.body.partial, true)
    assert.equal(res.body.message, '已移入回收站,但重挂载记录失败')
  } finally {
    await artifact.cleanup()
  }
})

test('已删除列表:GET 按存储序全量返回', skipMissingDeps, async () => {
  const entries = [
    { sessionId: 's2', path: 'p2', deletedAt: 2 },
    { sessionId: 's1', path: 'p1', deletedAt: 1 },
  ]
  const { handlers } = makeCtx({
    archivedIds: [],
    headers: [],
    agents: new Map(),
    ledger: makeLedgerDomain(entries),
  })
  const res = response()
  await handlers.get('/api/session-manager/deleted')(request('x', 'GET'), res)
  assert.equal(res.status, 200)
  assert.deepEqual(res.body, { deleted: entries })
})

test('已删除列表:非 GET 拒绝', skipMissingDeps, async () => {
  const { handlers } = makeCtx({ archivedIds: [], headers: [], agents: new Map() })
  const res = response()
  await handlers.get('/api/session-manager/deleted')(request('s1'), res)
  assert.equal(res.status, 405)
})

test('已删除列表:台账域打开失败拒绝', skipMissingDeps, async () => {
  const { handlers } = makeCtx({
    archivedIds: [],
    headers: [],
    agents: new Map(),
    openRejected: new Error('ledger down'),
  })
  const res = response()
  await handlers.get('/api/session-manager/deleted')(request('x', 'GET'), res)
  assert.equal(res.status, 400)
})

test('重挂载:产物已还原时经官方 attachSession 挂回并清除台账', skipMissingDeps, async () => {
  const workspace = makeWorkspace('C:\\x', [])
  const { handlers, ledger } = makeCtx({
    archivedIds: [],
    headers: [HEADER],
    agents: new Map(),
    workspaces: [workspace],
    ledger: makeLedgerDomain([{ sessionId: 's1', path: LEDGER_FIXTURE_PATH, deletedAt: 1 }]),
  })
  const res = response()
  await handlers.get('/api/session-manager/remount')(request('s1'), res)
  assert.equal(res.status, 200)
  assert.deepEqual(res.body, { ok: true })
  assert.deepEqual(workspace.attachCalls, ['s1'])
  assert.deepEqual(workspace.sessionIds, ['s1'])
  assert.deepEqual(ledger.state.deleted, [])
  assert.equal(ledger.writes, 1)
})

test('重挂载:产物未还原(持久层无 header)拒绝', skipMissingDeps, async () => {
  const { handlers, ledger } = makeCtx({
    archivedIds: [],
    headers: [],
    agents: new Map(),
    ledger: makeLedgerDomain([{ sessionId: 's1', path: LEDGER_FIXTURE_PATH, deletedAt: 1 }]),
  })
  const res = response()
  await handlers.get('/api/session-manager/remount')(request('s1'), res)
  assert.equal(res.status, 400)
  assert.equal(res.body.error, '会话产物不在持久层,请先到系统回收站还原后重试')
  // 拒绝路径不动台账
  assert.equal(ledger.writes, 0)
})

test('重挂载:找不到所属工作区拒绝', skipMissingDeps, async () => {
  const { handlers } = makeCtx({
    archivedIds: [],
    headers: [HEADER],
    agents: new Map(),
    workspaces: [makeWorkspace('C:\\other', [])],
    ledger: makeLedgerDomain([{ sessionId: 's1', path: LEDGER_FIXTURE_PATH, deletedAt: 1 }]),
  })
  const res = response()
  await handlers.get('/api/session-manager/remount')(request('s1'), res)
  assert.equal(res.status, 400)
  assert.equal(res.body.error, '未找到会话所属工作区,无法重新挂载')
})

test('重挂载:attachSession 失败时拒绝且台账保留', skipMissingDeps, async () => {
  const workspace = makeWorkspace('C:\\x', [], { attachError: new Error('cwd 消失') })
  const entries = [{ sessionId: 's1', path: LEDGER_FIXTURE_PATH, deletedAt: 1 }]
  const { handlers, ledger } = makeCtx({
    archivedIds: [],
    headers: [HEADER],
    agents: new Map(),
    workspaces: [workspace],
    ledger: makeLedgerDomain(entries),
  })
  const res = response()
  await handlers.get('/api/session-manager/remount')(request('s1'), res)
  assert.equal(res.status, 400)
  assert.match(res.body.error, /cwd 消失/)
  assert.deepEqual(ledger.state.deleted, entries)
  assert.equal(ledger.writes, 0)
})

test('重挂载:会话已在工作区时幂等收尾(残留条目重试无副作用)', skipMissingDeps, async () => {
  const workspace = makeWorkspace('C:\\x', ['s1'])
  const { handlers, ledger } = makeCtx({
    archivedIds: [],
    headers: [HEADER],
    agents: new Map(),
    workspaces: [workspace],
    ledger: makeLedgerDomain([{ sessionId: 's1', path: LEDGER_FIXTURE_PATH, deletedAt: 1 }]),
  })
  const res = response()
  await handlers.get('/api/session-manager/remount')(request('s1'), res)
  assert.equal(res.status, 200)
  assert.deepEqual(res.body, { ok: true })
  // 官方契约:id 已在 sessionIds 中,挂载幂等无重复
  assert.deepEqual(workspace.sessionIds, ['s1'])
  assert.deepEqual(ledger.state.deleted, [])
})

test('重挂载:挂载成功但台账清除失败时响应 partial', skipMissingDeps, async () => {
  const workspace = makeWorkspace('C:\\x', [])
  const brokenLedger = makeLedgerDomain([{ sessionId: 's1', path: LEDGER_FIXTURE_PATH, deletedAt: 1 }])
  brokenLedger.global.set = async () => { throw new Error('medium broken') }
  const { handlers } = makeCtx({
    archivedIds: [],
    headers: [HEADER],
    agents: new Map(),
    workspaces: [workspace],
    ledger: brokenLedger,
  })
  const res = response()
  await handlers.get('/api/session-manager/remount')(request('s1'), res)
  assert.equal(res.status, 200)
  assert.equal(res.body.partial, true)
  assert.equal(res.body.message, '已重新挂载,但清除台账记录失败;可在「已删除」区移除记录收尾')
  assert.deepEqual(workspace.attachCalls, ['s1'])
})

test('移除记录:命中删除,未命中幂等无写', skipMissingDeps, async () => {
  const entries = [
    { sessionId: 's1', path: 'p1', deletedAt: 1 },
    { sessionId: 's2', path: 'p2', deletedAt: 2 },
  ]
  const { handlers, ledger } = makeCtx({
    archivedIds: [],
    headers: [],
    agents: new Map(),
    ledger: makeLedgerDomain(entries),
  })
  const hit = response()
  await handlers.get('/api/session-manager/forget')(request('s1'), hit)
  assert.equal(hit.status, 200)
  assert.deepEqual(hit.body, { ok: true })
  assert.deepEqual(ledger.state.deleted.map((item) => item.sessionId), ['s2'])
  assert.equal(ledger.writes, 1)
  const miss = response()
  await handlers.get('/api/session-manager/forget')(request('s9'), miss)
  assert.equal(miss.status, 200)
  assert.equal(ledger.writes, 1)
})
