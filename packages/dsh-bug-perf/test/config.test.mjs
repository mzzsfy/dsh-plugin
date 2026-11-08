import test from 'node:test'
import assert from 'node:assert/strict'
import { DEFAULT_CONFIG, normalizeConfig } from '../src/config.mjs'

// Given 无配置, When 归一化, Then 两个功能默认开启且阈值取默认
test('配置_缺省_默认全开', () => {
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
    checkMs: 2000,
    stallMs: 8000,
    reconnect: true,
    maxReconnectAttempts: 5,
    reconnectIntervalMs: 15000,
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
  assert.equal(config.stuckSession.checkMs, 2000)
  assert.equal(config.stuckSession.stallMs, 8000)
  assert.equal(config.stuckSession.reconnect, true)
  assert.equal(config.stuckSession.maxReconnectAttempts, 5)
  assert.equal(config.stuckSession.reconnectIntervalMs, 15000)
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
