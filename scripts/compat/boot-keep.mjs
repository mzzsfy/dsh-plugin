// L3 逐包轮宿主看护:常驻进程持有宿主为直接子进程并守护重启。
// WMI Win32_Process.Create 启动本进程(WMI 上下文不在 pwsh executor 的 job
// 对象内,跨命令存活——实测孤儿形态会被滞后清理扫掉,必须常驻持有)。
// 宿主退出即按同参重启并更新 live.json(新 boot 新 token);STOP 文件存在则退出。
// 用法:node scripts/compat/boot-keep.mjs --daemon --version <v> [--only 包,包] [--port N]
import { spawn } from 'node:child_process'
import { createWriteStream, existsSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { isSemver } from './window.mjs'
import { buildProfile, enumeratePackages } from './profile.mjs'
import { COMPAT_ROOT, DEFAULT_PORT, killPortOwner, log } from './lib.mjs'

const BOOT_TIMEOUT_MS = 150 * 1000
const READY_POLL_MS = 1500
const WATCH_POLL_MS = 5000

// gateway LLM 链路的 echo 路由 seed:宿主重启会重写 profile cordis.patch.yml,
// 每轮 boot 前幂等补行(行形态与 profile.mjs seedGatewayEntry 一致,端口 18123)
function ensureGatewaySeed(patchPath, logFn) {
  const seedRows = [
    '- id: llm-pi-gateway',
    '  name: "@mzzsfy/dsh-llm-pi-gateway"',
    '  config:',
    '    providers:',
    '      echo-openai:',
    '        displayName: Echo OpenAI',
    '        api: openai-completions',
    '        baseURL: http://127.0.0.1:18123',
    '        apiKeyEnv: ECHO_KEY',
    '        defaultInput:',
    '          - text',
    '        models:',
    '          - id: echo-model',
    '            name: Echo Model',
    '            input:',
    '              - text',
    '      echo-anthropic:',
    '        displayName: Echo Anthropic',
    '        api: anthropic-messages',
    '        baseURL: http://127.0.0.1:18123',
    '        apiKeyEnv: ECHO_KEY',
    '        defaultInput:',
    '          - text',
    '        compat:',
    '          sendSessionAffinityHeaders: true',
    '        models:',
    '          - id: echo-a-model',
    '            name: Echo A Model',
    '            input:',
    '              - text',
    '',
  ].join('\n')
  try {
    const current = readFileSync(patchPath, 'utf8')
    if (current.includes('llm-pi-gateway')) return
    writeFileSync(patchPath, current + seedRows, 'utf8')
    logFn(`[daemon] gateway seed rows injected -> ${patchPath}`)
  } catch (error) {
    logFn(`[daemon] gateway seed skip: ${error.message}`)
  }
}

function parseArgs(argv) {
  const args = { port: DEFAULT_PORT }
  for (let i = 0; i < argv.length; i++) {
    const map = {
      '--version': () => { args.version = argv[++i] },
      '--port': () => { args.port = Number(argv[++i]) },
      '--host-dir': () => { args.hostDir = argv[++i] },
      '--daemon': () => { args.daemon = true },
      '--only': () => {
        const short = argv[++i]
        args.only = [...(args.only ?? []), ...short.split(',').map((s) => s.trim()).filter(Boolean)]
      },
    }
    const handler = map[argv[i]]
    if (!handler) throw new Error(`未知参数: ${argv[i]}`)
    handler()
  }
  if (!args.version || !isSemver(args.version)) throw new Error(`--version 缺失或非法: ${args.version}`)
  return args
}

function sleep(ms) { return new Promise((done) => setTimeout(done, ms)) }

function canBind(p) {
  return new Promise((resolve) => {
    import('node:net').then(({ createServer }) => {
      const server = createServer()
      server.once('error', () => resolve(false))
      server.once('listening', () => server.close(() => resolve(true)))
      server.listen(p, '127.0.0.1')
    })
  })
}

const args = parseArgs(process.argv.slice(2))
const { version, port } = args
const workDir = join(COMPAT_ROOT, version)
const hostDir = join(workDir, 'dsh-host')
const stopFlag = join(workDir, 'boot-keep.stop')
const binPath = join(hostDir, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
if (!existsSync(binPath)) throw new Error(`宿主闭包缺失,先跑 run.mjs --version ${version} 完成安装: ${binPath}`)

// 幂等 profile:bundles 形态与工作副本桥都齐时跳过重建(pnpm install 分钟级,逐包轮同闭包形态复用)
const { bundles: repoBundles } = enumeratePackages()
const wantedShort = (args.only ?? []).map((n) => n.replace(/^@mzzsfy\//, ''))
const wantedBundles = wantedShort.length > 0
  ? repoBundles.filter((name) => wantedShort.includes(name.replace(/^@mzzsfy\//, ''))).map((name) => `@mzzsfy/${name}`)
  : repoBundles.map((name) => `@mzzsfy/${name}`)
const profileManifestPath = join(workDir, 'home', 'profiles', 'web', 'package.json')
const linkBase = join(workDir, 'home', 'profiles', 'web', 'node_modules', '@mzzsfy')
const expectShape = [...new Set(['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'dshmarket', ...wantedBundles])]
const profileReuseReady = existsSync(profileManifestPath)
  && JSON.parse(readFileSync(profileManifestPath, 'utf8'))?.dsh?.profile?.bundles?.join('|') === expectShape.join('|')
  && wantedBundles.every((name) => existsSync(join(linkBase, name.replace('@mzzsfy/', ''))))
let profile
if (profileReuseReady) {
  profile = { homeDir: join(workDir, 'home'), binPath, bundleNames: wantedBundles }
  log(`[daemon] ${version} profile 复用 bundles=${profile.bundleNames.length}`)
} else {
  profile = await buildProfile({ version, workRoot: COMPAT_ROOT, hostDir, only: args.only ?? [] })
  log(`[daemon] ${version} profile 构建 bundles=${profile.bundleNames.length}`)
}

async function bootOnce() {
  if (!(await canBind(port))) {
    log(`[daemon] 端口 ${port} 被占,清理`)
    killPortOwner(port)
    await sleep(3000)
    if (!(await canBind(port))) throw new Error(`端口 ${port} 清理后仍被占`)
  }
  // 每轮净启动:清上轮会话存储(跨宿主版本不兼容)
  rmSync(join(profile.homeDir, 'sessions'), { recursive: true, force: true })
  ensureGatewaySeed(join(profile.homeDir, 'profiles', 'web', 'cordis.patch.yml'), log)
  const bootLog = createWriteStream(join(workDir, 'boot-l3.log'), { flags: 'w' })
  const child = spawn(process.execPath, [binPath, 'web', '--no-open', '--port', String(port)], {
    cwd: profile.homeDir,
    env: {
      ...process.env,
      DSH_HOME: profile.homeDir,
      // 逐包数据目录隔离:缺一会写到生产 ~/.dsh(测试不是只读操作,测试任务会被
      // 生产调度器拾取、账号 Key 明文落生产文件)。新增带数据目录的包时在此追加
      DSH_CRON_BOARD_DATA_DIR: join(workDir, 'data', 'cron-board'),
      DSH_USAGE_PANEL_DATA_DIR: join(workDir, 'data', 'usage-panel'),
      // gateway LLM 链路凭据:apiKeyEnv 引用名 ECHO_KEY 走进程 env 通道(run.mjs 同款)
      ECHO_KEY: 'echo-compat',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  })
  child.stdout.pipe(bootLog)
  child.stderr.pipe(bootLog)
  log(`[daemon] 宿主 spawn pid=${child.pid}`)
  const base = `http://127.0.0.1:${port}`
  const deadline = Date.now() + BOOT_TIMEOUT_MS
  let token = null
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`宿主早退 code=${child.exitCode},日志 ${join(workDir, 'boot-l3.log')}`)
    try {
      const text = readFileSync(join(workDir, 'boot-l3.log'), 'utf8')
      const hits = [...text.matchAll(/token=([A-Za-z0-9_-]+)/g)]
      if (hits.length > 0) token = hits.at(-1)[1]
    } catch { /* 日志未落 */ }
    if (token !== null) {
      try {
        const res = await fetch(`${base}/?token=${token}`, { redirect: 'manual', signal: AbortSignal.timeout(4000) })
        if (res.status === 200 || (res.status >= 300 && res.status < 400)) {
          writeFileSync(join(workDir, 'live.json'), JSON.stringify({
            port, token, pid: child.pid, mode: 'daemon', bundles: profile.bundleNames, homeDir: profile.homeDir,
          }, null, 2), 'utf8')
          log(`[daemon] 就绪:${base}/?token=${token} pid=${child.pid}`)
          return child
        }
      } catch { /* 前端未就绪 */ }
    }
    await sleep(READY_POLL_MS)
  }
  child.kill()
  throw new Error(`boot 超时未就绪,日志 ${join(workDir, 'boot-l3.log')}`)
}

let child = await bootOnce()
while (true) {
  if (existsSync(stopFlag)) {
    log('[daemon] STOP 标记,退出(杀宿主)')
    try { child.kill() } catch { /* 已退 */ }
    await sleep(2000)
    try { child.kill('SIGKILL') } catch { /* 已退 */ }
    rmSync(stopFlag, { force: true })
    process.exit(0)
  }
  await sleep(WATCH_POLL_MS)
  if (child.exitCode === null) continue
  log(`[daemon] 宿主退出 code=${child.exitCode},重启`)
  child = await bootOnce()
}
