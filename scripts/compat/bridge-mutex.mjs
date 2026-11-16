// 根桥重指的工位互斥与备份:锁判定/陈旧锁接管/备份命名/heal 决策为纯函数,IO 只做落地。
// 多工位(文档支持 --work-root 错开)交错重指同一根桥会互删根桥,故重指前先抢独占锁;
// 备份带 pid 后缀,restore 只还原本工位创建的备份。
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve, sep } from 'node:path'
import { isProcessAlive } from './lib.mjs'

export const BRIDGE_LOCK_FILE = '.compat-bridge.lock'
export const BRIDGE_BACKUP_MARK = '.compat-bak'
// 根桥内与宿主版本耦合的解析面:运行期重指宿主闭包同版本,对齐生产
// healProfileModuleFallback 形态(插件 import 与宿主同源),结束后还原
export const BRIDGE_PACKAGES = [
  '@deepseek-ai/dsh-storage-domain',
  '@deepseek-ai/dsh-tools',
  '@deepseek-ai/dsh-scope',
  '@deepseek-ai/schemastery',
  '@deepseek-ai/dsh-shell',
  '@deepseek-ai/dsh-timeout',
  'zod',
]
// 只有这两类形态才可能是重指暂存的原桥;其余(普通文件/损坏链接)一律不采信
const HEALABLE_SHAPES = ['symlink', 'dir']

export const bridgeLockPath = (repoRoot) => join(repoRoot, 'node_modules', BRIDGE_LOCK_FILE)
export const bridgeBackupPath = (dst, pid) => `${dst}${BRIDGE_BACKUP_MARK}-${pid}`

export function bridgeArtifactShape(path) {
  // lstat 而非 existsSync:后者跟随链接,悬空重指(工位已被清理)会误报 absent
  let stats
  try { stats = lstatSync(path) } catch { return 'absent' }
  if (stats.isSymbolicLink()) return 'symlink'
  return stats.isDirectory() ? 'dir' : 'other'
}

export function describeBridgeLock(lock) {
  if (!lock) return '(内容不可解析)'
  return `pid=${lock.pid} startedAt=${lock.startedAt ?? '(无)'} workRoot=${lock.workRoot ?? '(无)'}`
}

// 锁判定:free 无锁 / busy 持有者存活 / stale 持有者已死或内容损坏(可接管)
export function classifyBridgeLock(raw, { isAlive = isProcessAlive } = {}) {
  if (raw === null || raw === undefined) return { status: 'free' }
  // 空文件是"存在但不可解析"的锁,不能判 free:createExclusive 的 wx 无法覆盖已存在文件,
  // 否则每次重试都撞 EEXIST,空锁永久占位。
  if (raw === '') return { status: 'stale', lock: null, reason: '空锁文件' }
  let lock = null
  try {
    lock = JSON.parse(raw)
  } catch {
    lock = null
  }
  const pid = Number(lock?.pid)
  if (!Number.isInteger(pid) || pid <= 0) return { status: 'stale', lock: null, reason: '锁内容不可解析' }
  if (isAlive(pid)) return { status: 'busy', lock }
  return { status: 'stale', lock, reason: `持有者 pid ${pid} 不存活` }
}

// 争抢同一把锁的并发上限:陈旧锁接管与别家抢占交错时重试,超限按占用处理
const ACQUIRE_ATTEMPTS = 3

// 独占创建:wx 保证"读到无锁"与"写锁"之间不会被别家插队
function createExclusive(path, content) {
  try {
    writeFileSync(path, content, { flag: 'wx' })
    return true
  } catch (error) {
    if (error.code === 'EEXIST') return false
    throw error
  }
}

