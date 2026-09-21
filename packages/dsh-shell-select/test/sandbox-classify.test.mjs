// sandbox-classify 官方镜像:BDD 场景见 docs/progress/shell-select-plan.md「模块 sandbox-classify」。
// 逐项对照 dsh-pwsh-sandbox lib/index.js helpers,签名词表对齐官方 dsh-sandbox-local。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { classifyDenial, classifyRunnerFailure, isRunnerSpawnFailure, isUsableWorkdir } from '../src/sandbox-classify.mjs'

const SIG = ['file access denied', 'EPERM: operation not permitted']

test('denial:非零退出 + stderr 命中签名(大小写不敏感)', () => {
  assert.equal(classifyDenial({ exitCode: 1, stderr: { text: 'bash: /x: File Access Denied\r\n' } }, SIG), true)
})

test('denial:零退出或信号死亡不判拒绝', () => {
  assert.equal(classifyDenial({ exitCode: 0, stderr: { text: 'file access denied' } }, SIG), false)
  assert.equal(classifyDenial({ exitCode: null, stderr: { text: 'file access denied' } }, SIG), false)
})

const RULES = [
  {
    allowedExitCodes: [126],
    informationalLines: ['info: harmless'],
    fatalSignatures: ['cannot run runner'],
  },
  { fatalSignatures: ['runner died'] },
]

test('runnerFailure:允许码外 + 致命行命中;信息行豁免;非允许码跳过', () => {
  assert.deepEqual(
    classifyRunnerFailure(126, 'info: harmless\ncannot run runner: boom\n', RULES),
    { detail: 'cannot run runner: boom' },
  )
  assert.equal(classifyRunnerFailure(999, 'nothing fatal here\n', RULES), undefined)
  assert.deepEqual(
    classifyRunnerFailure(2, 'some prefix runner died\n', RULES),
    { detail: 'some prefix runner died' },
  )
})

test('runnerFailure:零退出与信号死亡不判失败', () => {
  assert.equal(classifyRunnerFailure(0, 'runner died\n', RULES), undefined)
  assert.equal(classifyRunnerFailure(null, 'runner died\n', RULES), undefined)
})

test('runnerSpawnFailure:ENOENT/EACCES + spawn 系统调用 + argv0 溯源', () => {
  const workdir = process.cwd()
  assert.equal(isRunnerSpawnFailure(
    { code: 'ENOENT', syscall: 'spawn C:\\runner\\wrap.exe', path: 'C:\\runner\\wrap.exe' },
    'C:\\runner\\wrap.exe', workdir,
  ), true)
  assert.equal(isRunnerSpawnFailure(
    { code: 'EACCES', syscall: 'spawn C:\\runner\\wrap.exe' },
    'C:\\runner\\wrap.exe', workdir,
  ), true)
})

test('runnerSpawnFailure:其他码/其他路径/坏 cwd 不判 runner 失败', () => {
  const workdir = process.cwd()
  assert.equal(isRunnerSpawnFailure({ code: 'EACCES', syscall: 'spawn' }, undefined, workdir), false)
  assert.equal(isRunnerSpawnFailure({ code: 'ENOENT', syscall: 'spawn', path: 'C:\\other.exe' }, 'C:\\runner\\wrap.exe', workdir), false)
  assert.equal(isRunnerSpawnFailure({ code: 'EACCES', syscall: 'spawn x' }, 'C:\\runner\\wrap.exe', 'Z:\\definitely\\missing'), false)
})

test('isUsableWorkdir:存在目录 true,缺失 false', () => {
  assert.equal(isUsableWorkdir(process.cwd()), true)
  assert.equal(isUsableWorkdir('Z:\\definitely\\missing'), false)
})
