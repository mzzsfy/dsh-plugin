// 单版本端到端兼容性验证(docs/兼容性测试/测试与隔离方法.md 逐包标准流程的自动化):
// 宿主安装 → 隔离 profile → 杀旧进程 → boot(等就绪 + 取 token)→ HTTP 冒烟 →
// activation live + diagnostics findings 0 → 浏览器渲染探针 → 进程收尾。
// 判定门槛 = 统一底线:activation live + findings 0 + 页面无 Failed to load plugins + 正常访问。
// 用法:node scripts/compat/run.mjs --version <v> [--port N] [--host-dir PATH] [--work-root PATH]
import { spawn, spawnSync } from 'node:child_process'
import { createWriteStream, existsSync, writeFileSync, readFileSync, mkdirSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { createServer } from 'node:net'
import { join, resolve } from 'node:path'
import { COMPAT_ROOT, DSH_PACKAGE, DEFAULT_PORT, REPO_ROOT, workspaceYaml, runCmd, log } from './lib.mjs'
import { buildProfile } from './profile.mjs'

const BOOT_TIMEOUT_MS = 150 * 1000
const BOOT_SETTLE_MS = 8 * 1000
const READY_POLL_MS = 1.5 * 1000
const ACTIVATION_POLL_MS = 5 * 1000
const ACTIVATION_POLL_MAX = 24
const FETCH_TIMEOUT_MS = 10 * 1000

// 逐包安装 deps+devDeps(--omit=peer,与 CI test job 同款):包内模块级 import 的
// 宿主稳定导出(@deepseek-ai/*)靠包内 devDeps 解析;仓库文件解析链碰不到宿主安装目录。
// 过滤同 test job:仅含 @mzzsfy 自依赖或无依赖的包跳过,自依赖统一走符号链接桥
async function installPackageExternals() {
  const packagesDir = join(REPO_ROOT, 'packages')
  const installed = []
  for (const dir of readdirSync(packagesDir, { withFileTypes: true })) {
    if (!dir.isDirectory()) continue
    const pkgDir = join(packagesDir, dir.name)
    const manifestPath = join(pkgDir, 'package.json')
    if (!existsSync(manifestPath)) continue
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
    const hasExternal = [manifest.dependencies, manifest.devDependencies]
      .some((deps) => deps && Object.keys(deps).some((name) => !name.startsWith('@mzzsfy/')))
    if (!hasExternal) continue
    await runCmd('npm', ['install', '--omit=peer', '--legacy-peer-deps', '--no-save', '--no-package-lock', '--no-audit', '--no-fund'], { cwd: pkgDir })
    installed.push(manifest.name)
  }
  return installed
}

function parseArgs(argv) {
  const args = { port: DEFAULT_PORT, workRoot: COMPAT_ROOT }
  for (let i = 0; i < argv.length; i++) {
    const map = {
      '--version': () => { args.version = argv[++i] },
      '--port': () => { args.port = Number(argv[++i]) },
      '--host-dir': () => { args.hostDir = argv[++i] },
      '--work-root': () => { args.workRoot = argv[++i] },
    }
    const handler = map[argv[i]]
    if (!handler) throw new Error(`未知参数: ${argv[i]}`)
    handler()
  }
  if (!args.version) throw new Error('缺少 --version')
  // spawn 会切换 cwd,路径参数必须先定死为绝对
  args.workRoot = resolve(args.workRoot)
  if (args.hostDir) args.hostDir = resolve(args.hostDir)
  return args
}

// 端口可绑定探测:可绑定 = 无监听者
function canBind(port) {
  return new Promise((resolve) => {
    const server = createServer()
    server.once('error', () => resolve(false))
    server.once('listening', () => server.close(() => resolve(true)))
    server.listen(port, '127.0.0.1')
  })
}

function killPortOwner(port) {
  if (process.platform === 'win32') {
    spawnSync('powershell', ['-NoProfile', '-Command',
      `Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue | ` +
      'Select-Object -ExpandProperty OwningProcess -Unique | ' +
      'ForEach-Object { Stop-Process -Id $_ -Force -ErrorAction SilentlyContinue }'], { windowsHide: true })
  } else {
    spawnSync('fuser', ['-k', `${port}/tcp`], { windowsHide: true })
  }
}

// 进程树终止:宿主可能派生子进程,只杀直接子进程会残留
function killTree(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true })
  } else {
    try { process.kill(-child.pid, 'SIGTERM') } catch { child.kill('SIGTERM') }
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function fetchWithTimeout(url, options = {}) {
  return fetch(url, { ...options, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) })
}

