// 升级安全客户端逻辑:预检结果驱动安装按钮与安全模式提示。
// Given 预检报告与安全模式开关 When 判断能否开始安装 Then 环境阻断不可越过、插件阻断仅安全模式可越过。

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { extractLogic } from './logic-extract.mjs'

const installDisabled = () => false
const canStartInstall = extractLogic('canStartInstall', { installDisabled })
const preflightSummaryLine = extractLogic('preflightSummaryLine')

const PASS = { environmentOk: true, ok: true, pluginSummary: { block: 0, warn: 0 }, safeMode: { available: false, candidates: [] } }

test('canStartInstall:预检环境失败时不可开始', () => {
  const report = { ...PASS, ok: false, environmentOk: false, checks: [{ id: 'disk', status: 'block' }] }
  assert.equal(canStartInstall({}, {}, false, report, false), false)
})

test('canStartInstall:插件阻断未开安全模式时不可开始', () => {
  const report = { ...PASS, ok: false, pluginSummary: { block: 1, warn: 0 }, safeMode: { available: true, candidates: [{ name: '@scope/a' }] } }
  assert.equal(canStartInstall({}, {}, false, report, false), false)
  assert.equal(canStartInstall({}, {}, false, report, true), true)
})

test('canStartInstall:预检未加载时维持原安装门禁', () => {
  assert.equal(canStartInstall({}, {}, false, null, false), true)
  assert.equal(canStartInstall({}, {}, false, PASS, false), true)
})

test('preflightSummaryLine:按环境/插件阻断区分提示', () => {
  assert.match(preflightSummaryLine(null), /尚未检查/)
  assert.match(preflightSummaryLine(PASS), /通过/)
  assert.match(preflightSummaryLine({ ...PASS, ok: false, environmentOk: false }), /环境/)
  assert.match(preflightSummaryLine({ ...PASS, ok: false, pluginSummary: { block: 2 }, safeMode: { available: true } }), /安全模式/)
})
