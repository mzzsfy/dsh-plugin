// M0 A10:运行健康与升级结果分离，未确认结果不隐藏，已落定失败保留手动回执。

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { clientSource, extractLogic } from './logic-extract.mjs'
import { normalizePluginUpgrade } from '../src/managed-state.mjs'

const hasPluginUpgradeFailure = extractLogic('hasPluginUpgradeFailure')
const upgradeResultKind = extractLogic('upgradeResultKind', { hasPluginUpgradeFailure })
const shouldAutoAckReceipt = extractLogic('shouldAutoAckReceipt', { upgradeResultKind })
const canDismissUpgradeReceipt = extractLogic('canDismissUpgradeReceipt', { upgradeResultKind })
const pluginUpgradeSummaryLine = extractLogic('pluginUpgradeSummaryLine')
const upgradeFinalText = extractLogic('upgradeFinalText', { upgradeResultKind, hasPluginUpgradeFailure })
const upgradePhaseLabel = extractLogic('upgradePhaseLabel')

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

test('normalizePluginUpgrade:旧结构 pending 明示未执行，引导另行安排插件更新', () => {
  const legacy = normalizePluginUpgrade({ requested: true, pending: true, updated: [], failed: [], skipped: [], error: null })
  assert.equal(legacy.pending, undefined)
  assert.match(legacy.error, /未执行.*另行安排/)
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
  assert.equal(canDismissUpgradeReceipt(upgrade, { ok: true, pending: true }, null), false)
  assert.equal(canDismissUpgradeReceipt(upgrade, { ok: null, landed: true }, null), false)
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

function renderReceipt(last, extraUpgrade = {}, { stored = new Map(), postAck = () => Promise.resolve() } = {}) {
  const source = clientSource()
  const components = source.slice(source.indexOf('const PLUGIN_ITEM_LABELS'), source.indexOf('function SafeModeCard('))
  const receiptStorage = source.slice(source.indexOf('function upgradeReceiptKey('), source.indexOf('// 与 managed-state'))
  const calls = []
  const effects = []
  const scope = {
    h(type, props, ...children) { return { type, props, children } },
    useState: (value) => [value, () => {}],
    useRef: (current) => ({ current }),
    useEffect: (effect) => effects.push(effect),
    UPGRADE_RECEIPT_SEEN_KEY: 'receipt-key',
    seenUpgradeReceipts: new Set(),
    window: { localStorage: { getItem: (key) => stored.get(key), setItem: (key, value) => stored.set(key, value) } },
    hasPluginUpgradeFailure, shouldAutoAckReceipt, canDismissUpgradeReceipt, pluginUpgradeSummaryLine,
    upgradeResultKind, upgradeFinalText, upgradePhaseLabel,
    fmtTime: () => null, fmtElapsed: () => '1 秒',
    RECEIPT_ACK_URL: '/api/maintain/upgrade/receipt-ack',
    post(url, payload) { calls.push({ url, payload }); return postAck() },
  }
  const render = new Function(...Object.keys(scope), receiptStorage + '\n' + components + '\nreturn UpgradeCard')(...Object.values(scope))
  function collect(node) {
    if (Array.isArray(node)) return node.flatMap(collect)
    if (node === null || node === undefined || node === false) return []
    if (typeof node !== 'object') return [node]
    if (typeof node.type === 'function') return collect(node.type(node.props))
    return [node, ...node.children.flatMap(collect)]
  }
  const nodes = collect(render({ status: { upgrade: { running: false, historical: true, last, ...extraUpgrade } } }))
  for (const effect of effects) effect()
  return { nodes, calls, text: nodes.filter((node) => typeof node === 'string').join(' '),
    dismiss: nodes.find((node) => node.type === 'button' && node.children.includes('知道了')) }
}

for (const [name, state, expected] of [
  ['等重启', { ok: true, pending: true, exitScheduled: false }, /等待宿主重启|手动重启宿主/],
  ['未知', { ok: null, pending: false, landed: true }, /结果.*未确认|状态未知/],
]) {
  test('UpgradeCard: ' + name + ' 不绿色且不自动确认', () => {
    const receipt = renderReceipt({ operationId: 'unconfirmed', ...state })
    assert.match(receipt.text, expected)
    assert.ok(!receipt.nodes.some((node) => node.props?.className === 'dm-ok'))
    assert.doesNotMatch(receipt.text, /升级完成/)
    assert.deepEqual(receipt.calls, [])
  })
}

test('UpgradeCard: 健康宿主的历史失败不显示成功，保留折叠明细且只能手动 ack', () => {
  const receipt = renderReceipt({
    operationId: 'previous-failure', ok: false, landed: true, health: { ok: true },
    plugins: { requested: true, notRun: true, error: '旧版本遗留的插件升级意图未执行。如仍需更新插件，请另行安排', items: [
      { name: '@scope/a', state: 'not-run' }, { name: '@scope/b', state: 'failed', error: '下载失败' },
    ] },
  })
  assert.doesNotMatch(receipt.text, /升级完成|健康检查.*异常/)
  assert.match(receipt.text, /未执行 1/)
  assert.match(receipt.text, /插件明细.*未执行 @scope\/a.*下载失败/)
  assert.ok(receipt.nodes.some((node) => node.type === 'details' && !node.props.open))
  assert.deepEqual(receipt.calls, [])
  assert.ok(receipt.dismiss)
  receipt.dismiss.props.onClick()
  assert.deepEqual(receipt.calls, [{ url: '/api/maintain/upgrade/receipt-ack', payload: { operationId: 'previous-failure', result: 'failed' } }])
})

test('UpgradeCard: 确认成功后，同一笔升级被复检降级时失败记录仍可见', async () => {
  const stored = new Map()
  const receipt = renderReceipt({ operationId: 'same-operation', ok: true }, {}, { stored })
  await Promise.resolve()
  const failed = renderReceipt({ operationId: 'same-operation', ok: false, error: '复检失败' }, {}, { stored })
  assert.match(failed.text, /复检失败/)
  assert.ok(failed.dismiss)
  assert.deepEqual(receipt.calls, [{ url: '/api/maintain/upgrade/receipt-ack', payload: { operationId: 'same-operation', result: 'succeeded' } }])
  assert.equal(renderReceipt({ operationId: 'same-operation', ok: true }, {}, { stored }).text, '')
})

test('UpgradeCard: 服务端成功回执不得遮住同笔失败，而已确认的失败仍应隐藏', () => {
  const previous = { operationId: 'old-result', ok: false, receiptSeen: true }
  assert.ok(renderReceipt({ ...previous, receiptResult: 'succeeded' }).dismiss)
  assert.equal(renderReceipt({ ...previous, receiptResult: 'failed' }).text, '')
})

test('UpgradeCard: 自动或人工确认被服务端拒绝时保持可见且不记本地已读', async () => {
  const stored = new Map()
  const options = { stored, postAck: () => Promise.reject(Object.assign(new Error('结果冲突'), { status: 409 })) }
  const success = { operationId: 'success-unacked', ok: true }
  const failed = { operationId: 'failed-unacked', ok: false }
  renderReceipt(success, {}, options)
  renderReceipt(failed, {}, options).dismiss.props.onClick()
  await Promise.resolve()
  assert.equal(stored.size, 0)
  assert.match(renderReceipt(success, {}, options).text, /升级完成/)
  assert.ok(renderReceipt(failed, {}, options).dismiss)
})

test('UpgradeCard: 无 operationId 的旧回执可以仅本地确认', () => {
  const stored = new Map()
  const last = { ok: false, targetVersion: '2.0.0', startedAt: 456 }
  const receipt = renderReceipt(last, {}, { stored })
  receipt.dismiss.props.onClick()
  assert.deepEqual(receipt.calls, [])
  assert.equal(renderReceipt(last, {}, { stored }).text, '')
})

test('UpgradeCard: 仅有内存的终态有 operationId 也可以不发请求地手动确认', () => {
  const stored = new Map()
  const last = { operationId: 'process-local-failure', ok: false, receiptLocalOnly: true }
  const receipt = renderReceipt(last, {}, { stored })
  receipt.dismiss.props.onClick()
  assert.deepEqual(receipt.calls, [])
  assert.equal(renderReceipt(last, {}, { stored }).text, '')
})

test('UpgradeCard: 隔离待核验结果展示真实错误', () => {
  const receipt = renderReceipt({ operationId: 'indeterminate', ok: false, phase: 'indeterminate', error: '候选槽切换失败' })
  assert.match(receipt.text, /人工核验.*候选槽切换失败/)
  assert.doesNotMatch(receipt.text, /详情见版本与运维页/)
})

for (const ok of [false, null]) {
  test('UpgradeCard: 健康检查不完整但报告已知错误时，同时显示不可用原因和诊断（ok=' + ok + '）', () => {
    const receipt = renderReceipt({
      operationId: 'partial-health', ok: false,
      health: { ok, available: false, unavailableReason: '快照缺失', failed: [{ moduleName: 'failed-plugin' }], bundleErrors: [{ name: 'failed-bundle', error: '载入异常' }] },
    })
    assert.match(receipt.text, /插件健康检查不可用.*快照缺失/)
    assert.match(receipt.text, /failed-plugin.*failed-bundle.*载入异常/)
  })
}

test('UpgradeCard: 历史明细被截断时，说明分项只统计已显示的记录', () => {
  const receipt = renderReceipt({
    operationId: 'truncated-failure', ok: false,
    plugins: { requested: true, total: 101, omitted: 100, items: [{ name: '@scope/a', state: 'failed' }] },
  })
  assert.match(receipt.text, /插件 101 个.*仅统计已显示.*失败 1.*省略 100 条/)
})

test('UpgradeCard: 已知有历史插件明细但没有可显示行，仍说明省略数量', () => {
  const receipt = renderReceipt({
    operationId: 'missing-details', ok: null,
    plugins: { requested: true, total: 2, omitted: 2, items: [], incomplete: true },
  })
  assert.match(receipt.text, /插件 2 个.*省略 2 条/)
  assert.ok(!receipt.nodes.some((node) => node.type === 'details'))
})

test('UpgradeCard: 运行中只展示通用阶段，不显示在线插件明细', () => {
  const receipt = renderReceipt({ operationId: 'running', ok: null }, {
    running: true,
    progress: { phase: 'pre-switch', phaseLabel: '正在禁用插件 @scope/a(1/1)', items: [{ name: '@scope/a', state: 'upgrading' }] },
  })
  assert.match(receipt.text, /最终核验/)
  assert.doesNotMatch(receipt.text, /@scope\/a|禁用插件|升级中/)
  assert.equal(receipt.dismiss, undefined)
  assert.deepEqual(receipt.calls, [])
})