// hostDir 显式入锁:重指目标由 hostDir 决定(--host-dir 可落在 workRoot 之外),
// 只按 workRoot 前缀判定会在"复用别的工位宿主闭包"时看不到自己的重指
export function acquireBridgeLock({ repoRoot, workRoot, hostDir, pid = process.pid, isAlive = isProcessAlive, log = () => {} }) {
  const path = bridgeLockPath(repoRoot)
  const content = JSON.stringify({ pid, startedAt: new Date().toISOString(), workRoot, ...(hostDir === undefined ? {} : { hostDir: resolve(hostDir) }) }, null, 2)
  mkdirSync(dirname(path), { recursive: true })
  for (let attempt = 0; attempt < ACQUIRE_ATTEMPTS; attempt++) {
    const raw = existsSync(path) ? readFileSync(path, 'utf8') : null
    const verdict = classifyBridgeLock(raw, { isAlive })
    if (verdict.status === 'busy') {
      throw new Error(`根桥锁被其他工位占用(${describeBridgeLock(verdict.lock)}),等其退出或用独立仓库副本重跑;锁文件 ${path}`)
    }
    if (verdict.status === 'stale') {
      log(`[bridge] 接管陈旧锁:${verdict.reason}${verdict.lock ? `,${describeBridgeLock(verdict.lock)}` : ''}`)
      // 原子接管:rename 是排他操作,只有一方能把旧锁移走。移走后必须复核内容仍是
      // 刚才读到的 stale 锁;若已被别家新建并接管(内容不同),把它放回去并重试,
      // 不能按"路径存在即删"处理——那会删掉刚抢到锁的并行工位。
      const trash = `${path}.stale-${pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`
      try {
        renameSync(path, trash)
      } catch (error) {
        if (error?.code === 'ENOENT') continue
        throw error
      }
      const moved = readFileSync(trash, 'utf8')
      if (moved !== raw) {
        try { renameSync(trash, path) } catch { /* 别家已重新建锁,以别家为准 */ }
        continue
      }
      rmSync(trash, { force: true })
    }
    if (createExclusive(path, content)) return { path, pid, release: () => releaseBridgeLock({ repoRoot, pid, log }) }
  }
  throw new Error(`根桥锁争抢失败(多次被别家插队);锁文件 ${path}`)
}

// 只删本工位的锁:锁可能已被陈旧锁接管流程改写,误删他人锁等于放行并行重指
export function releaseBridgeLock({ repoRoot, pid = process.pid, path = bridgeLockPath(repoRoot), log = () => {} }) {
  if (!existsSync(path)) return false
  let owner = null
  try {
    owner = JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    owner = null
  }
  if (Number(owner?.pid) !== pid) {
    log(`[bridge] 锁属主非本工位(pid=${owner?.pid ?? '未知'}),不删 ${path}`)
    return false
  }
  rmSync(path, { force: true })
  return true
}

// 该桥目标下所有遗留备份(含旧版无 pid 后缀的 .compat-bak),按 mtime 升序
export function staleBridgeBackups(dst) {
  const dir = dirname(dst)
  if (!existsSync(dir)) return []
  const prefix = `${basename(dst)}${BRIDGE_BACKUP_MARK}`
  return readdirSync(dir)
    .filter((name) => name.startsWith(prefix))
    .map((name) => {
      const path = join(dir, name)
      try {
        return { path, shape: bridgeArtifactShape(path), mtime: lstatSync(path).mtimeMs }
      } catch {
        return null
      }
    })
    .filter(Boolean)
    .sort((a, b) => a.mtime - b.mtime)
}

// heal 决策(纯函数):锁在手时遗留备份必属已死工位,只采信形状合法的。
// dst 缺失或仍是重指留下的链接 → 还原最新备份;dst 已是真实目录 → 原桥在位,丢弃备份。
export function planBridgeHeal({ dstShape, backups }) {
  const valid = backups.filter((backup) => HEALABLE_SHAPES.includes(backup.shape))
  const skip = backups.filter((backup) => !HEALABLE_SHAPES.includes(backup.shape)).map((backup) => backup.path)
  if (valid.length === 0) return { restore: null, discard: [], skip }
  const newest = valid.reduce((left, right) => (right.mtime > left.mtime ? right : left))
  const discard = valid.filter((backup) => backup.path !== newest.path).map((backup) => backup.path)
  if (dstShape === 'symlink' || dstShape === 'absent') return { restore: newest.path, discard, skip }
  return { restore: null, discard: [...discard, newest.path], skip }
}

