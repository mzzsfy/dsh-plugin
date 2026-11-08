// keep 宿主收尾:杀 run.mjs --keep 留下的宿主进程树与 LLM 模拟器,清 live.json。
// 模拟器优先按 live.json simulatorPid 精确终止;缺 pid 才按 simulatorPort 解析;
// 全机 sweep 默认只警告,须显式 --sweep 才执行(并行工位不连坐)。
// 清理未达成(任一目标仍存活)置退出码 1 并保留 live.json 便于重试;全部达成才删。
// 用法:node scripts/compat/keep-stop.mjs [--sweep] [版本 ...](缺省 = .compat 下全部含 live.json 的版本)
import { existsSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { COMPAT_ROOT, log } from './lib.mjs'
import { collectSimulatorPlan, terminateTargets } from './simulator-cleanup.mjs'

export function parseKeepStopArgs(argv) {
  const parsed = { versions: [], sweep: false }
  for (const arg of argv) {
    if (arg === '--sweep') parsed.sweep = true
    else if (arg.startsWith('--')) throw new Error(`未知参数: ${arg}`)
    else parsed.versions.push(arg)
  }
  return parsed
}

// 单工位收尾判定:宿主与模拟器目标全部确认终止才算成功
export function judgeVersionCleanup({ host, simulator }) {
  const failures = [...(host?.failures ?? []), ...(simulator?.failures ?? [])]
  return { ok: failures.length === 0, failures }
}

function stopVersion(version, { sweep }) {
  const livePath = join(COMPAT_ROOT, version, 'live.json')
  if (!existsSync(livePath)) return false
  let live = null
  try {
    live = JSON.parse(readFileSync(livePath, 'utf8'))
  } catch {
    log(`keep-stop: ${version} live.json 不可解析,保留待人工处置`)
    process.exitCode = 1
    return true
  }
  const hostPid = Number(live.pid)
  const host = terminateTargets(Number.isInteger(hostPid) && hostPid > 0 ? [{ pid: hostPid, via: 'host' }] : [])
  if (host.killed.length > 0) log(`keep-stop: ${version} 宿主 pid=${hostPid} 已组杀`)
  const plan = collectSimulatorPlan(live, { sweep })
  if (plan.warning) log(`keep-stop: ${version} ${plan.warning}`)
  const simulator = terminateTargets(plan.targets)
  for (const { pid, via } of simulator.killed) log(`keep-stop: ${version} 模拟器 pid=${pid} 已终止(${via})`)
  const verdict = judgeVersionCleanup({ host, simulator })
  if (!verdict.ok) {
    process.exitCode = 1
    log(`keep-stop: ${version} 清理未达成:${verdict.failures.map((failure) => `${failure.via} pid=${failure.pid} ${failure.detail}`).join('; ')};保留 ${livePath} 供重试`)
    return true
  }
  rmSync(livePath, { force: true })
  return true
}

function main() {
  const args = parseKeepStopArgs(process.argv.slice(2))
  const versions = args.versions.length > 0
    ? args.versions
    : existsSync(COMPAT_ROOT)
      ? readdirSync(COMPAT_ROOT, { withFileTypes: true }).filter((dir) => dir.isDirectory()).map((dir) => dir.name)
      : []
  let handled = 0
  for (const version of versions) if (stopVersion(version, args)) handled++
  log(`keep-stop: 处理 ${handled} 个工位,退出码 ${process.exitCode ?? 0}`)
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
