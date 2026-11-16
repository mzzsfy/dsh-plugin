import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { judgeVersionCleanup, parseKeepStopArgs, stopAll, stopVersion } from '../scripts/compat/keep-stop.mjs'

/**
 * B6 keep-stop 收尾契约:参数分流 + 失败不静默 + 缺 live.json 的 keeper 窗口
 *
 * BDD 场景:
 *   1. 参数 —— 版本列表与 --sweep 分离,未知选项报错
 *   2. 收尾判定 —— 宿主与模拟器目标任一未终止即失败(调用方据此置 exitCode 1
 *      且保留 live.json 供重试);全部终止或无目标才算成功
 *   3. 缺 live.json 但 keeper 存活(宿主重启窗口)—— 写 STOP 并等其自行收尾,
 *      不得像"无工位"那样报成功;等不到必须强杀并补做根桥收尾
 *   4. 根桥未还原 —— 无论 live.json 在不在都不得报成功(重跑必须能发现)
 */

const okResult = { ok: true, killed: [{ pid: 1, via: 'host' }], failures: [] }
const okBridge = () => ({ ok: true, refused: false, healed: [], removed: [], clearedLock: false, pending: [], detail: null })

test('参数:版本列表与 --sweep 分离,未知选项报错', () => {
  assert.partialDeepStrictEqual(parseKeepStopArgs([]), { versions: [], sweep: false })
  assert.partialDeepStrictEqual(parseKeepStopArgs(['--sweep', '0.2.0-rc.1', '0.1.5']), { versions: ['0.2.0-rc.1', '0.1.5'], sweep: true })
  assert.partialDeepStrictEqual(parseKeepStopArgs(['0.1.5', '--sweep']), { versions: ['0.1.5'], sweep: true })
  assert.throws(() => parseKeepStopArgs(['--nope']), /未知参数/)
})

test('收尾判定:任一目标未终止即失败', () => {
  assert.deepEqual(judgeVersionCleanup({ host: okResult, simulator: okResult }), { ok: true, failures: [] })

  const simulatorFailed = { ok: false, killed: [], failures: [{ pid: 2, via: 'simulatorPid', detail: '进程仍存活' }] }
  const simulatorVerdict = judgeVersionCleanup({ host: okResult, simulator: simulatorFailed })
  assert.equal(simulatorVerdict.ok, false)
  assert.deepEqual(simulatorVerdict.failures, simulatorFailed.failures)

  const hostFailed = { ok: false, killed: [], failures: [{ pid: 3, via: 'host', detail: 'access denied' }] }
  assert.equal(judgeVersionCleanup({ host: hostFailed, simulator: okResult }).ok, false)

  // 无目标(live.json 无 pid 且未匹配模拟器)按成功处理,才可能删 live.json
  assert.equal(judgeVersionCleanup({ host: { failures: [] }, simulator: { failures: [] } }).ok, true)
})

/** 单工位夹具:live.json 四类 pid 齐全,探测/终止全部由 deps 注入 */
function keeperFixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'keep-stop-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const workRoot = join(root, '.compat')
  const version = '0.2.0-rc.1'
  mkdirSync(join(workRoot, version), { recursive: true })
  const livePath = join(workRoot, version, 'live.json')
  writeFileSync(livePath, JSON.stringify({
    port: 9296,
    pid: 111,
    hostStartedAt: 1,
    keeperPid: 222,
    keeperStartedAt: 1,
    simulatorPid: 333,
    simulatorStartedAt: 1,
  }))
  return { root, workRoot, version, livePath, stopFlag: join(workRoot, version, 'boot-keep.stop') }
}

