import { test } from 'node:test'
import assert from 'node:assert/strict'

const run = async options => {
  const api = await import('../src/managed-process.mjs')
  return api.runProcess(options)
}

test('argv执行保留特殊字符而不执行shell连接符', async () => {
  const result = await run({ executable: process.execPath, args: ['-e', 'console.log(process.argv[1])', 'x && echo injected $(bad)'], timeoutMs: 10 * 1000 })
  assert.equal(result.ok, true)
  assert.equal(result.stdoutTail.trim(), 'x && echo injected $(bad)')
})

test('安装非零失败和stderr可见', async () => {
  const result = await run({ executable: process.execPath, args: ['-e', 'console.error("failure"); process.exit(3)'], timeoutMs: 10 * 1000 })
  assert.equal(result.ok, false)
  assert.equal(result.code, 3)
  assert.match(result.stderrTail, /failure/)
})

test('超时终止本轮进程且禁止把unknown当成功', async () => {
  const result = await run({ executable: process.execPath, args: ['-e', 'setInterval(() => {}, 1000)'], timeoutMs: 300 })
  assert.equal(result.ok, false)
  assert.equal(result.timedOut, true)
})

test('不可启动可执行文件返回失败不挂起', async () => {
  const result = await run({ executable: 'missing-maintain-executable-xyz', args: [], timeoutMs: 10 * 1000 })
  assert.equal(result.ok, false)
  assert.match(result.stderrTail, /ENOENT/)
})
