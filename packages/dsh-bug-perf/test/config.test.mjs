import test from 'node:test'
import assert from 'node:assert/strict'
import { CONFIG_VERSION, DEFAULT_CONFIG, migrateConfig, normalizeConfig } from '../src/config.mjs'

// Given 无配置, When 归一化, Then 各补丁默认开启(诊断上报默认关闭)且阈值取默认
test('配置_缺省_功能默认值与阈值', () => {
  const config = normalizeConfig(undefined)
  assert.deepEqual(config, DEFAULT_CONFIG)
  assert.equal(config.restartCoalesce.enabled, true)
  assert.equal(config.restartCoalesce.windowMs, 100)
  assert.equal(config.terminalWatchdog.enabled, true)
  assert.equal(config.terminalWatchdog.checkMs, 2000)
  assert.equal(config.terminalWatchdog.stallMs, 8000)
  assert.equal(config.terminalWatchdog.cooldownMs, 60000)
})

// Given 只覆盖一个字段, When 归一化, Then 其余字段保持默认
test('配置_部分覆盖_其余保持默认', () => {
  const config = normalizeConfig({ restartCoalesce: { windowMs: 250 } })
  assert.equal(config.restartCoalesce.windowMs, 250)
  assert.equal(config.restartCoalesce.enabled, true)
  assert.equal(config.terminalWatchdog.stallMs, 8000)
})

// Given 功能关闭, When 归一化, Then 关闭语义原样保留而阈值仍可取
test('配置_功能关闭_保留阈值', () => {
  const config = normalizeConfig({ terminalWatchdog: { enabled: false, stallMs: 4000 } })
  assert.equal(config.terminalWatchdog.enabled, false)
  assert.equal(config.terminalWatchdog.stallMs, 4000)
})

// Given 非法类型与越界值, When 归一化, Then 回退默认而不是把坏值带进运行时
test('配置_非法值_回退默认', () => {
  const config = normalizeConfig({
    restartCoalesce: { enabled: 'yes', windowMs: -1 },
    terminalWatchdog: { checkMs: 0, stallMs: 'soon', cooldownMs: Number.NaN },
  })
  assert.equal(config.restartCoalesce.enabled, true)
  assert.equal(config.restartCoalesce.windowMs, 100)
  assert.equal(config.terminalWatchdog.checkMs, 2000)
  assert.equal(config.terminalWatchdog.stallMs, 8000)
  assert.equal(config.terminalWatchdog.cooldownMs, 60000)
})

// Given 超上限的阈值, When 归一化, Then 收敛到上限(防止错误配置把功能变成滥用)
test('配置_越界上限_收敛', () => {
  const config = normalizeConfig({
    restartCoalesce: { windowMs: 60000 },
    terminalWatchdog: { checkMs: 600000, stallMs: 999999999, cooldownMs: 999999999 },
  })
  assert.equal(config.restartCoalesce.windowMs, 2000)
  assert.equal(config.terminalWatchdog.checkMs, 60000)
  assert.equal(config.terminalWatchdog.stallMs, 600000)
  assert.equal(config.terminalWatchdog.cooldownMs, 3600000)
})

// Given 未知字段, When 归一化, Then 被丢弃(配置面只认已声明字段)
test('配置_未知字段_丢弃', () => {
  const config = normalizeConfig({ unknown: 1, restartCoalesce: { windowMs: 150 } })
  assert.equal(config.unknown, undefined)
  assert.equal(config.restartCoalesce.windowMs, 150)
})

// Given 无配置, When 归一化, Then 保活与停滞兜底默认开启且阈值取默认
test('配置_保活与停滞_默认值', () => {
  const config = normalizeConfig(undefined)
  assert.deepEqual(config.socketKeepAlive, { enabled: true, intervalMs: 1500 })
  assert.deepEqual(config.stuckSession, {
    enabled: true,
    checkMs: 3000,
    stallMs: 60000,
    reconnect: true,
    maxReconnectAttempts: 2,
    reconnectIntervalMs: 120000,
  })
  assert.deepEqual(config.jobStreamLimit, { enabled: true, base: 32, max: 48 })
})

