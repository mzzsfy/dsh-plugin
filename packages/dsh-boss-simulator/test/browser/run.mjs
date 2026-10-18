// 真实宿主浏览器测试的单次生命周期，所有工件只落隔离目录。
import { spawn } from 'node:child_process'
import { createWriteStream } from 'node:fs'
import { readFile, writeFile, stat, mkdir, rm } from 'node:fs/promises'
import { resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

const repository = resolve(import.meta.dirname, '../../../..')
const work = resolve(repository, '.compat/0.2.0-rc.2.aitk')
const port = 9381
const startedAt = Date.now()
const readinessMs = 10 * 60 * 1000
const teardownMs = 20 * 1000
const lifetimeMs = 20 * 60 * 1000
await mkdir(work, { recursive: true })
const artifact = resolve(work, 'frontend-browser.tap')
// 上次运行的停止标记必须清场:keeper 启动即见标记会立刻自杀,表现为"早退 0"
await rm(resolve(work, 'boot-keep.stop'), { force: true })
const log = createWriteStream(artifact)
const keeper = spawn(process.execPath, [
  'scripts/compat/boot-keep.mjs', '--daemon', '--version', '0.2.0-rc.2.aitk',
  '--host-dir', resolve(repository, '.compat/0.2.0-rc.2/dsh-host'),
  '--only', 'dsh-boss-simulator,dsh-llm-pi-gateway', '--port', String(port), '--llm-port', '18129',
], { cwd: repository, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
keeper.stdout.pipe(log, { end: false })
keeper.stderr.pipe(log, { end: false })
let testProcess
let stopping = false
const keeperExit = new Promise((done) => { keeper.once('exit', (code) => done(code)); keeper.once('error', done) })
// 生命周期看门狗只护测试阶段:profile 重建(pnpm install 分钟级)不算超时,武装点在测试进程启动后
let watchdog
const armWatchdog = () => { watchdog = setTimeout(() => { testProcess?.kill(); stop().finally(() => { process.exitCode = 1 }) }, lifetimeMs) }
async function stop() {
  if (stopping) return keeperExit
  stopping = true
  if (keeper.exitCode !== null) return
  await writeFile(resolve(work, 'boot-keep.stop'), 'stop\n')
  let timeout
  await Promise.race([keeperExit, new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error('隔离宿主未按时停场')), teardownMs) })]).finally(() => clearTimeout(timeout))
}
let failure
try {
  const deadline = startedAt + readinessMs
  let ready = false
  while (Date.now() < deadline) {
    if (keeper.exitCode !== null) throw new Error(`隔离keeper早退 ${keeper.exitCode}`)
    try {
      const metadata = await stat(resolve(work, 'live.json'))
      const live = JSON.parse(await readFile(resolve(work, 'live.json'), 'utf8'))
      if (metadata.mtimeMs >= startedAt && live.port === port && resolve(live.homeDir) === resolve(work, 'home')) {
        const response = await fetch(`http://127.0.0.1:${port}/?token=${encodeURIComponent(live.token)}`, { redirect: 'manual', signal: AbortSignal.timeout(3 * 1000) })
        if (response.ok || (response.status >= 300 && response.status < 400)) { ready = true; break }
      }
    } catch { /* 等待本次启动，不采用旧live记录 */ }
    await delay(1000)
  }
  if (!ready) throw new Error('隔离宿主就绪超时')
  armWatchdog()
  // 测试输出直通本进程 stdout:TAP 管道转发在 Windows 下有静默丢流风险,直通即所见即所得
  testProcess = spawn(process.execPath, ['--test', ...process.argv.slice(2), 'packages/dsh-boss-simulator/test/browser/filled.test.mjs'], { cwd: repository, stdio: ['ignore', 'inherit', 'inherit'], windowsHide: true })
  const code = await new Promise((done, reject) => { testProcess.once('exit', done); testProcess.once('error', reject) })
  if (code !== 0) throw new Error(`浏览器测试退出 ${code}`)
} catch (error) { failure = error }
finally {
  clearTimeout(watchdog)
  try { await stop() } catch (error) { failure ??= error }
  await new Promise((done) => log.end(done))
}
if (failure) { console.error(failure.message); process.exitCode = 1 }
console.log(`浏览器测试留档：${artifact}`)
