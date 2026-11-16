// 音效库路由集成测试:DSH_HOME 指向临时目录后动态装载 host 路由,
// 隔离真实 ~/.dsh 音效库;覆盖 sounds 列表 / sound 读取与删除 / upload 写入 /
// mapping 映射写读的完整链路(此前仅守卫路径有覆盖)。
import test from 'node:test'
import { busStub, resetBusStub } from './_mocks.common-tools.mjs'

import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { Agent, createServer, request } from 'node:http'
import { connect } from 'node:net'
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'

const homeRoot = await mkdtemp(join(tmpdir(), 'tn-sounds-'))
process.env.USERPROFILE = homeRoot
process.env.HOME = homeRoot
process.env.DSH_HOME = join(homeRoot, '.dsh')
const { apply } = await import('../src/index.js')
const { BODY_DRAIN_TIMEOUT_MS } = await import('../src/core.mjs')

test.after(async () => { await rm(homeRoot, { recursive: true, force: true }) })

const soundsDir = join(homeRoot, '.dsh', 'dsh-turn-notify', 'sounds')
const JSON_HEADERS = { 'content-type': 'application/json' }
// 浏览器 client 全部经 api() 以 application/json 发送;写请求默认带 JSON 头,
// 使业务用例不受共享闸门的 content-type 门影响(守卫差异由专门用例显式覆盖)
const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE'])
const WAV_BYTES = Buffer.from([1, 2, 3, 4])

// 真实 socket 工位:上传/重命名路由直接挂 Node HTTP server,超限响应必须实际送达
// 客户端,覆盖 stub req/res 无法暴露的"先 destroy 再回状态码"缺陷。
async function withHttpServer(handler, fn) {
  const server = createServer((req, res) => {
    Promise.resolve(handler(req, res)).catch(() => {
      if (!res.headersSent) res.writeHead(500)
      res.end()
    })
  })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  try {
    return await fn(server.address().port)
  } finally {
    server.closeAllConnections?.()
    await new Promise((resolve) => server.close(resolve))
  }
}

// keep-alive 探针:显式指定 socket 复用,响应读完即返回,用于验证同连接后续请求;
// socket 对象随结果返回,新建连接掩盖不了"413 后连接被废弃"
function keepAliveCall(agent, options, body) {
  return new Promise((resolve) => {
    const req = request({ ...options, agent }, (res) => {
      const chunks = []
      res.on('data', (chunk) => chunks.push(chunk))
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8'), socket: req.socket }))
    })
    req.on('error', (error) => resolve({ error: error.code || String(error) }))
    req.end(body)
  })
}

// 原始 socket 探针:字节级观察状态行/响应头/连接关闭,不被 fetch 的连接复用时序掩盖
function rawExchange(port, { headers, body, timeoutMs = 5000 }) {
  return new Promise((resolve) => {
    const socket = connect(port, '127.0.0.1')
    const chunks = []
    const started = Date.now()
    let settled = false
    const finish = (result) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      socket.destroy()
      resolve({ elapsed: Date.now() - started, data: Buffer.concat(chunks), ...result })
    }
    const timer = setTimeout(() => finish({ timeout: true }), timeoutMs)
    socket.on('data', (chunk) => chunks.push(chunk))
    socket.on('close', () => finish({ closed: true }))
    socket.on('error', (error) => finish({ error: error.code }))
    socket.write(headers)
    if (body) socket.write(body)
  })
}

// 响应行/头解析:状态码与 connection 头决定客户端是否复用连接;头为 ASCII,
// 正文按 UTF-8 解码供文案断言
function parseResponse(raw) {
  const text = raw.toString('latin1')
  const boundary = text.indexOf('\r\n\r\n')
  const head = boundary >= 0 ? text.slice(0, boundary) : text
  const status = Number((/^HTTP\/1\.1 (\d+)/.exec(head) || [])[1] || 0)
  const connection = ((/\r\nconnection:\s*([^\r\n]+)/i.exec(head) || [])[1] || '').trim().toLowerCase()
  return { status, connection, body: boundary >= 0 ? raw.subarray(boundary + 4).toString('utf8') : '' }
}

// res 桩带事件能力:投影处理器挂 close 事件感知断连,桩须支持 once
function makeRes() {
  const res = new EventEmitter()
  res.status = null
  res.body = null
  res.raw = null
  res.headers = null
  res.writeHead = (status, headers) => { res.status = status; res.headers = headers }
  res.end = (body) => {
    if (Buffer.isBuffer(body)) res.raw = body
    else if (typeof body === 'string' && (res.headers ? String(res.headers['content-type']) : '').includes('json')) res.body = JSON.parse(body)
    else res.raw = body
  }
  return res
}

