// 音效库路由集成测试:USERPROFILE 重定向到临时目录后动态装载 host 路由,
// 隔离真实 ~/.dsh 音效库;覆盖 sounds 列表 / sound 读取与删除 / upload 写入 /
// mapping 映射写读的完整链路(此前仅守卫路径有覆盖)。
import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'

const homeRoot = await mkdtemp(join(tmpdir(), 'tn-sounds-'))
process.env.USERPROFILE = homeRoot
process.env.HOME = homeRoot
const { apply } = await import('../src/index.js')

test.after(async () => { await rm(homeRoot, { recursive: true, force: true }) })

const soundsDir = join(homeRoot, '.dsh', 'dsh-turn-notify', 'sounds')
const JSON_HEADERS = { 'content-type': 'application/json' }
const WAV_BYTES = Buffer.from([1, 2, 3, 4])

function makeRes() {
  return {
    status: null,
    body: null,
    raw: null,
    headers: null,
    writeHead(status, headers) { this.status = status; this.headers = headers },
    end(body) {
      if (Buffer.isBuffer(body)) this.raw = body
      else if (typeof body === 'string' && (this.headers ? String(this.headers['content-type']) : '').includes('json')) this.body = JSON.parse(body)
      else this.raw = body
    },
  }
}

function makeReq(method, payload, headers, url) {
  const req = new EventEmitter()
  req.method = method
  req.url = url || '/api/turn-notify/sounds'
  req.headers = { host: '127.0.0.1:3080', ...(headers || {}) }
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
    req.headers = { host: '127.0.0.1:3080' }
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
  // 超限体 400
  const tooBig = makeRes()
  await upload(bodyReq('big.wav', Buffer.alloc(2 * 1024 * 1024 + 1)), tooBig)
  assert.equal(tooBig.status, 400)
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
