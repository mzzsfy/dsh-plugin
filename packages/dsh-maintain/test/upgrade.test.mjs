import { test } from 'node:test'
import assert from 'node:assert/strict'
import { rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { runUpgrade } from '../src/upgrade.mjs'
import { runUpgradeWithRetry, judgeAutoRestart, UPGRADE_MAX_ATTEMPTS, UPGRADE_RETRY_BACKOFF_MS } from '../src/index.js'
import {
  UPGRADE_FAIL_FILE_LOCKED,
  UPGRADE_FAIL_TRANSIENT_NETWORK,
  UPGRADE_FAIL_NPM_MISSING,
  UPGRADE_FAIL_TIMEOUT,
} from '../src/core.mjs'
import { RUNTIME_KINDS } from '../src/runtime.mjs'

// 脚本体一律单引号:Windows shell 化 spawn 经 cmd.exe,双层双引号会被截断。
const NODE = 'node'
const OK_SCRIPT = 'process.exit(0)'
const FAIL_SCRIPT = "console.error('boom-fail'); process.exit(3)"
const STDOUT_SCRIPT = "console.log('out-line-1'); console.log('out-line-2')"
const HANG_SCRIPT = 'setTimeout(() => {}, 60 * 1000)'

test('场景:shell 化执行 命令串含连接符与参数可运行', async () => {
  // shell:false 会把整串当可执行文件路径(POSIX 必 ENOENT);此用例锁死 shell 化语义
  const result = await runUpgrade({ command: NODE + ' -e "process.stdout.write(\'chain-ok\')"' + ' && echo done', timeoutMs: 30 * 1000 })
  assert.equal(result.ok, true)
  assert.match(result.stdoutTail, /chain-ok/)
  assert.match(result.stdoutTail, /done/)
})

test('场景:升级命令成功完成', async () => {
  const result = await runUpgrade({ command: NODE + ' -e "' + OK_SCRIPT + '"', timeoutMs: 30 * 1000 })
  assert.equal(result.ok, true)
  assert.equal(result.code, 0)
  assert.equal(result.timedOut, false)
  assert.equal(result.stderrTail, '')
})

test('场景:升级失败可见 非零码与 stderr 摘要', async () => {
  const result = await runUpgrade({ command: NODE + ' -e "' + FAIL_SCRIPT + '"', timeoutMs: 30 * 1000 })
  assert.equal(result.ok, false)
  assert.equal(result.code, 3)
  assert.match(result.stderrTail, /boom-fail/)
})

test('场景:stdout 内容被收集', async () => {
  const result = await runUpgrade({ command: NODE + ' -e "' + STDOUT_SCRIPT + '"', timeoutMs: 30 * 1000 })
  assert.equal(result.ok, true)
  assert.match(result.stdoutTail, /out-line-1/)
  assert.match(result.stdoutTail, /out-line-2/)
})

test('场景:命令超时被强制终止', async () => {
  const startedAt = Date.now()
  const result = await runUpgrade({ command: NODE + ' -e "' + HANG_SCRIPT + '"', timeoutMs: 2 * 1000 })
  assert.equal(result.ok, false)
  assert.equal(result.timedOut, true)
  // 上界收紧为 timeoutMs + 强杀宽限 + 数秒余量,防 killTree 回归被宽 assertion 掩盖
  assert.ok(Date.now() - startedAt < 2 * 1000 + 5 * 1000 + 5 * 1000, '超时后应在强杀宽限内收敛而不是等满挂起时长')
})

test('场景:超长输出截尾保留末尾', async () => {
  const result = await runUpgrade({
    command: NODE + " -e \"console.log(Array(100).fill('x-line-0123456789').join('\\n'))\"",
    timeoutMs: 30 * 1000,
  })
  assert.equal(result.ok, true)
  assert.ok(result.stdoutTail.length <= 2000)
  assert.match(result.stdoutTail, /x-line-0123456789$/)
})

test('场景:命令不存在失败不抛错', async () => {
  const result = await runUpgrade({ command: 'definitely-not-exist-cmd-xyz --version', timeoutMs: 10 * 1000 })
  assert.equal(result.ok, false)
})

// ---- S2 限次重试:尝试循环以注入式执行器单测,退避零等待;末尾附真实假命令端到端 ----

const FILE_LOCKED_FAIL = {
  ok: false,
  code: 1,
  timedOut: false,
  stillRunning: false,
  stdoutTail: '',
  stderrTail: 'npm error code EBUSY\nnpm error syscall rename',
}
const NETWORK_FAIL = {
  ok: false,
  code: 1,
  timedOut: false,
  stillRunning: false,
  stdoutTail: '',
  stderrTail: 'npm error code ECONNRESET',
}
const OK_RESULT = { ok: true, code: 0, timedOut: false, stillRunning: false, stdoutTail: '', stderrTail: '' }

function makeHarness(results) {
  const queue = results.slice()
  const sleeps = []
  let attemptStarts = 0
  return {
    sleeps,
    runImpl: async () => (queue.length > 1 ? queue.shift() : queue[0]),
    sleepImpl: async (ms) => { sleeps.push(ms) },
    onAttemptStart: () => { attemptStarts += 1 },
    get starts() { return attemptStarts },
  }
}

const ATTEMPT_KEYS = ['startedAt', 'finishedAt', 'ok', 'code', 'timedOut', 'kind'].sort()

test('重试:可重试失败按退避序列重试至成功', async () => {
  const harness = makeHarness([FILE_LOCKED_FAIL, NETWORK_FAIL, OK_RESULT])
  const settle = await runUpgradeWithRetry({ command: 'fake', runImpl: harness.runImpl, sleepImpl: harness.sleepImpl, onAttemptStart: harness.onAttemptStart })
  assert.equal(settle.ok, true)
  assert.equal(settle.attempts.length, 3)
  assert.equal(settle.kind, null)
  assert.deepEqual(settle.attempts.map((a) => a.kind), [UPGRADE_FAIL_FILE_LOCKED, UPGRADE_FAIL_TRANSIENT_NETWORK, null])
  // 退避按 kind 取序列对应位:file-locked 首退避、transient-network 次退避
  assert.deepEqual(harness.sleeps, [UPGRADE_RETRY_BACKOFF_MS[UPGRADE_FAIL_FILE_LOCKED][0], UPGRADE_RETRY_BACKOFF_MS[UPGRADE_FAIL_TRANSIENT_NETWORK][1]])
  assert.equal(harness.starts, 2, '首次尝试不经 onAttemptStart,每次重试各触发一次(锁覆写点)')
})

test('重试:尝试条目形态锁定为裁剪后字段集,尾流仅在落定结果上', async () => {
  const harness = makeHarness([FILE_LOCKED_FAIL, OK_RESULT])
  const settle = await runUpgradeWithRetry({ command: 'fake', runImpl: harness.runImpl, sleepImpl: harness.sleepImpl })
  assert.deepEqual(Object.keys(settle.attempts[0]).sort(), ATTEMPT_KEYS)
  assert.equal(settle.attempts[0].code, 1)
  assert.equal(settle.attempts[0].timedOut, false)
  assert.ok(settle.attempts[0].finishedAt >= settle.attempts[0].startedAt)
  // 末次尝试的尾流上浮到落定结果,供 last 直接消费
  assert.equal(settle.stdoutTail, '')
  assert.equal(settle.stderrTail, '')
})

test('重试:不可重试类立即落定,不睡眠不重试', async () => {
  for (const [fail, kind] of [
    [{ ...FILE_LOCKED_FAIL, stderrTail: 'spawn npmm ENOENT' }, UPGRADE_FAIL_NPM_MISSING],
    [{ ok: false, code: null, timedOut: true, stillRunning: false, stdoutTail: '', stderrTail: '' }, UPGRADE_FAIL_TIMEOUT],
    [{ ok: false, code: 3, timedOut: false, stillRunning: false, stdoutTail: '', stderrTail: 'boom-fail' }, 'unknown'],
  ]) {
    const harness = makeHarness([fail])
    const settle = await runUpgradeWithRetry({ command: 'fake', runImpl: harness.runImpl, sleepImpl: harness.sleepImpl })
    assert.equal(settle.ok, false)
    assert.equal(settle.kind, kind, JSON.stringify(fail))
    assert.equal(settle.attempts.length, 1, JSON.stringify(fail))
    assert.deepEqual(harness.sleeps, [], JSON.stringify(fail))
  }
})

test('重试:持续可重试失败收敛于次数上限,末次不安排退避', async () => {
  const harness = makeHarness([NETWORK_FAIL])
  const settle = await runUpgradeWithRetry({ command: 'fake', runImpl: harness.runImpl, sleepImpl: harness.sleepImpl })
  assert.equal(settle.ok, false)
  assert.equal(settle.kind, UPGRADE_FAIL_TRANSIENT_NETWORK)
  assert.equal(settle.attempts.length, UPGRADE_MAX_ATTEMPTS)
  assert.equal(harness.sleeps.length, UPGRADE_MAX_ATTEMPTS - 1, '末次尝试后不得再安排退避')
  assert.equal(settle.attempts.every((a) => a.kind === UPGRADE_FAIL_TRANSIENT_NETWORK), true)
})

test('重试:退避序列缺失按不可重试落定,不得零间隔轰击', async () => {
  // 注入空退避表模拟"可重试分类缺少序列"的配置缺口:宁可不重试,不可无间隔重试
  const warns = []
  const originalWarn = console.warn
  console.warn = (text) => { warns.push(String(text)) }
  try {
    const harness = makeHarness([FILE_LOCKED_FAIL])
    const settle = await runUpgradeWithRetry({ command: 'fake', backoff: {}, runImpl: harness.runImpl, sleepImpl: harness.sleepImpl })
    assert.equal(settle.ok, false)
    assert.equal(settle.kind, UPGRADE_FAIL_FILE_LOCKED)
    assert.equal(settle.attempts.length, 1, '序列缺失不得进入下一轮尝试')
    assert.deepEqual(harness.sleeps, [], '序列缺失不得安排退避')
    assert.equal(warns.some((text) => text.includes('退避')), true, '序列缺失必须留痕')
  } finally {
    console.warn = originalWarn
  }
})

test('重试:执行器抛错收敛为失败落定不重试', async () => {
  const settle = await runUpgradeWithRetry({
    command: 'fake',
    runImpl: async () => { throw new Error('spawn exploded') },
    sleepImpl: async () => {},
  })
  assert.equal(settle.ok, false)
  assert.equal(settle.error, 'spawn exploded')
  assert.equal(settle.attempts.length, 1)
})

test('重试:常量形态为计算式导出', () => {
  assert.equal(UPGRADE_MAX_ATTEMPTS, 3)
  assert.deepEqual(UPGRADE_RETRY_BACKOFF_MS[UPGRADE_FAIL_FILE_LOCKED], [5 * 1000, 15 * 1000])
  assert.deepEqual(UPGRADE_RETRY_BACKOFF_MS[UPGRADE_FAIL_TRANSIENT_NETWORK], [3 * 1000, 9 * 1000])
})

test('重试:假命令真实进程 文件锁失败后重试成功', async () => {
  const statePath = join(tmpdir(), 'dsh-maintain-retry-test-' + process.pid + '.flag')
  rmSync(statePath, { force: true })
  process.env.DSH_MAINTAIN_TEST_RETRY_STATE = statePath
  try {
    const script = "const fs=require('fs');const p=process.env.DSH_MAINTAIN_TEST_RETRY_STATE;if(fs.existsSync(p)){process.exit(0)}fs.writeFileSync(p,'1');console.error('npm error code EBUSY');console.error('npm error syscall rename');process.exit(1)"
    let attemptStarts = 0
    const settle = await runUpgradeWithRetry({
      command: NODE + ' -e "' + script + '"',
      runImpl: (opts) => runUpgrade(opts),
      sleepImpl: async () => {},
      onAttemptStart: () => { attemptStarts += 1 },
    })
    assert.equal(settle.ok, true)
    assert.equal(settle.attempts.length, 2)
    assert.equal(settle.attempts[0].ok, false)
    assert.equal(settle.attempts[0].kind, UPGRADE_FAIL_FILE_LOCKED, '真实进程 stderr 应命中文件锁特征: ' + settle.attempts[0].stderrTail)
    assert.equal(settle.attempts[1].ok, true)
    assert.equal(settle.attempts[1].kind, null)
    assert.equal(attemptStarts, 1, '仅重试尝试覆写锁')
  } finally {
    rmSync(statePath, { force: true })
  }
})

test('自动重启:四条件守卫(成功/非手动直跑/enabled/appExit 可用)', () => {
  // 成功+托管(含 unknown)+enabled=true → 调度
  assert.deepEqual(judgeAutoRestart({ ok: true, runtimeKind: RUNTIME_KINDS.UNKNOWN, hasExit: true, enabled: true }), { schedule: true, requiresManualRestart: false })
  assert.deepEqual(judgeAutoRestart({ ok: true, runtimeKind: RUNTIME_KINDS.DECLARED_MANAGED, hasExit: true, enabled: true }), { schedule: true, requiresManualRestart: false })
  assert.deepEqual(judgeAutoRestart({ ok: true, runtimeKind: RUNTIME_KINDS.PM2, hasExit: true, enabled: true }), { schedule: true, requiresManualRestart: false })
  // 失败不调度
  assert.deepEqual(judgeAutoRestart({ ok: false, runtimeKind: RUNTIME_KINDS.UNKNOWN, hasExit: true, enabled: true }), { schedule: false, requiresManualRestart: false })
  // 手动直跑 → 手动指引,不调度
  assert.deepEqual(judgeAutoRestart({ ok: true, runtimeKind: RUNTIME_KINDS.MANUAL_START, hasExit: true, enabled: true }), { schedule: false, requiresManualRestart: true })
  // appExit 缺失不调度
  assert.deepEqual(judgeAutoRestart({ ok: true, runtimeKind: RUNTIME_KINDS.UNKNOWN, hasExit: false, enabled: true }), { schedule: false, requiresManualRestart: false })
  // 手动直跑与 appExit 缺失并存 → 仍以手动指引标记(指引面板,与退出能力无关)
  assert.deepEqual(judgeAutoRestart({ ok: true, runtimeKind: RUNTIME_KINDS.MANUAL_START, hasExit: false, enabled: true }), { schedule: false, requiresManualRestart: true })
})

test('自动重启:enabled 严格 boolean,仅 true 调度', () => {
  // 显式 false:托管(含 unknown)不调度、不标手动指引
  assert.deepEqual(judgeAutoRestart({ ok: true, runtimeKind: RUNTIME_KINDS.UNKNOWN, hasExit: true, enabled: false }), { schedule: false, requiresManualRestart: false })
  assert.deepEqual(judgeAutoRestart({ ok: true, runtimeKind: RUNTIME_KINDS.DECLARED_MANAGED, hasExit: true, enabled: false }), { schedule: false, requiresManualRestart: false })
  // 手动直跑指引是环境约束事实,不受勾选影响
  assert.deepEqual(judgeAutoRestart({ ok: true, runtimeKind: RUNTIME_KINDS.MANUAL_START, hasExit: true, enabled: false }), { schedule: false, requiresManualRestart: true })
  // 非 true 一律不调度:调用点经升级路由严格 boolean 校验,此处锁定纯函数自身契约
  assert.deepEqual(judgeAutoRestart({ ok: true, runtimeKind: RUNTIME_KINDS.UNKNOWN, hasExit: true, enabled: undefined }), { schedule: false, requiresManualRestart: false })
  assert.deepEqual(judgeAutoRestart({ ok: true, runtimeKind: RUNTIME_KINDS.UNKNOWN, hasExit: true, enabled: null }), { schedule: false, requiresManualRestart: false })
  assert.deepEqual(judgeAutoRestart({ ok: true, runtimeKind: RUNTIME_KINDS.UNKNOWN, hasExit: true, enabled: 'true' }), { schedule: false, requiresManualRestart: false })
})
