// M0 A1/A11:环境和硬不兼容均阻断宿主升级，不提供在线修改插件的绕过入口。
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { clientSource, extractLogic } from './logic-extract.mjs'

const installDisabled = () => false
const canStartInstall = extractLogic('canStartInstall', { installDisabled })
const preflightSummaryLine = extractLogic('preflightSummaryLine')
const source = clientSource()
const dialogSource = source.slice(source.indexOf('function UpgradeDialog('), source.indexOf('// release 正文'))

const PASS = { environmentOk: true, ok: true, pluginSummary: { block: 0, warn: 0 }, safeMode: { available: false, candidates: [] }, okWithSafeMode: false }

function renderDialog(preflight, onConfirm = () => {}) {
  const render = new Function('h', 'useState', 'useEffect', 'switchToggle', 'buildInstallChangeLine', 'canStartInstall', 'preflightSummaryLine', 'return (' + dialogSource.trim() + ')')(
    (type, props, ...children) => ({ type, props, children }),
    (initial) => [initial === null && initialState++ === 0 ? preflight : initial, () => {}],
    () => {}, (props) => [{ type: 'input', props, children: [] }], () => '', canStartInstall, preflightSummaryLine,
  )
  let initialState = 0
  return render({
    status: { channelLatest: '2.0.0', upgradePluginsAvailable: false, pluginUpgradeMode: 'disabled' },
    busy: {}, restarting: false, onConfirm,
  })
}

function dialogNodes(node) {
  if (Array.isArray(node)) return node.flatMap(dialogNodes)
  return node && typeof node === 'object' ? [node, ...node.children.flatMap(dialogNodes)] : []
}

function installButton(nodes) {
  return nodes.find((node) => node.type === 'button' && node.children.includes('开始安装'))
}

test('宿主单独升级通过预检：显示不可用原因，只保留自动重启开关并提交宿主意图', () => {
  const calls = []
  const nodes = dialogNodes(renderDialog(PASS, (...args) => calls.push(args)))
  assert.equal(nodes.filter(({ type }) => type === 'input').length, 1)
  assert.ok(nodes.some(({ children }) => children.some((text) => typeof text === 'string' && /插件同步升级不可用.*未接入.*控制器/.test(text))))
  const button = installButton(nodes)
  assert.equal(button.props.disabled, false)
  button.props.onClick()
  assert.deepEqual(calls, [['2.0.0', true]])
})

test('旧预检即使仍宣告可在线禁用插件，弹窗仍禁用安装且不提供安全模式开关', () => {
  const report = { ...PASS, ok: false, pluginSummary: { block: 1, warn: 0 }, safeMode: { available: true, candidates: [{ name: '@scope/a' }] }, okWithSafeMode: true }
  const nodes = dialogNodes(renderDialog(report))
  assert.equal(nodes.filter(({ type }) => type === 'input').length, 1)
  assert.equal(installButton(nodes).props.disabled, true)
  assert.match(preflightSummaryLine(report), /插件不兼容.*阻止安装/)
  assert.equal(canStartInstall({}, {}, false, report, true, true), false)
})

test('预检环境失败：安装不可开始并说明是环境问题', () => {
  const report = { ...PASS, ok: false, environmentOk: false, checks: [{ id: 'disk', status: 'block' }] }
  assert.equal(canStartInstall({}, {}, false, report), false)
  assert.match(preflightSummaryLine(report), /环境/)
})

test('预检未知时确认弹窗不可提交；只有兼容性警告时可安装', () => {
  const pendingButton = dialogNodes(renderDialog(null)).find((node) => node.type === 'button' && node.children.includes('检查中…'))
  assert.equal(pendingButton.props.disabled, true)
  assert.match(preflightSummaryLine(null), /尚未检查/)
  assert.equal(canStartInstall({}, {}, false, { ...PASS, pluginSummary: { block: 0, warn: 2 } }), true)
})
