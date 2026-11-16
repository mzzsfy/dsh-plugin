// 路由层 BDD(mock ctx 强制 cordis 注入语义):宿主上下文上任何未声明 inject 的
// 服务属性访问一律抛 cannot get property ... without inject,与 cordis reflect 行为
// 一致,防止 inject 声明缺失回归。peer 依赖未安装的仓库环境(禁止 install)下整文件跳过。

import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtemp, rm, readFile, writeFile, readdir } from 'node:fs/promises'
import { mkdtempSync, rmSync } from 'node:fs'
import { createHash } from 'node:crypto'
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
const MESSAGES = indexModule.MESSAGES
const dependencyReady = typeof apply === 'function'
const skipMissingDeps = { skip: dependencyReady ? false : 'peer 依赖未安装,路由层测试跳过' }
const {
  HISTORY_SCOPES,
  HISTORY_INPUT_LIMIT,
  HISTORY_INPUT_MAX_CHARS,
  HISTORY_EXTRACT_VERSION,
  HISTORY_PROMPTS_MAX,
  HISTORY_SESSION_SCAN_LIMIT,
  HISTORY_STARTUP_SCAN_LIMIT,
} = await import('../src/core.mjs')
const { ensureCacheDir, updatePrompts, writeWorkspaceCache } = await import('../src/history-cache.mjs')

// 插件激活即跑历史缓存启动对齐:所有测试统一隔离缓存目录,
// 防止夹具工作区经默认路径(~/.dsh/historyPrompt)泄漏进真实用户目录
const sharedCacheDir = mkdtempSync(path.join(tmpdir(), 'cx-hist-shared-'))
process.env.DSH_HISTORY_CACHE_DIR = sharedCacheDir
// 各 makeCtx 的 effect disposer 统一卸载:启动对齐定时器不可清理则套件尾部
// 固定多等 30s(事件循环被 timer 拖住)
const effectDisposers = []
test.after(() => {
  for (const disposer of effectDisposers) {
    try { disposer() } catch { /* 逐个卸载,单个失败不阻断其余清理 */ }
  }
  rmSync(sharedCacheDir, { recursive: true, force: true })
})

function makeCtx({
  headers,
  agents,
  sessionPersistence,
  settingsValue,
  settingsGetError,
  readSessions,
  readSession,
  configRef,
  configEditor,
  settingsService: settingsServiceOverride,
  liveSessions,
  listSessionsError,
}) {
  const routes = []
  const pendingInjects = []
  const settingsState = { value: settingsValue }
  // settingsServiceOverride(0.1.7 形态桩,如仅 update 的 forms 面)优先;
  // 缺省时构造 legacy 方法面桩(get/register/update 命名空间语义)
  const settingsService = settingsServiceOverride ?? {
    // settingsGetError 注入读取期故障:验证 respondError 的系统级错误收敛分支
    get: () => {
      if (settingsGetError) throw settingsGetError
      return settingsState.value
    },
    register: () => ({ resolved: undefined }),
    // 宿主 update 为异步串行:合并进微任务队列后生效,读旧值发生在 flush 前
    update: (ns, patch) => new Promise((resolve) => queueMicrotask(() => {
      settingsState.value = { ...(settingsState.value || {}), ...patch }
      resolve()
    })),
  }
  // readSession 桩:sessionId → 事件数组(工厂形态则调用后抛错);reads 记录实际读取次数供缓存断言
  const readCounts = new Map()
  let listSessionsCalls = 0
  const sessionQuery = {
    listSessions: async () => {
      listSessionsCalls += 1
      if (listSessionsError) throw listSessionsError
      return headers.map((header) => ({ header }))
    },
    readSession: async (sessionId) => {
      readCounts.set(sessionId, (readCounts.get(sessionId) || 0) + 1)
      if (readSession) return readSession(sessionId)
      const events = readSessions ? readSessions[sessionId] : undefined
      if (typeof events === 'function') throw events()
      if (events === undefined) throw new Error('桩未配置该会话产物')
      return { session: headers.find((header) => header.id === sessionId), events }
    },
  }
  const services = {
    webServer: { register: (route) => routes.push(route) },
    sessionQuery,
    // 活会话注册表桩:get 返回 { header },与宿主 SessionStore 同形
    sessions: { get: (sessionId) => (liveSessions ? liveSessions.get(sessionId) : undefined) },
  }
  const base = {
    // disposer 收集进全局清单,test.after 统一执行:启动对齐的 30s 延迟定时器
    // 不清理则套件尾部固定多等 30s(无 force-exit 时事件循环被 timer 拖住)
    effect: (fn) => {
      const disposer = fn()
      if (typeof disposer === 'function') effectDisposers.push(disposer)
    },
    inject: (_deps, fn) => { pendingInjects.push(fn) },
    // fiber 桩:0.1.7 configure 装配以本条目 fiber 为 owner
    fiber: { entry: { options: { id: 'context-manager', name: '@mzzsfy/dsh-context-manager' } } },
    get: (name) => {
      if (name === 'configEditor') return configEditor
      return { agents, sessionPersistence, settings: settingsService }[name]
    },
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
    logger: base.logger,
    readCounts,
    listSessionsCalls: () => listSessionsCalls,
    // 模拟宿主 settings 服务激活:触发 inject 回调(注册)
    activateSettings: () => {
      while (pendingInjects.length > 0) {
        pendingInjects.shift()({
          settings: settingsService,
          // 注入上下文的 effect 桩:0.1.7 分支经它注册 configure 装配
          effect(fn) {
            const disposer = fn()
            if (typeof disposer === 'function') effectDisposers.push(disposer)
          },
        })
      }
    },
  }
}

function response() {
  const state = { status: undefined, body: undefined }
  state.writeHead = (status) => { state.status = status }
  state.end = (text) => { state.body = JSON.parse(text) }
  return state
}

test('进程树终止:taskkill spawn 带 windowsHide/error 监听,spawn 失败不冒泡', skipMissingDeps, () => {
  const { killTree } = indexModule
  const calls = []
  const listeners = {}
  const fakeChild = {
    on(event, listener) { listeners[event] = listener; return fakeChild },
    unref() {},
  }
  const spawnImpl = (command, args, options) => {
    calls.push({ command, args, options })
    return fakeChild
  }
  killTree(4321, { spawnImpl, platform: 'win32' })
  assert.equal(calls.length, 1)
  assert.equal(calls[0].command, 'taskkill')
  assert.deepEqual(calls[0].args, ['/pid', '4321', '/T', '/F'])
  assert.equal(calls[0].options.windowsHide, true, 'taskkill 不得闪窗')
  assert.equal(typeof listeners.error, 'function', '必须监听 spawn error,否则 ENOENT 成为未捕获异常')
  assert.doesNotThrow(() => listeners.error(new Error('ENOENT')))
  assert.doesNotThrow(() => killTree(1, { spawnImpl: () => { throw new Error('spawn failed') }, platform: 'win32' }))
})

// ── 历史输入路由(GET /api/context/inputs;工作区持久缓存)──

function getRequest(query) {
  const req = new EventEmitter()
  req.method = 'GET'
  req.url = '/api/context/inputs' + query
  return req
}

function getRequest2(url, method) {
  const req = new EventEmitter()
  req.method = method
  req.url = url
  return req
}

