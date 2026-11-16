// 宿主升级时同步升级插件:版本选择、registry/Git/maintain 跳过与单插件失败隔离。
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

test('upgradeProfilePlugins:升级 registry 插件,跳过 maintain/Git/无更新插件', async () => {
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
    onOutput: (text) => output.push(text),
  })
  assert.deepEqual(result.updated.map((row) => row.name), ['@scope/a'])
  assert.deepEqual(result.skipped.map((row) => row.name), [MAINTAIN_BUNDLE, '@scope/git'])
  assert.deepEqual(calls, [
    ['listVersions', '@scope/a', { registry: 'https://mirror.example/' }],
    ['updateBundle', '@scope/a', '1.1.0', { registry: 'https://registry.example/' }],
  ])
  assert.match(output.join(''), /升级插件 @scope\/a: 1\.0\.0 -> 1\.1\.0/)
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
  assert.deepEqual(result.updated, [])
  assert.deepEqual(result.failed, [])
  assert.equal(result.skipped[0].name, '@scope/old')
  assert.match(result.skipped[0].reason, /严格高于/)
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
  assert.deepEqual(result.updated, [])
  assert.deepEqual(calls, [])
  assert.match(result.skipped[0].reason, /严格高于/)
})

test('upgradeProfilePlugins:单插件失败/异常继续处理后续插件', async () => {
  const manager = {
    listBundles: async () => [
      { name: '@scope/fail', installed: true, update: 'registry', version: '1.0.0' },
      { name: '@scope/throw', installed: true, update: 'registry', version: '1.0.0' },
      { name: '@scope/ok', installed: true, update: 'registry', version: '1.0.0' },
    ],
    listVersions: async (name) => ({
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
  assert.deepEqual(result.updated.map((row) => row.name), ['@scope/ok'])
  assert.deepEqual(result.failed.map((row) => row.name), ['@scope/fail', '@scope/throw'])
  assert.equal(result.failed[0].restoreFailed, true)
  assert.match(result.failed[1].error, /network down/)
})

test('upgradeProfilePlugins:服务方法缺失时直接报错,不伪造成功', async () => {
  await assert.rejects(
    () => upgradeProfilePlugins({ pluginManager: { listBundles: async () => [] } }),
    /listBundles\/listVersions\/updateBundle/,
  )
})
