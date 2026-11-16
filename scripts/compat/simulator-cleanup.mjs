// 模拟器清理:目标选择(纯函数,注入进程表/端口属主)与终止执行分离,便于单元测试。
// run.mjs --keep 落 live.json 的 simulatorPid 是首选精确目标;缺 pid 时按 simulatorPort 定位
// (模拟器以 --port 0 启动,命令行不含实际端口,故以监听属主为主、命令行端口为辅);
// 两者都缺才允许全机 sweep,且必须显式 opt-in。
import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'
import { COMPAT_ROOT, isProcessAlive } from './lib.mjs'

export const SIMULATOR_COMMAND_PATTERN = 'scripts[\\\\/]echo-upstream[\\\\/]cli\\.mjs'
export const isEchoSimulatorCommandLine = (commandLine) => new RegExp(SIMULATOR_COMMAND_PATTERN, 'i').test(commandLine ?? '')
export const isDshHostCommandLine = (commandLine, port) =>
  /dsh[\\/].*bin\.js/i.test(commandLine ?? '') &&
  new RegExp(`--port(?:=|\\s+)${Number(port)}(?!\\d)`).test(commandLine ?? '')

const isPositivePid = (value) => Number.isInteger(value) && value > 0
// 进程启动时间与 live.json 记录时刻的容差:spawn 返回与实际启动有毫秒级偏差,
// 机器时钟调整与 PowerShell 取整放大误差;BOOT_TIMEOUT_MS 为 150s,容差必须覆盖
// 启动等待全程,否则合法慢启动工位会被判成 pid 复用。
export const PROCESS_START_TOLERANCE_MS = 10 * 60 * 1000

// 单 pid 启动时间(epoch ms);进程不存在或无法读取返回 null。只查单个 pid,
// 不触碰全机进程表(keep-stop 的 pid 优先语义依赖此性质)
export function processStartTime(pid, { spawn = spawnSync, platform = process.platform } = {}) {
  if (!isPositivePid(Number(pid))) return null
  const result = platform === 'win32'
    ? runPowerShell(`$p = Get-Process -Id ${Number(pid)} -ErrorAction SilentlyContinue; if ($p) { $p.StartTime.ToUniversalTime().ToString('o') }`, spawn)
    : spawn('ps', ['-p', String(Number(pid)), '-o', 'lstart='], { encoding: 'utf8', windowsHide: true })
  if (result?.error || result?.status !== 0) return null
  const text = String(result.stdout ?? '').trim()
  if (!text) return null
  const parsed = Date.parse(text)
  return Number.isNaN(parsed) ? null : parsed
}

// 启动时间校验:live.json 记录时刻与真实进程启动时间在容差内才认同一进程。
// 缺记录视为不可校验,拒绝终止(旧 live.json 无身份字段,pid 可能已被复用)
function startTimeMatches(live, key, startTime) {
  // 进程已退出是"已达成",必须先于字段缺失判断:旧 live.json 无身份字段时也要能清理死工位
  if (startTime === null) return { ok: false, reason: null }
  const recorded = Number(live?.[key])
  if (!Number.isFinite(recorded)) return { ok: false, reason: `live.json 缺 ${key},拒绝按 pid 终止` }
  if (Math.abs(startTime - recorded) > PROCESS_START_TOLERANCE_MS) return { ok: false, reason: `pid 启动时间不匹配(${new Date(startTime).toISOString()} vs ${new Date(recorded).toISOString()}),拒绝终止` }
  return { ok: true, reason: null }
}

// 命令行 --port 形态锚定整数端口(4321 不命中 43210)
export const isSimulatorPortCommandLine = (commandLine, port) =>
  new RegExp(`--port(?:=|\\s+)${Number(port)}(?!\\d)`).test(commandLine ?? '')

function runPowerShell(script, spawn) {
  return spawn('powershell', ['-NoProfile', '-Command', script], { encoding: 'utf8', windowsHide: true })
}

// 全机 node 进程表(命令行用于身份校验)
export function listNodeProcesses({ spawn = spawnSync, platform = process.platform } = {}) {
  if (platform === 'win32') {
    const result = runPowerShell(
      "Get-CimInstance -ClassName Win32_Process -Filter \"Name='node.exe'\" | Select-Object ProcessId, CommandLine | ConvertTo-Json -Compress",
      spawn,
    )
    if (result?.error || result?.status !== 0) return []
    try {
      const parsed = JSON.parse(result.stdout || '[]')
      return (Array.isArray(parsed) ? parsed : [parsed])
        .map((item) => ({ pid: Number(item?.ProcessId), commandLine: item?.CommandLine ?? '' }))
        .filter((item) => isPositivePid(item.pid))
    } catch {
      return []
    }
  }
  const result = spawn('ps', ['-eo', 'pid=,args='], { encoding: 'utf8', windowsHide: true })
  if (result?.error || result?.status !== 0) return []
  return String(result.stdout ?? '')
    .split('\n')
    .map((line) => line.match(/^\s*(\d+)\s+(.*)$/))
    .filter(Boolean)
    .map((match) => ({ pid: Number(match[1]), commandLine: match[2] }))
}

