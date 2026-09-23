// dsh-tunnel 全链路验证: 隔离 dsh 实例(compat 同款机制)内真实激活插件,
// 预种持久化表恢复双模式隧道, 经真实 webServer 分发面验证子域名/路径/WS/宿主共存。
// 用法: node scripts/compat/tunnel-fullchain.mjs [version] [port]
// 判定: 七项探针全过 = PASS
import http from 'node:http'
import { spawn, spawnSync } from 'node:child_process'
import { createServer } from 'node:net'
import { createWriteStream, mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { COMPAT_ROOT, killPortOwner, log } from './lib.mjs'
import { buildProfile, installPackageExternals } from './profile.mjs'

const VERSION = process.argv[2] ?? '0.1.7-alpha.2'
const PORT = Number(process.argv[3] ?? 9295)
const BOOT_TIMEOUT_MS = 150 * 1000
const READY_POLL_MS = 1500
const FETCH_TIMEOUT_MS = 10 * 1000
const WS_KEY = 'dGhlIHNhbXBsZSBub25jZQ=='

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function canBind(port) {
  return new Promise((resolve) => {
    const server = createServer()
    server.once('error', () => resolve(false))
    server.once('listening', () => server.close(() => resolve(true)))
    server.listen(port, '127.0.0.1')
  })
}

function killTree(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return
  try {
    spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true })
  } catch { /* 端口兜底在后 */ }
}

// Host 头可控的 HTTP 探针(fetch 不可设 Host, 一律 http.request)
function probeHttp(port, host, path) {
  return new Promise((resolve, reject) => {
    const request = http.request({ host: '127.0.0.1', port, path, headers: { host } }, async (res) => {
      const chunks = []
      for await (const chunk of res) chunks.push(chunk)
      resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString() })
    })
    request.setTimeout(FETCH_TIMEOUT_MS, () => {
      request.destroy()
      reject(new Error('探针超时'))
    })
    request.on('error', reject)
    request.end()
  })
}

// 任意路径 upgrade 探针: 断言 101 + 帧回环
function probeWs(port, host, path) {
  return new Promise((resolve) => {
    const request = http.request({
      host: '127.0.0.1',
      port,
      path,
      headers: { host, connection: 'Upgrade', upgrade: 'websocket', 'sec-websocket-key': WS_KEY, 'sec-websocket-version': '13' },
    })
    request.end()
    const timer = setTimeout(() => resolve({ ok: false, error: 'upgrade 超时' }), FETCH_TIMEOUT_MS)
    request.once('upgrade', (res, socket) => {
      socket.write('probe-frame')
      socket.once('data', (chunk) => {
        clearTimeout(timer)
        socket.destroy()
        resolve({ ok: res.statusCode === 101 && chunk.toString() === 'probe-frame', status: res.statusCode })
      })
    })
    request.once('response', (res) => {
      clearTimeout(timer)
      resolve({ ok: false, error: `未升级: ${res.statusCode}` })
    })
    request.once('error', (error) => {
      clearTimeout(timer)
      resolve({ ok: false, error: error.message })
    })
  })
}

// 目标应用: 回显 path/host/forwarded 头 + WS 回环, 供各探针断言
function startTarget() {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain' })
    res.end(JSON.stringify({ url: req.url, host: req.headers.host, fwdHost: req.headers['x-forwarded-host'] }))
  })
  server.on('upgrade', (req, socket) => {
    socket.write('HTTP/1.1 101 Switching Protocols\r\nconnection: Upgrade\r\nupgrade: websocket\r\n\r\n')
    socket.pipe(socket)
  })
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)))
}

async function waitBoot(base, child, bootLogPath) {
  const deadline = Date.now() + BOOT_TIMEOUT_MS
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) throw new Error(`宿主提前退出\n${logTail(bootLogPath)}`)
    try {
      await fetch(`http://127.0.0.1:${new URL(base).port}/`, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) })
      return
    } catch { /* 未就绪 */ }
    await sleep(READY_POLL_MS)
  }
  throw new Error(`boot 超时\n${logTail(bootLogPath)}`)
}

async function waitToken(bootLogPath) {
  const deadline = Date.now() + BOOT_TIMEOUT_MS
  while (Date.now() < deadline) {
    const token = extractToken(bootLogPath)
    if (token) return token
    await sleep(READY_POLL_MS)
  }
  throw new Error('token 未出现')
}

function logTail(path, lines = 40) {
  try {
    return readFileSync(path, 'utf8').split('\n').slice(-lines).join('\n')
  } catch {
    return '(无日志)'
  }
}

function extractToken(bootLogPath) {
  const text = readFileSync(bootLogPath, 'utf8')
  return [...text.matchAll(/token=([A-Za-z0-9_-]{8,})/g)].at(-1)?.[1] ?? ''
}

const isTargetBody = (body) => body.includes('"fwdHost"')

const target = await startTarget()
const targetPort = target.address().port
const workRoot = COMPAT_ROOT
const workDir = join(workRoot, VERSION)
const homeDir = join(workDir, 'home')
const bootLogPath = join(workDir, 'tunnel-boot.log')

