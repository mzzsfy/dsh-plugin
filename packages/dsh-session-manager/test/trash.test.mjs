// 回收站命令构造测试:平台分支与参数、执行失败传播;Windows 上补一条真实执行。

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile, rm, access } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { TRASH_ENV_NAME, moveToQuarantine, restoreFromQuarantine, trashCommandFor, trashPath } from '../src/trash.mjs'

test('Windows 走 PowerShell VisualBasic 回收站,路径经环境变量传递', () => {
  const cmd = trashCommandFor('win32', 'C:\\logs\\a.jsonl')
  assert.equal(cmd.file, 'powershell.exe')
  assert.equal(cmd.env[TRASH_ENV_NAME], 'C:\\logs\\a.jsonl')
  assert.ok(cmd.args.some((arg) => arg.includes('SendToRecycleBin')))
  // 路径不得进入 argv:-Command 会把 argv 空格重拼接进命令文本,存在断裂与注入面
  assert.ok(cmd.args.every((arg) => arg !== 'C:\\logs\\a.jsonl'))
})

test('macOS 走 Finder 回收站', () => {
  const cmd = trashCommandFor('darwin', '/tmp/a.jsonl')
  assert.equal(cmd.file, 'osascript')
  assert.ok(cmd.args.includes('/tmp/a.jsonl'))
})

test('Linux 走 gio trash', () => {
  const cmd = trashCommandFor('linux', '/tmp/a.jsonl')
  assert.equal(cmd.file, 'gio')
  assert.deepEqual(cmd.args, ['trash', '/tmp/a.jsonl'])
})

test('Windows 脚本按 PSIsContainer 分派 DeleteDirectory / DeleteFile', () => {
  const cmd = trashCommandFor('win32', 'C:\\logs\\a.jsonl')
  const script = cmd.args.find((arg) => arg.includes('DeleteDirectory'))
  assert.ok(script.includes('PSIsContainer'))
  assert.ok(script.includes('DeleteFile'))
  assert.ok(script.includes('exit 1'))
  // 脚本从环境变量取路径:变量名与宿主半区约定一致
  assert.ok(script.includes('$env:' + TRASH_ENV_NAME))
})

test('trashPath 真实执行:文件进入回收站且原路径消失(仅 Windows)', { skip: process.platform !== 'win32' }, async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'dsh-trash-test-'))
  const file = path.join(dir, 'a.jsonl')
  try {
    await writeFile(file, '{"header":1}\n')
    await trashPath(file)
    await assert.rejects(access(file))
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('trashPath 真实执行:含空格路径完整回收(-Command 空格重拼接不再破坏路径)', { skip: process.platform !== 'win32' }, async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'dsh trash test '))
  const file = path.join(dir, 'a b.jsonl')
  try {
    await writeFile(file, '{"header":1}\n')
    await trashPath(file)
    await assert.rejects(access(file))
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('trashPath 向执行器传递超时配置', async () => {
  const captured = []
  const run = async (file, args, options) => { captured.push(options) }
  await trashPath('C:\\x\\a.jsonl', { platform: 'linux', run })
  assert.equal(captured[0].timeout, 60 * 1000)
  await trashPath('C:\\x\\a.jsonl', { platform: 'linux', run, timeoutMs: 5 * 1000 })
  assert.equal(captured[1].timeout, 5 * 1000)
})

// Given 回收区目录不存在与同名基名, When moveToQuarantine, Then 目录整体搬入回收区
// 且返回唯一暂存路径(原路径消失,暂存路径存在)
test('moveToQuarantine:目录整体搬入回收区并返回暂存路径(真实 rename)', { skip: process.platform !== 'win32' && process.platform !== 'linux' && process.platform !== 'darwin' }, async () => {
  const base = await mkdtemp(path.join(tmpdir(), 'dsh-quarantine-'))
  const quarantineDir = path.join(base, 'held')
  const artifactDir = path.join(base, 'sess-1')
  await mkdir(path.join(artifactDir, 'inner'), { recursive: true })
  await writeFile(path.join(artifactDir, 'inner', 'a.jsonl'), '{"header":1}\n')
  try {
    const heldPath = await moveToQuarantine(artifactDir, quarantineDir)
    assert.ok(heldPath.startsWith(quarantineDir), '暂存路径应在回收区目录内')
    await assert.rejects(access(artifactDir), '原路径应消失')
    const moved = await readFile(path.join(heldPath, 'inner', 'a.jsonl'), 'utf8')
    assert.equal(moved, '{"header":1}\n')
  } finally {
    await rm(base, { recursive: true, force: true })
  }
})

// Given rename 因跨设备失败(EXDEV), When moveToQuarantine, Then 回退为复制后删除原路径
test('moveToQuarantine:EXDEV 回退复制+删除(注入 fs)', async () => {
  const calls = []
  const fakeFs = {
    rename: async (from, to) => {
      calls.push(['rename', from, to])
      throw Object.assign(new Error('cross-device'), { code: 'EXDEV' })
    },
    cp: async (from, to) => { calls.push(['cp', from, to]) },
    rm: async (target) => { calls.push(['rm', target]) },
    mkdir: async () => { calls.push(['mkdir']) },
  }
  const heldPath = await moveToQuarantine('/data/sess-1', '/home/.dsh/held', { fs: fakeFs, now: () => 1234 })
  assert.equal(heldPath, path.join('/home/.dsh/held', 'sess-1-1234'))
  assert.deepEqual(calls, [
    ['mkdir'],
    ['rename', '/data/sess-1', heldPath],
    ['cp', '/data/sess-1', heldPath],
    ['rm', '/data/sess-1'],
  ])
})

// Given 回收区暂存的目录与空缺的原位置, When restoreFromQuarantine, Then 目录回到原位置且暂存消失
test('restoreFromQuarantine:移回原位置且暂存消失(真实 rename)', { skip: process.platform !== 'win32' && process.platform !== 'linux' && process.platform !== 'darwin' }, async () => {
  const base = await mkdtemp(path.join(tmpdir(), 'dsh-quarantine-'))
  const quarantineDir = path.join(base, 'held')
  const originalDir = path.join(base, 'sess-2')
  await mkdir(path.join(originalDir, 'inner'), { recursive: true })
  await writeFile(path.join(originalDir, 'inner', 'a.jsonl'), '{"header":1}\n')
  try {
    const heldPath = await moveToQuarantine(originalDir, quarantineDir)
    await restoreFromQuarantine(heldPath, originalDir)
    await assert.rejects(access(heldPath), '暂存路径应消失')
    const restored = await readFile(path.join(originalDir, 'inner', 'a.jsonl'), 'utf8')
    assert.equal(restored, '{"header":1}\n')
  } finally {
    await rm(base, { recursive: true, force: true })
  }
})

// Given rename 因原位置已被占用而失败, When restoreFromQuarantine, Then 错误原样抛出由调用方响应
test('restoreFromQuarantine:原位置已存在时失败上抛(注入 fs)', async () => {
  const occupied = Object.assign(new Error('not empty'), { code: 'ENOTEMPTY' })
  const fakeFs = {
    rename: async () => { throw occupied },
    cp: async () => { throw new Error('不应回退复制') },
    rm: async () => { throw new Error('不应删除') },
    mkdir: async () => {},
  }
  await assert.rejects(restoreFromQuarantine('/held/s1', '/data/s1', { fs: fakeFs }), (error) => error.code === 'ENOTEMPTY')
})
