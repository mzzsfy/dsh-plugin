import test from 'node:test'
import assert from 'node:assert/strict'
import { isEchoSimulatorCommandLine, listNodeProcesses, listPortOwners } from './simulator-cleanup.mjs'

test('匹配新 echo simulator CLI 并拒绝旧入口及无关 Node 命令', () => {
  assert.equal(isEchoSimulatorCommandLine('node C:\\repo\\scripts\\echo-upstream\\cli.mjs --port 0'), true)
  assert.equal(isEchoSimulatorCommandLine('node /repo/scripts/echo-upstream/cli.mjs --port 0'), true)
  assert.equal(isEchoSimulatorCommandLine('node C:\\repo\\scripts\\echo-upstream.mjs --port 0'), false)
  assert.equal(isEchoSimulatorCommandLine('node C:\\repo\\scripts\\compat\\run.mjs'), false)
})

test('进程表:win32 经 CIM 取 node 命令行,单条 JSON 也成数组', () => {
  const calls = []
  const processes = listNodeProcesses({
    platform: 'win32',
    spawn: (...args) => {
      calls.push(args)
      return { status: 0, stdout: JSON.stringify({ ProcessId: 7, CommandLine: 'node cli.mjs' }) }
    },
  })
  assert.deepEqual(processes, [{ pid: 7, commandLine: 'node cli.mjs' }])
  assert.equal(calls[0][0], 'powershell')
  const command = calls[0][1].at(-1)
  assert.ok(command.includes(`Get-CimInstance -ClassName Win32_Process -Filter "Name='node.exe'"`))
  assert.ok(command.includes('Select-Object ProcessId, CommandLine'))
  assert.ok(command.includes('ConvertTo-Json -Compress'))
})

test('进程表:数组 JSON 全收,损坏输出与非零退出降级为空', () => {
  const processes = listNodeProcesses({
    platform: 'win32',
    spawn: () => ({ status: 0, stdout: JSON.stringify([{ ProcessId: 1, CommandLine: 'a' }, { ProcessId: 2, CommandLine: 'b' }, { ProcessId: null }]) }),
  })
  assert.deepEqual(processes.map((process) => process.pid), [1, 2])
  assert.deepEqual(listNodeProcesses({ platform: 'win32', spawn: () => ({ status: 0, stdout: 'not json' }) }), [])
  assert.deepEqual(listNodeProcesses({ platform: 'win32', spawn: () => ({ status: 1, stdout: '' }) }), [])
  assert.deepEqual(listNodeProcesses({ platform: 'win32', spawn: () => ({ error: new Error('denied'), status: null }) }), [])
})

test('进程表:posix 解析 ps 行', () => {
  const processes = listNodeProcesses({
    platform: 'linux',
    spawn: (...args) => {
      assert.deepEqual(args.slice(0, 2), ['ps', ['-eo', 'pid=,args=']])
      return { status: 0, stdout: '  111 node a.mjs --port 5000\n  222 node b.mjs\n' }
    },
  })
  assert.deepEqual(processes, [
    { pid: 111, commandLine: 'node a.mjs --port 5000' },
    { pid: 222, commandLine: 'node b.mjs' },
  ])
})

test('端口属主:win32 经 Get-NetTCPConnection 取监听进程', () => {
  const calls = []
  const owners = listPortOwners(54321, {
    platform: 'win32',
    spawn: (...args) => {
      calls.push(args)
      return { status: 0, stdout: '123\r\n456\r\n' }
    },
  })
  assert.deepEqual(owners, [123, 456])
  assert.match(calls[0][1].at(-1), /Get-NetTCPConnection -LocalPort 54321 -State Listen/)
})

test('端口属主:posix 走 lsof,非零退出与非法端口降级为空', () => {
  const owners = listPortOwners(54321, { platform: 'linux', spawn: () => ({ status: 0, stdout: '789\n' }) })
  assert.deepEqual(owners, [789])
  assert.deepEqual(listPortOwners(54321, { platform: 'linux', spawn: () => ({ status: 1, stdout: '' }) }), [])
  let called = 0
  assert.deepEqual(listPortOwners(0, { platform: 'linux', spawn: () => { called++; return { status: 0, stdout: '' } } }), [])
  assert.equal(called, 0)
})
