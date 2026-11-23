// managed-state:升级状态收尾、落地核对、插件健康摘要与安全模式记录。
// Given state.json / pluginInventory When 核对与收尾 Then 面板可读的 lastUpgrade 与 health 一致。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  clearSafeModeRecord,
  finalizeManagedState,
  markUpgradeReceiptSeen,
  mergeManagedState,
  normalizePluginUpgrade,
  readManagedState,
  readSafeModeRecord,
  reconcileManagedState,
  summarizePluginHealth,
  writeSafeModeRecord,
} from '../src/managed-state.mjs'

async function makeRoot(t) {
  const root = await mkdtemp(join(tmpdir(), 'maintain-state-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  return root
}

test('reconcileManagedState:state 目标与运行版本/路径一致即落地', () => {
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
  assert.equal(result.ok, true)
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

test('reconcileManagedState:旧 state 的平台不支持错误展示时归一为成功', () => {
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
  assert.equal(result.ok, true)
  assert.equal(result.health.ok, true)
  assert.equal(result.health.bundleErrors.length, 0)
})

test('finalizeManagedState:读取旧 state 并写入 healthy 与 health,保留目标版本', async (t) => {
  const root = await makeRoot(t)
  await writeFile(join(root, 'state.json'), JSON.stringify({
    operationId: 'op-1',
    targetVersion: '0.2.2-rc.3',
    phase: 'awaiting-restart',
    startedAt: 100,
  }))
  const final = await finalizeManagedState({ root }, {
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

test('mergeManagedState:插件前置升级结果与健康收尾并存', async (t) => {
  const root = await makeRoot(t)
  await writeFile(join(root, 'state.json'), JSON.stringify({
    operationId: 'op-plugins',
    phase: 'awaiting-restart',
    targetVersion: '9.9.9',
    targetPackage: 'C:/new/dsh',
    startedAt: 100,
  }))
  const plugins = {
    requested: true,
    items: [
      { name: '@scope/a', state: 'updated', from: '1.0.0', to: '1.1.0', application: 'applied' },
      { name: '@scope/git', state: 'skipped', reason: 'Git 插件没有版本列表,跳过' },
    ],
    error: null,
  }
  await mergeManagedState({ root }, { plugins })
  await finalizeManagedState({ root }, { phase: 'healthy', health: { ok: true }, finishedAt: 200 })
  const state = await readManagedState({ root })
  assert.deepEqual(state.plugins.items.map((row) => row.name), ['@scope/a', '@scope/git'])
  assert.equal(state.health.ok, true)
  assert.equal(state.phase, 'healthy')
  const reconciled = reconcileManagedState({
    state,
    runningVersion: '9.9.9',
    runningPackage: 'C:/new/dsh',
    platform: 'win32',
  })
  assert.equal(reconciled.plugins.items[0].name, '@scope/a')
  assert.equal(reconciled.plugins.items[0].state, 'updated')
  assert.equal(reconciled.plugins.items[1].state, 'skipped')
})

test('markUpgradeReceiptSeen:与健康收尾并发时保留已读标记', async (t) => {
  const root = await makeRoot(t)
  await writeFile(join(root, 'state.json'), JSON.stringify({
    operationId: 'op-race',
    phase: 'awaiting-restart',
    targetVersion: '0.2.2-rc.3',
    startedAt: 100,
  }))
  await Promise.all([
    markUpgradeReceiptSeen({ root }, 'op-race'),
    finalizeManagedState({ root }, {
      phase: 'healthy',
      health: { ok: true, available: true, failed: [], bundleErrors: [] },
      finishedAt: 300,
    }),
  ])
  const disk = JSON.parse(await readFile(join(root, 'state.json'), 'utf8'))
  assert.equal(disk.phase, 'healthy')
  assert.equal(disk.receiptSeen, true)
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
