import { mkdir, mkdtemp, rm, readFile, stat, chmod } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve, dirname, delimiter } from 'node:path'
import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { createLayout, readSelectedVersion } from '../src/managed-layout.mjs'
import { compareSemver, parseSemver } from '../src/core.mjs'
import { performManagedUpgrade, findNpmCli } from '../src/managed-upgrade.mjs'

// 受管升级隔离冒烟:临时 npm global prefix 内完成 安装→候选验证→切换→失败轮。
// 仅验证 CLI 编排链路,不启动宿主 profile,不代表候选宿主健康验收;需显式手动执行(真实联网 npm 安装)。
const [oldVersion, nextVersion] = process.argv.slice(2)
if (!oldVersion || !nextVersion || !parseSemver(oldVersion) || !parseSemver(nextVersion)) {
  throw new Error('参数必须为合法semver: <oldVersion> <nextVersion>')
}
const target = '@deepseek-ai/dsh'
const assert = (condition, message) => { if (!condition) throw new Error('验收失败: ' + message) }
// 失败轮目标:两版本相同则用不存在的高版本走安装失败,否则重装旧版走验证失败
const failedVersion = compareSemver(nextVersion, oldVersion) === 0 ? '999.999.999' : oldVersion

const sha256 = async path => createHash('sha256').update(await readFile(path)).digest('hex')
const prefix = await mkdtemp(join(tmpdir(), 'maintain-acceptance-'))
// POSIX npm global 布局要求 <prefix>/lib/node_modules,win32 为 <prefix>/node_modules
const installRoot = process.platform === 'win32' ? prefix : join(prefix, 'global')
const allowedEnvironmentKeys = process.platform === 'win32'
  ? ['PATH', 'SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'SYSTEMDRIVE', 'COMSPEC', 'PATHEXT', 'USERDOMAIN', 'USERNAME', 'OS', 'PROCESSOR_ARCHITECTURE']
  : ['PATH', 'TMPDIR', 'LANG', 'LC_ALL', 'LC_CTYPE', 'USER', 'LOGNAME', 'SHELL', 'TERM']
const env = Object.fromEntries(allowedEnvironmentKeys.filter(key => process.env[key] !== undefined).map(key => [key, process.env[key]]))
// npm 生成的入口经 env node 解析解释器,显式把当前 node 目录置于 PATH 首位
env.PATH = dirname(process.execPath) + delimiter + (env.PATH || '')
const home = join(prefix, 'candidate-root')
env.HOME = home
env.USERPROFILE = home
if (process.platform === 'win32') {
  env.APPDATA = join(home, 'AppData', 'Roaming')
  env.LOCALAPPDATA = join(home, 'AppData', 'Local')
  env.HOMEDRIVE = resolve(home).slice(0, 2)
  env.HOMEPATH = resolve(home).slice(2)
}
env.DSH_HOME = join(home, '.dsh')
env.npm_config_cache = join(home, 'npm-cache')
env.npm_config_userconfig = join(home, 'npmrc')
env.npm_config_global = 'false'
const npmCli = await findNpmCli()

// 子进程状态不确定(超时强杀)时保留整个临时根,避免与残留 npm lifecycle 竞态清理
let preserveRoot = false
let liveChild = null
const killTree = child => {
  if (process.platform === 'win32') {
    const taskkill = spawn(join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'taskkill.exe'), ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
    taskkill.unref()
  } else {
    try { process.kill(-child.pid, 'SIGKILL') } catch { child.kill('SIGKILL') }
  }
}
process.once('SIGINT', () => { preserveRoot = true; if (liveChild) killTree(liveChild) })
process.once('SIGTERM', () => { preserveRoot = true; if (liveChild) killTree(liveChild) })

// capture=true 收集输出供版本断言;默认 inherit 透传 npm 进度
const trackedRun = ({ capture = false, ...options }) => new Promise(resolvePromise => {
  const child = spawn(options.executable, options.args, {
    cwd: options.cwd,
    env: options.env,
    shell: false,
    detached: process.platform !== 'win32',
    windowsHide: true,
    stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
  })
  liveChild = child
  let timedOut = false
  let stdout = ''
  let stderr = ''
  if (capture) {
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', chunk => { stdout = (stdout + chunk).slice(-16 * 1024) })
    child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-16 * 1024) })
  }
  const timeout = setTimeout(() => {
    timedOut = true
    preserveRoot = true
    killTree(child)
  }, options.timeoutMs)
  child.once('error', error => {
    clearTimeout(timeout)
    liveChild = null
    resolvePromise({ ok: false, timedOut, stderrTail: stderr || error.message, stdoutTail: stdout, pid: child.pid })
  })
  child.once('close', code => {
    clearTimeout(timeout)
    liveChild = null
    resolvePromise({ ok: code === 0 && !timedOut, timedOut, stderrTail: stderr, stdoutTail: stdout, pid: child.pid })
  })
})

const install = version => async ({ slot, env: candidateEnv }) => trackedRun({
  executable: process.execPath,
  args: [npmCli, 'install', '--prefix', slot, target + '@' + version, '--no-audit', '--no-fund'],
  cwd: slot,
  env: candidateEnv,
  timeoutMs: 20 * 60 * 1000,
})