// 预种持久化表: 与隔离实例同存储解析(DSH_HOME/dsh-tunnel);
// sub1 = 子域名, pat1 = 路径模式(带 WS), 均指向本探针的 target
mkdirSync(join(homeDir, 'dsh-tunnel'), { recursive: true })
writeFileSync(join(homeDir, 'dsh-tunnel', 'tunnels.json'), JSON.stringify([
  { name: 'sub1', targetPort, entry: 'subdomain', wsPaths: [], createdAt: new Date().toISOString() },
  { name: 'pat1', targetPort, entry: 'path', wsPaths: ['/ws'], createdAt: new Date().toISOString() },
], null, 2), 'utf8')
log(`预种隧道表(target=${targetPort}), 构建 profile`)

const profile = await buildProfile({ version: VERSION, workRoot, hostDir: join(workDir, 'dsh-host') })
log(`bundles ${profile.bundleNames.length} 包, dsh-tunnel 在列: ${profile.bundleNames.includes('@mzzsfy/dsh-tunnel')}`)

// 逐包外部依赖必须晚于隔离 profile 的 pnpm install(与 run.mjs 同款):
// pnpm 解析 link: 依赖会同步清空源目录 node_modules, 补装在 pnpm 之后
const externals = await installPackageExternals()
log(`逐包外部依赖安装: ${externals.length} 包`)

if (!(await canBind(PORT))) {
  log(`端口 ${PORT} 被占, 清理`)
  killPortOwner(PORT)
  await sleep(3000)
}

writeFileSync(bootLogPath, '', 'utf8')
const bootLog = createWriteStream(bootLogPath, { flags: 'a' })
let child = null
const results = {}
try {
  child = spawn(process.execPath, [profile.binPath, 'web', '--no-open', '--port', String(PORT)], {
    cwd: homeDir,
    env: { ...process.env, DSH_HOME: homeDir, DSH_CRON_BOARD_DATA_DIR: join(workDir, 'tunnel-data') },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
    detached: true,
  })
  child.stdout.pipe(bootLog)
  child.stderr.pipe(bootLog)

  await waitBoot(`ws://x:${PORT}`, child, bootLogPath)
  await waitToken(bootLogPath)
  log('boot 就绪')

  // 探针统一收口: 单项异常计 FAIL 不中断报告
  const probe = async (name, fn) => {
    try {
      results[name] = await fn()
    } catch (error) {
      results[name] = false
      log(`探针 ${name} 异常: ${error.message}`)
    }
  }

  await probe('子域名HTTP无strip透传', async () => {
    // miss 路径经 fallback 座包装进分发
    const sub = await probeHttp(PORT, 'sub1.localhost', '/deep/path?q=1')
    const subBody = JSON.parse(sub.body)
    return sub.status === 200 && subBody.url === '/deep/path?q=1' && subBody.host === 'sub1.localhost'
  })
  await probe('子域名隔离优先级', async () => {
    // /api 前缀命中宿主路由但被隧道截获
    const subApi = await probeHttp(PORT, 'sub1.localhost', '/api/whatever')
    return subApi.status === 200 && JSON.parse(subApi.body).url === '/api/whatever'
  })
  await probe('子域名动态WS', async () => {
    // jupyter 内核通道形态, upgrades 表 miss 层合成
    return (await probeWs(PORT, 'sub1.localhost', '/api/kernels/9f8e7d6c-1234-4321-abcd-001122334455/channels')).ok
  })
  await probe('路径模式strip转发', async () => {
    const pat = await probeHttp(PORT, '127.0.0.1', '/p/pat1/hello')
    const patBody = JSON.parse(pat.body)
    return pat.status === 200 && patBody.url === '/hello'
  })
  await probe('路径模式WS', async () => (await probeWs(PORT, '127.0.0.1', '/p/pat1/ws')).ok)
  await probe('宿主GUI共存', async () => {
    // 非隧道 Host 首页宿主自答(200/3xx/401), 绝不是 target 回显
    const gui = await probeHttp(PORT, '127.0.0.1', '/')
    return (gui.status === 200 || (gui.status >= 300 && gui.status < 500)) && !isTargetBody(gui.body)
  })
  await probe('非隧道域名不劫持', async () => {
    const notTunnel = await probeHttp(PORT, 'gui.localhost', '/')
    return notTunnel.status !== 200 || !isTargetBody(notTunnel.body)
  })
} finally {
  killTree(child)
  await sleep(2000)
  killTree(child)
  if (!(await canBind(PORT))) killPortOwner(PORT)
  target.close()
  target.closeAllConnections()
  bootLog.end()
}

for (const [name, ok] of Object.entries(results)) log(`${ok ? 'PASS' : 'FAIL'} ${name}`)
const allOk = Object.values(results).every(Boolean)
log(`全链路判定 ${allOk ? 'PASS' : 'FAIL'}(boot 日志 ${bootLogPath})`)
process.exitCode = allOk ? 0 : 1
