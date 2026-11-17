// prune 自身:识别两种工位布局、默认只删可重建宿主、活跃/损坏凭证不猜、--all 与 --keep 生效
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  applyPrune,
  collectWorkstations,
  formatBytes,
  parsePruneArgs,
  planPrune,
  workstationBusyReason,
} from './prune.mjs'

function makeRoot() {
  return mkdtempSync(join(tmpdir(), 'compat-prune-'))
}

function writeFile(path, content = 'x') {
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, content, 'utf8')
}

function makeWorkstation(dir, { host = true, bytes = 1024 } = {}) {
  mkdirSync(join(dir, 'home'), { recursive: true })
  writeFile(join(dir, 'home', 'profile.json'), '{}')
  if (host) writeFile(join(dir, 'dsh-host', 'node_modules', 'blob.bin'), 'x'.repeat(bytes))
}

test('parsePruneArgs:默认值、--all、--dry-run、--keep 逗号拆分、未知参数报错', () => {
  const defaults = parsePruneArgs([])
  assert.equal(defaults.all, false)
  assert.equal(defaults.dryRun, false)
  assert.deepEqual(defaults.keep, [])

  const parsed = parsePruneArgs(['--all', '--dry-run', '--work-root', '.', '--keep', 'a,b'])
  assert.equal(parsed.all, true)
  assert.equal(parsed.dryRun, true)
  assert.deepEqual(parsed.keep, ['a', 'b'])
  assert.throws(() => parsePruneArgs(['--nope']), /未知参数/)
  assert.throws(() => parsePruneArgs(['--work-root']), /缺目录/)
})

test('collectWorkstations:识别 workRoot/<版本> 与 workRoot/<工位>/<版本> 两种布局', () => {
  const root = makeRoot()
  try {
    makeWorkstation(join(root, '0.2.2-rc.3'))
    makeWorkstation(join(root, 'manual', '0.2.2-rc.1'))
    mkdirSync(join(root, 'empty'), { recursive: true })
    const found = collectWorkstations(root).map((dir) => dir.slice(root.length + 1)).sort()
    assert.deepEqual(found, ['0.2.2-rc.3', join('manual', '0.2.2-rc.1')])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('planPrune:默认只挑宿主安装,保留 home 与测试证据', () => {
  const root = makeRoot()
  try {
    const workstation = join(root, '0.2.2-rc.3')
    makeWorkstation(workstation, { bytes: 2048 })
    writeFile(join(workstation, 'nm-backup', 'blob.bin'), 'x'.repeat(512))
    writeFile(join(workstation, 'l3-summary.json'), '{}')

    const plan = planPrune({ workRoot: root, isAlive: () => false })
    const row = plan.rows.find((item) => item.dir === workstation)
    assert.deepEqual(row.targets.map((target) => target.slice(workstation.length + 1)).sort(), ['dsh-host', 'nm-backup'])
    assert.equal(row.skipped, null)
    assert.ok(plan.totalBytes > 2048)

    applyPrune(plan)
    assert.equal(existsSync(join(workstation, 'dsh-host')), false)
    assert.equal(existsSync(join(workstation, 'nm-backup')), false)
    assert.equal(existsSync(join(workstation, 'home', 'profile.json')), true)
    assert.equal(existsSync(join(workstation, 'l3-summary.json')), true)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('planPrune:--all 删整个工位,--keep 跳过指定工位', () => {
  const root = makeRoot()
  try {
    const keepDir = join(root, 'keep-me')
    const dropDir = join(root, 'drop-me')
    makeWorkstation(keepDir)
    makeWorkstation(dropDir)

    const plan = planPrune({ workRoot: root, all: true, keep: ['keep-me'], isAlive: () => false })
    const kept = plan.rows.find((row) => row.dir === keepDir)
    assert.equal(kept.skipped, 'keep')
    const dropped = plan.rows.find((row) => row.dir === dropDir)
    assert.deepEqual(dropped.targets, [dropDir])

    applyPrune(plan)
    assert.equal(existsSync(keepDir), true)
    assert.equal(existsSync(dropDir), false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('planPrune:存活 pid 与不可解析凭证都跳过,不删任何东西', () => {
  const root = makeRoot()
  try {
    const liveDir = join(root, 'live')
    makeWorkstation(liveDir)
    writeFile(join(liveDir, 'live.json'), JSON.stringify({ pid: 111, keeperPid: 222 }))

    const lockDir = join(root, 'locked')
    makeWorkstation(lockDir)
    writeFile(join(lockDir, 'boot-keep.lock'), JSON.stringify({ pid: 333 }))

    const brokenDir = join(root, 'broken')
    makeWorkstation(brokenDir)
    writeFile(join(brokenDir, 'boot-keep.lock'), 'not json')

    const alive = new Set([111, 333])
    const plan = planPrune({ workRoot: root, isAlive: (pid) => alive.has(pid) })
    assert.equal(plan.totalBytes, 0)
    assert.equal(plan.rows.find((row) => row.dir === liveDir).skipped, 'pid=111 存活')
    assert.equal(plan.rows.find((row) => row.dir === lockDir).skipped, 'keeper pid=333 存活')
    assert.equal(plan.rows.find((row) => row.dir === brokenDir).skipped, 'boot-keep.lock 不可解析')
    applyPrune(plan)
    assert.equal(existsSync(join(liveDir, 'dsh-host')), true)
    assert.equal(existsSync(join(lockDir, 'dsh-host')), true)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('workstationBusyReason:存活列表外的 pid 视为可回收', () => {
  const root = makeRoot()
  try {
    const dir = join(root, 'ws')
    makeWorkstation(dir)
    writeFile(join(dir, 'live.json'), JSON.stringify({ pid: 999, simulatorPid: 998 }))
    assert.equal(workstationBusyReason(dir, () => false), null)
    assert.equal(workstationBusyReason(dir, (pid) => pid === 998), 'simulatorPid=998 存活')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

// 工位 home 里的 @mzzsfy 是指向仓库 packages 的 junction:删除必须只删链接,不得穿透到目标
test('applyPrune:--all 删工位时不跟随 junction 删除目标内容', () => {
  const root = makeRoot()
  const target = makeRoot()
  try {
    const workstation = join(root, '0.2.2-rc.3')
    makeWorkstation(workstation)
    writeFile(join(target, 'keep.txt'), 'keep')
    symlinkSync(target, join(workstation, 'home', 'linked'), process.platform === 'win32' ? 'junction' : 'dir')

    applyPrune(planPrune({ workRoot: root, all: true, isAlive: () => false }))
    assert.equal(existsSync(workstation), false)
    assert.equal(existsSync(join(target, 'keep.txt')), true)
  } finally {
    rmSync(root, { recursive: true, force: true })
    rmSync(target, { recursive: true, force: true })
  }
})

test('formatBytes:按 B/KB/MB/GB 进位', () => {
  assert.equal(formatBytes(0), '0B')
  assert.equal(formatBytes(1023), '1023B')
  assert.equal(formatBytes(1024), '1.0KB')
  assert.equal(formatBytes(1024 * 1024), '1.0MB')
  assert.equal(formatBytes(3 * 1024 ** 3), '3.0GB')
})
