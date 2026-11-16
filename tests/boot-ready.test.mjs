import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { KeeperStop, awaitEchoReady, awaitHostReady, stopRequestedBy, tokenFromLog } from '../scripts/compat/boot-ready.mjs'

/**
 * B8 宿主启动等待:STOP 标记必须在轮询层被消费
 *
 * BDD 场景:
 *   1. token 提取 —— 取 boot 日志最后一条;日志缺失不算 token
 *   2. 停标记判定 —— STOP 文件或终止信号任一命中即停
 *   3. 就绪 —— token + 探活通过才交接;探活失败继续轮询
 *   4. STOP —— boot 未就绪/探活往返期间到达,必须在 KEEPER_STOP_TIMEOUT_MS 之前抛
 *      KeeperStop(否则 keep-stop 会强杀 keeper,跳过 finally 的根桥还原)
 *   5. 其他终止态 —— 宿主早退、超时、echo 未就绪都是独立错误,不得被当成 STOP
 */

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'boot-ready-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return { dir, stopFlag: join(dir, 'boot-keep.stop'), bootLogPath: join(dir, 'boot-l3.log') }
}

const fakeChild = (exitCode = null) => ({ exitCode })
const clockOf = (step) => { let now = 0; return () => (now += step) }

test('token 提取:取 boot 日志最后一条,日志缺失不算 token', (t) => {
  const { bootLogPath } = fixture(t)
  assert.equal(tokenFromLog(bootLogPath), null)
  writeFileSync(bootLogPath, 'listening token=abc123\n登录 token=def456\n')
  assert.equal(tokenFromLog(bootLogPath), 'def456')
})

test('停标记判定:STOP 文件或终止信号任一命中即停', (t) => {
  const { stopFlag } = fixture(t)
  assert.equal(stopRequestedBy({ stopFlag, signalRequested: () => false }), false)
  assert.equal(stopRequestedBy({ stopFlag, signalRequested: () => true }), true)
  writeFileSync(stopFlag, 'stop')
  assert.equal(stopRequestedBy({ stopFlag, signalRequested: () => false }), true)
})

test('就绪:token 到位且探活通过即返回,探活失败继续轮询', async (t) => {
  const { bootLogPath, stopFlag } = fixture(t)
  writeFileSync(bootLogPath, 'token=abc123\n')
  const probes = []
  let clock = 0
  const token = await awaitHostReady({
    child: fakeChild(),
    base: 'http://127.0.0.1:9296',
    bootLogPath,
    stopFlag,
    now: () => (clock += 100),
    sleep: async () => {},
    probe: async (_base, probed) => { probes.push(probed); return probes.length >= 3 },
  })
  assert.equal(token, 'abc123')
  assert.equal(probes.length, 3, '探活未通过时必须继续轮询')
})

test('STOP:轮询期间落盘即抛 KeeperStop,远早于 boot 超时', async (t) => {
  // Given 宿主一直未就绪;When keep-stop 落 STOP;Then 必须立刻中止启动而不是等满 150s
  const { bootLogPath, stopFlag } = fixture(t)
  let clock = 0
  let polls = 0
  await assert.rejects(awaitHostReady({
    child: fakeChild(),
    base: 'http://127.0.0.1:9296',
    bootLogPath,
    stopFlag,
    timeoutMs: 150_000,
    now: () => (clock += 1000),
    // 第 2 次轮询前落 STOP(keep-stop 只等 15s 就强杀)
    sleep: async () => { polls += 1; if (polls === 2) writeFileSync(stopFlag, 'stop') },
    probe: async () => false,
  }), (error) => {
    assert.ok(error instanceof KeeperStop, `应抛 KeeperStop,实际 ${error.name}`)
    assert.match(error.message, /STOP/)
    return true
  })
  assert.equal(polls, 2)
  assert.ok(clock < 15_000, `中止时刻 ${clock}ms 必须早于 keep-stop 的强杀窗口`)
})

test('STOP:终止信号同样即时中止', async (t) => {
  const { bootLogPath, stopFlag } = fixture(t)
  let polls = 0
  await assert.rejects(awaitHostReady({
    child: fakeChild(),
    base: 'http://127.0.0.1:9296',
    bootLogPath,
    stopFlag,
    now: clockOf(1000),
    sleep: async () => { polls += 1 },
    signalRequested: () => polls >= 1,
    probe: async () => false,
  }), (error) => {
    assert.ok(error instanceof KeeperStop)
    return true
  })
  assert.equal(polls, 1)
})

