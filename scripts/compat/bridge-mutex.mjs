// 根桥重指的工位互斥与备份:锁判定/陈旧锁接管/备份命名/heal 决策为纯函数,IO 只做落地。
// 多工位(文档支持 --work-root 错开)交错重指同一根桥会互删根桥,故重指前先抢独占锁;
// 备份带 pid 后缀,restore 只还原本工位创建的备份。
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { isProcessAlive } from './lib.mjs'

export const BRIDGE_LOCK_FILE = '.compat-bridge.lock'
export const BRIDGE_BACKUP_MARK = '.compat-bak'
// 只有这两类形态才可能是重指暂存的原桥;其余(普通文件/损坏链接)一律不采信
const HEALABLE_SHAPES = ['symlink', 'dir']

export const bridgeLockPath = (repoRoot) => join(repoRoot, 'node_modules', BRIDGE_LOCK_FILE)
export const bridgeBackupPath = (dst, pid) => `${dst}${BRIDGE_BACKUP_MARK}-${pid}`

export function bridgeArtifactShape(path) {
  if (!existsSync(path)) return 'absent'
  const stats = lstatSync(path)
  if (stats.isSymbolicLink()) return 'symlink'
  return stats.isDirectory() ? 'dir' : 'other'
}

export function describeBridgeLock(lock) {
  if (!lock) return '(内容不可解析)'
  return `pid=${lock.pid} startedAt=${lock.startedAt ?? '(无)'} workRoot=${lock.workRoot ?? '(无)'}`
}

// 锁判定:free 无锁 / busy 持有者存活 / stale 持有者已死或内容损坏(可接管)
export function classifyBridgeLock(raw, { isAlive = isProcessAlive } = {}) {
  if (raw === null || raw === undefined || raw === '') return { status: 'free' }
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

export function acquireBridgeLock({ repoRoot, workRoot, pid = process.pid, isAlive = isProcessAlive, log = () => {} }) {
  const path = bridgeLockPath(repoRoot)
  const content = JSON.stringify({ pid, startedAt: new Date().toISOString(), workRoot }, null, 2)
  mkdirSync(dirname(path), { recursive: true })
  for (let attempt = 0; attempt < ACQUIRE_ATTEMPTS; attempt++) {
    const raw = existsSync(path) ? readFileSync(path, 'utf8') : null
    const verdict = classifyBridgeLock(raw, { isAlive })
    if (verdict.status === 'busy') {
      throw new Error(`根桥锁被其他工位占用(${describeBridgeLock(verdict.lock)}),等其退出或用独立仓库副本重跑;锁文件 ${path}`)
    }
    if (verdict.status === 'stale') {
      log(`[bridge] 接管陈旧锁:${verdict.reason}${verdict.lock ? `,${describeBridgeLock(verdict.lock)}` : ''}`)
      rmSync(path, { force: true })
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
