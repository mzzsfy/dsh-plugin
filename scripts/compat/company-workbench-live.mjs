// 真实公司管理测试的独立生命周期；禁止复用既有 home 或清理无关端口所有者。
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createServer } from 'node:net'
import { createWriteStream } from 'node:fs'
import { access, mkdir, readFile, writeFile, stat } from 'node:fs/promises'
import { resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

const repository = resolve(import.meta.dirname, '../..')
const version = '0.2.0-rc.2.company-live'
const work = resolve(repository, '.compat', version)
const host = resolve(repository, '.compat/0.2.0-rc.2/dsh-host')
const port = 9382
const readyTimeout = 10 * 60 * 1000
const teardownTimeout = 20 * 1000
const testTimeout = 8 * 60 * 1000
const children = []
const logs = []
let hostPid
let echoPort
let keeper
let tester
let stopping
let signalFailure
const cleanupChecks = []

async function absent(path) {
  try { await access(path) } catch (error) { if (error.code === 'ENOENT') return; throw error }
  throw new Error(`拒绝复用已有隔离目录：${path}；请保留或移走旧证据后重试`)
}
async function freePort(value) {
  const server = createServer()
  await new Promise((done, reject) => {
    server.once('error', reject)
    server.listen(value, '127.0.0.1', done)
  })
  await new Promise((done, reject) => server.close(error => error ? reject(error) : done()))
}
function alive(pid) {
  if (!pid) return false
  try { process.kill(pid, 0); return true } catch (error) { if (error.code === 'ESRCH') return false; throw error }
}
function start(args, logName, options = {}) {
  if (signalFailure || stopping) throw signalFailure ?? new Error('隔离测试正在停止，拒绝启动新进程')
  const log = createWriteStream(resolve(work, logName), { flags: 'wx' })
  logs.push(log)
  const child = spawn(process.execPath, args, {
    cwd: repository, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, DSH_HOME: resolve(work, 'home'), ECHO_KEY: 'echo-compat', ...options.env },
  })
  children.push(child)
  child.stdout.pipe(log, { end: false })
  child.stderr.pipe(log, { end: false })
  // 立即注册退出观察，避免已经退出后才等待而丢失事件。
  child.settled = new Promise((done) => {
    child.once('error', error => done({ error }))
    child.once('exit', (code, signal) => done({ code, signal }))
  })
  child.stdout.on('data', options.onStdout ?? (() => {}))
  if (options.forward) {
    child.stdout.pipe(process.stdout, { end: false })
    child.stderr.pipe(process.stderr, { end: false })
  }
  return child
}
async function waitFor(check, timeout, label) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    if (signalFailure) throw signalFailure
    const result = await check()
    if (signalFailure) throw signalFailure
    if (result) return result
    await delay(250)
  }
  throw new Error(`${label}超时`)
}
async function deadline(promise, timeout, message) {
  let timer
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), timeout)
    })])
  } finally { clearTimeout(timer) }
}
async function killTree(child) {
  if (!child?.pid || !alive(child.pid)) return
  if (process.platform === 'win32') {
    const killer = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'pipe' })
    let detail = ''
    killer.stderr.on('data', chunk => { detail += chunk })
    await new Promise((done, reject) => {
      killer.once('error', reject)
      killer.once('exit', code => code === 0 || !alive(child.pid) ? done() : reject(new Error(`本次进程树清理失败：${detail}`)))
    })
  } else {
    // keeper 的宿主是直接子进程，只停止本次捕获的 PID。
    if (child === keeper && hostPid && alive(hostPid)) process.kill(hostPid, 'SIGKILL')
    child.kill('SIGKILL')
  }
  await deadline(child.settled, teardownTimeout, `进程 ${child.pid} 未结束`)
}
async function stop() {
  if (stopping) return stopping
  stopping = (async () => {
    const errors = []
    // 先停测试，防止其在宿主停场期间继续发送。
    try { await killTree(tester) } catch (error) { errors.push(error) }
    if (keeper?.pid && alive(keeper.pid)) {
      try {
        await writeFile(resolve(work, 'boot-keep.stop'), 'stop\n', { flag: 'wx' })
        await deadline(keeper.settled, teardownTimeout, 'keeper 未按时响应停止标记')
      } catch (error) {
        errors.push(error)
        try { await killTree(keeper) } catch (killError) { errors.push(killError) }
      }
    }
    // 再按本次记录补查宿主，不按端口杀进程。
    if (hostPid && alive(hostPid)) {
      try { process.kill(hostPid, 'SIGKILL') } catch (error) { errors.push(error) }
    }
    for (const child of children.filter(child => child !== tester && child !== keeper)) {
      try { await killTree(child) } catch (error) { errors.push(error) }
    }
    for (let pass = 1; pass <= 2; pass += 1) {
      const pids = [...new Set([...children.map(child => child.pid), hostPid].filter(Boolean))]
      const running = pids.filter(alive)
      const occupied = []
      for (const value of [port, echoPort].filter(Boolean)) {
        try { await freePort(value) } catch (error) { occupied.push({ port: value, error: error.message }) }
      }
      cleanupChecks.push({ pass, pids, running, occupied })
      if (running.length || occupied.length) errors.push(new Error(`清理复查 ${pass} 失败：${JSON.stringify(cleanupChecks.at(-1))}`))
      if (pass === 1) await delay(500)
    }
    await writeFile(resolve(work, 'cleanup.json'), JSON.stringify(cleanupChecks, null, 2), { flag: 'wx' })
    if (errors.length) throw new AggregateError(errors, '隔离测试清理未完全成功')
  })()
  return stopping
}

