import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile, realpath, readlink, lstat, symlink, unlink, rm, readdir } from 'node:fs/promises'
import { join, relative } from 'node:path'
import { tmpdir } from 'node:os'

async function fixture(t, platform = process.platform) {
  const prefix = await mkdtemp(join(tmpdir(), 'maintain-ab-layout-'))
  t.after(() => rm(prefix, { recursive: true, force: true }))
  const originalPackage = platform === 'win32'
    ? join(prefix, 'node_modules', '@deepseek-ai', 'dsh')
    : join(prefix, 'lib', 'node_modules', '@deepseek-ai', 'dsh')
  await mkdir(join(originalPackage, 'lib'), { recursive: true })
  await writeFile(join(originalPackage, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh', version: '1.0.0', bin: { dsh: 'lib/bin.js' } }))
  await writeFile(join(originalPackage, 'lib', 'bin.js'), 'original-cli')
  if (platform === 'win32') {
    for (const [name, content] of Object.entries({
      'dsh.ps1': '& "$basedir/node.exe" "$basedir/node_modules/@deepseek-ai/dsh/lib/bin.js" $args\n',
      'dsh.cmd': '@"%dp0%node.exe" "%dp0%node_modules\\@deepseek-ai\\dsh\\lib\\bin.js" %*\r\n',
      dsh: '"$basedir/node" "$basedir/node_modules/@deepseek-ai/dsh/lib/bin.js" "$@"\n',
    })) await writeFile(join(prefix, name), content)
  } else {
    await mkdir(join(prefix, 'bin'), { recursive: true })
    await symlink(join(originalPackage, 'lib', 'bin.js'), join(prefix, 'bin', 'dsh'))
  }
  const api = await import('../src/managed-layout.mjs')
  const layout = await api.createLayout({ prefix, originalPackage, platform })
  await mkdir(layout.root)
  async function install(slot, version) {
    const pkg = join(layout[slot], 'node_modules', '@deepseek-ai', 'dsh')
    await mkdir(join(pkg, 'lib'), { recursive: true })
    await writeFile(join(pkg, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh', version, bin: { dsh: 'lib/bin.js' } }))
    await writeFile(join(pkg, 'lib', 'bin.js'), `cli-${version}`)
    return pkg
  }
  return { api, layout, originalPackage, prefix, install }
}

test('POSIX入口切换用临时链接替换旧目标且不写Windows shim', { skip: process.platform === 'win32' }, async t => {
  const prefix = await mkdtemp(join(tmpdir(), 'maintain-posix-'))
  t.after(() => rm(prefix, { recursive: true, force: true }))
  const originalPackage = join(prefix, 'lib', 'node_modules', '@deepseek-ai', 'dsh')
  await mkdir(join(originalPackage, 'lib'), { recursive: true })
  await writeFile(join(originalPackage, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh', version: '1.0.0', bin: { dsh: 'lib/bin.js' } }))
  await writeFile(join(originalPackage, 'lib', 'bin.js'), 'original')
  const binDir = join(prefix, 'bin')
  await mkdir(binDir, { recursive: true })
  const entryPath = join(binDir, 'dsh')
  await symlink(join(originalPackage, 'lib', 'bin.js'), entryPath)
  const api = await import('../src/managed-layout.mjs')
  const layout = await api.createLayout({ prefix, originalPackage, platform: process.platform })
  await mkdir(layout.root, { recursive: true })
  const pkg = join(layout.a, 'node_modules', '@deepseek-ai', 'dsh')
  await mkdir(join(pkg, 'lib'), { recursive: true })
  await writeFile(join(pkg, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh', version: '2.0.0', bin: { dsh: 'lib/bin.js' } }))
  await writeFile(join(pkg, 'lib', 'bin.js'), 'candidate')
  await api.activateInstallation(layout, pkg, { runningPackage: originalPackage })
  assert.equal(await readlink(entryPath), relative(binDir, join(layout.link, 'lib', 'bin.js')))
  assert.equal(await realpath(layout.link), pkg)
})

test('Windows junction切换失败但外层恢复旧目标时不保留错误状态', { skip: process.platform !== 'win32' }, async t => {
  const f = await fixture(t, 'win32')
  const first = await f.install('a', '2.0.0')
  await f.api.activateInstallation(f.layout, first, { runningPackage: f.originalPackage })
  const originalTarget = await realpath(f.layout.link)
  const next = await f.install('b', '3.0.0')
  let failedOnce = true
  const failingSymlink = async (target, path, type) => {
    if (path === f.layout.link && failedOnce) {
      failedOnce = false
      const error = new Error('simulated junction creation failure')
      error.code = 'EIO'
      throw error
    }
    return symlink(target, path, type)
  }
  await assert.rejects(f.api.activateInstallation(f.layout, next, {
    runningPackage: first,
    symlinkImpl: failingSymlink,
  }), error => {
    assert.equal(error.rollbackFailed, false)
    return error.message.includes('simulated junction creation failure')
  })
  assert.equal(await realpath(f.layout.link), originalTarget)
})

test('POSIX槽位边界按原生分隔符接受合法安装目录', async t => {
  const f = await fixture(t)
  const slot = f.api.selectInactiveSlot
  const inactive = await slot(f.layout, f.originalPackage)
  await f.api.clearInactiveSlot(f.layout, inactive, f.originalPackage)
  assert.equal(await readdir(inactive).then(rows => rows.length), 0)
})

test('槽位清理不会跟随嵌套symlink删除槽外数据', async t => {
  const f = await fixture(t)
  const slot = await f.api.selectInactiveSlot(f.layout, f.originalPackage)
  const outside = join(f.prefix, 'outside-node-modules')
  await mkdir(outside, { recursive: true })
  await writeFile(join(outside, 'keep.txt'), 'keep')
  await mkdir(slot, { recursive: true })
  await mkdir(join(slot, 'node_modules'), { recursive: true })
  const linkKind = process.platform === 'win32' ? 'junction' : 'dir'
  await symlink(outside, join(slot, 'node_modules', 'external-link'), linkKind)
  await f.api.clearInactiveSlot(f.layout, slot, f.originalPackage)
  assert.equal(await readFile(join(outside, 'keep.txt'), 'utf8'), 'keep')
  assert.equal(await readdir(slot).then(rows => rows.length), 0)
})
test('初次接入只新增包内链接，原文件不改且命令入口目标在包内', async t => {
  const f = await fixture(t)
  const pkg = await f.install('a', '2.0.0')
  await f.api.activateInstallation(f.layout, pkg, { runningPackage: f.originalPackage })
  assert.equal(await readFile(join(f.originalPackage, 'lib/bin.js'), 'utf8'), 'original-cli')
  assert.equal(await realpath(f.layout.link), await realpath(pkg))
  for (const entry of f.layout.entryPaths) {
    const info = await lstat(entry)
    if (process.platform === 'win32') assert.ok(info.isFile())
    else {
      assert.ok(info.isSymbolicLink())
      assert.equal(await realpath(entry), join(f.layout.link, 'lib', 'bin.js'))
    }
    assert.ok(!(await readFile(entry, 'utf8')).includes('.dsh-maintain'))
  }
})

test('连续十轮升级交替复用A/B且不在当前目录安装', async t => {
  const f = await fixture(t)
  let running = f.originalPackage
  for (let n = 0; n < 10; n++) {
    const target = await f.api.selectInactiveSlot(f.layout, running)
    assert.equal(target, n % 2 === 0 ? f.layout.a : f.layout.b)
    await f.api.clearInactiveSlot(f.layout, target, running)
    const pkg = await f.install(n % 2 === 0 ? 'a' : 'b', `${n + 2}.0.0`)
    await f.api.activateInstallation(f.layout, pkg, { runningPackage: running })
    running = await realpath(f.layout.link)
  }
  assert.equal(await f.api.readSelectedVersion(f.layout), '11.0.0')
  const dirs = (await readdir(f.layout.root)).filter(n => n.startsWith('install-'))
  assert.deepEqual(dirs.sort(), ['install-a', 'install-b'])
})

test('运行路径与link不一致时拒绝再次升级，不能清理当前或链接目录', async t => {
  const f = await fixture(t)
  const pkg = await f.install('a', '2.0.0')
  await f.api.activateInstallation(f.layout, pkg, { runningPackage: f.originalPackage })
  await assert.rejects(f.api.selectInactiveSlot(f.layout, f.originalPackage), /不一致|退出/)
  await assert.rejects(f.api.clearInactiveSlot(f.layout, f.layout.a, pkg), /运行|引用/)
  assert.equal(await readFile(join(pkg, 'lib/bin.js'), 'utf8'), 'cli-2.0.0')
})

test('未知命令入口不改，切换失败保持原link', async t => {
  const f = await fixture(t)
  await writeFile(join(f.prefix, 'dsh.cmd'), 'custom unrelated launcher')
  const pkg = await f.install('a', '2.0.0')
  await assert.rejects(f.api.activateInstallation(f.layout, pkg, { runningPackage: f.originalPackage }), /入口|shim/)
  await assert.rejects(realpath(f.layout.link), { code: 'ENOENT' })
  assert.equal(await readFile(join(f.prefix, 'dsh.cmd'), 'utf8'), 'custom unrelated launcher')
})

test('实体dsh_link和备用目录symlink禁止删除，不跟随链接清理其它树', async t => {
  const f = await fixture(t)
  const other = join(f.prefix, 'untouched')
  await mkdir(other)
  await writeFile(join(other, 'proof'), 'keep')
  await symlink(other, f.layout.a, process.platform === 'win32' ? 'junction' : 'dir')
  await assert.rejects(f.api.clearInactiveSlot(f.layout, f.layout.a, f.originalPackage), /链接|真实目录/)
  assert.equal(await readFile(join(other, 'proof'), 'utf8'), 'keep')
  const pkg = await f.install('b', '2.0.0')
  if (process.platform === 'win32') await mkdir(f.layout.link)
  else await writeFile(f.layout.link, 'not a link')
  await assert.rejects(f.api.activateInstallation(f.layout, pkg, { runningPackage: f.originalPackage }), /链接|目录/)
})
test('bin路径变化候选拒绝，活动版本保持', async t => {
  const f = await fixture(t)
  const pkg = await f.install('a', '2.0.0')
  await writeFile(join(pkg, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh', version: '2.0.0', bin: { dsh: 'changed.js' } }))
  await assert.rejects(f.api.activateInstallation(f.layout, pkg, { runningPackage: f.originalPackage }), /bin|入口/)
  assert.equal(await readFile(join(f.originalPackage, 'lib/bin.js'), 'utf8'), 'original-cli')
})
