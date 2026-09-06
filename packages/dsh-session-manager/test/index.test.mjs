// 路由层 BDD(mock ctx 强制 cordis 注入语义):宿主上下文上任何未声明 inject 的
// 服务属性访问一律抛 cannot get property ... without inject,与 cordis reflect 行为
// 一致,防止 inject 声明缺失回归。peer 依赖未安装的仓库环境(禁止 install)下整文件跳过。

import test, { mock } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtemp, writeFile, utimes, mkdir, rm, readFile } from 'node:fs/promises'
import { mkdtempSync, rmSync } from 'node:fs'
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
const { DELETE_MESSAGES, HISTORY_INPUT_LIMIT, HISTORY_STARTUP_SCAN_LIMIT } = await import('../src/core.mjs').catch(() => ({ DELETE_MESSAGES: {} }))
const { ensureCacheDir, writeWorkspaceCache } = await import('../src/history-cache.mjs')

// 插件激活即跑历史缓存启动对齐:所有测试统一隔离缓存目录,
// 防止夹具工作区经默认路径(~/.dsh/historyPrompt)泄漏进真实用户目录
const sharedCacheDir = mkdtempSync(path.join(tmpdir(), 'sm-hist-shared-'))
process.env.DSH_HISTORY_CACHE_DIR = sharedCacheDir
test.after(() => { rmSync(sharedCacheDir, { recursive: true, force: true }) })
// 台账/重挂载夹具路径仅作数据,不落盘;形态与实现一致(会话目录)
const LEDGER_FIXTURE_PATH = 'C:\\store\\s1'

function makeRegistry(initialIds) {
  // 真实注册表契约:archivedSessionIds 是进程内快照的 getter,官方读路径全部经快照;
  // archiveSession 归档即入集合(官方幂等判定依据),桩保持同语义
  const registry = {
    state: { initialized: true, workspaceIds: [], archivedSessionIds: initialIds },
    list: () => [],
    archiveCalls: [],
    archiveSession: async (id) => {
      const sid = String(id)
      registry.archiveCalls.push(sid)
      registry.state.archivedSessionIds = [...registry.state.archivedSessionIds, sid]
    },
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
  settingsValue,
  timerAvailable,
  readSessions,
}) {
  const routes = []
  const eventHandlers = {}
  const pendingInjects = []
  const ledgerDomain = ledger === undefined ? makeLedgerDomain([]) : ledger
  const workspaceList = workspaces || []
  const settingsService = {
    get: () => settingsValue,
    register: () => ({ resolved: undefined }),
  }
  // timer 服务桩:模拟宿主 timer 激活后的 interval;unref 保证测试进程可自然退出
  const intervalStub = (fn, ms) => {
    const timer = setInterval(fn, ms)
    timer.unref()
    return () => clearInterval(timer)
  }
  // readSession 桩:sessionId → 事件数组(工厂形态则调用后抛错);reads 记录实际读取次数供缓存断言
  const readCounts = new Map()
  const sessionQuery = {
    listSessions: async () => headers.map((header) => ({ header })),
    readSession: async (sessionId) => {
      readCounts.set(sessionId, (readCounts.get(sessionId) || 0) + 1)
      const events = readSessions ? readSessions[sessionId] : undefined
      if (typeof events === 'function') throw events()
      if (events === undefined) throw new Error('桩未配置该会话产物')
      return { session: headers.find((header) => header.id === sessionId), events }
    },
  }
  const services = {
    webServer: { register: (route) => routes.push(route) },
    workspaceRegistry: Object.assign(makeRegistry(archivedIds), { list: () => workspaceList }),
    sessionQuery,
    storageDomain: {
      get: (name) => name === 'workspace' ? (domain || undefined) : undefined,
      open: openRejected ? () => Promise.reject(openRejected) : async () => ledgerDomain,
    },
  }
  const base = {
    effect: (fn) => fn(),
    inject: (_deps, fn) => { pendingInjects.push(fn) },
    get: (name) => ({ agents, sessionPersistence, settings: settingsService }[name]),
    on: (event, handler) => { eventHandlers[event] = handler },
    // 日志桩:partial 降级点(logger.warn)在测试中可执行且可断言,不再被 undefined 短路
    logger: { warns: [], warn(message) { this.warns.push(message) }, info() {} },
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
    logger: base.logger,
    readCounts,
    // 模拟宿主 settings 与 timer 服务激活:触发 inject 回调(注册 + 启动补扫 + 周期武装)
    activateSettings: () => {
      const injected = { settings: settingsService, interval: timerAvailable === false ? undefined : intervalStub }
      while (pendingInjects.length > 0) pendingInjects.shift()(injected)
    },
  }
}

async function waitFor(predicate) {
  // performance.now 不受 mock.timers 的 Date 接管影响,周期评估测试中仍可真实计时
  const deadline = performance.now() + 2000
  while (performance.now() < deadline) {
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
  for (const service of ['webServer', 'workspaceRegistry', 'sessionQuery', 'storageDomain', 'agents', 'sessions', 'sessionPersistence']) {
    assert.ok(declaredInject.includes(service), `inject 缺少 "${service}"`)
  }
})

test('请求体非法 JSON:协议错误与业务错误分通道,不透出引擎 SyntaxError', skipMissingDeps, async () => {
  const { handlers } = makeCtx({ archivedIds: [], headers: [], agents: new Map() })
  const req = new EventEmitter()
  req.method = 'POST'
  process.nextTick(() => {
    req.emit('data', Buffer.from('{not json'))
    req.emit('end')
  })
  const res = response()
  await handlers.get('/api/session-manager/unarchive')(req, res)
  assert.equal(res.status, 400)
  assert.equal(res.body.error, '请求体不是合法 JSON')
})

