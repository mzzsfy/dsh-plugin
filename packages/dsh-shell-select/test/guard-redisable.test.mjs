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
import { shellSelectExecutorFiber, beginShellSelectApply, endShellSelectApplyActive, retireShellSelectExecutorFiber } from '../src/apply-state.mjs'

function row({ id, disabled = false, running = false, throwsGetter = false }) {
  const entry = {
    options: { id },
    disabled,
    throwsGetter,
    fiber: running ? { uid: 'f' } : undefined,
    updates: [],
    get disabled() {
      // !!js 表达式求值抛错形态(宿主行 getter 抛):状态不可信
      if (entry.throwsGetter) throw new Error('bad !!js expression')
      return entry._disabled
    },
    set disabled(value) {
      entry._disabled = value
    },
    async update(patch, create, force) {
      // 宿主 Entry.update(options, create=false, force=false):三参全记录,
      // 断言钉死 create=false(为真会整份替换 options)与 force=true
      entry.updates.push({ patch, create, force })
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
  assert.deepEqual(sandbox.updates, [{ patch: { disabled: true }, create: false, force: true }])
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
  assert.deepEqual(sandbox.updates, [{ patch: { disabled: true }, create: false, force: true }])
  assert.equal(disposed.length, 0)
})

test('重新禁用被拒:保持执行器,不让位', async () => {
  // Given 宿主拒绝重新禁用(写事务重建行树中)；When patch-context；Then 保留执行器,
  // 官方行激活撞 ctx.shell 是宿主侧结果,不能把接管链自己撤掉(撤掉=shell 真空只能重启)
  const rows = takeoverWorld()
  const sandbox = rows[2]
  sandbox.rejectUpdate = true
  const { ctx, listeners } = stubCtx(rows)
  const disposed = []
  stubExecutor(disposed)
  await installGuard(ctx, silent)
  await listeners.get('loader/patch-context')(sandbox, () => 'passed')
  assert.equal(disposed.length, 0)
  assert.equal(shellSelectExecutorFiber.current !== undefined, true)
})

test('同一行反复翻回:每次重禁,不让位', async () => {
  // Given 每次都能重新禁用但行持续翻回；When 逐轮 patch-context；Then 每轮都
  // 重禁(不让行停在启用态,否则后续写事务反复撞服务),执行器始终保留
  const rows = takeoverWorld()
  const sandbox = rows[2]
  const { ctx, listeners } = stubCtx(rows)
  const disposed = []
  stubExecutor(disposed)
  await installGuard(ctx, silent)
  const patchContext = listeners.get('loader/patch-context')
  for (let round = 0; round < 6; round += 1) {
    sandbox._disabled = false
    await patchContext(sandbox, () => 'passed')
  }
  assert.equal(disposed.length, 0)
  assert.equal(shellSelectExecutorFiber.current !== undefined, true)
  assert.equal(sandbox.updates.length, 6, '每轮翻回都必须重禁')
  assert.equal(sandbox._disabled, true)
})

test('重禁写入抛错但行已禁用:保持执行器', async () => {
  // Given 重禁 update 写入 disabled 后抛错(写事务收尾异常)；When patch-context；
  // Then 重读已是禁用态,不得让位(让位后官方行并未复活,shell 全灭)
  const rows = takeoverWorld()
  const sandbox = rows[2]
  const { ctx, listeners } = stubCtx(rows)
  const disposed = []
  stubExecutor(disposed)
  const originalUpdate = sandbox.update
  sandbox.update = async (patch, create, force) => {
    await originalUpdate(patch, create, force)
    throw new Error('write transaction rejected after commit')
  }
  await installGuard(ctx, silent)
  await listeners.get('loader/patch-context')(sandbox, () => 'passed')
  assert.equal(sandbox._disabled, true)
  assert.equal(disposed.length, 0)
  assert.equal(shellSelectExecutorFiber.current !== undefined, true)
})

// ── G3-2 行状态求值不可信:零动作(不重禁、不让位、不卸代挂)────────────────

test('官方行 getter 求值抛错:不卸代挂(状态不可信保持现状)', async () => {
  // Given 死态已代挂官方两行(主行停摆 + 官方两行禁用)
  const rows = [
    row({ id: MAIN_ROW_ID, disabled: true }),
    row({ id: 'tool-pwsh', disabled: true }),
    row({ id: 'pwsh-sandbox', disabled: true }),
  ]
  const sandbox = rows[2]
  const { ctx, listeners, log } = stubCtx(rows)
  let mountCalls = 0
  let unmounts = 0
  ctx.plugin = () => {
    mountCalls += 1
    return Promise.resolve({ dispose: async () => { unmounts += 1 } })
  }
  await installGuard(ctx, silent)
  assert.equal(mountCalls, 2, '死态必须代挂官方两行')
  // When 该行 disabled 求值开始抛错(宿主表达式异常),patch-context 到达
  sandbox.throwsGetter = true
  await listeners.get('loader/patch-context')(sandbox, () => 'passed')
  // Then 保持现状:代挂不被撤;轨迹留不可信标记
  assert.equal(unmounts, 0, '状态不可信不得卸代挂')
  assert.ok(log.some((msg) => msg.includes('不可信')))
})

test('重禁写入后 getter 开始抛错:不让位(执行器保持)', async () => {
  // Given 官方行翻回(patch-context 期间可靠地读到启用)
  const rows = takeoverWorld()
  const sandbox = rows[2]
  const { ctx, listeners, log } = stubCtx(rows)
  const disposed = []
  stubExecutor(disposed)
  const originalUpdate = sandbox.update
  // 重禁写入成功后宿主表达式求值开始抛错(写事务收尾异常形态)
  sandbox.update = async (patch, create, force) => {
    await originalUpdate(patch, create, force)
    if (patch?.disabled === true) sandbox.throwsGetter = true
  }
  await installGuard(ctx, silent)
  // When patch-context;Then 重禁已写但状态不可确认 → 保持接管,不让位
  await listeners.get('loader/patch-context')(sandbox, () => 'passed')
  assert.equal(disposed.length, 0, '状态不可信不得退役执行器')
  assert.equal(shellSelectExecutorFiber.current !== undefined, true)
  assert.ok(log.some((msg) => msg.includes('不可信')))
})

// ── 执行器丢失自愈:主行 active 但执行器句柄不在场 → 代挂官方链 ──────────────

test('执行器丢失超过宽限:代挂官方链恢复终端', async () => {
  // Given 主行 apply 已落定 active,执行器句柄因接管链断裂退役(写事务让位残留)
  const rows = [
    row({ id: MAIN_ROW_ID, disabled: false, running: true }),
    row({ id: 'tool-pwsh', disabled: true }),
    row({ id: 'pwsh-sandbox', disabled: true }),
  ]
  const { ctx } = stubCtx(rows)
  let mountCalls = 0
  ctx.plugin = async () => {
    mountCalls += 1
    return { dispose: async () => {} }
  }
  const generation = beginShellSelectApply()
  endShellSelectApplyActive(generation)
  retireShellSelectExecutorFiber()
  await installGuard(ctx, { ...silent, sweepIntervalMs: 20, executorLossGraceMs: 0, timeouts: { load: 100, mount: 100 } })
  // When 轮询跨过宽限窗口；Then 代挂官方两行
  await new Promise((done) => setTimeout(done, 120))
  assert.equal(mountCalls, 2, '执行器不在场必须代挂官方链,不能留给用户重启')
})
