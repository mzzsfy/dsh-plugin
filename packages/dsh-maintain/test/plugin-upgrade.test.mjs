// 宿主升级前的插件升级:版本选择、registry/Git/内置跳过、逐插件进度事件与单插件失败隔离。
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { choosePluginVersion, supportsPluginUpgrade, upgradeProfilePlugins } from '../src/plugin-upgrade.mjs'
import { MAINTAIN_BUNDLE } from '../src/plugin-compat.mjs'

test('supportsPluginUpgrade:三个方法齐全才可用', () => {
  assert.equal(supportsPluginUpgrade({}), false)
  assert.equal(supportsPluginUpgrade({ listBundles() {}, listVersions() {} }), false)
  assert.equal(supportsPluginUpgrade({ listBundles() {}, listVersions() {}, updateBundle() {} }), true)
})

test('choosePluginVersion:优先稳定版,跳过弃用/不兼容/非组合包', () => {
  const versions = [
    { version: '3.0.0', bundle: true, prerelease: false },
    { version: '2.1.0', bundle: true, prerelease: true },
    { version: '2.0.0', bundle: true, prerelease: false, deprecated: 'old' },
    { version: '1.9.0', bundle: true, prerelease: false, incompatible: { requirements: {} } },
    { version: '1.8.0', bundle: false, prerelease: false },
    { version: '1.7.0', bundle: true, prerelease: false },
  ]
  assert.equal(choosePluginVersion(versions, '1.0.0').version, '3.0.0')
  assert.equal(choosePluginVersion([], '1.0.0'), null)
  assert.equal(choosePluginVersion(null, '1.0.0'), null)
})

test('choosePluginVersion:没有稳定版时退回最新的兼容预发布版', () => {
  assert.equal(choosePluginVersion([
    { version: '2.0.0-beta.1', bundle: true, prerelease: true },
    { version: '1.0.0', bundle: true, prerelease: false, incompatible: {} },
  ], '1.0.0').version, '2.0.0-beta.1')
})

test('choosePluginVersion:只接受严格高于已装版本,不降级', () => {
  assert.equal(choosePluginVersion([
    { version: '1.0.0', bundle: true, prerelease: false },
    { version: '0.9.0', bundle: true, prerelease: false },
  ], '1.0.0'), null)
  assert.equal(choosePluginVersion([
    { version: '1.1.0-beta.1', bundle: true, prerelease: true },
    { version: '1.0.0', bundle: true, prerelease: false },
  ], '1.0.0').version, '1.1.0-beta.1')
  assert.equal(choosePluginVersion([{ version: '1.1.0', bundle: true }], null), null)
  assert.equal(choosePluginVersion([{ version: '1.1.0', bundle: true }], 'not-semver'), null)
})

test('upgradeProfilePlugins:升级 registry 插件,清单不含 maintain/Git/内置', async () => {
  const calls = []
  const manager = {
    listBundles: async () => [
      { name: MAINTAIN_BUNDLE, installed: true, update: 'registry', version: '1.0.0' },
      { name: '@scope/a', installed: true, update: 'registry', version: '1.0.0' },
      { name: '@scope/git', installed: true, update: 'git', version: '1.0.0' },
      { name: '@scope/official', installed: true, version: '1.0.0' },
      { name: '@scope/missing', installed: false, update: 'registry' },
    ],
    listVersions: async (name, options) => {
      calls.push(['listVersions', name, options])
      return {
        status: 'listed',
        installed: '1.0.0',
        registry: 'https://registry.example/',
        versions: [{ version: '1.1.0', bundle: true, prerelease: false }],
      }
    },
    updateBundle: async (name, version, options) => {
      calls.push(['updateBundle', name, version, options])
      return { from: '1.0.0', to: version, step: 'install', result: { application: 'applied', changed: true } }
    },
  }
  const output = []
  const result = await upgradeProfilePlugins({
    pluginManager: manager,
    registryBase: 'https://mirror.example/',
    newRequestId: () => 'req-1',
    onOutput: (text) => output.push(text),
  })
  assert.deepEqual(result.items.map((row) => [row.name, row.state, row.from, row.to]), [
    ['@scope/a', 'updated', '1.0.0', '1.1.0'],
  ])
  assert.deepEqual(calls, [
    ['listVersions', '@scope/a', { registry: 'https://mirror.example/' }],
    ['updateBundle', '@scope/a', '1.1.0', { registry: 'https://registry.example/', requestId: 'req-1' }],
  ])
  assert.match(output.join(''), /升级插件 @scope\/a: 1\.0\.0 -> 1\.1\.0/)
})