// 端口监听属主(模拟器动态端口的唯一精确来源)
export function listPortOwners(port, { spawn = spawnSync, platform = process.platform } = {}) {
  if (!isPositivePid(Number(port))) return []
  const result = platform === 'win32'
    ? runPowerShell(`Get-NetTCPConnection -LocalPort ${Number(port)} -State Listen -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess -Unique`, spawn)
    : spawn('lsof', ['-ti', `tcp:${port}`, '-sTCP:LISTEN'], { encoding: 'utf8', windowsHide: true })
  if (result?.error || result?.status !== 0) return []
  return String(result.stdout ?? '')
    .split(/\r?\n/)
    .map((line) => Number(line.trim()))
    .filter(isPositivePid)
}

// 选择目标:pid 优先 → 端口 → (显式)全机 sweep;纯函数,所有输入由调用方注入
export function planSimulatorCleanup(live, { sweep = false, processes = [], portOwners = [], startTime = undefined, commandLine = undefined } = {}) {
  if (isPositivePid(Number(live?.simulatorPid))) {
    const pid = Number(live.simulatorPid)
    const verdict = startTimeMatches(live, 'simulatorStartedAt', startTime === undefined ? null : startTime)
    if (!verdict.ok) {
      return { mode: 'pid', targets: [], refused: verdict.reason !== null, warning: verdict.reason ?? `模拟器 pid=${pid} 已不在进程表(视为已退出)` }
    }
    // 启动时间命中仍需命令行确认:10 分钟容差内 pid 复用到别的 node 进程同样可能
    if (!isEchoSimulatorCommandLine(commandLine)) {
      return { mode: 'pid', targets: [], refused: true, warning: `模拟器 pid=${pid} 命令行不匹配(${commandLine ?? '不可读'}),拒绝终止` }
    }
    return { mode: 'pid', targets: [{ pid, via: 'simulatorPid' }], warning: null }
  }
  const port = Number(live?.simulatorPort)
  if (isPositivePid(port)) {
    const simulatorPids = processes
      .filter((process) => isEchoSimulatorCommandLine(process?.commandLine))
      .map((process) => process.pid)
    const byCommand = processes
      .filter((process) => isEchoSimulatorCommandLine(process?.commandLine) && isSimulatorPortCommandLine(process?.commandLine, port))
      .map((process) => process.pid)
    // 监听属主只在命令行确认是模拟器时采信,防端口被第三方复用后误杀
    const byListen = portOwners.filter((pid) => simulatorPids.includes(pid))
    const targets = [...new Set([...byCommand, ...byListen])]
      .filter(isPositivePid)
      .map((pid) => ({ pid, via: 'simulatorPort' }))
    return { mode: 'port', targets, warning: targets.length === 0 ? `simulatorPort ${port} 未匹配到模拟器进程(可能已退出)` : null }
  }
  if (sweep !== true) {
    return { mode: 'sweep-skipped', targets: [], warning: 'live.json 缺 simulatorPid/simulatorPort,全机 sweep 需显式 --sweep,本次跳过' }
  }
  const targets = [...new Set(processes.filter((process) => isEchoSimulatorCommandLine(process?.commandLine)).map((process) => process?.pid))]
    .filter((pid) => isPositivePid(pid) && pid !== process.pid)
    .map((pid) => ({ pid, via: 'sweep' }))
  return { mode: 'sweep', targets, warning: targets.length === 0 ? '全机 sweep 未发现模拟器进程' : null }
}

// 现场探测 + 决策:pid 命中时只查该 pid 的启动时间,并取该 pid 命令行做二次校验(不遍历监听属主)
export function collectSimulatorPlan(live, { sweep = false, listProcesses = listNodeProcesses, listOwners = listPortOwners, startTimeOf = processStartTime } = {}) {
  if (isPositivePid(Number(live?.simulatorPid))) {
    const pid = Number(live.simulatorPid)
    const process = listProcesses().find((item) => item.pid === pid)
    return planSimulatorCleanup(live, { sweep, startTime: startTimeOf(pid), commandLine: process?.commandLine })
  }
  const port = Number(live?.simulatorPort)
  return planSimulatorCleanup(live, {
    sweep,
    processes: listProcesses(),
    portOwners: isPositivePid(port) ? listOwners(port) : [],
  })
}

// 宿主目标选择:live.json 的 pid 必须是 dsh 宿主且启动时间匹配;进程已退出视为已达成
export function planHostCleanup(live, { startTime = null, commandLine = null } = {}) {
  const pid = Number(live?.pid)
  if (!isPositivePid(pid)) return { targets: [], refused: false, warning: 'live.json 缺宿主 pid,跳过' }
  const verdict = startTimeMatches(live, 'hostStartedAt', startTime)
  if (!verdict.ok) {
    return { targets: [], refused: verdict.reason !== null, warning: verdict.reason ?? `宿主 pid=${pid} 已不在进程表(视为已退出)` }
  }
  // 启动时间只能排除大部分复用;命令行必须同时锚定 dsh bin 与 --port,未知命令一律拒绝
  if (!isDshHostCommandLine(commandLine, live?.port)) {
    return { targets: [], refused: true, warning: `宿主 pid=${pid} 命令行不匹配(${commandLine ?? '不可读'}),拒绝终止` }
  }
  return { targets: [{ pid, via: 'host' }], refused: false, warning: null }
}

