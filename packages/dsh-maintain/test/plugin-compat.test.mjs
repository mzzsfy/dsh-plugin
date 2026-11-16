// plugin-compat:插件对目标 DSH 版本的兼容判定与安全模式候选。
// Given 插件清单与目标版本 When 扫描 Then 输出 ok/warn/block 与可禁用候选。

import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  MAINTAIN_BUNDLE,
  PLUGIN_BLOCK,
  PLUGIN_OK,
  PLUGIN_WARN,
  classifyPluginCompatibility,
  isSafeModeProtectedPlugin,
  normalizeSafeModeWhitelist,
  scanProfilePlugins,
} from '../src/plugin-compat.mjs'

const TARGET = '0.2.2-rc.3'

function manifest(extra = {}) {
  return {
    name: '@scope/plugin',
    version: '1.0.0',
    ...extra,
  }
}

test('classifyPluginCompatibility:宿主判定不满足 requirements 时为 block,并带需求明细', () => {
  const result = classifyPluginCompatibility({
    manifest: manifest({ engines: { dsh: '>=0.3.0' } }),
    targetVersion: TARGET,
    evaluator: () => ({
      name: '@scope/plugin',
      version: '1.0.0',
      runtimeVersion: TARGET,
      requirements: { 'engines.dsh': '>=0.3.0' },
      exempted: false,
    }),
  })
  assert.equal(result.status, PLUGIN_BLOCK)
  assert.match(result.reasons.join(' '), /engines\.dsh/)
})

test('classifyPluginCompatibility:宿主判定已豁免时为 warn,不进入 block', () => {
  const result = classifyPluginCompatibility({
    manifest: manifest({ engines: { dsh: '>=0.3.0' } }),
    targetVersion: TARGET,
    evaluator: () => ({
      name: '@scope/plugin',
      version: '1.0.0',
      runtimeVersion: TARGET,
      requirements: { 'engines.dsh': '>=0.3.0' },
      exempted: true,
    }),
  })
  assert.equal(result.status, PLUGIN_WARN)
  assert.match(result.reasons.join(' '), /豁免/)
})

test('classifyPluginCompatibility:仓库兼容矩阵声明 compatible 且宿主无异议时为 ok', () => {
  const result = classifyPluginCompatibility({
    manifest: manifest({ dsh: { compatibility: { dshReleases: { [TARGET]: 'compatible' } } } }),
    targetVersion: TARGET,
    evaluator: () => undefined,
  })
  assert.deepEqual(result, { status: PLUGIN_OK, reasons: [] })
})

test('classifyPluginCompatibility:仓库矩阵声明 unknown 时为 warn', () => {
  const result = classifyPluginCompatibility({
    manifest: manifest({ dsh: { compatibility: { dshReleases: { [TARGET]: 'unknown' } } } }),
    targetVersion: TARGET,
    evaluator: () => undefined,
  })
  assert.equal(result.status, PLUGIN_WARN)
  assert.match(result.reasons.join(' '), /未验证/)
})

test('classifyPluginCompatibility:未声明兼容矩阵时为 warn,不能冒充已验证', () => {
  const result = classifyPluginCompatibility({
    manifest: manifest(),
    targetVersion: TARGET,
    evaluator: () => undefined,
  })
  assert.equal(result.status, PLUGIN_WARN)
  assert.match(result.reasons.join(' '), /未声明/)
})

test('classifyPluginCompatibility:声明了矩阵但没有目标版本时为 warn', () => {
  const result = classifyPluginCompatibility({
    manifest: manifest({ dsh: { compatibility: { dshReleases: { '0.2.1': 'compatible' } } } }),
    targetVersion: TARGET,
    evaluator: () => undefined,
  })
  assert.equal(result.status, PLUGIN_WARN)
  assert.match(result.reasons.join(' '), /目标版本/)
})