test('自动归档评估门闩:评估进行中的新触发被丢弃不排队', skipMissingDeps, async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'sm-gate-'))
  try {
    const alivePath = path.join(dir, 'alive.jsonl')
    await writeFile(alivePath, '{"header":1}\n{"event":0}\n')
    const DAY_MS = 24 * 60 * 60 * 1000
    const stale = Date.now() - 30 * DAY_MS
    await utimes(alivePath, stale / 1000, stale / 1000)
    const cwd = 'C:\\x'
    const headers = [{ id: 's1', cwd, createdAt: stale }]
    const { eventHandlers, registry } = makeCtx({
      archivedIds: [],
      headers,
      agents: new Map(),
      sessionPersistence: { locate: (header) => ({ path: alivePath }) },
    })
    eventHandlers['session/created']({ header: { id: 'trigger', cwd } })
    // 首轮启动后立即补新候选并连发两触发:首轮候选列表已捕获(s1),门闩正常时
    // trigger2/3 被丢弃,s2 永不评估;门闩失效则 s2 被归档,断言可见
    headers.push({ id: 's2', cwd, createdAt: stale })
    eventHandlers['session/created']({ header: { id: 'trigger2', cwd } })
    eventHandlers['session/created']({ header: { id: 'trigger3', cwd } })
    await waitFor(() => registry.archiveCalls.length > 0)
    // 给在途与迟到轮留完成窗口后断言:仅首轮产出,s2 未被任何一轮归档
    await new Promise((resolve) => setTimeout(resolve, 150))
    assert.deepEqual(registry.archiveCalls, ['s1'], '门闩应丢弃在途触发,新候选 s2 不被评估')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('并发删除:台账串行化不丢条目', skipMissingDeps, async () => {
  const artifactA = await makeLocatedArtifact('a')
  const artifactB = await makeLocatedArtifact('b')
  try {
    const headers = [
      { id: 'a', cwd: 'C:\\x', createdAt: 0 },
      { id: 'b', cwd: 'C:\\x', createdAt: 0 },
    ]
    const workspace = makeWorkspace('C:\\x', ['a', 'b'])
    const { handlers, ledger } = makeCtx({
      archivedIds: ['a', 'b'],
      headers,
      agents: new Map([['a', { status: 'idle' }], ['b', { status: 'idle' }]]),
      domain: makeDomain(['a', 'b']),
      sessionPersistence: { locate: (header) => header.id === 'a' ? { path: artifactA.locatedPath } : { path: artifactB.locatedPath } },
      workspaces: [workspace],
    })
    const resA = response()
    const resB = response()
    await Promise.all([
      withTrashStub(async () => {}, async () => {
        await handlers.get('/api/session-manager/delete')(request('a'), resA)
      }),
      withTrashStub(async () => {}, async () => {
        await handlers.get('/api/session-manager/delete')(request('b'), resB)
      }),
    ])
    assert.equal(resA.status, 200)
    assert.equal(resB.status, 200)
    // 串行化后两条台账都在;丢失更新会让后写者只剩自己的条目
    assert.deepEqual(ledger.state.deleted.map((item) => item.sessionId).sort(), ['a', 'b'])
  } finally {
    await artifactA.cleanup()
    await artifactB.cleanup()
  }
})

test('同 id 并发删除:第二个请求收到 in-flight 提示', skipMissingDeps, async () => {
  const artifact = await makeLocatedArtifact()
  try {
    let releaseTrash
    const trashGate = new Promise((resolve) => { releaseTrash = resolve })
    const workspace = makeWorkspace('C:\\x', ['s1'])
    const { handlers } = makeCtx({
      archivedIds: ['s1'],
      headers: [HEADER],
      agents: IDLE_S1,
      domain: makeDomain(['s1']),
      sessionPersistence: { locate: (header) => header.id === 's1' ? { path: artifact.locatedPath } : undefined },
      workspaces: [workspace],
    })
    const first = response()
    const firstDone = withTrashStub(async () => { await trashGate }, async () => {
      await handlers.get('/api/session-manager/delete')(request('s1'), first)
    })
    // 等 trash 进入挂起后再发第二发
    await new Promise((resolve) => setTimeout(resolve, 20))
    const second = response()
    await handlers.get('/api/session-manager/delete')(request('s1'), second)
    assert.equal(second.status, 400)
    assert.equal(second.body.error, '该会话正在删除中,请稍后重试')
    releaseTrash()
    await firstDone
  } finally {
    await artifact.cleanup()
  }
})

test('多工作区 detach:首个失败不终止后续,全部失败进日志', skipMissingDeps, async () => {
  const artifact = await makeLocatedArtifact()
  try {
    const broken = makeWorkspace('C:\\one', ['s1'], { detachError: new Error('one boom') })
    const healthy = makeWorkspace('C:\\two', ['s1'])
    const { handlers } = makeCtx({
      archivedIds: ['s1'],
      headers: [HEADER],
      agents: IDLE_S1,
      domain: makeDomain(['s1']),
      sessionPersistence: { locate: (header) => header.id === 's1' ? { path: artifact.locatedPath } : undefined },
      workspaces: [broken, healthy],
    })
    const res = response()
    await withTrashStub(async () => {}, async () => {
      await handlers.get('/api/session-manager/delete')(request('s1'), res)
    })
    assert.equal(res.status, 200)
    assert.equal(res.body.partial, true)
    assert.equal(res.body.message, '已移入回收站,但移除列表记录失败')
    // 健康工作区仍被解除关联
    assert.deepEqual(healthy.sessionIds, [])
  } finally {
    await artifact.cleanup()
  }
})

test('取消归档:域领先快照时反向合并清理', skipMissingDeps, async () => {
  const domain = makeDomain(['s1'])
  const { handlers, registry } = makeCtx({ archivedIds: [], headers: [HEADER], agents: new Map(), domain })
  const res = response()
  await handlers.get('/api/session-manager/unarchive')(request('s1'), res)
  assert.equal(res.status, 200)
  assert.deepEqual(res.body, { ok: true })
  // durable 有而快照无:合并后仍完成移除,防漏清理
  assert.deepEqual(domain.state.archivedSessionIds, [])
  assert.equal(domain.writes, 1)
  assert.deepEqual(registry.state.archivedSessionIds, [])
})

test('台账 deletedAt 为删除时刻的数值(面板排序依据)', skipMissingDeps, async () => {
  const artifact = await makeLocatedArtifact()
  try {
    const before = Date.now()
    const { handlers, ledger } = makeCtx({
      archivedIds: ['s1'],
      headers: [HEADER],
      agents: IDLE_S1,
      domain: makeDomain(['s1']),
      sessionPersistence: { locate: (header) => header.id === 's1' ? { path: artifact.locatedPath } : undefined },
    })
    const res = response()
    await withTrashStub(async () => {}, async () => {
      await handlers.get('/api/session-manager/delete')(request('s1'), res)
    })
    assert.equal(res.status, 200)
    const deletedAt = ledger.state.deleted[0].deletedAt
    assert.ok(typeof deletedAt === 'number' && deletedAt >= before && deletedAt <= Date.now() + 1000)
  } finally {
    await artifact.cleanup()
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

test('自动归档评估:locate 缺失(第三方后端)的会话不参与归档', skipMissingDeps, async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'sm-eval-nolocate-'))
  try {
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
    const { eventHandlers, registry } = makeCtx({
      archivedIds: [],
      headers,
      agents: new Map(),
      // s2 locate 返回 undefined(抽象后端契约允许):仅凭 createdAt 判活跃会绕过
      // mtime 保护,与 delete 的 unsupportedBackend 拒绝对齐
      sessionPersistence: {
        locate: (header) => header.id === 's1' ? { path: alivePath } : undefined,
      },
    })
    eventHandlers['session/created']({ header: { id: 'trigger', cwd } })
    await waitFor(() => registry.archiveCalls.length > 0)
    assert.deepEqual(registry.archiveCalls, ['s1'])
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('启动评估:settings 就绪后全量归档超期会话,不限于单工作区', skipMissingDeps, async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'sm-startup-'))
  try {
    const artifactA = path.join(dir, 'a.jsonl')
    const artifactB = path.join(dir, 'b.jsonl')
    await writeFile(artifactA, '{"header":1}\n{"event":0}\n')
    await writeFile(artifactB, '{"header":1}\n{"event":0}\n')
    const DAY_MS = 24 * 60 * 60 * 1000
    const stale = Date.now() - 30 * DAY_MS
    await utimes(artifactA, stale / 1000, stale / 1000)
    await utimes(artifactB, stale / 1000, stale / 1000)
    const headers = [
      { id: 'a', cwd: 'C:\\x', createdAt: stale },
      { id: 'b', cwd: 'C:\\y', createdAt: stale },
    ]
    const { activateSettings, registry, handlers } = makeCtx({
      archivedIds: [],
      headers,
      agents: new Map(),
      sessionPersistence: {
        locate: (header) => ({ path: header.id === 'a' ? artifactA : artifactB }),
      },
    })
    activateSettings()
    await waitFor(() => registry.archiveCalls.length >= 2)
    assert.deepEqual([...registry.archiveCalls].sort(), ['a', 'b'])
    const status = response()
    await handlers.get('/api/session-manager/status')(request('x', 'GET'), status)
    assert.equal(status.status, 200)
    assert.equal(status.body.periodic.running, true)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('启动评估:autoArchiveDays=0 时不评估', skipMissingDeps, async () => {
  const { activateSettings, registry } = makeCtx({
    archivedIds: [],
    headers: [{ id: 's1', cwd: 'C:\\x', createdAt: 0 }],
    agents: new Map(),
    settingsValue: { autoArchiveDays: 0 },
  })
  activateSettings()
  await new Promise((resolve) => setTimeout(resolve, 50))
  assert.deepEqual(registry.archiveCalls, [])
})

test('周期评估:每日定时补扫首轮不可评估的会话', skipMissingDeps, async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'sm-period-'))
  // 夹具 mtime 用真实时钟落盘,之后接管 Date 与 setInterval:到期判断(nextDueAt)
  // 与定时器触发共用同一虚拟时钟,tick 推进 24h 即触发周期轮
  const artifactA = path.join(dir, 'a.jsonl')
  const artifactB = path.join(dir, 'b.jsonl')
  await writeFile(artifactA, '{"header":1}\n{"event":0}\n')
  await writeFile(artifactB, '{"header":1}\n{"event":0}\n')
  const DAY_MS = 24 * 60 * 60 * 1000
  const realNow = Date.now()
  const stale = realNow - 30 * DAY_MS
  await utimes(artifactA, stale / 1000, stale / 1000)
  await utimes(artifactB, stale / 1000, stale / 1000)
  // 显式传 now:mock.timers 接管 Date 后从 epoch 0 起算,不传则夹具时间戳全成「未来」
  mock.timers.enable({ apis: ['setInterval', 'Date'], now: realNow })
  try {
    // 首轮 b 产物不可读(守卫跳过),周期轮起可读:b 只能经周期评估归档
    let bReadable = false
    const { activateSettings, registry } = makeCtx({
      archivedIds: [],
      headers: [
        { id: 'a', cwd: 'C:\\x', createdAt: stale },
        { id: 'b', cwd: 'C:\\x', createdAt: stale },
      ],
      agents: new Map(),
      sessionPersistence: {
        locate: (header) => (header.id === 'b' && !bReadable)
          ? { path: path.join(dir, 'gone.jsonl') }
          : { path: header.id === 'a' ? artifactA : artifactB },
      },
    })
    activateSettings()
    await waitFor(() => registry.archiveCalls.length > 0)
    assert.deepEqual(registry.archiveCalls, ['a'])
    bReadable = true
    mock.timers.tick(DAY_MS)
    await waitFor(() => registry.archiveCalls.includes('b'))
    // 桩回写 archivedSessionIds(真实注册表契约):已归档 a 不被周期轮重复选中
    assert.deepEqual(registry.archiveCalls, ['a', 'b'])
  } finally {
    mock.timers.reset()
    await rm(dir, { recursive: true, force: true })
  }
})

test('周期评估:autoArchiveDays=0 时不评估', skipMissingDeps, async () => {
  mock.timers.enable({ apis: ['setInterval', 'Date'], now: Date.now() })
  try {
    const { activateSettings, registry } = makeCtx({
      archivedIds: [],
      headers: [{ id: 's1', cwd: 'C:\\x', createdAt: 0 }],
      agents: new Map(),
      settingsValue: { autoArchiveDays: 0 },
    })
    activateSettings()
    mock.timers.tick(24 * 60 * 60 * 1000)
    await new Promise((resolve) => setTimeout(resolve, 50))
    assert.deepEqual(registry.archiveCalls, [])
  } finally {
    mock.timers.reset()
  }
})

test('周期评估:间隔设置运行时变更经 tick 对账(0 重启用 / 关闭即时暂停)', skipMissingDeps, async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'sm-rearm-'))
  // settings 桩返回同一对象引用:测试中改字段即模拟用户运行时改设置
  const settingsValue = { autoArchiveIntervalHours: 0 }
  mock.timers.enable({ apis: ['setInterval', 'Date'], now: Date.now() })
  try {
    const artifacts = {}
    const DAY_MS = 24 * 60 * 60 * 1000
    const TICK_MS = 60 * 1000
    const stale = Date.now() - 30 * DAY_MS
    const readable = { s1: true, s2: false, s3: false }
    for (const id of ['s1', 's2', 's3']) {
      const artifact = path.join(dir, id + '.jsonl')
      await writeFile(artifact, '{"header":1}\n{"event":0}\n')
      await utimes(artifact, stale / 1000, stale / 1000)
      artifacts[id] = artifact
    }
    const headers = [
      { id: 's1', cwd: 'C:\\x', createdAt: stale },
      { id: 's2', cwd: 'C:\\x', createdAt: stale },
      { id: 's3', cwd: 'C:\\x', createdAt: stale },
    ]
    const { activateSettings, registry } = makeCtx({
      archivedIds: [],
      headers,
      agents: new Map(),
      settingsValue,
      sessionPersistence: {
        locate: (header) => ({ path: readable[header.id] ? artifacts[header.id] : path.join(dir, 'gone-' + header.id) }),
      },
    })
    activateSettings()
    // 启动补扫只看 autoArchiveDays(默认 7),intervalHours=0 不影响首轮
    await waitFor(() => registry.archiveCalls.length > 0)
    assert.deepEqual(registry.archiveCalls, ['s1'])
    // intervalHours=0 期间周期轮保持关闭:到期也不评估
    readable.s2 = true
    mock.timers.tick(DAY_MS)
    await new Promise((resolve) => setTimeout(resolve, 50))
    assert.deepEqual(registry.archiveCalls, ['s1'], '关闭状态下到期不得评估')
    // 0 重启用:缺失 due 经 tick 对账补排,最迟下个 tick 恢复周期轮
    settingsValue.autoArchiveIntervalHours = 24
    mock.timers.tick(TICK_MS)
    await waitFor(() => registry.archiveCalls.includes('s2'))
    assert.deepEqual(registry.archiveCalls, ['s1', 's2'])
    // 再次关闭:即时暂停,s3 不被评估
    readable.s3 = true
    settingsValue.autoArchiveIntervalHours = 0
    mock.timers.tick(DAY_MS)
    await new Promise((resolve) => setTimeout(resolve, 50))
    assert.deepEqual(registry.archiveCalls, ['s1', 's2'], '再次关闭后到期不得评估')
    // 第三次重启用:对账恢复,归档 s3
    settingsValue.autoArchiveIntervalHours = 24
    mock.timers.tick(TICK_MS)
    await waitFor(() => registry.archiveCalls.includes('s3'))
    assert.deepEqual(registry.archiveCalls, ['s1', 's2', 's3'])
  } finally {
    mock.timers.reset()
    await rm(dir, { recursive: true, force: true })
  }
})

