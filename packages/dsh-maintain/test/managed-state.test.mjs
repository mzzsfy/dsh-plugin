// managed-state:升级状态收尾、落地核对、插件健康摘要与安全模式记录。
// Given state.json / pluginInventory When 核对与收尾 Then 面板可读的 lastUpgrade 与 health 一致。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  clearSafeModeRecord,
  finalizeManagedState,
  managedProfileId,
  markUpgradeReceiptSeen,
  normalizePluginUpgrade,
  readManagedState,
  readSafeModeRecord,
  reconcileManagedState,
  saveManagedState,
  summarizePluginHealth,
  writeSafeModeRecord,
} from '../src/managed-state.mjs'

const runningTarget = { runningVersion: '0.2.2-rc.3', runningPackage: 'C:/new/dsh' }
const profileId = 'C:/profile-a'
const ownership = { ...runningTarget, profileId }
const ownedState = { profileId, targetVersion: runningTarget.runningVersion, targetPackage: runningTarget.runningPackage }
const successReceipt = { ...ownership, expectedOk: true }
const failureReceipt = { ...ownership, expectedOk: false }

async function makeRoot(t) {
  const root = await mkdtemp(join(tmpdir(), 'maintain-state-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  return root
}

test('reconcileManagedState:目标已运行但未健康确认时结果未知', () => {
  const result = reconcileManagedState({
    state: {
      phase: 'awaiting-restart',
      targetVersion: '0.2.2-rc.3',
      targetPackage: 'C:/prefix/.dsh-maintain/install-a/node_modules/@deepseek-ai/dsh',
      previousVersion: '0.2.2-rc.1',
      slot: 'a',
      startedAt: 100,
    },
    runningVersion: '0.2.2-rc.3',
    runningPackage: 'C:/prefix/.dsh-maintain/install-a/node_modules/@deepseek-ai/dsh',
    platform: 'win32',
  })
  assert.equal(result.landed, true)
  assert.equal(result.pending, false)
  assert.equal(result.ok, null)
  assert.equal(result.previousVersion, '0.2.2-rc.1')
})

test('reconcileManagedState:链接已切但运行版本仍旧时标记 pending', () => {
  const result = reconcileManagedState({
    state: { phase: 'awaiting-restart', targetVersion: '0.2.2-rc.3', targetPackage: 'C:/new/dsh' },
    runningVersion: '0.2.2-rc.1',
    runningPackage: 'C:/old/dsh',
    platform: 'win32',
  })
  assert.equal(result.landed, false)
  assert.equal(result.pending, true)
  assert.equal(result.ok, null)
})

function reconcileTarget(state, running = {}) {
  return reconcileManagedState({
    state: { targetVersion: '0.2.2-rc.3', targetPackage: 'C:/new/dsh', ...state },
    runningVersion: '0.2.2-rc.3',
    runningPackage: 'C:/new/dsh',
    platform: 'win32',
    ...running,
  })
}

// M0 A10:当前宿主恢复健康不能把失败/回滚或未执行的历史变成成功。
for (const phase of ['failed', 'indeterminate', 'rolled-back']) {
  test(`reconcileManagedState:${phase} 在目标已运行且健康时仍为失败`, () => {
    const result = reconcileTarget({ phase, health: { ok: true }, receiptSeen: true })
    assert.equal(result.failed, true)
    assert.equal(result.ok, false)
    assert.equal(result.receiptSeen, true)
  })
}

test('reconcileManagedState:旧插件失败历史保留明细且不因健康变绿', () => {
  const result = reconcileTarget({
    phase: 'healthy',
    health: { ok: true },
    plugins: {
      requested: true,
      updated: [{ name: '@scope/updated' }],
      failed: [{ name: '@scope/broken', error: 'boom' }],
      skipped: [{ name: '@scope/skipped' }],
    },
  })
  assert.equal(result.ok, false)
  assert.deepEqual(result.plugins.items.map(({ name, state }) => [name, state]), [
    ['@scope/updated', 'updated'], ['@scope/broken', 'failed'], ['@scope/skipped', 'skipped'],
  ])
  assert.equal(result.plugins.items[1].error, 'boom')
})

test('reconcileManagedState:展示行被截断仍不遗漏后续插件失败', () => {
  const result = reconcileTarget({
    phase: 'healthy',
    health: { ok: true },
    plugins: {
      requested: true,
      updated: Array.from({ length: 100 }, (_, i) => ({ name: `@scope/updated-${i}` })),
      failed: [{ name: '@scope/broken', error: 'boom' }],
    },
  })
  assert.equal(result.ok, false)
  assert.equal(result.plugins.total, 101)
  assert.equal(result.plugins.omitted, 1)
  const failed = result.plugins.items.find((item) => item.state === 'failed')
  assert.deepEqual([failed?.name, failed?.error], ['@scope/broken', 'boom'])
})

test('reconcileManagedState:旧 pending 插件是明确未执行且需另行安排', () => {
  const result = reconcileTarget({
    phase: 'healthy',
    health: { ok: true },
    plugins: { requested: true, pending: true, updated: [], failed: [], skipped: [], error: null },
  })
  assert.equal(result.ok, false)
  assert.equal(result.pending, false)
  assert.equal(result.plugins.notRun, true)
  assert.equal(result.plugins.failed, true)
  assert.match(result.plugins.error, /未执行.*另行安排/)
  assert.deepEqual(result.plugins.items, [])
})

test('reconcileManagedState:失败记录保留已知历史，尚未开始的行归为 not-run', () => {
  const result = reconcileTarget({
    phase: 'failed',
    plugins: { requested: true, items: [
      { name: '@scope/broken', state: 'failed', error: 'boom' },
      { name: '@scope/waiting', state: 'pending' },
      { name: '@scope/checking', state: 'checking' },
      { name: '@scope/uncertain', state: 'upgrading' },
    ] },
  })
  assert.deepEqual(result.plugins.items.map((item) => item.state), ['failed', 'not-run', 'not-run', 'upgrading'])
})

for (const state of [
  { phase: 'unknown', health: { ok: true } },
  { phase: 'preparing', health: { ok: true } },
  { phase: 'landed', health: { ok: true } },
  { phase: 'awaiting-restart', health: { ok: true } },
  { phase: 'healthy', health: { ok: null } },
  { phase: 'healthy', health: { ok: 1 } },
  { phase: 'healthy', health: { ok: true, available: false } },
  { phase: 'healthy', health: { ok: true }, plugins: { requested: true, items: [{ name: '@scope/a', state: 'upgrading' }] } },
  { phase: 'healthy', health: { ok: true }, plugins: { requested: true, items: [{ name: '@scope/a', state: 'unrecognized' }] } },
]) {
  test(`reconcileManagedState:缺少明确成功证据时结果未知 (${JSON.stringify(state)})`, () => {
    assert.equal(reconcileTarget(state).ok, null)
  })
}

test('reconcileManagedState:只有明确成功且目标路径、版本及健康均匹配才成功', () => {
  const state = { phase: 'healthy', health: { ok: true } }
  assert.equal(reconcileTarget(state).ok, true)
  assert.equal(reconcileTarget(state, { runningPackage: 'C:/other/dsh' }).ok, null)
  assert.equal(reconcileTarget(state, { runningVersion: '0.2.2-rc.2' }).ok, null)
})

test('reconcileManagedState:上次启动的成功样本等本次启动复查', () => {
  const bootId = 'boot-current'
  for (const health of [{ ok: true }, { ok: true, checkedAt: 99, bootId: 'boot-previous' }]) {
    assert.equal(reconcileTarget({ phase: 'healthy', health }, { bootId }).ok, null)
  }
  assert.equal(reconcileTarget({ phase: 'healthy', health: { ok: true, checkedAt: 100, bootId } }, { bootId }).ok, true)
})

test('reconcileManagedState:另一进程写入的较新样本不能确认当前启动', () => {
  const state = { phase: 'healthy', health: { ok: true, checkedAt: 200, bootId: 'boot-b' } }
  assert.equal(reconcileTarget(state, { bootId: 'boot-a' }).ok, null)
  assert.equal(reconcileTarget(state, { bootId: 'boot-b' }).ok, true)
})

test('reconcileManagedState:indeterminate 为 failed 且 ok=false', () => {
  const result = reconcileManagedState({
    state: { phase: 'indeterminate', targetVersion: '0.2.2-rc.3', targetPackage: 'C:/new/dsh' },
    runningVersion: '0.2.2-rc.1',
    runningPackage: 'C:/old/dsh',
  })
  assert.equal(result.failed, true)
  assert.equal(result.ok, false)
})

test('summarizePluginHealth:失败插件与 bundle error 使健康检查不通过', () => {
  const health = summarizePluginHealth({
    inventory: [
      { entryId: 'a', moduleName: '@scope/a', fiberPhase: 'active' },
      { entryId: 'b', moduleName: '@scope/b', fiberPhase: 'failed', diagnostic: 'boom' },
      { entryId: 'c', moduleName: '@scope/c', fiberPhase: 'pending' },
    ],
    bundleRows: [{ name: '@scope/d', error: { code: 'incompatible-version' } }],
    checkedAt: 1234,
  })
  assert.equal(health.ok, false)
  assert.deepEqual(health.failed.map((row) => row.entryId), ['b'])
  assert.deepEqual(health.pending.map((row) => row.entryId), ['c'])
  assert.equal(health.bundleErrors.length, 1)
  assert.equal(health.checkedAt, 1234)
})

test('summarizePluginHealth:兼容 pluginInventory 快照对象', () => {
  const health = summarizePluginHealth({
    inventory: {
      entries: [
        { entryId: 'a', moduleName: '@scope/a', fiberPhase: 'active' },
        { entryId: 'b', moduleName: '@scope/b', fiberPhase: 'failed', diagnostic: 'boom' },
      ],
    },
    bundleRows: [],
    checkedAt: 1234,
  })
  assert.equal(health.ok, false)
  assert.equal(health.pluginCount, 2)
  assert.deepEqual(health.failed.map((row) => row.entryId), ['b'])
})

test('summarizePluginHealth:not-bundle 行不算安装错误', () => {
  const health = summarizePluginHealth({
    inventory: [],
    bundleRows: [{ name: '@scope/plain', error: { code: 'not-bundle' } }],
    checkedAt: 1234,
  })
  assert.equal(health.ok, true)
  assert.equal(health.bundleErrors.length, 0)
})

test('summarizePluginHealth:平台不支持的插件不算安装错误', () => {
  const health = summarizePluginHealth({
    inventory: [],
    bundleRows: [{ name: '@deepseek-ai/dsh-cua-bundle', error: 'unsupported-platform' }],
    checkedAt: 1234,
  })
  assert.equal(health.ok, true)
  assert.equal(health.bundleErrors.length, 0)
  assert.deepEqual(health.ignoredBundleErrors.map((row) => row.name), ['@deepseek-ai/dsh-cua-bundle'])
})

test('summarizePluginHealth:部分来源不可用时仍报告另一来源的已知失败', () => {
  const fiberFailure = summarizePluginHealth({
    inventory: [{ entryId: 'broken', fiberPhase: 'failed' }], bundleAvailable: false,
  })
  const bundleFailure = summarizePluginHealth({
    inventoryAvailable: false, bundleRows: [{ name: '@scope/broken', error: 'install-error' }],
  })
  for (const health of [fiberFailure, bundleFailure]) {
    assert.equal(health.available, false)
    assert.equal(health.ok, false)
  }
  assert.equal(summarizePluginHealth({ inventory: [], bundleAvailable: false }).ok, null)
})

test('reconcileManagedState:旧部分快照已记录明确失败时无需等待所有来源', () => {
  const health = { ok: null, available: false, failed: [{ entryId: 'broken' }] }
  const result = reconcileTarget({ phase: 'landed', health })
  assert.equal(result.health.ok, false)
  assert.equal(result.ok, false)
})

test('summarizePluginHealth:有意依赖等待保留明细，加载和卸载过渡期健康未知', () => {
  const pending = { entryId: 'waiting', fiberPhase: 'pending' }
  const health = summarizePluginHealth({ inventory: [pending], bundleRows: [] })
  assert.equal(health.ok, true)
  assert.deepEqual(health.pending.map(({ entryId }) => entryId), ['waiting'])
  for (const fiberPhase of ['loading', 'unloading']) {
    const next = summarizePluginHealth({ inventory: [pending, { entryId: 'transition', fiberPhase }], bundleRows: [] })
    assert.equal(next.ok, null)
    assert.deepEqual(next.pending.map(({ entryId }) => entryId), ['waiting', 'transition'])
  }
})

test('reconcileManagedState:旧健康快照中的加载过渡阻止成功及回执', async (t) => {
  const health = { ok: true, pending: [{ entryId: 'a', fiberPhase: 'loading' }] }
  const state = { operationId: 'op-loading', phase: 'healthy', health }
  const result = reconcileTarget(state)
  assert.equal(result.health.ok, null)
  assert.equal(result.ok, null)
  const root = await makeRoot(t)
  await saveManagedState({ root }, { ...state, ...ownedState })
  assert.equal(await markUpgradeReceiptSeen({ root }, state.operationId, successReceipt), null)
})

test('reconcileManagedState:旧平台误报伴随加载过渡时允许后续复查', async (t) => {
  const root = await makeRoot(t)
  const operationId = 'op-legacy-degraded'
  const health = {
    ok: false,
    available: true,
    failed: [],
    bundleErrors: [{ name: '@scope/other-platform', error: 'unsupported-platform' }],
    pending: [{ entryId: 'a', fiberPhase: 'loading' }],
  }
  const state = { ...ownedState, operationId, phase: 'degraded', health }
  assert.equal(reconcileTarget(state).ok, null)
  await saveManagedState({ root }, state)
  const final = await finalizeManagedState({ root }, { ...ownership, operationId, phase: 'healthy', health: { ok: true } })
  assert.equal(final?.phase, 'healthy')
})

test('reconcileManagedState:旧平台不支持误报只归一健康，不直接提升历史结果', () => {
  const result = reconcileManagedState({
    state: {
      phase: 'degraded',
      targetVersion: '0.2.2-rc.3',
      targetPackage: 'C:/prefix/.dsh-maintain/install-a/node_modules/@deepseek-ai/dsh',
      health: {
        ok: false,
        available: true,
        failed: [],
        bundleErrors: [{ name: '@deepseek-ai/dsh-cua-bundle', error: 'unsupported-platform' }],
      },
    },
    runningVersion: '0.2.2-rc.3',
    runningPackage: 'C:/prefix/.dsh-maintain/install-a/node_modules/@deepseek-ai/dsh',
  })
  assert.equal(result.ok, null)
  assert.equal(result.health.ok, true)
  assert.equal(result.health.bundleErrors.length, 0)
})

test('finalizeManagedState:确认发起 profile 的目标并保留目标版本', async (t) => {
  const root = await makeRoot(t)
  await writeFile(join(root, 'state.json'), JSON.stringify({
    ...ownedState,
    operationId: 'op-1',
    phase: 'awaiting-restart',
    startedAt: 100,
  }))
  const final = await finalizeManagedState({ root }, {
    ...ownership,
    operationId: 'op-1',
    phase: 'healthy',
    health: { ok: true, checkedAt: 200 },
    finishedAt: 300,
  })
  assert.equal(final.phase, 'healthy')
  assert.equal(final.targetVersion, '0.2.2-rc.3')
  assert.equal(final.elapsedMs, 200)
  const disk = JSON.parse(await readFile(join(root, 'state.json'), 'utf8'))
  assert.equal(disk.phase, 'healthy')
  assert.equal(disk.health.ok, true)
})

test('normalizePluginUpgrade:逐插件状态与错误保留', () => {
  const normalized = normalizePluginUpgrade({
    requested: true,
    items: [
      { name: '@scope/a', state: 'updated', from: '1.0.0', to: '1.1.0', application: 'applied' },
      { name: '@scope/b', state: 'failed', error: 'network down', restoreFailed: true },
      { name: '@scope/c', state: 'skipped', reason: '没有严格高于已装版本的兼容版本' },
    ],
    error: null,
  })
  assert.equal(normalized.total, 3)
  assert.equal(normalized.items[0].state, 'updated')
  assert.equal(normalized.items[1].error, 'network down')
  assert.equal(normalized.items[1].restoreFailed, true)
  assert.match(normalized.items[2].reason, /严格高于/)
  assert.equal(normalizePluginUpgrade({ requested: true }).items.length, 0)
  assert.equal(normalizePluginUpgrade({ requested: false }), null)
})

for (const [phase, health] of [
  ['failed', undefined],
  ['indeterminate', undefined],
  ['rolled-back', undefined],
  ['degraded', { ok: false, available: true, failed: [{ entryId: 'broken' }], bundleErrors: [] }],
]) {
  test(`finalizeManagedState:复查健康时保留 ${phase} 结果`, async (t) => {
    const root = await makeRoot(t)
    const previous = { ...ownedState, operationId: 'op-failed', phase, health, startedAt: 100, finishedAt: 150 }
    await writeFile(join(root, 'state.json'), JSON.stringify(previous))
    await finalizeManagedState({ root }, { ...ownership, operationId: 'op-failed', phase: 'healthy', health: { ok: true }, finishedAt: 300 })
    const disk = await readManagedState({ root })
    assert.equal(disk.phase, phase)
    assert.equal(disk.finishedAt, 150)
  })
}

test('finalizeManagedState:显式插件失败的历史不允许被健康收尾改写', async (t) => {
  const root = await makeRoot(t)
  const operationId = 'op-plugin-failed'
  const previous = { ...ownedState, operationId, phase: 'awaiting-restart', plugins: { requested: true, failed: [{ name: '@scope/broken', error: 'boom' }] } }
  await saveManagedState({ root }, previous)
  assert.equal(await finalizeManagedState({ root }, { ...ownership, operationId, phase: 'healthy', health: { ok: true } }), null)
  assert.deepEqual(await readManagedState({ root }), previous)
})

test('finalizeManagedState:上一笔操作的迟到采样不能写入当前操作', async (t) => {
  const root = await makeRoot(t)
  const current = { ...ownedState, operationId: 'op-next', phase: 'awaiting-restart', startedAt: 250 }
  await writeFile(join(root, 'state.json'), JSON.stringify(current))
  const result = await finalizeManagedState({ root }, {
    ...ownership, operationId: 'op-sampled', phase: 'healthy', health: { ok: true }, finishedAt: 300,
  })
  assert.equal(result, null)
  assert.deepEqual(await readManagedState({ root }), current)
})

for (const phase of ['awaiting-restart', 'landed', 'preparing']) {
  test(`markUpgradeReceiptSeen:拒绝确认未落定的 ${phase} 操作`, async (t) => {
    const root = await makeRoot(t)
    const previous = { ...ownedState, operationId: 'op-pending', phase }
    await writeFile(join(root, 'state.json'), JSON.stringify(previous))
    assert.equal(await markUpgradeReceiptSeen({ root }, 'op-pending', successReceipt), null)
    assert.deepEqual(await readManagedState({ root }), previous)
  })
}

test('未归属的旧插件升级意图只读展示且不能确认到共享状态', async (t) => {
  const root = await makeRoot(t)
  const operationId = 'op-old'
  const plugins = { requested: true, pending: true, updated: [], failed: [], skipped: [] }
  const previous = { operationId, phase: 'awaiting-restart', plugins }
  await saveManagedState({ root }, previous)
  const visible = reconcileManagedState({ state: previous, ...ownership })
  assert.equal(visible.ok, false)
  assert.equal(visible.receiptLocalOnly, true)
  assert.equal(visible.plugins.notRun, true)
  assert.equal(await markUpgradeReceiptSeen({ root }, operationId, failureReceipt), null)
  assert.deepEqual(await readManagedState({ root }), previous)
})

test('markUpgradeReceiptSeen:旧健康样本和结果类别不匹配时拒绝确认', async (t) => {
  const root = await makeRoot(t)
  const operationId = 'op-old-healthy'
  const bootId = 'boot-current'
  const previous = {
    ...ownedState, operationId, phase: 'healthy',
    health: { ok: true, checkedAt: 100, bootId: 'boot-previous' }, receiptSeen: true,
  }
  await saveManagedState({ root }, previous)
  assert.equal(reconcileTarget(previous, { bootId }).receiptSeen, false)
  assert.equal(await markUpgradeReceiptSeen({ root }, operationId, { ...successReceipt, bootId }), null)
  await finalizeManagedState({ root }, { ...ownership, operationId, phase: 'degraded', health: { ok: false, checkedAt: 200, bootId } })
  const failed = await readManagedState({ root })
  assert.equal(failed.receiptSeen, false)
  assert.equal(reconcileTarget(failed, { bootId }).receiptSeen, false)
  assert.equal(await markUpgradeReceiptSeen({ root }, operationId, { ...successReceipt, bootId }), null)
  const marked = await markUpgradeReceiptSeen({ root }, operationId, { ...failureReceipt, bootId })
  assert.equal(marked.receiptResult, 'failed')
  assert.equal(reconcileTarget(marked, { bootId }).receiptSeen, true)
})

test('finalizeManagedState:旧成功已读经过未知阶段后也不能隐藏失败', async (t) => {
  const root = await makeRoot(t)
  const operationId = 'op-old-receipt'
  await saveManagedState({ root }, { ...ownedState, operationId, phase: 'healthy', health: { ok: true }, receiptSeen: true })
  await finalizeManagedState({ root }, { ...ownership, operationId, phase: 'landed', health: { ok: null } })
  await finalizeManagedState({ root }, { ...ownership, operationId, phase: 'degraded', health: { ok: false } })
  const disk = await readManagedState({ root })
  assert.equal(reconcileTarget(disk).receiptSeen, false)
})

test('reconcileManagedState:已读类别不能隐藏不同终态', () => {
  const state = { phase: 'degraded', health: { ok: false }, receiptSeen: true }
  assert.equal(reconcileTarget({ ...state, receiptResult: 'succeeded' }).receiptSeen, false)
  assert.equal(reconcileTarget({ ...state, receiptResult: 'failed' }).receiptSeen, true)
  assert.equal(reconcileTarget(state).receiptSeen, false)
})

test('markUpgradeReceiptSeen:与健康收尾并发时保留已读标记', async (t) => {
  const root = await makeRoot(t)
  await writeFile(join(root, 'state.json'), JSON.stringify({
    ...ownedState,
    operationId: 'op-race',
    phase: 'healthy',
    startedAt: 100,
    health: { ok: true },
  }))
  await Promise.all([
    markUpgradeReceiptSeen({ root }, 'op-race', successReceipt),
    finalizeManagedState({ root }, {
      ...ownership,
      operationId: 'op-race',
      phase: 'healthy',
      health: { ok: true, available: true, failed: [], bundleErrors: [] },
      finishedAt: 300,
    }),
  ])
  const disk = JSON.parse(await readFile(join(root, 'state.json'), 'utf8'))
  assert.equal(disk.phase, 'healthy')
  assert.equal(disk.receiptSeen, true)
})

test('state.json:新操作写入、健康确认和回执按调用次序持久化', async (t) => {
  const root = await makeRoot(t)
  const layout = { root }
  const phase = 'awaiting-restart'
  await saveManagedState(layout, { operationId: 'op-old', phase, startedAt: 100 })
  const operationId = 'op-new'
  const health = { ok: true, checkedAt: 300 }
  await Promise.all([
    saveManagedState(layout, { operationId, phase, startedAt: 200, ...ownedState }),
    finalizeManagedState(layout, { ...ownership, operationId, phase: 'healthy', health, finishedAt: 300 }),
    markUpgradeReceiptSeen(layout, operationId, successReceipt),
  ])
  assert.deepEqual(await readManagedState(layout), {
    operationId, phase: 'healthy', startedAt: 200, ...ownedState, health, finishedAt: 300, elapsedMs: 100, receiptSeen: true, receiptResult: 'succeeded',
  })
})

test('profile 归属以真实目录为准，同目录别名相同且不同目录有别', async (t) => {
  const root = await makeRoot(t)
  const a = join(root, 'a')
  const b = join(root, 'b')
  const alias = join(root, 'alias')
  await Promise.all([mkdir(a), mkdir(b)])
  await symlink(a, alias, process.platform === 'win32' ? 'junction' : 'dir')
  assert.equal(await managedProfileId(alias), await managedProfileId(a))
  assert.notEqual(await managedProfileId(b), await managedProfileId(a))
  assert.equal(await managedProfileId(join(root, 'missing')), null)
})

test('共享 prefix 时其他 profile 不能采样或确认所有者的操作', async (t) => {
  const root = await makeRoot(t)
  const layout = { root }
  const profileId = join(await realpath(root), 'profile-a')
  const other = join(await realpath(root), 'profile-b')
  const operation = { operationId: 'op-owner', profileId, phase: 'awaiting-restart', targetVersion: runningTarget.runningVersion, targetPackage: runningTarget.runningPackage }
  await saveManagedState(layout, operation)
  const health = { ok: true, bootId: 'boot-a' }
  assert.equal(await finalizeManagedState(layout, { ...runningTarget, profileId: other, operationId: operation.operationId, phase: 'healthy', health }), null)
  assert.deepEqual(await readManagedState(layout), operation)
  assert.ok(await finalizeManagedState(layout, { ...runningTarget, profileId, operationId: operation.operationId, phase: 'healthy', health }))
  assert.equal(await markUpgradeReceiptSeen(layout, operation.operationId, { ...successReceipt, profileId: other, bootId: health.bootId }), null)
  assert.ok(await markUpgradeReceiptSeen(layout, operation.operationId, { ...successReceipt, profileId, bootId: health.bootId }))
})

test('跨进程持有状态锁时，当前进程不能抢写或用旧回执覆盖新操作', async (t) => {
  const root = await makeRoot(t)
  const layout = { root }
  const profileId = root
  const prior = { operationId: 'op-old', profileId, phase: 'failed' }
  const next = { operationId: 'op-new', profileId, phase: 'installing' }
  await saveManagedState(layout, prior)
  const child = spawn(process.execPath, ['--input-type=module', '-e', `
    import { open, rename, unlink, writeFile } from 'node:fs/promises'
    import { once } from 'node:events'
    import { join } from 'node:path'
    const root = process.env.MAINTAIN_TEST_ROOT
    const lock = join(root, 'state.json.lock')
    const handle = await open(lock, 'wx')
    const release = once(process, 'message')
    process.send('locked')
    await release
    await writeFile(join(root, 'state-temp.json'), process.env.MAINTAIN_TEST_NEXT)
    await rename(join(root, 'state-temp.json'), join(root, 'state.json'))
    await handle.close()
    await unlink(lock)
    process.disconnect()
  `], { env: { ...process.env, MAINTAIN_TEST_ROOT: root, MAINTAIN_TEST_NEXT: JSON.stringify(next) }, stdio: ['ignore', 'ignore', 'inherit', 'ipc'] })
  const childExit = once(child, 'exit')
  t.after(async () => { if (child.exitCode === null && child.signalCode === null) child.kill(); await childExit })
  assert.equal((await once(child, 'message'))[0], 'locked')
  const ack = markUpgradeReceiptSeen(layout, prior.operationId, { ...failureReceipt, profileId })
  const during = await Promise.race([ack.then(() => 'completed'), new Promise((resolve) => setTimeout(resolve, 60, 'waiting'))])
  const following = { operationId: 'op-following', profileId, phase: 'preparing' }
  const save = saveManagedState(layout, following)
  child.send('release')
  assert.deepEqual(await childExit, [0, null])
  assert.equal(during, 'waiting')
  assert.equal(await ack, null)
  await save
  assert.deepEqual(await readManagedState(layout), following)
})

test('升级状态写入也遵守独占状态锁', async (t) => {
  const root = await makeRoot(t)
  const layout = { root }
  const path = join(root, 'state.json.lock')
  const prior = { ...ownedState, operationId: 'op-before', phase: 'healthy' }
  const next = { ...ownedState, operationId: 'op-after', phase: 'installing' }
  await saveManagedState(layout, prior)
  await writeFile(path, '', { flag: 'wx' })
  const save = saveManagedState(layout, next)
  try {
    const during = await Promise.race([save.then(() => 'completed'), new Promise((resolve) => setTimeout(resolve, 60, 'waiting'))])
    assert.equal(during, 'waiting')
    assert.deepEqual(await readManagedState(layout), prior)
  } finally {
    await rm(path)
    await save
  }
  assert.deepEqual(await readManagedState(layout), next)
})

test('运行健康忽略明确禁用的 bundle 兼容错误', () => {
  const row = { name: '@scope/fixture', enabled: false, installed: true, availability: 'profile', error: { code: 'incompatible' } }
  const disabled = summarizePluginHealth({ inventory: [], bundleRows: [row] })
  assert.equal(disabled.ok, true)
  assert.deepEqual(disabled.bundleErrors, [])
  const enabled = summarizePluginHealth({ inventory: [], bundleRows: [{ ...row, enabled: true }] })
  assert.equal(enabled.ok, false)
  assert.equal(enabled.bundleErrors[0].name, row.name)
})

test('readManagedState:文件缺失或损坏返回 null', async (t) => {
  const root = await makeRoot(t)
  assert.equal(await readManagedState({ root }), null)
  await writeFile(join(root, 'state.json'), '{bad json')
  assert.equal(await readManagedState({ root }), null)
})

test('safe-mode record:写入、读取、清除', async (t) => {
  const root = await makeRoot(t)
  await writeSafeModeRecord({ root }, {
    operationId: 'op-1',
    targetVersion: '0.2.2-rc.3',
    disabled: [{ name: '@scope/a', version: '1.0.0' }],
  })
  const record = await readSafeModeRecord({ root })
  assert.equal(record.operationId, 'op-1')
  assert.equal(record.disabled[0].name, '@scope/a')
  await clearSafeModeRecord({ root })
  assert.equal(await readSafeModeRecord({ root }), null)
})
