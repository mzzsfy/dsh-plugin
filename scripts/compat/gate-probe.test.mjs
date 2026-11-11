// 闸门探针自身:目标表覆盖全部有路由的包,且判定口径是"无 cookie 401/403 + 带 cookie 放行"
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'

import { GATE_TARGETS, probeHostGate } from './gate-probe.mjs'

function serve(handler) {
  return new Promise((resolve) => {
    const server = createServer(handler)
    server.listen(0, '127.0.0.1', () => resolve({ server, base: `http://127.0.0.1:${server.address().port}` }))
  })
}

test('目标表每条都是 /api/ 下的绝对路径且包名唯一', () => {
  const names = new Set()
  for (const [name, path] of GATE_TARGETS) {
    assert.match(path, /^\/api\/[a-z0-9-]+(\/|$)/)
    assert.equal(names.has(name), false, `重复包名 ${name}`)
    names.add(name)
  }
  assert.ok(GATE_TARGETS.length >= 16)
})

test('无 cookie 401 且带 cookie 200 判通过', async () => {
  const { server, base } = await serve((req, res) => {
    res.writeHead(req.headers.cookie === 'session=good' ? 200 : 401)
    res.end()
  })
  try {
    const result = await probeHostGate({ base, cookie: 'session=good', packages: ['dsh-bug-perf'] })
    assert.equal(result.ok, true)
    assert.deepEqual(result.rows.map((row) => [row.path, row.anon, row.auth]), [['/api/dsh-bug-perf/config', 401, 200]])
  } finally {
    server.close()
  }
})

test('无 cookie 漏成 200 判失败', async () => {
  const { server, base } = await serve((req, res) => {
    res.writeHead(200)
    res.end()
  })
  try {
    const result = await probeHostGate({ base, cookie: 'session=good', packages: ['dsh-bug-perf'] })
    assert.equal(result.ok, false)
    assert.equal(result.rows[0].anon, 200)
  } finally {
    server.close()
  }
})

test('带 cookie 也被拒同样判失败(闸门打死业务)', async () => {
  const { server, base } = await serve((req, res) => {
    res.writeHead(401)
    res.end()
  })
  try {
    const result = await probeHostGate({ base, cookie: 'session=good', packages: ['dsh-bug-perf'] })
    assert.equal(result.ok, false)
    assert.equal(result.rows[0].auth, 401)
  } finally {
    server.close()
  }
})

test('未装载的包(404)不参与判定', async () => {
  const { server, base } = await serve((req, res) => {
    res.writeHead(req.headers.cookie === 'session=good' ? 200 : 401)
    res.end()
  })
  try {
    const result = await probeHostGate({ base, cookie: 'session=good', packages: ['dsh-cron-board'] })
    assert.equal(result.ok, true)
    assert.deepEqual(result.rows.map((row) => row.path), ['/api/cron-board/jobs'])
  } finally {
    server.close()
  }
})
