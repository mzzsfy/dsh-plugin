// 热更新状态机 BDD(官方 apply 骨架同构):facts 比对触发原地 replace,
// 路由清空注销,坏配置保旧;目录空表跳过注册、replace 清空。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRouteManager } from '../src/manager.mjs'
import { resolveRoute } from '../src/config.mjs'

function routesOf(profiles) {
  return new Map(Object.entries(profiles).map(([name, profile]) => [name, resolveRoute(name, profile)]))
}

function harness() {
  const calls = { adapter: [], adapterReplaces: [], directory: [], directoryReplaces: [] }
  const registry = { adapter: null, directory: null }
  const manager = createRouteManager({
    routes: () => routesOf(harness.current),
    registerAdapter: (providers, adapter) => {
      calls.adapter.push(providers)
      registry.adapter = adapter
      return { replace: (next) => calls.adapterReplaces.push(next) }
    },
    registerDirectory: (entries) => {
      calls.directory.push(entries)
      return { replace: (next) => calls.directoryReplaces.push(next) }
    },
  })
  return { manager, calls, registry }
}

function profile(overrides = {}) {
  return {
    api: 'anthropic-messages',
    baseURL: 'https://gw.example.com',
    models: [{ id: 'auto', contextWindow: 200000 }],
    ...overrides,
  }
}

test('零路由休眠:adapter 与目录都不注册;发现逻辑不受影响', () => {
  const { manager, calls } = harness()
  harness.current = {}
  manager.ensureRegistration()
  manager.ensureDirectory()
  assert.equal(calls.adapter.length, 0)
  assert.equal(calls.directory.length, 0)
})

test('路由出现注册 adapter 与目录;再无变化则不重复动作', () => {
  const { manager, calls } = harness()
  harness.current = { a: profile() }
  manager.ensureRegistration()
  manager.ensureDirectory()
  assert.deepEqual(calls.adapter, [['a']])
  assert.deepEqual(calls.directory.map((entries) => entries.map((entry) => entry.provider)), [['a']])
  assert.equal(calls.directory[0][0].settingsNs, 'llm-pi-gateway')
  assert.deepEqual(calls.directory[0][0].settingsPath, ['providers', 'a'])
  assert.equal(calls.directory[0][0].declared, true)
  manager.ensureRegistration()
  manager.ensureDirectory()
  assert.equal(calls.adapter.length, 1)
  assert.equal(calls.directory.length, 1)
})

test('路由集变化:adapter 原地 replace;目录 replace', () => {
  const { manager, calls } = harness()
  harness.current = { a: profile() }
  manager.ensureRegistration()
  manager.ensureDirectory()
  harness.current = { a: profile(), b: profile({ baseURL: 'https://other.example.com' }) }
  manager.ensureRegistration()
  manager.ensureDirectory()
  assert.deepEqual(calls.adapterReplaces, [['a', 'b']])
  assert.deepEqual(calls.directoryReplaces.map((entries) => entries.map((entry) => entry.provider)), [['a', 'b']])
  harness.current = { a: profile() }
  manager.ensureRegistration()
  manager.ensureDirectory()
  assert.deepEqual(calls.adapterReplaces.at(-1), ['a'])
})

test('路由清空:adapter replace 空表注销,目录 replace 清空', () => {
  const { manager, calls } = harness()
  harness.current = { a: profile() }
  manager.ensureRegistration()
  manager.ensureDirectory()
  harness.current = {}
  manager.ensureRegistration()
  manager.ensureDirectory()
  assert.deepEqual(calls.adapterReplaces.at(-1), [])
  assert.deepEqual(calls.directoryReplaces.at(-1), [])
})

test('retryPolicy 或 displayName 变化触发 replace(注册捕获事实)', () => {
  const { manager, calls } = harness()
  harness.current = { a: profile() }
  manager.ensureRegistration()
  harness.current = { a: profile({ retryPolicy: { mode: 'normal', maxRetries: 2 } }) }
  manager.ensureRegistration()
  assert.equal(calls.adapterReplaces.length, 1)
  harness.current = { a: profile({ retryPolicy: { mode: 'normal', maxRetries: 2 }, displayName: 'Fancy' }) }
  manager.ensureRegistration()
  assert.equal(calls.adapterReplaces.length, 2)
})

test('routes() 解析失败:ensure 原样抛出,注册保持不动(调用方负责捕获保旧)', () => {
  const { manager, calls } = harness()
  harness.current = { a: profile() }
  manager.ensureRegistration()
  harness.current = { a: profile({ models: [] }) }
  assert.throws(() => manager.ensureRegistration(), /models/)
  assert.throws(() => manager.ensureDirectory(), /models/)
  assert.equal(calls.adapterReplaces.length, 0)
  assert.equal(calls.directoryReplaces.length, 0)
})

test('providerRetryPolicy 暴露已解析策略(注册捕获路径)', async () => {
  harness.current = { a: profile({ retryPolicy: { mode: 'normal', maxRetries: 5 } }) }
  const adapter = (await import('../src/adapter.mjs')).createGatewayAdapter(routesOf(harness.current))
  assert.equal(adapter.providerRetryPolicy('a').maxRetries, 5)
})
