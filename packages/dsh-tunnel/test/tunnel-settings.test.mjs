// 隧道生命周期与设置页数据契约: 自动命名/健康/停用/PATCH/双栈/URL。
// 宿主面仍走真实 http.Server 替身, 不 mock 分发语义。
import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { once } from 'node:events'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { FakeHost, FUNCTION_FALLBACK, startTarget } from './support/fake-host.mjs'
import { applyPlugin, list, open, storeRows, tempDataDir } from './support/plugin.mjs'

const cleanup = []
test.after(async () => {
  for (const dispose of cleanup.reverse()) {
    await Promise.race([
      Promise.resolve(dispose()).then(() => undefined),
      new Promise((resolve) => setTimeout(resolve, 3000)),
    ])
  }
})

function request(host, path, options = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1',
      port: host.port,
      path,
      method: options.method ?? 'GET',
      headers: { host: options.host ?? `127.0.0.1:${host.port}`, ...options.headers },
    }, async (res) => {
      const chunks = []
      for await (const chunk of res) chunks.push(chunk)
      resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString() })
    })
    req.on('error', reject)
    if (options.body !== undefined) req.write(options.body)
    req.end()
  })
}

async function scenario(options = {}) {
  const host = new FakeHost({ fallbackShape: FUNCTION_FALLBACK })
  await host.listen()
  host.installFallback('host-fallback')
  const plugin = await applyPlugin(host, options)
  cleanup.push(() => plugin.dispose(), () => host.dispose())
  return { host, plugin }
}

async function startIpv6Target(body = 'ipv6-ok') {
  const server = http.createServer((req, res) => { res.writeHead(200); res.end(body) })
  server.listen(0, '::1')
  await once(server, 'listening')
  return {
    port: server.address().port,
    async stop() {
      server.closeAllConnections()
      await once(server.close(), 'close')
    },
  }
}

test('Given 旧盘行无 enabled When 恢复 Then 默认启用; 显式停用行不激活且状态为 disabled', async () => {
  const target = await startTarget((req, res) => { res.writeHead(200); res.end('ok') })
  cleanup.push(() => target.stop())
  const dataDir = tempDataDir()
  writeFileSync(join(dataDir, 'tunnels.json'), JSON.stringify([
    { name: 'legacy', targetPort: target.port, entry: 'path', createdAt: '2026-01-01T00:00:00.000Z' },
    { name: 'off', targetPort: target.port, entry: 'path', enabled: false, createdAt: '2026-01-02T00:00:00.000Z' },
  ]))
  const { host, plugin } = await scenario({ dataDir })
  const rows = (await list(plugin)).tunnels
  const legacy = rows.find((row) => row.name === 'legacy')
  const off = rows.find((row) => row.name === 'off')
  assert.equal(legacy.enabled, true)
  assert.equal(legacy.active, true)
  assert.equal(off.enabled, false)
  assert.equal(off.active, false)
  assert.equal(off.status, 'disabled')
  assert.equal((await request(host, '/p/off/')).body, 'host-fallback')
})

test('Given 目标只监听 ::1 When 走 path 隧道 Then 200 而非 502', async () => {
  const target = await startIpv6Target()
  cleanup.push(() => target.stop())
  const { host, plugin } = await scenario()
  const opened = await open(plugin, { name: 'v6', targetPort: target.port, entry: 'path' })
  assert.equal(opened.ok, true)
  const response = await request(host, '/p/v6/')
  assert.equal(response.status, 200)
  assert.equal(response.body, 'ipv6-ok')
})

test('Given 在线/离线/停用/路由失败四类行 When list probe=1 Then 状态矩阵正确', async () => {
  const target = await startTarget((req, res) => { res.writeHead(200); res.end('ok') })
  cleanup.push(() => target.stop())
  const dataDir = tempDataDir()
  const deadPort = 59999
  writeFileSync(join(dataDir, 'tunnels.json'), JSON.stringify([
    { name: 'online', targetPort: target.port, entry: 'path', enabled: true },
    { name: 'offline', targetPort: deadPort, entry: 'path', enabled: true },
    { name: 'disabled', targetPort: target.port, entry: 'path', enabled: false },
    { name: 'dsh', targetPort: target.port, entry: 'subdomain', enabled: true },
  ]))
  const { plugin } = await scenario({ dataDir })
  const rows = (await list(plugin, { probe: true })).tunnels
  const byName = new Map(rows.map((row) => [row.name, row]))
  assert.equal(byName.get('online').status, 'online')
  assert.equal(byName.get('online').health.state, 'online')
  assert.equal(byName.get('offline').status, 'offline')
  assert.equal(byName.get('offline').health.state, 'offline')
  assert.equal(byName.get('offline').error, undefined)
  assert.equal(byName.get('disabled').status, 'disabled')
  assert.equal(byName.get('disabled').health, undefined)
  assert.equal(byName.get('dsh').status, 'online', '子域名行与路径行按同一健康判据')
  assert.equal(byName.get('dsh').error, undefined)
})

