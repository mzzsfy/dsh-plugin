// 单版本端到端兼容性验证(docs/兼容性测试/测试与隔离方法.md 逐包标准流程的自动化):
// 宿主安装 → 隔离 profile → 杀旧进程 → boot(等就绪 + 取 token)→ HTTP 冒烟 →
// activation live + diagnostics findings 0 → 浏览器渲染探针 → 进程收尾。
// 判定门槛 = 统一底线:activation live + findings 0 + 页面无 Failed to load plugins + 正常访问。
// 用法:node scripts/compat/run.mjs --version <v> [--port N] [--host-dir PATH] [--work-root PATH] [--skip-externals]
import { spawn, spawnSync } from 'node:child_process'
import { createWriteStream, existsSync, writeFileSync, readFileSync, mkdirSync, renameSync, rmSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { createServer } from 'node:net'
import { join, resolve } from 'node:path'
import { COMPAT_ROOT, DSH_PACKAGE, CORDIS_GROUP_PIN, DEFAULT_PORT, REPO_ROOT, workspaceYaml, runCmd, killPortOwner, symlinkDir, log } from './lib.mjs'
import { buildProfile, installPackageExternals } from './profile.mjs'
import { isSemver } from './window.mjs'

const BOOT_TIMEOUT_MS = 150 * 1000
const BOOT_SETTLE_MS = 8 * 1000
const READY_POLL_MS = 1.5 * 1000
const ACTIVATION_POLL_MS = 5 * 1000
const ACTIVATION_POLL_MAX = 24
const FETCH_TIMEOUT_MS = 10 * 1000
const KILL_GRACE_MS = 2 * 1000
// 根桥内与宿主版本耦合的解析面:运行期重指宿主闭包同版本,对齐生产
// healProfileModuleFallback 形态(插件 import 与宿主同源),结束后还原
const BRIDGE_PACKAGES = [
  '@deepseek-ai/dsh-storage-domain',
  '@deepseek-ai/dsh-tools',
  '@deepseek-ai/schemastery',
  'zod',
]

function parseArgs(argv) {
  const args = { port: DEFAULT_PORT, workRoot: COMPAT_ROOT }
  for (let i = 0; i < argv.length; i++) {
    const map = {
      '--version': () => { args.version = argv[++i] },
      '--port': () => { args.port = Number(argv[++i]) },
      '--host-dir': () => { args.hostDir = argv[++i] },
      '--work-root': () => { args.workRoot = argv[++i] },
      '--skip-externals': () => { args.skipExternals = true },
    }
    const handler = map[argv[i]]
    if (!handler) throw new Error(`未知参数: ${argv[i]}`)
    handler()
  }
  if (!args.version) throw new Error('缺少 --version')
  if (!isSemver(args.version)) throw new Error(`非法版本号: ${args.version}`)
  if (!Number.isInteger(args.port) || args.port < 1 || args.port > 65535) throw new Error(`--port 非法: ${args.port}`)
  // spawn 会切换 cwd,路径参数必须先定死为绝对
  args.workRoot = resolve(args.workRoot)
  if (args.hostDir) args.hostDir = resolve(args.hostDir)
  return args
}

// 根桥重指:dst 原位暂存为 .compat-bak;中途失败自动还原已重指部分
function repointBridgeFromHost(hostDir) {
  const backups = []
  const restore = () => {
    for (const { dst, backup } of backups) {
      rmSync(dst, { recursive: true, force: true })
      if (existsSync(backup)) renameSync(backup, dst)
    }
  }
  try {
    for (const name of BRIDGE_PACKAGES) {
      const src = join(hostDir, 'node_modules', name)
      const dst = join(REPO_ROOT, 'node_modules', name)
      if (!existsSync(src)) continue
      const backup = `${dst}.compat-bak`
      // 上次运行异常退出未还原(bak 残留):先恢复原桥,防止本次误删原件
      if (existsSync(backup)) {
        if (existsSync(dst)) rmSync(dst, { recursive: true, force: true })
        renameSync(backup, dst)
      }
      if (existsSync(dst)) renameSync(dst, backup)
      symlinkDir(src, dst)
      backups.push({ dst, backup })
    }
  } catch (error) {
    restore()
    throw error
  }
  return restore
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

// 进程树终止:宿主可能派生子进程,只杀直接子进程会残留(POSIX 需 detached 使子进程为组长)。
// 收尾函数自身不允许抛,失败路径的清理次序依赖它
function killTree(child, { force = false } = {}) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return
  try {
    if (process.platform === 'win32') {
      spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true })
    } else {
      const signal = force ? 'SIGKILL' : 'SIGTERM'
      try { process.kill(-child.pid, signal) } catch { child.kill(signal) }
    }
  } catch { /* 尽力而为,端口兜底清理在后 */ }
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
      const activation = data.activation
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
      detached: true,
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
  // 早退时 ci 会贴 result.json 当明细,陈旧文件必须先清
  rmSync(join(workDir, 'result.json'), { force: true })
  const bootLogPath = join(workDir, 'boot.log')
  const hostDir = args.hostDir ?? join(workDir, 'dsh-host')
  const base = `http://127.0.0.1:${args.port}`
  const checks = { page: false, activation: null, browser: null }

  // 宿主安装(幂等):已装则复用,支持 --host-dir 指向既有 .dsh-versions 目录
  const binGuess = join(hostDir, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
  const groupPath = join(hostDir, 'node_modules', '@deepseek-ai', 'cordis-plugin-group')
  if (!existsSync(binGuess)) {
    mkdirSync(hostDir, { recursive: true })
    // 幽灵依赖补装(CORDIS_GROUP_PIN):与 dsh 同闭包声明,一条 pnpm add 装齐
    writeFileSync(join(hostDir, 'package.json'), JSON.stringify({
      name: 'dsh-compat-host',
      private: true,
      dependencies: { '@deepseek-ai/cordis-plugin-group': CORDIS_GROUP_PIN },
    }), 'utf8')
    writeFileSync(join(hostDir, 'pnpm-workspace.yaml'), workspaceYaml(), 'utf8')
    log(`[${args.version}] pnpm add ${DSH_PACKAGE}@${args.version}`)
    await runCmd('pnpm', ['add', `${DSH_PACKAGE}@${args.version}`], { cwd: hostDir })
  } else if (!existsSync(groupPath)) {
    // 复用旧闭包路径:补齐缺失的幽灵依赖,防解析向上逃逸到仓库根产生跨机器不确定性
    log(`[${args.version}] 复用宿主闭包,补装 @deepseek-ai/cordis-plugin-group@${CORDIS_GROUP_PIN}`)
    await runCmd('pnpm', ['add', `@deepseek-ai/cordis-plugin-group@${CORDIS_GROUP_PIN}`], { cwd: hostDir })
  }

  log(`[${args.version}] 逐包外部依赖安装${args.skipExternals ? '(跳过)' : `: ${(await installPackageExternals()).length} 包`}`)

  const profile = await buildProfile({ version: args.version, workRoot: args.workRoot, hostDir })
  log(`[${args.version}] bundles: ${profile.bundleNames.length} 包`)

  if (!(await canBind(args.port))) {
    log(`端口 ${args.port} 被占,清理旧实例`)
    killPortOwner(args.port)
    await sleep(3 * 1000)
    if (!(await canBind(args.port))) throw new Error(`端口 ${args.port} 清理后仍被占,请手动处理`)
  }

  const bootLog = createWriteStream(bootLogPath, { flags: 'w' })
  let child = null
  let restoreBridge = null
  try {
    // detached 使 POSIX 子进程为进程组长,killTree 组杀才生效;win32 由 taskkill /T 承担
    child = spawn(process.execPath, [profile.binPath, 'web', '--no-open', '--port', String(args.port)], {
      cwd: profile.homeDir,
      env: {
        ...process.env,
        DSH_HOME: profile.homeDir,
        DSH_CRON_BOARD_DATA_DIR: join(workDir, 'data'),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      detached: true,
    })
    child.stdout.pipe(bootLog)
    child.stderr.pipe(bootLog)

    restoreBridge = repointBridgeFromHost(hostDir)

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
    await sleep(KILL_GRACE_MS)
    killTree(child, { force: true })
    await new Promise((done) => bootLog.end(done))
    restoreBridge?.()
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