async function waitBootReady(base, child, bootLogPath) {
  const deadline = Date.now() + BOOT_TIMEOUT_MS
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`宿主进程提前退出(码 ${child.exitCode ?? child.signalCode})\n${logTail(bootLogPath)}`)
    }
    try {
      const res = await fetchWithTimeout(base)
      if (res) return res.status
    } catch { /* 未就绪,继续轮询 */ }
    await sleep(READY_POLL_MS)
  }
  throw new Error(`boot 超时(${BOOT_TIMEOUT_MS / 1000}s 未监听)\n${logTail(bootLogPath)}`)
}

function logTail(path, lines = 40) {
  try {
    return readFileSync(path, 'utf8').split('\n').slice(-lines).join('\n')
  } catch { return '(无日志)' }
}

function extractToken(bootLogPath) {
  const text = readFileSync(bootLogPath, 'utf8')
  const matches = [...text.matchAll(/token=([A-Za-z0-9_-]{8,})/g)]
  return matches.at(-1)?.[1] ?? ''
}

// activation 全 live + diagnostics findings 0;未就绪(404/激活中)重试至多轮上限
async function checkActivation(base, token, bundleNames, workDir) {
  const url = `${base}/dsh-market/installed?token=${token}`
  const options = { headers: { Origin: base, Referer: `${base}/` } }
  let lastRaw = ''
  for (let attempt = 1; attempt <= ACTIVATION_POLL_MAX; attempt++) {
    try {
      const res = await fetchWithTimeout(url, options)
      lastRaw = await res.text()
      const data = JSON.parse(lastRaw)
      const activation = data.activation ?? data.data?.activation
      if (activation) {
        const findings = data.diagnostics?.findings ?? []
        const notLive = bundleNames.filter((name) => activation[name]?.state !== 'live')
        const done = {
          liveAll: notLive.length === 0,
          notLive,
          findingsCount: findings.length,
          findingsSample: findings.slice(0, 5),
          apiShape: Object.keys(data),
        }
        if (done.liveAll && done.findingsCount === 0) return done
        if (attempt === ACTIVATION_POLL_MAX) writeFileSync(join(workDir, 'installed.json'), lastRaw, 'utf8')
      }
    } catch { /* 未就绪(认证页/激活中),继续轮询 */ }
    await sleep(ACTIVATION_POLL_MS)
  }
  writeFileSync(join(workDir, 'installed.json'), lastRaw || '(空响应)', 'utf8')
  return { liveAll: false, notLive: bundleNames, findingsCount: -1, findingsSample: [], apiShape: [] }
}

