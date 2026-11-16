// 构建期 STOP:pnpm install 是分钟级长任务,必须能被 STOP 中止(否则 keeper 等外部
// 15s 强杀,finally 跳过,锁与半装 profile 留场)。runCmd 提供轮询中止口,buildProfile 接线。
import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runCmd } from '../scripts/compat/lib.mjs'
import { buildProfile } from '../scripts/compat/profile.mjs'

function workDir(t) {
  const root = mkdtempSync(join(tmpdir(), 'compat-build-stop-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  return root
}

test('runCmd:shouldAbort 轮询为真时杀子进程并以 STOPPED 拒绝', async (t) => {
  const root = workDir(t)
  const script = join(root, 'sleep.mjs')
  writeFileSync(script, 'setTimeout(() => {}, 30000)\n')
  const started = Date.now()
  let polls = 0
  await assert.rejects(
    runCmd(process.execPath, [script], { shouldAbort: () => { polls += 1; return polls >= 2 }, abortPollMs: 20 }),
    (error) => {
      assert.equal(error.code, 'STOPPED')
      assert.match(error.message, /被 STOP 中止/)
      return true
    },
  )
  assert.ok(Date.now() - started < 15_000, '中止必须立即生效,不得等子进程自然结束')
})

test('runCmd:未中止时正常返回 stdout', async (t) => {
  const root = workDir(t)
  const script = join(root, 'print.mjs')
  writeFileSync(script, 'process.stdout.write("ok")\n')
  const result = await runCmd(process.execPath, [script])
  assert.equal(result.stdout, 'ok')
})

test('buildProfile:构建前已 STOP 直接抛 STOPPED,不落任何目录', async (t) => {
  const root = workDir(t)
  await assert.rejects(
    buildProfile({
      version: '0.2.2-rc.1',
      workRoot: root,
      hostDir: join(root, 'host'),
      stop: () => true,
      deps: { probeUnpublished: async () => new Set(), runCmd: async () => ({ stdout: '', stderr: '' }) },
    }),
    (error) => {
      assert.equal(error.code, 'STOPPED')
      return true
    },
  )
  assert.equal(existsSync(join(root, '0.2.2-rc.1')), false, 'STOP 早退不得留下半装目录')
})

test('buildProfile:pnpm 安装阶段把 stop 作为 shouldAbort 传入', async (t) => {
  const root = workDir(t)
  let captured = null
  let probed = 0
  const stop = () => false
  await assert.rejects(
    buildProfile({
      version: '0.2.2-rc.1',
      workRoot: root,
      hostDir: join(root, 'no-host'),
      stop,
      deps: {
        probeUnpublished: async () => { probed += 1; return new Set() },
        runCmd: async (name, args, options) => {
          captured = { name, args, options }
          throw new Error('fake pnpm')
        },
      },
    }),
    /fake pnpm/,
  )
  assert.equal(probed, 1)
  assert.equal(captured.name, 'pnpm')
  assert.deepEqual(captured.args, ['install'])
  assert.equal(captured.options.shouldAbort, stop, '安装阶段必须接线 stop 轮询')
})
