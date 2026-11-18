// 闸门探针自身:目标表覆盖全部有路由的包,且判定口径是"无 cookie 401/403 + 带 cookie 放行"
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readdirSync } from 'node:fs'
import { createServer } from 'node:http'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { GATE_TARGETS, probeHostGate } from './gate-probe.mjs'

const PACKAGES = fileURLToPath(new URL('../../packages', import.meta.url))

function routeGatePackages() {
  return readdirSync(PACKAGES, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .filter((entry) => existsSync(join(PACKAGES, entry.name, 'lib/route-gate.mjs'))
      || existsSync(join(PACKAGES, entry.name, 'src/route-gate.mjs')))
    .map((entry) => entry.name)
    .sort()
}

function serve(handler) {
  return new Promise((resolve) => {
    const server = createServer(handler)
    server.listen(0, '127.0.0.1', () => resolve({ server, base: `http://127.0.0.1:${server.address().port}` }))
  })
}

test('目标表每条都是 /api/ 下的绝对路径,包名唯一且覆盖全部有路由闸门的包', () => {
  const names = new Set()
  for (const [name, path] of GATE_TARGETS) {
    assert.match(path, /^\/api\/[a-z0-9-]+(\/|$)/)
    assert.equal(names.has(name), false, `重复包名 ${name}`)
    names.add(name)
  }
  assert.deepEqual([...names].sort(), routeGatePackages(), 'GATE_TARGETS 必须与带 route-gate.mjs 的包集合一致')
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

test('live 包路由 404 判失败(装载成功但路由未注册)', async () => {
  const { server, base } = await serve((req, res) => {
    res.writeHead(404)
    res.end()
  })
  try {
    const result = await probeHostGate({
      base,
      cookie: 'session=good',
      packages: ['dsh-shared-terminal'],
      livePackages: new Set(['dsh-shared-terminal']),
    })
    assert.equal(result.ok, false)
    assert.equal(result.rows[0].anon, 404)
    assert.equal(result.rows[0].ok, false)
  } finally {
    server.close()
  }
})

test('非 live 包路由 404 跳过(--only 子集)', async () => {
  const { server, base } = await serve((req, res) => {
    res.writeHead(404)
    res.end()
  })
  try {
    const result = await probeHostGate({
      base,
      cookie: 'session=good',
      packages: ['dsh-shared-terminal'],
      livePackages: new Set(),
    })
    assert.equal(result.ok, true)
    assert.equal(result.rows[0].ok, true)
  } finally {
    server.close()
  }
})
