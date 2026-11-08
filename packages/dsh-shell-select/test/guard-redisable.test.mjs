// 写事务翻回官方行(HOST-022):guard 必须先尝试重新禁用并保持接管,
// 只有禁用失败才让位。让位会 dispose 执行器,把 shell 工具一起撤掉(0.2.2 真机事故)。
// BDD:
// - Given 执行器在场、官方行被写事务翻回启用,When patch-context 到达,Then 该行被重新禁用且执行器不退役;
// - Given 重新禁用被宿拒绝,When patch-context 到达,Then 让位(执行器退役)保官方链自服务;
// - Given 重新禁用成功,When 再次翻回(超过上限),Then 停止重试转为让位,不无限循环。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { installGuard } from '../src/guard.js'
import { MAIN_ROW_ID } from '../src/guard-state.mjs'
import { shellSelectExecutorFiber } from '../src/apply-state.mjs'

function row({ id, disabled = false, running = false }) {
  const entry = {
    options: { id },
    disabled,
    fiber: running ? { uid: 'f' } : undefined,
    updates: [],
    get disabled() {
      return entry._disabled
    },
    set disabled(value) {
      entry._disabled = value
    },
    async update(patch) {
      entry.updates.push(patch)
      if (entry.rejectUpdate === true) throw new Error('rejected')
      entry._disabled = patch.disabled
    },
  }
  entry._disabled = disabled
  return entry
}

function stubCtx(rows) {
  const listeners = new Map()
  const log = []
  const ctx = {
    logger: { warn: (msg) => log.push(msg), error: (msg) => log.push(msg), info: () => {} },
    loader: {
      resolve(id) {
        const found = rows.find((candidate) => candidate.options.id === id)
        if (found) return found
        throw new Error('not found')
      },
    },
    on(event, handler) {
      listeners.set(event, handler)
    },
    plugin: () => Promise.resolve({ dispose: () => Promise.resolve() }),
    effect: (execute) => execute(),
  }
  return { ctx, listeners, log }
}

const silent = { importOfficial: async () => ({ apply() {} }), delay: async () => {}, sweepIntervalMs: 3600 * 1000 }

function takeoverWorld() {
  return [
    row({ id: MAIN_ROW_ID, disabled: false, running: true }),
    row({ id: 'tool-pwsh', disabled: true }),
    row({ id: 'pwsh-sandbox', disabled: false }),
  ]
}

function stubExecutor(disposed) {
  shellSelectExecutorFiber.current = {
    dispose: async () => {
      disposed.push(true)
    },
  }
}

test('官方行翻回:重新禁用并保持接管,不让位', async () => {
  // Given 执行器在场且 pwsh-sandbox 翻回启用；When patch-context；Then 重新禁用且不退役
  const rows = takeoverWorld()
  const sandbox = rows[2]
  const { ctx, listeners } = stubCtx(rows)
  const disposed = []
  stubExecutor(disposed)
  await installGuard(ctx, silent)
  const patchContext = listeners.get('loader/patch-context')
  const result = await patchContext(sandbox, () => 'passed')
  assert.equal(result, 'passed')
  assert.deepEqual(sandbox.updates, [{ disabled: true }])
  assert.equal(disposed.length, 0)
  assert.equal(shellSelectExecutorFiber.current !== undefined, true)
})

test('翻回时官方行仍在运行:同样先重禁,不让位', async () => {
  // Given 行仍 running(写事务只改表达式求值,不重启行)；When patch-context；Then 重禁且执行器保留
  const rows = takeoverWorld()
  const sandbox = row({ id: 'pwsh-sandbox', disabled: false, running: true })
  rows[2] = sandbox
  const { ctx, listeners } = stubCtx(rows)
  const disposed = []
  stubExecutor(disposed)
  await installGuard(ctx, silent)
  await listeners.get('loader/patch-context')(sandbox, () => 'passed')
  assert.deepEqual(sandbox.updates, [{ disabled: true }])
  assert.equal(disposed.length, 0)
})

test('重新禁用被拒:让位并退役执行器', async () => {
  // Given 宿主拒绝重新禁用；When patch-context；Then 让位
  const rows = takeoverWorld()
  const sandbox = rows[2]
  sandbox.rejectUpdate = true
  const { ctx, listeners } = stubCtx(rows)
  const disposed = []
  stubExecutor(disposed)
  await installGuard(ctx, silent)
  await listeners.get('loader/patch-context')(sandbox, () => 'passed')
  assert.equal(disposed.length, 1)
})

test('同一行反复翻回:重试有上限,耗尽后让位', async () => {
  // Given 每次都能重新禁用但行持续翻回；When 逐轮 patch-context；Then 到上限后让位
  const rows = takeoverWorld()
  const sandbox = rows[2]
  const { ctx, listeners } = stubCtx(rows)
  const disposed = []
  stubExecutor(disposed)
  await installGuard(ctx, silent)
  const patchContext = listeners.get('loader/patch-context')
  for (let round = 0; round < 4; round += 1) {
    sandbox._disabled = false
    await patchContext(sandbox, () => 'passed')
  }
  assert.equal(disposed.length, 1)
})
