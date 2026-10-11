// keep 宿主收尾:杀 run.mjs --keep 留下的宿主进程树与 LLM 模拟器孤儿,清 live.json。
// 模拟器是 detached spawn 的孤儿(父已退出),按命令行特征匹配;宿主按 live.json pid 组杀。
// 用法:node scripts/compat/keep-stop.mjs [版本 ...](缺省 = .compat 下全部含 live.json 的版本)
import { spawnSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { COMPAT_ROOT, log } from './lib.mjs'
import { killSimulators, reportSimulatorCleanupFailure } from './simulator-cleanup.mjs'

function killTree(pid) {
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true })
    return
  }
  spawnSync('kill', ['-9', String(pid)], { windowsHide: true })
}

const versions = process.argv.slice(2)
const dirs = versions.length > 0
  ? versions
  : existsSync(COMPAT_ROOT)
    ? readdirSync(COMPAT_ROOT, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name)
    : []

let stopped = 0
for (const version of dirs) {
  const livePath = join(COMPAT_ROOT, version, 'live.json')
  if (!existsSync(livePath)) continue
  const live = JSON.parse(readFileSync(livePath, 'utf8'))
  if (live.pid) {
    killTree(live.pid)
    log(`keep-stop: ${version} 宿主 pid=${live.pid} 已组杀`)
    stopped++
  }
  rmSync(livePath, { force: true })
}
const simulatorCleanup = killSimulators()
reportSimulatorCleanupFailure(simulatorCleanup, log)
log(`keep-stop: 收尾 ${stopped} 个宿主,模拟器清理命令已执行`)