function runBrowserProbe(probeScript, url, pngPath) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [probeScript, JSON.stringify({ url, pngPath })], {
      cwd: process.cwd(),
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => { stdout += chunk })
    child.stderr.on('data', (chunk) => { stderr += chunk })
    const timer = setTimeout(() => killTree(child), 90 * 1000)
    child.on('close', () => {
      clearTimeout(timer)
      const line = stdout.trim().split('\n').at(-1) ?? ''
      try {
        resolve(JSON.parse(line))
      } catch {
        resolve({ ok: false, rendered: false, error: `探针无输出: ${stderr.slice(-500) || line}` })
      }
    })
  })
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const workDir = join(args.workRoot, args.version)
  mkdirSync(workDir, { recursive: true })
  const bootLogPath = join(workDir, 'boot.log')
  const hostDir = args.hostDir ?? join(workDir, 'dsh-host')
  const base = `http://127.0.0.1:${args.port}`
  const checks = { page: false, activation: null, browser: null }

  // 宿主安装(幂等):已装则复用,支持 --host-dir 指向既有 .dsh-versions 目录
  const binGuess = join(hostDir, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
  if (!existsSync(binGuess)) {
    mkdirSync(hostDir, { recursive: true })
    writeFileSync(join(hostDir, 'package.json'), JSON.stringify({ name: 'dsh-compat-host', private: true }), 'utf8')
    writeFileSync(join(hostDir, 'pnpm-workspace.yaml'), workspaceYaml(), 'utf8')
    log(`[${args.version}] pnpm add ${DSH_PACKAGE}@${args.version}`)
    await runCmd('pnpm', ['add', `${DSH_PACKAGE}@${args.version}`], { cwd: hostDir })
  }

  log(`[${args.version}] 逐包外部依赖安装: ${(await installPackageExternals()).length} 包`)

  const profile = await buildProfile({ version: args.version, workRoot: args.workRoot, hostDir })
  log(`[${args.version}] bundles: ${profile.bundleNames.length} 包`)

  if (!(await canBind(args.port))) {
    log(`端口 ${args.port} 被占,清理旧进程`)
    killPortOwner(args.port)
    await sleep(3 * 1000)
    if (!(await canBind(args.port))) throw new Error(`端口 ${args.port} 清理后仍被占,请手动处理`)
  }

  const bootLog = createWriteStream(bootLogPath, { flags: 'w' })
  const child = spawn(process.execPath, [profile.binPath, 'web', '--no-open', '--port', String(args.port)], {
    cwd: profile.homeDir,
    env: {
      ...process.env,
      DSH_HOME: profile.homeDir,
      DSH_CRON_BOARD_DATA_DIR: join(workDir, 'data'),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  })
  child.stdout.pipe(bootLog)
  child.stderr.pipe(bootLog)

  try {
    const status = await waitBootReady(base, child, bootLogPath)
    await sleep(BOOT_SETTLE_MS)
    const token = extractToken(bootLogPath)
    log(`[${args.version}] boot 就绪(status ${status},token ${token ? '已取' : '未找到'})`)

    // token 换 cookie 是 302 重定向语义(fetch 不持 cookie,跟随重定向会落回 404),只验可达性
    const pageRes = await fetchWithTimeout(`${base}/?token=${token}`, { redirect: 'manual' })
    checks.page = pageRes.status === 200 || (pageRes.status >= 300 && pageRes.status < 400)

    checks.activation = await checkActivation(base, token, profile.bundleNames, workDir)
    log(`[${args.version}] activation live=${checks.activation.liveAll} findings=${checks.activation.findingsCount}`)

    checks.browser = await runBrowserProbe(
      fileURLToPath(new URL('./browser-probe.mjs', import.meta.url)),
      `${base}/?token=${token}`,
      join(workDir, 'page.png'),
    )
    log(`[${args.version}] browser ok=${checks.browser.ok}`)
  } finally {
    killTree(child)
    await sleep(2 * 1000)
    killTree(child)
    bootLog.end()
    if (!(await canBind(args.port))) {
      log(`端口 ${args.port} 残留监听,强制清理`)
      killPortOwner(args.port)
    }
  }

  const ok = checks.page && checks.activation.liveAll && checks.activation.findingsCount === 0 && checks.browser.ok
  writeFileSync(join(workDir, 'result.json'), JSON.stringify({ version: args.version, checks, ok }, null, 2), 'utf8')
  log(`[${args.version}] 判定 ${ok ? 'PASS' : 'FAIL'}(明细 ${join(workDir, 'result.json')})`)
  process.exitCode = ok ? 0 : 1
}

main().catch((error) => {
  console.error(`[compat] run 失败: ${error.message}`)
  process.exitCode = 1
})
