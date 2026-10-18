import { mkdir, open, readFile, writeFile, rename, rm, realpath, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, dirname, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { parseSemver } from './core.mjs'
import { selectInactiveSlot, clearInactiveSlot, activateInstallation } from './managed-layout.mjs'
import { runProcess } from './managed-process.mjs'

export const MANAGED_TIMEOUT_MS = 10 * 60 * 1000

export async function saveManagedState(layout, state) {
  const temp = join(layout.root, 'state.json.next')
  await writeFile(temp, JSON.stringify(state, null, 2))
  await rename(temp, join(layout.root, 'state.json'))
}

export async function findNpmCli(execPath = process.execPath) {
  const node = await realpath(execPath)
  const dir = dirname(node)
  const candidates = [
    join(dir, 'node_modules/npm/bin/npm-cli.js'),
    join(dir, '../lib/node_modules/npm/bin/npm-cli.js'),
    join(dir, '../share/nodejs/npm/bin/npm-cli.js'),
    join(dir, '../share/npm/bin/npm-cli.js'),
  ]
  for (const path of candidates) {
    try { if ((await stat(path)).isFile()) return await realpath(path) } catch (error) { if (error.code !== 'ENOENT') throw error }
  }
  throw new Error('当前Node旁未发现npm-cli.js，不使用任意PATH shell替代')
}

export async function installCandidate({ slot, version, registryBase, env, npmCli, nodePath = process.execPath, onOutput }) {
  const args = [npmCli || await findNpmCli(nodePath), 'install', '--prefix', slot, `@deepseek-ai/dsh@${version}`, '--no-audit', '--no-fund']
  if (registryBase) args.push('--registry', registryBase)
  return runProcess({ executable: nodePath, args, cwd: slot, env, timeoutMs: MANAGED_TIMEOUT_MS, onOutput })
}

export function createCandidateEnvironment(layout) {
  const home = join(layout.root, 'candidate-home')
  const npmCache = join(layout.root, 'npm-cache')
  const npmUserConfig = join(layout.root, 'npmrc')
  const profile = join(home, '.dsh', 'profiles', 'web')
  const managedRoot = resolve(layout.root).toLowerCase()
  for (const path of [home, npmCache, npmUserConfig, profile]) {
    const normalized = resolve(path).toLowerCase()
    if (normalized !== managedRoot && !normalized.startsWith(managedRoot + '\\') && !normalized.startsWith(managedRoot + '/')) {
      throw new Error('候选隔离路径必须位于受管目录: ' + path)
    }
  }
  const env = {}
  const windows = process.platform === 'win32'
  const allowed = windows
    ? ['PATH', 'SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'SYSTEMDRIVE', 'COMSPEC', 'PATHEXT', 'APPDATA', 'LOCALAPPDATA', 'USERDOMAIN', 'USERNAME', 'OS', 'PROCESSOR_ARCHITECTURE']
    : ['PATH', 'TMPDIR', 'LANG', 'LC_ALL', 'LC_CTYPE', 'USER', 'LOGNAME', 'SHELL', 'TERM']
  for (const key of allowed) if (process.env[key] !== undefined) env[key] = process.env[key]
  if (windows) {
    env.APPDATA = join(home, 'AppData', 'Roaming')
    env.LOCALAPPDATA = join(home, 'AppData', 'Local')
    const root = resolve(home)
    const drive = root.match(/^[A-Za-z]:/)?.[0]
    if (!drive) throw new Error('候选HOME必须位于Windows本地驱动器')
    env.HOMEDRIVE = drive
    env.HOMEPATH = root.slice(drive.length)
  }
  return {
    ...env,
    HOME: home,
    USERPROFILE: home,
    DSH_HOME: join(home, '.dsh'),
    npm_config_cache: npmCache,
    npm_config_userconfig: npmUserConfig,
    npm_config_global: 'false',
  }
}

export async function performManagedUpgrade({ layout, runningPackage, targetVersion, registryBase, env,
  install = installCandidate, validate, beforeSwitch, activate = activateInstallation, onPhase = () => {}, activePackages = [], operationId = randomUUID(), nodePath, npmCli }) {
  if (!parseSemver(targetVersion)) throw new Error('必须指定合法精确版本')
  if (typeof validate !== 'function' || typeof beforeSwitch !== 'function') throw new Error('缺少隔离验证或提交前门控')
  await mkdir(layout.root, { recursive: true })
  const lockPath = join(layout.root, 'upgrade.lock')
  let handle
  try { handle = await open(lockPath, 'wx') } catch (error) {
    if (error.code === 'EEXIST') throw new Error('升级锁存在(残留待人工核验,内容含 operationId/pid/startedAt): ' + lockPath)
    throw error
  }
  let keepLock = false
  let switched = false
  const state = {
    operationId, targetVersion, prefix: layout.prefix, originalPackage: layout.originalPackage,
    runningPackage, phase: 'accepted', startedAt: Date.now(), bin: layout.bin,
  }
  const phase = async value => { state.phase = value; await saveManagedState(layout, state); onPhase({ ...state }) }
  try {
    await handle.writeFile(JSON.stringify({ operationId, pid: process.pid, startedAt: state.startedAt }))
    const slot = await selectInactiveSlot(layout, runningPackage)
    await phase('preparing')
    await clearInactiveSlot(layout, slot, runningPackage, { activePackages })
    await phase('installing')
    const candidateEnv = env ?? createCandidateEnvironment(layout)
    state.candidateHome = candidateEnv.HOME
    const result = await install({ slot, version: targetVersion, registryBase, env: candidateEnv, nodePath, npmCli })
    if (!result.ok) {
      keepLock = result.timedOut === true || result.stillRunning === true
      throw new Error(result.stderrTail || result.stdoutTail || 'npm安装失败')
    }
    const pkg = join(slot, 'node_modules/@deepseek-ai/dsh')
    const manifest = JSON.parse(await readFile(join(pkg, 'package.json'), 'utf8'))
    if (manifest.name !== '@deepseek-ai/dsh' || manifest.version !== targetVersion || manifest.bin?.dsh !== layout.bin) throw new Error('候选版本或bin不符合精确安装目标')
    await phase('validating')
    const validation = await validate({ slot, candidatePackage: pkg, targetVersion, env: candidateEnv, nodePath, npmCli })
    if (!validation || validation.ok !== true) {
      keepLock = validation?.timedOut === true || validation?.stillRunning === true
      throw new Error(validation?.stderrTail || validation?.stdoutTail || '候选验证失败')
    }
    await phase('ready-to-switch')
    await beforeSwitch({ candidatePackage: pkg, operationId })
    state.slot = slot === layout.a ? 'a' : 'b'
    state.targetPackage = pkg
    state.phase = 'awaiting-restart'
    await saveManagedState(layout, state)
    onPhase({ ...state })
    const activated = await activate(layout, pkg, { runningPackage })
    switched = true
    return { ...state, slot: activated.slot, targetPackage: activated.candidatePackage, switched: true }
  } catch (error) {
    keepLock ||= switched || error.indeterminate === true || error.stillRunning === true || error.timedOut === true || error.rollbackFailed === true
    state.phase = keepLock ? 'indeterminate' : 'failed'
    state.error = error.message
    try { await saveManagedState(layout, state); onPhase({ ...state }) } catch { keepLock = true }
    error.operationId = operationId
    error.switched = switched
    throw error
  } finally {
    await handle.close()
    // 锁删除失败不掩盖原错误:残留锁由下一次请求拒绝并提示人工核验
    try { if (!keepLock) await rm(lockPath, { force: true }) } catch (lockError) {
      console.warn('[dsh-maintain] 升级锁删除失败(已保留供人工核验): ' + (lockError?.message ?? lockError))
    }
  }
}
