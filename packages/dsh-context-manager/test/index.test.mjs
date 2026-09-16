// 路由层 BDD(mock ctx 强制 cordis 注入语义):宿主上下文上任何未声明 inject 的
// 服务属性访问一律抛 cannot get property ... without inject,与 cordis reflect 行为
// 一致,防止 inject 声明缺失回归。peer 依赖未安装的仓库环境(禁止 install)下整文件跳过。

import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises'
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
const dependencyReady = typeof apply === 'function'
const skipMissingDeps = { skip: dependencyReady ? false : 'peer 依赖未安装,路由层测试跳过' }
const {
  HISTORY_SCOPES,
  HISTORY_INPUT_LIMIT,
  HISTORY_INPUT_MAX_CHARS,
  HISTORY_PROMPTS_MAX,
  HISTORY_SESSION_SCAN_LIMIT,
  HISTORY_STARTUP_SCAN_LIMIT,
} = await import('../src/core.mjs')
const { ensureCacheDir, writeWorkspaceCache } = await import('../src/history-cache.mjs')

// 插件激活即跑历史缓存启动对齐:所有测试统一隔离缓存目录,
// 防止夹具工作区经默认路径(~/.dsh/historyPrompt)泄漏进真实用户目录
const sharedCacheDir = mkdtempSync(path.join(tmpdir(), 'cx-hist-shared-'))
process.env.DSH_HISTORY_CACHE_DIR = sharedCacheDir
test.after(() => {
  rmSync(sharedCacheDir, { recursive: true, force: true })
})

function makeCtx({
  headers,
  agents,
  sessionPersistence,
  settingsValue,
  readSessions,
}) {
  const routes = []
  const pendingInjects = []
  const settingsState = { value: settingsValue }
  const settingsService = {
    get: () => settingsState.value,
    register: () => ({ resolved: undefined }),
    // 宿主 update 为异步串行:合并进微任务队列后生效,读旧值发生在 flush 前
    update: (ns, patch) => new Promise((resolve) => queueMicrotask(() => {
      settingsState.value = { ...(settingsState.value || {}), ...patch }
      resolve()
    })),
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
    sessionQuery,
  }
  const base = {
    effect: (fn) => fn(),
    inject: (_deps, fn) => { pendingInjects.push(fn) },
    get: (name) => ({ agents, sessionPersistence, settings: settingsService }[name]),
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
  apply(ctx, undefined)
  return {
    handlers: new Map(routes.map((route) => [route.path, route.handler])),
    logger: base.logger,
    readCounts,
    // 模拟宿主 settings 服务激活:触发 inject 回调(注册)
    activateSettings: () => {
      while (pendingInjects.length > 0) pendingInjects.shift()({ settings: settingsService })
    },
  }
}

function response() {
  const state = { status: undefined, body: undefined }
  state.writeHead = (status) => { state.status = status }
  state.end = (text) => { state.body = JSON.parse(text) }
  return state
}

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

// 后台对齐是异步的:轮询等待响应满足条件(默认 aligned 翻真,可断言数据就绪)
async function requestUntil(handlers, query, predicate, maxMs = 3000) {
  for (let waited = 0; waited <= maxMs; waited += 100) {
    const res = response()
    await handlers.get('/api/context/inputs')(getRequest(query), res)
    if (predicate(res.body)) return res
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
  const res = response()
  const done = handlers.get(routePath)(req, res)
  req.emit('data', Buffer.from(JSON.stringify(body), 'utf8'))
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
  for (const service of ['webServer', 'agents', 'sessionQuery', 'sessionPersistence']) {
    assert.ok(declaredInject.includes(service), `inject 缺少 "${service}"`)
  }
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
      assert.equal(readCounts2.get('s1') === undefined, true, '产物未变,重启后对齐零解压')
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
