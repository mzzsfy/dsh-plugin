import test from 'node:test'
import assert from 'node:assert/strict'
import {
  collectHostPlan,
  collectSimulatorPlan,
  isSimulatorPortCommandLine,
  planHostCleanup,
  planKeeperCleanup,
  planSimulatorCleanup,
  processStartTime,
  terminateTargets,
} from '../scripts/compat/simulator-cleanup.mjs'

/**
 * B6 keep-stop 模拟器清理:目标选择与终止执行分离
 *
 * BDD 场景:
 *   1. 目标选择 —— simulatorPid 精确优先,不看进程表、不受 --sweep 影响
 *   2. 缺 pid —— 按 simulatorPort 匹配命令行端口;动态端口(--port 0)由监听属主兜底,
 *      监听属主命令行不是模拟器时拒绝采信(防端口复用误杀)
 *   3. 两者都缺 —— 默认只警告不扫全机;显式 --sweep 才全机扫描且排除自身
 *   4. 终止执行 —— 以进程实际消失为成功判据(命令非零但进程已退出算成功),
 *      仍存活/spawn 抛错计入 failures
 */

const simulatorLine = (extra = '') => `node C:\\repo\\scripts\\echo-upstream\\cli.mjs --port 0 --log C:\\work\\llm-echo.jsonl${extra}`

test('命令行端口匹配锚定整数端口', () => {
  assert.equal(isSimulatorPortCommandLine('node cli.mjs --port 4321 --log x', 4321), true)
  assert.equal(isSimulatorPortCommandLine('node cli.mjs --port=4321', 4321), true)
  assert.equal(isSimulatorPortCommandLine('node cli.mjs --port 43210', 4321), false)
  assert.equal(isSimulatorPortCommandLine('node cli.mjs --port 432', 4321), false)
  assert.equal(isSimulatorPortCommandLine(undefined, 4321), false)
})

test('live.json 有 simulatorPid 时只精确终止该 pid', () => {
  const startedAt = 1_700_000_000_000
  const plan = planSimulatorCleanup(
    { simulatorPid: 4242, simulatorPort: 5000, simulatorStartedAt: startedAt },
    { sweep: true, startTime: startedAt + 500, commandLine: simulatorLine() },
  )
  assert.equal(plan.mode, 'pid')
  assert.deepEqual(plan.targets, [{ pid: 4242, via: 'simulatorPid' }])
  assert.equal(plan.warning, null)
})

test('simulatorPid 启动时间不匹配时拒绝终止(pid 复用)', () => {
  const plan = planSimulatorCleanup(
    { simulatorPid: 4242, simulatorStartedAt: 1_700_000_000_000 },
    { startTime: 1_700_000_000_000 + 20 * 60 * 1000 },
  )
  assert.deepEqual(plan.targets, [])
  assert.equal(plan.refused, true)
  assert.match(plan.warning, /启动时间不匹配/)
})

test('simulatorPid 缺启动时间记录时拒绝终止(旧 live.json 不可校验)', () => {
  const plan = planSimulatorCleanup({ simulatorPid: 4242 }, { startTime: 1_700_000_000_000 })
  assert.deepEqual(plan.targets, [])
  assert.equal(plan.refused, true)
  assert.match(plan.warning, /缺 simulatorStartedAt/)
})

test('宿主目标:启动时间与命令行同时匹配才终止;进程已退出视为达成', () => {
  const startedAt = 1_700_000_000_000
  const live = { pid: 77, port: 9297, hostStartedAt: startedAt }
  const matched = planHostCleanup(live, {
    startTime: startedAt - 200,
    commandLine: 'node C:\\dsh\\lib\\bin.js web --no-open --port 9297',
  })
  assert.deepEqual(matched.targets, [{ pid: 77, via: 'host' }])
  const exited = planHostCleanup(live, { startTime: null })
  assert.deepEqual(exited.targets, [])
  assert.equal(exited.refused, false)
  const reused = planHostCleanup(live, { startTime: startedAt + 20 * 60 * 1000 })
  assert.equal(reused.refused, true)
  const wrongCommand = planHostCleanup(live, {
    startTime: startedAt,
    commandLine: 'node C:\\other\\server.js --port 9297',
  })
  assert.deepEqual(wrongCommand.targets, [])
  assert.equal(wrongCommand.refused, true)
  assert.match(wrongCommand.warning, /命令行不匹配/)
})

