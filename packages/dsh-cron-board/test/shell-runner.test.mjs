// ShellRunner 测试:child_process 真实 spawn,跨平台用 node -e 构造用例。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createShellRunner } from '../src/shell-runner.mjs'

// 便捷断言:等待执行结束并收集日志
async function runAndCollect(runner, { command, env, timeoutMs, workdir }) {
  const chunks = []
  const outcome = await runner.run({
    job: { command, workdir, timeoutMs: timeoutMs ?? 10 * 1000 },
    env: env || {},
    logSink: { append: (chunk) => { chunks.push(chunk) } },
  })
  return { outcome, log: chunks.join('') }
}

test('shell-runner:命令成功退出码 0 记 success,输出进日志', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'cron-board-runner-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const runner = createShellRunner({ workdirFallback: dir })
  // When 执行成功命令
  const { outcome, log } = await runAndCollect(runner, { command: `${process.execPath} -e "console.log('marker-ok')"` })
  // Then success 且日志含输出
  assert.equal(outcome.status, 'success')
  assert.equal(outcome.exitCode, 0)
  assert.match(log, /marker-ok/)
})

test('shell-runner:非零退出记 fail 并保留退出码', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'cron-board-runner-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const runner = createShellRunner({ workdirFallback: dir })
  // When 执行 exit 3
  const { outcome, log } = await runAndCollect(runner, { command: `${process.execPath} -e "process.stderr.write('bad'); process.exit(3)"` })
  // Then fail 且 stderr 合流入日志
  assert.equal(outcome.status, 'fail')
  assert.equal(outcome.exitCode, 3)
  assert.match(log, /bad/)
})

test('shell-runner:环境变量注入叠加 process.env 基础之上', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'cron-board-runner-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const runner = createShellRunner({ workdirFallback: dir })
  // When 注入 CB_TEST_VAR 并回读 env 与基础 PATH
  const { log } = await runAndCollect(runner, {
    command: `${process.execPath} -e "console.log('V=' + process.env.CB_TEST_VAR); console.log('HAS_PATH=' + Boolean(process.env.PATH))"`,
    env: { CB_TEST_VAR: 'injected' },
  })
  // Then 注入值可见且基础 env 未丢
  assert.match(log, /V=injected/)
  assert.match(log, /HAS_PATH=true/)
})

test('shell-runner:workdir 作为子进程 cwd', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'cron-board-runner-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const runner = createShellRunner({ workdirFallback: dir })
  // When 声明 workdir 执行回显 cwd
  const { log } = await runAndCollect(runner, {
    command: `${process.execPath} -e "console.log(process.cwd())"`,
    workdir: dir,
  })
  // Then cwd 即声明目录
  assert.match(log, new RegExp(dir.replace(/[/\\]/g, '[/\\\\]')))
})

test('shell-runner:超时终止进程记 timeout', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'cron-board-runner-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const runner = createShellRunner({ workdirFallback: dir })
  // When 运行长任务且 timeoutMs 极短
  const started = Date.now()
  const { outcome, log } = await runAndCollect(runner, {
    command: `${process.execPath} -e "console.log('started'); setTimeout(() => {}, 60000)"`,
    timeoutMs: 500,
  })
  // Then timeout 且进程被提前终止
  assert.equal(outcome.status, 'timeout')
  assert.ok(Date.now() - started < 30 * 1000)
  assert.match(log, /started/)
})