test('周期评估:缩短间隔经 earliest 钳制前移,不等满旧周期', skipMissingDeps, async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'sm-shorten-'))
  const TICK_MS = 60 * 1000
  const HOUR_MS = 60 * 60 * 1000
  mock.timers.enable({ apis: ['setInterval', 'Date'], now: Date.now() })
  try {
    const readable = { a: true, b: false }
    const artifacts = {}
    const DAY_MS = 24 * 60 * 60 * 1000
    const stale = Date.now() - 30 * DAY_MS
    for (const id of ['a', 'b']) {
      const artifact = path.join(dir, id + '.jsonl')
      await writeFile(artifact, '{"header":1}\n{"event":0}\n')
      await utimes(artifact, stale / 1000, stale / 1000)
      artifacts[id] = artifact
    }
    const settingsValue = { autoArchiveIntervalHours: 24 }
    const { activateSettings, registry } = makeCtx({
      archivedIds: [],
      headers: [
        { id: 'a', cwd: 'C:\\x', createdAt: stale },
        { id: 'b', cwd: 'C:\\x', createdAt: stale },
      ],
      agents: new Map(),
      settingsValue,
      sessionPersistence: {
        locate: (header) => readable[header.id] ? { path: artifacts[header.id] } : { path: path.join(dir, 'gone-' + header.id) },
      },
    })
    activateSettings()
    await waitFor(() => registry.archiveCalls.length > 0)
    assert.deepEqual(registry.archiveCalls, ['a'])
    const afterStartup = registry.archiveCalls.length
    // T+24h 到期轮(a 已归档无产出);紧接缩短为 1h:earliest 钳制应把 due 前移到
    // 缩短时刻 + 1h,而非等满旧周期 T+48h;b 在缩短后变可读,由前移后的轮归档
    mock.timers.tick(DAY_MS)
    settingsValue.autoArchiveIntervalHours = 1
    readable.b = true
    mock.timers.tick(DAY_MS + TICK_MS)
    await waitFor(() => registry.archiveCalls.length > afterStartup)
    assert.deepEqual(registry.archiveCalls, ['a', 'b'])
  } finally {
    mock.timers.reset()
    await rm(dir, { recursive: true, force: true })
  }
})

