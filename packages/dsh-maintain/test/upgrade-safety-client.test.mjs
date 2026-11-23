// 升级安全客户端逻辑:预检结果驱动安装按钮与安全模式提示。
// Given 预检报告与升级选项 When 判断能否开始安装 Then 环境阻断不可越过,插件阻断可由安全模式或先升级插件处理。

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

for (const environmentOk of [true, undefined]) {
  test('canStartInstall:先升级插件时仅插件阻断且 environmentOk=' + String(environmentOk) + '允许开始', () => {
    // Given 只有插件阻断,安全模式不可用且未显式报告环境失败
    const report = {
      ...PASS, ok: false, environmentOk, okWithSafeMode: false,
      pluginSummary: { block: 1, warn: 0 }, safeMode: { available: false, candidates: [] },
    }
    // When 第六参明确要求先升级插件 Then 不依赖安全模式豁免也能开始
    assert.equal(canStartInstall({}, {}, false, report, false, true), true)
    assert.equal(canStartInstall({}, {}, false, report, false, false), false)
  })
}

test('canStartInstall:先升级插件仍不可越过环境阻断', () => {
  // Given 环境与插件均有阻断 When 开启先升级插件 Then 安全模式开关均不能越过环境门
  const report = {
    ...PASS, ok: false, environmentOk: false, pluginSummary: { block: 1, warn: 0 },
    checks: [{ id: 'disk', status: 'block' }], safeMode: { available: true, candidates: [{ name: '@scope/a' }] },
  }
  assert.equal(canStartInstall({}, {}, false, report, false, true), false)
  assert.equal(canStartInstall({}, {}, false, report, true, true), false)
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