/** 宿主重启窗口夹具:live.json 已被 boot-keep 净删,只剩 keeper 锁 */
function keeperOnlyFixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'keep-stop-restart-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const workRoot = join(root, '.compat')
  const version = '0.2.2-rc.1'
  mkdirSync(join(workRoot, version), { recursive: true })
  const lockPath = join(workRoot, version, 'boot-keep.lock')
  writeFileSync(lockPath, JSON.stringify({
    pid: 555,
    startedAt: '2026-01-01T00:00:00.000Z',
    hostDir: join(root, '.compat', '0.2.2-rc.1', 'dsh-host'),
  }))
  return { root, workRoot, version, lockPath, livePath: join(workRoot, version, 'live.json'), stopFlag: join(workRoot, version, 'boot-keep.stop') }
}

function fakeDeps({ alive, bridge = okBridge, overrides = {} } = {}) {
  let aliveNow = alive
  return {
    collectKeeper: () => ({ targets: [{ pid: 222, via: 'keeper' }], refused: false }),
    collectHost: () => ({ targets: [], refused: false }),
    collectSimulator: () => ({ targets: [], refused: false }),
    terminate: targets => ({ ok: true, killed: targets.map(({ pid, via }) => ({ pid, via })), failures: [] }),
    isAlive: () => (typeof aliveNow === 'function' ? aliveNow() : aliveNow),
    // 第一次进入循环在期限内,第二次已过 KEEPER_STOP_TIMEOUT_MS,不真等 15s
    sleep: () => { aliveNow = false },
    now: (() => { let calls = 0; return () => (calls++ === 0 ? 0 : 60_000) })(),
    recoverBridge: bridge,
    ...overrides,
  }
}

test('stopVersion_keeper STOP超时强杀_非零并保留 live.json', t => {
  // Given keeper 无视 STOP 且被强杀;When 收尾;Then 不得谎报成功,必须保留工位供核验
  const { workRoot, version, livePath, stopFlag } = keeperFixture(t)
  const previousExitCode = process.exitCode
  try {
    process.exitCode = undefined
    assert.equal(stopVersion(version, { sweep: false, workRoot, deps: fakeDeps({ alive: true }) }), true)
    assert.equal(process.exitCode, 1, '强杀 keeper 的收尾必须非零退出')
    assert.ok(existsSync(livePath), '强杀分支必须保留 live.json(根桥还原未验证)')
    assert.ok(existsSync(stopFlag), 'STOP 标记保留,便于人工/重跑继续处置')
  } finally {
    process.exitCode = previousExitCode
  }
})

test('stopVersion_keeper 正常收到 STOP 退出_删 live.json 且成功', t => {
  // Given keeper 已退出且宿主/模拟器无目标;When 收尾;Then 全达成才删除 live.json
  const { workRoot, version, livePath, stopFlag } = keeperFixture(t)
  const previousExitCode = process.exitCode
  try {
    process.exitCode = undefined
    assert.equal(stopVersion(version, { sweep: false, workRoot, deps: fakeDeps({ alive: false }) }), true)
    assert.equal(process.exitCode, undefined)
    assert.equal(existsSync(livePath), false)
    assert.equal(existsSync(stopFlag), false)
  } finally {
    process.exitCode = previousExitCode
  }
})

