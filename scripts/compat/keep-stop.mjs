// keep 宿主收尾:杀 run.mjs --keep / boot-keep 留下的宿主进程树、keeper 与 LLM 模拟器,
// 清 live.json、STOP 标记与根桥重指。
// 缺 live.json 不代表工位已结束:boot-keep 每轮 spawn 前净删 live.json,重启窗口里
// 工位仍然在跑(keeper 锁是唯一凭证)。此时必须写 STOP 让它自行收尾(它的 finally 会
// 杀宿主、还原根桥、清锁),等不到再强杀;强杀会跳过 finally,必须在此补做根桥/锁收尾
// 并复核,桥未还原不得报成功。
// 模拟器优先按 live.json simulatorPid 精确终止;缺 pid 才按 simulatorPort 解析;
// 全机 sweep 默认只警告,须显式 --sweep 才执行(并行工位不连坐)。
// 清理未达成(任一目标仍存活、根桥仍重指)置退出码 1 并保留 live.json 便于重试;全部达成才删。
// 用法:node scripts/compat/keep-stop.mjs [--sweep] [--work-root DIR] [版本 ...]
//   (缺省 = work-root 下全部版本目录)
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { COMPAT_ROOT, REPO_ROOT, isProcessAlive, log } from './lib.mjs'
import { collectHostPlan, collectKeeperPlan, collectSimulatorPlan, terminateTargets } from './simulator-cleanup.mjs'
import { bridgeRepointState, clearStaleBridgeLock, recoverRootBridge } from './bridge-mutex.mjs'

export function parseKeepStopArgs(argv) {
  const parsed = { versions: [], sweep: false, workRoot: COMPAT_ROOT }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--sweep') parsed.sweep = true
    else if (arg === '--work-root') {
      const value = argv[++i]
      if (!value) throw new Error('--work-root 缺目录')
      parsed.workRoot = resolve(value)
    } else if (arg.startsWith('--')) throw new Error(`未知参数: ${arg}`)
    else parsed.versions.push(arg)
  }
  return parsed
}

// 单工位收尾判定:宿主与模拟器目标全部确认终止才算成功
export function judgeVersionCleanup({ host, simulator }) {
  const failures = [...(host?.failures ?? []), ...(simulator?.failures ?? [])]
  return { ok: failures.length === 0, failures }
}

// keeper 收尾最坏路径:5s STOP 轮询 + 2s 宿主宽限 + SIGKILL/落盘余量,固定 5s 会硬杀在 finally 前
const KEEPER_STOP_TIMEOUT_MS = 15_000

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

// keeper 锁:boot-keep 启动即写 {pid, startedAt},退出时删。缺 live.json 时它既是
// "工位仍在"的凭证,也是身份校验(启动时间/命令行/工位/版本)的 pid 来源
function readKeeperLock(path) {
  if (!existsSync(path)) return null
  try {
    const lock = JSON.parse(readFileSync(path, 'utf8'))
    return lock !== null && typeof lock === 'object' ? lock : {}
  } catch {
    // 损坏锁无法证明持有者已死:按"未收尾"保留,不猜
    return {}
  }
}

const keeperHint = (live, keeperLock) => live ?? {
  keeperPid: keeperLock?.pid,
  keeperStartedAt: Date.parse(String(keeperLock?.startedAt ?? '')),
}

// live.json 与 keeper 锁都没有时,工位只剩强杀可能留下的根桥重指/陈旧锁。
// hostDirs 来自 live/keeper 锁记录(--host-dir 可落在 workRoot 之外);
// 两者都没有时按 compat 宿主闭包兜底认领孤儿重指(此时已证明无存活 keeper)。
function settleBridgeOnly({ version, workRoot, repoRoot, hostDirs, recoverBridge, bridgeState, clearStaleLock }) {
  const owned = bridgeState({ repoRoot, workRoot, hostDirs, includeLayout: false })
  const state = owned.repointed.length > 0 ? owned : bridgeState({ repoRoot, workRoot, hostDirs, includeLayout: true })
  if (state.repointed.length === 0) {
    const cleared = clearStaleLock({ repoRoot, workRoot, log })
    if (cleared) log(`keep-stop: ${version} 无 live.json/keeper 锁,已清理陈旧根桥锁`)
    return cleared
  }
  const bridge = recoverBridge({ repoRoot, workRoot, hostDirs, log })
  if (!bridge.ok) {
    process.exitCode = 1
    log(`keep-stop: ${version} 无 live.json/keeper 锁,但根桥仍重指(${bridge.pending.join(',') || bridge.detail});保留工位供重试`)
    return true
  }
  // 锁被别的存活工位持有 → 未动手也不算本工位收尾
  if (bridge.healed.length + bridge.removed.length === 0) return false
  log(`keep-stop: ${version} 无 live.json/keeper 锁,已补做根桥还原(${[...bridge.healed.map((item) => item.name), ...bridge.removed.map((item) => item.name)].join(',')})`)
  return true
}