// 候选验证:npm ls 依赖树 + 直接以 node 执行候选 bin(切换前全局入口仍指向旧版,不能复用)
const validate = async ({ slot, candidatePackage, env: candidateEnv }) => {
  const tree = await trackedRun({ executable: process.execPath, args: [npmCli, 'ls', '--omit=dev', '--prefix', slot], cwd: slot, env: candidateEnv, timeoutMs: 60 * 1000 })
  if (!tree.ok) return { ok: false, stderrTail: tree.stderrTail || '依赖树检查失败' }
  const cli = join(candidatePackage, JSON.parse(await readFile(join(candidatePackage, 'package.json'), 'utf8')).bin.dsh)
  const bootEnv = { ...candidateEnv, DSH_HOME: join(slot, 'probe-home', '.dsh'), HOME: join(slot, 'probe-home'), USERPROFILE: join(slot, 'probe-home'), PORT: '0' }
  await mkdir(join(slot, 'probe-home'), { recursive: true })
  const boot = await trackedRun({ executable: process.execPath, args: [cli, '--version'], cwd: candidatePackage, env: bootEnv, timeoutMs: 60 * 1000 })
  return boot.ok ? { ok: true } : { ok: false, stderrTail: boot.stderrTail || boot.stdoutTail || '候选CLI版本探针失败' }
}

try {
  await mkdir(home, { recursive: true })
  await mkdir(installRoot, { recursive: true })
  const bootstrap = await trackedRun({
    executable: process.execPath,
    args: [npmCli, 'install', '--global', '--prefix', installRoot, target + '@' + oldVersion, '--no-audit', '--no-fund'],
    cwd: installRoot, env, timeoutMs: 20 * 60 * 1000,
  })
  assert(bootstrap.ok, bootstrap.stderrTail || '原包安装失败')
  const originalPackage = process.platform === 'win32'
    ? join(installRoot, 'node_modules', '@deepseek-ai', 'dsh')
    : join(installRoot, 'lib', 'node_modules', '@deepseek-ai', 'dsh')
  const manifest = JSON.parse(await readFile(join(originalPackage, 'package.json'), 'utf8'))
  const bin = join(originalPackage, manifest.bin.dsh)
  const before = await sha256(bin)
  const layout = await createLayout({ prefix: installRoot, originalPackage, platform: process.platform })
  await mkdir(layout.root, { recursive: true })
  // npm 原生生成的命令入口(非手工 shim):win32 dsh.cmd,POSIX bin/dsh
  const entryPath = process.platform === 'win32' ? join(installRoot, 'dsh.cmd') : join(installRoot, 'bin', 'dsh')
  assert(await stat(entryPath).then(info => info.isFile(), () => false), 'npm未为global prefix生成命令入口: ' + entryPath)
  await chmod(entryPath, 0o755).catch(() => {})
  const runEntry = () => trackedRun({
    capture: true,
    executable: process.platform === 'win32' ? process.env.ComSpec || 'cmd.exe' : entryPath,
    args: process.platform === 'win32' ? ['/d', '/s', '/c', entryPath + ' --version'] : ['--version'],
    cwd: installRoot,
    env,
    timeoutMs: 60 * 1000,
  })
  const entryBefore = await runEntry()
  assert(entryBefore.ok, entryBefore.stderrTail || '原npm命令入口不可执行')

  const candidateEnv = {
    ...env,
    HOME: join(layout.root, 'candidate-home'),
    USERPROFILE: join(layout.root, 'candidate-home'),
    DSH_HOME: join(layout.root, 'candidate-home', '.dsh'),
    npm_config_cache: join(layout.root, 'npm-cache'),
    npm_config_userconfig: join(layout.root, 'npmrc'),
  }
  const first = await performManagedUpgrade({ layout, runningPackage: originalPackage, targetVersion: nextVersion, install: install(nextVersion), validate, beforeSwitch: async () => {}, env: candidateEnv })
  assert(first.switched, '第一轮没有激活')
  assert(await readSelectedVersion(layout) === nextVersion, 'A/B链接版本错误')
  assert(await sha256(bin) === before, '原始CLI被修改')
  assert(await stat(join(layout.a, 'probe-home')).then(info => info.isDirectory(), () => false), 'CLI探针HOME未创建')
  // 切换后同一 npm 入口必须解析到新版本(证明入口跟随 dsh_link)
  const entryAfter = await runEntry()
  assert(entryAfter.ok, entryAfter.stderrTail || '切换后npm命令入口不可执行')
  assert(entryAfter.stdoutTail.includes(nextVersion), '切换后入口版本未跟随链接: ' + entryAfter.stdoutTail.trim())

  try {
    await performManagedUpgrade({ layout, runningPackage: first.targetPackage, targetVersion: failedVersion, install: install(failedVersion), validate: async () => ({ ok: false, stderrTail: 'expected validation failure' }), beforeSwitch: async () => {}, env: candidateEnv })
    throw new Error('验收失败: 失败轮意外成功')
  } catch (roundError) {
    // 失败轮允许落在安装(如 999.999.999 不存在)或验证(显式 stub)任一阶段
    assert(
      String(roundError.message).includes('expected validation failure') || String(roundError.message).includes(failedVersion),
      '失败轮错误不匹配: ' + roundError.message,
    )
    assert(roundError.switched === false, '失败轮不得报告已切换')
  }
  assert(await readSelectedVersion(layout) === nextVersion, '验证失败导致链接切换')
  const state = JSON.parse(await readFile(join(layout.root, 'state.json'), 'utf8'))
  assert(state.phase === 'failed', '失败状态未写入')
  assert(await stat(join(layout.root, 'upgrade.lock')).then(() => false, error => error.code === 'ENOENT'), '失败但安全的安装未释放锁')
  console.log('\n[acceptance] 通过 prefix=' + prefix + ' active=' + nextVersion)
} catch (error) {
  if (preserveRoot) console.error('[acceptance] 子进程状态不确定,保留隔离目录供核验: ' + prefix)
  throw error
} finally {
  if (!preserveRoot) await rm(prefix, { recursive: true, force: true })
}