function makeReq(method, payload, headers, url) {
  const req = new EventEmitter()
  req.method = method
  req.url = url || '/api/turn-notify/sounds'
  req.headers = { host: '127.0.0.1:3080', ...(WRITE_METHODS.has(method) ? JSON_HEADERS : {}), ...(headers || {}) }
  req.destroy = () => {}
  const data = payload === undefined ? null : Buffer.from(JSON.stringify(payload))
  process.nextTick(() => {
    if (data !== null) req.emit('data', data)
    req.readableEnded = true
    req.emit('end')
  })
  return req
}

function makeSettings() {
  const doc = new Map()
  const merge = (under, over) => {
    const out = { ...under }
    for (const [key, value] of Object.entries(over)) {
      const underValue = out[key]
      const bothPlain = (value !== null && typeof value === 'object' && !Array.isArray(value))
        && (underValue !== null && typeof underValue === 'object' && !Array.isArray(underValue))
      out[key] = bothPlain ? merge(underValue, value) : value
    }
    return out
  }
  return {
    register(ns) {
      if (!doc.has(ns)) doc.set(ns, {})
      return {
        get: () => doc.get(ns),
        watch: () => () => {},
      }
    },
    get: (ns) => doc.get(ns),
    update: async (ns, patch) => { doc.set(ns, merge(doc.get(ns) ?? {}, patch)) },
  }
}

function makeCtx() {
  const routes = new Map()
  const settingsService = makeSettings()
  const ctx = {
    on() {},
    get(key) { return key === 'settings' ? settingsService : undefined },
    inject(deps, fn) { fn({ settings: settingsService }) },
    effect(thunk) { thunk() },
    webServer: { register(route) { routes.set(route.path, route.handler) } },
  }
  return { ctx, routes, settingsService }
}

async function resetSounds() {
  await rm(soundsDir, { recursive: true, force: true })
  await mkdir(soundsDir, { recursive: true })
}

async function seedSound(name, bytes) {
  await writeFile(join(soundsDir, name), bytes || WAV_BYTES)
}

async function listNames() {
  return readdir(soundsDir)
}

test('sounds 列表:id/ext 按首点切分,非音效文件过滤,无索引记录展示名为空', async () => {
  await resetSounds()
  await seedSound('a.wav')
  await seedSound('c.ogg')
  await seedSound('notasound')
  const { ctx, routes } = makeCtx()
  apply(ctx)
  const res = makeRes()
  await routes.get('/api/turn-notify/sounds')(makeReq('GET'), res)
  assert.equal(res.status, 200)
  assert.deepEqual(
    res.body.sounds.sort((x, y) => x.id.localeCompare(y.id)),
    [{ id: 'a', ext: 'wav', name: null }, { id: 'c', ext: 'ogg', name: null }],
  )
  assert.equal(res.body.builtin, true)
})

test('sounds 列表:展示名随索引附加,索引文件不入列,索引损坏降级为无名', async () => {
  await resetSounds()
  await seedSound('a.wav')
  await writeFile(join(soundsDir, 'index.json'), JSON.stringify({ a: '别名甲', ghost: '孤儿名' }))
  const { ctx, routes } = makeCtx()
  apply(ctx)
  const res = makeRes()
  await routes.get('/api/turn-notify/sounds')(makeReq('GET'), res)
  assert.equal(res.status, 200)
  assert.deepEqual(res.body.sounds, [{ id: 'a', ext: 'wav', name: '别名甲' }])
  await writeFile(join(soundsDir, 'index.json'), '{broken')
  const degraded = makeRes()
  await routes.get('/api/turn-notify/sounds')(makeReq('GET'), degraded)
  assert.equal(degraded.status, 200)
  assert.deepEqual(degraded.body.sounds, [{ id: 'a', ext: 'wav', name: null }])
})

test('sounds 列表 405 与错误兜底', async () => {
  await resetSounds()
  const { ctx, routes } = makeCtx()
  apply(ctx)
  const res = makeRes()
  await routes.get('/api/turn-notify/sounds')(makeReq('POST'), res)
  assert.equal(res.status, 405)
})