// Given 新增补丁的非法值, When 归一化, Then 回退默认而不是把坏值带进运行时
test('配置_保活与停滞_非法值回退', () => {
  const config = normalizeConfig({
    socketKeepAlive: { enabled: 'on', intervalMs: 0 },
    stuckSession: { checkMs: -5, stallMs: 'slow', reconnect: 1, maxReconnectAttempts: Number.NaN, reconnectIntervalMs: 0 },
  })
  assert.equal(config.socketKeepAlive.enabled, true)
  assert.equal(config.socketKeepAlive.intervalMs, 1500)
  assert.equal(config.stuckSession.checkMs, 3000)
  assert.equal(config.stuckSession.stallMs, 60000)
  assert.equal(config.stuckSession.reconnect, true)
  assert.equal(config.stuckSession.maxReconnectAttempts, 2)
  assert.equal(config.stuckSession.reconnectIntervalMs, 120000)
})

// Given 超上限的阈值, When 归一化, Then 收敛到上限
test('配置_保活与停滞_越界收敛', () => {
  const config = normalizeConfig({
    socketKeepAlive: { intervalMs: 999999 },
    stuckSession: { checkMs: 999999, stallMs: 999999999, maxReconnectAttempts: 999999, reconnectIntervalMs: 999999999 },
  })
  assert.equal(config.socketKeepAlive.intervalMs, 60000)
  assert.equal(config.stuckSession.checkMs, 60000)
  assert.equal(config.stuckSession.stallMs, 600000)
  assert.equal(config.stuckSession.maxReconnectAttempts, 20)
  assert.equal(config.stuckSession.reconnectIntervalMs, 600000)
})

// Given 任务流上限被关掉或给了非法值, When 归一化, Then 关闭生效、非法值回退默认
test('配置_任务流上限_开关与回退', () => {
  const off = normalizeConfig({ jobStreamLimit: { enabled: false } })
  assert.equal(off.jobStreamLimit.enabled, false)
  const bad = normalizeConfig({ jobStreamLimit: { base: 0, max: 0 } })
  assert.equal(bad.jobStreamLimit.base, 32)
  assert.equal(bad.jobStreamLimit.max, 48)
  const capped = normalizeConfig({ jobStreamLimit: { max: 99999 } })
  assert.equal(capped.jobStreamLimit.max, 512)
  const inverted = normalizeConfig({ jobStreamLimit: { base: 200, max: 10 } })
  assert.equal(inverted.jobStreamLimit.base, 10)
})

// Given 列表瘦身缺省或关闭, When 归一化, Then 默认开启、显式关闭保留、非法类型回退默认
test('配置_列表瘦身_开关与回退', () => {
  assert.deepEqual(normalizeConfig(undefined).listSlim, { enabled: true })
  assert.equal(normalizeConfig({ listSlim: { enabled: false } }).listSlim.enabled, false)
  assert.equal(normalizeConfig({ listSlim: { enabled: 'off' } }).listSlim.enabled, true)
})

// Given 历史窗口缺省, When 归一化, Then 默认开启且上限为 200 条 / 2 轮
test('配置_历史窗口_默认值', () => {
  assert.deepEqual(normalizeConfig(undefined).sessionWindow, { enabled: true, maxMessages: 200, minMessages: 30, minTurns: 2 })
})

// Given 历史窗口显式开关、非法值与越界值, When 归一化, Then 开关保留、非法值回退、越界收敛
test('配置_历史窗口_开关与边界', () => {
  const off = normalizeConfig({ sessionWindow: { enabled: false, maxMessages: 60 } })
  assert.equal(off.sessionWindow.enabled, false)
  assert.equal(off.sessionWindow.maxMessages, 60)
  const bad = normalizeConfig({ sessionWindow: { enabled: 'on', maxMessages: 0, minTurns: 'two' } })
  assert.equal(bad.sessionWindow.enabled, true)
  assert.equal(bad.sessionWindow.maxMessages, 200)
  assert.equal(bad.sessionWindow.minTurns, 2)
  const capped = normalizeConfig({ sessionWindow: { maxMessages: 9999, minMessages: 9999, minTurns: 9999 } })
  assert.equal(capped.sessionWindow.maxMessages, 500)
  assert.equal(capped.sessionWindow.minMessages, 200)
  assert.equal(capped.sessionWindow.minTurns, 50)
  assert.equal(normalizeConfig({ sessionWindow: { minTurns: 1 } }).sessionWindow.minTurns, 1)
  assert.equal(normalizeConfig({ sessionWindow: { minMessages: 4 } }).sessionWindow.minMessages, 30)
  assert.equal(normalizeConfig({ sessionWindow: { minMessages: 12 } }).sessionWindow.minMessages, 12)
})