function request(sessionId, method = 'POST') {
  const req = new EventEmitter()
  req.method = method
  req.headers = { 'content-type': 'application/json' }
  if (method !== 'GET') {
    process.nextTick(() => {
      req.emit('data', Buffer.from(JSON.stringify({ sessionId })))
      req.emit('end')
    })
  }
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

// 后台对齐是异步的:轮询等待响应满足条件(默认 aligned 翻真,可断言数据就绪)。
// predicate 可为异步(如等待缓存文件被清除),每轮之间留 100ms 给后台车道推进
async function requestUntil(handlers, query, predicate, maxMs = 3000) {
  for (let waited = 0; waited <= maxMs; waited += 100) {
    const res = response()
    await handlers.get('/api/context/inputs')(getRequest(query), res)
    if (await predicate(res.body)) return res
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error('条件未满足: ' + query)
}

function requestUntilAligned(handlers, query) {
  return requestUntil(handlers, query, (body) => body.aligned)
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

// POST 原始体夹具:发非法 JSON / 非 JSON content-type 用
async function postRaw(handlers, routePath, raw, headers = { 'content-type': 'application/json' }) {
  const req = new EventEmitter()
  req.method = 'POST'
  req.url = routePath
  req.headers = headers
  const res = response()
  const done = handlers.get(routePath)(req, res)
  req.emit('data', Buffer.from(raw, 'utf8'))
  req.emit('end')
  await done
  return res
}

// 每个测试独占临时缓存目录:插件 factory 在 makeCtx 时读取 env 解析缓存目录。
// 后台对齐 fire-and-forget,测试结束仍在写目录——清理重试躲开 Windows 文件占用
async function withHistoryCacheDir(run) {
  const cacheDir = await mkdtemp(path.join(tmpdir(), 'cx-hist-'))
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

function workspaceCacheFile(dir, cwd) {
  return path.join(dir, 'x-' + createHash('sha1').update(cwd).digest('hex').slice(0, 8) + '.json')
}

test('inject 声明覆盖路由层触及的全部宿主服务(cordis 未声明即抛 cannot get property)', skipMissingDeps, () => {
  for (const service of ['webServer', 'agents', 'sessionQuery', 'sessionPersistence', 'sessions']) {
    assert.ok(declaredInject.includes(service), `inject 缺少 "${service}"`)
  }
})

// ── 历史输入路由:会话头解析成本(收藏/当前会话不得触发全量清单扫描)──

test('历史输入路由:收藏范围不解析会话头(零全量清单扫描)', skipMissingDeps, async () => {
  await withHistoryCacheDir(async (cacheDir) => {
    const { handlers, listSessionsCalls } = makeCtx({
      headers: [],
      agents: new Map(),
      listSessionsError: new Error('收藏范围不应扫描会话清单'),
    })
    await updatePrompts(cacheDir, () => [{ text: '收藏的提示词', at: 123 }])
    const res = response()
    // 收藏是全局文件,与会话存在性无关:未知 sessionId 也照常返回
    await handlers.get('/api/context/inputs')(getRequest('?sessionId=ghost&scope=prompts'), res)
    assert.equal(res.status, 200)
    assert.deepEqual(res.body, { inputs: [{ text: '收藏的提示词', at: 123 }], aligned: true })
    assert.equal(listSessionsCalls(), 0)
  })
})

test('历史输入路由:当前会话头取自活会话注册表,零全量清单扫描', skipMissingDeps, async () => {
  await withHistoryCacheDir(async (cacheDir) => {
    const dir = await mkdtemp(path.join(tmpdir(), 'cx-hist-live-'))
    const artifactPath = path.join(dir, 'session.jsonl.zstd')
    await writeFile(artifactPath, 'log-bytes')
    try {
      const { stat } = await import('node:fs/promises')
      const info = await stat(artifactPath)
      await ensureCacheDir(cacheDir)
      await writeWorkspaceCache(cacheDir, 'C:\\x', {
        entries: [{ text: '活会话输入', at: 100, sid: 's1' }],
        extracts: {
          s1: { v: HISTORY_EXTRACT_VERSION, mtimeMs: info.mtimeMs, size: info.size, entries: [{ text: '活会话输入', at: 100 }] },
        },
      })
      const { handlers, listSessionsCalls } = makeCtx({
        headers: [],
        agents: new Map(),
        // 活会话注册表命中(浮层所在会话必然在册):header 仅供 cwd 归属,
        // 全量清单扫描无论何种理由都不应发生
        liveSessions: new Map([['s1', { header: { id: 's1', cwd: 'C:\\x', createdAt: 0 } }]]),
        sessionPersistence: { locate: () => ({ path: artifactPath }) },
        listSessionsError: new Error('活会话头不应回落全量清单'),
      })
      const res = response()
      await handlers.get('/api/context/inputs')(getRequest('?sessionId=s1&scope=session'), res)
      assert.equal(res.status, 200)
      assert.deepEqual(res.body, { inputs: [{ text: '活会话输入', at: 100, sid: 's1' }], aligned: true })
      assert.equal(listSessionsCalls(), 0)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

test('历史输入路由:工作区缓存已存在时,当前会话范围只做本会话聚焦对齐', skipMissingDeps, async () => {
  await withHistoryCacheDir(async (cacheDir) => {
    const dir = await mkdtemp(path.join(tmpdir(), 'cx-hist-nobulk-'))
    const artifactOf = (header) => path.join(dir, header.id + '.jsonl.zstd')
    await writeFile(artifactOf({ id: 's1' }), 'log-s1')
    await writeFile(artifactOf({ id: 's2' }), 'log-s2')
    try {
      // 缓存已建立(邻居条目在册):当前会话请求无需再扫邻居
      await ensureCacheDir(cacheDir)
      await writeWorkspaceCache(cacheDir, 'C:\\x', {
        entries: [{ text: '邻居会话输入', at: 200, sid: 's2' }],
        extracts: {},
      })
      const { handlers, readCounts } = makeCtx({
        headers: [
          { id: 's1', cwd: 'C:\\x', createdAt: 0 },
          { id: 's2', cwd: 'C:\\x', createdAt: 0 },
        ],
        agents: new Map(),
        sessionPersistence: { locate: (header) => ({ path: artifactOf(header) }) },
        readSessions: {
          s1: [userMessageEvent('目标会话输入', 100)],
          s2: [userMessageEvent('邻居会话输入', 200)],
        },
      })
      const res = await requestUntil(handlers, '?sessionId=s1&scope=session',
        (body) => body.aligned && body.inputs.some((item) => item.text === '目标会话输入'))
      assert.deepEqual(res.body.inputs.map((item) => item.text), ['目标会话输入'])
      assert.equal(readCounts.get('s2'), undefined, '当前会话范围不得解压其他会话产物')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

test('历史输入路由:session 范围取 extracts 全集,不受工作区 200 条截断', skipMissingDeps, async () => {
  await withHistoryCacheDir(async (cacheDir) => {
    const dir = await mkdtemp(path.join(tmpdir(), 'cx-hist-extract-'))
    const artifactPath = path.join(dir, 's1.jsonl.zstd')
    await writeFile(artifactPath, 'log-bytes')
    try {
      const { stat } = await import('node:fs/promises')
      const info = await stat(artifactPath)
      const full = Array.from({ length: HISTORY_INPUT_LIMIT + 30 }, (_, index) => ({ text: '会话输入' + index, at: index + 1 }))
      await ensureCacheDir(cacheDir)
      // 全局 entries 已按工作区 200 条截断:老会话 s1 只剩最早一条;
      // 该会话全量在 extracts.s1.entries(每会话独立指纹记录)
      await writeWorkspaceCache(cacheDir, 'C:\\x', {
        entries: [{ text: '会话输入0', at: 1, sid: 's1' }],
        extracts: {
          s1: { v: HISTORY_EXTRACT_VERSION, mtimeMs: info.mtimeMs, size: info.size, entries: full },
        },
      })
      const { handlers } = makeCtx({
        headers: [{ id: 's1', cwd: 'C:\\x', createdAt: 0 }],
        agents: new Map(),
        sessionPersistence: { locate: () => ({ path: artifactPath }) },
        readSessions: { s1: [] },
      })
      const res = response()
      await handlers.get('/api/context/inputs')(getRequest('?sessionId=s1&scope=session'), res)
      assert.equal(res.status, 200)
      assert.ok(res.body.inputs.length >= HISTORY_INPUT_LIMIT, 'session 范围应有完整 200 条窗口')
      assert.equal(res.body.inputs[0].text, '会话输入' + (HISTORY_INPUT_LIMIT + 29), '保留最新条目')
      assert.ok(res.body.inputs.some((item) => item.text === '会话输入150'), '不得只剩全局截断后的最早一条')
      assert.equal(res.body.inputs.some((item) => item.text === '会话输入' + (HISTORY_INPUT_LIMIT + 30)), false, '超出上限的更新条目被截断')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

test('历史输入路由:产物尚未落盘(指纹缺失)退回整工作区对齐,不空转', skipMissingDeps, async () => {
  await withHistoryCacheDir(async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'cx-hist-unmaterialized-'))
    try {
      const { handlers } = makeCtx({
        headers: [
          { id: 's1', cwd: 'C:\\x', createdAt: 0 },
          { id: 's2', cwd: 'C:\\x', createdAt: 0 },
        ],
        agents: new Map(),
        // 新会话首轮:产物未落盘,stat 为空——无从判断新鲜度,批量对齐是唯一可取数据路径
        sessionPersistence: { locate: (header) => ({ path: path.join(dir, header.id + '.jsonl.zstd') }) },
        readSessions: {
          s1: [userMessageEvent('首轮输入', 100)],
          s2: [userMessageEvent('邻居输入', 200)],
        },
      })
      const res = await requestUntil(handlers, '?sessionId=s1&scope=session',
        (body) => body.aligned && body.inputs.some((item) => item.text === '首轮输入'))
      assert.deepEqual(res.body.inputs.map((item) => item.text), ['首轮输入'])
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

test('历史输入路由:巨产物会话首开且工作区缓存缺失时仍建缓存,浮层不停在未对齐', skipMissingDeps, async () => {
  await withHistoryCacheDir(async (cacheDir) => {
    const dir = await mkdtemp(path.join(tmpdir(), 'cx-hist-oversize-'))
    const artifactPath = path.join(dir, 'session.jsonl.zstd')
    // 超过巨产物跳过线的产物:聚焦对齐整段跳过,缓存缺失时只有批量对齐能建缓存
    await writeFile(artifactPath, Buffer.alloc(20 * 1024 * 1024))
    try {
      const { handlers } = makeCtx({
        headers: [
          { id: 's1', cwd: 'C:\\x', createdAt: 0 },
          { id: 's2', cwd: 'C:\\x', createdAt: 0 },
        ],
        agents: new Map(),
        sessionPersistence: { locate: (header) => ({ path: header.id === 's1' ? artifactPath : path.join(dir, 's2.jsonl.zstd') }) },
        readSessions: {
          s1: [userMessageEvent('巨产物输入', 100)],
          s2: [userMessageEvent('可对齐输入', 200)],
        },
      })
      const res = await requestUntil(handlers, '?sessionId=s1&scope=session', (body) => body.aligned)
      assert.equal(res.body.aligned, true, '巨产物会话跳过聚焦后仍须经批量对齐落地为已对齐')
      assert.deepEqual(res.body.inputs, [], '巨产物自身不入缓存,列表为空而非报错')
      const cached = JSON.parse(await readFile(workspaceCacheFile(cacheDir, 'C:\\x'), 'utf8'))
      assert.ok(cached, '工作区缓存已建立')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

// ── 历史输入路由:范围/对齐/缓存 ──

test('历史输入路由:首次 aligned=false 触发后台对齐,对齐后三范围正确且 session 按 sid 过滤', skipMissingDeps, async () => {
  await withHistoryCacheDir(async () => {
    const { handlers } = makeHistoryCtx()
    const first = response()
    await handlers.get('/api/context/inputs')(getRequest('?sessionId=s1&scope=workspace'), first)
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
  await withHistoryCacheDir(async (cacheDir) => {
    await ensureCacheDir(cacheDir)
    await writeWorkspaceCache(cacheDir, 'C:\\x', {
      entries: [
        { text: '更早的输入', at: 100, sid: 's1' },
        // 另一个仍有来源的会话的旧条目:合并时不得丢(已删除会话的条目见下一条用例)
        { text: '第二条的旧条目', at: 50, sid: 's2' },
      ],
      extracts: {},
    })
    const { handlers } = makeHistoryCtx()
    const res = await requestUntil(handlers, '?sessionId=s1&scope=workspace',
      (body) => body.aligned && body.inputs.some((item) => item.text === '最新输入'))
    assert.deepEqual(res.body.inputs.map((item) => item.text), ['最新输入', '第二条', '更早的输入', '第二条的旧条目'])
    const sessionRes = await requestUntil(handlers, '?sessionId=s1&scope=session',
      (body) => body.aligned && body.inputs.some((item) => item.text === '最新输入'))
    assert.deepEqual(sessionRes.body.inputs.map((item) => item.text), ['最新输入', '更早的输入'])
  })
})

test('历史输入路由:已删除会话的输入在对齐时清除,磁盘缓存与响应都不再保留', skipMissingDeps, async () => {
  await withHistoryCacheDir(async (cacheDir) => {
    // 缓存里留着已删除会话 gone 的两条输入(它不在宿主清单里):旧版本靠时间挤出,
    // 而 gone 的最早条目会被聚合首条保护永久钉住
    await ensureCacheDir(cacheDir)
    await writeWorkspaceCache(cacheDir, 'C:\\x', {
      entries: [
        { text: '已删除会话开场', at: 1, sid: 'gone' },
        { text: '已删除会话最近', at: 800, sid: 'gone' },
        { text: '存活会话输入', at: 100, sid: 's1' },
        // 无 sid 的早期条目无从判归属,保留
        { text: '无溯源旧条目', at: 50 },
      ],
      extracts: { gone: { v: HISTORY_EXTRACT_VERSION, mtimeMs: 0, size: 0, entries: [{ text: '已删除会话最近', at: 800 }] } },
    })
    const { handlers } = makeCtx({
      headers: [{ id: 's1', cwd: 'C:\\x', createdAt: 0 }],
      agents: new Map(),
      readSessions: { s1: [userMessageEvent('存活会话输入', 100)] },
    })
    const res = await requestUntil(handlers, '?sessionId=s1&scope=workspace',
      (body) => body.aligned && body.inputs.every((item) => item.sid !== 'gone'))
    assert.deepEqual(res.body.inputs.map((item) => item.text), ['存活会话输入', '无溯源旧条目'])
    const cached = JSON.parse(await readFile(workspaceCacheFile(cacheDir, 'C:\\x'), 'utf8'))
    assert.equal(cached.entries.some((entry) => entry.sid === 'gone'), false, '已删除会话条目已从缓存清除')
    assert.equal(cached.extracts.gone, undefined, '已删除会话提取记录一并清除')
  })
})

test('历史输入路由:已删除会话的开场条目不再被首条保护钉在 limit 之外', skipMissingDeps, async () => {
  await withHistoryCacheDir(async (cacheDir) => {
    // 存活会话的新条目填满 200 条窗口:旧实现里 gone 的最早条目由首条保护追加在
    // 截断之后,永远留在浮层里(时间挤出对它无效)
    const live = Array.from({ length: HISTORY_INPUT_LIMIT }, (_, index) => ({ text: '存活输入' + index, at: 1000 + index, sid: 's1' }))
    await ensureCacheDir(cacheDir)
    await writeWorkspaceCache(cacheDir, 'C:\\x', {
      entries: [{ text: '已删除会话开场', at: 1, sid: 'gone' }, ...live],
      extracts: {},
    })
    const { handlers } = makeCtx({
      headers: [{ id: 's1', cwd: 'C:\\x', createdAt: 0 }],
      agents: new Map(),
      readSessions: { s1: live.map((entry) => userMessageEvent(entry.text, entry.at)) },
    })
    const res = await requestUntil(handlers, '?sessionId=s1&scope=workspace',
      (body) => body.aligned && body.inputs.every((item) => item.sid !== 'gone'))
    assert.equal(res.body.inputs.length, HISTORY_INPUT_LIMIT, 'limit 之外只有存活会话首条保护,不追加已删除会话条目')
    assert.equal(res.body.inputs.some((item) => item.text === '已删除会话开场'), false)
  })
})

test('历史输入路由:窗口外的存活会话条目不被白名单误删(白名单取全量主会话)', skipMissingDeps, async () => {
  await withHistoryCacheDir(async (cacheDir) => {
    // 101 个存活主会话:最老的 s0 落在扫描窗口外,其既有条目不参与重解压但必须保留
    const total = HISTORY_SESSION_SCAN_LIMIT + 1
    const headers = Array.from({ length: total }, (_, index) => ({ id: 's' + (total - 1 - index), cwd: 'C:\\x', createdAt: 0 }))
    const oldest = 's0'
    await ensureCacheDir(cacheDir)
    await writeWorkspaceCache(cacheDir, 'C:\\x', {
      entries: [{ text: '窗口外老会话输入', at: 10, sid: oldest }],
      extracts: {},
    })
    const readSessions = {}
    for (let index = 1; index < total; index += 1) readSessions['s' + index] = [userMessageEvent('输入' + index, 1000 + index)]
    const { handlers, readCounts } = makeCtx({ headers, agents: new Map(), readSessions })
    const res = await requestUntil(handlers, '?sessionId=s1&scope=workspace',
      (body) => body.aligned && body.inputs.some((item) => item.text === '输入1'))
    assert.ok(res.body.inputs.some((item) => item.text === '窗口外老会话输入'), '窗口外存活会话的既有条目不得被白名单剔除')
    assert.equal(readCounts.get(oldest), undefined, '窗口外会话不再重解压')
  })
})

test('历史输入路由:工作区会话全被删除后缓存整份清除,不残留在全部工作区范围', skipMissingDeps, async () => {
  await withHistoryCacheDir(async (cacheDir) => {
    // C:\x 的会话已被删除(清单里没有该 cwd 的会话),它的缓存只能由 global 轮询清理
    await writeWorkspaceCache(cacheDir, 'C:\\x', {
      entries: [{ text: '已删除会话输入', at: 500, sid: 'gone' }],
      extracts: {},
    })
    const { handlers } = makeCtx({
      headers: [{ id: 's3', cwd: 'C:\\other', createdAt: 0 }],
      agents: new Map(),
      readSessions: { s3: [userMessageEvent('别的工作区输入', 900)] },
    })
    // 先让 C:\other 建缓存,global 才有对照:只剩它的条目,不得混入已删除工作区的残留
    await requestUntilAligned(handlers, '?sessionId=s3&scope=workspace')
    const res = await requestUntil(handlers, '?sessionId=s3&scope=global',
      (body) => body.aligned && body.inputs.every((item) => item.text !== '已删除会话输入'))
    assert.deepEqual(res.body.inputs.map((item) => item.text), ['别的工作区输入'], '全局范围不得再聚合已删除工作区的残留')
    // 删除而非写空:空文件会留在 global 轮询的缓存清单里反复触发该工作区对齐
    const cacheFile = workspaceCacheFile(cacheDir, 'C:\\x')
    assert.equal((await readdir(cacheDir)).includes(path.basename(cacheFile)), false, '缓存文件整份移除')
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
    await handlers.get('/api/context/inputs')(getRequest('?sessionId=ghost'), unknown)
    assert.equal(unknown.status, 400)
    assert.equal(unknown.body.error, '会话不存在')
    const wrongMethod = response()
    await handlers.get('/api/context/inputs')(request('s1'), wrongMethod)
    assert.equal(wrongMethod.status, 405)
    const missing = response()
    await handlers.get('/api/context/inputs')(getRequest(''), missing)
    assert.equal(missing.status, 400)
  })
})

test('历史输入路由:损坏会话对齐跳过不中断;无 cwd 会话 workspace/session 返回空且 aligned', skipMissingDeps, async () => {
  await withHistoryCacheDir(async () => {
    const { handlers, logger } = makeCtx({
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
    await handlers.get('/api/context/inputs')(getRequest('?sessionId=nocwd&scope=workspace'), noCwdWorkspace)
    assert.deepEqual(noCwdWorkspace.body, { inputs: [], aligned: true })
    const noCwdSession = response()
    await handlers.get('/api/context/inputs')(getRequest('?sessionId=nocwd&scope=session'), noCwdSession)
    assert.deepEqual(noCwdSession.body, { inputs: [], aligned: true })
  })
})

test('历史输入路由:运行中会话参与对齐(实时追加),缓存上限裁剪保留最新', skipMissingDeps, async () => {
  await withHistoryCacheDir(async () => {
    const agents = new Map([['running1', { status: 'running' }]])
    const manyEvents = Array.from({ length: HISTORY_INPUT_LIMIT + 50 }, (_, i) => userMessageEvent('运行输入' + i, 1000 + i))
    const { handlers, readCounts } = makeCtx({
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
      (body) => body.aligned && body.inputs.length === HISTORY_INPUT_LIMIT + 1)
    const texts = res.body.inputs.map((item) => item.text)
    // 运行中会话输入量远超上限:limit 之外仅追加该会话去重后最早一条(s1 首条已在 limit 内)
    assert.equal(texts.length, HISTORY_INPUT_LIMIT + 1)
    assert.ok(texts.includes('历史输入'), '最新既有输入保留')
    assert.ok(texts.includes('运行输入' + (HISTORY_INPUT_LIMIT + 49)), '次新运行输入保留')
    assert.ok(texts.includes('运行输入0'), '运行中会话最早输入受首条保护')
    assert.ok(!texts.includes('运行输入1'), '首条之外的旧输入仍被上限裁剪')
    assert.ok(readCounts.get('running1') >= 1, '运行中会话被对齐解压')
    const sessionRes = await requestUntilAligned(handlers, '?sessionId=running1&scope=session')
    assert.ok(sessionRes.body.inputs.length > 0, 'session 范围可取运行中会话自身输入')
  })
})

test('历史输入路由:运行→停止后产物再追加,session 范围不得停在停止前内存快照', skipMissingDeps, async () => {
  await withHistoryCacheDir(async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'cx-hist-stop-'))
    const artifactPath = path.join(dir, 'session.jsonl.zstd')
    await writeFile(artifactPath, 'log-v1')
    try {
      const agents = new Map([['s1', { status: 'running' }]])
      const readSessions = { s1: [userMessageEvent('运行中输入', 100)] }
      const { handlers, readCounts } = makeCtx({
        headers: [{ id: 's1', cwd: 'C:\\x', createdAt: 0 }],
        agents,
        sessionPersistence: { locate: () => ({ path: artifactPath }) },
        readSessions,
      })
      // 运行中:提取结果只进内存(runtimeExtracts),不落 extracts
      const running = await requestUntilAligned(handlers, '?sessionId=s1&scope=session')
      assert.deepEqual(running.body.inputs.map((item) => item.text), ['运行中输入'])
      // 停止后宿主 flush 出最终尾段(产物增长),内存记录不再更新
      agents.set('s1', { status: 'idle' })
      readSessions.s1 = [userMessageEvent('运行中输入', 100), userMessageEvent('停止后输入', 200)]
      await writeFile(artifactPath, 'log-v1-plus-final-tail')
      const afterStop = response()
      await handlers.get('/api/context/inputs')(getRequest('?sessionId=s1&scope=session'), afterStop)
      assert.equal(afterStop.body.aligned, true, '聚焦对齐完成即对齐')
      assert.deepEqual(afterStop.body.inputs.map((item) => item.text), ['停止后输入', '运行中输入'],
        '停止后必须读产物最终态,内存快照不得盖住停止后追加的尾部')
      const readsAfterStop = readCounts.get('s1')
      // 产物未再变化:磁盘 extracts 指纹命中,后续请求零解压
      const steady = response()
      await handlers.get('/api/context/inputs')(getRequest('?sessionId=s1&scope=session'), steady)
      assert.deepEqual(steady.body.inputs.map((item) => item.text), ['停止后输入', '运行中输入'])
      assert.equal(readCounts.get('s1'), readsAfterStop, '停止后指纹已落盘,稳定读取不再解压')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

test('历史输入路由:后端无 stat/locate 观测能力时不 400,session 范围逐次重读并自建缓存', skipMissingDeps, async () => {
  await withHistoryCacheDir(async (cacheDir) => {
    const readSessions = { s1: [userMessageEvent('第一轮输入', 100)] }
    const { handlers, logger } = makeCtx({
      headers: [{ id: 's1', cwd: 'C:\\x', createdAt: 0 }],
      agents: new Map(),
      // 第三方后端不提供 stat/locate:旧实现直调 locate 抛 TypeError,请求被打成 400
      sessionPersistence: {},
      readSessions,
    })
    const first = response()
    await handlers.get('/api/context/inputs')(getRequest('?sessionId=s1&scope=session'), first)
    assert.equal(first.status, 200, '定位能力缺失不得拒绝请求')
    assert.equal(first.body.aligned, true, '聚焦对齐落定即对齐')
    assert.deepEqual(first.body.inputs.map((item) => item.text), ['第一轮输入'])
    // 无指纹可判新鲜度:每次请求重新读取产物(否则新输入永远不可见)
    readSessions.s1 = [userMessageEvent('第一轮输入', 100), userMessageEvent('第二轮输入', 200)]
    const second = response()
    await handlers.get('/api/context/inputs')(getRequest('?sessionId=s1&scope=session'), second)
    assert.equal(second.body.aligned, true)
    assert.deepEqual(second.body.inputs.map((item) => item.text), ['第二轮输入', '第一轮输入'])
    assert.ok(logger.warns.some((line) => line.includes('locate')), '定位降级必须落 warn,不得静默')
    const cached = JSON.parse(await readFile(workspaceCacheFile(cacheDir, 'C:\\x'), 'utf8'))
    assert.ok(cached.extracts.s1, '聚焦对齐自建 extracts 记录(无指纹也保留该会话全集)')
  })
})

test('历史输入路由:locate 抛错按不可定位降级,workspace/session 两路径均不中断', skipMissingDeps, async () => {
  await withHistoryCacheDir(async () => {
    const { handlers, logger } = makeCtx({
      headers: [{ id: 's1', cwd: 'C:\\x', createdAt: 0 }],
      agents: new Map(),
      // locate 方法在场但抛错(部分后端按 header 形态抛):私有钩子异常不得打断对齐
      sessionPersistence: { locate: () => { throw new TypeError('locate is not a function') } },
      readSessions: { s1: [userMessageEvent('无定位输入', 100)] },
    })
    const workspace = await requestUntilAligned(handlers, '?sessionId=s1&scope=workspace')
    assert.deepEqual(workspace.body.inputs.map((item) => item.text), ['无定位输入'], '批量对齐走无指纹路径')
    const session = response()
    await handlers.get('/api/context/inputs')(getRequest('?sessionId=s1&scope=session'), session)
    assert.equal(session.status, 200)
    assert.equal(session.body.aligned, true)
    assert.deepEqual(session.body.inputs.map((item) => item.text), ['无定位输入'])
    assert.ok(logger.warns.some((line) => line.includes('stat/locate')), '观测能力缺失必须可见(warn)')
  })
})

test('历史输入路由:旧代产物(migration-required)经 stat 快照指向真实历史文件,不落空指纹', skipMissingDeps, async () => {
  await withHistoryCacheDir(async (cacheDir) => {
    const dir = await mkdtemp(path.join(tmpdir(), 'cx-oldgen-'))
    try {
      // 旧代真实产物:历史代文件名与当前代不同;locate 按当前代拼出的路径不存在
      const oldPath = path.join(dir, 's1.session.v3.jsonl')
      const oldBody = '{"header":1}\n{"event":0}\n'
      await writeFile(oldPath, oldBody)
      const bogusPath = path.join(dir, 's1.session.v4.jsonl.zstd')
      let locateCalls = 0
      const snapshots = [{
        header: { id: 's1', cwd: 'C:\\x', createdAt: 0 },
        formatStatus: 'migration-required',
        revision: 'rev-old',
        sizeBytes: Buffer.byteLength(oldBody),
        location: { kind: 'jsonl', path: oldPath },
      }]
      const sessionPersistence = {
        stat: async (id) => snapshots.find((snapshot) => snapshot.header.id === String(id)),
        list: async () => snapshots,
        locate: () => { locateCalls += 1; return { kind: 'jsonl', path: bogusPath } },
      }
      const { handlers, readCounts } = makeCtx({
        headers: [{ id: 's1', cwd: 'C:\\x', createdAt: 0 }],
        agents: new Map(),
        sessionPersistence,
        readSessions: { s1: [userMessageEvent('旧代输入', 100)] },
      })
      const first = await requestUntilAligned(handlers, '?sessionId=s1&scope=workspace')
      assert.deepEqual(first.body.inputs.map((item) => item.text), ['旧代输入'])
      const cached = JSON.parse(await readFile(workspaceCacheFile(cacheDir, 'C:\\x'), 'utf8'))
      assert.ok(cached.extracts.s1.mtimeMs > 0, '旧代产物指纹必须取真实文件 mtime,不得占位 0')
      assert.equal(cached.extracts.s1.size, Buffer.byteLength(oldBody), '指纹 size 取真实历史文件大小')
      const readsAfterBulk = readCounts.get('s1')
      const session = response()
      await handlers.get('/api/context/inputs')(getRequest('?sessionId=s1&scope=session'), session)
      assert.equal(session.body.aligned, true)
      assert.equal(readCounts.get('s1'), readsAfterBulk, 'stat 快照指纹命中后不得重解压')
      assert.equal(locateCalls, 0, '公共 stat/list 可用时不得调用私有 locate')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

test('历史输入路由:后端仅提供公共 list 快照时,旧代产物同样建立真实指纹', skipMissingDeps, async () => {
  await withHistoryCacheDir(async (cacheDir) => {
    const dir = await mkdtemp(path.join(tmpdir(), 'cx-oldgen-list-'))
    try {
      const oldPath = path.join(dir, 's1.session.v3.jsonl')
      const oldBody = '{"header":1}\n{"event":0}\n'
      await writeFile(oldPath, oldBody)
      const snapshot = {
        header: { id: 's1', cwd: 'C:\\x', createdAt: 0 },
        formatStatus: 'migration-required',
        revision: 'rev-old',
        sizeBytes: Buffer.byteLength(oldBody),
        location: { kind: 'jsonl', path: oldPath },
      }
      const { handlers } = makeCtx({
        headers: [{ id: 's1', cwd: 'C:\\x', createdAt: 0 }],
        agents: new Map(),
        sessionPersistence: { list: async () => [snapshot] },
        readSessions: { s1: [userMessageEvent('仅 list 快照输入', 100)] },
      })
      const first = await requestUntilAligned(handlers, '?sessionId=s1&scope=workspace')
      assert.deepEqual(first.body.inputs.map((item) => item.text), ['仅 list 快照输入'])
      const cached = JSON.parse(await readFile(workspaceCacheFile(cacheDir, 'C:\\x'), 'utf8'))
      assert.ok(cached.extracts.s1.mtimeMs > 0, '仅 list 快照也须用真实文件 mtime 建指纹')
      assert.equal(cached.extracts.s1.size, Buffer.byteLength(oldBody))
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

test('历史输入路由:再次请求读缓存不再解压产物(对齐节流内)', skipMissingDeps, async () => {
  await withHistoryCacheDir(async () => {
    const { handlers, readCounts } = makeCtx({
      headers: [{ id: 's1', cwd: 'C:\\x', createdAt: 0 }],
      agents: new Map(),
      readSessions: { s1: [userMessageEvent('工作区输入', 100)] },
    })
    await requestUntilAligned(handlers, '?sessionId=s1&scope=workspace')
    const readsAfterAlign = readCounts.get('s1')
    const second = response()
    await handlers.get('/api/context/inputs')(getRequest('?sessionId=s1&scope=workspace'), second)
    assert.deepEqual(second.body.inputs.map((item) => item.text), ['工作区输入'])
    assert.equal(second.body.aligned, true)
    assert.equal(readCounts.get('s1'), readsAfterAlign, '读路径不得解压产物')
  })
})

test('历史输入路由:会话产物变化即席聚焦对齐,单次请求内拿到新输入(首条<3s)', skipMissingDeps, async () => {
  await withHistoryCacheDir(async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'cx-hist-focus-'))
    const artifactPath = path.join(dir, 'session.jsonl.zstd')
    await writeFile(artifactPath, 'log-v1')
    try {
      const shared = {
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
      await second.handlers.get('/api/context/inputs')(getRequest('?sessionId=s1&scope=session'), res)
      assert.equal(res.body.aligned, true, '焦点对齐快于等待时限,首请求即就绪')
      assert.deepEqual(res.body.inputs.map((item) => item.text), ['新输入XYZ', '旧输入'])
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

test('HC3 Given stale bulk read and new focus commit, When bulk finishes, Then acknowledged focus input survives', skipMissingDeps, async () => {
  await withHistoryCacheDir(async (cacheDir) => {
    const artifact = path.join(cacheDir, 'artifact')
    await writeFile(artifact, 'old')
    const started = Promise.withResolvers(), release = Promise.withResolvers()
    const shared = { headers: [{ id: 's1', cwd: 'C:\\x', createdAt: 0 }], agents: new Map(), sessionPersistence: { locate: () => ({ path: artifact }) } }
    const old = makeCtx({ ...shared, readSession: async () => { started.resolve(); await release.promise; return { events: [userMessageEvent('old', 100)] } } })
    const initial = response()
    await old.handlers.get('/api/context/inputs')(getRequest('?sessionId=s1&scope=workspace'), initial)
    await started.promise
    await writeFile(artifact, 'new-longer')
    const newer = makeCtx({ ...shared, readSessions: { s1: [userMessageEvent('old', 100), userMessageEvent('new', 200)] } })
    try {
      const focus = response()
      await newer.handlers.get('/api/context/inputs')(getRequest('?sessionId=s1&scope=session'), focus)
      assert.ok(focus.body.inputs.some((item) => item.text === 'new'))
    } finally { release.resolve() }
    // 两个车道仍独立;等待旧批量路径写回完成后核对磁盘。
    await requestUntil(old.handlers, '?sessionId=s1&scope=workspace', (body) => body.aligned)
    await new Promise((resolve) => setTimeout(resolve, 50))
    const cached = JSON.parse(await readFile(workspaceCacheFile(cacheDir, 'C:\\x'), 'utf8'))
    assert.ok(cached.entries.some((item) => item.text === 'new'), '旧bulk不得覆写已确认新输入')
    assert.equal(cached.extracts.s1.size, 'new-longer'.length, '旧指纹不得覆盖新提交')
  })
})

test('历史输入路由:聚焦对齐只更新目标会话,不抹其他会话的持久 extracts', skipMissingDeps, async () => {
  await withHistoryCacheDir(async (cacheDir) => {
    const dir = await mkdtemp(path.join(tmpdir(), 'cx-hist-prune-'))
    const artifactPath = path.join(dir, 'session.jsonl.zstd')
    await writeFile(artifactPath, 'log-v1')
    try {
      await ensureCacheDir(cacheDir)
      await writeWorkspaceCache(cacheDir, 'C:\\x', {
        entries: [{ text: '更早的输入', at: 100, sid: 's1' }],
        extracts: { s2: { mtimeMs: 1, size: 2, entries: [{ text: '邻居会话输入', at: 50 }] } },
      })
      const { handlers } = makeCtx({
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
      const cached = JSON.parse(await readFile(workspaceCacheFile(cacheDir, 'C:\\x'), 'utf8'))
      assert.ok(cached.extracts.s2, '邻居会话 extracts 不得被聚焦对齐抹掉')
      assert.ok(cached.extracts.s1, '目标会话 extracts 已更新')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

test('历史输入路由:产物未变的会话跨对齐零解压(磁盘 extracts 指纹命中)', skipMissingDeps, async () => {
  await withHistoryCacheDir(async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'cx-hist-art-'))
    const artifactPath = path.join(dir, 'session.jsonl.zstd')
    await writeFile(artifactPath, 'log-bytes')
    try {
      const { handlers, readCounts } = makeCtx({
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
        headers: [{ id: 's1', cwd: 'C:\\x', createdAt: 0 }],
        agents: new Map(),
        sessionPersistence: { locate: (header) => ({ path: artifactPath }) },
        readSessions: { s1: [userMessageEvent('工作区输入', 100)] },
      })
      // 同一缓存目录(env 未变,withHistoryCacheDir 复用):指纹命中 → 零解压
      const second = response()
      await handlers2.get('/api/context/inputs')(getRequest('?sessionId=s1&scope=workspace'), second)
      assert.equal(second.body.aligned, true)
      assert.deepEqual(second.body.inputs.map((item) => item.text), ['工作区输入'])
      // 触发一次对齐(绕过节流:新 ctx 节流 Map 为空,请求即触发)
      await new Promise((resolve) => setTimeout(resolve, 300))
      assert.equal(readCounts2.get('s1'), undefined, '产物未变,重启后对齐零解压')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

test('历史输入路由:旧版本提取缓存自动重解压(命令历史自愈)', skipMissingDeps, async () => {
  await withHistoryCacheDir(async (cacheDir) => {
    const dir = await mkdtemp(path.join(tmpdir(), 'cx-hist-ver-'))
    const artifactPath = path.join(dir, 'session.jsonl.zstd')
    await writeFile(artifactPath, 'log-bytes')
    try {
      const { stat } = await import('node:fs/promises')
      const info = await stat(artifactPath)
      await ensureCacheDir(cacheDir)
      // 预置旧版本提取器写下的缓存:指纹与产物一致但条目缺命令输入(无 v 字段)
      await writeWorkspaceCache(cacheDir, 'C:\\x', {
        entries: [{ text: '旧输入', at: 100, sid: 's1' }],
        extracts: {
          s1: { mtimeMs: info.mtimeMs, size: info.size, entries: [{ text: '旧输入', at: 100 }] },
        },
      })
      const commandEvent = {
        type: 'command/run',
        seq: 2,
        time: 200,
        data: { commandId: 'c1', name: 'goal', args: ' 收尾', source: { kind: 'user' } },
      }
      const { handlers, readCounts } = makeCtx({
        headers: [{ id: 's1', cwd: 'C:\\x', createdAt: 0 }],
        agents: new Map(),
        sessionPersistence: { locate: (header) => ({ path: artifactPath }) },
        readSessions: { s1: [userMessageEvent('旧输入', 100), commandEvent] },
      })
      const res = await requestUntil(handlers, '?sessionId=s1&scope=workspace',
        (body) => body.aligned && body.inputs.some((item) => item.text === '/goal 收尾'))
      assert.ok(readCounts.get('s1') >= 1, '版本不符触发重解压')
      assert.deepEqual(res.body.inputs.map((item) => item.text), ['/goal 收尾', '旧输入'])
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

test('历史输入路由:session 范围版本不符判 stale,聚焦对齐首请求内补齐', skipMissingDeps, async () => {
  await withHistoryCacheDir(async (cacheDir) => {
    const dir = await mkdtemp(path.join(tmpdir(), 'cx-hist-ver2-'))
    const artifactPath = path.join(dir, 'session.jsonl.zstd')
    await writeFile(artifactPath, 'log-bytes')
    try {
      const { stat } = await import('node:fs/promises')
      const info = await stat(artifactPath)
      await ensureCacheDir(cacheDir)
      // 预置旧版本缓存:指纹与产物一致(不改条目则指纹校验判新鲜)但缺 v 字段
      await writeWorkspaceCache(cacheDir, 'C:\\x', {
        entries: [{ text: '旧输入', at: 100, sid: 's1' }],
        extracts: {
          s1: { mtimeMs: info.mtimeMs, size: info.size, entries: [{ text: '旧输入', at: 100 }] },
        },
      })
      const commandEvent = {
        type: 'command/run',
        seq: 2,
        time: 200,
        data: { commandId: 'c1', name: 'goal', args: ' 收尾', source: { kind: 'user' } },
      }
      const { handlers, readCounts } = makeCtx({
        headers: [{ id: 's1', cwd: 'C:\\x', createdAt: 0 }],
        agents: new Map(),
        sessionPersistence: { locate: (header) => ({ path: artifactPath }) },
        readSessions: { s1: [userMessageEvent('旧输入', 100), commandEvent] },
      })
      // 首请求即 aligned:true 且含命令条目——版本不符走聚焦对齐,单次请求内补齐
      const res = await requestUntil(handlers, '?sessionId=s1&scope=session',
        (body) => body.aligned && body.inputs.some((item) => item.text === '/goal 收尾'))
      assert.equal(res.body.aligned, true, '聚焦对齐快于等待时限,首请求即就绪')
      assert.deepEqual(res.body.inputs.map((item) => item.text), ['/goal 收尾', '旧输入'])
      assert.ok(readCounts.get('s1') >= 1, '版本不符触发聚焦重解压')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

// ── 历史输入路由:窗口与 subagent 排除 ──

test('历史输入路由:启动对齐只回溯最近 STARTUP_SCAN 个会话,老会话不解压', skipMissingDeps, async () => {
  await withHistoryCacheDir(async () => {
    const total = HISTORY_STARTUP_SCAN_LIMIT + 20
    // 宿主 listSessions 为最新在前:数组首元素即最新会话
    const headers = Array.from({ length: total }, (_, i) => ({ id: 's' + (total - 1 - i), cwd: 'C:\\x', createdAt: 0 }))
    const readSessions = {}
    for (let i = 0; i < total; i++) readSessions['s' + i] = [userMessageEvent('输入' + i, 1000 + i)]
    const { handlers, readCounts } = makeCtx({ headers, agents: new Map(), readSessions })
    // 触发对齐(请求工作区),等队列排空后窗口外老会话(s0..s19)不得被解压
    await requestUntil(handlers, '?sessionId=s' + (total - 1) + '&scope=workspace',
      (body) => body.aligned && body.inputs.length > 0)
    assert.equal(readCounts.get('s0'), undefined, '窗口外最老会话不被启动对齐解压')
    assert.ok(readCounts.get('s' + (total - 1)) >= 1, '窗口内最新会话被解压')
  })
})

test('历史输入路由:窗口排除 subagent 会话——不解压、条目不入浮层', skipMissingDeps, async () => {
  await withHistoryCacheDir(async () => {
    // subagent 会话在宿主列表中更新更近(排最前):若不排除将挤占窗口并收录其输入
    const headers = [
      { id: 'sub1', cwd: 'C:\\x', createdAt: 0, origin: 'subagent' },
      { id: 's1', cwd: 'C:\\x', createdAt: 0 },
    ]
    const { handlers, readCounts } = makeCtx({
      headers,
      agents: new Map(),
      readSessions: {
        sub1: [userMessageEvent('子代理任务提示', 100)],
        s1: [userMessageEvent('人类输入', 200)],
      },
    })
    const res = await requestUntil(handlers, '?sessionId=s1&scope=workspace',
      (body) => body.aligned && body.inputs.some((item) => item.text === '人类输入'))
    assert.equal(res.body.inputs.some((item) => item.text === '子代理任务提示'), false, 'subagent 输入不入浮层')
    assert.equal(readCounts.get('sub1'), undefined, 'subagent 产物不被解压')
  })
})

test('历史输入路由:子 agent 会话自身请求返回空且已对齐,不触碰产物', skipMissingDeps, async () => {
  await withHistoryCacheDir(async () => {
    for (const derived of [
      { origin: 'subagent', parentSession: 'root', delegationDepth: 1 },
      { parentSession: 'root', delegationDepth: 1 },
    ]) {
      const { handlers, readCounts } = makeCtx({
        headers: [{ id: 'sub1', cwd: 'C:\\x', createdAt: 0, ...derived }, { id: 's1', cwd: 'C:\\x', createdAt: 0 }],
        agents: new Map(),
        readSessions: { sub1: [userMessageEvent('子代理任务提示', 100)] },
      })
      const res = response()
      await handlers.get('/api/context/inputs')(getRequest('?sessionId=sub1&scope=session'), res)
      assert.equal(res.status, 200)
      assert.deepEqual(res.body, { inputs: [], aligned: true })
      assert.equal(readCounts.get('sub1'), undefined, '子会话产物不被解压')
    }
  })
})

test('历史输入路由:子会话视图下 workspace/global 照常聚合,只有 session 范围置空', skipMissingDeps, async () => {
  await withHistoryCacheDir(async (cacheDir) => {
    await ensureCacheDir(cacheDir)
    await writeWorkspaceCache(cacheDir, 'C:\\x', {
      entries: [{ text: '人类输入', at: 200, sid: 's1' }],
      extracts: {},
    })
    const { handlers } = makeCtx({
      headers: [
        { id: 'sub1', cwd: 'C:\\x', createdAt: 0, origin: 'subagent' },
        { id: 's1', cwd: 'C:\\x', createdAt: 0 },
      ],
      agents: new Map(),
      readSessions: { sub1: [userMessageEvent('子代理任务提示', 100)] },
      // 缓存已建时 workspace 范围直接读缓存;后台对齐会碰 s1 产物,给它空产物即可
      sessionPersistence: { locate: () => ({ path: 'C:\\nonexistent.jsonl.zstd' }) },
    })
    for (const scope of ['workspace', 'global']) {
      const res = response()
      await handlers.get('/api/context/inputs')(getRequest('?sessionId=sub1&scope=' + scope), res)
      assert.equal(res.status, 200, scope)
      assert.equal(res.body.aligned, true, scope + ' 应已对齐')
      assert.ok(res.body.inputs.some((item) => item.text === '人类输入'), scope + ' 不得被子会话请求整体置空')
    }
    const sessionRes = response()
    await handlers.get('/api/context/inputs')(getRequest('?sessionId=sub1&scope=session'), sessionRes)
    assert.deepEqual(sessionRes.body, { inputs: [], aligned: true }, 'session 范围仍应置空')
  })
})


test('历史输入路由:窗口放宽后最近 SCAN 个主会话全部参与对齐(超过旧 20 窗口)', skipMissingDeps, async () => {
  await withHistoryCacheDir(async () => {
    const total = HISTORY_SESSION_SCAN_LIMIT + 10
    const headers = Array.from({ length: total }, (_, i) => ({ id: 's' + (total - 1 - i), cwd: 'C:\\x', createdAt: 0 }))
    const readSessions = {}
    for (let i = 0; i < total; i++) readSessions['s' + i] = [userMessageEvent('输入' + i, 1000 + i)]
    const { handlers, readCounts } = makeCtx({ headers, agents: new Map(), readSessions })
    // 第 SCAN 个会话(旧窗口外)的输入必须可入浮层
    const boundary = 's' + (total - HISTORY_SESSION_SCAN_LIMIT)
    await requestUntil(handlers, '?sessionId=' + boundary + '&scope=workspace',
      (body) => body.aligned && body.inputs.some((item) => item.text === '输入' + (total - HISTORY_SESSION_SCAN_LIMIT)))
    assert.ok(readCounts.get(boundary) >= 1, '窗口边界会话被解压')
    assert.equal(readCounts.get('s0'), undefined, '窗口外最老会话不解压')
  })
})

test('历史输入路由:既往误收录的 subagent 条目在对齐时自愈清除', skipMissingDeps, async () => {
  await withHistoryCacheDir(async (cacheDir) => {
    // 预置被旧版本污染的缓存:subagent 条目已在 entries 中
    const cacheFile = workspaceCacheFile(cacheDir, 'C:\\x')
    await writeFile(cacheFile, JSON.stringify({
      cwd: 'C:\\x',
      entries: [
        { text: '子代理任务提示', at: 100, sid: 'sub1' },
        { text: '人类输入', at: 200, sid: 's1' },
      ],
      extracts: {},
    }), 'utf8')
    const headers = [
      { id: 'sub1', cwd: 'C:\\x', createdAt: 0, origin: 'subagent' },
      { id: 's1', cwd: 'C:\\x', createdAt: 0 },
    ]
    const { handlers } = makeCtx({
      headers,
      agents: new Map(),
      readSessions: { s1: [userMessageEvent('人类输入', 200)] },
    })
    // 对齐完成前请求直接返回预置缓存(aligned 且含目标文本):必须等到污染条目消失
    const res = await requestUntil(handlers, '?sessionId=s1&scope=workspace',
      (body) => body.aligned && body.inputs.some((item) => item.text === '人类输入')
        && !body.inputs.some((item) => item.text === '子代理任务提示'))
    assert.deepEqual(res.body.inputs.map((item) => item.text), ['人类输入'])
  })
})

test('历史输入路由:subagent 排最前不挤占窗口——第 SCAN 个主会话仍被解压', skipMissingDeps, async () => {
  await withHistoryCacheDir(async () => {
    // 锁定 filter 先于 slice:若先 slice 再 filter,sub1 占一槽后 s1(第 SCAN 个主会话)落窗外
    const headers = [
      { id: 'sub1', cwd: 'C:\\x', createdAt: 0, origin: 'subagent' },
      ...Array.from({ length: HISTORY_SESSION_SCAN_LIMIT }, (_, i) => ({ id: 's' + (HISTORY_SESSION_SCAN_LIMIT - i), cwd: 'C:\\x', createdAt: 0 })),
    ]
    const readSessions = {}
    for (let i = 1; i <= HISTORY_SESSION_SCAN_LIMIT; i++) readSessions['s' + i] = [userMessageEvent('输入' + i, 1000 + i)]
    const { handlers, readCounts } = makeCtx({ headers, agents: new Map(), readSessions })
    await requestUntil(handlers, '?sessionId=s1&scope=workspace',
      (body) => body.aligned && body.inputs.some((item) => item.text === '输入1'))
    assert.ok(readCounts.get('s1') >= 1, '第 SCAN 个主会话在窗内被解压')
    assert.equal(readCounts.get('sub1'), undefined, 'subagent 仍不被解压')
  })
})

// ── 常用提示词 ──

for (const sameText of [false, true]) {
  test(`HC${sameText ? 2 : 1} Given two live instances, When toggles overlap, Then acknowledged changes serialize (same=${sameText})`, skipMissingDeps, async () => {
    await withHistoryCacheDir(async () => {
      const make = () => makeCtx({ headers: [{ id: 's1', cwd: 'C:\\x', createdAt: 0 }], agents: new Map(), readSessions: {} })
      const a = make(), b = make()
      const results = await Promise.all([
        postJson(a.handlers, '/api/context/prompts/toggle', { text: 'A' }),
        postJson(b.handlers, '/api/context/prompts/toggle', { text: sameText ? 'A' : 'B' }),
      ])
      assert.deepEqual(results.map((res) => res.status), [200, 200])
      assert.deepEqual(results.map((res) => res.body.collected), sameText ? [true, false] : [true, true])
      const res = response()
      await a.handlers.get('/api/context/inputs')(getRequest('?sessionId=s1&scope=prompts'), res)
      assert.deepEqual(res.body.inputs.map((item) => item.text).sort(), sameText ? [] : ['A', 'B'])
    })
  })
}


test('常用提示词:toggle 收藏/取消,prompts 范围可见,与工作区缓存互不污染', skipMissingDeps, async () => {
  await withHistoryCacheDir(async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'cx-hist-prompts-'))
    const artifactPath = path.join(dir, 'session.jsonl.zstd')
    try {
      await writeFile(artifactPath, 'log-v1')
      const { handlers } = makeCtx({
        headers: [{ id: 's1', cwd: 'C:\\x', createdAt: 0 }],
        agents: new Map(),
        sessionPersistence: { locate: (header) => ({ path: artifactPath }) },
        readSessions: { s1: [userMessageEvent('历史输入A', 100)] },
      })
      // 初始为空
      const empty = response()
      await handlers.get('/api/context/inputs')(getRequest('?sessionId=s1&scope=prompts'), empty)
      assert.deepEqual(empty.body.inputs, [])
      // 收藏 → prompts 可见;工作区范围不混入
      await postJson(handlers, '/api/context/prompts/toggle', { text: '常用句子X' })
      const listed = response()
      await handlers.get('/api/context/inputs')(getRequest('?sessionId=s1&scope=prompts'), listed)
      assert.deepEqual(listed.body.inputs.map((item) => item.text), ['常用句子X'])
      const workspace = await requestUntil(handlers, '?sessionId=s1&scope=workspace',
        (body) => body.aligned && body.inputs.some((item) => item.text === '历史输入A'))
      assert.equal(workspace.body.inputs.some((item) => item.text === '常用句子X'), false, '收藏不混入工作区历史')
      // 再 toggle = 取消
      await postJson(handlers, '/api/context/prompts/toggle', { text: '常用句子X' })
      const cleared = response()
      await handlers.get('/api/context/inputs')(getRequest('?sessionId=s1&scope=prompts'), cleared)
      assert.deepEqual(cleared.body.inputs, [])
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

test('常用提示词:超长截断、上限裁剪、空 text 拒绝', skipMissingDeps, async () => {
  await withHistoryCacheDir(async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'cx-hist-prompts-cap-'))
    const artifactPath = path.join(dir, 'session.jsonl.zstd')
    try {
      await writeFile(artifactPath, 'log-v1')
      const { handlers } = makeCtx({
        headers: [{ id: 's1', cwd: 'C:\\x', createdAt: 0 }],
        agents: new Map(),
        sessionPersistence: { locate: (header) => ({ path: artifactPath }) },
        readSessions: { s1: [userMessageEvent('占位', 100)] },
      })
      await requestUntilAligned(handlers, '?sessionId=s1&scope=prompts')
      // 空白文本拒绝
      const blank = await postJson(handlers, '/api/context/prompts/toggle', { text: '   ' })
      assert.equal(blank.status, 400)
      // 截断:HISTORY_INPUT_MAX_CHARS 以上裁到上限
      const long = '长'.repeat(HISTORY_INPUT_MAX_CHARS + 10)
      await postJson(handlers, '/api/context/prompts/toggle', { text: long })
      const listed = response()
      await handlers.get('/api/context/inputs')(getRequest('?sessionId=s1&scope=prompts'), listed)
      assert.equal(listed.body.inputs[0].text.length, HISTORY_INPUT_MAX_CHARS)
      await postJson(handlers, '/api/context/prompts/toggle', { text: '长'.repeat(HISTORY_INPUT_MAX_CHARS) })
      // 上限:超过 HISTORY_PROMPTS_MAX 后最旧被裁
      for (let i = 0; i < HISTORY_PROMPTS_MAX + 1; i++) {
        await postJson(handlers, '/api/context/prompts/toggle', { text: '条目' + i })
      }
      const capped = response()
      await handlers.get('/api/context/inputs')(getRequest('?sessionId=s1&scope=prompts'), capped)
      assert.equal(capped.body.inputs.length, HISTORY_PROMPTS_MAX)
      assert.equal(capped.body.inputs.some((item) => item.text === '条目0'), false, '最旧条目被裁掉')
      assert.equal(capped.body.inputs[0].text, '条目' + HISTORY_PROMPTS_MAX, '最新条目在顶部')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

// ── 常用提示词:自定义顺序(拖动排序)──

test('常用提示词:超限淘汰收藏最旧的一条,不按尾部截断(顺序可自定义)', skipMissingDeps, async () => {
  await withHistoryCacheDir(async (cacheDir) => {
    const { handlers } = makeCtx({ headers: [], agents: new Map() })
    // 满额文件:at 递增造出"最旧",再把它挪到中间,尾部放较新的条目
    const items = Array.from({ length: HISTORY_PROMPTS_MAX }, (_, index) => ({ text: '旧' + index, at: 1000 + index }))
    const [oldest] = items.splice(0, 1)
    items.splice(50, 0, oldest)
    await writeFile(path.join(cacheDir, 'prompts.json'), JSON.stringify({ items }), 'utf8')
    await postJson(handlers, '/api/context/prompts/toggle', { text: '新收藏' })
    const res = response()
    await handlers.get('/api/context/inputs')(getRequest('?sessionId=s1&scope=prompts'), res)
    const texts = res.body.inputs.map((item) => item.text)
    assert.equal(texts.length, HISTORY_PROMPTS_MAX)
    assert.equal(texts[0], '新收藏', '新收藏置顶')
    assert.equal(texts.includes('旧0'), false, '淘汰收藏最旧的一条,而非尾部一条')
    assert.deepEqual(texts.slice(1, 4), ['旧1', '旧2', '旧3'], '其余条目顺序保持')
  })
})

test('常用提示词:prompts 范围按文件顺序呈现,不再按收藏时间倒序', skipMissingDeps, async () => {
  await withHistoryCacheDir(async (cacheDir) => {
    const { handlers } = makeCtx({ headers: [], agents: new Map() })
    // 直接落盘一个自定义顺序:顺序与收藏时间解耦
    await updatePrompts(cacheDir, () => [
      { text: '第三条最先', at: 300 },
      { text: '最早收藏但居中', at: 100 },
      { text: '中间收藏但最后', at: 200 },
    ])
    const res = response()
    await handlers.get('/api/context/inputs')(getRequest('?sessionId=s1&scope=prompts'), res)
    assert.deepEqual(res.body.inputs.map((item) => item.text), ['第三条最先', '最早收藏但居中', '中间收藏但最后'])
  })
})

test('常用提示词:reorder 按提交顺序持久化,回包与 GET 同步反映新顺序', skipMissingDeps, async () => {
  await withHistoryCacheDir(async (cacheDir) => {
    const { handlers } = makeCtx({ headers: [], agents: new Map() })
    for (const text of ['A', 'B', 'C']) await postJson(handlers, '/api/context/prompts/toggle', { text })
    // toggle 为 unshift:文件顺序 C,B,A(最新收藏在顶部)
    const before = response()
    await handlers.get('/api/context/inputs')(getRequest('?sessionId=s1&scope=prompts'), before)
    assert.deepEqual(before.body.inputs.map((item) => item.text), ['C', 'B', 'A'])
    const moved = await postJson(handlers, '/api/context/prompts/reorder', { texts: ['A', 'C', 'B'] })
    assert.equal(moved.status, 200)
    assert.deepEqual(moved.body.texts, ['A', 'C', 'B'], '回包为服务端实际顺序')
    const after = response()
    await handlers.get('/api/context/inputs')(getRequest('?sessionId=s1&scope=prompts'), after)
    assert.deepEqual(after.body.inputs.map((item) => item.text), ['A', 'C', 'B'])
    // 落盘核对:顺序持久化,收藏时间戳原样保留(时间列仍有意义)
    const stored = JSON.parse(await readFile(path.join(cacheDir, 'prompts.json'), 'utf8'))
    assert.deepEqual(stored.items.map((item) => item.text), ['A', 'C', 'B'])
    assert.ok(stored.items.every((item) => typeof item.at === 'number'), '重排不得丢失收藏时间')
  })
})

test('常用提示词:reorder 未提及条目保尾(陈旧顺序不丢数据),未知文本忽略', skipMissingDeps, async () => {
  await withHistoryCacheDir(async () => {
    const { handlers } = makeCtx({ headers: [], agents: new Map() })
    for (const text of ['A', 'B', 'C']) await postJson(handlers, '/api/context/prompts/toggle', { text })
    const res = await postJson(handlers, '/api/context/prompts/reorder', { texts: ['C', '另一窗口新增的条目'] })
    assert.equal(res.status, 200)
    // C 命中置顶,未提及的 B、A 按原相对序保尾
    assert.deepEqual(res.body.texts, ['C', 'B', 'A'])
  })
})

test('常用提示词:reorder 空顺序不改动,非法形态一律 400', skipMissingDeps, async () => {
  await withHistoryCacheDir(async () => {
    const { handlers } = makeCtx({ headers: [], agents: new Map() })
    for (const text of ['A', 'B']) await postJson(handlers, '/api/context/prompts/toggle', { text })
    const empty = await postJson(handlers, '/api/context/prompts/reorder', { texts: [] })
    assert.equal(empty.status, 200)
    assert.deepEqual(empty.body.texts, ['B', 'A'], '空顺序不改动既有顺序')
    for (const body of [{}, { texts: 'A' }, { texts: [1, 'A'] }, { texts: [null] }]) {
      const res = await postJson(handlers, '/api/context/prompts/reorder', body)
      assert.equal(res.status, 400, JSON.stringify(body) + ' 应拒绝')
    }
  })
})

test('常用提示词:rename 原位替换文本,顺序与收藏时间不变', skipMissingDeps, async () => {
  await withHistoryCacheDir(async (cacheDir) => {
    const { handlers } = makeCtx({ headers: [], agents: new Map() })
    await updatePrompts(cacheDir, () => [
      { text: '首条', at: 300 },
      { text: '旧名', at: 100 },
      { text: '末条', at: 200 },
    ])
    const res = await postJson(handlers, '/api/context/prompts/rename', { from: '旧名', to: '新名' })
    assert.equal(res.status, 200)
    assert.equal(res.body.result, 'renamed')
    const stored = JSON.parse(await readFile(path.join(cacheDir, 'prompts.json'), 'utf8'))
    assert.deepEqual(stored.items, [
      { text: '首条', at: 300 },
      { text: '新名', at: 100 },
      { text: '末条', at: 200 },
    ], '重命名保留位置与收藏时间,不再置顶')
  })
})

test('常用提示词:rename 清空即删除,目标已存在合并,源不存在返回 missing', skipMissingDeps, async () => {
  await withHistoryCacheDir(async (cacheDir) => {
    const { handlers } = makeCtx({ headers: [], agents: new Map() })
    const seed = async () => updatePrompts(cacheDir, () => [
      { text: 'A', at: 1 },
      { text: 'B', at: 2 },
      { text: 'C', at: 3 },
    ])
    await seed()
    const removed = await postJson(handlers, '/api/context/prompts/rename', { from: 'B', to: '' })
    assert.equal(removed.body.result, 'removed')
    let stored = JSON.parse(await readFile(path.join(cacheDir, 'prompts.json'), 'utf8'))
    assert.deepEqual(stored.items.map((item) => item.text), ['A', 'C'])
    await seed()
    const merged = await postJson(handlers, '/api/context/prompts/rename', { from: 'A', to: 'C' })
    assert.equal(merged.body.result, 'merged')
    stored = JSON.parse(await readFile(path.join(cacheDir, 'prompts.json'), 'utf8'))
    assert.deepEqual(stored.items, [{ text: 'B', at: 2 }, { text: 'C', at: 3 }], '合并保留既有条目与位置')
    const missing = await postJson(handlers, '/api/context/prompts/rename', { from: '不存在', to: 'X' })
    assert.equal(missing.status, 200)
    assert.equal(missing.body.result, 'missing')
  })
})

test('常用提示词:rename 空 from 400,GET 405', skipMissingDeps, async () => {
  await withHistoryCacheDir(async () => {
    const { handlers } = makeCtx({ headers: [], agents: new Map() })
    for (const body of [{}, { from: '   ', to: 'X' }, { from: 1, to: 'X' }]) {
      const res = await postJson(handlers, '/api/context/prompts/rename', body)
      assert.equal(res.status, 400, JSON.stringify(body) + ' 应拒绝')
    }
    const wrongMethod = response()
    await handlers.get('/api/context/prompts/rename')(getRequest('?sessionId=s1'), wrongMethod)
    assert.equal(wrongMethod.status, 405)
  })
})

test('常用提示词:历史超载文件一次新增即裁剪到上限,不逐条收敛', skipMissingDeps, async () => {
  await withHistoryCacheDir(async (cacheDir) => {
    const { handlers } = makeCtx({ headers: [], agents: new Map() })
    // 手改/旧版遗留的超载文件:超出上限 5 条,越靠后 at 越大(越新)
    const items = Array.from({ length: HISTORY_PROMPTS_MAX + 5 }, (_, index) => ({ text: '旧' + index, at: 1000 + index }))
    await writeFile(path.join(cacheDir, 'prompts.json'), JSON.stringify({ items }), 'utf8')
    await postJson(handlers, '/api/context/prompts/toggle', { text: '新收藏' })
    const stored = JSON.parse(await readFile(path.join(cacheDir, 'prompts.json'), 'utf8'))
    assert.equal(stored.items.length, HISTORY_PROMPTS_MAX, '一次新增即裁剪到上限,不再只删一条')
    assert.equal(stored.items[0].text, '新收藏', '新收藏置顶')
    assert.deepEqual(stored.items.slice(1, 3).map((item) => item.text), ['旧6', '旧7'], '保留条目原序不变')
    assert.equal(stored.items.some((item) => item.text === '旧5'), false, '淘汰的是收藏时间最旧的几条')
  })
})

test('常用提示词:自定义顺序下新收藏仍插最前,既有相对顺序不变', skipMissingDeps, async () => {
  await withHistoryCacheDir(async () => {
    const { handlers } = makeCtx({ headers: [], agents: new Map() })
    for (const text of ['A', 'B', 'C']) await postJson(handlers, '/api/context/prompts/toggle', { text })
    await postJson(handlers, '/api/context/prompts/reorder', { texts: ['A', 'C', 'B'] })
    await postJson(handlers, '/api/context/prompts/toggle', { text: 'D' })
    const res = response()
    await handlers.get('/api/context/inputs')(getRequest('?sessionId=s1&scope=prompts'), res)
    assert.deepEqual(res.body.inputs.map((item) => item.text), ['D', 'A', 'C', 'B'])
  })
})

// ── 路由层横切守卫:方法白名单 / JSON 体 / 系统级错误收敛 / 非字符串 text ──

test('横切守卫:12 条路由方法白名单,白名单外一律 405', skipMissingDeps, async () => {
  await withHistoryCacheDir(async () => {
    const { handlers } = makeCtx({ headers: [{ id: 's1', cwd: 'C:\\x', createdAt: 0 }], agents: new Map() })
    const getOnly = '/api/context/inputs'
    const postOnly = ['/api/context/prompts/toggle', '/api/context/prompts/rename', '/api/context/prompts/reorder', '/api/context/git-clone']
    const dualMethods = ['/api/context/history-enabled', '/api/context/history-button-enabled', '/api/context/steer-recall-enabled', '/api/context/fork-enabled', '/api/context/fork-auto-resend-enabled', '/api/context/copy-sid-enabled', '/api/context/clone-enabled']
    assert.equal(1 + postOnly.length + dualMethods.length, 12, '路由总数须与实现一致')
    // GET-only 路由:POST 拒绝
    const inputsPost = response()
    await handlers.get(getOnly)(request('s1'), inputsPost)
    assert.equal(inputsPost.status, 405)
    // POST-only 路由:GET 拒绝
    for (const routePath of postOnly) {
      const toggleGet = response()
      await handlers.get(routePath)(getRequest2(routePath, 'GET'), toggleGet)
      assert.equal(toggleGet.status, 405)
    }
    // 双方法路由(GET+POST):白名单外方法拒绝。写方法的共享闸门先校验 JSON
    // content-type,探针必须带 JSON 头才走到方法白名单(缺头由闸门 400,见 route-gate 用例)
    for (const routePath of dualMethods) {
      const res = response()
      const put = new EventEmitter()
      put.method = 'PUT'
      put.url = routePath
      put.headers = { 'content-type': 'application/json' }
      await handlers.get(routePath)(put, res)
      assert.equal(res.status, 405, routePath + ' 应拒绝 PUT')
    }
  })
})

test('横切守卫:11 条 POST 路由的非法 JSON 请求体统一 400(badJsonBody)', skipMissingDeps, async () => {
  await withHistoryCacheDir(async () => {
    const { handlers } = makeCtx({ headers: [{ id: 's1', cwd: 'C:\\x', createdAt: 0 }], agents: new Map() })
    const postPaths = ['/api/context/prompts/toggle', '/api/context/prompts/rename', '/api/context/prompts/reorder', '/api/context/history-enabled', '/api/context/history-button-enabled', '/api/context/steer-recall-enabled', '/api/context/fork-enabled', '/api/context/fork-auto-resend-enabled', '/api/context/copy-sid-enabled', '/api/context/clone-enabled', '/api/context/git-clone']
    assert.equal(postPaths.length, 11, 'POST 路由数须与实现一致')
    for (const routePath of postPaths) {
      const res = await postRaw(handlers, routePath, '{oops')
      assert.equal(res.status, 400, routePath + ' 非法 JSON 应回 400')
      assert.equal(res.body.error, MESSAGES.badJsonBody)
    }
  })
})

test('横切守卫:POST 跨源 403、非 JSON content-type 400,业务不执行', skipMissingDeps, async () => {
  await withHistoryCacheDir(async () => {
    const { handlers } = makeCtx({ headers: [{ id: 's1', cwd: 'C:\\x', createdAt: 0 }], agents: new Map() })
    const routePath = '/api/context/history-enabled'
    const req = new EventEmitter()
    req.method = 'POST'
    req.url = routePath
    req.headers = { host: '127.0.0.1:3080', origin: 'http://evil.example', 'content-type': 'application/json' }
    const cross = response()
    await handlers.get(routePath)(req, cross)
    assert.equal(cross.status, 403, '跨源写请求必须 403')
    const nonJson = await postRaw(handlers, routePath, '{"enabled":false}', { 'content-type': 'text/plain' })
    assert.equal(nonJson.status, 400, '非 JSON content-type 必须 400')
    const read = response()
    await handlers.get(routePath)(getRequest2(routePath, 'GET'), read)
    assert.equal(read.body.enabled, true, '被拒绝的写请求不得改动设置')
  })
})

test('横切守卫:请求体恰好 64KiB 通过、+1 字节回 413(分块累计边界不偏)', skipMissingDeps, async () => {
  const { readBody } = indexModule
  const { EventEmitter: Emitter } = await import('node:events')
  const BODY_MAX_BYTES = 64 * 1024
  const emitInChunks = (req, totalBytes, chunkBytes) => {
    for (let sent = 0; sent < totalBytes; sent += chunkBytes) {
      req.emit('data', Buffer.alloc(Math.min(chunkBytes, totalBytes - sent), 0x61))
    }
  }
  // 恰好上限:4 × 16KiB 分块累计等于上限,整串送达
  const exact = new Emitter()
  exact.pause = () => {}
  const exactPromise = readBody(exact)
  emitInChunks(exact, BODY_MAX_BYTES, 16 * 1024)
  exact.emit('end')
  const text = await exactPromise
  assert.equal(Buffer.byteLength(text, 'utf8'), BODY_MAX_BYTES, '上限字节必须完整送达')
  // 上限 +1:同样分块路径必须拒绝,且不销毁 socket(响应仍要能送出)
  const over = new Emitter()
  let destroyed = false
  over.destroy = () => { destroyed = true }
  over.pause = () => {}
  const overPromise = readBody(over)
  emitInChunks(over, BODY_MAX_BYTES, 16 * 1024)
  over.emit('data', Buffer.alloc(1))
  await assert.rejects(overPromise, (error) => error.statusCode === 413 && /超过上限/.test(error.message))
  assert.equal(destroyed, false, '超限不得销毁 socket(否则 413 响应送不出)')
})

test('横切守卫:请求体读取时限绑定 30s 真实数值', () => {
  // 半开体用例按常量自身步进假时钟,常量被改小仍会自洽通过;真实时限只在此钉住
  assert.equal(indexModule.BODY_READ_TIMEOUT_MS, 30 * 1000)
})

test('横切守卫:半开体按时限拒绝为 408 超时', skipMissingDeps, async (t) => {
  const { readBody, BODY_READ_TIMEOUT_MS } = indexModule
  const { EventEmitter: Emitter } = await import('node:events')
  // 半开体:data 后既无 end 也无 close,按总时限拒绝
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const stalledReq = new Emitter()
  stalledReq.pause = () => {}
  const stalledPromise = readBody(stalledReq)
  stalledReq.emit('data', Buffer.from('{}'))
  t.mock.timers.tick(BODY_READ_TIMEOUT_MS)
  await assert.rejects(stalledPromise, (error) => error.statusCode === 408 && /超时/.test(error.message))
  t.mock.timers.reset()
})

test('横切守卫:请求 aborted/close(未 complete)按中止拒绝为 400,毫秒级收敛不落到读取时限', skipMissingDeps, async () => {
  const { readBody } = indexModule
  const { EventEmitter: Emitter } = await import('node:events')
  const drive = {
    aborted: (req) => req.emit('aborted'),
    // close 在正常 end 后也会触发:未 complete 才是客户端中途断开
    closed: (req) => { req.complete = false; req.emit('close') },
  }
  // 中止收敛预算:与读取时限差一个量级以上,退化成时限分支时必然超出
  const ABORT_LATENCY_BUDGET_MS = 1 * 1000
  for (const [name, trigger] of Object.entries(drive)) {
    const req = new Emitter()
    req.pause = () => {}
    const started = performance.now()
    const promise = readBody(req)
    trigger(req)
    const error = await promise.then(
      () => assert.fail(`${name} 不得 resolve(悬挂 Promise 会占住 clone 单飞行锁)`),
      (rejected) => rejected,
    )
    const elapsedMs = performance.now() - started
    assert.ok(elapsedMs < ABORT_LATENCY_BUDGET_MS, `${name} 须毫秒级收敛,实测 ${elapsedMs.toFixed(1)}ms`)
    // 400(中止)与 408(时限超时)是两条不同分支:篡改中止监听会退化成 30s 后 408
    assert.equal(error.statusCode, 400, `${name} 应按客户端中止回 400`)
    assert.match(error.message, /请求已中止/)
  }
})

test('横切守卫:带错误码的系统级错误收敛为固定文案并进服务端日志', skipMissingDeps, async () => {
  await withHistoryCacheDir(async () => {
    const settingsGetError = new Error("EACCES: permission denied, open 'C:\\secrets\\settings.json'")
    settingsGetError.code = 'EACCES'
    const { handlers, logger } = makeCtx({
      headers: [{ id: 's1', cwd: 'C:\\x', createdAt: 0 }],
      agents: new Map(),
      settingsGetError,
    })
    const res = response()
    await handlers.get('/api/context/history-enabled')(getRequest2('/api/context/history-enabled', 'GET'), res)
    assert.equal(res.status, 400)
    assert.equal(res.body.error, MESSAGES.systemError, '系统级错误文案必须收敛,不得内嵌绝对路径')
    assert.ok(logger.warns.some((line) => line.includes('EACCES')), '原始错误应仅进服务端日志')
  })
})

test('常用提示词:非字符串 text 一律拒绝;超长文本二次 toggle 幂等(按截断后文本查重)', skipMissingDeps, async () => {
  await withHistoryCacheDir(async () => {
    const { handlers } = makeCtx({ headers: [{ id: 's1', cwd: 'C:\\x', createdAt: 0 }], agents: new Map() })
    for (const body of [{ text: 123 }, { text: null }, {}]) {
      const res = await postJson(handlers, '/api/context/prompts/toggle', body)
      assert.equal(res.status, 400, JSON.stringify(body) + ' 应拒绝')
      assert.equal(res.body.error, 'text 不能为空')
    }
    // 超长文本收藏后再次原样 toggle = 取消(查重基于截断后文本,直调不产生重复收藏)
    const truncated = '长'.repeat(HISTORY_INPUT_MAX_CHARS)
    const first = await postJson(handlers, '/api/context/prompts/toggle', { text: truncated + '超出部分' })
    assert.equal(first.body.collected, true)
    const second = await postJson(handlers, '/api/context/prompts/toggle', { text: truncated })
    assert.equal(second.body.collected, false, '原样超长文本 toggle 应命中截断后文本并取消')
  })
})

test('常用提示词:client 与 core 的 HISTORY_SCOPES 镜像同序同值,默认落点为当前会话', { skip: process.env.TEST_SKIP_PARITY }, async () => {
  const clientSource = await readFile(new URL('../src/client.js', import.meta.url), 'utf8')
  const declared = clientSource.match(/const HISTORY_SCOPES = (\[[^\]]*\])/)
  assert.ok(declared, 'client.js 必须内联声明 HISTORY_SCOPES')
  assert.deepEqual(JSON.parse(declared[1].replace(/'/g, '"')), HISTORY_SCOPES)
  const labels = clientSource.match(/const HISTORY_SCOPE_LABELS = (\[[^\]]*\])/)
  assert.ok(labels, 'client.js 必须内联声明 HISTORY_SCOPE_LABELS')
  assert.equal(JSON.parse(labels[1].replace(/'/g, '"')).length, HISTORY_SCOPES.length, '标签与范围一一对应')
  assert.equal(HISTORY_SCOPES.indexOf('session'), 1, '浮层默认落点为当前会话(索引 1)')
})

// ── 启停开关路由(GET/POST;settings 持久)──

test('历史浮层启停:GET 默认启用,POST 切换经 settings 持久,GET 反映新值', skipMissingDeps, async () => {
  const { handlers } = makeCtx({ headers: [{ id: 's1', cwd: 'C:\\x', createdAt: 0 }], agents: new Map() })
  const initial = response()
  await handlers.get('/api/context/history-enabled')(getRequest2('/api/context/history-enabled', 'GET'), initial)
  assert.equal(initial.body.enabled, true, '默认启用')
  const off = await postJson(handlers, '/api/context/history-enabled', { enabled: false })
  assert.equal(off.body.enabled, false)
  // settings 持久:重读反映关闭态;POST 回 true 恢复
  const reread = response()
  await handlers.get('/api/context/history-enabled')(getRequest2('/api/context/history-enabled', 'GET'), reread)
  assert.equal(reread.body.enabled, false, 'settings 持久化关闭态')
  await postJson(handlers, '/api/context/history-enabled', { enabled: true })
  const restored = response()
  await handlers.get('/api/context/history-enabled')(getRequest2('/api/context/history-enabled', 'GET'), restored)
  assert.equal(restored.body.enabled, true)
})

test('插话撤回启停:GET 默认启用,POST 切换经 settings 持久,GET 反映新值', skipMissingDeps, async () => {
  const { handlers } = makeCtx({ headers: [{ id: 's1', cwd: 'C:\\x', createdAt: 0 }], agents: new Map() })
  const off = await postJson(handlers, '/api/context/steer-recall-enabled', { enabled: false })
  assert.equal(off.body.enabled, false)
  const reread = response()
  await handlers.get('/api/context/steer-recall-enabled')(getRequest2('/api/context/steer-recall-enabled', 'GET'), reread)
  assert.equal(reread.body.enabled, false)
  await postJson(handlers, '/api/context/steer-recall-enabled', { enabled: true })
  const restored = response()
  await handlers.get('/api/context/steer-recall-enabled')(getRequest2('/api/context/steer-recall-enabled', 'GET'), restored)
  assert.equal(restored.body.enabled, true)
})

test('fork 启停:GET 默认启用,POST 切换经 settings 持久,GET 反映新值', skipMissingDeps, async () => {
  const { handlers } = makeCtx({ headers: [{ id: 's1', cwd: 'C:\\x', createdAt: 0 }], agents: new Map() })
  const initial = response()
  await handlers.get('/api/context/fork-enabled')(getRequest2('/api/context/fork-enabled', 'GET'), initial)
  assert.equal(initial.body.enabled, true, '默认启用')
  const off = await postJson(handlers, '/api/context/fork-enabled', { enabled: false })
  assert.equal(off.body.enabled, false)
  const reread = response()
  await handlers.get('/api/context/fork-enabled')(getRequest2('/api/context/fork-enabled', 'GET'), reread)
  assert.equal(reread.body.enabled, false, 'settings 持久化关闭态')
  await postJson(handlers, '/api/context/fork-enabled', { enabled: true })
  const restored = response()
  await handlers.get('/api/context/fork-enabled')(getRequest2('/api/context/fork-enabled', 'GET'), restored)
  assert.equal(restored.body.enabled, true)
})

test('标题栏复制 sessionId 启停:GET 默认启用,POST 切换经 settings 持久,GET 反映新值', skipMissingDeps, async () => {
  const { handlers } = makeCtx({ headers: [{ id: 's1', cwd: 'C:\\x', createdAt: 0 }], agents: new Map() })
  const initial = response()
  await handlers.get('/api/context/copy-sid-enabled')(getRequest2('/api/context/copy-sid-enabled', 'GET'), initial)
  assert.equal(initial.body.enabled, true, '默认启用')
  const off = await postJson(handlers, '/api/context/copy-sid-enabled', { enabled: false })
  assert.equal(off.body.enabled, false)
  const reread = response()
  await handlers.get('/api/context/copy-sid-enabled')(getRequest2('/api/context/copy-sid-enabled', 'GET'), reread)
  assert.equal(reread.body.enabled, false, 'settings 持久化关闭态')
  await postJson(handlers, '/api/context/copy-sid-enabled', { enabled: true })
  const restored = response()
  await handlers.get('/api/context/copy-sid-enabled')(getRequest2('/api/context/copy-sid-enabled', 'GET'), restored)
  assert.equal(restored.body.enabled, true)
})

test('输入框历史按钮启停:GET 默认启用,POST 切换经 settings 持久,GET 反映新值', skipMissingDeps, async () => {
  const { handlers } = makeCtx({ headers: [{ id: 's1', cwd: 'C:\\x', createdAt: 0 }], agents: new Map() })
  const initial = response()
  await handlers.get('/api/context/history-button-enabled')(getRequest2('/api/context/history-button-enabled', 'GET'), initial)
  assert.equal(initial.body.enabled, true, '默认启用')
  const off = await postJson(handlers, '/api/context/history-button-enabled', { enabled: false })
  assert.equal(off.body.enabled, false)
  // settings 持久:重读反映关闭态;POST 回 true 恢复
  const reread = response()
  await handlers.get('/api/context/history-button-enabled')(getRequest2('/api/context/history-button-enabled', 'GET'), reread)
  assert.equal(reread.body.enabled, false, 'settings 持久化关闭态')
  await postJson(handlers, '/api/context/history-button-enabled', { enabled: true })
  const restored = response()
  await handlers.get('/api/context/history-button-enabled')(getRequest2('/api/context/history-button-enabled', 'GET'), restored)
  assert.equal(restored.body.enabled, true)
})

// --- 0.1.7 settings 面双形适配(maintain a913c2c 同构) ---

test('Config 导出契约:根级 volatile 包装,validate 产整节单 ref,默认值对拍', () => {
  // Given 静态 Config 导出(0.1.7 节表单事实源)
  assert.ok(indexModule.Config, 'Config 导出必须在场')
  // When 空配置校验
  const resolved = indexModule.Config['~standard'].validate({})
  // Then 产整节单 ref(get 协议),布尔开关默认全开(forkAutoResend 除外)
  assert.equal(resolved.issues, undefined)
  const section = resolved.value.get()
  assert.equal(section.historyEnabled, true)
  assert.equal(section.forkAutoResendEnabled, false)
  assert.equal(section.copySidEnabled, true)
})

test('0.1.7 形态:settings 无 get/register 时读回落 config ref 节值', skipMissingDeps, async () => {
  // Given settingsForms 只有 update(0.1.7 真实方法面)+ config ref 携带用户值
  const settingsForms = { update: async () => {} }
  const configRef = { get: () => ({ historyEnabled: false, copySidEnabled: false }) }
  const { handlers } = makeCtx({
    headers: [{ id: 's1', cwd: 'C:/x', createdAt: 0 }],
    agents: new Map(),
    settingsService: settingsForms,
    configRef,
  })
  // When GET 开关路由
  const res = response()
  await handlers.get('/api/context/history-enabled')(getRequest2('/api/context/history-enabled', 'GET'), res)
  // Then 返回 config 节值而非默认
  assert.equal(res.body.enabled, false)
})

test('0.1.7 形态:开关 POST 经 configEditor.edit 落 fiber.entry 并回显新值', skipMissingDeps, async () => {
  // Given settingsForms 只有 update + configEditor 桩(合并写回 configStore)
  const settingsForms = { update: async () => {} }
  const configStore = {}
  const editCalls = []
  const configRef = { get: () => ({ ...configStore }) }
  const { handlers } = makeCtx({
    headers: [{ id: 's1', cwd: 'C:/x', createdAt: 0 }],
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
  // When POST 关闭历史浮层
  const off = await postJson(handlers, '/api/context/history-enabled', { enabled: false })
  // Then edit 定位本条目,合并写回,回显新值
  assert.equal(off.body.enabled, false)
  assert.equal(editCalls.length, 1)
  assert.equal(editCalls[0].options.id, 'context-manager')
  assert.equal(configStore.historyEnabled, false)
})

test('0.1.7 形态:configEditor 缺失即 400 拒写,配置不变', skipMissingDeps, async () => {
  // Given settingsForms 只有 update 且无 configEditor
  const settingsForms = { update: async () => {} }
  const configRef = { get: () => ({}) }
  const { handlers } = makeCtx({
    headers: [{ id: 's1', cwd: 'C:/x', createdAt: 0 }],
    agents: new Map(),
    settingsService: settingsForms,
    configRef,
  })
  // When POST 写开关
  const denied = await postJson(handlers, '/api/context/history-enabled', { enabled: false })
  // Then 400 错误响应
  assert.equal(denied.status, 400)
  assert.ok(denied.body.error)
})

test('0.1.7 形态:settings.configure 在场即关闭原生自动页,register 缺失不抛错', skipMissingDeps, () => {
  // Given settingsForms 带 configure 无 register
  const configureCalls = []
  const settingsForms = { configure: (presentation, owner) => { configureCalls.push({ presentation, owner }); return () => {} } }
  const { activateSettings } = makeCtx({
    headers: [{ id: 's1', cwd: 'C:/x', createdAt: 0 }],
    agents: new Map(),
    settingsService: settingsForms,
  })
  // When 激活 settings 注入
  activateSettings()
  // Then 关闭自动页且 owner 为本插件 fiber
  assert.equal(configureCalls.length, 1)
  assert.deepEqual(configureCalls[0].presentation, { auto: false })
})