test('sound 读取:命中返回音频与 MIME,未命中 404,fs 故障 500', async () => {
  await resetSounds()
  await seedSound('x.wav')
  // 同名目录:列表命中但读取报 EISDIR,锚定错误归一的 fs 类 500 分支
  await mkdir(join(soundsDir, 'd.wav'))
  const { ctx, routes } = makeCtx()
  apply(ctx)
  const hit = makeRes()
  await routes.get('/api/turn-notify/sound')(makeReq('GET', undefined, undefined, '/api/turn-notify/sound?id=x'), hit)
  assert.equal(hit.status, 200)
  assert.equal(hit.headers['content-type'], 'audio/wav')
  assert.deepEqual(hit.raw, WAV_BYTES)
  const miss = makeRes()
  await routes.get('/api/turn-notify/sound')(makeReq('GET', undefined, undefined, '/api/turn-notify/sound?id=missing'), miss)
  assert.equal(miss.status, 404)
  const fsFailure = makeRes()
  await routes.get('/api/turn-notify/sound')(makeReq('GET', undefined, undefined, '/api/turn-notify/sound?id=d'), fsFailure)
  assert.equal(fsFailure.status, 500)
})

test('sound 删除:文件移除,映射引用同步清理,再次删除 404', async () => {
  await resetSounds()
  await seedSound('gone.wav')
  const { ctx, routes, settingsService } = makeCtx()
  apply(ctx)
  await settingsService.update('turn-notify', { soundMapping: { completed: 'gone', error: 'other' } })
  const res = makeRes()
  await routes.get('/api/turn-notify/sound')(makeReq('DELETE', undefined, undefined, '/api/turn-notify/sound?id=gone'), res)
  assert.equal(res.status, 200)
  assert.deepEqual(await listNames(), [])
  const stored = settingsService.get('turn-notify')
  // 深合并存储语义:清除为置 null,读侧 resolvedConfig 过滤
  assert.equal(stored.soundMapping.completed, null)
  assert.equal(stored.soundMapping.error, 'other')
  const again = makeRes()
  await routes.get('/api/turn-notify/sound')(makeReq('DELETE', undefined, undefined, '/api/turn-notify/sound?id=gone'), again)
  assert.equal(again.status, 404)
})

test('upload 主路径:内容寻址落盘,非法扩展与超限体拒绝,同内容幂等', async () => {
  await resetSounds()
  const { ctx, routes } = makeCtx()
  apply(ctx)
  const wav = Buffer.alloc(64, 7)
  const upload = routes.get('/api/turn-notify/upload')
  const bodyReq = (name, bytes) => {
    const req = new EventEmitter()
    req.method = 'POST'
    req.url = '/api/turn-notify/upload?name=' + encodeURIComponent(name)
    // 上传体为原始音频字节,但写路由统一经 JSON content-type 门阻断跨站简单请求
    req.headers = { host: '127.0.0.1:3080', 'content-type': 'application/json' }
    req.destroy = () => {}
    process.nextTick(() => {
      req.emit('data', bytes)
      req.readableEnded = true
      req.emit('end')
    })
    return req
  }
  const ok = makeRes()
  await upload(bodyReq('clip.wav', wav), ok)
  assert.equal(ok.status, 200)
  const expectedId = 'snd-' + createHash('sha256').update(wav).digest('hex').slice(0, 16)
  assert.equal(ok.body.id, expectedId)
  const names = await listNames()
  assert.deepEqual(names, [expectedId + '.wav'])
  assert.deepEqual(await readFile(join(soundsDir, expectedId + '.wav')), wav)
  // 同内容重传:幂等返回既有 id,不产生第二份文件
  const again = makeRes()
  await upload(bodyReq('clip.wav', wav), again)
  assert.equal(again.status, 200)
  assert.equal(again.body.id, expectedId)
  assert.deepEqual(await listNames(), [expectedId + '.wav'])
  // 非法扩展名 400
  const badExt = makeRes()
  await upload(bodyReq('a.txt', Buffer.from('x')), badExt)
  assert.equal(badExt.status, 400)
  // 超限体 413
  const tooBig = makeRes()
  await upload(bodyReq('big.wav', Buffer.alloc(2 * 1024 * 1024 + 1)), tooBig)
  assert.equal(tooBig.status, 413)
})

