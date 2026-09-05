// 音效重命名路由测试(展示名语义):USERPROFILE 重定向到临时目录后动态装载 host 路由,
// 隔离真实 ~/.dsh 音效库;覆盖展示名落索引 / 文件名不变 / 映射引用不动 / 幂等 /
// 非法名 / 404 / 并发收敛 / 删除清索引 / 守卫。
import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SOUND_NAME_MAX_CHARS } from '../src/core.mjs'

const homeRoot = await mkdtemp(join(tmpdir(), 'tn-rename-'))
process.env.USERPROFILE = homeRoot
process.env.HOME = homeRoot
const { apply } = await import('../src/index.js')

test.after(async () => { await rm(homeRoot, { recursive: true, force: true }) })

const soundsDir = join(homeRoot, '.dsh', 'dsh-turn-notify', 'sounds')
const JSON_HEADERS = { 'content-type': 'application/json' }

function makeRes() {
  return {
    status: null,
    body: null,
    raw: null,
    headers: null,
    writeHead(status, headers) { this.status = status; this.headers = headers },
    end(body) {
      if (Buffer.isBuffer(body)) this.raw = body
      else if (body !== undefined && (this.headers ? String(this.headers['content-type']) : '').includes('json')) this.body = JSON.parse(body)
      else this.raw = body
    },
  }
}