test('STOP:探活成功但往返期间收到 STOP 也不得交接', async (t) => {
  // Given 探活刚返回 true;When STOP 在往返期间落盘;Then 不得写 live.json 式交接
  const { bootLogPath, stopFlag } = fixture(t)
  writeFileSync(bootLogPath, 'token=abc123\n')
  await assert.rejects(awaitHostReady({
    child: fakeChild(),
    base: 'http://127.0.0.1:9296',
    bootLogPath,
    stopFlag,
    now: clockOf(100),
    sleep: async () => {},
    probe: async () => { writeFileSync(stopFlag, 'stop'); return true },
  }), (error) => {
    assert.ok(error instanceof KeeperStop)
    return true
  })
})

test('宿主早退:错误带退出码与日志路径,不按 STOP 处理', async (t) => {
  const { bootLogPath, stopFlag } = fixture(t)
  await assert.rejects(awaitHostReady({
    child: fakeChild(3),
    base: 'http://127.0.0.1:9296',
    bootLogPath,
    stopFlag,
    now: clockOf(100),
    sleep: async () => {},
    probe: async () => true,
  }), (error) => {
    assert.ok(!(error instanceof KeeperStop))
    assert.match(error.message, /宿主早退 code=3/)
    assert.ok(error.message.includes(bootLogPath))
    return true
  })
})

test('超时:未就绪时抛 boot 超时,不按 STOP 处理', async (t) => {
  const { bootLogPath, stopFlag } = fixture(t)
  await assert.rejects(awaitHostReady({
    child: fakeChild(),
    base: 'http://127.0.0.1:9296',
    bootLogPath,
    stopFlag,
    timeoutMs: 5000,
    now: clockOf(1500),
    sleep: async () => {},
    probe: async () => false,
  }), (error) => {
    assert.ok(!(error instanceof KeeperStop))
    assert.match(error.message, /boot 超时未就绪/)
    return true
  })
})

test('echo 探活:STOP 优先于未就绪,就绪后返回', async (t) => {
  const { stopFlag } = fixture(t)
  await assert.rejects(awaitEchoReady(18123, {
    stopFlag,
    now: clockOf(1000),
    sleep: async () => {},
    probe: async () => false,
  }), (error) => {
    assert.ok(!(error instanceof KeeperStop), '未就绪本身不是 STOP')
    assert.match(error.message, /echo 未就绪/)
    return true
  })

  writeFileSync(stopFlag, 'stop')
  await assert.rejects(awaitEchoReady(18123, {
    stopFlag,
    now: clockOf(1000),
    sleep: async () => {},
    probe: async () => false,
  }), (error) => {
    assert.ok(error instanceof KeeperStop, 'STOP 必须优先命中')
    return true
  })

  rmSync(stopFlag, { force: true })
  const logs = []
  let polls = 0
  await awaitEchoReady(18123, {
    now: clockOf(1000),
    sleep: async () => {},
    probe: async () => { polls += 1; return polls === 2 },
    logFn: (line) => logs.push(line),
  })
  assert.equal(polls, 2)
  assert.ok(logs.some((line) => line.includes('echo 就绪')))
  assert.equal(existsSync(stopFlag), false)
})

test('boot-keep 接线:两处等待都必须带 STOP 依赖,KeeperStop 不算失败', () => {
  // 轮询语义在 boot-ready.mjs,但"是否把 STOP 交进去"只在调用点。此处钉住接线,
  // 防止回退成只查 stopRequested 信号的老实现(keep-stop 会在 15s 后强杀)。
  const source = readFileSync(fileURLToPath(new URL('../scripts/compat/boot-keep.mjs', import.meta.url)), 'utf8')
  assert.match(source, /const stopDeps = \{ stopFlag, signalRequested: \(\) => stopRequested \}/)
  assert.match(source, /awaitHostReady\(\{[\s\S]{0,400}?\.\.\.stopDeps/)
  assert.match(source, /awaitEchoReady\([^)]*stopDeps\)/)
  assert.match(source, /if \(error instanceof KeeperStop \|\| error\?\.code === 'STOPPED'\)/)
  assert.match(source, /stop: \(\) => stopRequestedBy\(\{ stopFlag, signalRequested: \(\) => stopRequested \}\)/, 'buildProfile 必须消费 STOP(安装阶段可中止)')
  assert.match(source, /profile = await ensureProfile\(\)/, 'profile 构建必须在 try/finally 内,STOP 才能走正常收尾')
  assert.doesNotMatch(source, /while \(Date\.now\(\) < deadline && !stopRequested\)/, '不得保留不认 STOP 文件的旧轮询')
  assert.doesNotMatch(source, /const BOOT_TIMEOUT_MS = /, '超时口径归 boot-ready.mjs,避免两处漂移')
})
