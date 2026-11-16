// 路由层 BDD(mock ctx 强制 cordis 注入语义):宿主上下文上任何未声明 inject 的
// 服务属性访问一律抛 cannot get property ... without inject,与 cordis reflect 行为
// 一致,防止 inject 声明缺失回归。peer 依赖未安装的仓库环境(禁止 install)下整文件跳过。

import test, { mock } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtemp, writeFile, utimes, mkdir, rm, readFile, access } from 'node:fs/promises'
import { mkdtempSync, rmSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import path from 'node:path'
import * as nodeZlib from 'node:zlib'

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
const { DELETE_MESSAGES, DEFAULT_AUTO_ARCHIVE_DAYS, DEFAULT_AUTO_ARCHIVE_INTERVAL_HOURS, UNARCHIVE_GRACE_MS } = await import('../src/core.mjs').catch(() => ({ DELETE_MESSAGES: {} }))

// 回收区目录统一隔离:删除降级路径把产物搬进该目录,防泄漏真实用户目录
const sharedQuarantineDir = mkdtempSync(path.join(tmpdir(), 'sm-quarantine-shared-'))
process.env.DSH_QUARANTINE_DIR = sharedQuarantineDir
test.after(() => {
  rmSync(sharedQuarantineDir, { recursive: true, force: true })
})
// 台账/重挂载夹具路径仅作数据,不落盘;形态与实现一致(会话目录)
const LEDGER_FIXTURE_PATH = 'C:\\store\\s1'
// 幽灵产物夹具:tmpdir 下未创建的路径,跨平台 stat 必 ENOENT
// (POSIX 对纯反斜杠 Windows 字面量取 dirname 会落回 '.',stat 成功使幽灵分支不可达)
const GHOST_DIR = path.join(tmpdir(), 'sm-ghost-fixture', 's1')
const GHOST_PATH = path.join(GHOST_DIR, 'session.jsonl.zstd')

function makeRegistry(initialIds, dispatchEvent) {
  // 真实注册表契约(0.2.1-rc.2+):archivedSessionIds 是进程内快照的 getter;
  // archiveSession 归档即入集合,unarchiveSession 串行移除(未归档 id 幂等不写),
  // 两个官方入口都写穿 state——快照与持久集由注册表自身保证一致。
  // 0.2.2-rc.3+ 在移除归档标记前派发 workspace/session-unarchiving(本桩同构,
  // 供外部恢复夹具经注册表入口复现宿主事件链)。
  const registry = {
    state: { initialized: true, workspaceIds: [], archivedSessionIds: initialIds },
    list: () => [],
    archiveCalls: [],
    unarchiveCalls: [],
    archiveSession: async (id) => {
      const sid = String(id)
      registry.archiveCalls.push(sid)
      registry.state.archivedSessionIds = [...registry.state.archivedSessionIds, sid]
    },
    unarchiveSession: async (id) => {
      const sid = String(id)
      const next = registry.state.archivedSessionIds.filter((existing) => String(existing) !== sid)
      if (next.length === registry.state.archivedSessionIds.length) return
      dispatchEvent?.('workspace/session-unarchiving', { sessionId: sid })
      registry.unarchiveCalls.push(sid)
      registry.state.archivedSessionIds = next
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
    state: { deleted: entries, unarchivedAt: 0 },
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
  settingsService: settingsServiceOverride,
  timerAvailable,
  readSessions,
  configRef,
  configEditor,
}) {
  const routes = []
  const eventHandlers = {}
  const pendingInjects = []
  const disposers = []
  const ledgerDomain = ledger === undefined ? makeLedgerDomain([]) : ledger
  const workspaceList = workspaces || []
  const settingsState = { value: settingsValue }
  const settingsService = settingsServiceOverride ?? {
    get: () => settingsState.value,
    register: () => ({ resolved: undefined }),
    // 宿主 update 为异步串行:合并进微任务队列后生效,读旧值发生在 flush 前
    update: (ns, patch) => new Promise((resolve) => queueMicrotask(() => {
      settingsState.value = { ...(settingsState.value || {}), ...patch }
      resolve()
    })),
  }
  // timer 服务桩:模拟宿主 timer 激活后的 interval;unref 保证测试进程可自然退出
  const intervalStub = (fn, ms) => {
    const timer = setInterval(fn, ms)
    timer.unref()
    return () => clearInterval(timer)
  }
  // readSession 桩:sessionId → 事件数组(工厂形态则调用后抛错);reads 记录实际读取次数供缓存断言
  // headers 支持同步或异步函数形态:每次列会话现求值,模拟宿主按产物现状动态列会话;
  // 数组形态在调用点同步快照(门闩时序测试依赖该语义,禁入 await 链)
  const readCounts = new Map()
  const sessionQuery = {
    listSessions: async () => {
      if (typeof headers !== 'function') return headers.map((header) => ({ header }))
      const list = await headers()
      return list.map((header) => ({ header }))
    },
    readSession: async (sessionId) => {
      readCounts.set(sessionId, (readCounts.get(sessionId) || 0) + 1)
      const events = readSessions ? readSessions[sessionId] : undefined
      if (typeof events === 'function') throw events()
      if (events === undefined) throw new Error('桩未配置该会话产物')
      const list = typeof headers !== 'function' ? headers : await headers()
      return { session: list.find((header) => header.id === sessionId), events }
    },
  }
  const services = {
    webServer: { register: (route) => routes.push(route) },
    workspaceRegistry: Object.assign(makeRegistry(archivedIds, (event, payload) => eventHandlers[event]?.(payload)), { list: () => workspaceList }),
    sessionQuery,
    storageDomain: {
      get: (name) => name === 'workspace' ? (domain || undefined) : undefined,
      open: openRejected ? () => Promise.reject(openRejected) : async () => ledgerDomain,
    },
  }
  const base = {
    effect: (fn) => {
      const disposer = fn()
      if (typeof disposer === 'function') disposers.push(disposer)
      return disposer
    },
    inject: (_deps, fn) => { pendingInjects.push(fn) },
    // fiber 桩:0.1.7 configure 装配以本条目 fiber 为 owner
    fiber: { entry: { options: { id: 'session-manager', name: '@mzzsfy/dsh-session-manager' } } },
    get: (name) => {
      if (name === 'configEditor') return configEditor
      return { agents, sessionPersistence, settings: settingsService }[name]
    },
    on: (event, handler) => { eventHandlers[event] = handler },
    // 日志桩:partial 降级点(logger.warn)在测试中可执行且可断言,不再被 undefined 短路
    logger: { warns: [], warn(message) { this.warns.push(message) }, infos: [], info(message) { this.infos.push(message) } },
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
  apply(ctx, configRef)
  return {
    handlers: new Map(routes.map((route) => [route.path, route.handler])),
    eventHandlers,
    domain,
    ledger: ledgerDomain,
    registry: services.workspaceRegistry,
    logger: base.logger,
    readCounts,
    // 模拟宿主插件卸载:按注册逆序释放全部 effect
    disposeAll: () => {
      while (disposers.length > 0) disposers.pop()()
    },
    // 模拟宿主 settings 与 timer 服务激活:触发 inject 回调(注册 + 启动补扫 + 周期武装)
    activateSettings: () => {
      const injected = {
        settings: settingsService,
        interval: timerAvailable === false ? undefined : intervalStub,
        // 注入上下文的 effect 桩:0.1.7 分支经它注册 configure 装配
        effect(fn) {
          const disposer = fn()
          if (typeof disposer === 'function') disposers.push(disposer)
        },
      }
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

// 写路由统一闸门要求 POST 带 JSON content-type(缺头 400),夹具默认带上
function request(sessionId, method = 'POST') {
  const req = new EventEmitter()
  req.method = method
  if (method !== 'GET') {
    req.headers = { 'content-type': 'application/json' }
    process.nextTick(() => {
      req.emit('data', Buffer.from(JSON.stringify({ sessionId })))
      req.emit('end')
    })
  }
  return req
}

// 批量路由请求体:与 request 区分(后者固定 sessionId 字段)
function requestJson(body, method = 'POST') {
  const req = new EventEmitter()
  req.method = method
  if (method !== 'GET') {
    req.headers = { 'content-type': 'application/json' }
    process.nextTick(() => {
      req.emit('data', Buffer.from(typeof body === 'string' ? body : JSON.stringify(body)))
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
  req.headers = { 'content-type': 'application/json' }
  process.nextTick(() => {
    req.emit('data', Buffer.from('{not json'))
    req.emit('end')
  })
  const res = response()
  await handlers.get('/api/session-manager/unarchive')(req, res)
  assert.equal(res.status, 400)
  assert.equal(res.body.error, '请求体不是合法 JSON')
})

// C4:超限必须回 413 且保留响应通道——旧实现 reject 后 destroy socket,413 送不出去;
// requireSessionId 的 catch-all 又把协议错误折成固定 400 文案
test('请求体超过上限:回 413 且不销毁 socket,协议状态码不被折成 400', skipMissingDeps, async () => {
  const { handlers } = makeCtx({ archivedIds: [], headers: [], agents: new Map() })
  const req = new EventEmitter()
  req.method = 'POST'
  req.headers = { 'content-type': 'application/json' }
  let destroyed = false
  let paused = false
  req.destroy = () => { destroyed = true }
  req.pause = () => { paused = true }
  const res = response()
  const done = handlers.get('/api/session-manager/info')(req, res)
  req.emit('data', Buffer.alloc(64 * 1024 + 1, 0x20))
  await done
  assert.equal(res.status, 413)
  assert.equal(destroyed, false, '销毁 socket 会让 413 响应写不出去')
  assert.equal(paused, true, '超限后暂停读取,不再堆积 chunk')
})

test('请求体中止/半开 close:按 400 结束 handler,不永久挂起', skipMissingDeps, async () => {
  const outcomes = []
  for (const interrupt of ['aborted', 'close']) {
    const { handlers } = makeCtx({ archivedIds: [], headers: [], agents: new Map() })
    const req = new EventEmitter()
    req.method = 'POST'
    req.headers = { 'content-type': 'application/json' }
    req.complete = interrupt !== 'close'
    const res = response()
    const done = handlers.get('/api/session-manager/info')(req, res)
    req.emit('data', Buffer.from('{"sessionId":"s'))
    req.emit(interrupt)
    await done
    outcomes.push(res.status)
  }
  assert.deepEqual(outcomes, [400, 400], 'aborted 与未 complete 的 close 都必须结束读取')
})

test('请求体读取超时:30s 无结束回 408', skipMissingDeps, async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const { handlers } = makeCtx({ archivedIds: [], headers: [], agents: new Map() })
  const req = new EventEmitter()
  req.method = 'POST'
  req.headers = { 'content-type': 'application/json' }
  const res = response()
  const done = handlers.get('/api/session-manager/info')(req, res)
  req.emit('data', Buffer.from('{"sessionId":"s'))
  t.mock.timers.tick(indexModule.BODY_READ_TIMEOUT_MS)
  await done
  assert.equal(res.status, 408)
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

test('取消归档路由:走官方 unarchiveSession 写穿注册表', skipMissingDeps, async () => {
  const domain = makeDomain(['s1', 's2'])
  const { handlers, registry } = makeCtx({ archivedIds: ['s1', 's2'], headers: [HEADER], agents: new Map(), domain })
  const res = response()
  await handlers.get('/api/session-manager/unarchive')(request('s1'), res)
  assert.equal(res.status, 200)
  assert.deepEqual(res.body, { ok: true })
  // 官方 API 写穿:注册表快照移除,无私有直写路径
  assert.deepEqual(registry.unarchiveCalls, ['s1'])
  assert.deepEqual(registry.state.archivedSessionIds, ['s2'])
  assert.deepEqual(registry.archivedSessionIds, ['s2'])
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

test('取消归档路由:未归档 id 幂等,注册表零写', skipMissingDeps, async () => {
  const { handlers, registry } = makeCtx({ archivedIds: ['s1'], headers: [HEADER], agents: new Map() })
  const res = response()
  await handlers.get('/api/session-manager/unarchive')(request('s9'), res)
  assert.equal(res.status, 200)
  assert.deepEqual(res.body, { ok: true })
  assert.deepEqual(registry.unarchiveCalls, [])
  assert.deepEqual(registry.state.archivedSessionIds, ['s1'])
})

test('取消归档宽限:恢复后 graceMs 内同进程评估暂停,不秒归档', skipMissingDeps, async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'sm-grace-'))
  try {
    const artifact = path.join(dir, 's1.jsonl')
    await writeFile(artifact, '{"header":1}\n{"event":0}\n')
    const DAY_MS = 24 * 60 * 60 * 1000
    const stale = Date.now() - 30 * DAY_MS
    await utimes(artifact, stale / 1000, stale / 1000)
    const headers = [{ id: 's1', cwd: 'C:\\x', createdAt: stale }]
    const ctxBundle = makeCtx({
      archivedIds: [],
      headers,
      agents: new Map(),
      sessionPersistence: { locate: () => ({ path: artifact }) },
      domain: makeDomain([]),
    })
    const { activateSettings, registry, handlers, eventHandlers } = ctxBundle
    activateSettings()
    await waitFor(() => registry.archiveCalls.length > 0)
    assert.deepEqual(registry.archiveCalls, ['s1'])
    // 手动恢复:归档集合移除 + 进程内宽限生效
    const res = response()
    await handlers.get('/api/session-manager/unarchive')(request('s1'), res)
    assert.equal(res.status, 200)
    assert.deepEqual(registry.state.archivedSessionIds, [])
    // 宽限内经新会话创建触发评估:同产物仍超期,但不再归档
    eventHandlers['session/created']({ header: { cwd: 'C:\\x' } })
    await new Promise((resolve) => setTimeout(resolve, 80))
    assert.deepEqual(registry.archiveCalls, ['s1'], '宽限期内不得重新归档')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

// Given 外部恢复走官方注册表入口(不经插件路由), 宿主在移除归档标记前派发
// workspace/session-unarchiving, When 恢复后同轮评估, Then 同样记宽限不秒归档
test('取消归档宽限:宿主外部恢复事件也记账(不经插件路由)', skipMissingDeps, async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'sm-grace-host-'))
  try {
    const artifact = path.join(dir, 's1.jsonl')
    await writeFile(artifact, '{"header":1}\n{"event":0}\n')
    const DAY_MS = 24 * 60 * 60 * 1000
    const stale = Date.now() - 30 * DAY_MS
    await utimes(artifact, stale / 1000, stale / 1000)
    const headers = [{ id: 's1', cwd: 'C:\\x', createdAt: stale }]
    const { activateSettings, registry, eventHandlers } = makeCtx({
      archivedIds: [],
      headers,
      agents: new Map(),
      sessionPersistence: { locate: () => ({ path: artifact }) },
      domain: makeDomain([]),
    })
    activateSettings()
    await waitFor(() => registry.archiveCalls.length > 0)
    assert.deepEqual(registry.archiveCalls, ['s1'])
    assert.equal(typeof eventHandlers['workspace/session-unarchiving'], 'function', '必须订阅宿主取消归档事件')
    // 等首轮评估门闩复位,避免后续触发被在途评估吞掉造成空断言
    await new Promise((resolve) => setTimeout(resolve, 60))
    // 外部恢复:直接走官方注册表入口,不经过 /api/session-manager/unarchive;
    // 注册表桩按宿主 0.2.2 语义先派发 workspace/session-unarchiving 再移除标记
    await registry.unarchiveSession('s1')
    assert.deepEqual(registry.state.archivedSessionIds, [])
    eventHandlers['session/created']({ header: { cwd: 'C:\\x' } })
    await new Promise((resolve) => setTimeout(resolve, 80))
    assert.deepEqual(registry.archiveCalls, ['s1'], '外部恢复同样受宽限保护,不得秒归档')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

// Given 自动归档后的会话经删除清理路径 unarchive, When 同轮评估再次触发,
// Then 清理不得写宽限(宽限只服务用户恢复),超期产物照常重新归档
test('删除清理触发的 unarchive 不写宽限:删除后评估照常归档', skipMissingDeps, async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'sm-grace-cleanup-'))
  try {
    const artifact = path.join(dir, 's1.jsonl')
    await writeFile(artifact, '{"header":1}\n{"event":0}\n')
    const stale = Date.now() - 30 * 24 * 60 * 60 * 1000
    await utimes(artifact, stale / 1000, stale / 1000)
    const headers = [{ id: 's1', cwd: 'C:\\x', createdAt: stale }]
    const { activateSettings, registry, eventHandlers, handlers } = makeCtx({
      archivedIds: [],
      headers,
      agents: new Map(),
      sessionPersistence: { locate: () => ({ path: artifact }) },
      domain: makeDomain([]),
    })
    activateSettings()
    await waitFor(() => registry.archiveCalls.length > 0)
    assert.deepEqual(registry.archiveCalls, ['s1'])
    // 等首轮评估门闩复位,避免后续触发被在途评估吞掉造成空断言
    await new Promise((resolve) => setTimeout(resolve, 60))
    // 删除清理:trash 桩不移动产物,保留可再次评估的产物;清理的 unarchive 不得记宽限
    const res = response()
    await withTrashStub(async () => {}, async () => {
      await handlers.get('/api/session-manager/delete')(request('s1'), res)
    })
    assert.equal(res.status, 200)
    assert.deepEqual(registry.state.archivedSessionIds, [])
    eventHandlers['session/created']({ header: { cwd: 'C:\\x' } })
    await waitFor(() => registry.archiveCalls.length > 1)
    assert.deepEqual(registry.archiveCalls, ['s1', 's1'], '删除清理不得留下宽限')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

// Given 无 workspace/session-unarchiving 事件的旧宿主上原生恢复只移除归档集合,
// When 下一轮评估开始, Then 对比上一轮集合补记宽限,不把刚恢复的会话秒归档
test('取消归档宽限:无事件宿主按归档集合移除补记', skipMissingDeps, async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'sm-grace-diff-'))
  try {
    const artifact = path.join(dir, 's1.jsonl')
    await writeFile(artifact, '{"header":1}\n{"event":0}\n')
    const stale = Date.now() - 30 * 24 * 60 * 60 * 1000
    await utimes(artifact, stale / 1000, stale / 1000)
    const headers = [{ id: 's1', cwd: 'C:\\x', createdAt: stale }]
    const { activateSettings, registry, eventHandlers } = makeCtx({
      archivedIds: [],
      headers,
      agents: new Map(),
      sessionPersistence: { locate: () => ({ path: artifact }) },
      domain: makeDomain([]),
    })
    activateSettings()
    await waitFor(() => registry.archiveCalls.length > 0)
    assert.deepEqual(registry.archiveCalls, ['s1'])
    // 等首轮评估门闩复位并完成基线刷新
    await new Promise((resolve) => setTimeout(resolve, 60))
    // 旧宿主原生恢复:直接改变归档集合,不派发 workspace/session-unarchiving
    registry.state.archivedSessionIds = []
    eventHandlers['session/created']({ header: { cwd: 'C:\\x' } })
    await new Promise((resolve) => setTimeout(resolve, 80))
    assert.deepEqual(registry.archiveCalls, ['s1'], '无事件宿主也必须补记宽限,不得秒归档')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
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
    sessionPersistence: { locate: (header) => header.id === 's1' ? { path: GHOST_PATH } : undefined },
  })
  const res = response()
  await handlers.get('/api/session-manager/info')(request('s1'), res)
  assert.equal(res.status, 200)
  assert.deepEqual(res.body, { supported: true, sizeBytes: 0, missing: true })
})

test('sizes 路由:批量返回产物大小,缺失与 locate 缺失按标记返回,重复 id 去重', skipMissingDeps, async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'sm-sizes-'))
  const presentPath = path.join(dir, 'session.jsonl.zstd')
  await writeFile(presentPath, 'log-bytes')
  try {
    const { handlers } = makeCtx({
      archivedIds: [],
      headers: [
        { id: 's1', cwd: 'C:\\x', createdAt: 0 },
        { id: 's2', cwd: 'C:\\x', createdAt: 0 },
        { id: 's3', cwd: 'C:\\x', createdAt: 0 },
      ],
      agents: new Map(),
      sessionPersistence: {
        locate: (header) => header.id === 's1'
          ? { path: presentPath }
          : header.id === 's2' ? { path: GHOST_PATH } : undefined,
      },
    })
    const res = response()
    await handlers.get('/api/session-manager/sizes')(requestJson({ sessionIds: ['s1', 's2', 's3', 'unknown', 's1'] }), res)
    assert.equal(res.status, 200)
    assert.deepEqual(res.body.sizes, {
      s1: { supported: true, sizeBytes: Buffer.byteLength('log-bytes') },
      s2: { supported: true, sizeBytes: 0, missing: true },
      s3: { supported: false },
      unknown: { supported: false },
    })
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('sizes 路由:单个会话 locate 抛错不拖垮整批', skipMissingDeps, async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'sm-sizes-err-'))
  const presentPath = path.join(dir, 'session.jsonl.zstd')
  await writeFile(presentPath, 'ok')
  try {
    const { handlers, logger } = makeCtx({
      archivedIds: [],
      headers: [
        { id: 's1', cwd: 'C:\\x', createdAt: 0 },
        { id: 's2', cwd: 'C:\\x', createdAt: 0 },
      ],
      agents: new Map(),
      sessionPersistence: {
        locate: (header) => {
          if (header.id === 's1') throw new Error('后端故障')
          return { path: presentPath }
        },
      },
    })
    const res = response()
    await handlers.get('/api/session-manager/sizes')(requestJson({ sessionIds: ['s1', 's2'] }), res)
    assert.equal(res.status, 200)
    assert.deepEqual(res.body.sizes, {
      s1: { supported: false },
      s2: { supported: true, sizeBytes: 2 },
    })
    assert.ok(logger.warns.some((message) => message.includes('s1')), '单条失败应落服务端日志')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('sizes 路由:sessionIds 缺失、非数组或空集拒绝', skipMissingDeps, async () => {
  const { handlers } = makeCtx({ archivedIds: [], headers: [], agents: new Map() })
  for (const body of [{}, { sessionIds: 's1' }, { sessionIds: [] }, { sessionIds: ['', '  '] }]) {
    const res = response()
    await handlers.get('/api/session-manager/sizes')(requestJson(body), res)
    assert.equal(res.status, 400, JSON.stringify(body))
    assert.match(res.body.error, /sessionIds/)
  }
})

test('sizes 路由:超过批量上限拒绝', skipMissingDeps, async () => {
  const { handlers } = makeCtx({ archivedIds: [], headers: [], agents: new Map() })
  const ids = Array.from({ length: indexModule.SIZES_MAX_IDS + 1 }, (_, index) => 's' + index)
  const res = response()
  await handlers.get('/api/session-manager/sizes')(requestJson({ sessionIds: ids }), res)
  assert.equal(res.status, 400)
  assert.match(res.body.error, new RegExp(String(indexModule.SIZES_MAX_IDS)))
})

test('sizes 路由:非 POST 方法拒绝', skipMissingDeps, async () => {
  const { handlers } = makeCtx({ archivedIds: [], headers: [], agents: new Map() })
  const res = response()
  await handlers.get('/api/session-manager/sizes')(requestJson({ sessionIds: ['s1'] }, 'GET'), res)
  assert.equal(res.status, 405)
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
  const { eventHandlers, registry, logger } = makeCtx({
    archivedIds: [],
    headers,
    agents: new Map(),
    sessionPersistence,
  })
  eventHandlers['session/created']({ header: { id: 'trigger', cwd } })
  await waitFor(() => registry.archiveCalls.length > 0)
  // s2 产物缺失必须被守卫跳过:否则已删除会话会被重新归档而在面板复活
  assert.deepEqual(registry.archiveCalls, ['s1'])
  // 归档成功须落可追溯日志(含会话 id)
  await waitFor(() => logger.infos.length > 0)
  assert.ok(logger.infos.some((message) => message.includes('s1')), '归档成功应落 info 日志')
})

// C3:宿主 0.2.x 产物为 zstd 压缩 JSONL;按原始字节数换行会在压缩数据里随机命中,
// 把「仅 header 一行」的空白会话误判成非空白而错归档。夹具构造压缩字节中确实含
// 两个 0x0A 的 header-only 产物:旧探测必判非空白,解压后按行判定才是空白
test('自动归档评估:zstd 产物按解压文本判空白,压缩字节含换行也不误归档', {
  skip: dependencyReady
    ? (typeof nodeZlib.zstdCompressSync === 'function' ? false : '本机 Node 无 zstd 能力(>=22.15)')
    : 'peer 依赖未安装,路由层测试跳过',
}, async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'sm-eval-zstd-blank-'))
  try {
    const header = { header: 1, id: 'blank' }
    let frame
    // 确定性搜索:同一行文本加不同长度填充,直到压缩结果前 64KiB 内含 >=2 个换行
    for (let pad = 0; pad < 256; pad += 1) {
      const candidate = nodeZlib.zstdCompressSync(Buffer.from(JSON.stringify({ ...header, pad: 'x'.repeat(pad) }) + '\n'))
      let breaks = 0
      for (const byte of candidate) if (byte === 0x0a) breaks += 1
      if (breaks >= 2) { frame = candidate; break }
    }
    assert.ok(frame, '未能构造含两个换行的 header-only zstd 产物')
    const blankPath = path.join(dir, 'blank.jsonl.zstd')
    await writeFile(blankPath, frame)
    // 阳性对照:header + 一条事件(两行),同一探测路径必须归档
    const plainPath = path.join(dir, 'plain.jsonl.zstd')
    await writeFile(plainPath, Buffer.concat([
      nodeZlib.zstdCompressSync(Buffer.from('{"header":1,"id":"plain"}\n')),
      nodeZlib.zstdCompressSync(Buffer.from('{"event":0}\n')),
    ]))
    const DAY_MS = 24 * 60 * 60 * 1000
    const stale = Date.now() - 30 * DAY_MS
    await utimes(blankPath, stale / 1000, stale / 1000)
    await utimes(plainPath, stale / 1000, stale / 1000)
    const cwd = 'C:\\x'
    const { eventHandlers, registry } = makeCtx({
      archivedIds: [],
      headers: [
        { id: 's1', cwd, createdAt: stale },
        { id: 's2', cwd, createdAt: stale },
      ],
      agents: new Map(),
      sessionPersistence: {
        locate: (header) => ({ path: header.id === 's1' ? blankPath : plainPath }),
      },
    })
    eventHandlers['session/created']({ header: { id: 'trigger', cwd } })
    await waitFor(() => registry.archiveCalls.length > 0)
    assert.deepEqual(registry.archiveCalls, ['s2'], '空白会话跳过,两行产物正常归档')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

// C3 兜底:zstd 帧损坏/运行时无解压能力时按事件数判定,不得回退到原始字节数换行
test('自动归档评估:zstd 解压失败退回事件数判定空白', {
  skip: dependencyReady
    ? (typeof nodeZlib.zstdCompressSync === 'function' ? false : '本机 Node 无 zstd 能力(>=22.15)')
    : 'peer 依赖未安装,路由层测试跳过',
}, async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'sm-eval-zstd-fallback-'))
  try {
    const brokenPath = path.join(dir, 'broken.jsonl.zstd')
    // 合法魔数 + 非法帧体:解压必失败,走 readSession 的事件数
    await writeFile(brokenPath, Buffer.concat([
      Buffer.from([0x28, 0xb5, 0x2f, 0xfd]),
      Buffer.from('not-a-zstd-frame-with-\n\nnewlines'),
    ]))
    const DAY_MS = 24 * 60 * 60 * 1000
    const stale = Date.now() - 30 * DAY_MS
    await utimes(brokenPath, stale / 1000, stale / 1000)
    const cwd = 'C:\\x'
    const { eventHandlers, registry } = makeCtx({
      archivedIds: [],
      headers: [
        { id: 's1', cwd, createdAt: stale },
        { id: 's2', cwd, createdAt: stale },
      ],
      agents: new Map(),
      sessionPersistence: { locate: () => ({ path: brokenPath }) },
      readSessions: { s1: [], s2: [{ type: 'turn/start' }, { type: 'turn/end' }] },
    })
    eventHandlers['session/created']({ header: { id: 'trigger', cwd } })
    await waitFor(() => registry.archiveCalls.length > 0)
    assert.deepEqual(registry.archiveCalls, ['s2'], '事件数为 0 按空白跳过,非空会话正常归档')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
// F1:旧代产物(migration-required)的真实文件是历史代路径,私有 locate 按当前代
// 拼出的路径不存在。公共 stat()/list() 快照的 location 指向真实历史文件,info/
// sizes/自动归档都必须以快照为真源,否则整类旧会话永不归档且面板误报产物缺失
test('旧代产物:migration-required 快照指向历史文件,自动归档与 info/sizes 不误报缺失', skipMissingDeps, async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'sm-oldgen-'))
  try {
    const oldPath = path.join(dir, 's1.session.v3.jsonl')
    const oldBody = '{"header":1}\n{"event":0}\n'
    await writeFile(oldPath, oldBody)
    const DAY_MS = 24 * 60 * 60 * 1000
    const stale = Date.now() - 30 * DAY_MS
    await utimes(oldPath, stale / 1000, stale / 1000)
    const bogusPath = path.join(dir, 's1.session.v4.jsonl.zstd')
    let locateCalls = 0
    const snapshot = {
      header: HEADER,
      formatStatus: 'migration-required',
      revision: 'rev-old',
      sizeBytes: Buffer.byteLength(oldBody),
      location: { kind: 'jsonl', path: oldPath },
    }
    const sessionPersistence = {
      stat: async (id) => String(id) === 's1' ? snapshot : undefined,
      list: async () => [snapshot],
      locate: () => { locateCalls += 1; return { kind: 'jsonl', path: bogusPath } },
    }
    const { handlers, eventHandlers, registry } = makeCtx({
      archivedIds: [],
      headers: [HEADER],
      agents: new Map(),
      sessionPersistence,
    })
    const info = response()
    await handlers.get('/api/session-manager/info')(request('s1'), info)
    assert.deepEqual(info.body, { supported: true, sizeBytes: Buffer.byteLength(oldBody) }, 'info 必须报告历史文件大小,不得误报 missing')
    const sizes = response()
    await handlers.get('/api/session-manager/sizes')(requestJson({ sessionIds: ['s1'] }), sizes)
    assert.deepEqual(sizes.body.sizes.s1, { supported: true, sizeBytes: Buffer.byteLength(oldBody) })
    eventHandlers['session/created']({ header: { id: 'trigger', cwd: 'C:\\x' } })
    await waitFor(() => registry.archiveCalls.length > 0)
    assert.deepEqual(registry.archiveCalls, ['s1'], '旧代产物超期必须照常归档')
    assert.equal(locateCalls, 0, '公共 stat/list 可用时不得调用私有 locate')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

// F1 list 兜底:旧宿主没有 stat 时,公共 list 快照仍需支撑 info/sizes/自动归档
test('旧代产物:后端仅提供公共 list 快照时,info/sizes 与自动归档仍走快照', skipMissingDeps, async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'sm-oldgen-list-'))
  try {
    const oldPath = path.join(dir, 's1.session.v3.jsonl')
    const oldBody = '{"header":1}\n{"event":0}\n'
    await writeFile(oldPath, oldBody)
    const DAY_MS = 24 * 60 * 60 * 1000
    const stale = Date.now() - 30 * DAY_MS
    await utimes(oldPath, stale / 1000, stale / 1000)
    const snapshot = {
      header: HEADER,
      formatStatus: 'migration-required',
      revision: 'rev-old-list',
      sizeBytes: Buffer.byteLength(oldBody),
      location: { kind: 'jsonl', path: oldPath },
    }
    const { handlers, eventHandlers, registry } = makeCtx({
      archivedIds: [],
      headers: [HEADER],
      agents: new Map(),
      sessionPersistence: { list: async () => [snapshot] },
    })
    const info = response()
    await handlers.get('/api/session-manager/info')(request('s1'), info)
    assert.deepEqual(info.body, { supported: true, sizeBytes: Buffer.byteLength(oldBody) })
    const sizes = response()
    await handlers.get('/api/session-manager/sizes')(requestJson({ sessionIds: ['s1'] }), sizes)
    assert.deepEqual(sizes.body.sizes.s1, { supported: true, sizeBytes: Buffer.byteLength(oldBody) })
    eventHandlers['session/created']({ header: { id: 'trigger', cwd: 'C:\\x' } })
    await waitFor(() => registry.archiveCalls.length > 0)
    assert.deepEqual(registry.archiveCalls, ['s1'])
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

// F2:一个会话的后端探测异常不得 abort 整轮评估,否则同批健康会话也永不归档
test('自动归档评估:单会话 stat 抛错只跳过该会话,健康会话照常归档', skipMissingDeps, async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'sm-eval-isolate-'))
  try {
    const goodPath = path.join(dir, 's2.session.v4.jsonl')
    const goodBody = '{"header":1}\n{"event":0}\n'
    await writeFile(goodPath, goodBody)
    const DAY_MS = 24 * 60 * 60 * 1000
    const stale = Date.now() - 30 * DAY_MS
    await utimes(goodPath, stale / 1000, stale / 1000)
    const cwd = 'C:\\x'
    const headers = [
      { id: 's1', cwd, createdAt: stale },
      { id: 's2', cwd, createdAt: stale },
    ]
    const sessionPersistence = {
      stat: async (id) => {
        if (String(id) === 's1') throw new Error('stat boom')
        return {
          header: headers[1],
          revision: 'rev-good',
          sizeBytes: Buffer.byteLength(goodBody),
          location: { kind: 'jsonl', path: goodPath },
        }
      },
    }
    const { eventHandlers, registry, logger } = makeCtx({
      archivedIds: [],
      headers,
      agents: new Map(),
      sessionPersistence,
    })
    eventHandlers['session/created']({ header: { id: 'trigger', cwd } })
    await waitFor(() => registry.archiveCalls.length > 0)
    assert.deepEqual(registry.archiveCalls, ['s2'], '坏会话不得拖垮健康会话')
    assert.ok(logger.warns.some((line) => line.includes('s1') && line.includes('stat boom')), '逐会话失败必须落 warn')
    assert.ok(logger.warns.some((line) => line.includes('1 个会话探测失败已跳过')), '轮末必须有失败计数汇总')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
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

test('自动归档评估:subagent 内部会话不参与归档(官方主列表不收录 subagent)', skipMissingDeps, async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'sm-eval-subagent-'))
  try {
    const plainPath = path.join(dir, 'plain.jsonl')
    const childPath = path.join(dir, 'child.jsonl')
    await writeFile(plainPath, '{"header":1}\n{"event":0}\n')
    await writeFile(childPath, '{"header":1}\n{"event":0}\n')
    const DAY_MS = 24 * 60 * 60 * 1000
    const stale = Date.now() - 30 * DAY_MS
    await utimes(plainPath, stale / 1000, stale / 1000)
    await utimes(childPath, stale / 1000, stale / 1000)
    const cwd = 'C:\\x'
    const headers = [
      { id: 'plain', cwd, createdAt: stale },
      { id: 'child', cwd, createdAt: stale, origin: 'subagent', parentSession: 'parent' },
    ]
    const { eventHandlers, registry } = makeCtx({
      archivedIds: [],
      headers,
      agents: new Map(),
      sessionPersistence: {
        locate: (header) => ({ path: header.id === 'plain' ? plainPath : childPath }),
      },
    })
    eventHandlers['session/created']({ header: { id: 'trigger', cwd } })
    await waitFor(() => registry.archiveCalls.length > 0)
    assert.deepEqual(registry.archiveCalls, ['plain'], 'subagent 会话永不入选归档')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('启动自愈:归档集合中的子会话 id 经官方 unarchiveSession 清理,根会话保留', skipMissingDeps, async () => {
  const headers = [
    { id: 'root', cwd: 'C:\\x', createdAt: 0 },
    { id: 'child', cwd: 'C:\\x', createdAt: 0, origin: 'subagent', parentSession: 'root', delegationDepth: 1 },
    { id: 'legacy', cwd: 'C:\\x', createdAt: 0, parentSession: 'root', delegationDepth: 1 },
    { id: 'gone', cwd: 'C:\\x', createdAt: 0 },
  ]
  const { activateSettings, registry } = makeCtx({
    archivedIds: ['root', 'child', 'legacy', 'gone', 'missing-header'],
    headers,
    agents: new Map(),
    settingsValue: { autoArchiveDays: 0, autoArchiveIntervalHours: 0 },
  })
  activateSettings()
  await waitFor(() => registry.unarchiveCalls.length >= 2)
  assert.deepEqual(registry.unarchiveCalls, ['child', 'legacy'], '只清理可识别为派生的 id,已删除/未知 id 不主动写')
  assert.deepEqual(registry.archivedSessionIds, ['root', 'gone', 'missing-header'])
})

test('0.2.2 形态:settings 无 register 时启动自愈与全量补扫仍执行', skipMissingDeps, async () => {
  const DAY_MS = 24 * 60 * 60 * 1000
  const stale = Date.now() - 30 * DAY_MS
  const dir = await mkdtemp(path.join(tmpdir(), 'sm-no-register-'))
  try {
    const artifact = path.join(dir, 'stale.jsonl')
    await writeFile(artifact, '{"header":1}\n{"event":0}\n')
    await utimes(artifact, stale / 1000, stale / 1000)
    const headers = [
      { id: 'stale', cwd: 'C:\\x', createdAt: stale },
      { id: 'child', cwd: 'C:\\x', createdAt: 0, origin: 'subagent', parentSession: 'root', delegationDepth: 1 },
    ]
    const { activateSettings, registry } = makeCtx({
      settingsServiceOverride: { configure: () => ({ dispose() {} }) },
      archivedIds: ['child'],
      headers,
      agents: new Map(),
      sessionPersistence: { locate: () => ({ path: artifact }) },
    })
    activateSettings()
    await waitFor(() => registry.archiveCalls.length > 0 && registry.unarchiveCalls.length > 0)
    assert.deepEqual(registry.unarchiveCalls, ['child'], '现役宿主无 register 时也必须执行归档集合自愈')
    assert.deepEqual(registry.archiveCalls, ['stale'], '现役宿主无 register 时也必须执行启动补扫')
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

test('settings 方法面缺失(0.1.7 SettingsForms 形态):tick 与 status 路由不抛错,配置回落默认', skipMissingDeps, async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'sm-methodface-'))
  // 宿主 0.1.7-alpha.1 将 settings 服务换形为 SettingsForms:缺 get/register,仅剩 update。
  // 旧形态直接 settings.get 会在 timer 回调抛 TypeError 崩进程(实测事故),守卫后应回落默认值
  const DAY_MS = 24 * 60 * 60 * 1000
  const TICK_MS = 60 * 1000
  mock.timers.enable({ apis: ['setInterval', 'Date'], now: Date.now() })
  try {
    const artifact = path.join(dir, 'a.jsonl')
    await writeFile(artifact, '{"header":1}\n{"event":0}\n')
    const stale = Date.now() - 30 * DAY_MS
    await utimes(artifact, stale / 1000, stale / 1000)
    const settingsForms = { update: async () => {} }
    const { activateSettings, handlers, registry } = makeCtx({
      archivedIds: [],
      headers: [{ id: 'a', cwd: 'C:\\x', createdAt: stale }],
      agents: new Map(),
      settingsService: settingsForms,
      sessionPersistence: { locate: () => ({ path: artifact }) },
    })
    activateSettings()
    // 守卫生效:配置读不到回落默认(days=7,intervalHours=24),30 天超期夹具到期即按默认轮归档
    mock.timers.tick(DAY_MS + TICK_MS)
    await waitFor(() => registry.archiveCalls.includes('a'))
    assert.deepEqual(registry.archiveCalls, ['a'], '配置缺失按默认间隔正常评估,不因服务形变停摆')
    // status 路由读设置不抛:回默认 days/intervalHours
    const statusHandler = handlers.get('/api/session-manager/status')
    const res = response()
    await statusHandler(request('s1', 'GET'), res)
    assert.equal(res.status, 200)
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

// Given 评估在 listSessions 挂起, When 插件卸载后宿主服务才返回,
// Then 旧代 await 后自检失败,不得继续 archiveSession
test('自动归档评估:卸载中止在途批次,await 后不再归档', skipMissingDeps, async () => {
  const artifact = await makeLocatedArtifact()
  const DAY_MS = 24 * 60 * 60 * 1000
  try {
    const stale = Date.now() - 30 * DAY_MS
    await writeFile(artifact.locatedPath, '{"header":1}\n{"event":0}\n')
    await utimes(artifact.locatedPath, stale / 1000, stale / 1000)
    const header = { id: 's1', cwd: 'C:\\x', createdAt: stale }
    let releaseScan
    const gate = new Promise((resolve) => { releaseScan = resolve })
    let scans = 0
    const headers = async () => {
      scans += 1
      if (scans === 1) await gate
      return [header]
    }
    const bundle = makeCtx({
      archivedIds: [],
      headers,
      agents: new Map(),
      sessionPersistence: { locate: () => ({ path: artifact.locatedPath }) },
      domain: makeDomain([]),
    })
    bundle.eventHandlers['session/created']({ header: { cwd: 'C:\\x' } })
    await waitFor(() => scans === 1)
    bundle.disposeAll()
    releaseScan()
    await new Promise((resolve) => setTimeout(resolve, 40))
    assert.deepEqual(bundle.registry.archiveCalls, [], '卸载后旧代不得归档')
  } finally {
    await artifact.cleanup()
  }
})

// Given 评估在 listSessions 挂起且超过超时阈值, When 宿主服务随后返回,
// Then 超时批次不归档,门闩等待 work 收尾后才允许下一轮
test('自动归档评估:超时不提前释放门闩,旧批次收尾后不再归档', skipMissingDeps, async () => {
  const previousTimeout = indexModule.evaluationRuntime.timeoutMs
  const artifact = await makeLocatedArtifact()
  const DAY_MS = 24 * 60 * 60 * 1000
  try {
    indexModule.evaluationRuntime.timeoutMs = 50
    const stale = Date.now() - 30 * DAY_MS
    await writeFile(artifact.locatedPath, '{"header":1}\n{"event":0}\n')
    await utimes(artifact.locatedPath, stale / 1000, stale / 1000)
    const header = { id: 's1', cwd: 'C:\\x', createdAt: stale }
    let releaseScan
    const gate = new Promise((resolve) => { releaseScan = resolve })
    let scans = 0
    const headers = async () => {
      scans += 1
      if (scans === 1) await gate
      return [header]
    }
    const bundle = makeCtx({
      archivedIds: [],
      headers,
      agents: new Map(),
      sessionPersistence: { locate: () => ({ path: artifact.locatedPath }) },
      domain: makeDomain([]),
    })
    bundle.eventHandlers['session/created']({ header: { cwd: 'C:\\x' } })
    await waitFor(() => scans === 1)
    await new Promise((resolve) => setTimeout(resolve, 60))
    assert.ok(bundle.logger.warns.some((message) => message.includes('自动归档评估超时')), '超时必须落日志')
    // 超时后再次触发:门闩仍被旧 work 占用,不得重入并开始第二批扫描
    bundle.eventHandlers['session/created']({ header: { cwd: 'C:\\x' } })
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal(scans, 1, '门闩未收尾前不得重入评估')
    releaseScan()
    await new Promise((resolve) => setTimeout(resolve, 40))
    assert.deepEqual(bundle.registry.archiveCalls, [], '超时旧批次不得继续归档')
    // 旧 work 收尾后门闩释放,下一轮才能正常评估并归档
    indexModule.evaluationRuntime.timeoutMs = previousTimeout
    bundle.eventHandlers['session/created']({ header: { cwd: 'C:\\x' } })
    await waitFor(() => bundle.registry.archiveCalls.includes('s1'))
  } finally {
    indexModule.evaluationRuntime.timeoutMs = previousTimeout
    await artifact.cleanup()
  }
})

// Given 宿主 listSessions 永不落定, When 超时软中止后再过一档硬上界,
// Then 作废旧代释放门闩,下一轮可启动且旧代不得归档
test('自动归档评估:宿主永不落定后硬上界释放门闩', skipMissingDeps, async () => {
  const previousTimeout = indexModule.evaluationRuntime.timeoutMs
  try {
    indexModule.evaluationRuntime.timeoutMs = 20
    let scans = 0
    let releaseFirst
    let releaseSecond
    const firstGate = new Promise((resolve) => { releaseFirst = resolve })
    const secondGate = new Promise((resolve) => { releaseSecond = resolve })
    const headers = async () => {
      const call = ++scans
      if (call === 1) await firstGate
      if (call === 2) await secondGate
      return []
    }
    const bundle = makeCtx({
      archivedIds: [],
      headers,
      agents: new Map(),
      domain: makeDomain([]),
    })
    bundle.eventHandlers['session/created']({ header: { cwd: 'C:\\x' } })
    await waitFor(() => scans === 1)
    await new Promise((resolve) => setTimeout(resolve, 70))
    assert.ok(bundle.logger.warns.some((message) => message.includes('硬上界')), '硬上界必须落日志')
    // 旧 work 仍挂起,但门闩已被硬上界释放:下一轮可以启动并占住门闩
    bundle.eventHandlers['session/created']({ header: { cwd: 'C:\\x' } })
    await waitFor(() => scans === 2)
    // 释放旧 work:旧代 current() 恒假,不得归档,也不得清掉新代门闩
    releaseFirst()
    await new Promise((resolve) => setTimeout(resolve, 20))
    bundle.eventHandlers['session/created']({ header: { cwd: 'C:\\x' } })
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal(scans, 2, '旧代 finally 不得清掉新代门闩')
    releaseSecond()
    await new Promise((resolve) => setTimeout(resolve, 30))
    assert.deepEqual(bundle.registry.archiveCalls, [], '旧代不得归档,下一轮无可归档项')
  } finally {
    indexModule.evaluationRuntime.timeoutMs = previousTimeout
  }
})

// Given 硬上界已作废旧代且新代仍挂起, When 旧 work 迟到收尾并尝试触发第三代,
// Then 旧代 finally 不得清掉新代门闩,第三代仍被拦
test('自动归档评估:硬上界后旧代迟到 finally 不清新代门闩', skipMissingDeps, async () => {
  const previousTimeout = indexModule.evaluationRuntime.timeoutMs
  try {
    indexModule.evaluationRuntime.timeoutMs = 20
    const calls = []
    const gates = []
    const headers = async () => {
      const call = calls.length
      calls.push(call)
      await new Promise((resolve) => { gates.push(resolve) })
      return []
    }
    const bundle = makeCtx({
      archivedIds: [],
      headers,
      agents: new Map(),
      domain: makeDomain([]),
    })
    bundle.eventHandlers['session/created']({ header: { cwd: 'C:\\x' } })
    await waitFor(() => calls.length === 1)
    await new Promise((resolve) => setTimeout(resolve, 70))
    assert.ok(bundle.logger.warns.some((message) => message.includes('硬上界')), '硬上界必须落日志')
    // 硬上界释放后启动新代并挂起
    bundle.eventHandlers['session/created']({ header: { cwd: 'C:\\x' } })
    await waitFor(() => calls.length === 2)
    // 旧代迟到收尾:新代仍未落定,第三代触发必须仍被门闩拦住
    gates[0]()
    await new Promise((resolve) => setTimeout(resolve, 20))
    bundle.eventHandlers['session/created']({ header: { cwd: 'C:\\x' } })
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal(calls.length, 2, '旧代 finally 不得清掉新代门闩')
    gates[1]()
    await new Promise((resolve) => setTimeout(resolve, 10))
  } finally {
    indexModule.evaluationRuntime.timeoutMs = previousTimeout
  }
})

// Given 取消归档宽限刚记账, When 墙钟前跳后再评估, Then 单调时钟使宽限仍生效
test('取消归档宽限:墙钟前跳不缩短宽限', skipMissingDeps, async () => {
  const artifact = await makeLocatedArtifact()
  const DAY_MS = 24 * 60 * 60 * 1000
  const realNow = Date.now
  try {
    const stale = realNow() - 30 * DAY_MS
    await writeFile(artifact.locatedPath, '{"header":1}\n{"event":0}\n')
    await utimes(artifact.locatedPath, stale / 1000, stale / 1000)
    const header = { id: 's1', cwd: 'C:\\x', createdAt: stale }
    const bundle = makeCtx({
      archivedIds: ['s1'],
      headers: [header],
      agents: new Map(),
      sessionPersistence: { locate: () => ({ path: artifact.locatedPath }) },
      domain: makeDomain(['s1']),
    })
    await bundle.registry.unarchiveSession('s1')
    Date.now = () => realNow() + UNARCHIVE_GRACE_MS + 60 * 1000
    bundle.eventHandlers['session/created']({ header: { cwd: 'C:\\x' } })
    await new Promise((resolve) => setTimeout(resolve, 60))
    assert.deepEqual(bundle.registry.archiveCalls, [], '墙钟前跳不得缩短宽限')
  } finally {
    Date.now = realNow
    await artifact.cleanup()
  }
})

// 执行器桩替:trash 与回收区搬移为进程级 OS 副作用出口,经 executor 注册表注入
async function withExecutorStub(stubs, run) {
  const originals = {}
  for (const [name, stub] of Object.entries(stubs)) {
    originals[name] = indexModule.executor[name]
    indexModule.executor[name] = stub
  }
  try {
    await run()
  } finally {
    for (const [name, original] of Object.entries(originals)) indexModule.executor[name] = original
  }
}

async function withTrashStub(stub, run) {
  await withExecutorStub({ trashPath: stub }, run)
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
    const { handlers, ledger, registry } = makeCtx({
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
    assert.deepEqual(res.body, { ok: true, mode: 'os' })
    // locate 给的是日志文件,trash 必须上移到会话目录,否则残留空目录
    assert.deepEqual(trashed, [artifact.locatedDir])
    assert.equal(ledger.state.deleted.length, 1)
    assert.equal(ledger.state.deleted[0].sessionId, 's1')
    assert.equal(ledger.state.deleted[0].path, artifact.locatedDir)
    // 取消归档走官方 unarchiveSession:注册表快照为事实源,域不再被插件直写
    assert.deepEqual(registry.state.archivedSessionIds, [])
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
    assert.deepEqual(res.body, { ok: true, mode: 'os' })
    assert.deepEqual(ledger.state.deleted.map((item) => item.sessionId), ['s1'])
    assert.equal(ledger.state.deleted[0].path, artifact.locatedDir)
  } finally {
    await artifact.cleanup()
  }
})

// Given 系统回收站不可用(trash 抛错), When 删除, Then 产物降级搬入插件回收区,
// 台账记录暂存路径 heldPath,响应 mode=quarantine
test('删除:系统回收站不可用时降级搬入插件回收区,台账记录暂存路径', skipMissingDeps, async () => {
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
    await withExecutorStub({ trashPath: async () => { throw new Error('gio: not found') } }, async () => {
      await handlers.get('/api/session-manager/delete')(request('s1'), res)
    })
    assert.equal(res.status, 200)
    assert.equal(res.body.ok, true)
    assert.equal(res.body.mode, 'quarantine')
    const entry = ledger.state.deleted[0]
    assert.equal(entry.sessionId, 's1')
    assert.equal(entry.path, artifact.locatedDir, '台账 path 仍为原位置,移回时使用')
    assert.ok(entry.heldPath && entry.heldPath.startsWith(process.env.DSH_QUARANTINE_DIR), '台账记录回收区暂存路径')
    await assert.rejects(access(artifact.locatedDir), '原位置产物应已搬走')
    const held = await readFile(path.join(entry.heldPath, 'session.jsonl.zstd'), 'utf8')
    assert.equal(held, 'log-bytes')
  } finally {
    await artifact.cleanup()
  }
})

// Given 回收站命令不存在(execFile spawn ENOENT:{code:'ENOENT',syscall:'spawn gio'}),
// When 删除, Then 按回收站不可用降级插件回收区,不得把命令缺失当产物已消失
test('删除:回收站命令 spawn ENOENT 走回收区降级,不按产物缺失', skipMissingDeps, async () => {
  const artifact = await makeLocatedArtifact()
  try {
    const { handlers, ledger } = makeCtx({
      archivedIds: ['s1'],
      headers: [HEADER],
      agents: IDLE_S1,
      domain: makeDomain(['s1']),
      sessionPersistence: { locate: (header) => header.id === 's1' ? { path: artifact.locatedPath } : undefined },
    })
    const spawnError = Object.assign(new Error('spawn gio ENOENT'), {
      code: 'ENOENT',
      errno: -2,
      syscall: 'spawn gio',
      path: 'gio',
    })
    const res = response()
    await withTrashStub(async () => { throw spawnError }, async () => {
      await handlers.get('/api/session-manager/delete')(request('s1'), res)
    })
    assert.equal(res.status, 200)
    assert.equal(res.body.ok, true)
    assert.equal(res.body.mode, 'quarantine', '命令缺失必须降级回收区')
    const entry = ledger.state.deleted[0]
    assert.equal(entry.sessionId, 's1')
    assert.ok(entry.heldPath && entry.heldPath.startsWith(process.env.DSH_QUARANTINE_DIR), '台账记录回收区暂存路径')
    await assert.rejects(access(artifact.locatedDir), '原位置产物应已搬入回收区')
    const held = await readFile(path.join(entry.heldPath, 'session.jsonl.zstd'), 'utf8')
    assert.equal(held, 'log-bytes')
  } finally {
    await artifact.cleanup()
  }
})

// Given 回收站与回收区均不可用, When 删除, Then 400 且台账不写(会话未被删除)
test('删除:回收站与回收区均失败时拒绝且台账不写', skipMissingDeps, async () => {
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
    await withExecutorStub({
      trashPath: async () => { throw new Error('gio: not found') },
      moveToQuarantine: async () => { throw new Error('read-only volume') },
    }, async () => {
      await handlers.get('/api/session-manager/delete')(request('s1'), res)
    })
    assert.equal(res.status, 400)
    assert.ok(res.body.error.startsWith(MESSAGES.trashFailed) && res.body.error.includes('均不可用'), '双失败文案区分两级')
    assert.deepEqual(ledger.state.deleted, [])
    // 双失败产物原地保留
    await access(artifact.locatedDir)
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
    sessionPersistence: { locate: (header) => header.id === 's1' ? { path: GHOST_PATH } : undefined },
    ledger: makeLedgerDomain([{ sessionId: 's1', path: GHOST_DIR, deletedAt: 1 }]),
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

// Given 探测时目录仍在、处置时产物已消失(trash 非零退出后回收区 rename ENOENT),
// When 删除, Then 与幽灵分支同语义:不写台账,提示产物已不存在并完成列表清理
test('删除:处置期产物消失按幽灵语义收尾,不写台账不谎报已移入回收站', skipMissingDeps, async () => {
  const artifact = await makeLocatedArtifact()
  try {
    const workspace = makeWorkspace('C:\\x', ['s1'])
    const { handlers, ledger, registry } = makeCtx({
      archivedIds: ['s1'],
      headers: [HEADER],
      agents: IDLE_S1,
      domain: makeDomain(['s1']),
      sessionPersistence: { locate: (header) => header.id === 's1' ? { path: artifact.locatedPath } : undefined },
      workspaces: [workspace],
    })
    // 真实 gio 对消失目标以非零退出报告(execFile error.code 为退出码),不是 spawn ENOENT
    const trashExitError = Object.assign(new Error('gio: file not found'), { code: 1, cmd: 'gio trash ' + artifact.locatedDir })
    const renameGone = Object.assign(new Error("ENOENT: no such file or directory, rename '" + artifact.locatedDir + "'"), {
      code: 'ENOENT',
      errno: -2,
      syscall: 'rename',
      path: artifact.locatedDir,
    })
    const res = response()
    await withExecutorStub({
      trashPath: async () => { throw trashExitError },
      moveToQuarantine: async () => { throw renameGone },
    }, async () => {
      await handlers.get('/api/session-manager/delete')(request('s1'), res)
    })
    assert.equal(res.status, 200)
    assert.deepEqual(res.body, { ok: true, message: MESSAGES.ghostCleanup }, '不得带 mode 或台账成功文案')
    assert.equal(ledger.writes, 0, '无产物可还原,不写台账')
    assert.deepEqual(ledger.state.deleted, [])
    assert.deepEqual(workspace.sessionIds, [], '列表记录照常移除')
    assert.deepEqual(registry.state.archivedSessionIds, [], '归档记录照常清理')
  } finally {
    await artifact.cleanup()
  }
})

// Given 回收区 mkdir 因目标侧 ENOENT 失败(不是源路径消失),
// When 删除, Then 按回收区不可用拒绝,产物与归档/台账原样保留
test('删除:回收区 mkdir ENOENT 不按产物缺失收尾', skipMissingDeps, async () => {
  const artifact = await makeLocatedArtifact()
  try {
    const workspace = makeWorkspace('C:\\x', ['s1'])
    const { handlers, ledger, registry } = makeCtx({
      archivedIds: ['s1'],
      headers: [HEADER],
      agents: IDLE_S1,
      domain: makeDomain(['s1']),
      sessionPersistence: { locate: (header) => header.id === 's1' ? { path: artifact.locatedPath } : undefined },
      workspaces: [workspace],
    })
    const mkdirError = Object.assign(new Error("ENOENT: no such file or directory, mkdir '" + process.env.DSH_QUARANTINE_DIR + "'"), {
      code: 'ENOENT',
      errno: -2,
      syscall: 'mkdir',
      path: process.env.DSH_QUARANTINE_DIR,
    })
    const res = response()
    await withExecutorStub({
      trashPath: async () => { throw new Error('gio: not found') },
      moveToQuarantine: async () => { throw mkdirError },
    }, async () => {
      await handlers.get('/api/session-manager/delete')(request('s1'), res)
    })
    assert.equal(res.status, 400)
    assert.ok(res.body.error.startsWith(MESSAGES.trashFailed), 'mkdir 失败必须按回收区不可用处理')
    assert.equal(ledger.writes, 0, '拒绝路径不写台账')
    assert.deepEqual(workspace.sessionIds, ['s1'], '列表记录不得被摘除')
    assert.deepEqual(registry.state.archivedSessionIds, ['s1'], '归档记录不得被清理')
    await access(artifact.locatedDir)
  } finally {
    await artifact.cleanup()
  }
})

test('删除:产物缺失且无归档记录无台账时拒绝(防新建会话未落盘被剥离)', skipMissingDeps, async () => {
  const workspace = makeWorkspace('C:\\x', ['s1'])
  const { handlers } = makeCtx({
    archivedIds: [],
    headers: [HEADER],
    agents: IDLE_S1,
    domain: makeDomain([]),
    sessionPersistence: { locate: (header) => header.id === 's1' ? { path: GHOST_PATH } : undefined },
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
    sessionPersistence: { locate: (header) => header.id === 's1' ? { path: GHOST_PATH } : undefined },
  })
  const res = response()
  await withTrashStub(async () => {}, async () => {
    await handlers.get('/api/session-manager/delete')(request('s1'), res)
  })
  assert.equal(res.status, 400)
  assert.equal(res.body.error, MESSAGES.running)
})

test('删除:产物已缺失且幽灵 detach 失败时保留归档与台账', skipMissingDeps, async () => {
  const workspace = makeWorkspace('C:\\x', ['s1'], { detachError: new Error('detach boom') })
  const ledger = makeLedgerDomain([{ sessionId: 's1', path: GHOST_DIR, deletedAt: 1 }])
  const { handlers, logger, registry } = makeCtx({
    archivedIds: ['s1'],
    headers: [HEADER],
    agents: IDLE_S1,
    sessionPersistence: { locate: (header) => header.id === 's1' ? { path: GHOST_PATH } : undefined },
    ledger,
    workspaces: [workspace],
  })
  const res = response()
  await withTrashStub(async () => {}, async () => {
    await handlers.get('/api/session-manager/delete')(request('s1'), res)
  })
  assert.equal(res.status, 200)
  assert.equal(res.body.partial, true)
  assert.equal(res.body.message, MESSAGES.ghostDetach)
  // detach 失败后幽灵行仍在主列表:归档记录与台账必须保留,供重试继续清理
  assert.deepEqual(registry.state.archivedSessionIds, ['s1'])
  assert.deepEqual(ledger.state.deleted.map((item) => item.sessionId), ['s1'])
  assert.equal(ledger.writes, 0, '幽灵清理不写台账')
  // 幽灵 detach 失败:原始错误进服务端日志(排障契约),响应文案保持摘要
  assert.ok(logger.warns.some((message) => message.includes('s1') && message.includes('detach boom')), '幽灵 detach 失败应落日志')
})

test('删除:幽灵 detach 成功但归档清理失败时聚合归档失败点', skipMissingDeps, async () => {
  const workspace = makeWorkspace('C:\\x', ['s1'])
  const { handlers, logger, registry } = makeCtx({
    archivedIds: ['s1'],
    headers: [HEADER],
    agents: IDLE_S1,
    sessionPersistence: { locate: (header) => header.id === 's1' ? { path: GHOST_PATH } : undefined },
    workspaces: [workspace],
  })
  // 官方取消归档半失败:注入 unarchiveSession 抛错
  registry.unarchiveSession = async () => { throw new Error('unarchive boom') }
  const res = response()
  await withTrashStub(async () => {}, async () => {
    await handlers.get('/api/session-manager/delete')(request('s1'), res)
  })
  assert.equal(res.status, 200)
  assert.equal(res.body.partial, true)
  assert.equal(res.body.message, MESSAGES.ghostCleanup + MESSAGES.ghostArchiveSuffix)
  assert.deepEqual(workspace.sessionIds, [], 'detach 成功照常移除列表记录')
  assert.ok(logger.warns.some((message) => message.includes('s1') && message.includes('unarchive boom')), '幽灵归档清理失败应落日志')
})

// Given 回收窗口内会话恢复运行(runningDuringTrash), When 聚合, Then 警告形态且无 partial 键
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
    // 全成功警告态:{ok,message,mode} 形态,无 partial 键
    assert.deepEqual(res.body, { ok: true, mode: 'os', message: DELETE_MESSAGES.runningDuringTrash })
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

test('删除:取消归档半失败时响应 partial 且台账已记录', skipMissingDeps, async () => {
  const artifact = await makeLocatedArtifact()
  try {
    const { handlers, ledger, registry } = makeCtx({
      archivedIds: ['s1'],
      headers: [HEADER],
      agents: IDLE_S1,
      sessionPersistence: { locate: (header) => header.id === 's1' ? { path: artifact.locatedPath } : undefined },
    })
    registry.unarchiveSession = async () => { throw new Error('unarchive boom') }
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

// (旧「trash 失败整体中止」语义已被回收区降级取代:单 trash 失败见降级用例,
// 双失败中止见「回收站与回收区均失败时拒绝且台账不写」)

test('台账域打开失败:删除其余成功仍响应 partial', skipMissingDeps, async () => {
  const artifact = await makeLocatedArtifact()
  try {
    const { handlers, registry } = makeCtx({
      archivedIds: ['s1'],
      headers: [HEADER],
      agents: IDLE_S1,
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
    // 台账失败不阻断删除主链路:归档清理经官方 API 照常完成
    assert.deepEqual(registry.state.archivedSessionIds, [])
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

// Given 回收区暂存条目(heldPath)且产物在暂存处, When 重挂载, Then 先移回原位置再挂载,
// 会话列表随产物回位而可见(动态 headers 模拟宿主按产物现状列会话),台账清除
test('重挂载:回收区暂存条目自动移回原位置后挂载成功', skipMissingDeps, async () => {
  const base = await mkdtemp(path.join(tmpdir(), 'sm-held-'))
  const originalDir = path.join(base, 's1')
  const locatedPath = path.join(originalDir, 'session.jsonl.zstd')
  const workspace = makeWorkspace('C:\\x', [])
  try {
    await mkdir(originalDir, { recursive: true })
    await writeFile(locatedPath, 'log-bytes')
    const { moveToQuarantine } = await import('../src/trash.mjs')
    const heldPath = await moveToQuarantine(originalDir, path.join(base, 'held'))
    await access(originalDir).then(() => { throw new Error('夹具前置失败:原位置应已空') }, () => {})
    const { handlers, ledger } = makeCtx({
      archivedIds: [],
      // 宿主按产物现状列会话:移回前不可见,移回后可见
      headers: async () => ((await access(locatedPath).then(() => true, () => false)) ? [HEADER] : []),
      agents: new Map(),
      workspaces: [workspace],
      sessionPersistence: { locate: (header) => header.id === 's1' ? { path: locatedPath } : undefined },
      ledger: makeLedgerDomain([{ sessionId: 's1', path: originalDir, heldPath, deletedAt: 1 }]),
    })
    const res = response()
    await handlers.get('/api/session-manager/remount')(request('s1'), res)
    assert.equal(res.status, 200)
    assert.deepEqual(res.body, { ok: true })
    assert.deepEqual(workspace.attachCalls, ['s1'])
    assert.deepEqual(ledger.state.deleted, [])
    // 产物已回到原位置,暂存消失
    const restored = await readFile(locatedPath, 'utf8')
    assert.equal(restored, 'log-bytes')
    await assert.rejects(access(heldPath))
  } finally {
    await rm(base, { recursive: true, force: true })
  }
})

// Given 回收区暂存条目但暂存已缺失(原位置同样缺失), When 重挂载, Then 专属文案拒绝
test('重挂载:回收区暂存缺失时拒绝且不动台账', skipMissingDeps, async () => {
  const { handlers, ledger } = makeCtx({
    archivedIds: [],
    headers: [],
    agents: new Map(),
    ledger: makeLedgerDomain([{ sessionId: 's1', path: path.join(tmpdir(), 'sm-gone-original', 's1'), heldPath: path.join(tmpdir(), 'sm-gone-held', 's1-1'), deletedAt: 1 }]),
  })
  const res = response()
  await handlers.get('/api/session-manager/remount')(request('s1'), res)
  assert.equal(res.status, 400)
  assert.equal(res.body.error, MESSAGES.heldMissing)
  assert.equal(ledger.writes, 0)
})

// Given 回收区暂存条目且原位置产物已被手工还原, When 重挂载, Then 跳过移回直接挂载,暂存保留
test('重挂载:原位置已有产物时跳过移回(手工还原场景)', skipMissingDeps, async () => {
  const base = await mkdtemp(path.join(tmpdir(), 'sm-skip-held-'))
  const originalDir = path.join(base, 's1')
  const locatedPath = path.join(originalDir, 'session.jsonl.zstd')
  try {
    await mkdir(originalDir, { recursive: true })
    await writeFile(locatedPath, 'restored-by-hand')
    const heldPath = path.join(base, 'held', 's1-123')
    await mkdir(heldPath, { recursive: true })
    await writeFile(path.join(heldPath, 'session.jsonl.zstd'), 'held-copy')
    const workspace = makeWorkspace('C:\\x', [])
    const { handlers, ledger } = makeCtx({
      archivedIds: [],
      headers: [HEADER],
      agents: new Map(),
      workspaces: [workspace],
      sessionPersistence: { locate: (header) => header.id === 's1' ? { path: locatedPath } : undefined },
      ledger: makeLedgerDomain([{ sessionId: 's1', path: originalDir, heldPath, deletedAt: 1 }]),
    })
    const res = response()
    await handlers.get('/api/session-manager/remount')(request('s1'), res)
    assert.equal(res.status, 200)
    assert.deepEqual(res.body, { ok: true })
    assert.deepEqual(workspace.attachCalls, ['s1'])
    assert.deepEqual(ledger.state.deleted, [])
    // 原位置内容未被覆盖,暂存目录按已知取舍保留(孤儿清理不做)
    assert.equal(await readFile(locatedPath, 'utf8'), 'restored-by-hand')
    await access(heldPath)
  } finally {
    await rm(base, { recursive: true, force: true })
  }
})

// Given quarantine 降级成功但 detach 失败, When 删除, Then partial 主文案为回收区前缀且 mode=quarantine
test('删除:回收区降级加 detach 失败聚合为回收区前缀 partial', skipMissingDeps, async () => {
  const artifact = await makeLocatedArtifact()
  try {
    const workspace = makeWorkspace('C:\\x', ['s1'], { detachError: new Error('detach 失败') })
    const { handlers } = makeCtx({
      archivedIds: ['s1'],
      headers: [HEADER],
      agents: IDLE_S1,
      domain: makeDomain(['s1']),
      workspaces: [workspace],
      sessionPersistence: { locate: (header) => header.id === 's1' ? { path: artifact.locatedPath } : undefined },
    })
    const res = response()
    await withExecutorStub({ trashPath: async () => { throw new Error('gio: not found') } }, async () => {
      await handlers.get('/api/session-manager/delete')(request('s1'), res)
    })
    assert.equal(res.status, 200)
    assert.equal(res.body.partial, true)
    assert.equal(res.body.mode, 'quarantine')
    assert.ok(res.body.message.startsWith('已移入插件回收区'), 'partial 主文案为回收区前缀')
  } finally {
    await artifact.cleanup()
  }
})

// Given 台账域打开失败, When 重挂载, Then 入口即拒绝(移回依据不可得,不做静默跳过)
test('重挂载:台账域打开失败时入口拒绝', skipMissingDeps, async () => {
  const { handlers, ledger } = makeCtx({
    archivedIds: [],
    headers: [HEADER],
    agents: new Map(),
    openRejected: new Error('ledger down'),
  })
  const res = response()
  await handlers.get('/api/session-manager/remount')(request('s1'), res)
  assert.equal(res.status, 400)
  assert.equal(res.body.error, MESSAGES.systemError)
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

// ── 自动归档配置 ──

// GET 夹具:任意 URL 的 GET 请求
function getRequest2(url, method) {
  const req = new EventEmitter()
  req.method = method
  req.url = url
  return req
}

// POST 夹具:请求体走 readBody 的 data/end 事件流,handler 按路径查找
async function postJson(handlers, routePath, body) {
  const req = new EventEmitter()
  req.method = 'POST'
  req.url = routePath
  req.headers = { 'content-type': 'application/json' }
  const res = response()
  const done = handlers.get(routePath)(req, res)
  req.emit('data', Buffer.from(JSON.stringify(body), 'utf8'))
  req.emit('end')
  await done
  return res
}

test('自动归档配置:GET 回显生效值(未配置回默认),POST 持久,GET 反映新值', skipMissingDeps, async () => {
  const { handlers } = makeCtx({ archivedIds: [], headers: [{ id: 's1', cwd: 'C:\\x', createdAt: 0 }], agents: new Map() })
  const initial = response()
  await handlers.get('/api/session-manager/auto-archive')(getRequest2('/api/session-manager/auto-archive', 'GET'), initial)
  assert.deepEqual(initial.body, { days: DEFAULT_AUTO_ARCHIVE_DAYS, intervalHours: DEFAULT_AUTO_ARCHIVE_INTERVAL_HOURS }, '未配置时回显默认值')
  const changed = await postJson(handlers, '/api/session-manager/auto-archive', { days: 3, intervalHours: 12 })
  assert.deepEqual(changed.body, { days: 3, intervalHours: 12 })
  const reread = response()
  await handlers.get('/api/session-manager/auto-archive')(getRequest2('/api/session-manager/auto-archive', 'GET'), reread)
  assert.deepEqual(reread.body, { days: 3, intervalHours: 12 }, 'settings 持久化新值')
})

test('自动归档配置:单字段部分更新,未提交字段保持不变', skipMissingDeps, async () => {
  const { handlers } = makeCtx({ archivedIds: [], headers: [{ id: 's1', cwd: 'C:\\x', createdAt: 0 }], agents: new Map() })
  const onlyDays = await postJson(handlers, '/api/session-manager/auto-archive', { days: 3 })
  assert.deepEqual(onlyDays.body, { days: 3, intervalHours: DEFAULT_AUTO_ARCHIVE_INTERVAL_HOURS }, '仅更新 days')
  const onlyHours = await postJson(handlers, '/api/session-manager/auto-archive', { intervalHours: 12 })
  assert.deepEqual(onlyHours.body, { days: 3, intervalHours: 12 }, '仅更新 intervalHours,days 保持')
})

test('自动归档配置:0 值合法且持久(阈值天数关自动归档,间隔小时数关周期轮)', skipMissingDeps, async () => {
  const { handlers } = makeCtx({ archivedIds: [], headers: [{ id: 's1', cwd: 'C:\\x', createdAt: 0 }], agents: new Map() })
  const off = await postJson(handlers, '/api/session-manager/auto-archive', { days: 0, intervalHours: 0 })
  assert.deepEqual(off.body, { days: 0, intervalHours: 0 })
  const reread = response()
  await handlers.get('/api/session-manager/auto-archive')(getRequest2('/api/session-manager/auto-archive', 'GET'), reread)
  assert.deepEqual(reread.body, { days: 0, intervalHours: 0 }, '关闭值持久化')
})

test('自动归档配置:负数/非整数/非数值/空字段一律 400,配置不变', skipMissingDeps, async () => {
  const { handlers } = makeCtx({ archivedIds: [], headers: [{ id: 's1', cwd: 'C:\\x', createdAt: 0 }], agents: new Map() })
  const invalidPayloads = [
    { days: -1, intervalHours: 1 },
    { days: 1.5, intervalHours: 1 },
    { days: '3', intervalHours: 1 },
    { days: true, intervalHours: 1 },
    { days: null, intervalHours: 1 },
    {},
  ]
  for (const payload of invalidPayloads) {
    const rejected = await postJson(handlers, '/api/session-manager/auto-archive', payload)
    assert.equal(rejected.status, 400, JSON.stringify(payload))
  }
  const after = response()
  await handlers.get('/api/session-manager/auto-archive')(getRequest2('/api/session-manager/auto-archive', 'GET'), after)
  assert.deepEqual(after.body, { days: DEFAULT_AUTO_ARCHIVE_DAYS, intervalHours: DEFAULT_AUTO_ARCHIVE_INTERVAL_HOURS }, '被拒请求不改动配置')
})

test('自动归档配置提交判定:noop/invalid/post 三态分类', async () => {
  const { classifyAutoArchiveInput } = await import('../src/core.mjs')
  assert.deepEqual(classifyAutoArchiveInput('7', '7'), { action: 'noop' }, '值未变不提交')
  assert.deepEqual(classifyAutoArchiveInput('7', '  7  '), { action: 'noop' }, '空白差异修剪后视为未变')
  assert.deepEqual(classifyAutoArchiveInput('7', '-1'), { action: 'invalid' }, '负数拒绝')
  assert.deepEqual(classifyAutoArchiveInput('7', '1.5'), { action: 'invalid' }, '非整数拒绝')
  assert.deepEqual(classifyAutoArchiveInput('7', 'abc'), { action: 'invalid' }, '非数值拒绝')
  assert.deepEqual(classifyAutoArchiveInput('7', ''), { action: 'invalid' }, '空文本拒绝')
  assert.deepEqual(classifyAutoArchiveInput('7', '0'), { action: 'post', value: 0 }, '0 合法(关闭语义)')
  assert.deepEqual(classifyAutoArchiveInput('7', '3'), { action: 'post', value: 3 }, '正整数可提交')
})

test('自动归档配置提交判定:client 与 core 镜像同源,提交守卫对照已提交值', { skip: process.env.TEST_SKIP_PARITY }, async () => {
  const clientSource = await readFile(new URL('../src/client.js', import.meta.url), 'utf8')
  const declared = clientSource.match(/function classifyAutoArchiveInput\(committedText, text\) \{([\s\S]*?)\n\}/)
  assert.ok(declared, 'client.js 必须内联声明 classifyAutoArchiveInput')
  const coreSource = await readFile(new URL('../src/core.mjs', import.meta.url), 'utf8')
  const coreBody = coreSource.match(/export function classifyAutoArchiveInput\(committedText, text\) \{([\s\S]*?)\n\}/)
  assert.ok(coreBody, 'core.mjs 必须声明 classifyAutoArchiveInput')
  assert.equal(declared[1].trim(), coreBody[1].trim(), 'client 内联实现与 core 逐行一致')
  // 调用点契约:守卫实参必须是已提交基准 committed[field],对照显示值比较恒相等(受控输入击键已同步)
  assert.match(clientSource, /classifyAutoArchiveInput\(committed\[field\], text\)/, 'commit 必须以 committed[field] 为守卫基准')
})


// --- 0.1.7 settings 面双形适配(maintain a913c2c 同构) ---

test('Config 导出契约:根级 volatile 包装,validate 产整节单 ref,默认值对拍', () => {
  // Given 静态 Config 导出(0.1.7 节表单事实源)
  assert.ok(indexModule.Config, 'Config 导出必须在场')
  // When 空配置校验
  const resolved = indexModule.Config['~standard'].validate({})
  // Then 产整节单 ref(get 协议),字段为 schema 默认值
  assert.equal(resolved.issues, undefined)
  const section = resolved.value.get()
  assert.equal(section.autoArchiveDays, DEFAULT_AUTO_ARCHIVE_DAYS)
  assert.equal(section.autoArchiveIntervalHours, DEFAULT_AUTO_ARCHIVE_INTERVAL_HOURS)
  // When 显式值校验
  // Then 值透传
  const provided = indexModule.Config['~standard'].validate({ autoArchiveDays: 3 }).value.get()
  assert.equal(provided.autoArchiveDays, 3)
})

test('0.1.7 形态:settings 无 get/register 时读回落 config ref 节值', skipMissingDeps, async () => {
  // Given settingsForms 只有 update(0.1.7 真实方法面)+ config ref 携带用户值
  const settingsForms = { update: async () => {} }
  const configRef = { get: () => ({ autoArchiveDays: 3, autoArchiveIntervalHours: 12 }) }
  const { handlers } = makeCtx({
    archivedIds: [],
    headers: [{ id: 's1', cwd: 'C:\\x', createdAt: 0 }],
    agents: new Map(),
    settingsService: settingsForms,
    configRef,
  })
  // When GET auto-archive
  const res = response()
  await handlers.get('/api/session-manager/auto-archive')(getRequest2('/api/session-manager/auto-archive', 'GET'), res)
  // Then 返回 config 节值而非默认
  assert.deepEqual(res.body, { days: 3, intervalHours: 12 })
})

test('0.1.7 形态:auto-archive POST 经 configEditor.edit 落 fiber.entry 并回显新值', skipMissingDeps, async () => {
  // Given settingsForms 只有 update + configEditor 桩(合并写回 configStore)
  const settingsForms = { update: async () => {} }
  const configStore = { autoArchiveDays: 7 }
  const editCalls = []
  const configRef = { get: () => ({ ...configStore }) }
  const { handlers } = makeCtx({
    archivedIds: [],
    headers: [{ id: 's1', cwd: 'C:\\x', createdAt: 0 }],
    agents: new Map(),
    settingsService: settingsForms,
    configRef,
    configEditor: {
      async edit(entry, change) {
        editCalls.push(entry)
        const next = change({ ...configStore }, {})
        for (const [key, value] of Object.entries(next)) configStore[key] = value
      },
    },
  })
  // When POST 写 days
  const changed = await postJson(handlers, '/api/session-manager/auto-archive', { days: 3 })
  // Then edit 定位本条目,合并写回,响应回显新值
  assert.deepEqual(changed.body, { days: 3, intervalHours: DEFAULT_AUTO_ARCHIVE_INTERVAL_HOURS })
  assert.equal(editCalls.length, 1)
  assert.equal(editCalls[0].options.id, 'session-manager')
  assert.equal(configStore.autoArchiveDays, 3)
})

test('0.1.7 形态:configEditor 缺失即 400 拒写,配置不变', skipMissingDeps, async () => {
  // Given settingsForms 只有 update 且无 configEditor
  const settingsForms = { update: async () => {} }
  const configRef = { get: () => ({}) }
  const { handlers } = makeCtx({
    archivedIds: [],
    headers: [{ id: 's1', cwd: 'C:\\x', createdAt: 0 }],
    agents: new Map(),
    settingsService: settingsForms,
    configRef,
  })
  // When POST 写 days
  const denied = await postJson(handlers, '/api/session-manager/auto-archive', { days: 3 })
  // Then 400 错误响应
  assert.equal(denied.status, 400)
  assert.ok(denied.body.error)
})

test('0.1.7 形态:settings.configure 在场即关闭原生自动页', skipMissingDeps, () => {
  // Given settingsForms 带 configure 无 register
  const configureCalls = []
  const settingsForms = { configure: (presentation, owner) => { configureCalls.push({ presentation, owner }); return () => {} } }
  const { activateSettings } = makeCtx({
    archivedIds: [],
    headers: [],
    agents: new Map(),
    settingsService: settingsForms,
  })
  // When 激活 settings 注入
  activateSettings()
  // Then 关闭自动页
  assert.equal(configureCalls.length, 1)
  assert.deepEqual(configureCalls[0].presentation, { auto: false })
})

// ── 写路由同源 + JSON 守卫回归 ──

// POST 夹具:带 headers 的请求体走 readBody 的 data/end 事件流
function guardedRequest(routePath, headers, body = { sessionId: 's1' }) {
  const req = new EventEmitter()
  req.method = 'POST'
  req.url = routePath
  req.headers = headers
  process.nextTick(() => {
    req.emit('data', Buffer.from(JSON.stringify(body)))
    req.emit('end')
  })
  return req
}

test('写路由守卫:跨源 403 / 非 JSON 或缺 content-type 400 / 同源 JSON 正常受理', skipMissingDeps, async () => {
  // Given 全部写路由(浏览器表单可发 text/plain 且载荷为合法 JSON,仅方法守卫不足)
  const POST_ROUTES = [
    '/api/session-manager/unarchive',
    '/api/session-manager/info',
    '/api/session-manager/sizes',
    '/api/session-manager/delete',
    '/api/session-manager/auto-archive',
    '/api/session-manager/remount',
    '/api/session-manager/forget',
  ]
  const ORIGIN = 'http://127.0.0.1:9291'
  const sameOrigin = {
    origin: ORIGIN,
    host: '127.0.0.1:9291',
    'content-type': 'application/json; charset=utf-8',
  }

  for (const routePath of POST_ROUTES) {
    const { handlers } = makeCtx({ archivedIds: ['s1'], headers: [HEADER], agents: new Map() })

    // When Origin 与 Host 不同 Then 403,且响应为统一拒绝文案
    const crossOrigin = response()
    await handlers.get(routePath)(guardedRequest(routePath, { ...sameOrigin, origin: 'http://evil.example' }), crossOrigin)
    assert.equal(crossOrigin.status, 403, `${routePath} 跨源 POST 必须 403`)

    // When 同源但 content-type: text/plain Then 400(共享闸门,不再有本地 415 分叉)
    const textPlain = response()
    await handlers.get(routePath)(guardedRequest(routePath, { ...sameOrigin, 'content-type': 'text/plain' }), textPlain)
    assert.equal(textPlain.status, 400, `${routePath} text/plain POST 必须 400`)

    // When 完全不带头(旧本地守卫放行)Then 400:缺 content-type 即拒绝
    const missingType = response()
    await handlers.get(routePath)(guardedRequest(routePath, { origin: ORIGIN, host: '127.0.0.1:9291' }), missingType)
    assert.equal(missingType.status, 400, `${routePath} 缺 content-type 必须 400`)
  }

  // When 同源 application/json Then 正常受理(unarchive 可幂等成功)
  const { handlers } = makeCtx({ archivedIds: ['s1'], headers: [HEADER], agents: new Map() })
  const accepted = response()
  await handlers.get('/api/session-manager/unarchive')(guardedRequest('/api/session-manager/unarchive', sameOrigin), accepted)
  assert.equal(accepted.status, 200)
  assert.deepEqual(accepted.body, { ok: true })

  // GET 不受 Origin/content-type 闸门约束
  const read = response()
  await handlers.get('/api/session-manager/status')(getRequest2('/api/session-manager/status', 'GET'), read)
  assert.equal(read.status, 200)
})

// ── 子 agent 会话:面板不展示,生命周期动作拒绝,创建事件不触发评估 ──

const DERIVED_HEADERS = [
  { ...HEADER, origin: 'subagent', parentSession: 'root', delegationDepth: 1 },
  { ...HEADER, parentSession: 'root', delegationDepth: 1 },
]

test('删除路由:子 agent 会话拒绝,不触碰产物', skipMissingDeps, async () => {
  for (const header of DERIVED_HEADERS) {
    const { handlers } = makeCtx({ archivedIds: ['s1'], headers: [header], agents: new Map() })
    const res = response()
    await handlers.get('/api/session-manager/delete')(request('s1'), res)
    assert.equal(res.status, 400)
    assert.deepEqual(res.body, { error: MESSAGES.derivedSession })
  }
})

test('取消归档路由:子 agent 会话拒绝,注册表不变', skipMissingDeps, async () => {
  for (const header of DERIVED_HEADERS) {
    const { handlers, registry } = makeCtx({ archivedIds: ['s1'], headers: [header], agents: new Map() })
    const res = response()
    await handlers.get('/api/session-manager/unarchive')(request('s1'), res)
    assert.equal(res.status, 400)
    assert.deepEqual(res.body, { error: MESSAGES.derivedSession })
    assert.deepEqual(registry.unarchiveCalls, [])
  }
})

test('重挂载路由:子 agent 会话拒绝,不写工作区归属行', skipMissingDeps, async () => {
  for (const header of DERIVED_HEADERS) {
    const workspace = makeWorkspace('C:\\x', [])
    const { handlers, ledger } = makeCtx({
      archivedIds: [],
      headers: [header],
      agents: new Map(),
      workspaces: [workspace],
      ledger: makeLedgerDomain([{ sessionId: 's1', path: LEDGER_FIXTURE_PATH, deletedAt: 1 }]),
    })
    const res = response()
    await handlers.get('/api/session-manager/remount')(request('s1'), res)
    assert.equal(res.status, 400)
    assert.deepEqual(res.body, { error: MESSAGES.derivedSession })
    assert.deepEqual(workspace.attachCalls, [])
    assert.equal(ledger.state.deleted.length, 1, '拒绝后台账保留供人工处置')
  }
})

test('会话创建事件:子 agent 会话不触发归档评估(不列会话)', skipMissingDeps, async () => {
  for (const header of DERIVED_HEADERS) {
    let scans = 0
    const { eventHandlers, registry } = makeCtx({
      archivedIds: [],
      headers: () => { scans += 1; return [] },
      agents: new Map(),
    })
    eventHandlers['session/created']({ header: { ...header, cwd: 'C:\\x' } })
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal(scans, 0, '子会话创建不得触发 listSessions 全量扫描')
    assert.deepEqual(registry.archiveCalls, [])
  }
})

// ── 删除父会话:级联回收派生子会话产物 ──

async function makeCascadeArtifacts(ids) {
  const root = await mkdtemp(path.join(tmpdir(), 'sm-cascade-'))
  const paths = {}
  for (const id of ids) {
    await mkdir(path.join(root, id), { recursive: true })
    await writeFile(path.join(root, id, 'session.jsonl.zstd'), 'log-bytes')
    paths[id] = path.join(root, id)
  }
  return { root, paths, cleanup: () => rm(root, { recursive: true, force: true }) }
}

test('删除父会话:级联回收全部派生子会话且不记台账(子会话不可重挂载)', skipMissingDeps, async () => {
  const artifacts = await makeCascadeArtifacts(['p', 'c', 'g'])
  try {
    const headers = [
      { id: 'p', cwd: 'C:\\x', createdAt: 0 },
      { id: 'c', cwd: 'C:\\x', createdAt: 0, origin: 'subagent', parentSession: 'p', delegationDepth: 1 },
      { id: 'g', cwd: 'C:\\x', createdAt: 0, origin: 'subagent', parentSession: 'c', delegationDepth: 2 },
    ]
    const { handlers, ledger } = makeCtx({
      archivedIds: ['p'],
      headers,
      agents: new Map(headers.map((header) => [header.id, { status: 'idle' }])),
      sessionPersistence: { locate: (header) => ({ path: path.join(artifacts.paths[header.id], 'session.jsonl.zstd') }) },
    })
    const trashed = []
    const res = response()
    await withTrashStub(async (target) => { trashed.push(target) }, async () => {
      await handlers.get('/api/session-manager/delete')(request('p'), res)
    })
    assert.equal(res.status, 200)
    assert.deepEqual(res.body.cascade, { deleted: ['c', 'g'], failed: [] })
    assert.deepEqual(trashed.sort(), [artifacts.paths.p, artifacts.paths.c, artifacts.paths.g].sort())
    // 台账只服务「还原后重挂载」;重挂载明确拒绝子会话,写进去只会留下点击必 400 的面板行
    assert.deepEqual(ledger.state.deleted.map((item) => item.sessionId), ['p'])
  } finally {
    await artifacts.cleanup()
  }
})

// F3:子会话目录不存在不是回收失败——产物已无,必须照常 detach + 清归档,
// 不得误报 partial 把子会话留在父 catalog/归档集合里
test('删除父会话:子会话目录不存在按无产物处理,照常 detach 并清归档', skipMissingDeps, async () => {
  const artifacts = await makeCascadeArtifacts(['p'])
  try {
    const headers = [
      { id: 'p', cwd: 'C:\\x', createdAt: 0 },
      { id: 'c', cwd: 'C:\\x', createdAt: 0, origin: 'subagent', parentSession: 'p', delegationDepth: 1 },
    ]
    const childSnapshot = {
      header: headers[1],
      formatStatus: 'current',
      revision: 'rev-child',
      sizeBytes: 0,
      // 快照指向的子目录并未创建:模拟持久层列表与磁盘之间的删除窗口
      location: { kind: 'jsonl', path: path.join(artifacts.root, 'c', 'session.jsonl.zstd') },
    }
    const parentSnapshot = {
      header: headers[0],
      formatStatus: 'current',
      revision: 'rev-parent',
      sizeBytes: 9,
      location: { kind: 'jsonl', path: path.join(artifacts.paths.p, 'session.jsonl.zstd') },
    }
    const workspace = makeWorkspace('C:\\x', ['p', 'c'])
    const { handlers, ledger, registry } = makeCtx({
      archivedIds: ['p', 'c'],
      headers,
      agents: new Map(headers.map((header) => [header.id, { status: 'idle' }])),
      workspaces: [workspace],
      sessionPersistence: {
        stat: async (id) => String(id) === 'p' ? parentSnapshot : String(id) === 'c' ? childSnapshot : undefined,
      },
    })
    const trashed = []
    const res = response()
    await withTrashStub(async (target) => { trashed.push(target) }, async () => {
      await handlers.get('/api/session-manager/delete')(request('p'), res)
    })
    assert.equal(res.status, 200)
    assert.equal(res.body.partial, undefined, '目录不存在的子会话不得误报 partial')
    assert.deepEqual(res.body.cascade, { deleted: ['c'], failed: [] })
    assert.deepEqual(trashed, [artifacts.paths.p], '子会话无可回收目录,不得调用回收')
    assert.deepEqual(workspace.sessionIds, [], '子会话必须照常 detach')
    assert.deepEqual(registry.state.archivedSessionIds, [], '子会话必须照常清归档')
    assert.deepEqual(ledger.state.deleted.map((item) => item.sessionId), ['p'], '只有父会话入台账')
  } finally {
    await artifacts.cleanup()
  }
})

test('删除父会话:子会话回收时目录 ENOENT 按无产物收尾,不误报 partial', skipMissingDeps, async () => {
  const artifacts = await makeCascadeArtifacts(['p', 'c'])
  try {
    const headers = [
      { id: 'p', cwd: 'C:\\x', createdAt: 0 },
      { id: 'c', cwd: 'C:\\x', createdAt: 0, origin: 'subagent', parentSession: 'p', delegationDepth: 1 },
    ]
    const snapshotOf = (header) => ({
      header,
      formatStatus: 'current',
      revision: 'rev-' + header.id,
      sizeBytes: 9,
      location: { kind: 'jsonl', path: path.join(artifacts.paths[header.id], 'session.jsonl.zstd') },
    })
    const workspace = makeWorkspace('C:\\x', ['p', 'c'])
    const { handlers, ledger, registry } = makeCtx({
      archivedIds: ['p', 'c'],
      headers,
      agents: new Map(headers.map((header) => [header.id, { status: 'idle' }])),
      workspaces: [workspace],
      sessionPersistence: { stat: async (id) => snapshotOf(headers.find((header) => header.id === String(id))) },
    })
    const trashCalls = []
    const res = response()
    await withExecutorStub({
      trashPath: async (target) => {
        trashCalls.push(path.basename(target))
        if (path.basename(target) === 'c') {
          // 目标目录在探测与回收之间消失:文件系统 rename ENOENT(非命令缺失)
          throw Object.assign(new Error('directory vanished'), { code: 'ENOENT', errno: -2, syscall: 'rename', path: target })
        }
      },
    }, async () => {
      await handlers.get('/api/session-manager/delete')(request('p'), res)
    })
    assert.equal(res.status, 200)
    assert.equal(res.body.partial, undefined)
    assert.deepEqual(res.body.cascade, { deleted: ['c'], failed: [] })
    assert.deepEqual(trashCalls, ['p', 'c'], '目录消失的子会话不得降级到回收区')
    assert.deepEqual(workspace.sessionIds, [], '子会话必须照常 detach')
    assert.deepEqual(registry.state.archivedSessionIds, [], '子会话必须照常清归档')
    assert.deepEqual(ledger.state.deleted.map((item) => item.sessionId), ['p'])
  } finally {
    await artifacts.cleanup()
  }
})

test('删除父会话:级联子会话不写已删除台账,台账写入仍只此一次', skipMissingDeps, async () => {
  const artifacts = await makeCascadeArtifacts(['p', 'c'])
  try {
    const headers = [
      { id: 'p', cwd: 'C:\\x', createdAt: 0 },
      { id: 'c', cwd: 'C:\\x', createdAt: 0, origin: 'subagent', parentSession: 'p', delegationDepth: 1 },
    ]
    const ledger = makeLedgerDomain([])
    const writes = []
    const write = ledger.global.set
    ledger.global.set = async (next) => {
      writes.push(next.deleted.map((entry) => entry.sessionId))
      return write(next)
    }
    const { handlers } = makeCtx({
      archivedIds: ['p'],
      headers,
      agents: new Map(headers.map((header) => [header.id, { status: 'idle' }])),
      sessionPersistence: { locate: (header) => ({ path: path.join(artifacts.paths[header.id], 'session.jsonl.zstd') }) },
      ledger,
    })
    const res = response()
    await withTrashStub(async () => {}, async () => {
      await handlers.get('/api/session-manager/delete')(request('p'), res)
    })
    assert.equal(res.status, 200)
    assert.deepEqual(res.body.cascade, { deleted: ['c'], failed: [] })
    assert.deepEqual(writes, [['p']], '级联子会话不得进入已删除台账(只写父会话一条)')
  } finally {
    await artifacts.cleanup()
  }
})

test('删除父会话:子会话运行中拒绝整次删除,父产物不动', skipMissingDeps, async () => {
  const artifacts = await makeCascadeArtifacts(['p', 'c'])
  try {
    const headers = [
      { id: 'p', cwd: 'C:\\x', createdAt: 0 },
      { id: 'c', cwd: 'C:\\x', createdAt: 0, origin: 'subagent', parentSession: 'p', delegationDepth: 1 },
    ]
    const { handlers } = makeCtx({
      archivedIds: ['p'],
      headers,
      agents: new Map([['p', { status: 'idle' }], ['c', { status: 'running' }]]),
      sessionPersistence: { locate: (header) => ({ path: path.join(artifacts.paths[header.id], 'session.jsonl.zstd') }) },
    })
    const trashed = []
    const res = response()
    await withTrashStub(async (target) => { trashed.push(target) }, async () => {
      await handlers.get('/api/session-manager/delete')(request('p'), res)
    })
    assert.equal(res.status, 400)
    assert.deepEqual(res.body, { error: MESSAGES.descendantRunning })
    assert.deepEqual(trashed, [])
  } finally {
    await artifacts.cleanup()
  }
})

test('删除父会话:普通 fork 不随父级联(只回收父目录)', skipMissingDeps, async () => {
  const artifacts = await makeCascadeArtifacts(['p', 'f'])
  try {
    const headers = [
      { id: 'p', cwd: 'C:\\x', createdAt: 0 },
      { id: 'f', cwd: 'C:\\x', createdAt: 0, parentSession: 'p', delegationDepth: 0 },
    ]
    const { handlers, ledger } = makeCtx({
      archivedIds: ['p'],
      headers,
      agents: new Map([['p', { status: 'idle' }], ['f', { status: 'idle' }]]),
      sessionPersistence: { locate: (header) => ({ path: path.join(artifacts.paths[header.id], 'session.jsonl.zstd') }) },
    })
    const trashed = []
    const res = response()
    await withTrashStub(async (target) => { trashed.push(target) }, async () => {
      await handlers.get('/api/session-manager/delete')(request('p'), res)
    })
    assert.equal(res.status, 200)
    assert.equal(res.body.cascade, undefined)
    assert.deepEqual(trashed, [artifacts.paths.p])
    assert.deepEqual(ledger.state.deleted.map((item) => item.sessionId), ['p'])
  } finally {
    await artifacts.cleanup()
  }
})

test('删除父会话:父产物缺失的幽灵清理同样级联子会话', skipMissingDeps, async () => {
  const artifacts = await makeCascadeArtifacts(['c'])
  try {
    const headers = [
      { id: 'p', cwd: 'C:\\x', createdAt: 0 },
      { id: 'c', cwd: 'C:\\x', createdAt: 0, origin: 'subagent', parentSession: 'p', delegationDepth: 1 },
    ]
    const { handlers, ledger } = makeCtx({
      archivedIds: ['p'],
      headers,
      agents: new Map([['p', { status: 'idle' }], ['c', { status: 'idle' }]]),
      sessionPersistence: { locate: (header) => ({ path: path.join(artifacts.root, header.id, 'session.jsonl.zstd') }) },
    })
    const trashed = []
    const res = response()
    await withTrashStub(async (target) => { trashed.push(target) }, async () => {
      await handlers.get('/api/session-manager/delete')(request('p'), res)
    })
    assert.equal(res.status, 200)
    assert.deepEqual(res.body.cascade, { deleted: ['c'], failed: [] })
    assert.deepEqual(trashed, [artifacts.paths.c])
    assert.deepEqual(ledger.state.deleted.map((item) => item.sessionId), [], '幽灵清理不记台账,级联子会话同样不记')
  } finally {
    await artifacts.cleanup()
  }
})

test('删除父会话:子会话回收失败时如实返回 partial 与失败清单', skipMissingDeps, async () => {
  const artifacts = await makeCascadeArtifacts(['p', 'c'])
  try {
    const headers = [
      { id: 'p', cwd: 'C:\\x', createdAt: 0 },
      { id: 'c', cwd: 'C:\\x', createdAt: 0, origin: 'subagent', parentSession: 'p', delegationDepth: 1 },
    ]
    const { handlers, ledger } = makeCtx({
      archivedIds: ['p'],
      headers,
      agents: new Map([['p', { status: 'idle' }], ['c', { status: 'idle' }]]),
      sessionPersistence: { locate: (header) => ({ path: path.join(artifacts.paths[header.id], 'session.jsonl.zstd') }) },
    })
    const res = response()
    await withExecutorStub({
      trashPath: async (target) => { if (path.basename(target) === 'c') throw new Error('gio: not found') },
      moveToQuarantine: async () => { throw new Error('EXDEV') },
    }, async () => {
      await handlers.get('/api/session-manager/delete')(request('p'), res)
    })
    assert.equal(res.status, 200)
    assert.equal(res.body.partial, true)
    assert.match(res.body.message, /1 个子会话/)
    assert.deepEqual(res.body.cascade.deleted, [])
    assert.equal(res.body.cascade.failed.length, 1)
    assert.deepEqual(ledger.state.deleted.map((item) => item.sessionId), ['p'])
  } finally {
    await artifacts.cleanup()
  }
})

// ── 审查修复回归(2026-11-14 §3.3 P2-08~P2-12 与 §4 session-manager P3) ──

const IDLE_PC = new Map([['p', { status: 'idle' }], ['c', { status: 'idle' }]])

// Given 资格判定通过、子会话扫描期间用户在另一窗口恢复该会话,
// When 删除走到执行前, Then 归档资格复核失败 → 409 中止,产物与台账零副作用
test('删除:资格判定到执行之间会话被恢复 → 409 中止且无副作用', skipMissingDeps, async () => {
  const artifact = await makeLocatedArtifact()
  try {
    let scans = 0
    let bundle
    const headers = async () => {
      scans += 1
      // 第二次全量扫描 = 删除前的子会话清单:此刻用户在另一窗口点「恢复」
      if (scans === 2) bundle.registry.state.archivedSessionIds = []
      return [HEADER]
    }
    bundle = makeCtx({
      archivedIds: ['s1'],
      headers,
      agents: IDLE_S1,
      domain: makeDomain(['s1']),
      sessionPersistence: { locate: () => ({ path: artifact.locatedPath }) },
      workspaces: [makeWorkspace('C:\\x', ['s1'])],
    })
    const trashed = []
    const res = response()
    await withTrashStub(async (target) => { trashed.push(target) }, async () => {
      await bundle.handlers.get('/api/session-manager/delete')(request('s1'), res)
    })
    assert.equal(res.status, 409)
    assert.equal(res.body.error, MESSAGES.archiveRevoked)
    assert.deepEqual(trashed, [], '恢复后不得再移走产物')
    assert.equal(bundle.ledger.writes, 0, '中止路径不写台账')
  } finally {
    await artifact.cleanup()
  }
})

// Given 执行前复核通过、trash 处置窗口内用户恢复该会话, When 处置返回,
// Then 处置后复查归档资格 → 409,台账/detach/归档清理零副作用
test('删除:处置窗口内会话被恢复(OS 回收) → 409 且不写台账不 detach', skipMissingDeps, async () => {
  const artifact = await makeLocatedArtifact()
  try {
    const workspace = makeWorkspace('C:\\x', ['s1'])
    let bundle
    bundle = makeCtx({
      archivedIds: ['s1'],
      headers: [HEADER],
      agents: IDLE_S1,
      domain: makeDomain(['s1']),
      sessionPersistence: { locate: () => ({ path: artifact.locatedPath }) },
      workspaces: [workspace],
    })
    const res = response()
    await withTrashStub(async () => {
      // 模拟 OS 回收异步窗口内用户在另一窗口完成恢复
      bundle.registry.state.archivedSessionIds = []
    }, async () => {
      await bundle.handlers.get('/api/session-manager/delete')(request('s1'), res)
    })
    assert.equal(res.status, 409)
    assert.equal(res.body.error, MESSAGES.archiveRevoked)
    assert.equal(bundle.ledger.writes, 0, '恢复中止路径不写台账')
    assert.deepEqual(workspace.sessionIds, ['s1'], '不得 detach 已恢复会话')
  } finally {
    await artifact.cleanup()
  }
})

// Given 处置降级到插件回收区后才发现会话已被恢复, When 收尾,
// Then 暂存产物回退原位置并 409,不写台账/不 detach
test('删除:处置窗口内会话被恢复(回收区) → 回退暂存并 409', skipMissingDeps, async () => {
  const artifact = await makeLocatedArtifact()
  try {
    const workspace = makeWorkspace('C:\\x', ['s1'])
    let bundle
    bundle = makeCtx({
      archivedIds: ['s1'],
      headers: [HEADER],
      agents: IDLE_S1,
      domain: makeDomain(['s1']),
      sessionPersistence: { locate: () => ({ path: artifact.locatedPath }) },
      workspaces: [workspace],
    })
    const heldPath = path.join(process.env.DSH_QUARANTINE_DIR, 'held-s1-rollback')
    const restored = []
    const res = response()
    await withExecutorStub({
      trashPath: async () => { throw new Error('gio: not found') },
      moveToQuarantine: async () => {
        bundle.registry.state.archivedSessionIds = []
        return heldPath
      },
      restoreFromQuarantine: async (held, original) => { restored.push([held, original]) },
    }, async () => {
      await bundle.handlers.get('/api/session-manager/delete')(request('s1'), res)
    })
    assert.equal(res.status, 409)
    assert.equal(res.body.error, MESSAGES.archiveRevoked)
    assert.deepEqual(restored, [[heldPath, artifact.locatedDir]], '回收区暂存必须回退原位置')
    assert.equal(bundle.ledger.writes, 0, '回退路径不写台账')
    assert.deepEqual(workspace.sessionIds, ['s1'], '不得 detach 已恢复会话')
  } finally {
    await artifact.cleanup()
  }
})

// Given 子会话 detach 失败, When 父会话删除走完级联, Then 子会话进 failed+partial、
// 不计入 deleted、归档记录保留,且原始错误落日志
test('删除父会话:子会话 detach 失败计入 failed+partial,不谎报已清理', skipMissingDeps, async () => {
  const artifacts = await makeCascadeArtifacts(['p', 'c'])
  try {
    const headers = [
      { id: 'p', cwd: 'C:\\x', createdAt: 0 },
      { id: 'c', cwd: 'C:\\x', createdAt: 0, origin: 'subagent', parentSession: 'p', delegationDepth: 1 },
    ]
    const workspace = makeWorkspace('C:\\x', ['p', 'c'])
    const detach = workspace.detachSession
    workspace.detachSession = async (id) => {
      if (String(id) === 'c') throw new Error('child detach boom')
      return detach(id)
    }
    const { handlers, logger, registry } = makeCtx({
      // 子会话也在归档集合里:detach 失败必须保留其归档记录供重试
      archivedIds: ['p', 'c'],
      headers,
      agents: IDLE_PC,
      sessionPersistence: { locate: (header) => ({ path: path.join(artifacts.paths[header.id], 'session.jsonl.zstd') }) },
      workspaces: [workspace],
    })
    const res = response()
    await withTrashStub(async () => {}, async () => {
      await handlers.get('/api/session-manager/delete')(request('p'), res)
    })
    assert.equal(res.status, 200)
    assert.equal(res.body.partial, true)
    assert.match(res.body.message, /1 个子会话/)
    assert.deepEqual(res.body.cascade.deleted, [])
    assert.deepEqual(res.body.cascade.failed, [{ sessionId: 'c', error: MESSAGES.cascadeDetach, partial: true }])
    assert.deepEqual(registry.state.archivedSessionIds, ['c'], 'detach 失败的子会话保留归档资格')
    assert.ok(logger.warns.some((message) => message.includes('child detach boom')), '单个工作区 detach 失败也要落日志')
  } finally {
    await artifacts.cleanup()
  }
})

// Given header 已被缓存, When 产物不在持久层(未还原)再点重新挂载,
// Then 缓存必须被绕过 → 400 notRestored,不得直接 attachSession
test('重挂载:header 缓存不击穿「产物未还原」守卫', skipMissingDeps, async () => {
  const present = { value: true }
  const workspace = makeWorkspace('C:\\x', [])
  const { handlers } = makeCtx({
    archivedIds: [],
    headers: async () => (present.value ? [HEADER] : []),
    agents: new Map(),
    workspaces: [workspace],
    ledger: makeLedgerDomain([{ sessionId: 's1', path: LEDGER_FIXTURE_PATH, deletedAt: 1 }]),
  })
  // info 路由先扫一次并写入缓存(删除前的常见前置动作)
  const infoRes = response()
  await handlers.get('/api/session-manager/info')(request('s1'), infoRes)
  assert.equal(infoRes.status, 200)
  // 产物已进回收站:持久层不再列出该会话
  present.value = false
  const res = response()
  await handlers.get('/api/session-manager/remount')(request('s1'), res)
  assert.equal(res.status, 400)
  assert.equal(res.body.error, MESSAGES.notRestored)
  assert.deepEqual(workspace.attachCalls, [], '未还原不得调用 attachSession')
})

// Given 删除成功后会话已不在持久层, When 再次查询 info, Then 缓存已失效按不存在处理
test('删除成功后失效 header 缓存:后续 info 不再读到已删除会话', skipMissingDeps, async () => {
  const artifact = await makeLocatedArtifact()
  const present = { value: true }
  try {
    const { handlers } = makeCtx({
      archivedIds: ['s1'],
      headers: async () => (present.value ? [HEADER] : []),
      agents: IDLE_S1,
      domain: makeDomain(['s1']),
      sessionPersistence: { locate: () => ({ path: artifact.locatedPath }) },
    })
    const primed = response()
    await handlers.get('/api/session-manager/info')(request('s1'), primed)
    assert.equal(primed.status, 200)
    const del = response()
    await withTrashStub(async () => {}, async () => {
      await handlers.get('/api/session-manager/delete')(request('s1'), del)
    })
    assert.equal(del.status, 200)
    present.value = false
    const after = response()
    await handlers.get('/api/session-manager/info')(request('s1'), after)
    assert.equal(after.status, 400)
    assert.equal(after.body.error, MESSAGES.unknownSession)
  } finally {
    await artifact.cleanup()
  }
})

// Given 第三方会话后端不提供 stat/list/locate 观测能力, When 删除 / info / 自动归档评估,
// Then 一律按「不可定位」处理,不把 TypeError 原文回给面板、整轮评估不停摆
test('无 stat/list/locate 观测能力:删除与 info 按后端不支持处理,不回传 TypeError', skipMissingDeps, async () => {
  const { handlers } = makeCtx({
    archivedIds: ['s1'],
    headers: [HEADER],
    agents: IDLE_S1,
    domain: makeDomain(['s1']),
    sessionPersistence: { pathFor: () => ({ path: 'C:\\x\\s1' }) },
  })
  const del = response()
  await handlers.get('/api/session-manager/delete')(request('s1'), del)
  assert.equal(del.status, 400)
  assert.equal(del.body.error, MESSAGES.unsupportedBackend)
  const info = response()
  await handlers.get('/api/session-manager/info')(request('s1'), info)
  assert.equal(info.status, 200)
  assert.deepEqual(info.body, { supported: false })
})

test('无 stat/list/locate 观测能力:自动归档评估不整轮抛错,周期状态与归档集合不受污染', skipMissingDeps, async () => {
  const stale = Date.now() - 30 * 24 * 60 * 60 * 1000
  const bundle = makeCtx({
    archivedIds: [],
    headers: [{ id: 's1', cwd: 'C:\\x', createdAt: stale }],
    agents: new Map(),
    sessionPersistence: {},
  })
  bundle.activateSettings()
  await new Promise((resolve) => setTimeout(resolve, 120))
  assert.ok(
    !bundle.logger.warns.some((message) => message.includes('自动归档评估失败')),
    '观测能力缺失不应让整轮评估 reject: ' + bundle.logger.warns.join(' | '),
  )
  assert.deepEqual(bundle.registry.archiveCalls, [])
  const res = response()
  await bundle.handlers.get('/api/session-manager/status')(request('s1', 'GET'), res)
  assert.equal(res.status, 200)
  assert.equal(res.body.periodic.running, true)
})

// Given 台账操作成功, When 路由返回, Then 本次操作注册的定时器全部被清理(无 10s 悬挂)
test('台账读改写定时器在操作落定后清理', skipMissingDeps, async () => {
  const artifact = await makeLocatedArtifact()
  const realSetTimeout = globalThis.setTimeout
  const realClearTimeout = globalThis.clearTimeout
  const scheduled = []
  const cleared = new Set()
  globalThis.setTimeout = (fn, ms, ...args) => {
    const handle = realSetTimeout(fn, ms, ...args)
    scheduled.push({ handle, ms })
    return handle
  }
  globalThis.clearTimeout = (handle) => {
    if (handle !== undefined) cleared.add(handle)
    return realClearTimeout(handle)
  }
  try {
    const { handlers, ledger } = makeCtx({
      archivedIds: ['s1'],
      headers: [HEADER],
      agents: IDLE_S1,
      domain: makeDomain(['s1']),
      sessionPersistence: { locate: () => ({ path: artifact.locatedPath }) },
    })
    const res = response()
    await withTrashStub(async () => {}, async () => {
      await handlers.get('/api/session-manager/delete')(request('s1'), res)
    })
    assert.equal(res.status, 200)
    assert.deepEqual(ledger.state.deleted.map((item) => item.sessionId), ['s1'])
  } finally {
    globalThis.setTimeout = realSetTimeout
    globalThis.clearTimeout = realClearTimeout
    await artifact.cleanup()
  }
  const opTimers = scheduled.filter((item) => item.ms === indexModule.ledgerRuntime.opTimeoutMs)
  assert.ok(opTimers.length > 0, '台账操作应注册超时定时器')
  assert.deepEqual(opTimers.filter((item) => !cleared.has(item.handle)).map((item) => item.ms), [],
    '台账超时定时器未清理')
})

// Given 首个台账写挂起(被判超时)且后续写已提交, When 挂起的写迟到落定,
// Then 互斥链等到真实落定才放行,两条条目都在(旧快照不得整表覆盖)
test('台账迟到写不与后续写交错覆盖:两条删除条目都保留', skipMissingDeps, async () => {
  const artifactA = await makeLocatedArtifact('a')
  const artifactB = await makeLocatedArtifact('b')
  const runtime = indexModule.ledgerRuntime
  const saved = { opTimeoutMs: runtime.opTimeoutMs, chainEscapeMs: runtime.chainEscapeMs }
  runtime.opTimeoutMs = 40
  runtime.chainEscapeMs = 5000
  try {
    let releaseFirst
    const gate = new Promise((resolve) => { releaseFirst = resolve })
    const ledger = makeLedgerDomain([])
    const write = ledger.global.set
    const setCalls = []
    let gated = false
    ledger.global.set = async (next) => {
      setCalls.push(next.deleted.map((entry) => entry.sessionId))
      if (!gated) {
        gated = true
        await gate
      }
      return write(next)
    }
    const headers = [
      { id: 'a', cwd: 'C:\\x', createdAt: 0 },
      { id: 'b', cwd: 'C:\\x', createdAt: 0 },
    ]
    const { handlers } = makeCtx({
      archivedIds: ['a', 'b'],
      headers,
      agents: new Map([['a', { status: 'idle' }], ['b', { status: 'idle' }]]),
      domain: makeDomain(['a', 'b']),
      sessionPersistence: {
        locate: (header) => header.id === 'a' ? { path: artifactA.locatedPath } : { path: artifactB.locatedPath },
      },
      ledger,
      workspaces: [makeWorkspace('C:\\x', ['a', 'b'])],
    })
    const resA = response()
    const firstDone = withTrashStub(async () => {}, async () => {
      await handlers.get('/api/session-manager/delete')(request('a'), resA)
    })
    await waitFor(() => setCalls.length === 1)
    const resB = response()
    await withTrashStub(async () => {}, async () => {
      await handlers.get('/api/session-manager/delete')(request('b'), resB)
    })
    // 首个写在挂起中:其调用方已按超时失败降级返回,迟到写仍会落定
    await waitFor(() => resA.status !== undefined)
    assert.equal(resA.status, 200)
    assert.equal(resA.body.partial, true, 'a 的删除已按台账超时降级为 partial')
    releaseFirst()
    await firstDone
    // 迟到写落定 + 链条放行后,后续写按最新快照重算:两条条目都在
    await waitFor(() => ledger.state.deleted.length === 2)
    assert.equal(resB.status, 200)
    assert.deepEqual(ledger.state.deleted.map((item) => item.sessionId).sort(), ['a', 'b'],
      '迟到写不得抹掉后续写提交的条目')
  } finally {
    runtime.opTimeoutMs = saved.opTimeoutMs
    runtime.chainEscapeMs = saved.chainEscapeMs
    await artifactA.cleanup()
    await artifactB.cleanup()
  }
})

// Given 恢复 s1 后同轮又有另一条超期会话 s2, When 触发评估,
// Then 宽限只保护 s1,s2 照常归档(不做整轮全局短路)
test('取消归档宽限按会话:恢复 s1 不阻止同轮归档 s2', skipMissingDeps, async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'sm-grace-ps-'))
  try {
    const artifacts = {}
    const stale = Date.now() - 30 * 24 * 60 * 60 * 1000
    for (const id of ['s1', 's2']) {
      const artifact = path.join(dir, id + '.jsonl')
      await writeFile(artifact, '{"header":1}\n{"event":0}\n')
      await utimes(artifact, stale / 1000, stale / 1000)
      artifacts[id] = artifact
    }
    const headers = [{ id: 's1', cwd: 'C:\\x', createdAt: stale }]
    const { activateSettings, eventHandlers, registry, handlers } = makeCtx({
      archivedIds: [],
      headers,
      agents: new Map(),
      sessionPersistence: { locate: (header) => ({ path: artifacts[header.id] }) },
    })
    activateSettings()
    await waitFor(() => registry.archiveCalls.length > 0)
    assert.deepEqual(registry.archiveCalls, ['s1'])
    // 恢复 s1:进入宽限;随后新增超期 s2,由新会话触发新一轮评估
    const res = response()
    await handlers.get('/api/session-manager/unarchive')(request('s1'), res)
    assert.equal(res.status, 200)
    headers.push({ id: 's2', cwd: 'C:\\x', createdAt: stale })
    eventHandlers['session/created']({ header: { id: 'trigger', cwd: 'C:\\x' } })
    await waitFor(() => registry.archiveCalls.includes('s2'))
    assert.deepEqual(registry.archiveCalls, ['s1', 's2'], '宽限只保护被恢复的 s1')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

// Given 父级台账失败且级联子会话也半失败, When 聚合响应, Then 两段文案都在
test('删除父会话:父级与级联半失败文案合并不互相覆盖', skipMissingDeps, async () => {
  const artifacts = await makeCascadeArtifacts(['p', 'c'])
  try {
    const headers = [
      { id: 'p', cwd: 'C:\\x', createdAt: 0 },
      { id: 'c', cwd: 'C:\\x', createdAt: 0, origin: 'subagent', parentSession: 'p', delegationDepth: 1 },
    ]
    const ledger = makeLedgerDomain([])
    const write = ledger.global.set
    ledger.global.set = async (next) => {
      if (next.deleted.some((entry) => entry.sessionId === 'p')) throw new Error('ledger unavailable')
      return write(next)
    }
    const { handlers } = makeCtx({
      archivedIds: ['p'],
      headers,
      agents: IDLE_PC,
      sessionPersistence: { locate: (header) => ({ path: path.join(artifacts.paths[header.id], 'session.jsonl.zstd') }) },
      ledger,
    })
    const res = response()
    await withExecutorStub({
      trashPath: async (target) => { if (path.basename(target) === 'c') throw new Error('gio: not found') },
      moveToQuarantine: async () => { throw new Error('EXDEV') },
    }, async () => {
      await handlers.get('/api/session-manager/delete')(request('p'), res)
    })
    assert.equal(res.status, 200)
    assert.equal(res.body.partial, true)
    assert.equal(res.body.message, '已移入回收站,但重挂载记录失败;父会话已删除,1 个子会话未完全清理')
    assert.equal(res.body.cascade.failed.length, 1)
  } finally {
    await artifacts.cleanup()
  }
})
