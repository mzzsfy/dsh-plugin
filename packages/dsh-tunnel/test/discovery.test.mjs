import test from 'node:test'
import assert from 'node:assert/strict'
import net from 'node:net'
import { once } from 'node:events'

import {
  parseWindowsNetstat,
  parseTasklist,
  parseSs,
  parseLsof,
  scanListeningPorts,
  probeTcpPort,
  resetDiscoveryCache,
} from '../src/discovery.mjs'

const WINDOWS_NETSTAT = `
活动连接

  协议  本地地址          外部地址        状态           PID
  TCP    0.0.0.0:8090           0.0.0.0:0              LISTENING       4242
  TCP    [::]:8090              [::]:0                 LISTENING       4242
  TCP    127.0.0.1:3080         0.0.0.0:0              LISTENING       1000
  TCP    0.0.0.0:445            0.0.0.0:0              LISTENING       4
`

const WINDOWS_TASKLIST = `
"collectord.exe","4242","Console","1","100,000 K"
"node.exe","1000","Console","1","100,000 K"
"System","4","Services","0","1 K"
`

test('Given Windows netstat 与 tasklist When 解析 Then 合并双栈同端口且映射进程', () => {
  // Given 同端口 IPv4/IPv6 两条监听 + PID 进程表
  const listeners = parseWindowsNetstat(WINDOWS_NETSTAT)
  const names = parseTasklist(WINDOWS_TASKLIST)
  // When 按 PID 合并
  const byPort = new Map()
  for (const item of listeners) {
    const entry = byPort.get(item.port) ?? { port: item.port, binds: [], pids: [] }
    entry.binds.push(item.bind)
    entry.pids.push(item.pid)
    byPort.set(item.port, entry)
  }
  // Then 同端口只留一条, IPv4/IPv6 都在, 进程名可查
  assert.equal(byPort.size, 3)
  assert.deepEqual(byPort.get(8090).binds.sort(), ['0.0.0.0', '::'])
  assert.equal(names.get(4242), 'collectord.exe')
  assert.equal(names.get(4), 'System')
})

test('Given Linux ss 输出 When 解析 Then 取监听地址与进程名', () => {
  const text = `
State  Recv-Q Send-Q Local Address:Port Peer Address:Port Process
LISTEN 0      511    127.0.0.1:5173      0.0.0.0:*         users:(("node",pid=777,fd=21))
LISTEN 0      128    [::1]:8080          [::]:*            users:(("java",pid=888,fd=9))
`
  const listeners = parseSs(text)
  assert.deepEqual(listeners, [
    { bind: '127.0.0.1', port: 5173, pid: 777, process: 'node' },
    { bind: '::1', port: 8080, pid: 888, process: 'java' },
  ])
})

test('Given macOS lsof 输出 When 解析 Then 取监听地址与命令名', () => {
  const text = `
COMMAND   PID USER   FD   TYPE             DEVICE SIZE/OFF NODE NAME
node    1234 user   20u  IPv4 0x123456789      0t0  TCP 127.0.0.1:3000 (LISTEN)
node    1234 user   21u  IPv6 0x123456789      0t0  TCP [::1]:3001 (LISTEN)
`
  const listeners = parseLsof(text)
  assert.deepEqual(listeners, [
    { bind: '127.0.0.1', port: 3000, pid: 1234, process: 'node' },
    { bind: '::1', port: 3001, pid: 1234, process: 'node' },
  ])
})

test('Given 注入的系统命令 When 扫描 Then 排除宿主端口且标记 dev 候选', async () => {
  resetDiscoveryCache()
  const calls = []
  const execFile = async (file, args) => {
    calls.push([file, ...args])
    if (file === 'netstat') return { stdout: WINDOWS_NETSTAT, stderr: '' }
    if (file === 'tasklist') return { stdout: WINDOWS_TASKLIST, stderr: '' }
    throw new Error('unexpected command: ' + file)
  }
  const result = await scanListeningPorts({ platform: 'win32', execFile, excludePorts: [3080] })
  assert.equal(result.supported, true)
  const byPort = new Map(result.items.map((item) => [item.port, item]))
  assert.deepEqual([...byPort.keys()], [445, 8090])
  assert.equal(byPort.get(8090).process, 'collectord.exe')
  assert.equal(byPort.get(8090).dev, true)
  assert.equal(byPort.get(8090).family, 'dual')
  assert.equal(byPort.get(445).dev, false)
  assert.equal(byPort.get(445).system, true)
  assert.equal(calls.filter(([file]) => file === 'netstat').length, 1)
})

test('Given 两次扫描 When 缓存未过期 Then 不重复执行系统命令, refresh 强制重扫', async () => {
  resetDiscoveryCache()
  let scans = 0
  const execFile = async (file) => {
    if (file === 'netstat') {
      scans += 1
      return { stdout: WINDOWS_NETSTAT, stderr: '' }
    }
    return { stdout: WINDOWS_TASKLIST, stderr: '' }
  }
  const first = await scanListeningPorts({ platform: 'win32', execFile })
  const second = await scanListeningPorts({ platform: 'win32', execFile })
  assert.equal(scans, 1)
  assert.equal(second.scannedAt, first.scannedAt)
  await scanListeningPorts({ platform: 'win32', execFile, refresh: true })
  assert.equal(scans, 2)
})

test('Given 系统命令不可用 When 扫描 Then supported:false 且不抛出', async () => {
  resetDiscoveryCache()
  const result = await scanListeningPorts({
    platform: 'win32',
    execFile: async () => { throw Object.assign(new Error('missing'), { code: 'ENOENT' }) },
  })
  assert.equal(result.supported, false)
  assert.equal(result.reason, '当前平台无法读取监听端口')
  assert.deepEqual(result.items, [])
  assert.equal(typeof result.scannedAt, 'string')
})

test('Given 已关闭端口 When TCP 探测 Then 有界返回 offline', async () => {
  const server = net.createServer()
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const port = server.address().port
  await new Promise((resolve) => server.close(resolve))
  const probe = await probeTcpPort(port, { timeoutMs: 300 })
  assert.equal(probe.state, 'offline')
  assert.equal(typeof probe.checkedAt, 'string')
  assert.equal(probe.latencyMs, null)
})

test('Given 真实监听端口 When TCP 探测 Then 返回 online 与耗时', async () => {
  const server = net.createServer()
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const port = server.address().port
  try {
    const probe = await probeTcpPort(port, { timeoutMs: 300 })
    assert.equal(probe.state, 'online')
    assert.equal(typeof probe.latencyMs, 'number')
  } finally {
    server.close()
  }
})
