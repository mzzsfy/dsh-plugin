import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import {
  acquireBridgeLock,
  bridgeArtifactShape,
  bridgeBackupPath,
  bridgeLinkTarget,
  bridgeLockPath,
  bridgeRepointState,
  classifyBridgeLock,
  clearStaleBridgeLock,
  healBridgeBackups,
  planBridgeHeal,
  recoverRootBridge,
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

test('锁判定:无锁 free、持有者存活 busy、持有者已死或损坏/空文件 stale', () => {
  assert.equal(classifyBridgeLock(null).status, 'free')
  assert.equal(classifyBridgeLock('').status, 'stale')
  assert.match(classifyBridgeLock('').reason, /空锁文件/)

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

test('空锁文件可被原子接管,不会永久占位', (t) => {
  const repoRoot = fixtureRepo(t)
  writeFileSync(bridgeLockPath(repoRoot), '')
  const lock = acquireBridgeLock({ repoRoot, workRoot: 'C:/work', pid: 4242, isAlive: () => false })
  const content = JSON.parse(readFileSync(bridgeLockPath(repoRoot), 'utf8'))
  assert.equal(content.pid, 4242)
  lock.release()
  assert.equal(existsSync(bridgeLockPath(repoRoot)), false)
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

/**
 * B7b 强杀 keeper 后的根桥兜底:重指判定 + 还原 + 清锁
 *
 * BDD 场景:
 *   1. 重指判定 —— 只有符号链接且指向本 workRoot 才算重指;pnpm 自身链接不算
 *   2. keeper 被强杀(finally 未执行)—— recover 还原备份、删除无备份补链、清陈旧锁
 *   3. 锁被存活工位持有 —— 不动别人的根桥;本工位残留重指时拒绝并报未达成
 *   4. 备份形状非法 —— 不删唯一证据,按未达成上报
 *   5. clearStaleBridgeLock —— 只清登记本工位且持有者已死的锁
 */

const BRIDGE_HOST = join('.compat', '0.2.2-rc.1', 'dsh-host', 'node_modules')
const REPOINT_PACKAGES = ['zod', '@deepseek-ai/dsh-tools']

/** 造现场:dst 原位是原桥(真实目录),重指后原位变链接、原桥改名为带 pid 备份 */
function repointedRepo(t, { packages = REPOINT_PACKAGES, backup = true, backupShape = 'dir' } = {}) {
  const repoRoot = fixtureRepo(t)
  const workRoot = join(repoRoot, '.compat')
  const entries = []
  for (const name of packages) {
    const src = join(repoRoot, BRIDGE_HOST, name)
    mkdirSync(src, { recursive: true })
    writeFileSync(join(src, 'package.json'), `{"name":"host${name}"}`)
    const dst = join(repoRoot, 'node_modules', name)
    mkdirSync(dst, { recursive: true })
    writeFileSync(join(dst, 'package.json'), `{"name":"original${name}"}`)
    if (backup) {
      if (backupShape === 'dir') renameSync(dst, bridgeBackupPath(dst, 999))
      else {
        rmSync(dst, { recursive: true, force: true })
        writeFileSync(bridgeBackupPath(dst, 999), 'junk')
      }
    } else {
      rmSync(dst, { recursive: true, force: true })
    }
    symlinkSync(src, dst, process.platform === 'win32' ? 'junction' : 'dir')
    entries.push({ name, src, dst })
  }
  return { repoRoot, workRoot, entries }
}

test('重指判定:指进本 workRoot 的链接才算重指,指到别处属原桥', (t) => {
  const { repoRoot, workRoot, entries } = repointedRepo(t)
  const state = bridgeRepointState({ repoRoot, workRoot, packages: REPOINT_PACKAGES })
  assert.deepEqual(state.repointed.map((item) => item.name), entries.map((entry) => entry.name))
  assert.deepEqual(state.foreign, [])

  // 指向别的工位/仓库内的链接不属本工位重指
  const [first] = entries
  rmSync(first.dst, { force: true })
  mkdirSync(join(repoRoot, 'other-host'), { recursive: true })
  symlinkSync(join(repoRoot, 'other-host'), first.dst, process.platform === 'win32' ? 'junction' : 'dir')
  const after = bridgeRepointState({ repoRoot, workRoot, packages: REPOINT_PACKAGES })
  assert.deepEqual(after.repointed.map((item) => item.name), [entries[1].name])
  assert.deepEqual(after.foreign.map((item) => item.name), [first.name])
  assert.equal(bridgeLinkTarget(first.dst), join(repoRoot, 'other-host'))
})

test('重指判定:工位目录被清掉后的悬空链接仍算重指', (t) => {
  // Given 链接指向的宿主闭包已被删除;When 复核根桥;Then 不得因 existsSync 假报"无重指"
  const { repoRoot, workRoot, entries } = repointedRepo(t, { packages: ['zod'] })
  rmSync(entries[0].src, { recursive: true, force: true })
  const state = bridgeRepointState({ repoRoot, workRoot, packages: ['zod'] })
  assert.deepEqual(state.repointed.map((item) => item.name), ['zod'])
  assert.equal(bridgeArtifactShape(entries[0].dst), 'symlink')

  const result = recoverRootBridge({ repoRoot, workRoot, packages: ['zod'], isAlive: () => false })
  assert.equal(result.ok, true)
  assert.equal(bridgeArtifactShape(entries[0].dst), 'dir', '悬空重指也必须还原为原桥')
})

test('recover:强杀现场还原备份并清陈旧锁', (t) => {
  const { repoRoot, workRoot, entries } = repointedRepo(t)
  writeFileSync(bridgeLockPath(repoRoot), lockOf(999999, { workRoot }))
  const logs = []
  const result = recoverRootBridge({
    repoRoot,
    workRoot,
    packages: REPOINT_PACKAGES,
    isAlive: () => false,
    log: (message) => logs.push(message),
  })
  assert.equal(result.ok, true, logs.join('\n'))
  assert.deepEqual(result.healed.map((item) => item.name), entries.map((entry) => entry.name))
  assert.equal(result.clearedLock, true)
  assert.deepEqual(result.pending, [])
  for (const entry of entries) {
    assert.equal(bridgeArtifactShape(entry.dst), 'dir', `${entry.name} 必须还原为原桥目录`)
    assert.equal(readFileSync(join(entry.dst, 'package.json'), 'utf8'), `{"name":"original${entry.name}"}`)
    assert.equal(existsSync(bridgeBackupPath(entry.dst, 999)), false, '备份必须被消费掉')
  }
  assert.equal(existsSync(bridgeLockPath(repoRoot)), false, '陈旧锁必须清掉')
})

test('recover:重指时根桥本不存在则删除补链,不留悬空链接', (t) => {
  const { repoRoot, workRoot, entries } = repointedRepo(t, { packages: ['zod'], backup: false })
  const result = recoverRootBridge({ repoRoot, workRoot, packages: ['zod'], isAlive: () => false })
  assert.equal(result.ok, true)
  assert.deepEqual(result.removed.map((item) => item.name), ['zod'])
  assert.equal(existsSync(entries[0].dst), false, '无备份补链必须删除,回到"缺失"')
})

test('recover:锁被存活工位持有且本工位无残留重指时不动别人的根桥', (t) => {
  const { repoRoot, workRoot } = repointedRepo(t, { packages: ['zod'], backup: false })
  const otherRoot = join(repoRoot, '.compat-multimodel')
  const lockPath = bridgeLockPath(repoRoot)
  writeFileSync(lockPath, lockOf(process.pid, { workRoot: otherRoot }))
  // 别家工位的重指现场:本 workRoot 下无重指
  const dst = join(repoRoot, 'node_modules', 'zod')
  const foreignHost = join(repoRoot, '.compat-multimodel', 'dsh-host', 'node_modules', 'zod')
  mkdirSync(foreignHost, { recursive: true })
  rmSync(dst, { force: true })
  symlinkSync(foreignHost, dst, process.platform === 'win32' ? 'junction' : 'dir')
  const result = recoverRootBridge({ repoRoot, workRoot, packages: ['zod'] })
  assert.equal(result.ok, true)
  assert.deepEqual(result.healed, [])
  assert.equal(existsSync(lockPath), true, '别人的锁不得清除')
  assert.equal(bridgeArtifactShape(dst), 'symlink', '别人的重指不得改动')
})

test('recover:锁被存活工位持有且本工位重指仍在则拒绝,不得报成功', (t) => {
  const { repoRoot, workRoot, entries } = repointedRepo(t, { packages: ['zod'] })
  const lockPath = bridgeLockPath(repoRoot)
  const otherLock = lockOf(process.pid, { workRoot: join(repoRoot, '.compat-multimodel') })
  writeFileSync(lockPath, otherLock)
  const result = recoverRootBridge({ repoRoot, workRoot, packages: ['zod'] })
  assert.equal(result.ok, false)
  assert.equal(result.refused, true)
  assert.deepEqual(result.pending, [entries[0].dst])
  assert.equal(readFileSync(lockPath, 'utf8'), otherLock, '拒绝路径不得改写别人的锁')
  assert.equal(bridgeArtifactShape(entries[0].dst), 'symlink')
})

test('recover:备份形状非法时不删唯一证据,按未达成上报', (t) => {
  const { repoRoot, workRoot, entries } = repointedRepo(t, { packages: ['zod'], backupShape: 'other' })
  const result = recoverRootBridge({ repoRoot, workRoot, packages: ['zod'], isAlive: () => false })
  assert.equal(result.ok, false)
  assert.deepEqual(result.pending, [entries[0].dst])
  assert.equal(existsSync(bridgeBackupPath(entries[0].dst, 999)), true, '非法备份不得删除')
  assert.equal(bridgeArtifactShape(entries[0].dst), 'symlink', '重指补链不得删除')
})

/**
 * B7c 跨 hostDir 重指:归属按实际链接目标,不按 workRoot 前缀
 *
 * BDD 场景:
 *   1. hostDir 落在 workRoot 之外 —— 只凭 workRoot 会漏判(repointed=0/foreign=1),
 *      显式 hostDirs 或锁内记录的 hostDir 必须能认领
 *   2. 锁记录 hostDir 的强杀现场 —— recover 还原自带备份(pid 后缀可不同)、清锁
 *   3. 裸调用(无锁无 hostDir)—— 按 compat 宿主闭包兜底认领孤儿重指
 */

function crossHostRepo(t) {
  const repoRoot = fixtureRepo(t)
  const workRoot = join(repoRoot, '.compat-multimodel')
  const hostDir = join(repoRoot, '.compat', '0.2.2-rc.3', 'dsh-host')
  const entries = []
  for (const name of ['zod']) {
    const src = join(hostDir, 'node_modules', name)
    mkdirSync(src, { recursive: true })
    writeFileSync(join(src, 'package.json'), '{"name":"host-zod"}')
    const dst = join(repoRoot, 'node_modules', name)
    mkdirSync(dst, { recursive: true })
    writeFileSync(join(dst, 'package.json'), '{"name":"original-zod"}')
    renameSync(dst, bridgeBackupPath(dst, 1344))
    symlinkSync(src, dst, process.platform === 'win32' ? 'junction' : 'dir')
    entries.push({ name, src, dst })
  }
  return { repoRoot, workRoot, hostDir, entries }
}

test('重指判定:hostDir 在 workRoot 之外按实际链接目标认领,不得漏判', (t) => {
  const { repoRoot, workRoot, hostDir } = crossHostRepo(t)
  const blind = bridgeRepointState({ repoRoot, workRoot, packages: ['zod'], includeLayout: false })
  assert.deepEqual(blind.repointed, [], '只按 workRoot 前缀会漏判(实机形态)')
  assert.deepEqual(blind.foreign.map((item) => item.name), ['zod'])

  const byLayout = bridgeRepointState({ repoRoot, workRoot, packages: ['zod'] })
  assert.deepEqual(byLayout.repointed.map((item) => [item.name, item.via]), [['zod', 'host-layout']], '默认按实际链接目标认领')

  const explicit = bridgeRepointState({ repoRoot, workRoot, hostDirs: [hostDir], packages: ['zod'] })
  assert.deepEqual(explicit.repointed.map((item) => [item.name, item.via]), [['zod', 'hostDir']])
})

test('recover:锁内 hostDir 跨 workRoot 也能还原自带备份并清锁', (t) => {
  const { repoRoot, workRoot, hostDir, entries } = crossHostRepo(t)
  writeFileSync(bridgeLockPath(repoRoot), lockOf(999999, { workRoot, hostDir }))
  const logs = []
  const result = recoverRootBridge({
    repoRoot,
    workRoot,
    packages: ['zod'],
    isAlive: () => false,
    log: (message) => logs.push(message),
  })
  assert.equal(result.ok, true, logs.join('\n'))
  assert.deepEqual(result.healed.map((item) => item.name), ['zod'])
  assert.equal(result.clearedLock, true)
  assert.equal(bridgeArtifactShape(entries[0].dst), 'dir')
  assert.equal(readFileSync(join(entries[0].dst, 'package.json'), 'utf8'), '{"name":"original-zod"}')
  assert.equal(existsSync(bridgeBackupPath(entries[0].dst, 1344)), false, '自带备份必须被消费')
  assert.equal(existsSync(bridgeLockPath(repoRoot)), false)
})

test('recover:无锁无 hostDir 时按宿主闭包兜底还原孤儿重指,失败非零', (t) => {
  const { repoRoot, workRoot } = crossHostRepo(t)
  const healed = recoverRootBridge({ repoRoot, workRoot, packages: ['zod'], isAlive: () => false })
  assert.equal(healed.ok, true)
  assert.deepEqual(healed.healed.map((item) => item.name), ['zod'])

  // 还原不了(备份形状非法)必须报未达成,调用方据此非零
  const { repoRoot: repo2, workRoot: root2, entries } = crossHostRepo(t)
  const dst = entries[0].dst
  rmSync(bridgeBackupPath(dst, 1344), { recursive: true, force: true })
  writeFileSync(bridgeBackupPath(dst, 1344), 'junk')
  const failed = recoverRootBridge({ repoRoot: repo2, workRoot: root2, packages: ['zod'], isAlive: () => false })
  assert.equal(failed.ok, false)
  assert.deepEqual(failed.pending, [dst])
  assert.equal(bridgeArtifactShape(dst), 'symlink', '非法备份现场不得删链接')
})

test('acquireBridgeLock:显式 hostDir 入锁,供强杀后认领重指', (t) => {
  const repoRoot = fixtureRepo(t)
  const hostDir = join(repoRoot, '.compat', '0.2.2-rc.3', 'dsh-host')
  const lock = acquireBridgeLock({ repoRoot, workRoot: 'C:/mine', hostDir })
  const written = JSON.parse(readFileSync(bridgeLockPath(repoRoot), 'utf8'))
  assert.equal(written.hostDir, hostDir)
  lock.release()
})

test('clearStaleBridgeLock:只清登记本工位且持有者已死的锁', (t) => {
  const repoRoot = fixtureRepo(t)
  const workRoot = join(repoRoot, '.compat')
  const path = bridgeLockPath(repoRoot)

  assert.equal(clearStaleBridgeLock({ repoRoot, workRoot, isAlive: () => true }), false, '无锁不算清理')
  writeFileSync(path, lockOf(process.pid, { workRoot }))
  assert.equal(clearStaleBridgeLock({ repoRoot, workRoot }), false, '持有者存活不得清')
  assert.equal(existsSync(path), true)

  writeFileSync(path, lockOf(999999, { workRoot: join(repoRoot, '.compat-multimodel') }))
  assert.equal(clearStaleBridgeLock({ repoRoot, workRoot, isAlive: () => false }), false, '别家工位的锁不得清')
  assert.equal(existsSync(path), true)

  writeFileSync(path, lockOf(999999, { workRoot }))
  assert.equal(clearStaleBridgeLock({ repoRoot, workRoot, isAlive: () => false }), true)
  assert.equal(existsSync(path), false)
})