test('stopVersion_缺 live 但 keeper 存活:写 STOP 等其收尾,成功后才清凭证', t => {
  // Given 宿主重启窗口(keeper 每轮 spawn 前净删 live.json);When keep-stop;
  // Then 必须按 keeper 锁发现工位、落 STOP 让它自行还原根桥,不得以"0 工位"报成功
  const { workRoot, version, lockPath, livePath, stopFlag } = keeperOnlyFixture(t)
  const previousExitCode = process.exitCode
  const observed = []
  const bridgeCalls = []
  let hint = null
  const holder = { alive: true }
  try {
    process.exitCode = undefined
    const deps = {
      ...fakeDeps({ alive: true }),
      collectKeeper: (candidate) => { hint = candidate; return { targets: [{ pid: 555, via: 'keeper' }], refused: false } },
      isAlive: () => holder.alive,
      // 时间只前进一小步:等 keeper 收到 STOP 自行退出,不触发超时强杀
      now: (() => { let clock = 0; return () => (clock += 200) })(),
      // keeper 收到 STOP 后自行退出:等待期间 STOP 必须已经落盘
      sleep: () => { observed.push(existsSync(stopFlag)); holder.alive = false },
      recoverBridge: (args) => { bridgeCalls.push(args); return okBridge() },
    }
    assert.equal(stopVersion(version, { sweep: false, workRoot, deps }), true)
    assert.equal(process.exitCode, undefined, 'keeper 收到 STOP 正常退出时必须成功')
    assert.deepEqual(observed, [true], '等待 keeper 前必须已落 STOP 标记')
    assert.equal(existsSync(stopFlag), false, '成功后清 STOP,避免污染下一个 keeper')
    assert.equal(existsSync(lockPath), false, '成功后清陈旧 keeper 锁')
    assert.equal(existsSync(livePath), false)
    assert.equal(hint.keeperPid, 555, 'keeper 目标必须由锁里的 pid 派生')
    assert.equal(bridgeCalls.length, 1, '成功分支必须复核根桥')
    assert.equal(bridgeCalls[0].workRoot, workRoot)
  } finally {
    process.exitCode = previousExitCode
  }
})

test('stopVersion_缺 live 且 keeper 无视 STOP:强杀后非零,保留 STOP 与锁', t => {
  // Given 重启窗口里 keeper 卡住不退出;When keep-stop;Then 强杀不得报成功
  const { workRoot, version, lockPath, livePath, stopFlag } = keeperOnlyFixture(t)
  const previousExitCode = process.exitCode
  const bridgeCalls = []
  try {
    process.exitCode = undefined
    const deps = fakeDeps({
      alive: true,
      bridge: (args) => { bridgeCalls.push(args); return okBridge() },
      overrides: { now: (() => { let calls = 0; return () => (calls++ === 0 ? 0 : 60_000) })() },
    })
    assert.equal(stopVersion(version, { sweep: false, workRoot, deps }), true)
    assert.equal(process.exitCode, 1, ' keeper 被强杀必须非零退出')
    assert.ok(existsSync(stopFlag), '强杀分支保留 STOP 供人工核验')
    assert.ok(existsSync(lockPath), '强杀分支保留 keeper 锁供人工核验')
    assert.equal(existsSync(livePath), false)
    assert.equal(bridgeCalls.length, 1, '强杀后必须补做根桥/锁收尾')
  } finally {
    process.exitCode = previousExitCode
  }
})

test('stopVersion_缺 live 且 keeper 已死但根桥仍重指:非零', t => {
  // Given 上一次强杀留下的重指根桥;When 重跑 keep-stop;Then 不得在桥未还原时报成功,
  // 且 keeper 锁里记录的 hostDir 必须交给根桥复核(可落在 workRoot 之外)
  const { workRoot, version, lockPath, stopFlag } = keeperOnlyFixture(t)
  const previousExitCode = process.exitCode
  const calls = []
  try {
    process.exitCode = undefined
    const deps = fakeDeps({
      alive: false,
      overrides: {
        collectKeeper: () => ({ targets: [], refused: false }),
        recoverBridge: (args) => { calls.push(args); return { ...okBridge(), ok: false, pending: ['C:/repo/node_modules/zod'], detail: 'heal 失败' } },
      },
    })
    assert.equal(stopVersion(version, { sweep: false, workRoot, deps }), true)
    assert.equal(process.exitCode, 1)
    assert.deepEqual(calls[0].hostDirs, [JSON.parse(readFileSync(lockPath, 'utf8')).hostDir], 'keeper 锁的 hostDir 必须透传')
    assert.ok(existsSync(lockPath), '失败分支保留陈旧锁供人工核验')
    assert.equal(existsSync(stopFlag), false, 'keeper 已死不得留 STOP(会毒化下一个 keeper)')
  } finally {
    process.exitCode = previousExitCode
  }
})

