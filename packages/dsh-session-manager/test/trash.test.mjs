// 回收站命令构造测试:平台分支与参数、执行失败传播;Windows 上补一条真实执行。

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, rm, access } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { trashCommandFor, trashPath } from '../src/trash.mjs'

test('Windows 走 PowerShell VisualBasic 回收站', () => {
  const cmd = trashCommandFor('win32', 'C:\\logs\\a.jsonl')
  assert.equal(cmd.file, 'powershell.exe')
  assert.ok(cmd.args.at(-1) === 'C:\\logs\\a.jsonl')
  assert.ok(cmd.args.some((arg) => arg.includes('SendToRecycleBin')))
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