// deps 仅测试注入:默认全部走真实探测/终止实现,不改变生产调用面
export function stopVersion(version, { sweep, workRoot, repoRoot = REPO_ROOT, deps = {} }) {
  const {
    collectKeeper = collectKeeperPlan,
    collectHost = collectHostPlan,
    collectSimulator = collectSimulatorPlan,
    terminate = terminateTargets,
    isAlive = isProcessAlive,
    sleep = sleepSync,
    now = Date.now,
    recoverBridge = recoverRootBridge,
    clearStaleLock = clearStaleBridgeLock,
    bridgeState = bridgeRepointState,
    readLock = readKeeperLock,
  } = deps
  const versionDir = join(workRoot, version)
  if (!existsSync(versionDir)) return false
  const livePath = join(versionDir, 'live.json')
  const stopFlag = join(versionDir, 'boot-keep.stop')
  const lockPath = join(versionDir, 'boot-keep.lock')
  const keeperLock = readLock(lockPath)
  let live = null
  if (existsSync(livePath)) {
    try {
      live = JSON.parse(readFileSync(livePath, 'utf8'))
    } catch {
      log(`keep-stop: ${version} live.json 不可解析,保留待人工处置`)
      process.exitCode = 1
      return true
    }
  }
  // hostDir 是重指归属的第二凭证(--host-dir 可在 workRoot 之外):live 与 keeper 锁都记
  const hostDirs = [live?.hostDir, keeperLock?.hostDir].filter((dir) => typeof dir === 'string' && dir !== '')
  if (live === null && keeperLock === null) {
    return settleBridgeOnly({ version, workRoot, repoRoot, hostDirs, recoverBridge, bridgeState, clearStaleLock })
  }
  if (live === null && !(Number.isInteger(Number(keeperLock?.pid)) && Number(keeperLock.pid) > 0)) {
    log(`keep-stop: ${version} live.json 缺失且 keeper 锁不可解析(${lockPath}),无法证明 keeper 已退出;确认无 keeper 后删锁重试`)
    process.exitCode = 1
    return true
  }
  // boot-keep daemon 的生命周期:先写 STOP 让其自行收尾(它会杀宿主并还原根桥),
  // 等不到再组杀 keeper;否则只杀宿主会被 daemon 在 5s 内重新拉起。
  const keeperPlan = collectKeeper(keeperHint(live, keeperLock), { workRoot, version })
  if (keeperPlan.warning) log(`keep-stop: ${version} ${keeperPlan.warning}`)
  if (keeperPlan.refused === true) {
    process.exitCode = 1
    log(`keep-stop: ${version} keeper pid 身份校验未通过,拒绝终止;保留 ${livePath} 供人工核验`)
    return true
  }
  let keeperBlocked = false
  if (keeperPlan.targets.length > 0) {
    const keeperPid = keeperPlan.targets[0].pid
    // 已退出就别写 STOP:标记留下会让同一工作目录的下一个 keeper 启动即退出
    if (isAlive(keeperPid)) {
      writeFileSync(stopFlag, 'stop', 'utf8')
      const deadline = now() + KEEPER_STOP_TIMEOUT_MS
      while (now() < deadline && isAlive(keeperPid)) sleep(200)
      if (isAlive(keeperPid)) {
        const keeper = terminate(keeperPlan.targets)
        // 强杀 keeper 时它的 finally 未执行:finally 里的根桥还原/锁清理随即补做,
        // 但那次收尾不是 keeper 自己完成的可信路径,不按成功删 live.json
        keeperBlocked = true
        process.exitCode = 1
        log(`keep-stop: ${version} keeper pid=${keeperPid} STOP 超时${keeper.killed.length > 0 ? '已被强杀' : '强杀失败'};补做根桥/锁收尾`)
      }
    } else {
      log(`keep-stop: ${version} keeper pid=${keeperPid} 已退出,无需 STOP`)
    }
  }
  // live.json 缺失时没有宿主/模拟器凭证:keeper 被强杀时其子进程随 taskkill /T 一并终止
  let host = null
  let simulator = null
  if (live !== null) {
    // 身份校验:pid 可能已被复用,启动时间不匹配即拒绝终止并保留 live.json
    const hostPlan = collectHost(live)
    if (hostPlan.warning) log(`keep-stop: ${version} ${hostPlan.warning}`)
    host = terminate(hostPlan.targets)
    if (host.killed.length > 0) log(`keep-stop: ${version} 宿主 pid=${Number(live.pid)} 已组杀`)
    const plan = collectSimulator(live, { sweep })
    if (plan.warning) log(`keep-stop: ${version} ${plan.warning}`)
    simulator = terminate(plan.targets)
    for (const { pid, via } of simulator.killed) log(`keep-stop: ${version} 模拟器 pid=${pid} 已终止(${via})`)
    if (hostPlan.refused === true || plan.refused === true) {
      process.exitCode = 1
      log(`keep-stop: ${version} pid 身份校验未通过,拒绝终止;保留 ${livePath} 供人工核验`)
      return true
    }
  }
  const verdict = judgeVersionCleanup({ host, simulator })
  // 根桥/锁复核:keeper 自行退出会还原根桥,强杀则不会;桥仍重指时收尾未达成
  const bridge = recoverBridge({ repoRoot, workRoot, hostDirs, log })
  if (!verdict.ok || keeperBlocked || !bridge.ok) {
    process.exitCode = 1
    const reasons = verdict.failures.map((failure) => `${failure.via} pid=${failure.pid} ${failure.detail}`)
    if (keeperBlocked) reasons.push('keeper 被强杀,根桥还原由兜底路径补做')
    if (!bridge.ok) reasons.push(`根桥仍重指(${bridge.pending.join(',') || bridge.detail})`)
    log(`keep-stop: ${version} 清理未达成:${reasons.join('; ')};保留 ${livePath} 供重试`)
    return true
  }
  rmSync(livePath, { force: true })
  rmSync(stopFlag, { force: true })
  rmSync(lockPath, { force: true })
  return true
}