test('Given 真实 socket When upload 超 2MB 或 sound PUT 超 64KB Then 413 可达', async () => {
  await resetSounds()
  const { ctx, routes } = makeCtx()
  apply(ctx)
  const upload = routes.get('/api/turn-notify/upload')
  const sound = routes.get('/api/turn-notify/sound')
  const handler = (req, res) => (req.url.startsWith('/api/turn-notify/upload') ? upload : sound)(req, res)
  await withHttpServer(handler, async (port) => {
    const uploadRes = await fetch('http://127.0.0.1:' + port + '/api/turn-notify/upload?name=big.wav', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: Buffer.alloc(2 * 1024 * 1024 + 1),
    })
    assert.equal(uploadRes.status, 413, 'upload 超限响应必须送达,而不是客户端 UND_ERR_SOCKET')
    assert.match((await uploadRes.json()).error, /超过上限/)
    const renameRes = await fetch('http://127.0.0.1:' + port + '/api/turn-notify/sound?id=gone', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: 'gone', name: 'x'.repeat(64 * 1024 + 1) }),
    })
    assert.equal(renameRes.status, 413, 'sound PUT 超限响应必须送达')
    assert.match((await renameRes.json()).error, /超过上限/)
  })
})

test('Given 同一条 keep-alive 连接 When upload 8MB 超限 Then 413 后后续 GET 仍复用该 socket', async () => {
  await resetSounds()
  const { ctx, routes } = makeCtx()
  apply(ctx)
  const handler = (req, res) => routes.get(req.url.split('?', 1)[0])(req, res)
  await withHttpServer(handler, async (port) => {
    const agent = new Agent({ keepAlive: true, maxSockets: 1 })
    try {
      const body = Buffer.alloc(8 * 1024 * 1024)
      const first = await keepAliveCall(agent, {
        host: '127.0.0.1',
        port,
        method: 'POST',
        path: '/api/turn-notify/upload?name=big.wav',
        headers: { 'content-type': 'application/json', 'content-length': String(body.length) },
      }, body)
      assert.equal(first.error, undefined, '超限响应必须送达,实际 ' + first.error)
      assert.equal(first.status, 413)
      assert.match(JSON.parse(first.body).error, /超过上限/)
      // 回归:超限体不排空时宿主在响应后废弃 socket,这里第二个请求即 ECONNRESET
      const second = await keepAliveCall(agent, { host: '127.0.0.1', port, method: 'GET', path: '/api/turn-notify/sounds' })
      assert.equal(second.error, undefined, '413 后同连接请求不得被复位,实际 ' + second.error)
      assert.equal(second.status, 200)
      assert.deepEqual(JSON.parse(second.body).sounds, [])
      assert.equal(second.socket, first.socket, '后续请求必须复用同一 socket,新连接掩盖 RST')
    } finally {
      agent.destroy()
    }
  })
})

test('Given 小超额完整送达 When upload 超 2MB 4KB Then 排空后同 socket 仍可用', async () => {
  await resetSounds()
  const { ctx, routes } = makeCtx()
  apply(ctx)
  const handler = (req, res) => routes.get(req.url.split('?', 1)[0])(req, res)
  await withHttpServer(handler, async (port) => {
    const agent = new Agent({ keepAlive: true, maxSockets: 1 })
    try {
      const body = Buffer.alloc(2 * 1024 * 1024 + 4096)
      const first = await keepAliveCall(agent, {
        host: '127.0.0.1',
        port,
        method: 'POST',
        path: '/api/turn-notify/upload?name=edge.wav',
        headers: { 'content-type': 'application/json', 'content-length': String(body.length) },
      }, body)
      assert.equal(first.error, undefined, '超限响应必须送达,实际 ' + first.error)
      assert.equal(first.status, 413)
      const second = await keepAliveCall(agent, { host: '127.0.0.1', port, method: 'GET', path: '/api/turn-notify/sounds' })
      assert.equal(second.error, undefined, '小超额排空后连接必须可复用,实际 ' + second.error)
      assert.equal(second.status, 200)
      assert.equal(second.socket, first.socket, '小超额必须保留 keep-alive')
    } finally {
      agent.destroy()
    }
  })
})

test('Given 真实 fetch 发送 50MB When upload 超限 Then 请求体排空后 413 送达且 Connection: close', async () => {
  await resetSounds()
  const { ctx, routes } = makeCtx()
  apply(ctx)
  const upload = routes.get('/api/turn-notify/upload')
  await withHttpServer(upload, async (port) => {
    const response = await fetch('http://127.0.0.1:' + port + '/api/turn-notify/upload?name=big.wav', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: Buffer.alloc(50 * 1024 * 1024),
    })
    assert.equal(response.status, 413, '真实 fetch 50MB 必须收到 413,而不是 ECONNRESET')
    assert.equal(response.headers.get('connection'), 'close')
    assert.match((await response.json()).error, /超过上限/)
    assert.deepEqual(await listNames(), [], '超限体不得落盘')
  })
})

