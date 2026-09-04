// 回收站命令构造测试:平台分支与参数、执行失败传播;Windows 上补一条真实执行。

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, rm, access } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { TRASH_ENV_NAME, trashCommandFor, trashPath } from '../src/trash.mjs'

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
