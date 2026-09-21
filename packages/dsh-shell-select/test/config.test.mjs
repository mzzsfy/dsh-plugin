// config 设置 schema 与 argv 组装:BDD 场景见 docs/progress/shell-select-plan.md「模块 config」。
// schemastery schema 走真实官方包验证默认值与校验行为。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Config, defaultConfig, entryById, requireEntry, buildArgv, KINDS, RESOLVED_AUTO } from '../src/config.mjs'

test('schema 应用出厂默认:三客户端 + 默认 pwsh', () => {
  const applied = Config({})
  assert.deepEqual(applied, defaultConfig())
  assert.equal(applied.default, 'pwsh')
  assert.deepEqual(applied.shells.map((entry) => entry.id), ['pwsh', 'git-bash', 'cmd'])
  for (const entry of applied.shells) {
    assert.equal(entry.path, '')
    assert.ok(KINDS.includes(entry.kind))
  }
})

test('schema 拒绝未知 kind;default 跨字段一致性由 validate hook 与 requireEntry 兜底', () => {
  assert.throws(() => Config({ shells: [{ id: 'x', name: 'X', kind: 'fish', path: '' }], default: 'x' }))
})

test('pwsh argv:非交互形 + 编码前缀', () => {
  const argv = buildArgv({ kind: 'pwsh', path: 'C:\\pf\\pwsh.exe' }, 'Get-Item .')
  assert.deepEqual(argv, [
    'C:\\pf\\pwsh.exe',
    '-NoLogo', '-NoProfile', '-NonInteractive', '-Command',
    '[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); $OutputEncoding = [System.Text.UTF8Encoding]::new($false); Get-Item .',
  ])
})

test('bash argv:-c 直传', () => {
  assert.deepEqual(buildArgv({ kind: 'bash', path: 'C:\\Git\\bin\\bash.exe' }, 'ls -la'), [
    'C:\\Git\\bin\\bash.exe', '-c', 'ls -la',
  ])
})

test('cmd argv:/d /s /c 忽略 AutoRun', () => {
  assert.deepEqual(buildArgv({ kind: 'cmd', path: 'C:\\S32\\cmd.exe' }, 'dir'), [
    'C:\\S32\\cmd.exe', '/d', '/s', '/c', 'dir',
  ])
})

test('wsl argv:--exec 绕过默认 shell', () => {
  assert.deepEqual(buildArgv({ kind: 'wsl', path: 'C:\\S32\\wsl.exe' }, 'uname -a'), [
    'C:\\S32\\wsl.exe', '--exec', 'bash', '-c', 'uname -a',
  ])
})

test('自定义 args 模板:{command} 占位替换', () => {
  const argv = buildArgv({ kind: 'bash', path: 'C:\\x\\fish.exe', args: ['--login', '-c', '{command}'] }, 'echo hi')
  assert.deepEqual(argv, ['C:\\x\\fish.exe', '--login', '-c', 'echo hi'])
})

test('自定义 args 模板:无占位则追加末项', () => {
  const argv = buildArgv({ kind: 'bash', path: 'C:\\x\\sh.exe', args: ['-s'] }, 'echo hi')
  assert.deepEqual(argv, ['C:\\x\\sh.exe', '-s', 'echo hi'])
})

test('entryById 按 id 取条目', () => {
  const shells = [
    { id: 'a', name: 'A', kind: 'bash', path: '' },
    { id: 'b', name: 'B', kind: 'cmd', path: '' },
  ]
  assert.equal(entryById(shells, 'b'), shells[1])
  assert.equal(entryById(shells, 'zz'), undefined)
})

test('requireEntry:缺省用 default,default 缺失报配置指引', () => {
  const shells = [
    { id: 'a', name: 'A', kind: 'bash', path: '' },
    { id: 'b', name: 'B', kind: 'cmd', path: '' },
  ]
  assert.equal(requireEntry(shells, undefined, 'b'), shells[1])
  assert.equal(requireEntry(shells, 'a', 'b'), shells[0])
  assert.throws(() => requireEntry(shells, undefined, undefined), /default.*shell-select|shell-select.*default/is)
  assert.throws(() => requireEntry(shells, 'zz', 'b'), /zz/)
})

test('kind 常量与自动解析标记', () => {
  assert.deepEqual(KINDS, ['pwsh', 'bash', 'cmd', 'wsl'])
  assert.equal(RESOLVED_AUTO, '')
})