function makeReq(method, payload, headers, url) {
  const req = new EventEmitter()
  req.method = method
  req.url = url || '/api/turn-notify/sound'
  req.headers = { host: '127.0.0.1:3080', ...(headers || {}) }
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

// 目录为各测试共享:每个测试先重置,再种自己需要的文件,保证互不残留
async function resetSounds() {
  await rm(soundsDir, { recursive: true, force: true })
  await mkdir(soundsDir, { recursive: true })
}

async function seedSound(id, ext) {
  await writeFile(join(soundsDir, id + '.' + ext), Buffer.from([1, 2, 3]))
}

async function listNames() {
  return readdir(soundsDir)
}

async function readIndex() {
  try {
    return JSON.parse(await readFile(join(soundsDir, 'index.json'), 'utf8'))
  } catch {
    return {}
  }
}

test('重命名主路径:文件名不变,展示名落索引,映射引用不动,原 id 仍可读取', async () => {
  await resetSounds()
  await seedSound('snd-abc', 'wav')
  const { ctx, routes, settingsService } = makeCtx()
  apply(ctx)
  await settingsService.update('turn-notify', { soundMapping: { completed: 'snd-abc', error: 'snd-other' } })
  const res = makeRes()
  await routes.get('/api/turn-notify/sound')(makeReq('PUT', { id: 'snd-abc', name: ' 提示音甲 ' }, JSON_HEADERS), res)
  assert.equal(res.status, 200)
  assert.deepEqual(res.body, { ok: true, id: 'snd-abc', name: '提示音甲' })
  assert.deepEqual((await listNames()).sort(), ['index.json', 'snd-abc.wav'])
  assert.deepEqual(await readIndex(), { 'snd-abc': '提示音甲' })
  const stored = settingsService.get('turn-notify')
  assert.equal(stored.soundMapping.completed, 'snd-abc')
  assert.equal(stored.soundMapping.error, 'snd-other')
  const got = makeRes()
  await routes.get('/api/turn-notify/sound')(makeReq('GET', undefined, undefined, '/api/turn-notify/sound?id=snd-abc'), got)
  assert.equal(got.status, 200)
  assert.deepEqual(got.raw, Buffer.from([1, 2, 3]))
})

test('重命名为当前展示名:幂等成功,索引与文件不动', async () => {
  await resetSounds()
  await seedSound('snd-keep', 'mp3')
  const { ctx, routes } = makeCtx()
  apply(ctx)
  const first = makeRes()
  await routes.get('/api/turn-notify/sound')(makeReq('PUT', { id: 'snd-keep', name: '名称甲' }, JSON_HEADERS), first)
  assert.equal(first.status, 200)
  const again = makeRes()
  await routes.get('/api/turn-notify/sound')(makeReq('PUT', { id: 'snd-keep', name: ' 名称甲 ' }, JSON_HEADERS), again)
  assert.equal(again.status, 200)
  assert.deepEqual(again.body, { ok: true, id: 'snd-keep', name: '名称甲' })
  assert.deepEqual(await readIndex(), { 'snd-keep': '名称甲' })
  assert.deepEqual((await listNames()).sort(), ['index.json', 'snd-keep.mp3'])
})

test('重命名为非法名:400 拒绝,索引与文件不动', async () => {
  await resetSounds()
  await seedSound('snd-x', 'ogg')
  const { ctx, routes } = makeCtx()
  apply(ctx)
  for (const name of ['a.wav', 'a/b', 'bell', '', '长'.repeat(SOUND_NAME_MAX_CHARS + 1), 123]) {
    const res = makeRes()
    await routes.get('/api/turn-notify/sound')(makeReq('PUT', { id: 'snd-x', name }, JSON_HEADERS), res)
    assert.equal(res.status, 400, '非法名应 400: ' + name)
  }
  assert.deepEqual(await listNames(), ['snd-x.ogg'])
  assert.deepEqual(await readIndex(), {})
})

test('重命名不存在的音效:404', async () => {
  await resetSounds()
  const { ctx, routes } = makeCtx()
  apply(ctx)
  const res = makeRes()
  await routes.get('/api/turn-notify/sound')(makeReq('PUT', { id: 'snd-missing', name: '任意' }, JSON_HEADERS), res)
  assert.equal(res.status, 404)
})

test('并发展示名重命名:互斥串行,双双成功,文件不变且索引收敛于单值', async () => {
  await resetSounds()
  await seedSound('snd-dup', 'wav')
  const { ctx, routes } = makeCtx()
  apply(ctx)
  const handler = routes.get('/api/turn-notify/sound')
  const results = await Promise.all(['并发名一', '并发名二'].map((name) => {
    const res = makeRes()
    return handler(makeReq('PUT', { id: 'snd-dup', name }, JSON_HEADERS), res).then(() => res.status)
  }))
  assert.deepEqual(results, [200, 200])
  assert.deepEqual((await listNames()).sort(), ['index.json', 'snd-dup.wav'])
  const index = await readIndex()
  assert.deepEqual(Object.keys(index), ['snd-dup'])
  assert.ok(index['snd-dup'] === '并发名一' || index['snd-dup'] === '并发名二')
})

test('删除清理展示名索引:条目随文件移除,映射引用同步清理', async () => {
  await resetSounds()
  await seedSound('gone', 'wav')
  const { ctx, routes, settingsService } = makeCtx()
  apply(ctx)
  const renamed = makeRes()
  await routes.get('/api/turn-notify/sound')(makeReq('PUT', { id: 'gone', name: '旧名' }, JSON_HEADERS), renamed)
  assert.equal(renamed.status, 200)
  await settingsService.update('turn-notify', { soundMapping: { completed: 'gone' } })
  const res = makeRes()
  await routes.get('/api/turn-notify/sound')(makeReq('DELETE', undefined, undefined, '/api/turn-notify/sound?id=gone'), res)
  assert.equal(res.status, 200)
  assert.deepEqual(await listNames(), ['index.json'])
  assert.deepEqual(await readIndex(), {})
  const stored = settingsService.get('turn-notify')
  assert.equal(stored.soundMapping.completed, null)
})

test('删除不存在的音效:404,不产生索引文件', async () => {
  await resetSounds()
  const { ctx, routes } = makeCtx()
  apply(ctx)
  const res = makeRes()
  await routes.get('/api/turn-notify/sound')(makeReq('DELETE', undefined, undefined, '/api/turn-notify/sound?id=missing'), res)
  assert.equal(res.status, 404)
  assert.deepEqual(await listNames(), [])
})

test('重命名路由守卫:跨源 403,非 JSON 400,畸形体 400,不支持的方法 405', async () => {
  await resetSounds()
  await seedSound('snd-guard', 'wav')
  const { ctx, routes } = makeCtx()
  apply(ctx)
  const cross = makeRes()
  await routes.get('/api/turn-notify/sound')(
    makeReq('PUT', { id: 'snd-guard', name: '甲' }, { ...JSON_HEADERS, origin: 'https://evil.example' }), cross)
  assert.equal(cross.status, 403)
  const wrongType = makeRes()
  await routes.get('/api/turn-notify/sound')(
    makeReq('PUT', { id: 'snd-guard', name: '甲' }, { 'content-type': 'text/plain' }), wrongType)
  assert.equal(wrongType.status, 400)
  const malformed = makeRes()
  await routes.get('/api/turn-notify/sound')(makeReq('PUT', undefined, JSON_HEADERS), malformed)
  assert.equal(malformed.status, 400)
  const badMethod = makeRes()
  await routes.get('/api/turn-notify/sound')(makeReq('POST', {}, JSON_HEADERS), badMethod)
  assert.equal(badMethod.status, 405)
})
