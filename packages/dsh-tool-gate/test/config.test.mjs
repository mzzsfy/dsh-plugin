import test from 'node:test'
import assert from 'node:assert/strict'
import { Config, DEFAULT_ALLOWLIST, resolveConfig, resolveConfigStrict, unwrapConfig } from '../src/config.mjs'

test('出厂默认:核心工具白名单 + enabled + collapse', () => {
  const config = resolveConfig({})
  assert.deepEqual(config.allowlist, [...DEFAULT_ALLOWLIST])
  assert.equal(config.enabled, true)
  assert.equal(config.collapse, true)
})

test('volatile ref 容器解箱:get() 协议', () => {
  const config = resolveConfig(unwrapConfig({
    allowlist: { get: () => ['read'] },
    enabled: { get: () => false },
    collapse: { get: () => false },
  }))
  assert.deepEqual(config.allowlist, ['read'])
  assert.equal(config.enabled, false)
  assert.equal(config.collapse, false)
})

test('落盘坏值宽容降级:类型不符键降 schema 默认(行不死)', () => {
  const config = resolveConfig({ allowlist: { broken: true }, enabled: 'yes', collapse: 1 })
  assert.deepEqual(config.allowlist, [...DEFAULT_ALLOWLIST])
  assert.equal(config.enabled, true)
  assert.equal(config.collapse, true)
})

test('执行面严格解析:ref 容器未解箱即抛(炸在收敛点)', () => {
  assert.throws(() => resolveConfigStrict({ allowlist: { get: () => [] } }), /形态非法/)
})

test('执行面严格解析:collapse 非布尔即抛', () => {
  assert.throws(() => resolveConfigStrict({ collapse: 'yes' }), /形态非法/)
})

test('执行面严格解析:普通对象合法输入直通', () => {
  const config = resolveConfigStrict({ allowlist: ['shell'], enabled: false, collapse: false })
  assert.deepEqual(config.allowlist, ['shell'])
  assert.equal(config.enabled, false)
  assert.equal(config.collapse, false)
})

test('resolveConfig 幂等:二轮 resolve 不炸不可扩展产物', () => {
  const first = resolveConfig({ allowlist: ['read'] })
  const second = resolveConfig(first)
  assert.deepEqual(second.allowlist, ['read'])
})