test('缺 pid 时按 simulatorPort 匹配命令行端口', () => {
  const plan = planSimulatorCleanup(
    { simulatorPort: 5000 },
    {
      processes: [
        { pid: 111, commandLine: 'node scripts/echo-upstream/cli.mjs --port 5000' },
        { pid: 222, commandLine: 'node scripts/echo-upstream/cli.mjs --port 0' },
        { pid: 333, commandLine: 'node scripts/compat/run.mjs --port 5000' },
      ],
    },
  )
  assert.equal(plan.mode, 'port')
  assert.deepEqual(plan.targets, [{ pid: 111, via: 'simulatorPort' }])
})

test('动态端口(--port 0)由监听属主定位', () => {
  const plan = planSimulatorCleanup(
    { simulatorPort: 54321 },
    { processes: [{ pid: 222, commandLine: simulatorLine() }], portOwners: [222] },
  )
  assert.equal(plan.mode, 'port')
  assert.deepEqual(plan.targets, [{ pid: 222, via: 'simulatorPort' }])
})

test('监听属主命令行不是模拟器时拒绝采信,只警告不终止', () => {
  const plan = planSimulatorCleanup(
    { simulatorPort: 3000 },
    { processes: [{ pid: 999, commandLine: 'node C:\\other\\server.mjs' }], portOwners: [999] },
  )
  assert.deepEqual(plan.targets, [])
  assert.match(plan.warning, /未匹配/)
})

test('两者都缺时默认不扫全机;显式 --sweep 才扫描且排除自身', () => {
  const processes = [
    { pid: process.pid, commandLine: simulatorLine() },
    { pid: 111, commandLine: simulatorLine() },
    { pid: 333, commandLine: 'node scripts/compat/run.mjs' },
  ]
  const skipped = planSimulatorCleanup({}, { processes })
  assert.equal(skipped.mode, 'sweep-skipped')
  assert.deepEqual(skipped.targets, [])
  assert.match(skipped.warning, /--sweep/)

  const swept = planSimulatorCleanup({}, { sweep: true, processes })
  assert.equal(swept.mode, 'sweep')
  assert.deepEqual(swept.targets, [{ pid: 111, via: 'sweep' }])
})

test('collectSimulatorPlan:有 pid 时只按该 pid 查一次进程表,不扫监听', () => {
  let called = 0
  const startedAt = 1_700_000_000_000
  const plan = collectSimulatorPlan(
    { simulatorPid: 42, simulatorStartedAt: startedAt },
    {
      listProcesses: () => { called++; return [{ pid: 42, commandLine: simulatorLine() }] },
      listOwners: () => { called++; return [] },
      startTimeOf: () => startedAt,
    },
  )
  assert.deepEqual(plan.targets, [{ pid: 42, via: 'simulatorPid' }])
  assert.equal(called, 1)

  let queriedPort = null
  collectSimulatorPlan(
    { simulatorPort: 5000 },
    { listProcesses: () => [], listOwners: (port) => { queriedPort = port; return [] } },
  )
  assert.equal(queriedPort, 5000)
})

test('processStartTime:非法 pid 不查询', () => {
  let called = 0
  const result = processStartTime(Number.NaN, { spawn: () => { called++; return { status: 0 } } })
  assert.equal(result, null)
  assert.equal(called, 0)
})

test('collectHostPlan:按单 pid 查询启动时间,并用进程表命令行二次校验', () => {
  let queried = null
  const plan = collectHostPlan(
    { pid: 88, port: 9297, hostStartedAt: 1_700_000_000_000 },
    {
      startTimeOf: (pid) => { queried = pid; return 1_700_000_000_500 },
      listProcesses: () => [{ pid: 88, commandLine: 'node C:\\dsh\\lib\\bin.js web --port 9297' }],
    },
  )
  assert.equal(queried, 88)
  assert.deepEqual(plan.targets, [{ pid: 88, via: 'host' }])
})

test('旧 live.json 无启动时间但进程已退出时视为已达成,不阻塞清理', () => {
  const plan = collectHostPlan({ pid: 90, port: 9297 }, { startTimeOf: () => null, listProcesses: () => [] })
  assert.deepEqual(plan.targets, [])
  assert.equal(plan.refused, false)
})

