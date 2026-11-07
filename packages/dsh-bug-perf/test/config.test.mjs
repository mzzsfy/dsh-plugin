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