test('scanProfilePlugins:只把用户安装且非 ok 的非只读插件列为安全模式候选', async () => {
  const rows = [
    { name: '@mzzsfy/dsh-usage-panel', version: '1.0.0', enabled: true, installed: true, availability: 'profile', official: false },
    { name: '@mzzsfy/dsh-tunnel', version: '1.0.0', enabled: true, installed: true, availability: 'profile', official: false },
    { name: '@mzzsfy/dsh-auto-trust-all', version: '1.0.0', enabled: true, installed: true, availability: 'profile', official: false },
    { name: MAINTAIN_BUNDLE, version: '1.0.0', enabled: true, installed: true, availability: 'profile', official: false },
    { name: '@scope/readonly', version: '1.0.0', enabled: true, installed: true, availability: 'profile', official: false, readOnlyReason: 'management-required' },
    { name: '@deepseek-ai/dsh-web-app', version: '0.2.2-rc.3', enabled: true, installed: true, availability: 'installation', official: true },
    { name: '@scope/good', version: '1.0.0', enabled: true, installed: true, availability: 'profile', official: false },
    { name: '@scope/disabled', version: '1.0.0', enabled: false, installed: true, availability: 'profile', official: false },
    { name: '@scope/not-bundle', version: '1.0.0', enabled: true, installed: true, availability: 'profile', official: false, error: { code: 'not-bundle' } },
  ]
  const manifests = {
    '@mzzsfy/dsh-usage-panel': manifest({ name: '@mzzsfy/dsh-usage-panel', dsh: { compatibility: { dshReleases: { [TARGET]: 'unknown' } } } }),
    '@mzzsfy/dsh-tunnel': manifest({ name: '@mzzsfy/dsh-tunnel', dsh: { compatibility: { dshReleases: { [TARGET]: 'unknown' } } } }),
    '@mzzsfy/dsh-auto-trust-all': manifest({ name: '@mzzsfy/dsh-auto-trust-all', dsh: { compatibility: { dshReleases: { [TARGET]: 'unknown' } } } }),
    [MAINTAIN_BUNDLE]: manifest({ name: MAINTAIN_BUNDLE, dsh: { compatibility: { dshReleases: { [TARGET]: 'compatible' } } } }),
    '@scope/readonly': manifest({ name: '@scope/readonly' }),
    '@scope/good': manifest({ name: '@scope/good', dsh: { compatibility: { dshReleases: { [TARGET]: 'compatible' } } } }),
  }
  const report = await scanProfilePlugins({
    profileDir: 'C:/fake-profile',
    targetVersion: TARGET,
    pluginManager: {
      listBundles: async () => rows,
    },
    loadEvaluator: () => ({
      evaluate: () => undefined,
      readExemptions: () => ({}),
    }),
    readFileImpl: async (path) => {
      const name = Object.keys(manifests).find((key) => path.includes(key.split('/').pop()))
      if (!name) throw new Error('ENOENT')
      return JSON.stringify(manifests[name])
    },
  })
  assert.equal(report.available, true)
  const candidates = report.safeModeCandidates.map((row) => row.name)
  assert.deepEqual(candidates.sort(), ['@mzzsfy/dsh-tunnel', '@mzzsfy/dsh-usage-panel'])
  assert.equal(report.plugins.some((row) => row.name === '@scope/not-bundle'), false)
  assert.equal(report.plugins.find((row) => row.name === MAINTAIN_BUNDLE).status, PLUGIN_OK)
  assert.deepEqual(report.protectedPlugins.map((row) => row.name), ['@mzzsfy/dsh-auto-trust-all'])
  assert.equal(report.plugins.find((row) => row.name === '@mzzsfy/dsh-auto-trust-all').safeModeCandidate, false)
  assert.match(report.plugins.find((row) => row.name === '@mzzsfy/dsh-auto-trust-all').reasons.join(' '), /默认保护/)
  assert.equal(report.plugins.find((row) => row.name === '@mzzsfy/dsh-tunnel').safeModeCandidate, true)
})

test('isSafeModeProtectedPlugin:默认只保护三个关键插件', () => {
  assert.equal(isSafeModeProtectedPlugin(MAINTAIN_BUNDLE), true)
  assert.equal(isSafeModeProtectedPlugin('@mzzsfy/dsh-auto-trust-all'), true)
  assert.equal(isSafeModeProtectedPlugin('dsh-web-startup-auth'), true)
  assert.equal(isSafeModeProtectedPlugin('@mzzsfy/dsh-tunnel'), false)
  assert.equal(isSafeModeProtectedPlugin('@acme/dsh-web-auth'), false)
  assert.equal(isSafeModeProtectedPlugin('@acme/auth'), false)
  assert.equal(isSafeModeProtectedPlugin('@acme/dsh-llm-pi-gateway'), false)
})

test('normalizeSafeModeWhitelist:逗号/换行分隔、去空去重并截断', () => {
  assert.deepEqual(normalizeSafeModeWhitelist(' @scope/a, @scope/b\n@scope/a '), ['@scope/a', '@scope/b'])
  assert.deepEqual(normalizeSafeModeWhitelist(['@scope/a', '', null, '@scope/a']), ['@scope/a'])
})

test('scanProfilePlugins:白名单插件不进入安全模式候选并带原因', async () => {
  const rows = [{ name: '@scope/custom', version: '1.0.0', enabled: true, installed: true, availability: 'profile', official: false }]
  const report = await scanProfilePlugins({
    profileDir: 'C:/fake-profile',
    targetVersion: TARGET,
    pluginManager: { listBundles: async () => rows },
    safeModeWhitelist: ['@scope/custom'],
    loadEvaluator: () => ({ evaluate: () => undefined, readExemptions: () => ({}) }),
    readFileImpl: async () => JSON.stringify(manifest({ name: '@scope/custom' })),
  })
  const plugin = report.plugins[0]
  assert.equal(plugin.safeModeProtected, true)
  assert.equal(plugin.safeModeWhitelisted, true)
  assert.equal(plugin.safeModeCandidate, false)
  assert.match(plugin.reasons.join(' '), /白名单/)
  assert.deepEqual(report.safeModeCandidates, [])
})

test('scanProfilePlugins:pluginManager 缺失时返回 unavailable,不抛错', async () => {
  const report = await scanProfilePlugins({ profileDir: 'C:/fake-profile', targetVersion: TARGET, pluginManager: null })
  assert.equal(report.available, false)
  assert.match(report.reason, /pluginManager/)
})
