// L3 逐包轮宿主看护:常驻进程持有宿主为直接子进程并守护重启。
// WMI Win32_Process.Create 启动本进程(WMI 上下文不在 pwsh executor 的 job
// 对象内,跨命令存活——实测孤儿形态会被滞后清理扫掉,必须常驻持有)。
// 宿主退出即按同参重启并更新 live.json(新 boot 新 token);STOP 文件存在则退出。
// 用法:node scripts/compat/boot-keep.mjs --daemon --version <v> [--only 包,包] [--port N]
//   [--work-root DIR](独立工位目录,默认 .compat) [--llm-port N](echo 模拟器端口,seed 与探活用,默认 18123) [--host-dir PATH]
//   [--refuse-port-owner](端口被占即拒绝清理) [--keep-sessions](夹具轮跳过净启动清会话)
import { spawn } from 'node:child_process'
import { createWriteStream, existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { isSemver } from './window.mjs'
import { buildProfile, enumeratePackages } from './profile.mjs'
import { repointBridgeFromHost } from './run.mjs'
import { compatEnv } from './env.mjs'
import { COMPAT_ROOT, DEFAULT_PORT, killPortOwner, log } from './lib.mjs'
import { BOOT_TIMEOUT_MS, KeeperStop, READY_POLL_MS, awaitEchoReady, awaitHostReady, stopRequestedBy } from './boot-ready.mjs'

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const KEEPER_STARTED_AT = Date.now()
const WATCH_POLL_MS = 5000

// gateway LLM 链路的 echo 路由 seed:宿主重启会重写 profile cordis.patch.yml,
// 每轮 boot 前幂等补行(行形态与 profile.mjs seedGatewayEntry 一致,端口 18123)
// 装饰器形态:echo 路由声明在官方 llm-pi-ai 节(官方行自服务,gateway 仅经
// registerAdapter shadow 装饰,不服务任何路由);gateway 节仅 sessionMarker。
// 不再注入官方行静态禁用(接管形态遗产,已退役)
function ensureGatewaySeed(patchPath, logFn, { gateway = false, think = false, llmPort = 18123 } = {}) {
  if (!gateway && !think) return []
  const seeded = []
  try {
    const current = readFileSync(patchPath, 'utf8')
    if (gateway && !current.includes('echo-anthropic')) {
      const seedRows = [
        '- id: llm-pi-ai',
        '  config:',
        '    providers:',
        '      echo-openai:',
        '        displayName: Echo OpenAI',
        '        api: openai-completions',
        `        baseURL: http://127.0.0.1:${llmPort}`,
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
        `        baseURL: http://127.0.0.1:${llmPort}`,
        '        apiKeyEnv: ECHO_KEY',
        '        defaultInput:',
        '          - text',
        '        models:',
        '          - id: echo-a-model',
        '            name: Echo A Model',
        '            input:',
        '              - text',
        '- id: llm-pi-gateway',
        '  name: "@mzzsfy/dsh-llm-pi-gateway"',
        '  config:',
        '    sessionMarker:',
        '      enabled: true',
        '      prefix: dsh',
        '',
      ].join('\n')
      const pending = current.replace(/\n*$/, '\n') + seedRows
      writeFileSync(patchPath, pending, 'utf8')
      logFn(`[daemon] decorator seed rows injected -> ${patchPath}`)
      return think ? ['llm-pi-gateway', 'think-expand'] : ['llm-pi-gateway']
    }
    if (gateway && !current.includes('llm-pi-gateway')) {
      const pending = current.replace(/\n*$/, '\n') + [
        '- id: llm-pi-gateway',
        '  name: "@mzzsfy/dsh-llm-pi-gateway"',
        '  config:',
        '    sessionMarker:',
        '      enabled: true',
        '      prefix: dsh',
        '',
      ].join('\n')
      writeFileSync(patchPath, pending, 'utf8')
      logFn(`[daemon] gateway row injected -> ${patchPath}`)
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
      '          - id: echo-model-thinkslow',
      '            name: Echo Thinkslow Model',
      '            input:',
      '              - text',
      '          - id: echo-model-tool',
      '            name: Echo Tool Model',
      '            input:',
      '              - text',
      '',
    ].join('\n')
    // 幂等补 think/tool 模型行(宿主重启重写 patch 丢扩展行;流式思考断言依赖
    // -think 后缀,工具链断言依赖 -tool 后缀)。重读防与上方 seed 写盘互抹
    const afterSeed = readFileSync(patchPath, 'utf8')
    if ((think || gateway) && !afterSeed.includes('echo-model-tool') && afterSeed.includes(MODEL_TAIL)) {
      writeFileSync(patchPath, afterSeed.replace(MODEL_TAIL, EXT_BLOCK), 'utf8')
      logFn('[daemon] gateway think/tool model rows injected')
    }
    if (think) seeded.push('think-expand')
  } catch (error) {
    logFn(`[daemon] gateway seed skip: ${error.message}`)
  }
  return seeded
}

function parseArgs(argv) {
  const args = { port: DEFAULT_PORT, refusePortOwner: true }
  let i = 0
  const valueOf = (flag) => {
    const value = argv[++i]
    if (value === undefined || value.startsWith('--')) throw new Error(`${flag} 缺参数值`)
    return value
  }
  for (i = 0; i < argv.length; i++) {
    const map = {
      '--version': () => { args.version = valueOf('--version') },
      '--port': () => { args.port = Number(valueOf('--port')) },
      '--llm-port': () => { args.llmPort = Number(valueOf('--llm-port')) },
      '--host-dir': () => { args.hostDir = valueOf('--host-dir') },
      '--work-root': () => { args.workRoot = valueOf('--work-root') },
      '--daemon': () => { args.daemon = true },
      '--refuse-port-owner': () => { args.refusePortOwner = true },
      // 只有显式 opt-in 才允许清理端口占用者;默认拒绝,防误杀生产 3080/人工实例
      '--allow-port-owner-kill': () => { args.refusePortOwner = false },
      // 会话夹具轮(#5/#6 类需要伪造会话跨重启存活)跳过净启动清理
      '--keep-sessions': () => { args.keepSessions = true },
      '--only': () => {
        const short = valueOf('--only')
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
  if (!Number.isInteger(args.port) || args.port < 9291 || args.port > 9310) {
    throw new Error(`--port 须在 9291-9310 隔离段(拒绝生产 3080/人工 9191): ${args.port}`)
  }
  return args
}

function sleep(ms) { return new Promise((done) => setTimeout(done, ms)) }
let activeChild = null

// echo-upstream 探活与就绪轮询的 STOP 语义在 boot-ready.mjs:两处都必须能即时
// 中止,否则 keep-stop 的 KEEPER_STOP_TIMEOUT_MS 会先到并强杀 keeper

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

let args
try {
  args = parseArgs(process.argv.slice(2))
} catch (error) {
  console.error(`[compat] 参数错误: ${error.message}`)
  process.exit(1)
}
const { version, port } = args
const workRoot = args.workRoot ? resolve(args.workRoot) : COMPAT_ROOT
const workDir = join(workRoot, version)
const hostDir = args.hostDir ? resolve(args.hostDir) : join(workDir, 'dsh-host')
const stopFlag = join(workDir, 'boot-keep.stop')
const binPath = join(hostDir, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
if (!existsSync(binPath)) throw new Error(`宿主闭包缺失,先跑 run.mjs --version ${version} 完成安装: ${binPath}`)

// keeper 互斥锁(V8):双 keeper 同工作目录会互杀宿主(killPortOwner 清场 + 各自
// respawn 循环 = 无限互踩)或同 home 静默共写(sessions/patch 竞态)。锁按 pid
// 存活判定自愈陈旧项,持有期写 pid,STOP 标记退出时释放
const keeperLockPath = join(workDir, 'boot-keep.lock')
function acquireKeeperLock() {
  // 全新 --version 工位目录不存在,写锁 ENOENT;lock 前自建(run.mjs 安装面同构)
  mkdirSync(workDir, { recursive: true })
  if (existsSync(keeperLockPath)) {
    let holder = null
    try { holder = JSON.parse(readFileSync(keeperLockPath, 'utf8')) } catch { /* 损坏锁按陈旧处理 */ }
    // process.kill(pid,0):存活返回 true;死亡抛 ESRCH;必须 try/catch 判定
    let alive = false
    try { alive = holder ? process.kill(holder.pid, 0) : false } catch { alive = false }
    if (alive) throw new Error(`工作目录已被另一 keeper 持有(pid ${holder.pid},锁 ${keeperLockPath});确认无误后删除锁文件可强制接管`)
    log(`[daemon] 清理陈旧 keeper 锁(持有者 pid ${holder?.pid} 已不存在)`)
  }
  // hostDir 入锁:keep-stop 强杀后据此识别"指进本工位宿主闭包"的根桥重指
  writeFileSync(keeperLockPath, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString(), hostDir }), 'utf8')
}
acquireKeeperLock()
// 净空放在 bin/桥校验与 keeper 锁之后:第二个 keeper 不能先清空运行中 keeper 的数据再失败退出
rmSync(join(workDir, 'data'), { recursive: true, force: true })

// 幂等 profile:bundles 形态与工作副本桥都齐时跳过重建(pnpm install 分钟级,逐包轮同闭包形态复用)
// enumeratePackages 返回的已是 @mzzsfy 全名,此处禁止再拼 scope
const { bundles: repoBundles } = enumeratePackages({ hostVersion: version })
const wantedShort = (args.only ?? []).map((n) => n.replace(/^@mzzsfy\//, ''))
const wantedBundles = wantedShort.length > 0
  ? repoBundles.filter((name) => wantedShort.includes(name.replace(/^@mzzsfy\//, '')))
  : repoBundles
const profileManifestPath = join(workDir, 'home', 'profiles', 'web', 'package.json')
const linkBase = join(workDir, 'home', 'profiles', 'web', 'node_modules', '@mzzsfy')
const expectShape = [...new Set(['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'dshmarket', ...wantedBundles])]
const reuseManifest = existsSync(profileManifestPath) ? JSON.parse(readFileSync(profileManifestPath, 'utf8')) : null
const reuseShapeOk = reuseManifest?.dsh?.profile?.bundles?.join('|') === expectShape.join('|')
const reuseLinksOk = (() => {
  // profile 复用必须验证全部 @mzzsfy 依赖行都有链接,而不只是本轮 wantedBundles:
  // 单包轮会遗留其他包的旧链接/旧声明,只查本轮会让半残 profile 被当成可复用。
  const declared = Object.keys(reuseManifest?.dependencies ?? {}).filter((name) => name.startsWith('@mzzsfy/'))
  return declared.length > 0 && declared.every((name) => existsSync(join(linkBase, name.replace('@mzzsfy/', ''))))
    && wantedBundles.every((name) => existsSync(join(linkBase, name.replace('@mzzsfy/', ''))))
})()
const profileReuseReady = existsSync(profileManifestPath) && reuseShapeOk && reuseLinksOk
let profile = null
// 在 try/finally 内调用:安装阶段收到 STOP 由 buildProfile 的 stop 口中止(抛 STOPPED),
// keeper 走正常收尾,不会等外部 15s 强杀后把锁与半装 profile 留场
async function ensureProfile() {
  if (profileReuseReady) {
    const reused = { homeDir: join(workDir, 'home'), binPath, bundleNames: wantedBundles }
    log(`[daemon] ${version} profile 复用 bundles=${reused.bundleNames.length}`)
    return reused
  }
  log(`[daemon] profile 复用未命中: manifest=${existsSync(profileManifestPath)} shape=${reuseShapeOk} links=${reuseLinksOk}(per-link=${wantedBundles.map((n) => `${n}:${existsSync(join(linkBase, n.replace('@mzzsfy/', '')))}`).join(',')}) 期望(${expectShape.length})=${expectShape.join('|')} 实际(${reuseManifest?.dsh?.profile?.bundles?.length})=${reuseManifest?.dsh?.profile?.bundles?.join('|')}`)
  const built = await buildProfile({
    version,
    workRoot,
    hostDir,
    only: args.only ?? [],
    stop: () => stopRequestedBy({ stopFlag, signalRequested: () => stopRequested }),
  })
  log(`[daemon] ${version} profile 构建 bundles=${built.bundleNames.length}`)
  return built
}

async function bootOnce() {
  // STOP 可能在上轮收尾后立刻到达:净删 live.json 之前先认,避免空转一轮再被杀
  if (stopRequestedBy({ stopFlag, signalRequested: () => stopRequested })) throw new KeeperStop()
  // 陈旧 live.json 会在就绪前误导读取方(死 token 401 / 旧 bundles),每轮 spawn 前净删
  rmSync(join(workDir, 'live.json'), { force: true })
  if (!(await canBind(port))) {
    if (args.refusePortOwner) throw new Error(`端口 ${port} 被占，拒绝清理其他进程`)
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
    llmPort: args.llmPort ?? 18123,
  })
  // 探活绑意图(--only 含 gateway)而非 seed 返回值:seed 的 catch 吞错返回 []
  // 时守卫若跟着 seed 走会静默旁路,恰是 NO_ADAPTER 最可能场景
  const stopDeps = { stopFlag, signalRequested: () => stopRequested }
  if (wantedShort.includes('dsh-llm-pi-gateway')) await awaitEchoReady(args.llmPort ?? 18123, stopDeps)
  const bootLogPath = join(workDir, 'boot-l3.log')
  const bootLog = createWriteStream(bootLogPath, { flags: 'w' })
  // 启动时间取 spawn 前:等就绪后写会晚于真实启动,keep-stop 的 pid 校验会误拒
  const childStartedAt = Date.now()
  const child = spawn(process.execPath, [binPath, 'web', '--no-open', '--port', String(port)], {
    cwd: profile.homeDir,
    env: compatEnv({
      DSH_HOME: profile.homeDir,
      // 逐包数据目录隔离:缺一会写到生产 ~/.dsh(测试不是只读操作,测试任务会被
      // 生产调度器拾取、账号 Key 明文落生产文件)。新增带数据目录的包时在此追加
      DSH_CRON_BOARD_DATA_DIR: join(workDir, 'data', 'cron-board'),
      DSH_USAGE_PANEL_DATA_DIR: join(workDir, 'data', 'usage-panel'),
      DSH_HISTORY_CACHE_DIR: join(workDir, 'data', 'context-manager-history'),
      // gateway LLM 链路凭据:apiKeyEnv 引用名 ECHO_KEY 走进程 env 通道(run.mjs 同款)
      ECHO_KEY: 'echo-compat',
    }),
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  })
  child.stdout.pipe(bootLog)
  child.stderr.pipe(bootLog)
  activeChild = child
  log(`[daemon] 宿主 spawn pid=${child.pid}`)
  const base = `http://127.0.0.1:${port}`
  let token = null
  try {
    // 就绪轮询消费 STOP/信号:迟到退出会被 keep-stop 强杀,跳过 finally 的根桥还原
    token = await awaitHostReady({
      child,
      base,
      bootLogPath,
      ...stopDeps,
      timeoutMs: BOOT_TIMEOUT_MS,
      pollMs: READY_POLL_MS,
    })
  } catch (error) {
    child.kill()
    throw error
  }
  writeFileSync(join(workDir, 'live.json'), JSON.stringify({
    port, token, pid: child.pid, keeperPid: process.pid, keeperStartedAt: KEEPER_STARTED_AT, hostStartedAt: childStartedAt, mode: 'daemon', bundles: profile.bundleNames, homeDir: profile.homeDir, hostDir, seeded,
  }, null, 2), 'utf8')
  log(`[daemon] 就绪:${base}/?token=${token} pid=${child.pid}`)
  return child
}

let restoreBridge = null
let child = null
let stopRequested = false
// keeper 自己收信号时必须走 finally:还原根桥、删两把锁;否则 CI 超时杀进程会污染根 node_modules
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => {
    stopRequested = true
    try { activeChild?.kill() } catch { /* 已退 */ }
    try { child?.kill() } catch { /* 已退 */ }
  })
}
try {
  // STOP 可能在 profile 构建/桥重指之间到达:重指前先认,避免刚拿到根桥锁就被强杀
  if (stopRequestedBy({ stopFlag, signalRequested: () => stopRequested })) throw new KeeperStop()
  profile = await ensureProfile()
  // 根桥生命周期归 keeper:run.mjs 收尾会还原根桥,复用工位前必须由本进程重指并持有锁,
  // 直到 STOP 再还原;否则插件 import 的宿主 API 会与实际运行的宿主代际错位。
  restoreBridge = repointBridgeFromHost(hostDir, { workRoot })
  child = await bootOnce()
  while (!stopRequested) {
    if (existsSync(stopFlag)) {
      log('[daemon] STOP 标记,退出(杀宿主)')
      try { child.kill() } catch { /* 已退 */ }
      await sleep(2000)
      try { child.kill('SIGKILL') } catch { /* 已退 */ }
      break
    }
    await sleep(WATCH_POLL_MS)
    if (child.exitCode === null) continue
    log(`[daemon] 宿主退出 code=${child.exitCode},重启`)
    child = await bootOnce()
  }
  if (stopRequested) log('[daemon] 收到终止信号,收尾')
} catch (error) {
  // STOP 是正常终止:finally 会还原根桥并清锁,不得按失败上报(keep-stop 等的是退出本身)
  if (error instanceof KeeperStop || error?.code === 'STOPPED') log(`[daemon] ${error.message},收尾`)
  else {
    console.error(`[compat] boot-keep 失败: ${error.message}`)
    process.exitCode = 1
  }
} finally {
  try { if (activeChild && activeChild.exitCode === null) activeChild.kill('SIGKILL') } catch { /* 已退 */ }
  try { if (child && child.exitCode === null) child.kill('SIGKILL') } catch { /* 已退 */ }
  restoreBridge?.()
  rmSync(keeperLockPath, { force: true })
  rmSync(stopFlag, { force: true })
}
