import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile, realpath, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { createLayout } from '../src/managed-layout.mjs'
import { createCandidateEnvironment, findNpmCli, validateCandidate } from '../src/managed-upgrade.mjs'

async function setup(t) {
  const prefix = await mkdtemp(join(tmpdir(), 'maintain-upgrade-test-'))
  t.after(() => rm(prefix, { recursive: true, force: true }))
  const profileRoot = join(prefix, '.dsh-maintain')
  await mkdir(profileRoot, { recursive: true })
  const originalPackage = process.platform === 'win32'
    ? join(prefix, 'node_modules/@deepseek-ai/dsh')
    : join(prefix, 'lib/node_modules/@deepseek-ai/dsh')
  await mkdir(join(originalPackage, 'lib'), { recursive: true })
  await writeFile(join(originalPackage, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh', version: '1.0.0', bin: { dsh: 'lib/bin.js' } }))
  await writeFile(join(originalPackage, 'lib/bin.js'), 'original')
  if (process.platform === 'win32') await writeFile(join(prefix, 'dsh.cmd'), '@"%dp0%node.exe" "%dp0%node_modules\\@deepseek-ai\\dsh\\lib\\bin.js" %*')
  else {
    await mkdir(join(prefix, 'bin'), { recursive: true })
    await symlink(join(originalPackage, 'lib/bin.js'), join(prefix, 'bin/dsh'))
  }
  const layout = Object.freeze({ ...(await createLayout({ prefix, originalPackage, platform: process.platform })), root: profileRoot })
  const api = await import('../src/managed-upgrade.mjs')
  const events = []
  const install = async ({ slot, version }) => {
    events.push('install')
    const pkg = join(slot, 'node_modules/@deepseek-ai/dsh')
    await mkdir(join(pkg, 'lib'), { recursive: true })
    await writeFile(join(pkg, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh', version, bin: { dsh: 'lib/bin.js' } }))
    await writeFile(join(pkg, 'lib/bin.js'), `candidate-${version}`)
    return { ok: true, code: 0 }
  }
  const validate = async () => { events.push('validate'); return { ok: true, code: 0 } }
  const beforeSwitch = async () => { events.push('guard') }
  return { prefix, layout, api, events, originalPackage, install, validate, beforeSwitch }
}

test('系统npm位于标准share目录时使用该真实CLI', async t => {
  const root = await mkdtemp(join(tmpdir(), 'maintain-system-node-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const node = join(root, 'bin', 'node')
  const npmCli = join(root, 'share', 'nodejs', 'npm', 'bin', 'npm-cli.js')
  await mkdir(dirname(node), { recursive: true })
  await mkdir(dirname(npmCli), { recursive: true })
  await writeFile(node, '')
  await writeFile(npmCli, '')
  assert.equal(await findNpmCli(node), await realpath(npmCli))
})

test('系统npm位于share/npm目录时使用该真实CLI', async t => {
  const root = await mkdtemp(join(tmpdir(), 'maintain-system-npm-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const node = join(root, 'bin', 'node')
  const npmCli = join(root, 'share', 'npm', 'bin', 'npm-cli.js')
  await mkdir(dirname(node), { recursive: true })
  await mkdir(dirname(npmCli), { recursive: true })
  await writeFile(node, '')
  await writeFile(npmCli, '')
  assert.equal(await findNpmCli(node), await realpath(npmCli))
})
test('POSIX槽位清理使用原生分隔符', async t => {
  const f = await setup(t)
  const layoutApi = await import('../src/managed-layout.mjs')
  const slot = await layoutApi.selectInactiveSlot(f.layout, f.originalPackage)
  await layoutApi.clearInactiveSlot(f.layout, slot, f.originalPackage)
  assert.deepEqual(await (await import('node:fs/promises')).readdir(slot), [])
})
test('候选环境只继承启动npm所需变量并清除宿主注入点', async t => {
  const f = await setup(t)
  const keys = ['NODE_OPTIONS', 'NODE_PATH', 'APPDATA', 'LOCALAPPDATA', 'DSH_PROFILE', 'DSH_INSTALL_ANCHOR']
  const before = new Map(keys.map(key => [key, process.env[key]]))
  for (const key of keys) process.env[key] = 'production-' + key
  try {
    const env = createCandidateEnvironment({ root: f.layout.root })
    assert.equal(env.NODE_OPTIONS, undefined)
    assert.equal(env.NODE_PATH, undefined)
    if (process.platform === 'win32') {
      assert.equal(env.APPDATA, join(f.layout.root, 'candidate-home', 'AppData', 'Roaming'))
      assert.equal(env.LOCALAPPDATA, join(f.layout.root, 'candidate-home', 'AppData', 'Local'))
    } else {
      assert.equal(env.APPDATA, undefined)
      assert.equal(env.LOCALAPPDATA, undefined)
    }
    assert.equal(env.DSH_PROFILE, undefined)
    assert.equal(env.DSH_INSTALL_ANCHOR, undefined)
    assert.equal(env.HOME, join(f.layout.root, 'candidate-home'))
    assert.equal(env.DSH_HOME, join(f.layout.root, 'candidate-home', '.dsh'))
    assert.equal(env.PATH, process.env.PATH)
    assert.ok(!Object.keys(env).some(key => /TOKEN|SECRET|PASSWORD|API_KEY/i.test(key)))
  } finally {
    for (const [key, value] of before) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
})
test('完整升级先安装验证再最终门控与切换，锁释放且只记录等待重启', async t => {
  const f = await setup(t)
  const result = await f.api.performManagedUpgrade({ ...f, runningPackage: f.originalPackage, targetVersion: '2.0.0' })
  assert.deepEqual(f.events, ['install', 'validate', 'guard'])
  assert.equal(result.switched, true)
  assert.equal(result.targetVersion, '2.0.0')
  assert.equal(await realpath(f.layout.link), join(f.layout.a, 'node_modules/@deepseek-ai/dsh'))
  const state = JSON.parse(await readFile(join(f.layout.root, 'state.json'), 'utf8'))
  assert.equal(state.phase, 'awaiting-restart')
  assert.equal(state.originalPackage, f.originalPackage)
  await assert.rejects(readFile(join(f.layout.root, 'upgrade.lock')), { code: 'ENOENT' })
})

test('候选复扫和切槽共用一个 profile 临界区，安装与验证在锁外', async t => {
  const f = await setup(t)
  const activate = (await import('../src/managed-layout.mjs')).activateInstallation
  const events = []
  await f.api.performManagedUpgrade({
    ...f, runningPackage: f.originalPackage, targetVersion: '2.0.0',
    install: async (input) => { events.push('install'); return f.install(input) },
    validate: async (input) => { events.push('validate'); return f.validate(input) },
    withSwitchLock: async (commit) => {
      events.push('locked')
      try { return await commit() } finally { events.push('released') }
    },
    beforeSwitch: async () => {
      events.push('scan')
      const state = JSON.parse(await readFile(join(f.layout.root, 'state.json'), 'utf8'))
      assert.equal(state.phase, 'ready-to-switch')
      assert.equal(state.targetPackage, undefined)
    },
    activate: async (...args) => {
      events.push('activate')
      const state = JSON.parse(await readFile(join(f.layout.root, 'state.json'), 'utf8'))
      assert.equal(state.phase, 'awaiting-restart')
      assert.equal(state.targetPackage, args[1])
      return activate(...args)
    },
  })
  assert.deepEqual(events, ['install', 'validate', 'locked', 'scan', 'activate', 'released'])
})

test('无法取得 profile 写锁时不复扫、不切槽、不要求退出', async t => {
  const f = await setup(t)
  const entry = process.platform === 'win32' ? join(f.prefix, 'dsh.cmd') : join(f.prefix, 'bin/dsh')
  const originalEntry = await readFile(entry)
  await assert.rejects(f.api.performManagedUpgrade({
    ...f, runningPackage: f.originalPackage, targetVersion: '2.0.0',
    withSwitchLock: async () => { throw new Error('profile 正在改包') },
  }), { message: 'profile 正在改包', switched: false, indeterminate: false })
  assert.deepEqual(f.events, ['install', 'validate'])
  assert.deepEqual(await readFile(entry), originalEntry)
  if (process.platform !== 'win32') assert.equal(await realpath(entry), join(f.originalPackage, 'lib/bin.js'))
  await assert.rejects(readFile(join(f.layout.root, 'upgrade.lock')), { code: 'ENOENT' })
  await assert.rejects(realpath(f.layout.link), { code: 'ENOENT' })
})

test('profile 锁释放失败不能掩盖切槽回滚失败', async t => {
  const f = await setup(t)
  await assert.rejects(f.api.performManagedUpgrade({
    ...f, runningPackage: f.originalPackage, targetVersion: '2.0.0',
    withSwitchLock: async (commit) => {
      try { return await commit() } finally { throw new Error('释放 profile 写锁失败') }
    },
    activate: async () => { throw Object.assign(new Error('切槽回滚失败'), { rollbackFailed: true }) },
  }), (error) => error.indeterminate === true && error.requiresHostExit === true
    && error.switched === false && /切槽回滚失败/.test(error.message))
  const state = JSON.parse(await readFile(join(f.layout.root, 'state.json'), 'utf8'))
  assert.equal(state.phase, 'indeterminate')
  assert.ok(await readFile(join(f.layout.root, 'upgrade.lock'), 'utf8'))
})

test('初次落盘被状态锁阻止时保留历史、释放升级锁且不要求退出', async t => {
  const f = await setup(t)
  const previous = '{"operationId":"op-previous","phase":"healthy"}'
  await writeFile(join(f.layout.root, 'state.json'), previous)
  await writeFile(join(f.layout.root, 'state.json.lock'), 'held')
  await assert.rejects(f.api.performManagedUpgrade({ ...f, runningPackage: f.originalPackage, targetVersion: '2.0.0' }), {
    code: 'STATE_LOCK_BUSY', switched: false, indeterminate: false,
  })
  assert.deepEqual(f.events, [])
  assert.equal(await readFile(join(f.layout.root, 'state.json'), 'utf8'), previous)
  await assert.rejects(readFile(join(f.layout.root, 'upgrade.lock')), { code: 'ENOENT' })
})

test('同 prefix 的旧宿主持过期预检进入 runner 时不覆盖已切槽操作', async t => {
  const f = await setup(t)
  const options = { ...f, runningPackage: f.originalPackage, targetVersion: '2.0.0' }
  await f.api.performManagedUpgrade({ ...options, profileId: 'profile-a', operationId: 'op-a' })
  const path = join(f.layout.root, 'state.json')
  const awaitingRestart = await readFile(path, 'utf8')
  await assert.rejects(f.api.performManagedUpgrade({ ...options, profileId: 'profile-b', operationId: 'op-b' }), {
    switched: false, indeterminate: false,
  })
  assert.deepEqual(f.events, ['install', 'validate', 'guard'])
  assert.equal(JSON.parse(awaitingRestart).profileId, 'profile-a')
  assert.equal(await readFile(path, 'utf8'), awaitingRestart)
})

test('候选安装失败只尝试一次，不验证切换，也不改原bin', async t => {
  const f = await setup(t)
  let attempts = 0
  await assert.rejects(f.api.performManagedUpgrade({ ...f, runningPackage: f.originalPackage, targetVersion: '2.0.0', install: async () => { attempts++; return { ok: false, stderrTail: 'npm error' } } }), /npm error/)
  assert.equal(attempts, 1)
  assert.deepEqual(f.events, [])
  await assert.rejects(realpath(f.layout.link), { code: 'ENOENT' })
  assert.equal(await readFile(join(f.originalPackage, 'lib/bin.js'), 'utf8'), 'original')
})

test('提交窗口新增工作时不切链接', async t => {
  const f = await setup(t)
  await assert.rejects(f.api.performManagedUpgrade({ ...f, runningPackage: f.originalPackage, targetVersion: '2.0.0', validate: async () => ({ ok: true, code: 0 }), beforeSwitch: async () => { throw new Error('active work') } }), /active work/)
  await assert.rejects(realpath(f.layout.link), { code: 'ENOENT' })
})

test('最终落盘窗口卸载后不切换安装链接', async t => {
  const f = await setup(t)
  let disposed = false
  await assert.rejects(f.api.performManagedUpgrade({
    ...f, runningPackage: f.originalPackage, targetVersion: '2.0.0',
    onPhase: ({ phase }) => { if (phase === 'ready-to-switch') disposed = true },
    beforeSwitch: async () => {
      if (disposed) throw new Error('维护插件已卸载')
    },
  }), /维护插件已卸载/)
  await assert.rejects(realpath(f.layout.link), { code: 'ENOENT' })
  assert.equal(JSON.parse(await readFile(join(f.layout.root, 'state.json'), 'utf8')).phase, 'failed')
})

test('beforeSwitch 抛错不切链接、锁释放、state 落定 failed 且可重试', async t => {
  const f = await setup(t)
  const pluginGate = async () => { throw new Error('插件升级未完成,已中止切换槽位: @scope/a') }
  let error = null
  try {
    await f.api.performManagedUpgrade({ ...f, runningPackage: f.originalPackage, targetVersion: '2.0.0', beforeSwitch: pluginGate })
  } catch (thrown) {
    error = thrown
  }
  assert.ok(error)
  assert.match(error.message, /插件升级未完成/)
  assert.notEqual(error.switched, true)
  assert.notEqual(error.indeterminate, true)
  assert.deepEqual(f.events, ['install', 'validate'])
  await assert.rejects(realpath(f.layout.link), { code: 'ENOENT' })
  await assert.rejects(readFile(join(f.layout.root, 'upgrade.lock')), { code: 'ENOENT' })
  const state = JSON.parse(await readFile(join(f.layout.root, 'state.json'), 'utf8'))
  assert.equal(state.phase, 'failed')
  assert.match(state.error, /插件升级未完成/)
  // 失败落定后同一目标可再次发起:锁已释放,不被"进行中"拒绝
  await assert.rejects(
    f.api.performManagedUpgrade({ ...f, runningPackage: f.originalPackage, targetVersion: '2.0.0', beforeSwitch: pluginGate }),
    (retry) => retry.message !== '升级进行中' && /插件升级未完成/.test(retry.message),
  )
  assert.deepEqual(f.events, ['install', 'validate', 'install', 'validate'])
})

test('同prefix并发仅一个安装；损坏或古老锁不能TTL放行', async t => {
  const f = await setup(t)
  await mkdir(f.layout.root, { recursive: true })
  const lockPath = join(f.layout.root, 'upgrade.lock')
  for (const content of ['{bad', JSON.stringify({ pid: process.pid, startedAt: 0, operationId: 'old' })]) {
    await writeFile(lockPath, content)
    await assert.rejects(f.api.performManagedUpgrade({ ...f, runningPackage: f.originalPackage, targetVersion: '2.0.0' }), /锁|进行中/)
    assert.deepEqual(f.events, [])
    await rm(lockPath)
  }
  let release
  let entered
  const started = new Promise(resolve => { entered = resolve })
  const first = f.api.performManagedUpgrade({ ...f, runningPackage: f.originalPackage, targetVersion: '2.0.0', install: async args => { entered(); await new Promise(resolve => { release = resolve }); return f.install(args) }, validate: f.validate })
  await started
  await assert.rejects(f.api.performManagedUpgrade({ ...f, runningPackage: f.originalPackage, targetVersion: '3.0.0' }), /锁|进行中/)
  release()
  await first
  assert.equal(f.events.filter(e => e === 'install').length, 1)
})

test('npm超时将槽隔离，下一请求不得直接复用', async t => {
  const f = await setup(t)
  const error = await f.api.performManagedUpgrade({ ...f, runningPackage: f.originalPackage, targetVersion: '2.0.0', install: async () => ({ ok: false, timedOut: true, stderrTail: 'timeout' }) }).then(() => null, (thrown) => thrown)
  assert.match(error.message, /timeout/)
  assert.equal(error.indeterminate, true)
  assert.equal(error.requiresHostExit, true)
  assert.equal(error.switched, false)
  await assert.rejects(f.api.performManagedUpgrade({ ...f, runningPackage: f.originalPackage, targetVersion: '2.0.0' }), /锁|隔离|进行中/)
  assert.deepEqual(f.events, [])
})

test('候选验证显式失败不得切换', async t => {
  const f = await setup(t)
  const error = await f.api.performManagedUpgrade({ ...f, runningPackage: f.originalPackage, targetVersion: '2.0.0', validate: async () => ({ ok: false, code: 1, stderrTail: 'ELSPROBLEMS' }) }).then(() => null, (thrown) => thrown)
  assert.match(error.message, /ELSPROBLEMS/)
  // 可判定的失败不保留锁,也不得以 indeterminate 触发强制退出
  assert.equal(error.indeterminate, false)
  await assert.rejects(realpath(f.layout.link), { code: 'ENOENT' })
})

test('候选验证超时必须保留锁', async t => {
  const f = await setup(t)
  const error = await f.api.performManagedUpgrade({ ...f, runningPackage: f.originalPackage, targetVersion: '2.0.0', validate: async () => ({ ok: false, timedOut: true, stillRunning: true, stderrTail: 'timeout' }) }).then(() => null, (thrown) => thrown)
  assert.match(error.message, /timeout/)
  assert.equal(error.indeterminate, true)
  assert.equal(error.switched, false)
  assert.match(await readFile(join(f.layout.root, 'upgrade.lock'), 'utf8'), /operationId/)
  const state = JSON.parse(await readFile(join(f.layout.root, 'state.json'), 'utf8'))
  assert.equal(state.phase, 'indeterminate')
})

test('入口切换回滚失败保留锁并标记不可判定', async t => {
  const f = await setup(t)
  const error = await f.api.performManagedUpgrade({
    ...f, runningPackage: f.originalPackage, targetVersion: '2.0.0',
    activate: async () => { const thrown = new Error('rollback failed'); thrown.rollbackFailed = true; throw thrown },
  }).then(() => null, (thrown) => thrown)
  assert.match(error.message, /rollback failed/)
  assert.equal(error.indeterminate, true)
  assert.match(await readFile(join(f.layout.root, 'upgrade.lock'), 'utf8'), /operationId/)
  const state = JSON.parse(await readFile(join(f.layout.root, 'state.json'), 'utf8'))
  assert.equal(state.phase, 'indeterminate')
})
test('进入激活后故障且失败状态无法落盘时仍要求保护性退出', async t => {
  const f = await setup(t)
  const stateLock = join(f.layout.root, 'state.json.lock')
  await assert.rejects(f.api.performManagedUpgrade({
    ...f, runningPackage: f.originalPackage, targetVersion: '2.0.0',
    activate: async () => {
      await writeFile(stateLock, 'fixture', { flag: 'wx' })
      throw new Error('激活未完成')
    },
  }), { message: /激活未完成.*失败结果无法落盘/, switched: false, indeterminate: true, requiresHostExit: true })
  assert.ok(await readFile(join(f.layout.root, 'upgrade.lock'), 'utf8'))
})

test('非法精确版本不清空任何目录或启动安装', async t => {
  const f = await setup(t)
  await assert.rejects(f.api.performManagedUpgrade({ ...f, runningPackage: f.originalPackage, targetVersion: 'latest;bad' }), /版本/)
  assert.deepEqual(f.events, [])
})

// 候选验证真实执行:真 npm ls 依赖树 + 真 node 执行候选 bin --version(自然退出,不起服务)。
// env 直传 process.env:隔离性由 createCandidateEnvironment 独立用例覆盖,此处只验判定逻辑
async function candidateFixture(t, binScript) {
  const prefix = await mkdtemp(join(tmpdir(), 'maintain-validate-test-'))
  t.after(() => rm(prefix, { recursive: true, force: true }))
  const slot = join(prefix, 'install-a')
  const candidatePackage = join(slot, 'node_modules/@deepseek-ai/dsh')
  await mkdir(join(slot, 'node_modules'), { recursive: true })
  await mkdir(join(candidatePackage, 'lib'), { recursive: true })
  await writeFile(join(candidatePackage, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh', version: '2.0.0', bin: { dsh: 'lib/bin.js' } }))
  if (binScript !== null) await writeFile(join(candidatePackage, 'lib/bin.js'), binScript)
  return { slot, candidatePackage }
}

test('候选验证:依赖树与CLI冒烟均通过即放行', async t => {
  const f = await candidateFixture(t, 'console.log("2.0.0")\n')
  const result = await validateCandidate({ slot: f.slot, candidatePackage: f.candidatePackage, env: process.env })
  assert.deepEqual(result, { ok: true })
})

test('候选验证:CLI冒烟非零退出即拒绝且不触发锁保留', async t => {
  const f = await candidateFixture(t, 'process.exit(3)\n')
  const result = await validateCandidate({ slot: f.slot, candidatePackage: f.candidatePackage, env: process.env })
  assert.equal(result.ok, false)
  assert.notEqual(result.timedOut, true)
  assert.notEqual(result.stillRunning, true)
  assert.ok(result.stderrTail || result.stdoutTail, '失败必须携带可诊断输出')
})

test('候选验证:候选bin缺失即拒绝', async t => {
  const f = await candidateFixture(t, null)
  const result = await validateCandidate({ slot: f.slot, candidatePackage: f.candidatePackage, env: process.env })
  assert.equal(result.ok, false)
})

