import test from 'node:test'
import assert from 'node:assert/strict'
import { isEchoSimulatorCommandLine, killSimulators, reportSimulatorCleanupFailure, SIMULATOR_COMMAND_PATTERN } from './simulator-cleanup.mjs'

test('匹配新 echo simulator CLI 并拒绝旧入口及无关 Node 命令', () => {
  assert.equal(isEchoSimulatorCommandLine('node C:\\repo\\scripts\\echo-upstream\\cli.mjs --port 0'), true)
  assert.equal(isEchoSimulatorCommandLine('node /repo/scripts/echo-upstream/cli.mjs --port 0'), true)
  assert.equal(isEchoSimulatorCommandLine('node C:\\repo\\scripts\\echo-upstream.mjs --port 0'), false)
  assert.equal(isEchoSimulatorCommandLine('node C:\\repo\\scripts\\compat\\run.mjs'), false)
})

test('清理失败时记录 spawn error、stderr 或非零退出码', () => {
  for (const result of [
    { error: new Error('spawn denied'), status: null, stderr: '' },
    { status: 1, stderr: 'permission denied' },
    { status: 2, stderr: '' },
  ]) {
    const messages = []
    reportSimulatorCleanupFailure(result, (message) => messages.push(message))
    assert.equal(messages.length, 1)
    assert.match(messages[0], /模拟器清理失败:/)
    assert.ok(messages[0].length > 'keep-stop: 模拟器清理失败: '.length)
  }
  const messages = []
  reportSimulatorCleanupFailure({ status: 0, stderr: '' }, (message) => messages.push(message))
  assert.equal(messages.length, 0)
})

test('清理命令使用新入口筛选并逐进程传播停止错误', () => {
  const calls = []
  const result = killSimulators((...args) => { calls.push(args); return { status: 0, stderr: '' } })
  assert.equal(result.status, 0)
  assert.equal(calls.length, 1)
  assert.equal(calls[0][0], 'powershell')
  const command = calls[0][1].at(-1)
  assert.ok(command.includes(`Get-CimInstance -ClassName Win32_Process -Filter "Name='node.exe'"`))
  assert.ok(command.includes(SIMULATOR_COMMAND_PATTERN))
  assert.match(command, /Stop-Process -Id \$_.ProcessId -Force -ErrorAction Stop/)
})
