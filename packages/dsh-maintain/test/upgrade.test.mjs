import { test } from 'node:test'
import assert from 'node:assert/strict'

import { runUpgrade } from '../src/upgrade.mjs'

// 脚本体一律单引号:Windows shell 化 spawn 经 cmd.exe,双层双引号会被截断。
const NODE = 'node'
const OK_SCRIPT = 'process.exit(0)'
const FAIL_SCRIPT = "console.error('boom-fail'); process.exit(3)"
const STDOUT_SCRIPT = "console.log('out-line-1'); console.log('out-line-2')"
const HANG_SCRIPT = 'setTimeout(() => {}, 60 * 1000)'

test('场景:shell 化执行 命令串含连接符与参数可运行', async () => {
  // shell:false 会把整串当可执行文件路径(POSIX 必 ENOENT);此用例锁死 shell 化语义
  const result = await runUpgrade({ command: NODE + ' -e "process.stdout.write(\'chain-ok\')"' + ' && echo done', timeoutMs: 30 * 1000 })
  assert.equal(result.ok, true)
  assert.match(result.stdoutTail, /chain-ok/)
  assert.match(result.stdoutTail, /done/)
})

test('场景:升级命令成功完成', async () => {
  const result = await runUpgrade({ command: NODE + ' -e "' + OK_SCRIPT + '"', timeoutMs: 30 * 1000 })
  assert.equal(result.ok, true)
  assert.equal(result.code, 0)
  assert.equal(result.timedOut, false)
  assert.equal(result.stderrTail, '')
})

test('场景:升级失败可见 非零码与 stderr 摘要', async () => {
  const result = await runUpgrade({ command: NODE + ' -e "' + FAIL_SCRIPT + '"', timeoutMs: 30 * 1000 })
  assert.equal(result.ok, false)
  assert.equal(result.code, 3)
  assert.match(result.stderrTail, /boom-fail/)
})

test('场景:stdout 内容被收集', async () => {
  const result = await runUpgrade({ command: NODE + ' -e "' + STDOUT_SCRIPT + '"', timeoutMs: 30 * 1000 })
  assert.equal(result.ok, true)
  assert.match(result.stdoutTail, /out-line-1/)
  assert.match(result.stdoutTail, /out-line-2/)
})

test('场景:命令超时被强制终止', async () => {
  const startedAt = Date.now()
  const result = await runUpgrade({ command: NODE + ' -e "' + HANG_SCRIPT + '"', timeoutMs: 2 * 1000 })
  assert.equal(result.ok, false)
  assert.equal(result.timedOut, true)
  assert.ok(Date.now() - startedAt < 30 * 1000, '超时后应立即终止而不是等满挂起时长')
})

test('场景:超长输出截尾保留末尾', async () => {
  const result = await runUpgrade({
    command: NODE + " -e \"console.log(Array(100).fill('x-line-0123456789').join('\\n'))\"",
    timeoutMs: 30 * 1000,
  })
  assert.equal(result.ok, true)
  assert.ok(result.stdoutTail.length <= 2000)
  assert.match(result.stdoutTail, /x-line-0123456789$/)
})

test('场景:命令不存在失败不抛错', async () => {
  const result = await runUpgrade({ command: 'definitely-not-exist-cmd-xyz --version', timeoutMs: 10 * 1000 })
  assert.equal(result.ok, false)
})