test('终止命令按平台选择 taskkill / kill', () => {
  const calls = []
  const spawn = (...args) => { calls.push(args); return { status: 0 } }
  terminateTargets([{ pid: 11, via: 'simulatorPid' }], { platform: 'win32', spawn, isAlive: () => false })
  terminateTargets([{ pid: 12, via: 'sweep' }], { platform: 'linux', spawn, isAlive: () => false })
  assert.deepEqual(calls[0].slice(0, 2), ['taskkill', ['/PID', '11', '/T', '/F']])
  assert.deepEqual(calls[1].slice(0, 2), ['kill', ['-9', '12']])
})

test('终止执行:命令非零但进程已消失算达成', () => {
  const result = terminateTargets([{ pid: 111, via: 'simulatorPid' }], {
    spawn: () => ({ status: 1, stderr: 'not found' }),
    isAlive: () => false,
  })
  assert.equal(result.ok, true)
  assert.deepEqual(result.killed, [{ pid: 111, via: 'simulatorPid' }])
  assert.deepEqual(result.failures, [])
})

test('终止执行失败面:仍存活计入 failures 并带命令细节', () => {
  const alive = terminateTargets([{ pid: 111, via: 'simulatorPid' }], {
    spawn: () => ({ status: 1, stderr: 'access denied' }),
    isAlive: () => true,
    exitPoll: { attempts: 1, intervalMs: 0 },
  })
  assert.equal(alive.ok, false)
  assert.equal(alive.failures[0].pid, 111)
  assert.equal(alive.failures[0].via, 'simulatorPid')
  assert.match(alive.failures[0].detail, /access denied/)

  const thrown = terminateTargets([{ pid: 7, via: 'sweep' }], {
    spawn: () => { throw new Error('spawn denied') },
    isAlive: () => true,
    exitPoll: { attempts: 1, intervalMs: 0 },
  })
  assert.match(thrown.failures[0].detail, /spawn denied/)

  const silent = terminateTargets([{ pid: 7, via: 'sweep' }], {
    spawn: () => ({ status: 0 }),
    isAlive: () => true,
    exitPoll: { attempts: 1, intervalMs: 0 },
  })
  assert.match(silent.failures[0].detail, /仍存活/)
})

test('终止执行:进程表延迟消失时有界轮询确认,不误判失败', () => {
  let probes = 0
  const result = terminateTargets([{ pid: 55, via: 'simulatorPid' }], {
    spawn: () => ({ status: 0 }),
    isAlive: () => (++probes < 3),
    exitPoll: { attempts: 5, intervalMs: 0 },
  })
  assert.equal(result.ok, true)
  assert.equal(probes, 3)
})

test('非法 pid 目标直接判失败,不下发终止命令', () => {
  let called = 0
  const result = terminateTargets([{ pid: Number.NaN, via: 'host' }], {
    spawn: () => { called++; return { status: 0 } },
    isAlive: () => false,
    exitPoll: { attempts: 1, intervalMs: 0 },
  })
  assert.equal(called, 0)
  assert.equal(result.ok, false)
  assert.match(result.failures[0].detail, /非法 pid/)
})

test('keeper 目标必须核对启动时间与 boot-keep 命令行,防 pid 复用误杀', () => {
  const live = { keeperPid: 4242, keeperStartedAt: 1_000_000 }
  assert.deepEqual(planKeeperCleanup(live, { startTime: null }).targets, [])
  assert.equal(planKeeperCleanup(live, { startTime: null }).refused, false)
  const mismatch = planKeeperCleanup(live, { startTime: 1_000_000, commandLine: 'node unrelated.js' })
  assert.equal(mismatch.refused, true)
  assert.deepEqual(mismatch.targets, [])
  const stale = planKeeperCleanup(live, { startTime: 1_000_000 + 11 * 60 * 1000, commandLine: 'node scripts/compat/boot-keep.mjs --daemon' })
  assert.equal(stale.refused, true)
  const ok = planKeeperCleanup(live, { startTime: 1_000_000, commandLine: 'node scripts/compat/boot-keep.mjs --daemon' })
  assert.deepEqual(ok.targets, [{ pid: 4242, via: 'keeper' }])
})
