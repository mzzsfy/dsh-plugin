import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { readFile } from 'node:fs/promises'

// 仅替换进程/时钟边界,执行实际 runner 源码,不在测试重写终止控制流。
const source = (await readFile(new URL('../src/shell-runner.mjs', import.meta.url), 'utf8'))
  .replace("import { spawn } from 'node:child_process'", '')
  .replace('export function createShellRunner', 'function createShellRunner')
const load = new Function('spawn', 'process', 'setTimeout', 'clearTimeout', source + '\nreturn createShellRunner')

for (const closeBeforeGrace of [false, true]) {
  test(`POSIX Given TERM ignored by descendant after parent exit, When grace expires, Then whole group gets KILL (earlyClose=${closeBeforeGrace})`, async () => {
    const child = Object.assign(new EventEmitter(), { pid: 12345, exitCode: null, signalCode: null, stdout: new PassThrough(), stderr: new PassThrough() })
    const signals = [], direct = [], timers = new Map()
    child.kill = (signal) => direct.push(signal)
    const processBoundary = { platform: 'linux', env: {}, kill: (pid, signal) => signals.push([pid, signal]) }
    const schedule = (fn, ms) => { const timer = { unref() { return this } }; timers.set(timer, { fn, ms }); return timer }
    const fire = (ms) => {
      const item = [...timers].find(([, value]) => value.ms === ms)
      assert.ok(item, 'missing expected timer ' + ms)
      timers.delete(item[0]); item[1].fn()
    }
    const create = load(() => child, processBoundary, schedule, (id) => timers.delete(id))
    const runner = create({ workdirFallback: '/isolated' })
    const pending = runner.run({ job: { command: 'fixture', timeoutMs: 100 }, env: {}, logSink: { append() {} } })
    fire(100)
    assert.deepEqual(signals, [[-12345, 'SIGTERM']])
    child.exitCode = 0
    if (closeBeforeGrace) child.emit('close', 0)
    fire(5 * 1000)
    assert.deepEqual(signals, [[-12345, 'SIGTERM'], [-12345, 'SIGKILL']])
    assert.deepEqual(direct, [], 'group termination must not kill only the departed parent')
    if (!closeBeforeGrace) child.emit('close', 0)
    assert.equal((await pending).status, 'timeout')
    assert.equal(timers.size, 0)
    child.stdout.destroy(); child.stderr.destroy()
  })
}
