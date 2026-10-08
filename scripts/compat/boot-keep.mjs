// L3 逐包轮宿主看护:常驻进程持有宿主为直接子进程并守护重启。
// WMI Win32_Process.Create 启动本进程(WMI 上下文不在 pwsh executor 的 job
// 对象内,跨命令存活——实测孤儿形态会被滞后清理扫掉,必须常驻持有)。
// 宿主退出即按同参重启并更新 live.json(新 boot 新 token);STOP 文件存在则退出。
// 用法:node scripts/compat/boot-keep.mjs --daemon --version <v> [--only 包,包] [--port N]
import { spawn } from 'node:child_process'
import { createWriteStream, existsSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { isSemver } from './window.mjs'
import { buildProfile, enumeratePackages } from './profile.mjs'
import { COMPAT_ROOT, DEFAULT_PORT, killPortOwner, log } from './lib.mjs'

const BOOT_TIMEOUT_MS = 150 * 1000
const READY_POLL_MS = 1500
const WATCH_POLL_MS = 5000

// gateway LLM 链路的 echo 路由 seed:宿主重启会重写 profile cordis.patch.yml,
// 每轮 boot 前幂等补行(行形态与 profile.mjs seedGatewayEntry 一致,端口 18123)
// seed 跟随 --only 意图(V6 根因修复):gateway/think 的 seed 行是非 insert 形态,
// 只能改写 bundle 层已 insert 的条目;包不在 --only 即不在 bundles,注入必打空
// (app-boot applyEntryPatches :95-98 warn+skip,宿主不自愈)。此前无条件注入,
// --only 单包轮每 boot 产出 not found warn 且 seed 静默无效
function ensureGatewaySeed(patchPath, logFn, { gateway = false, think = false } = {}) {
  if (!gateway && !think) return []
  const seeded = []
  try {
    const current = readFileSync(patchPath, 'utf8')
    // 官方行静态禁用(takeover 本位形态):运行时禁用会在冷 boot 触发宿主
    // inject-epoch 级联('llm' impl 换 fiber → gateway fiber 卸载 → 注册全灭
    // 且无重建);官方行从不动则零级联,复活由 gateway 守卫接管。
    // DSH_COMPAT_SKIP_OFFICIAL_SEED=1 跳过:guard 孤儿自愈活体验证需要官
    // 方启用形态的级联场景,与 seed 静态禁用互斥
    // 单次写盘:多块拼接后一次写,分次写会用 stale 内容互相抹除(实证缺陷)
    let pending = current
    if (gateway && process.env.DSH_COMPAT_SKIP_OFFICIAL_SEED !== '1' && !/^-\s*id:\s*llm-pi-ai\s*$/m.test(current)) {
      // 块前空行:紧接 models 列表尾会被 YAML 缩进歧义解析为子项而被宿主丢弃
      pending = pending.replace(/\n*$/, '\n') + ['', '- id: llm-pi-ai', '  disabled: true', ''].join('\n')
      logFn('[daemon] official row static-disable injected')
    }
    if (gateway && !current.includes('llm-pi-gateway')) {
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
        '          - id: echo-model-think',
        '            name: Echo Think Model',
        '            input:',
        '              - text',
        '          - id: echo-model-tool',
        '            name: Echo Tool Model',
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
      pending = pending.replace(/\n*$/, '\n') + seedRows
      writeFileSync(patchPath, pending, 'utf8')
      logFn(`[daemon] gateway seed rows injected -> ${patchPath}`)
      return think ? ['llm-pi-gateway', 'think-expand'] : ['llm-pi-gateway']
    }
    if (pending !== current) {
      // 仅官方行块被拼接(gateway 行已在)的路径:在此统一落盘
      writeFileSync(patchPath, pending, 'utf8')
    }
    if (gateway) seeded.push('llm-pi-gateway')
    // 宿主重启会重写 patch 规范形(丢扩展模型行);幂等补 think/tool 模型行
    // (流式思考断言依赖 -think 后缀,工具链断言依赖 -tool 后缀)
    const MODEL_TAIL = '          - id: echo-model\n            name: Echo Model\n            input:\n              - text'
    const EXT_BLOCK = [
      '          - id: echo-model',
      '            name: Echo Model',
      '            input:',
      '              - text',
      '          - id: echo-model-think',
      '            name: Echo Think Model',
      '            input:',
      '              - text',
      '          - id: echo-model-tool',
      '            name: Echo Tool Model',
      '            input:',
      '              - text',
      '',
    ].join('\n')
    if ((think || gateway) && !pending.includes('echo-model-tool') && pending.includes(MODEL_TAIL)) {
      // 基于 pending(含官方行块)修补,再落盘,防 stale 抹除
      const patched = pending.replace(MODEL_TAIL, EXT_BLOCK)
      writeFileSync(patchPath, patched, 'utf8')
      logFn('[daemon] gateway think/tool model rows injected')
    }
    if (think) seeded.push('think-expand')
  } catch (error) {
    logFn(`[daemon] gateway seed skip: ${error.message}`)
  }
  return seeded
}

function parseArgs(argv) {
  const args = { port: DEFAULT_PORT }
  for (let i = 0; i < argv.length; i++) {
    const map = {
      '--version': () => { args.version = argv[++i] },
      '--port': () => { args.port = Number(argv[++i]) },
      '--host-dir': () => { args.hostDir = argv[++i] },
      '--daemon': () => { args.daemon = true },
      // 会话夹具轮(#5/#6 类需要伪造会话跨重启存活)跳过净启动清理
      '--keep-sessions': () => { args.keepSessions = true },
      '--only': () => {
        const short = argv[++i]
        args.only = [...(args.only ?? []), ...short.split(',').map((s) => s.trim()).filter(Boolean)]
      },
    }
    const handler = map[argv[i]]
    // 后台任务运行器会向命令行尾注附加 token(实测注入 AGENTS.md):裸 token 忽略,未知选项仍抛错
    if (!handler) {
      if (argv[i].startsWith('--')) throw new Error(`未知参数: ${argv[i]}`)
      continue
    }
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
const hostDir = args.hostDir ? resolve(args.hostDir) : join(workDir, 'dsh-host')
const stopFlag = join(workDir, 'boot-keep.stop')
const binPath = join(hostDir, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
if (!existsSync(binPath)) throw new Error(`宿主闭包缺失,先跑 run.mjs --version ${version} 完成安装: ${binPath}`)

// keeper 互斥锁(V8):双 keeper 同工作目录会互杀宿主(killPortOwner 清场 + 各自
// respawn 循环 = 无限互踩)或同 home 静默共写(sessions/patch 竞态)。锁按 pid
// 存活判定自愈陈旧项,持有期写 pid,STOP 标记退出时释放
const keeperLockPath = join(workDir, 'boot-keep.lock')
function acquireKeeperLock() {
  if (existsSync(keeperLockPath)) {
    let holder = null
    try { holder = JSON.parse(readFileSync(keeperLockPath, 'utf8')) } catch { /* 损坏锁按陈旧处理 */ }
    // process.kill(pid,0):存活返回 true;死亡抛 ESRCH;必须 try/catch 判定
    let alive = false
    try { alive = holder ? process.kill(holder.pid, 0) : false } catch { alive = false }
    if (alive) throw new Error(`工作目录已被另一 keeper 持有(pid ${holder.pid},锁 ${keeperLockPath});确认无误后删除锁文件可强制接管`)
    log(`[daemon] 清理陈旧 keeper 锁(持有者 pid ${holder?.pid} 已不存在)`)
  }
  writeFileSync(keeperLockPath, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }), 'utf8')
}
acquireKeeperLock()

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
  // 陈旧 live.json 会在就绪前误导读取方(死 token 401 / 旧 bundles),每轮 spawn 前净删
  rmSync(join(workDir, 'live.json'), { force: true })
  if (!(await canBind(port))) {
    log(`[daemon] 端口 ${port} 被占,清理`)
    killPortOwner(port)
    await sleep(3000)
    if (!(await canBind(port))) throw new Error(`端口 ${port} 清理后仍被占`)
  }
  // 每轮净启动:清上轮会话存储(跨宿主版本不兼容);--keep-sessions 夹具轮豁免
  if (args.keepSessions !== true) {
    rmSync(join(profile.homeDir, 'sessions'), { recursive: true, force: true })
  }
  // seed 跟随 --only:包在 --only(bundles)才注入对应行,else 打空(V6 根因)
  const seeded = ensureGatewaySeed(join(profile.homeDir, 'profiles', 'web', 'cordis.patch.yml'), log, {
    gateway: wantedShort.includes('dsh-llm-pi-gateway'),
    think: wantedShort.includes('dsh-think-expand'),
  })
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
      DSH_HISTORY_CACHE_DIR: join(workDir, 'data', 'context-manager-history'),
      DSH_RS_WORKFLOW_DATA_DIR: join(workDir, 'data', 'rs-workflow'),
      DSH_RS_WORKFLOW_PRESET_ROOT: join(workDir, 'data', 'rs-workflow-presets'),
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
            port, token, pid: child.pid, mode: 'daemon', bundles: profile.bundleNames, homeDir: profile.homeDir, seeded,
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
    rmSync(keeperLockPath, { force: true })
    process.exit(0)
  }
  await sleep(WATCH_POLL_MS)
  if (child.exitCode === null) continue
  log(`[daemon] 宿主退出 code=${child.exitCode},重启`)
  child = await bootOnce()
}