// heal 落地并逐项审计:桥包消失事故需要留下的确切形态与处置
export function healBridgeBackups(dst, { log = () => {} } = {}) {
  const backups = staleBridgeBackups(dst)
  const plan = planBridgeHeal({ dstShape: bridgeArtifactShape(dst), backups })
  for (const path of plan.skip) log(`[bridge] heal 跳过 ${basename(path)}:形状非法(非符号链接/目录),留待人工处置`)
  if (plan.restore) {
    const shape = backups.find((backup) => backup.path === plan.restore)?.shape ?? 'unknown'
    rmSync(dst, { recursive: true, force: true })
    renameSync(plan.restore, dst)
    log(`[bridge] heal 恢复 ${basename(dst)} ← ${basename(plan.restore)}(备份形状 ${shape})`)
  }
  for (const path of plan.discard) {
    rmSync(path, { recursive: true, force: true })
    log(`[bridge] heal 丢弃陈旧备份 ${basename(path)}`)
  }
  return plan
}

// 只清"登记本工位且持有者已死"的根桥锁:别家工位的锁一律不动(它可能正在重指)。
// 强杀 keeper 会留下这种锁,下一次 acquire 虽能自愈,但收尾工具应显式清掉。
export function clearStaleBridgeLock({ repoRoot, workRoot, isAlive = isProcessAlive, log = () => {} } = {}) {
  const path = bridgeLockPath(repoRoot)
  if (!existsSync(path)) return false
  let raw = null
  try { raw = readFileSync(path, 'utf8') } catch { return false }
  const verdict = classifyBridgeLock(raw, { isAlive })
  if (verdict.status !== 'stale') return false
  const declared = verdict.lock?.workRoot
  if (declared !== undefined && resolve(String(declared)) !== resolve(workRoot)) return false
  rmSync(path, { force: true })
  log(`[bridge] 清理陈旧根桥锁(${verdict.reason ?? '持有者已死'})`)
  return true
}

// 符号链接的真实指向;非符号链接/不可读返回 null。判定"是否重指"只认指向,
// 不认形状:pnpm 的 node_modules 条目本身也是符号链接(指向仓库/store),属原桥。
// lstat 判定"链接在场":工位目录被清掉后链接悬空,existsSync 会假报不在场。
export function bridgeLinkTarget(dst) {
  let stats
  try { stats = lstatSync(dst) } catch { return null }
  if (!stats.isSymbolicLink()) return null
  try { return resolve(dirname(dst), readlinkSync(dst)) } catch { return null }
}

const withinDir = (target, dir) => {
  const root = resolve(dir)
  return target === root || target.startsWith(root.endsWith(sep) ? root : root + sep)
}

// 工位宿主闭包特征:`<hostDir>/node_modules/<pkg>` 是 compat 专有布局,正常 pnpm
// 链接不可能长这样。锁/记录都丢了时按它兜底认领孤儿重指(仅无存活持有者时启用)。
const COMPAT_HOST_MARK = `${sep}dsh-host${sep}node_modules${sep}`
const isCompatHostLayout = (target) => target.includes(COMPAT_HOST_MARK)

// 根桥重指判定:指进本工位(workRoot)、显式 hostDir 或 compat 宿主闭包的符号链接 = 未还原的
// 重指。指到别处(仓库内 workspace 链接/全局 store)属原桥形态,不得当重指处置。
// includeLayout 默认开:实际链接目标是权威口径,workRoot 前缀只是其中一条归属线索。
export function bridgeRepointState({ repoRoot, workRoot, hostDirs = [], includeLayout = true, packages = BRIDGE_PACKAGES } = {}) {
  const repointed = []
  const foreign = []
  for (const name of packages) {
    const dst = join(repoRoot, 'node_modules', name)
    const target = bridgeLinkTarget(dst)
    if (target === null) continue
    const via = withinDir(target, workRoot)
      ? 'workRoot'
      : hostDirs.some((dir) => withinDir(target, dir))
        ? 'hostDir'
        : includeLayout && isCompatHostLayout(target)
          ? 'host-layout'
          : null
    if (via !== null) repointed.push({ name, dst, target, via })
    else foreign.push({ name, dst, target })
  }
  return { repointed, foreign }
}

