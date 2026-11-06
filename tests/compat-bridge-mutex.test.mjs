import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import {
  acquireBridgeLock,
  bridgeArtifactShape,
  bridgeBackupPath,
  bridgeLockPath,
  classifyBridgeLock,
  healBridgeBackups,
  planBridgeHeal,
  releaseBridgeLock,
  staleBridgeBackups,
} from '../scripts/compat/bridge-mutex.mjs'

/**
 * B7 根解析桥重指:工位互斥锁与备份所有权
 *
 * BDD 场景:
 *   1. 锁判定 —— 无锁 free、持有者存活 busy、持有者已死/内容损坏 stale
 *   2. 持有者存活的锁 —— 重指直接失败且不篡改原锁(提示占用工位)
 *   3. 陈旧锁 —— 记录后接管,锁内容改写为本工位;释放只删本工位的锁
 *   4. 备份命名 —— 带 pid 后缀,不同工位不互相覆盖;旧无后缀备份仍在发现范围
 *   5. heal 决策 —— 原桥不在位才恢复(取最新),真实目录在位则丢弃陈旧备份,
 *      形状非法(普通文件)既不恢复也不删除
 *   6. heal 落地 —— 链接残留被原桥备份替换,审计日志在场
 *
 * 全程临时目录 + 注入 repoRoot,不触碰仓库 node_modules。
 */