async function main() {
  // 预检并让 keeper 拒绝后来占用，禁止清理其他会话的工位。
  await absent(work)
  await freePort(port)
  await access(resolve(host, 'node_modules/@deepseek-ai/dsh/lib/bin.js'))
  await mkdir(work)
  const onSignal = (signal) => {
    signalFailure = new Error(`收到 ${signal}，停止本次隔离测试`)
    void stop().catch(error => console.error(error))
  }
  const onInt = () => onSignal('SIGINT')
  const onTerm = () => onSignal('SIGTERM')
  process.once('SIGINT', onInt)
  process.once('SIGTERM', onTerm)
  let failure
  try {
    let output = ''
    const echo = start(['scripts/echo-upstream/cli.mjs', '--port', '0', '--log', resolve(work, 'llm-echo.jsonl')], 'echo.log', {
      onStdout: chunk => { output += chunk; echoPort = Number(output.match(/listening 127\.0\.0\.1:(\d+)/)?.[1]) || undefined },
    })
    await waitFor(async () => {
      if (echo.exitCode !== null) throw new Error(`echo-upstream 早退 ${echo.exitCode}`)
      return echoPort
    }, 20 * 1000, 'echo-upstream 随机端口')
    // 缺省回复让意外自动消息在证据中可识别，且永远不接真实上游。
    const echoReady = await fetch(`http://127.0.0.1:${echoPort}/control/default`, {
      method: 'PUT', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'LIVE_UNEXPECTED_AUTOMATIC_MESSAGE' }), signal: AbortSignal.timeout(5 * 1000),
    })
    assert.equal(echoReady.status, 200)
    await freePort(port)
    keeper = start(['scripts/compat/boot-keep.mjs', '--daemon', '--version', version, '--host-dir', host,
      '--only', 'dsh-boss-simulator,dsh-llm-pi-gateway', '--port', String(port), '--llm-port', String(echoPort),
      '--refuse-port-owner'], 'keeper.log')
    const startedAt = Date.now()
    const live = await waitFor(async () => {
      if (keeper.exitCode !== null) throw new Error(`keeper 早退 ${keeper.exitCode}，检查 keeper.log`)
      let record
      try {
        const metadata = await stat(resolve(work, 'live.json'))
        if (metadata.mtimeMs < startedAt) return false
        record = JSON.parse(await readFile(resolve(work, 'live.json'), 'utf8'))
      } catch (error) { if (error.code === 'ENOENT' || error instanceof SyntaxError) return false; throw error }
      assert.equal(record.port, port)
      assert.equal(resolve(record.homeDir), resolve(work, 'home'))
      assert.deepEqual(record.bundles.slice().sort(), ['@mzzsfy/dsh-boss-simulator', '@mzzsfy/dsh-llm-pi-gateway'].sort())
      assert.ok(Number.isSafeInteger(record.pid) && record.pid > 0)
      hostPid = record.pid
      const response = await fetch(`http://127.0.0.1:${port}/?token=${encodeURIComponent(record.token)}`, { redirect: 'manual', signal: AbortSignal.timeout(3 * 1000) })
      return response.ok || (response.status >= 300 && response.status < 400) ? record : false
    }, readyTimeout, '隔离宿主就绪')
    await writeFile(resolve(work, 'run.json'), JSON.stringify({ version, port, echoPort, keeperPid: keeper.pid, echoPid: echo.pid, hostPid: live.pid, homeDir: live.homeDir }, null, 2), { flag: 'wx' })
    tester = start(['--test', 'packages/dsh-boss-simulator/test/browser/live-workbench.test.mjs'], 'browser.tap', {
      forward: true, env: { DSH_COMPANY_LIVE_WORK: work, DSH_COMPANY_LIVE_ECHO_PORT: String(echoPort), DSH_COMPANY_LIVE_KEEPER_PID: String(keeper.pid) },
    })
    const result = await deadline(tester.settled, testTimeout, '真实浏览器测试超过生命周期上限')
    if (result.error) throw result.error
    assert.equal(result.code, 0, `真实浏览器测试退出 ${result.code} signal=${result.signal}`)
  } catch (error) { failure = error }
  finally {
    try { await stop() } catch (error) { failure = failure ? new AggregateError([failure, error], '测试与清理失败') : error }
    process.removeListener('SIGINT', onInt)
    process.removeListener('SIGTERM', onTerm)
    await Promise.all(logs.map(log => new Promise(done => log.end(done))))
  }
  console.log(`真实测试证据目录：${work}`)
  if (failure) throw failure
}

main().catch(error => { console.error(error); process.exitCode = 1 })