export function collectHostPlan(live, { startTimeOf = processStartTime, listProcesses = listNodeProcesses } = {}) {
  const pid = Number(live?.pid)
  const process = isPositivePid(pid) ? listProcesses().find((item) => item.pid === pid) : undefined
  return planHostCleanup(live, { startTime: startTimeOf(pid), commandLine: process?.commandLine })
}

export const isKeeperCommandLine = (commandLine) => /boot-keep\.mjs/i.test(commandLine ?? '')

// keeper 也是被 kill 的目标:pid 可能复用,必须校验启动时间与命令行,不能信任 live.json 单字段
export function planKeeperCleanup(live, { startTime = null, commandLine = null, workRoot = COMPAT_ROOT, version = null } = {}) {
  const pid = Number(live?.keeperPid)
  if (!isPositivePid(pid)) return { targets: [], refused: false, warning: null }
  if (startTime === null) return { targets: [], refused: false, warning: `keeper pid=${pid} 已不在进程表(视为已退出)` }
  const recorded = Number(live?.keeperStartedAt)
  if (!Number.isFinite(recorded) || Math.abs(startTime - recorded) > PROCESS_START_TOLERANCE_MS) {
    return { targets: [], refused: true, warning: `keeper pid=${pid} 启动时间不匹配或缺失,拒绝终止` }
  }
  if (!isKeeperCommandLine(commandLine)) {
    return { targets: [], refused: true, warning: `keeper pid=${pid} 命令行不匹配(${commandLine ?? '不可读'}),拒绝终止` }
  }
  if (version !== null && !new RegExp(`--version(?:=|\\s+)${version.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?!\\S)`).test(commandLine)) {
    return { targets: [], refused: true, warning: `keeper pid=${pid} 版本不匹配(期望 ${version}),拒绝终止` }
  }
  const workRootMatch = commandLine.match(/--work-root(?:=|\s+)(?:"([^"]+)"|'([^']+)'|(\S+))/)
  const declaredWorkRoot = workRootMatch ? (workRootMatch[1] ?? workRootMatch[2] ?? workRootMatch[3]) : COMPAT_ROOT
  if (resolve(declaredWorkRoot) !== resolve(workRoot)) {
    return { targets: [], refused: true, warning: `keeper pid=${pid} 工位不匹配(${declaredWorkRoot}),拒绝终止` }
  }
  return { targets: [{ pid, via: 'keeper' }], refused: false, warning: null }
}

export function collectKeeperPlan(live, { startTimeOf = processStartTime, listProcesses = listNodeProcesses, workRoot = COMPAT_ROOT, version = null } = {}) {
  const pid = Number(live?.keeperPid)
  const process = isPositivePid(pid) ? listProcesses().find((item) => item.pid === pid) : undefined
  return planKeeperCleanup(live, { startTime: startTimeOf(pid), commandLine: process?.commandLine, workRoot, version })
}

function killProcess(pid, { platform, spawn }) {
  try {
    const result = platform === 'win32'
      ? spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { encoding: 'utf8', windowsHide: true })
      : spawn('kill', ['-9', String(pid)], { encoding: 'utf8', windowsHide: true })
    if (result?.error) return result.error.message
    if (result?.status !== 0) return String(result?.stderr ?? '').trim() || `exit ${result?.status}`
    return null
  } catch (error) {
    return error.message
  }
}

const EXIT_POLL_ATTEMPTS = 10
const EXIT_POLL_MS = 100

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

// 终止命令返回后进程未必立刻从进程表消失:有界轮询确认,防把已成功的收尾误判为失败
function confirmGone(pid, isAlive, { attempts = EXIT_POLL_ATTEMPTS, intervalMs = EXIT_POLL_MS } = {}) {
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (!isAlive(pid)) return true
    sleepSync(intervalMs)
  }
  return !isAlive(pid)
}

// 执行终止:以进程实际消失为成功判据(taskkill 对已自行退出的进程返回非零,目标已达成)
export function terminateTargets(targets, { platform = process.platform, spawn = spawnSync, isAlive = isProcessAlive, exitPoll } = {}) {
  const killed = []
  const failures = []
  for (const { pid, via } of targets) {
    if (!isPositivePid(Number(pid))) {
      failures.push({ pid, via, detail: '非法 pid' })
      continue
    }
    const detail = killProcess(Number(pid), { platform, spawn })
    if (confirmGone(Number(pid), isAlive, exitPoll)) killed.push({ pid: Number(pid), via })
    else failures.push({ pid: Number(pid), via, detail: detail ?? '进程仍存活' })
  }
  return { ok: failures.length === 0, killed, failures }
}