// 强杀 keeper 后的根桥兜底:keeper 自己收 STOP 时 finally 会还原根桥并释放锁;
// 被 taskkill 强杀则跳过 finally,根桥留在 compat 重指态、锁留在已死 pid 上。
// 本函数按"该工位已无存活重指者"前提补做收尾,并把锁一起清掉。
// 归属:workRoot + 显式 hostDirs + 锁里记录的 hostDir(--host-dir 可在 workRoot 之外)。
// 拒绝条件(不得动手):锁被别的存活工位持有;重指目标不属于本 workRoot/hostDir。
export function recoverRootBridge({ repoRoot, workRoot, hostDirs = [], packages = BRIDGE_PACKAGES, isAlive = isProcessAlive, log = () => {} } = {}) {
  const result = { ok: false, refused: false, healed: [], removed: [], clearedLock: false, pending: [], detail: null }
  const lockPath = bridgeLockPath(repoRoot)
  let raw = null
  try { raw = existsSync(lockPath) ? readFileSync(lockPath, 'utf8') : null } catch { raw = null }
  const verdict = classifyBridgeLock(raw, { isAlive })
  // 锁里记录的 hostDir 只在"锁属于本 workRoot"(或旧格式无 workRoot)时采信,
  // 别家存活工位的锁不得借来认领它自己的重指
  const declared = verdict.lock?.workRoot === undefined || resolve(String(verdict.lock.workRoot)) === resolve(workRoot)
    ? verdict.lock?.hostDir
    : undefined
  const dirs = [...new Set([...hostDirs, declared].filter((dir) => typeof dir === 'string' && dir !== '').map((dir) => resolve(dir)))]
  // 拒绝判定只认显式归属(workRoot/hostDir),不把别家工位闭包链接算成"本工位残留"
  const owned = bridgeRepointState({ repoRoot, workRoot, hostDirs: dirs, includeLayout: false, packages })
  if (verdict.status === 'busy') {
    // 活着的是别的工位的重指者:根桥当下归它,本工位的期望是"没有残留重指"
    result.detail = `根桥锁被存活工位持有(${describeBridgeLock(verdict.lock)})`
    if (owned.repointed.length > 0) {
      result.refused = true
      result.pending = owned.repointed.map((item) => item.dst)
      log(`[bridge] recover 拒绝:${result.detail},且本工位重指仍在(${owned.repointed.map((item) => item.name).join(',')})`)
      return result
    }
    log(`[bridge] recover 跳过:${result.detail},本工位无残留重指`)
    result.ok = true
    return result
  }
  // 无存活持有者:本工位无重指时按 compat 宿主闭包兜底认领孤儿重指
  const usedLayout = owned.repointed.length === 0
  const state = usedLayout
    ? bridgeRepointState({ repoRoot, workRoot, hostDirs: dirs, includeLayout: true, packages })
    : owned
  if (state.repointed.length === 0 && verdict.status === 'free') {
    result.ok = true
    return result
  }
  // 接管/接管陈旧锁(acquire 会原子清陈旧项),独占期内 heal
  const hadLock = verdict.status !== 'free'
  let lock = null
  try {
    lock = acquireBridgeLock({ repoRoot, workRoot, hostDir: dirs[0], log })
  } catch (error) {
    result.refused = true
    result.pending = state.repointed.map((item) => item.dst)
    result.detail = error.message
    log(`[bridge] recover 拒绝:${error.message}`)
    return result
  }
  result.clearedLock = hadLock
  try {
    for (const { name, dst } of state.repointed) {
      const plan = healBridgeBackups(dst, { log })
      if (plan.restore !== null) {
        result.healed.push({ name, via: 'backup', path: plan.restore })
        continue
      }
      // 备份形状非法时不删重指补链:留证据并按未达成上报,避免把唯一可还原物也清掉
      if (plan.skip.length > 0) {
        result.pending.push(dst)
        log(`[bridge] recover 跳过 ${name}:备份形状非法,留待人工`)
        continue
      }
      // 无备份 = 重指时根桥本就不存在:还原语义即删除补链,回到"缺失"
      if (bridgeLinkTarget(dst) !== null) {
        rmSync(dst, { force: true })
        result.removed.push({ name, dst })
        log(`[bridge] recover 删除无备份补链 ${name}`)
      }
    }
  } finally {
    lock.release()
  }
  const after = bridgeRepointState({ repoRoot, workRoot, hostDirs: dirs, includeLayout: usedLayout, packages })
  result.pending = after.repointed.map((item) => item.dst)
  result.ok = after.repointed.length === 0
  if (!result.ok) log(`[bridge] recover 未完成:仍有 ${after.repointed.map((item) => item.name).join(',')} 指进本工位`)
  return result
}