export function stopAll({ versions, sweep, workRoot, repoRoot = REPO_ROOT, deps = {} }) {
  const handled = versions.filter((version) => stopVersion(version, { sweep, workRoot, repoRoot, deps }))
  // 一个工位都没收尾时仍要复核根桥:强杀后带错版本号/换了 work-root 重跑不得静默报成功
  if (handled.length === 0) {
    const bridge = (deps.recoverBridge ?? recoverRootBridge)({ repoRoot, workRoot, hostDirs: deps.hostDirs ?? [], log })
    if (!bridge.ok) {
      process.exitCode = 1
      log(`keep-stop: 无工位可收尾,但根桥仍重指(${bridge.pending.join(',') || bridge.detail});确认工位目录后重试`)
    }
  }
  return { handled }
}

function main() {
  const args = parseKeepStopArgs(process.argv.slice(2))
  const versions = args.versions.length > 0
    ? args.versions
    : existsSync(args.workRoot)
      ? readdirSync(args.workRoot, { withFileTypes: true }).filter((dir) => dir.isDirectory()).map((dir) => dir.name)
      : []
  const { handled } = stopAll({ versions, sweep: args.sweep, workRoot: args.workRoot })
  log(`keep-stop: 处理 ${handled.length} 个工位,退出码 ${process.exitCode ?? 0}`)
}

// 直接执行才收尾:被测试 import 时不产生任何副作用
const invokedDirectly = process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (invokedDirectly) {
  try {
    main()
  } catch (error) {
    console.error(`[compat] keep-stop 失败: ${error.message}`)
    process.exitCode = 1
  }
}