test('定时服务缺失:周期评估降级,状态接口提示且不影响启动补扫', skipMissingDeps, async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'sm-degrade-'))
  try {
    const artifact = path.join(dir, 'a.jsonl')
    await writeFile(artifact, '{"header":1}\n{"event":0}\n')
    const DAY_MS = 24 * 60 * 60 * 1000
    const stale = Date.now() - 30 * DAY_MS
    await utimes(artifact, stale / 1000, stale / 1000)
    const { activateSettings, handlers, registry } = makeCtx({
      archivedIds: [],
      headers: [{ id: 'a', cwd: 'C:\\x', createdAt: stale }],
      agents: new Map(),
      sessionPersistence: { locate: () => ({ path: artifact }) },
      timerAvailable: false,
    })
    activateSettings()
    // 启动补扫照常工作:软依赖缺失只影响周期轮
    await waitFor(() => registry.archiveCalls.length > 0)
    assert.deepEqual(registry.archiveCalls, ['a'])
    const status = response()
    await handlers.get('/api/session-manager/status')(request('x', 'GET'), status)
    assert.equal(status.status, 200)
    assert.equal(status.body.periodic.running, false)
    assert.notEqual(status.body.periodic.reason, '')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('周期评估:到期 tick 恰逢门闩占用时保持到期态,下个 tick 重试而非推后一个周期', skipMissingDeps, async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'sm-gate-tick-'))
  const TICK_MS = 60 * 1000
  const DAY_MS = 24 * 60 * 60 * 1000
  mock.timers.enable({ apis: ['setInterval', 'Date'], now: Date.now() })
  try {
    const readable = { a: true, b: false, c: false }
    const artifacts = {}
    const stale = Date.now() - 30 * DAY_MS
    for (const id of ['a', 'b', 'c']) {
      const artifact = path.join(dir, id + '.jsonl')
      await writeFile(artifact, '{"header":1}\n{"event":0}\n')
      await utimes(artifact, stale / 1000, stale / 1000)
      artifacts[id] = artifact
    }
    const headers = [
      { id: 'a', cwd: 'C:\\x', createdAt: stale },
      { id: 'b', cwd: 'C:\\x', createdAt: stale },
      { id: 'c', cwd: 'C:\\x', createdAt: stale },
    ]
    const { activateSettings, eventHandlers, registry } = makeCtx({
      archivedIds: [],
      headers,
      agents: new Map(),
      sessionPersistence: {
        locate: (header) => readable[header.id] ? { path: artifacts[header.id] } : { path: path.join(dir, 'gone-' + header.id) },
      },
    })
    activateSettings()
    // 启动补扫:a 归档(桩回写 archived),b/c 不可读留候选
    await waitFor(() => registry.archiveCalls.length > 0)
    assert.deepEqual(registry.archiveCalls, ['a'])
    // 挂起归档执行器,再触发一轮评估:门闩被占
    let releaseArchive
    const held = new Promise((resolve) => { releaseArchive = resolve })
    const originalArchive = registry.archiveSession
    let archiveArrived = false
    registry.archiveSession = async (id) => {
      archiveArrived = true
      await held
      await originalArchive(id)
    }
    readable.b = true
    eventHandlers['session/created']({ header: headers[1] })
    await waitFor(() => archiveArrived)
    assert.deepEqual(registry.archiveCalls, ['a'], '挂起的 b 尚未计入归档调用')
    // 到期 tick 恰逢门闩占用:被丢弃,不得把周期推后 24h(保持到期态)
    mock.timers.tick(DAY_MS)
    // 释放挂起评估并让出事件循环,确保门闩复位(evaluating=false)落定
    releaseArchive()
    await new Promise((resolve) => setImmediate(resolve))
    await new Promise((resolve) => setTimeout(resolve, 0))
    // c 变可读,60s 后的下个 tick 即应重试并归档 c(若周期被推后 24h 此步超时)
    readable.c = true
    mock.timers.tick(TICK_MS)
    await waitFor(() => registry.archiveCalls.includes('c'))
    assert.deepEqual(registry.archiveCalls, ['a', 'b', 'c'])
  } finally {
    mock.timers.reset()
    await rm(dir, { recursive: true, force: true })
  }
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
async function makeLocatedArtifact(sessionId = 's1') {
  const root = await mkdtemp(path.join(tmpdir(), 'sm-del-'))
  const locatedDir = path.join(root, sessionId)
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

test('删除:产物已缺失时跳过 trash 与台账,完成列表清理(同 id 重删场景)', skipMissingDeps, async () => {
  const domain = makeDomain([])
  const workspace = makeWorkspace('C:\\x', ['s1'])
  const { handlers, ledger } = makeCtx({
    // 幽灵会话已不在归档集合:残留清理不要求归档资格,但要求台账有记录
    // (首删已记录,重删走幽灵收尾)
    archivedIds: [],
    headers: [HEADER],
    agents: IDLE_S1,
    domain,
    sessionPersistence: { locate: (header) => header.id === 's1' ? { path: 'C:\\gone\\s1\\session.jsonl.zstd' } : undefined },
    ledger: makeLedgerDomain([{ sessionId: 's1', path: 'C:\\gone\\s1', deletedAt: 1 }]),
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
  assert.equal(ledger.writes, 0)
  // 残留清理仍解除工作区关联与归档集合(幂等)
  assert.deepEqual(workspace.sessionIds, [])
  assert.deepEqual(domain.state.archivedSessionIds, [])
})

test('删除:产物缺失且无归档记录无台账时拒绝(防新建会话未落盘被剥离)', skipMissingDeps, async () => {
  const workspace = makeWorkspace('C:\\x', ['s1'])
  const { handlers } = makeCtx({
    archivedIds: [],
    headers: [HEADER],
    agents: IDLE_S1,
    domain: makeDomain([]),
    sessionPersistence: { locate: (header) => header.id === 's1' ? { path: 'C:\\gone\\s1\\session.jsonl.zstd' } : undefined },
    workspaces: [workspace],
  })
  const res = response()
  await withTrashStub(async () => {}, async () => {
    await handlers.get('/api/session-manager/delete')(request('s1'), res)
  })
  assert.equal(res.status, 400)
  assert.equal(res.body.error, MESSAGES.notArchived)
  // 拒绝路径不动工作区关联
  assert.deepEqual(workspace.sessionIds, ['s1'])
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
  const { handlers, logger } = makeCtx({
    archivedIds: [],
    headers: [HEADER],
    agents: IDLE_S1,
    domain: null,
    sessionPersistence: { locate: (header) => header.id === 's1' ? { path: 'C:\\gone\\s1\\session.jsonl.zstd' } : undefined },
    ledger: makeLedgerDomain([{ sessionId: 's1', path: 'C:\\gone\\s1', deletedAt: 1 }]),
    workspaces: [workspace],
  })
  const res = response()
  await withTrashStub(async () => {}, async () => {
    await handlers.get('/api/session-manager/delete')(request('s1'), res)
  })
  assert.equal(res.status, 200)
  assert.equal(res.body.partial, true)
  assert.equal(res.body.message, '产物已不存在,但移除列表记录失败,且移除归档记录失败')
  // 幽灵清理半失败:原始错误进服务端日志(排障契约),响应文案保持摘要
  assert.ok(logger.warns.some((message) => message.includes('s1') && message.includes('detach boom')), '幽灵 detach 失败应落日志')
})

test('删除:回收窗口内会话恢复运行,响应警告形态且无 partial 键', skipMissingDeps, async () => {
  const artifact = await makeLocatedArtifact()
  try {
    const agents = new Map([['s1', { status: 'idle' }]])
    const { handlers } = makeCtx({
      archivedIds: ['s1'],
      headers: [HEADER],
      agents,
      domain: makeDomain(['s1']),
      sessionPersistence: { locate: (header) => header.id === 's1' ? { path: artifact.locatedPath } : undefined },
    })
    const res = response()
    // trash 桩内翻转运行态:模拟 OS 回收异步窗口内的执行期翻转
    await withTrashStub(async () => { agents.set('s1', { status: 'running' }) }, async () => {
      await handlers.get('/api/session-manager/delete')(request('s1'), res)
    })
    assert.equal(res.status, 200)
    // 全成功警告态:{ok,message} 形态,无 partial 键
    assert.deepEqual(res.body, { ok: true, message: DELETE_MESSAGES.runningDuringTrash })
  } finally {
    await artifact.cleanup()
  }
})

test('归档评估:超期运行中会话零产物 IO(早退,core 过滤为第二道防线)', skipMissingDeps, async () => {
  const stale = Date.now() - 30 * 24 * 60 * 60 * 1000
  let locateCalls = 0
  const { activateSettings, registry } = makeCtx({
    archivedIds: [],
    headers: [{ id: 's1', cwd: 'C:\\x', createdAt: stale }],
    agents: new Map([['s1', { status: 'running' }]]),
    sessionPersistence: {
      locate: (header) => {
        locateCalls += 1
        return { path: 'C:\\x\\s1\\session.jsonl.zstd' }
      },
    },
  })
  // 历史启动对齐(运行中会话即时路径)也走 locate:等它跑完并清零计数,
  // 此后断言只针对归档评估的产物 IO
  await new Promise((resolve) => setTimeout(resolve, 30))
  locateCalls = 0
  activateSettings()
  // 等评估轮跑完(正常会话路径必然触达 locate):running 会话不得产生 locate 调用
  await new Promise((resolve) => setTimeout(resolve, 250))
  assert.equal(locateCalls, 0, '运行中会话应在产物 IO 前早退')
  assert.deepEqual(registry.archiveCalls, [])
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
    const { handlers, logger } = makeCtx({
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
    // 台账与 detach 的原始错误均进服务端日志
    assert.ok(logger.warns.some((message) => message.includes('s1') && message.includes('medium broken')), '台账失败应落日志')
    assert.ok(logger.warns.some((message) => message.includes('s1') && message.includes('detach boom')), 'detach 失败应落日志')
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

// ── 历史输入路由(GET /api/session-manager/inputs;工作区持久缓存)──

function getRequest(query) {
  const req = new EventEmitter()
  req.method = 'GET'
  req.url = '/api/session-manager/inputs' + query
  return req
}

function userMessageEvent(text, at) {
  return {
    type: 'user/message',
    seq: at,
    time: at,
    data: { id: 'm' + at, role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text }] },
  }
}

function makeHistoryCtx() {
  return makeCtx({
    archivedIds: [],
    headers: [
      { id: 's1', cwd: 'C:\\x', createdAt: 0 },
      { id: 's2', cwd: 'C:\\x', createdAt: 0 },
      { id: 's3', cwd: 'C:\\other', createdAt: 0 },
    ],
    agents: new Map(),
    readSessions: {
      s1: [userMessageEvent('更早的输入', 100), userMessageEvent('最新输入', 900)],
      s2: [userMessageEvent('第二条', 500)],
      s3: [userMessageEvent('别的工作区', 999)],
    },
  })
}

// 后台对齐是异步的:轮询等待响应满足条件(默认 aligned 翻真,可断言数据就绪)
async function requestUntil(handlers, query, predicate, maxMs = 3000) {
  for (let waited = 0; waited <= maxMs; waited += 100) {
    const res = response()
    await handlers.get('/api/session-manager/inputs')(getRequest(query), res)
    if (predicate(res.body)) return res
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error('条件未满足: ' + query)
}

function requestUntilAligned(handlers, query) {
  return requestUntil(handlers, query, (body) => body.aligned)
}

// 每个测试独占临时缓存目录:插件 factory 在 makeCtx 时读取 env 解析缓存目录。
// 后台对齐 fire-and-forget,测试结束仍在写目录——清理重试躲开 Windows 文件占用
async function withHistoryCacheDir(run) {
  const cacheDir = await mkdtemp(path.join(tmpdir(), 'sm-hist-'))
  process.env.DSH_HISTORY_CACHE_DIR = cacheDir
  try {
    return await run(cacheDir)
  } finally {
    delete process.env.DSH_HISTORY_CACHE_DIR
    for (let attempt = 0; attempt < 6; attempt += 1) {
      try {
        await rm(cacheDir, { recursive: true, force: true })
        break
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 150))
      }
    }
  }
}

test('历史输入路由:首次 aligned=false 触发后台对齐,对齐后三范围正确且 session 按 sid 过滤', skipMissingDeps, async () => {
  await withHistoryCacheDir(async () => {
    const { handlers } = makeHistoryCtx()
    const first = response()
    await handlers.get('/api/session-manager/inputs')(getRequest('?sessionId=s1&scope=workspace'), first)
    assert.equal(first.status, 200)
    assert.deepEqual(first.body.inputs, [])
    assert.equal(first.body.aligned, false)
    const workspaceRes = await requestUntilAligned(handlers, '?sessionId=s1&scope=workspace')
    assert.deepEqual(workspaceRes.body.inputs.map((item) => item.text), ['最新输入', '第二条', '更早的输入'])
    const sessionRes = await requestUntilAligned(handlers, '?sessionId=s1&scope=session')
    assert.deepEqual(sessionRes.body.inputs.map((item) => item.text), ['最新输入', '更早的输入'])
    const otherSessionRes = await requestUntilAligned(handlers, '?sessionId=s2&scope=session')
    assert.deepEqual(otherSessionRes.body.inputs.map((item) => item.text), ['第二条'])
    // global 合并全部工作区缓存:先触发 C:\other 对齐(模拟其已就绪),再等 global 汇聚
    await requestUntilAligned(handlers, '?sessionId=s3&scope=workspace')
    const globalRes = await requestUntil(handlers, '?sessionId=s1&scope=global',
      (body) => body.aligned && body.inputs.some((item) => item.text === '别的工作区'))
    assert.deepEqual(globalRes.body.inputs.map((item) => item.text), ['别的工作区', '最新输入', '第二条', '更早的输入'])
  })
})

test('历史输入路由:对齐与既有缓存合并——旧条目保留、新输入追加、sid 溯源不变', skipMissingDeps, async () => {
  await withHistoryCacheDir(async () => {
    await ensureCacheDir(process.env.DSH_HISTORY_CACHE_DIR)
    await writeWorkspaceCache(process.env.DSH_HISTORY_CACHE_DIR, 'C:\\x', {
      entries: [
        { text: '更早的输入', at: 100, sid: 's1' },
        { text: '已消失会话的输入', at: 50, sid: 'gone' },
      ],
      extracts: {},
    })
    const { handlers } = makeHistoryCtx()
    const res = await requestUntil(handlers, '?sessionId=s1&scope=workspace',
      (body) => body.aligned && body.inputs.some((item) => item.text === '最新输入'))
    assert.deepEqual(res.body.inputs.map((item) => item.text), ['最新输入', '第二条', '更早的输入', '已消失会话的输入'])
    const sessionRes = await requestUntil(handlers, '?sessionId=s1&scope=session',
      (body) => body.aligned && body.inputs.some((item) => item.text === '最新输入'))
    assert.deepEqual(sessionRes.body.inputs.map((item) => item.text), ['最新输入', '更早的输入'])
  })
})

test('历史输入路由:scope 缺省回退 session;未知会话/非 GET/缺 sessionId 拒绝', skipMissingDeps, async () => {
  await withHistoryCacheDir(async () => {
    const { handlers } = makeHistoryCtx()
    const defaultRes = await requestUntilAligned(handlers, '?sessionId=s1')
    assert.deepEqual(defaultRes.body.inputs.map((item) => item.text), ['最新输入', '更早的输入'])
    const invalidRes = await requestUntilAligned(handlers, '?sessionId=s1&scope=bogus')
    assert.deepEqual(invalidRes.body.inputs.map((item) => item.text), ['最新输入', '更早的输入'])
    const unknown = response()
    await handlers.get('/api/session-manager/inputs')(getRequest('?sessionId=ghost'), unknown)
    assert.equal(unknown.status, 400)
    assert.equal(unknown.body.error, MESSAGES.unknownSession)
    const wrongMethod = response()
    await handlers.get('/api/session-manager/inputs')(request('s1'), wrongMethod)
    assert.equal(wrongMethod.status, 405)
    const missing = response()
    await handlers.get('/api/session-manager/inputs')(getRequest(''), missing)
    assert.equal(missing.status, 400)
  })
})

test('历史输入路由:损坏会话对齐跳过不中断;无 cwd 会话 workspace/session 返回空且 aligned', skipMissingDeps, async () => {
  await withHistoryCacheDir(async () => {
    const { handlers, logger } = makeCtx({
      archivedIds: [],
      headers: [
        { id: 's1', cwd: 'C:\\x', createdAt: 0 },
        { id: 'broken', cwd: 'C:\\x', createdAt: 0 },
        { id: 'nocwd', createdAt: 0 },
      ],
      agents: new Map(),
      readSessions: {
        s1: [userMessageEvent('存活输入', 100)],
        broken: () => { throw new Error('产物损坏') },
      },
    })
    const res = await requestUntilAligned(handlers, '?sessionId=s1&scope=workspace')
    assert.deepEqual(res.body.inputs.map((item) => item.text), ['存活输入'])
    assert.ok(logger.warns.some((line) => line.includes('broken')), '对齐失败未进服务端日志')
    const noCwdWorkspace = response()
    await handlers.get('/api/session-manager/inputs')(getRequest('?sessionId=nocwd&scope=workspace'), noCwdWorkspace)
    assert.deepEqual(noCwdWorkspace.body, { inputs: [], aligned: true })
    const noCwdSession = response()
    await handlers.get('/api/session-manager/inputs')(getRequest('?sessionId=nocwd&scope=session'), noCwdSession)
    assert.deepEqual(noCwdSession.body, { inputs: [], aligned: true })
  })
})

test('历史输入路由:运行中会话参与对齐(实时追加),缓存上限裁剪保留最新', skipMissingDeps, async () => {
  await withHistoryCacheDir(async () => {
    const agents = new Map([['running1', { status: 'running' }]])
    const manyEvents = Array.from({ length: HISTORY_INPUT_LIMIT + 50 }, (_, i) => userMessageEvent('运行输入' + i, 1000 + i))
    const { handlers, readCounts } = makeCtx({
      archivedIds: [],
      headers: [
        { id: 's1', cwd: 'C:\\x', createdAt: 0 },
        { id: 'running1', cwd: 'C:\\x', createdAt: 0 },
      ],
      agents,
      readSessions: {
        s1: [userMessageEvent('历史输入', 1000 + manyEvents.length + 10)],
        running1: manyEvents,
      },
    })
    const res = await requestUntil(handlers, '?sessionId=s1&scope=workspace',
      (body) => body.aligned && body.inputs.length === HISTORY_INPUT_LIMIT)
    const texts = res.body.inputs.map((item) => item.text)
    assert.equal(texts.length, HISTORY_INPUT_LIMIT)
    assert.ok(texts.includes('历史输入'), '最新既有输入保留')
    assert.ok(texts.includes('运行输入' + (HISTORY_INPUT_LIMIT + 49)), '次新运行输入保留')
    assert.ok(!texts.includes('运行输入0'), '最旧输入被上限裁剪')
    assert.ok(readCounts.get('running1') >= 1, '运行中会话被对齐解压')
    const sessionRes = await requestUntilAligned(handlers, '?sessionId=running1&scope=session')
    assert.ok(sessionRes.body.inputs.length > 0, 'session 范围可取运行中会话自身输入')
  })
})

test('历史输入路由:再次请求读缓存不再解压产物(对齐节流内)', skipMissingDeps, async () => {
  await withHistoryCacheDir(async () => {
    const { handlers, readCounts } = makeCtx({
      archivedIds: [],
      headers: [{ id: 's1', cwd: 'C:\\x', createdAt: 0 }],
      agents: new Map(),
      readSessions: { s1: [userMessageEvent('工作区输入', 100)] },
    })
    await requestUntilAligned(handlers, '?sessionId=s1&scope=workspace')
    const readsAfterAlign = readCounts.get('s1')
    const second = response()
    await handlers.get('/api/session-manager/inputs')(getRequest('?sessionId=s1&scope=workspace'), second)
    assert.deepEqual(second.body.inputs.map((item) => item.text), ['工作区输入'])
    assert.equal(second.body.aligned, true)
    assert.equal(readCounts.get('s1'), readsAfterAlign, '读路径不得解压产物')
  })
})

test('历史输入路由:会话产物变化即席聚焦对齐,单次请求内拿到新输入(首条<3s)', skipMissingDeps, async () => {
  await withHistoryCacheDir(async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'sm-hist-focus-'))
    const artifactPath = path.join(dir, 'session.jsonl.zstd')
    await writeFile(artifactPath, 'log-v1')
    try {
      const shared = {
        archivedIds: [],
        headers: [{ id: 's1', cwd: 'C:\\x', createdAt: 0 }],
        agents: new Map(),
        sessionPersistence: { locate: (header) => ({ path: artifactPath }) },
      }
      const first = makeCtx({ ...shared, readSessions: { s1: [userMessageEvent('旧输入', 100)] } })
      await requestUntilAligned(first.handlers, '?sessionId=s1&scope=session')
      // 产物增长(会话有新输入):指纹失效——路由就地等待聚焦对齐,
      // 测试桩的 readSession 立即完成,单次请求内应直接拿到新输入且 aligned
      await writeFile(artifactPath, 'log-v1-much-longer-appended')
      const second = makeCtx({ ...shared, readSessions: { s1: [userMessageEvent('旧输入', 100), userMessageEvent('新输入XYZ', 200)] } })
      const res = response()
      await second.handlers.get('/api/session-manager/inputs')(getRequest('?sessionId=s1&scope=session'), res)
      assert.equal(res.body.aligned, true, '焦点对齐快于等待时限,首请求即就绪')
      assert.deepEqual(res.body.inputs.map((item) => item.text), ['新输入XYZ', '旧输入'])
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

test('历史输入路由:聚焦对齐只更新目标会话,不抹其他会话的持久 extracts', skipMissingDeps, async () => {
  await withHistoryCacheDir(async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'sm-hist-prune-'))
    const artifactPath = path.join(dir, 'session.jsonl.zstd')
    await writeFile(artifactPath, 'log-v1')
    try {
      await ensureCacheDir(process.env.DSH_HISTORY_CACHE_DIR)
      await writeWorkspaceCache(process.env.DSH_HISTORY_CACHE_DIR, 'C:\\x', {
        entries: [{ text: '更早的输入', at: 100, sid: 's1' }],
        extracts: { s2: { mtimeMs: 1, size: 2, entries: [{ text: '邻居会话输入', at: 50 }] } },
      })
      const { handlers } = makeCtx({
        archivedIds: [],
        headers: [
          { id: 's1', cwd: 'C:\\x', createdAt: 0 },
          { id: 's2', cwd: 'C:\\x', createdAt: 0 },
        ],
        agents: new Map(),
        sessionPersistence: { locate: (header) => ({ path: artifactPath }) },
        readSessions: { s1: [userMessageEvent('更早的输入', 100), userMessageEvent('聚焦新输入', 200)] },
      })
      await requestUntil(handlers, '?sessionId=s1&scope=session',
        (body) => body.aligned && body.inputs.some((item) => item.text === '聚焦新输入'))
      const cached = JSON.parse(await readFile(path.join(process.env.DSH_HISTORY_CACHE_DIR, 'x-5358b306.json'), 'utf8'))
      assert.ok(cached.extracts.s2, '邻居会话 extracts 不得被聚焦对齐抹掉')
      assert.ok(cached.extracts.s1, '目标会话 extracts 已更新')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

test('历史输入路由:产物未变的会话跨对齐零解压(磁盘 extracts 指纹命中)', skipMissingDeps, async () => {
  await withHistoryCacheDir(async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'sm-hist-art-'))
    const artifactPath = path.join(dir, 'session.jsonl.zstd')
    await writeFile(artifactPath, 'log-bytes')
    try {
      const { handlers, readCounts } = makeCtx({
        archivedIds: [],
        headers: [{ id: 's1', cwd: 'C:\\x', createdAt: 0 }],
        agents: new Map(),
        sessionPersistence: { locate: (header) => ({ path: artifactPath }) },
        readSessions: { s1: [userMessageEvent('工作区输入', 100)] },
      })
      await requestUntilAligned(handlers, '?sessionId=s1&scope=workspace')
      const readsAfterFirstAlign = readCounts.get('s1')
      assert.ok(readsAfterFirstAlign >= 1, '首次对齐必然解压')
      // 节流壳 30s 挡住同工作区二次触发:直接以新 makeCtx(新节流 Map)模拟"重启后再次对齐"
      const { handlers: handlers2, readCounts: readCounts2 } = makeCtx({
        archivedIds: [],
        headers: [{ id: 's1', cwd: 'C:\\x', createdAt: 0 }],
        agents: new Map(),
        sessionPersistence: { locate: (header) => ({ path: artifactPath }) },
        readSessions: { s1: [userMessageEvent('工作区输入', 100)] },
      })
      // 同一缓存目录(env 未变,withHistoryCacheDir 复用):指纹命中 → 零解压
      const second = response()
      await handlers2.get('/api/session-manager/inputs')(getRequest('?sessionId=s1&scope=workspace'), second)
      assert.equal(second.body.aligned, true)
      assert.deepEqual(second.body.inputs.map((item) => item.text), ['工作区输入'])
      // 触发一次对齐(绕过节流:新 ctx 节流 Map 为空,请求即触发)
      await new Promise((resolve) => setTimeout(resolve, 300))
      assert.equal(readCounts2.get('s1') === undefined, true, '产物未变,重启后对齐零解压')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

test('历史输入路由:启动对齐只回溯最近 STARTUP_SCAN 个会话,老会话不解压', skipMissingDeps, async () => {
  await withHistoryCacheDir(async () => {
    const total = HISTORY_STARTUP_SCAN_LIMIT + 20
    // 宿主 listSessions 为最新在前:数组首元素即最新会话
    const headers = Array.from({ length: total }, (_, i) => ({ id: 's' + (total - 1 - i), cwd: 'C:\\x', createdAt: 0 }))
    const readSessions = {}
    for (let i = 0; i < total; i++) readSessions['s' + i] = [userMessageEvent('输入' + i, 1000 + i)]
    const { handlers, readCounts } = makeCtx({ archivedIds: [], headers, agents: new Map(), readSessions })
    // 触发对齐(请求工作区),等队列排空后窗口外老会话(s0..s19)不得被解压
    await requestUntil(handlers, '?sessionId=s' + (total - 1) + '&scope=workspace',
      (body) => body.aligned && body.inputs.length > 0)
    assert.equal(readCounts.get('s0'), undefined, '窗口外最老会话不被启动对齐解压')
    assert.ok(readCounts.get('s' + (total - 1)) >= 1, '窗口内最新会话被解压')
  })
})
