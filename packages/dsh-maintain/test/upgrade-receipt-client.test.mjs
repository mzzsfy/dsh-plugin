// 升级回执展示逻辑:插件前置升级失败时不再永久占据面板。
// Given 落定升级记录 When 判断是否自动隐藏/是否可手动确认 Then 仅成功且无插件失败时自动隐藏,其余保留「知道了」。

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { clientSource, extractLogic } from './logic-extract.mjs'
import { normalizePluginUpgrade } from '../src/managed-state.mjs'

const hasPluginUpgradeFailure = extractLogic('hasPluginUpgradeFailure')
const shouldAutoAckReceipt = extractLogic('shouldAutoAckReceipt', { hasPluginUpgradeFailure })
const canDismissUpgradeReceipt = extractLogic('canDismissUpgradeReceipt')
const pluginUpgradeSummaryLine = extractLogic('pluginUpgradeSummaryLine')

test('hasPluginUpgradeFailure:无插件信息/空 items/非失败状态为 false', () => {
  assert.equal(hasPluginUpgradeFailure(null), false)
  assert.equal(hasPluginUpgradeFailure(undefined), false)
  assert.equal(hasPluginUpgradeFailure({}), false)
  assert.equal(hasPluginUpgradeFailure({ items: [] }), false)
  assert.equal(hasPluginUpgradeFailure({ items: [{ state: 'pending' }, { state: 'updated' }, { state: 'skipped' }] }), false)
})

test('hasPluginUpgradeFailure:逐项失败或整体异常为 true', () => {
  assert.equal(hasPluginUpgradeFailure({ items: [{ state: 'updated' }, { state: 'failed', error: 'aborted' }] }), true)
  assert.equal(hasPluginUpgradeFailure({ error: 'pluginManager 不支持' }), true)
})

test('shouldAutoAckReceipt:仅成功且插件阶段无失败时自动隐藏', () => {
  assert.equal(shouldAutoAckReceipt(null), false)
  assert.equal(shouldAutoAckReceipt({ ok: false }), false)
  assert.equal(shouldAutoAckReceipt({ ok: true }), true)
  assert.equal(shouldAutoAckReceipt({ ok: true, plugins: { requested: true, items: [{ state: 'updated' }] } }), true)
  assert.equal(shouldAutoAckReceipt({ ok: true, plugins: { requested: true, items: [{ state: 'failed', name: '@scope/a' }] } }), false)
  assert.equal(shouldAutoAckReceipt({ ok: true, plugins: { requested: true, error: 'boom' } }), false)
  assert.equal(shouldAutoAckReceipt({ ok: true, exitScheduled: false }), false)
  assert.equal(shouldAutoAckReceipt({ ok: true, exitScheduled: true }), true)
  assert.equal(shouldAutoAckReceipt({ ok: true, pending: true }), false)
})

test('normalizePluginUpgrade:旧 post-restart 三数组结构归一为 items 并保留失败', () => {
  const legacy = normalizePluginUpgrade({
    requested: true,
    pending: false,
    updated: [{ name: '@scope/a', from: '1.0.0', to: '1.1.0', application: 'applied' }],
    failed: [{ name: '@scope/b', from: '1.0.0', to: '1.1.0', error: 'This operation was aborted' }],
    skipped: [{ name: '@scope/c', reason: '没有严格高于已装版本的兼容版本' }],
    error: null,
  })
  assert.equal(legacy.total, 3)
  assert.deepEqual(legacy.items.map((item) => [item.name, item.state]), [
    ['@scope/a', 'updated'],
    ['@scope/b', 'failed'],
    ['@scope/c', 'skipped'],
  ])
  assert.equal(legacy.items[1].error, 'This operation was aborted')
  assert.equal(hasPluginUpgradeFailure(legacy), true)
  assert.equal(shouldAutoAckReceipt({ ok: true, plugins: legacy }), false)
})

test('normalizePluginUpgrade:旧结构 pending 意图转为需重新升级的明示错误', () => {
  const legacy = normalizePluginUpgrade({ requested: true, pending: true, updated: [], failed: [], skipped: [], error: null })
  assert.equal(legacy.pending, undefined)
  assert.match(legacy.error, /重新发起升级/)
  assert.equal(hasPluginUpgradeFailure(legacy), true)
  assert.equal(shouldAutoAckReceipt({ ok: true, plugins: legacy }), false)
})

test('normalizePluginUpgrade:total 保留真实总数,失败行缺 error 时兜底文案', () => {
  const normalized = normalizePluginUpgrade({
    requested: true,
    total: 120,
    items: [{ name: '@scope/a', state: 'failed' }],
    error: null,
  })
  assert.equal(normalized.total, 120)
  assert.equal(normalized.items[0].error, '未知错误')
  assert.equal(normalizePluginUpgrade({ requested: true, items: [] }).total, 0)
})

test('canDismissUpgradeReceipt:仅落定且非自动 ack 的记录显示知道了', () => {
  const upgrade = { running: false }
  assert.equal(canDismissUpgradeReceipt(upgrade, null, null), false)
  assert.equal(canDismissUpgradeReceipt({ running: true }, { ok: false }, null), false)
  assert.equal(canDismissUpgradeReceipt(upgrade, { ok: false }, null), true)
  assert.equal(canDismissUpgradeReceipt(upgrade, { ok: true }, 'receipt-key'), false)
})

test('pluginUpgradeSummaryLine:按逐项状态计数', () => {
  const plugins = {
    requested: true,
    items: [
      { name: '@scope/a', state: 'updated' },
      { name: '@scope/b', state: 'failed' },
      { name: '@scope/c', state: 'skipped' },
      { name: '@scope/d', state: 'skipped' },
    ],
  }
  assert.equal(pluginUpgradeSummaryLine(plugins), '插件 4 个:更新 1,失败 1,跳过 2')
  assert.equal(pluginUpgradeSummaryLine(null), null)
  assert.equal(pluginUpgradeSummaryLine({ requested: false, items: [] }), null)
  assert.equal(pluginUpgradeSummaryLine({ requested: true, items: [] }), null)
})

test('UpgradeCard:失败历史提供知道了与插件明细折叠,回执 key 不被成功条件锁死', () => {
  const source = clientSource()
  assert.ok(source.includes("'知道了'"), '缺少手动确认入口')
  assert.ok(source.includes("'插件明细'"), '缺少插件明细折叠标题')
  assert.match(source, /h\('details'[^]*?'插件明细'/, '插件明细未使用 details 折叠')
  assert.ok(source.includes('const receiptKey = upgrade && !upgrade.running && last ? upgradeReceiptKey(last) : null'), '回执 key 必须对全部落定记录生成')
  assert.ok(source.includes('const autoReceiptKey = shouldAutoAckReceipt(last) ? receiptKey : null'), '自动 ack 必须由 shouldAutoAckReceipt 单独判定')
  assert.ok(source.includes('const receiptDismissible = canDismissUpgradeReceipt(upgrade, last, autoReceiptKey)'), '手动确认入口必须接 canDismissUpgradeReceipt')
  assert.ok(!source.includes('last.ok === true && !pluginUpgradeWarning'), '回执 key 不应再被成功条件锁死')
})