// Given 小数配置, When 归一化, Then 截断为整数(宿主只接受正安全整数),字符串仍按非法回退
test('配置_历史窗口_非整数取整', () => {
  const config = normalizeConfig({ sessionWindow: { maxMessages: 200.5, minTurns: 1.9 } })
  assert.equal(config.sessionWindow.maxMessages, 200)
  assert.equal(config.sessionWindow.minTurns, 1)
  assert.equal(normalizeConfig({ sessionWindow: { maxMessages: 20.4 } }).sessionWindow.maxMessages, 20)
  assert.equal(normalizeConfig({ sessionWindow: { maxMessages: '150' } }).sessionWindow.maxMessages, 200)
  assert.equal(normalizeConfig({ sessionWindow: { maxMessages: 19.9 } }).sessionWindow.maxMessages, 200)
})

// Given 诊断上报缺省, When 归一化, Then 默认关闭且上报间隔取默认
test('配置_诊断上报_默认关闭', () => {
  assert.deepEqual(normalizeConfig(undefined).diag, { enabled: false, reportEvery: 12 })
})

// Given 诊断上报显式开关与非法值, When 归一化, Then 开关保留、非法类型回退、间隔越界收敛、未知字段丢弃
test('配置_诊断上报_开关边界', () => {
  const off = normalizeConfig({ diag: { enabled: false, reportEvery: 5 } })
  assert.equal(off.diag.enabled, false)
  assert.equal(off.diag.reportEvery, 5)
  const on = normalizeConfig({ diag: { enabled: true } })
  assert.equal(on.diag.enabled, true)
  const bad = normalizeConfig({ diag: { enabled: 'yes', reportEvery: 'often' } })
  assert.equal(bad.diag.enabled, false)
  assert.equal(bad.diag.reportEvery, 12)
  assert.equal(normalizeConfig({ diag: { reportEvery: 0 } }).diag.reportEvery, 1)
  assert.equal(normalizeConfig({ diag: { reportEvery: 99999 } }).diag.reportEvery, 720)
  assert.deepEqual(normalizeConfig({ diag: { reportEvery: 3, unknown: 1 } }).diag, { enabled: false, reportEvery: 3 })
})

// Given 旧版设置页把当时的默认值落盘, When 读取迁移, Then 旧默认值整节复写为当前默认值
test('配置_版本迁移_旧默认值复写', () => {
  const legacy = {
    stuckSession: { enabled: true, checkMs: 2000, stallMs: 8000, reconnect: true, maxReconnectAttempts: 5, reconnectIntervalMs: 15000 },
  }
  const config = migrateConfig(legacy)
  assert.equal(config.configVersion, CONFIG_VERSION)
  assert.deepEqual(config.stuckSession, DEFAULT_CONFIG.stuckSession)
})

// Given 旧版配置里用户显式改过若干字段, When 迁移, Then 只复写仍等于旧默认值的字段
test('配置_版本迁移_保留用户值', () => {
  const legacy = {
    stuckSession: { enabled: true, checkMs: 2000, stallMs: 30000, reconnect: false, maxReconnectAttempts: 5, reconnectIntervalMs: 15000 },
  }
  const config = migrateConfig(legacy)
  assert.equal(config.stuckSession.stallMs, 30000)
  assert.equal(config.stuckSession.reconnect, false)
  assert.equal(config.stuckSession.checkMs, DEFAULT_CONFIG.stuckSession.checkMs)
  assert.equal(config.stuckSession.maxReconnectAttempts, DEFAULT_CONFIG.stuckSession.maxReconnectAttempts)
  assert.equal(config.stuckSession.reconnectIntervalMs, DEFAULT_CONFIG.stuckSession.reconnectIntervalMs)
})

// Given 已是当前版本的配置, When 迁移, Then 原样归一化, 不把用户选的值当成旧默认值复写
test('配置_版本迁移_当前版本不迁移', () => {
  const current = { configVersion: CONFIG_VERSION, stuckSession: { stallMs: 8000 } }
  assert.equal(migrateConfig(current).stuckSession.stallMs, 8000)
})

// Given 配置缺少版本号, When 迁移, Then 按最低版本处理并补上当前版本号
test('配置_版本迁移_缺版本号补版本', () => {
  const config = migrateConfig({})
  assert.equal(config.configVersion, CONFIG_VERSION)
  assert.deepEqual(config.stuckSession, DEFAULT_CONFIG.stuckSession)
})
