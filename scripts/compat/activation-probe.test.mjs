// activation 探针自身:cookie 优先、token 回退、失败取证与轮询终态。
// 宿主 0.2.3-alpha.2 起 /dsh-market/installed 只认会话 cookie,token 查询 401;
// 旧宿主接受 token 查询,两条路径都要被测试锁定。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { mintSessionCookie, probeActivation } from './activation-probe.mjs'

const BUNDLES = ['@mzzsfy/dsh-alpha', '@mzzsfy/dsh-beta']

function serve(handler) {
  return new Promise((resolve) => {
    const server = createServer(handler)
    server.listen(0, '127.0.0.1', () => resolve({ server, base: `http://127.0.0.1:${server.address().port}` }))
  })
}

function installedBody(states, findings = []) {
  return JSON.stringify({
    activation: Object.fromEntries(Object.entries(states).map(([name, state]) => [name, { state }])),
    diagnostics: { findings },
  })
}

function workDir() {
  return mkdtempSync(join(tmpdir(), 'compat-activation-'))
}

test('mintSessionCookie 取 set-cookie 首段;无 set-cookie 返回空串', async () => {
  const { server, base } = await serve((req, res) => {
    if (req.url.startsWith('/?token=launch')) {
      res.writeHead(303, { 'set-cookie': 'dsh-auth-abc=v1.payload.sig; Max-Age=60; Path=/; HttpOnly' })
      res.end()
      return
    }
    res.writeHead(200)
    res.end()
  })
  try {
    assert.equal(await mintSessionCookie(base, 'launch'), 'dsh-auth-abc=v1.payload.sig')
    assert.equal(await mintSessionCookie(base, 'other'), '')
  } finally {
    server.close()
  }
})

test('带 cookie 200 且全 live/findings 0 判通过并落 installed.json', async () => {
  const dir = workDir()
  const raw = installedBody({ '@mzzsfy/dsh-alpha': 'live', '@mzzsfy/dsh-beta': 'live' })
  const { server, base } = await serve((req, res) => {
    res.writeHead(req.headers.cookie === 'dsh-auth-abc=v1.payload.sig' ? 200 : 401)
    res.end(req.headers.cookie ? raw : 'unauthorized')
  })
  try {
    const result = await probeActivation({ base, token: 'launch', cookie: 'dsh-auth-abc=v1.payload.sig', bundleNames: BUNDLES, workDir: dir, maxAttempts: 1 })
    assert.equal(result.liveAll, true)
    assert.equal(result.findingsCount, 0)
    assert.deepEqual(result.live, BUNDLES)
    assert.equal(result.auth, 'cookie')
    assert.equal(result.status, 200)
    assert.equal(result.bodySample, '')
    assert.equal(readFileSync(join(dir, 'installed.json'), 'utf8'), raw)
  } finally {
    server.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('cookie 与 token 都被 401 判失败,取证状态码与响应体', async () => {
  const dir = workDir()
  const { server, base } = await serve((req, res) => {
    res.writeHead(401, { 'content-type': 'text/plain; charset=utf-8' })
    res.end('dsh web authentication required; reopen the URL printed by dsh web.')
  })
  try {
    const result = await probeActivation({ base, token: 'launch', cookie: 'stale-cookie=1', bundleNames: BUNDLES, workDir: dir, maxAttempts: 3, pollMs: 0 })
    assert.equal(result.liveAll, false)
    assert.equal(result.findingsCount, -1)
    assert.deepEqual(result.notLive, BUNDLES)
    assert.equal(result.status, 401)
    assert.equal(result.auth, 'token')
    assert.match(result.bodySample, /authentication required/)
    assert.equal(readFileSync(join(dir, 'installed.json'), 'utf8'), 'dsh web authentication required; reopen the URL printed by dsh web.')
  } finally {
    server.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('cookie 401 时回退 token 查询,旧宿主仍判通过', async () => {
  const dir = workDir()
  const raw = installedBody({ '@mzzsfy/dsh-alpha': 'live', '@mzzsfy/dsh-beta': 'live' })
  const { server, base } = await serve((req, res) => {
    if (req.headers.cookie !== undefined) {
      res.writeHead(401)
      res.end('unauthorized')
      return
    }
    const token = new URL(req.url, 'http://dsh.invalid').searchParams.get('token')
    res.writeHead(token === 'launch' ? 200 : 401)
    res.end(token === 'launch' ? raw : 'unauthorized')
  })
  try {
    const result = await probeActivation({ base, token: 'launch', cookie: 'stale-cookie=1', bundleNames: BUNDLES, workDir: dir, maxAttempts: 1 })
    assert.equal(result.liveAll, true)
    assert.equal(result.auth, 'token')
  } finally {
    server.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('未全 live/findings>0 时轮询到全绿终态', async () => {
  const dir = workDir()
  let calls = 0
  const { server, base } = await serve((req, res) => {
    calls += 1
    if (calls === 1) {
      res.writeHead(200)
      res.end(installedBody({ '@mzzsfy/dsh-alpha': 'live', '@mzzsfy/dsh-beta': 'activating' }, [{ code: 'pending' }]))
      return
    }
    res.writeHead(200)
    res.end(installedBody({ '@mzzsfy/dsh-alpha': 'live', '@mzzsfy/dsh-beta': 'live' }))
  })
  try {
    const result = await probeActivation({ base, token: 'launch', cookie: 'session=good', bundleNames: BUNDLES, workDir: dir, maxAttempts: 3, pollMs: 0 })
    assert.equal(result.liveAll, true)
    assert.equal(result.findingsCount, 0)
    assert.ok(calls >= 2)
  } finally {
    server.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('200 但缺 activation 字段按证据未通过返回(代码未接入与认证失败可区分)', async () => {
  const dir = workDir()
  const { server, base } = await serve((req, res) => {
    res.writeHead(200)
    res.end('{"profile":"web"}')
  })
  try {
    const result = await probeActivation({ base, token: 'launch', cookie: 'session=good', bundleNames: BUNDLES, workDir: dir, maxAttempts: 2, pollMs: 0 })
    assert.equal(result.liveAll, false)
    assert.equal(result.findingsCount, -1)
    assert.equal(result.status, 200)
    assert.equal(result.bodySample, '{"profile":"web"}')
  } finally {
    server.close()
    rmSync(dir, { recursive: true, force: true })
  }
})