test('stopVersion_补做根桥还原成功:exit 0 并清陈旧锁', t => {
  const { workRoot, version, lockPath, stopFlag } = keeperOnlyFixture(t)
  const previousExitCode = process.exitCode
  try {
    process.exitCode = undefined
    const deps = fakeDeps({
      alive: false,
      overrides: {
        collectKeeper: () => ({ targets: [], refused: false }),
        recoverBridge: () => ({ ...okBridge(), healed: [{ name: 'zod', via: 'backup', path: 'x' }] }),
      },
    })
    assert.equal(stopVersion(version, { sweep: false, workRoot, deps }), true)
    assert.equal(process.exitCode, undefined)
    assert.equal(existsSync(lockPath), false)
    assert.equal(existsSync(stopFlag), false)
  } finally {
    process.exitCode = previousExitCode
  }
})

test('stopVersion_缺 live 且 keeper 锁不可解析:不得猜存活,非零保留', t => {
  const { workRoot, version, lockPath } = keeperOnlyFixture(t)
  const previousExitCode = process.exitCode
  try {
    process.exitCode = undefined
    writeFileSync(lockPath, '{半截 json')
    const deps = fakeDeps({ alive: false, overrides: { recoverBridge: okBridge } })
    assert.equal(stopVersion(version, { sweep: false, workRoot, deps }), true)
    assert.equal(process.exitCode, 1)
    assert.ok(existsSync(lockPath))
  } finally {
    process.exitCode = previousExitCode
  }
})

test('stopVersion_live 存在但根桥未还原:非零且保留 live.json', t => {
  // Given 宿主/模拟器都收完了,根桥仍指进本工位;When 收尾;Then 重跑必须能再次发现
  const { workRoot, version, livePath } = keeperFixture(t)
  const previousExitCode = process.exitCode
  try {
    process.exitCode = undefined
    const deps = fakeDeps({
      alive: false,
      overrides: { recoverBridge: () => ({ ...okBridge(), ok: false, pending: ['C:/repo/node_modules/zod'] }) },
    })
    assert.equal(stopVersion(version, { sweep: false, workRoot, deps }), true)
    assert.equal(process.exitCode, 1)
    assert.ok(existsSync(livePath), '桥未还原必须保留 live.json 供重试')
  } finally {
    process.exitCode = previousExitCode
  }
})

test('stopVersion_无 live 无锁但根桥仍重指:补做还原,还原失败则非零', t => {
  // Given 工位只剩强杀留下的重指根桥(live/锁都被清掉);When 重跑 keep-stop;
  // Then 必须按根桥状态处置,不得"无工位"静默成功
  const { workRoot, version } = keeperOnlyFixture(t)
  rmSync(join(workRoot, version, 'boot-keep.lock'), { force: true })
  const previousExitCode = process.exitCode
  const repointed = [{ name: 'zod', dst: 'C:/repo/node_modules/zod', target: join(workRoot, version, 'dsh-host', 'node_modules', 'zod') }]
  try {
    process.exitCode = undefined
    const healed = []
    const deps = {
      bridgeState: () => ({ repointed, foreign: [] }),
      recoverBridge: (args) => { healed.push(args); return { ...okBridge(), healed: [{ name: 'zod', via: 'backup', path: 'x' }] } },
      clearStaleLock: () => false,
    }
    assert.equal(stopVersion(version, { sweep: false, workRoot, deps }), true)
    assert.equal(process.exitCode, undefined, '兜底还原成功即达成收尾')
    assert.equal(healed.length, 1)

    process.exitCode = undefined
    const failing = {
      bridgeState: () => ({ repointed, foreign: [] }),
      recoverBridge: () => ({ ...okBridge(), ok: false, pending: ['C:/repo/node_modules/zod'], detail: '锁被占用' }),
      clearStaleLock: () => false,
    }
    assert.equal(stopVersion(version, { sweep: false, workRoot, deps: failing }), true)
    assert.equal(process.exitCode, 1, '根桥未还原不得成功')
  } finally {
    process.exitCode = previousExitCode
  }
})

