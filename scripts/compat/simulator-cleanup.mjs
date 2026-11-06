// 模拟器清理:目标选择(纯函数,注入进程表/端口属主)与终止执行分离,便于单元测试。
// run.mjs --keep 落 live.json 的 simulatorPid 是首选精确目标;缺 pid 时按 simulatorPort 定位
// (模拟器以 --port 0 启动,命令行不含实际端口,故以监听属主为主、命令行端口为辅);
// 两者都缺才允许全机 sweep,且必须显式 opt-in。
import { spawnSync } from 'node:child_process'
import { isProcessAlive } from './lib.mjs'

export const SIMULATOR_COMMAND_PATTERN = 'scripts[\\\\/]echo-upstream[\\\\/]cli\\.mjs'
export const isEchoSimulatorCommandLine = (commandLine) => new RegExp(SIMULATOR_COMMAND_PATTERN, 'i').test(commandLine ?? '')

const isPositivePid = (value) => Number.isInteger(value) && value > 0

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
export function planSimulatorCleanup(live, { sweep = false, processes = [], portOwners = [] } = {}) {
  if (isPositivePid(Number(live?.simulatorPid))) {
    return { mode: 'pid', targets: [{ pid: Number(live.simulatorPid), via: 'simulatorPid' }], warning: null }
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

// 现场探测 + 决策:pid 命中时不触碰全机进程表
export function collectSimulatorPlan(live, { sweep = false, listProcesses = listNodeProcesses, listOwners = listPortOwners } = {}) {
  if (isPositivePid(Number(live?.simulatorPid))) return planSimulatorCleanup(live, { sweep })
  const port = Number(live?.simulatorPort)
  return planSimulatorCleanup(live, {
    sweep,
    processes: listProcesses(),
    portOwners: isPositivePid(port) ? listOwners(port) : [],
  })
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
