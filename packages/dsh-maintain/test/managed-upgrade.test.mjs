import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile, realpath, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { createLayout } from '../src/managed-layout.mjs'
import { createCandidateEnvironment, findNpmCli } from '../src/managed-upgrade.mjs'

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
  await assert.rejects(f.api.performManagedUpgrade({ ...f, runningPackage: f.originalPackage, targetVersion: '2.0.0', install: async () => ({ ok: false, timedOut: true, stderrTail: 'timeout' }) }), /timeout/)
  await assert.rejects(f.api.performManagedUpgrade({ ...f, runningPackage: f.originalPackage, targetVersion: '2.0.0' }), /锁|隔离|进行中/)
  assert.deepEqual(f.events, [])
})

test('候选验证显式失败不得切换', async t => {
  const f = await setup(t)
  await assert.rejects(f.api.performManagedUpgrade({ ...f, runningPackage: f.originalPackage, targetVersion: '2.0.0', validate: async () => ({ ok: false, code: 1, stderrTail: 'ELSPROBLEMS' }) }), /ELSPROBLEMS/)
  await assert.rejects(realpath(f.layout.link), { code: 'ENOENT' })
})

test('候选验证超时必须保留锁', async t => {
  const f = await setup(t)
  await assert.rejects(f.api.performManagedUpgrade({ ...f, runningPackage: f.originalPackage, targetVersion: '2.0.0', validate: async () => ({ ok: false, timedOut: true, stillRunning: true, stderrTail: 'timeout' }) }), /timeout/)
  assert.match(await readFile(join(f.layout.root, 'upgrade.lock'), 'utf8'), /operationId/)
  const state = JSON.parse(await readFile(join(f.layout.root, 'state.json'), 'utf8'))
  assert.equal(state.phase, 'indeterminate')
})

test('入口切换回滚失败保留锁并标记不可判定', async t => {
  const f = await setup(t)
  await assert.rejects(f.api.performManagedUpgrade({
    ...f, runningPackage: f.originalPackage, targetVersion: '2.0.0',
    activate: async () => { const error = new Error('rollback failed'); error.rollbackFailed = true; throw error },
  }), /rollback failed/)
  assert.match(await readFile(join(f.layout.root, 'upgrade.lock'), 'utf8'), /operationId/)
  const state = JSON.parse(await readFile(join(f.layout.root, 'state.json'), 'utf8'))
  assert.equal(state.phase, 'indeterminate')
})
test('非法精确版本不清空任何目录或启动安装', async t => {
  const f = await setup(t)
  await assert.rejects(f.api.performManagedUpgrade({ ...f, runningPackage: f.originalPackage, targetVersion: 'latest;bad' }), /版本/)
  assert.deepEqual(f.events, [])
})