test('stopVersion_无 live 无锁且根桥干净:清陈旧锁后计为收尾', t => {
  const { workRoot, version } = keeperOnlyFixture(t)
  rmSync(join(workRoot, version, 'boot-keep.lock'), { force: true })
  const previousExitCode = process.exitCode
  try {
    process.exitCode = undefined
    const cleared = []
    const clean = {
      bridgeState: () => ({ repointed: [], foreign: [] }),
      clearStaleLock: (args) => { cleared.push(args); return true },
      recoverBridge: okBridge,
    }
    assert.equal(stopVersion(version, { sweep: false, workRoot, deps: clean }), true)
    assert.equal(cleared.length, 1)
    assert.equal(process.exitCode, undefined)

    process.exitCode = undefined
    const nothing = {
      bridgeState: () => ({ repointed: [], foreign: [] }),
      clearStaleLock: () => false,
      recoverBridge: okBridge,
    }
    assert.equal(stopVersion(version, { sweep: false, workRoot, deps: nothing }), false, '真正无残留时不计为收尾')
  } finally {
    process.exitCode = previousExitCode
  }
})

test('stopVersion_live.hostDir 透传根桥复核:hostDir 在 workRoot 之外失败必须非零', t => {
  // Given keeper 用 --host-dir 指到 workRoot 之外,重指只按 workRoot 前缀看不到;
  // When 收尾;Then 必须把 hostDir 交给根桥复核,复核失败即非零(实机漏判形态)
  const { workRoot, version, livePath } = keeperFixture(t)
  const hostDir = 'C:/elsewhere/.compat/0.2.2-rc.3/dsh-host'
  const live = JSON.parse(readFileSync(livePath, 'utf8'))
  writeFileSync(livePath, JSON.stringify({ ...live, hostDir }))
  const previousExitCode = process.exitCode
  const calls = []
  try {
    process.exitCode = undefined
    const failing = fakeDeps({
      alive: false,
      overrides: { recoverBridge: (args) => { calls.push(args); return { ...okBridge(), ok: false, pending: ['C:/repo/node_modules/zod'] } } },
    })
    assert.equal(stopVersion(version, { sweep: false, workRoot, deps: failing }), true)
    assert.equal(process.exitCode, 1, 'hostDir 归属的重指还原失败不得报成功')
    assert.deepEqual(calls[0].hostDirs, [hostDir])
    assert.ok(existsSync(livePath), '失败必须保留 live.json')

    process.exitCode = undefined
    const okCalls = []
    const passing = fakeDeps({
      alive: false,
      overrides: { recoverBridge: (args) => { okCalls.push(args); return { ...okBridge(), healed: [{ name: 'zod', via: 'backup', path: 'x' }] } } },
    })
    assert.equal(stopVersion(version, { sweep: false, workRoot, deps: passing }), true)
    assert.equal(process.exitCode, undefined)
    assert.deepEqual(okCalls[0].hostDirs, [hostDir])
  } finally {
    process.exitCode = previousExitCode
  }
})

