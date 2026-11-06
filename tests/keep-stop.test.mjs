import test from 'node:test'
import assert from 'node:assert/strict'
import { judgeVersionCleanup, parseKeepStopArgs } from '../scripts/compat/keep-stop.mjs'

/**
 * B6 keep-stop 收尾契约:参数分流 + 失败不静默
 *
 * BDD 场景:
 *   1. 参数 —— 版本列表与 --sweep 分离,未知选项报错
 *   2. 收尾判定 —— 宿主与模拟器目标任一未终止即失败(调用方据此置 exitCode 1
 *      且保留 live.json 供重试);全部终止或无目标才算成功
 */

const okResult = { ok: true, killed: [{ pid: 1, via: 'host' }], failures: [] }

test('参数:版本列表与 --sweep 分离,未知选项报错', () => {
  assert.deepEqual(parseKeepStopArgs([]), { versions: [], sweep: false })
  assert.deepEqual(parseKeepStopArgs(['--sweep', '0.2.0-rc.1', '0.1.5']), { versions: ['0.2.0-rc.1', '0.1.5'], sweep: true })
  assert.deepEqual(parseKeepStopArgs(['0.1.5', '--sweep']), { versions: ['0.1.5'], sweep: true })
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