function fixtureRepo(t) {
  const root = mkdtempSync(join(tmpdir(), 'compat-bridge-lock-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  mkdirSync(join(root, 'node_modules'), { recursive: true })
  return root
}

const lockOf = (pid, extra = {}) => JSON.stringify({ pid, startedAt: '2026-01-01T00:00:00.000Z', workRoot: 'C:/other-workstation', ...extra })
const backupEntry = (path, shape, mtime) => ({ path, shape, mtime })

test('锁判定:无锁 free、持有者存活 busy、持有者已死或损坏 stale', () => {
  assert.equal(classifyBridgeLock(null).status, 'free')
  assert.equal(classifyBridgeLock('').status, 'free')

  const busy = classifyBridgeLock(lockOf(4242), { isAlive: () => true })
  assert.equal(busy.status, 'busy')
  assert.equal(busy.lock.pid, 4242)

  const stale = classifyBridgeLock(lockOf(4242), { isAlive: () => false })
  assert.equal(stale.status, 'stale')
  assert.match(stale.reason, /4242/)

  for (const raw of ['not-json', '{}', '{"pid":"abc"}', '{"pid":0}', '[]']) {
    assert.equal(classifyBridgeLock(raw).status, 'stale', `应判为陈旧锁: ${raw}`)
  }
})

test('持有者存活的锁:重指失败且不篡改原锁', (t) => {
  const repoRoot = fixtureRepo(t)
  const path = bridgeLockPath(repoRoot)
  writeFileSync(path, lockOf(process.pid))
  assert.throws(() => acquireBridgeLock({ repoRoot, workRoot: 'C:/mine' }), (error) => {
    assert.match(error.message, /占用/)
    assert.match(error.message, new RegExp(String(process.pid)))
    return true
  })
  assert.equal(JSON.parse(readFileSync(path, 'utf8')).pid, process.pid)
})

test('陈旧锁接管:记录审计后改写为本工位,释放只删本工位的锁', (t) => {
  const repoRoot = fixtureRepo(t)
  const path = bridgeLockPath(repoRoot)
  writeFileSync(path, lockOf(999999))
  const logs = []
  const lock = acquireBridgeLock({
    repoRoot,
    workRoot: 'C:/mine',
    pid: 4321,
    isAlive: () => false,
    log: (message) => logs.push(message),
  })
  assert.equal(logs.length, 1)
  assert.match(logs[0], /陈旧锁/)
  assert.match(logs[0], /999999/)
  const written = JSON.parse(readFileSync(path, 'utf8'))
  assert.deepEqual([written.pid, written.workRoot], [4321, 'C:/mine'])
  assert.ok(written.startedAt.length > 0)

  // 其他 pid 释放不动本工位的锁
  assert.equal(releaseBridgeLock({ repoRoot, pid: 1 }), false)
  assert.ok(existsSync(path))
  lock.release()
  assert.equal(existsSync(path), false)
})

test('损坏的锁文件同样按陈旧锁接管', (t) => {
  const repoRoot = fixtureRepo(t)
  writeFileSync(bridgeLockPath(repoRoot), '{半截 json')
  const logs = []
  acquireBridgeLock({ repoRoot, workRoot: 'C:/mine', pid: 11, log: (message) => logs.push(message) })
  assert.match(logs[0], /不可解析/)
  assert.equal(JSON.parse(readFileSync(bridgeLockPath(repoRoot), 'utf8')).pid, 11)
})

test('备份命名带 pid 后缀,同目标不同工位互不覆盖', () => {
  const dst = join('C:/repo', 'node_modules', '@deepseek-ai', 'zod')
  assert.equal(bridgeBackupPath(dst, 100), `${dst}.compat-bak-100`)
  assert.match(bridgeBackupPath(dst, 100), /\.compat-bak-\d+$/)
  assert.notEqual(bridgeBackupPath(dst, 100), bridgeBackupPath(dst, 200))
  // 备份名是 dst 的兄弟节点,不能落进 dst 内部
  assert.ok(!bridgeBackupPath(dst, 100).startsWith(`${dst}/`))
})

test('遗留备份发现:含无后缀旧备份,不跨包误收', (t) => {
  const repoRoot = fixtureRepo(t)
  const dst = join(repoRoot, 'node_modules', 'zod')
  mkdirSync(dst, { recursive: true })
  mkdirSync(`${dst}.compat-bak`, { recursive: true })
  mkdirSync(`${dst}.compat-bak-42`, { recursive: true })
  mkdirSync(join(repoRoot, 'node_modules', 'zodx.compat-bak-1'), { recursive: true })
  writeFileSync(`${dst}.compat-bak-7`, 'not-a-bridge')
  const found = staleBridgeBackups(dst).map((backup) => relative(repoRoot, backup.path))
  assert.deepEqual(found.sort(), [
    join('node_modules', 'zod.compat-bak'),
    join('node_modules', 'zod.compat-bak-42'),
    join('node_modules', 'zod.compat-bak-7'),
  ].sort())
  assert.deepEqual(staleBridgeBackups(join(repoRoot, 'node_modules', 'absent')), [])
})

test('heal 决策:原桥不在位才恢复最新备份,真实目录在位则丢弃备份', () => {
  assert.deepEqual(planBridgeHeal({ dstShape: 'dir', backups: [] }), { restore: null, discard: [], skip: [] })

  // dst 仍是重指留下的链接 → 原桥在备份里
  const linked = planBridgeHeal({ dstShape: 'symlink', backups: [backupEntry('b1', 'symlink', 1)] })
  assert.equal(linked.restore, 'b1')
  assert.deepEqual(linked.discard, [])

  // dst 缺失 → 取最新备份,其余丢弃
  const absent = planBridgeHeal({
    dstShape: 'absent',
    backups: [backupEntry('b1', 'dir', 1), backupEntry('b2', 'dir', 2)],
  })
  assert.equal(absent.restore, 'b2')
  assert.deepEqual(absent.discard, ['b1'])

  // dst 是真实目录 → 原桥在位,陈旧备份丢弃
  const present = planBridgeHeal({ dstShape: 'dir', backups: [backupEntry('b1', 'symlink', 1)] })
  assert.equal(present.restore, null)
  assert.deepEqual(present.discard, ['b1'])

  // 形状非法 → 既不恢复也不删除
  const invalid = planBridgeHeal({ dstShape: 'absent', backups: [backupEntry('b1', 'other', 1)] })
  assert.equal(invalid.restore, null)
  assert.deepEqual(invalid.discard, [])
  assert.deepEqual(invalid.skip, ['b1'])
})

test('heal 落地:重指残留的链接被原桥备份替换并留审计', (t) => {
  const repoRoot = fixtureRepo(t)
  const dst = join(repoRoot, 'node_modules', 'zod')
  const hostClosure = join(repoRoot, 'other-host', 'node_modules', 'zod')
  mkdirSync(hostClosure, { recursive: true })
  writeFileSync(join(hostClosure, 'package.json'), '{"name":"host-zod"}')
  // 模拟崩溃现场:dst 是本次重指留下的链接,原桥已改名为带后缀备份
  symlinkSync(hostClosure, dst, process.platform === 'win32' ? 'junction' : 'dir')
  mkdirSync(`${dst}.compat-bak-9`)
  writeFileSync(join(`${dst}.compat-bak-9`, 'package.json'), '{"name":"original-zod"}')
  assert.equal(bridgeArtifactShape(dst), 'symlink')

  const logs = []
  healBridgeBackups(dst, { log: (message) => logs.push(message) })
  assert.equal(bridgeArtifactShape(dst), 'dir')
  assert.equal(readFileSync(join(dst, 'package.json'), 'utf8'), '{"name":"original-zod"}')
  assert.equal(existsSync(`${dst}.compat-bak-9`), false)
  assert.ok(logs.some((message) => message.includes('heal 恢复') && message.includes('备份形状 dir')))
})

test('heal 落地:真实目录在位时不动原桥,只清陈旧备份', (t) => {
  const repoRoot = fixtureRepo(t)
  const dst = join(repoRoot, 'node_modules', 'zod')
  mkdirSync(dst, { recursive: true })
  writeFileSync(join(dst, 'package.json'), '{"name":"live-zod"}')
  mkdirSync(`${dst}.compat-bak-3`)
  writeFileSync(`${dst}.compat-bak-4`, 'junk')
  const logs = []
  healBridgeBackups(dst, { log: (message) => logs.push(message) })
  assert.equal(readFileSync(join(dst, 'package.json'), 'utf8'), '{"name":"live-zod"}')
  assert.equal(existsSync(`${dst}.compat-bak-3`), false)
  // 形状非法的备份保留待人工处置
  assert.equal(existsSync(`${dst}.compat-bak-4`), true)
  assert.ok(logs.some((message) => message.includes('形状非法')))
})