test('stopVersion_跨 hostDir 强杀现场:真实 recover 按实际链接目标还原后才报成功', t => {
  // Given keeper 用 --host-dir 指到 workRoot 之外,被强杀后根桥 7 条链与自带备份留在现场;
  // When keep-stop 收尾;Then 必须按 locker 记录的 hostDir 找到并还原,才算完成
  const root = mkdtempSync(join(tmpdir(), 'keep-stop-cross-host-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const repoRoot = join(root, 'repo')
  const workRoot = join(root, '.compat-multimodel')
  const version = '0.2.2-rc.3'
  const workDir = join(workRoot, version)
  const hostDir = join(root, '.compat', version, 'dsh-host')
  mkdirSync(join(repoRoot, 'node_modules'), { recursive: true })
  mkdirSync(workDir, { recursive: true })
  const src = join(hostDir, 'node_modules', 'zod')
  mkdirSync(src, { recursive: true })
  writeFileSync(join(src, 'package.json'), '{"name":"host-zod"}')
  const dst = join(repoRoot, 'node_modules', 'zod')
  mkdirSync(dst, { recursive: true })
  writeFileSync(join(dst, 'package.json'), '{"name":"original-zod"}')
  const backup = `${dst}.compat-bak-1344`
  renameSync(dst, backup)
  symlinkSync(src, dst, process.platform === 'win32' ? 'junction' : 'dir')
  writeFileSync(join(workDir, 'boot-keep.lock'), JSON.stringify({ pid: 555, startedAt: '2026-01-01T00:00:00.000Z', hostDir }))
  writeFileSync(join(repoRoot, 'node_modules', '.compat-bridge.lock'), JSON.stringify({ pid: 999999, startedAt: '2026-01-01T00:00:00.000Z', workRoot, hostDir }))
  const previousExitCode = process.exitCode
  try {
    process.exitCode = undefined
    const deps = fakeDeps({
      alive: false,
      overrides: { collectKeeper: () => ({ targets: [], refused: false }), recoverBridge: undefined, readLock: () => JSON.parse(readFileSync(join(workDir, 'boot-keep.lock'), 'utf8')) },
    })
    assert.equal(stopVersion(version, { sweep: false, workRoot, repoRoot, deps }), true)
    assert.equal(process.exitCode, undefined, '根桥按 hostDir 还原成功后不得非零')
    assert.equal(existsSync(backup), false, '自带备份必须被消费')
    assert.equal(readFileSync(join(dst, 'package.json'), 'utf8'), '{"name":"original-zod"}')
    assert.equal(existsSync(join(repoRoot, 'node_modules', '.compat-bridge.lock')), false, '陈旧根桥锁必须清除')
    assert.equal(existsSync(join(workDir, 'boot-keep.lock')), false)
  } finally {
    process.exitCode = previousExitCode
  }
})

test('stopAll: 没有工位可收尾也要复核根桥,重指未还原即非零', t => {
  const { workRoot } = keeperOnlyFixture(t)
  const previousExitCode = process.exitCode
  const calls = []
  try {
    process.exitCode = undefined
    assert.deepEqual(stopAll({
      versions: [],
      sweep: false,
      workRoot,
      deps: { recoverBridge: (args) => { calls.push(args); return { ...okBridge(), ok: false, pending: ['zod'] } } },
    }).handled, [])
    assert.equal(calls.length, 1)
    assert.equal(process.exitCode, 1)

    process.exitCode = undefined
    assert.deepEqual(stopAll({ versions: [], sweep: false, workRoot, deps: { recoverBridge: okBridge } }).handled, [])
    assert.equal(process.exitCode, undefined)
  } finally {
    process.exitCode = previousExitCode
  }
})

test('stopAll: 版本目录不存在时不计入收尾', t => {
  const { workRoot } = keeperOnlyFixture(t)
  const previousExitCode = process.exitCode
  try {
    process.exitCode = undefined
    const result = stopAll({ versions: ['9.9.9'], sweep: false, workRoot, deps: { recoverBridge: okBridge } })
    assert.deepEqual(result.handled, [])
    assert.equal(process.exitCode, undefined)
  } finally {
    process.exitCode = previousExitCode
  }
})

test('live.json 不可解析:非零且保留文件', t => {
  const { workRoot, version, livePath } = keeperFixture(t)
  const previousExitCode = process.exitCode
  try {
    process.exitCode = undefined
    writeFileSync(livePath, '{半截 json')
    assert.equal(stopVersion(version, { sweep: false, workRoot, deps: fakeDeps({ alive: false }) }), true)
    assert.equal(process.exitCode, 1)
    assert.equal(readFileSync(livePath, 'utf8'), '{半截 json')
  } finally {
    process.exitCode = previousExitCode
  }
})