test('upgradeProfilePlugins:逐插件快照与宿主步骤 requestId 事件', async () => {
  const events = []
  const manager = {
    listBundles: async () => [{ name: '@scope/a', installed: true, update: 'registry', version: '1.0.0' }],
    listVersions: async () => ({
      status: 'listed',
      installed: '1.0.0',
      registry: null,
      versions: [{ version: '1.1.0', bundle: true, prerelease: false }],
    }),
    updateBundle: async (name, version) => ({ from: '1.0.0', to: version, step: 'install', result: { application: 'applied', changed: true } }),
  }
  await upgradeProfilePlugins({
    pluginManager: manager,
    newRequestId: () => 'req-a',
    onItem: (event) => events.push(event),
  })
  const snapshots = events.filter((event) => event.kind === 'snapshot').map((event) => event.items.map((item) => item.state))
  assert.deepEqual(snapshots[0], ['pending'])
  assert.ok(snapshots.some((states) => states[0] === 'checking'))
  assert.ok(snapshots.some((states) => states[0] === 'upgrading'))
  assert.deepEqual(snapshots[snapshots.length - 1], ['updated'])
  assert.deepEqual(events.filter((event) => event.kind === 'step'), [
    { kind: 'step', name: '@scope/a', index: 1, total: 1, requestId: 'req-a' },
  ])
})

test('upgradeProfilePlugins:候选不高于已装版本时跳过,不调用 updateBundle', async () => {
  const calls = []
  const manager = {
    listBundles: async () => [{ name: '@scope/old', installed: true, update: 'registry', version: '1.0.0' }],
    listVersions: async () => ({
      status: 'listed',
      installed: '1.0.0',
      registry: null,
      versions: [{ version: '0.9.0', bundle: true, prerelease: false }],
    }),
    updateBundle: async (...args) => { calls.push(args) },
  }
  const result = await upgradeProfilePlugins({ pluginManager: manager })
  assert.equal(result.items[0].state, 'skipped')
  assert.match(result.items[0].reason, /严格高于/)
  assert.deepEqual(calls, [])
})

test('upgradeProfilePlugins:已装版本来源不一致时取较高者,仍不降级', async () => {
  const calls = []
  const manager = {
    listBundles: async () => [{ name: '@scope/old', installed: true, update: 'registry', version: '1.2.0' }],
    listVersions: async () => ({
      status: 'listed',
      installed: '1.0.0',
      registry: null,
      versions: [{ version: '1.1.0', bundle: true, prerelease: false }],
    }),
    updateBundle: async (...args) => { calls.push(args) },
  }
  const result = await upgradeProfilePlugins({ pluginManager: manager })
  assert.equal(result.items[0].state, 'skipped')
  assert.deepEqual(calls, [])
  assert.match(result.items[0].reason, /严格高于/)
})

test('upgradeProfilePlugins:单插件失败/异常继续处理后续插件', async () => {
  const manager = {
    listBundles: async () => [
      { name: '@scope/fail', installed: true, update: 'registry', version: '1.0.0' },
      { name: '@scope/throw', installed: true, update: 'registry', version: '1.0.0' },
      { name: '@scope/ok', installed: true, update: 'registry', version: '1.0.0' },
    ],
    listVersions: async () => ({
      status: 'listed',
      installed: '1.0.0',
      registry: null,
      versions: [{ version: '1.1.0', bundle: true, prerelease: false }],
    }),
    updateBundle: async (name) => {
      if (name === '@scope/throw') throw new Error('network down')
      if (name === '@scope/fail') {
        return {
          from: '1.0.0',
          to: '1.1.0',
          step: 'install',
          result: { application: 'failed', changed: false, error: { code: 'operation-error' } },
          restore: { application: 'failed' },
        }
      }
      return { from: '1.0.0', to: '1.1.0', step: 'install', result: { application: 'restart-required', changed: true } }
    },
  }
  const result = await upgradeProfilePlugins({ pluginManager: manager })
  const byName = new Map(result.items.map((row) => [row.name, row]))
  assert.equal(byName.get('@scope/ok').state, 'updated')
  assert.equal(byName.get('@scope/fail').state, 'failed')
  assert.equal(byName.get('@scope/fail').restoreFailed, true)
  assert.equal(byName.get('@scope/throw').state, 'failed')
  assert.match(byName.get('@scope/throw').error, /network down/)
})

test('upgradeProfilePlugins:版本列表不可用时失败,不能把未检查伪装成已是最新版', async () => {
  const manager = {
    listBundles: async () => [{ name: '@scope/a', installed: true, update: 'registry', version: '1.0.0' }],
    listVersions: async () => ({ status: 'unavailable', reason: 'registry unavailable' }),
    updateBundle: async () => { throw new Error('不得安装未知版本') },
  }
  const result = await upgradeProfilePlugins({ pluginManager: manager })
  assert.equal(result.items[0].state, 'failed')
  assert.match(result.items[0].error, /registry unavailable/)
})

test('upgradeProfilePlugins:服务方法缺失时直接报错,不伪造成功', async () => {
  await assert.rejects(
    () => upgradeProfilePlugins({ pluginManager: { listBundles: async () => [] } }),
    /listBundles\/listVersions\/updateBundle/,
  )
})
