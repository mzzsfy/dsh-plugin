// compat 工位磁盘回收:每个工位默认自带一份宿主闭包,仅进程收尾时删不掉磁盘,长期线性增长。
// 默认只删可重建的宿主安装(dsh-host / host-* / nm-backup),home、日志与截图等测试证据保留;
// --all 才删整个工位。存活工位(live.json / boot-keep.lock 的 pid)一律跳过,锁不可解析也不猜。
// 用法:node scripts/compat/prune.mjs [--work-root DIR] [--all] [--dry-run] [--keep 名字,...]
import { existsSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { COMPAT_ROOT, isProcessAlive, log } from './lib.mjs'

// 工位识别标记:任一存在即判定该目录是 compat 工位
const WORKSTATION_MARKERS = ['home', 'dsh-host', 'live.json', 'boot-keep.lock']
// 可重建的宿主安装:删除后 run.mjs / boot-keep 首次启动按需重装
const REBUILDABLE_DIR_NAMES = ['dsh-host', 'nm-backup']
const REBUILDABLE_DIR_PREFIXES = ['host-']
// 工位只可能出现在 workRoot 下两层:workRoot/<版本> 与 workRoot/<工位>/<版本>
const MAX_SCAN_DEPTH = 2
// 活跃判定只看这些 pid 字段
const LIVE_PID_KEYS = ['pid', 'keeperPid', 'simulatorPid']

export function parsePruneArgs(argv) {
  const args = { workRoot: COMPAT_ROOT, all: false, dryRun: false, keep: [] }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--all') args.all = true
    else if (arg === '--dry-run') args.dryRun = true
    else if (arg === '--work-root') {
      const value = argv[++i]
      if (!value) throw new Error('--work-root 缺目录')
      args.workRoot = resolve(value)
    } else if (arg === '--keep') {
      const value = argv[++i]
      if (!value) throw new Error('--keep 缺名字')
      args.keep.push(...value.split(',').map((name) => name.trim()).filter(Boolean))
    } else throw new Error(`未知参数: ${arg}`)
  }
  return args
}

export function isWorkstationDir(dir) {
  return WORKSTATION_MARKERS.some((name) => existsSync(join(dir, name)))
}

export function collectWorkstations(workRoot, depth = 1) {
  if (depth > MAX_SCAN_DEPTH || !existsSync(workRoot)) return []
  const found = []
  for (const entry of readdirSync(workRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const dir = join(workRoot, entry.name)
    if (isWorkstationDir(dir)) found.push(dir)
    else found.push(...collectWorkstations(dir, depth + 1))
  }
  return found
}

function readJsonObject(path) {
  try {
    const value = JSON.parse(readFileSync(path, 'utf8'))
    return value !== null && typeof value === 'object' ? value : {}
  } catch {
    // 损坏的凭证无法证明持有者已退出:返回 null 由调用方按"未知"保守处理
    return null
  }
}

// 返回工位占用原因;null 表示可回收
export function workstationBusyReason(dir, isAlive = isProcessAlive) {
  const livePath = join(dir, 'live.json')
  if (existsSync(livePath)) {
    const live = readJsonObject(livePath)
    if (live === null) return 'live.json 不可解析'
    for (const key of LIVE_PID_KEYS) {
      const pid = Number(live[key])
      if (Number.isInteger(pid) && pid > 0 && isAlive(pid)) return `${key}=${pid} 存活`
    }
  }
  const lockPath = join(dir, 'boot-keep.lock')
  if (existsSync(lockPath)) {
    const lock = readJsonObject(lockPath)
    if (lock === null) return 'boot-keep.lock 不可解析'
    const pid = Number(lock.pid)
    if (Number.isInteger(pid) && pid > 0 && isAlive(pid)) return `keeper pid=${pid} 存活`
  }
  return null
}

export function dirSizeBytes(dir) {
  let total = 0
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) total += dirSizeBytes(path)
    else if (entry.isFile()) {
      try {
        total += statSync(path).size
      } catch {
        // 并发删除/权限变化不计入,不影响回收决策
      }
    }
  }
  return total
}

function rebuildableChildren(dir) {
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .filter((entry) => REBUILDABLE_DIR_NAMES.includes(entry.name)
      || REBUILDABLE_DIR_PREFIXES.some((prefix) => entry.name.startsWith(prefix)))
    .map((entry) => join(dir, entry.name))
}

export function planPrune({ workRoot = COMPAT_ROOT, all = false, keep = [], isAlive = isProcessAlive } = {}) {
  const root = resolve(workRoot)
  const keepSet = new Set(keep)
  const rows = []
  for (const dir of collectWorkstations(root)) {
    const relative = dir.slice(root.length + 1)
    if (keepSet.has(basename(dir)) || keepSet.has(relative)) {
      rows.push({ dir, targets: [], bytes: 0, skipped: 'keep' })
      continue
    }
    const busy = workstationBusyReason(dir, isAlive)
    if (busy !== null) {
      rows.push({ dir, targets: [], bytes: 0, skipped: busy })
      continue
    }
    const targets = all ? [dir] : rebuildableChildren(dir)
    if (targets.length === 0) continue
    rows.push({ dir, targets, bytes: targets.reduce((sum, target) => sum + dirSizeBytes(target), 0), skipped: null })
  }
  return { workRoot: root, rows, totalBytes: rows.reduce((sum, row) => sum + row.bytes, 0) }
}

export function applyPrune(plan, remove = (path) => rmSync(path, { recursive: true, force: true })) {
  for (const row of plan.rows) {
    for (const target of row.targets) remove(target)
  }
}

export function formatBytes(bytes) {
  const units = ['B', 'KB', 'MB', 'GB']
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit++
  }
  return `${value.toFixed(unit === 0 ? 0 : 1)}${units[unit]}`
}

function main() {
  const args = parsePruneArgs(process.argv.slice(2))
  const plan = planPrune(args)
  const verb = args.dryRun ? '将回收' : '回收'
  for (const row of plan.rows) {
    if (row.skipped !== null) {
      log(`prune: 跳过 ${row.dir}(${row.skipped})`)
      continue
    }
    log(`prune: ${verb} ${row.dir} ${formatBytes(row.bytes)}`)
  }
  if (!args.dryRun) applyPrune(plan)
  log(`prune: ${args.dryRun ? '合计可回收' : '合计回收'} ${formatBytes(plan.totalBytes)},工位 ${plan.rows.length} 个`)
}

// 直接执行才动手:被测试 import 时不产生任何副作用
const invokedDirectly = process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (invokedDirectly) {
  try {
    main()
  } catch (error) {
    console.error(`[compat] prune 失败: ${error.message}`)
    process.exitCode = 1
  }
}