test('Given 慢速客户端 When 超限后排空超时 Then 413 带 Connection: close 且连接按时关闭', async () => {
  await resetSounds()
  const { ctx, routes } = makeCtx()
  apply(ctx)
  const upload = routes.get('/api/turn-notify/upload')
  await withHttpServer(upload, async (port) => {
    const declared = 8 * 1024 * 1024
    const partial = Buffer.alloc(2 * 1024 * 1024 + 64 * 1024)
    const result = await rawExchange(port, {
      headers: 'POST /api/turn-notify/upload?name=slow.wav HTTP/1.1\r\n'
        + 'Host: 127.0.0.1\r\nContent-Type: application/json\r\nContent-Length: ' + declared + '\r\n\r\n',
      body: partial,
      timeoutMs: BODY_DRAIN_TIMEOUT_MS + 3000,
    })
    assert.equal(result.timeout, undefined, '排空超时后必须关闭连接')
    assert.equal(result.closed, true)
    const response = parseResponse(result.data)
    assert.equal(response.status, 413, '413 必须在排空超时前送达')
    assert.equal(response.connection, 'close', '排空超时的响应必须告知客户端不要复用连接')
    assert.ok(result.elapsed >= BODY_DRAIN_TIMEOUT_MS - 500, '连接应在排空超时后关闭,实际 ' + result.elapsed + 'ms')
    assert.ok(result.elapsed < BODY_DRAIN_TIMEOUT_MS + 2000, '连接不得拖到宿主 requestTimeout,实际 ' + result.elapsed + 'ms')
    assert.deepEqual(await listNames(), [])
  })
})

test('Given 0 字节音频 When upload Then 400 报文件为空且不落盘', async () => {
  await resetSounds()
  const { ctx, routes } = makeCtx()
  apply(ctx)
  const upload = routes.get('/api/turn-notify/upload')
  await withHttpServer(upload, async (port) => {
    const res = await fetch('http://127.0.0.1:' + port + '/api/turn-notify/upload?name=empty.wav', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: Buffer.alloc(0),
    })
    assert.equal(res.status, 400)
    const payload = await res.json()
    assert.equal(payload.error, '文件为空')
    assert.deepEqual(await listNames(), [], '空文件不得落盘')
  })
})

test('mapping 写读链路:写映射生效,未知分类与未知音效 400,空 id 清除', async () => {
  await resetSounds()
  await seedSound('snd-1.wav')
  const { ctx, routes, settingsService } = makeCtx()
  apply(ctx)
  const handler = routes.get('/api/turn-notify/mapping')
  const write = makeRes()
  await handler(makeReq('POST', { category: 'completed', id: 'snd-1' }, JSON_HEADERS, '/api/turn-notify/mapping'), write)
  assert.equal(write.status, 200)
  assert.deepEqual(write.body.soundMapping, { completed: 'snd-1' })
  assert.equal(settingsService.get('turn-notify').soundMapping.completed, 'snd-1')
  // 投影路由带回 mapping
  const projection = makeRes()
  await routes.get('/api/turn-notify/projection')(makeReq('GET', undefined, undefined, '/api/turn-notify/projection'), projection)
  assert.deepEqual(projection.body.soundMapping, { completed: 'snd-1' })
  const unknownCategory = makeRes()
  await handler(makeReq('POST', { category: 'nope', id: 'snd-1' }, JSON_HEADERS, '/api/turn-notify/mapping'), unknownCategory)
  assert.equal(unknownCategory.status, 400)
  const unknownSound = makeRes()
  await handler(makeReq('POST', { category: 'completed', id: 'snd-404' }, JSON_HEADERS, '/api/turn-notify/mapping'), unknownSound)
  assert.equal(unknownSound.status, 400)
  const clear = makeRes()
  await handler(makeReq('POST', { category: 'completed', id: '' }, JSON_HEADERS, '/api/turn-notify/mapping'), clear)
  assert.equal(clear.status, 200)
  assert.deepEqual(clear.body.soundMapping, {})
  // 深合并存储语义:清除为置 null;真实宿主 settings 经 schema 归一落为空串,
  // 两者均被读侧 resolvedConfig 的非空字符串过滤挡下,mock 原样存 null
  assert.equal(settingsService.get('turn-notify').soundMapping.completed, null)
})