test('Given 在线行 When PATCH enabled=false Then 路由摘除且重启仍停用; PATCH true 恢复', async () => {
  const target = await startTarget((req, res) => { res.writeHead(200); res.end('ok') })
  cleanup.push(() => target.stop())
  const { host, plugin } = await scenario()
  assert.equal((await open(plugin, { name: 'toggle', targetPort: target.port, entry: 'path' })).ok, true)
  const disabled = await request(host, '/api/tunnel/tunnels/toggle', {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ enabled: false }),
  })
  assert.equal(disabled.status, 200)
  assert.equal(JSON.parse(disabled.body).enabled, false)
  assert.equal((await request(host, '/p/toggle/')).body, 'host-fallback')
  assert.equal(storeRows(plugin.dataDir)[0].enabled, false)

  const enabled = await request(host, '/api/tunnel/tunnels/toggle', {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ enabled: true }),
  })
  assert.equal(enabled.status, 200)
  assert.equal((await request(host, '/p/toggle/')).body, 'ok')
  plugin.dispose()
  const restarted = await applyPlugin(host, { dataDir: plugin.dataDir })
  cleanup.push(() => restarted.dispose())
  assert.equal((await list(restarted)).tunnels[0].enabled, true)
})

test('Given 已激活行 When PATCH enabled=true 幂等 Then 不重复注册路由', async () => {
  const target = await startTarget((req, res) => { res.writeHead(200); res.end('ok') })
  cleanup.push(() => target.stop())
  const { host, plugin } = await scenario()
  assert.equal((await open(plugin, { name: 'idem', targetPort: target.port, entry: 'path' })).ok, true)
  const response = await request(host, '/api/tunnel/tunnels/idem', {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ enabled: true }),
  })
  assert.equal(response.status, 200)
  assert.equal((await request(host, '/p/idem/')).body, 'ok')
})

test('Given 在线行 When PATCH 非法 targetPort Then 400 且旧路由与旧配置保留', async () => {
  const target = await startTarget((req, res) => { res.writeHead(200); res.end('old') })
  cleanup.push(() => target.stop())
  const { host, plugin } = await scenario()
  assert.equal((await open(plugin, { name: 'edit', targetPort: target.port, entry: 'path' })).ok, true)
  const response = await request(host, '/api/tunnel/tunnels/edit', {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ targetPort: 70000 }),
  })
  assert.equal(response.status, 400)
  assert.equal((await request(host, '/p/edit/')).body, 'old')
  assert.equal(storeRows(plugin.dataDir)[0].targetPort, target.port)
})

test('Given 无 name When tunnel_open Then 自动命名 app-<port> 且重名自动后缀', async () => {
  const target = await startTarget((req, res) => { res.writeHead(200); res.end('ok') })
  cleanup.push(() => target.stop())
  const { plugin } = await scenario()
  const first = await open(plugin, { targetPort: target.port, entry: 'path' })
  assert.equal(first.ok, true)
  assert.equal(first.name, 'app-' + target.port)
  assert.match(first.url, /^https?:\/\/.+:\d+\/p\/app-/)
  if (first.lanUrl !== undefined) assert.match(first.lanUrl, /^https?:\/\/.+:\d+\/p\/app-/)
  const second = await open(plugin, { targetPort: target.port, entry: 'path' })
  assert.equal(second.name, 'app-' + target.port + '-2')
})

test('Given 宿主绑定显式网卡地址 When open path Then url/lanUrl 都是合法 scheme', async () => {
  const target = await startTarget((req, res) => { res.writeHead(200); res.end('ok') })
  cleanup.push(() => target.stop())
  const { host, plugin } = await scenario()
  host.host = '10.1.2.3'
  const opened = await open(plugin, { name: 'lan-scheme', targetPort: target.port, entry: 'path' })
  assert.equal(opened.ok, true)
  assert.equal(opened.url, `http://10.1.2.3:${host.port}/p/lan-scheme/`)
  assert.equal(opened.lanUrl, `http://10.1.2.3:${host.port}/p/lan-scheme/`)
})

test('Given 显式 name 冲突 When tunnel_open Then 400 不自动改名', async () => {
  const target = await startTarget((req, res) => { res.writeHead(200); res.end('ok') })
  cleanup.push(() => target.stop())
  const { plugin } = await scenario()
  assert.equal((await open(plugin, { name: 'same', targetPort: target.port, entry: 'path' })).ok, true)
  const again = await open(plugin, { name: 'same', targetPort: target.port, entry: 'path' })
  assert.equal(again.ok, false)
  assert.match(again.error, /已占用/)
})

test('Given 工具面 When 注册 Then 四件工具齐全, list 默认不探测', async () => {
  const { plugin } = await scenario()
  assert.deepEqual(Object.keys(plugin.tools).sort(), ['tunnel_close', 'tunnel_list', 'tunnel_open', 'tunnel_ports'])
  const result = await list(plugin)
  assert.equal(result.ok, true)
})
