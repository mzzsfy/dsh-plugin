// plugin-compat:插件对目标 DSH 版本的兼容判定与安全模式候选。
// Given 插件清单与目标版本 When 扫描 Then 输出 ok/warn/block 与可禁用候选。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import {
  MAINTAIN_BUNDLE,
  PLUGIN_BLOCK,
  PLUGIN_OK,
  PLUGIN_WARN,
  classifyPluginCompatibility,
  isSafeModeProtectedPlugin,
  normalizeSafeModeWhitelist,
  scanProfilePlugins,
  scanCandidatePlugins,
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

function scanFixture(overrides = {}) {
  return scanProfilePlugins({
    profileDir: 'C:/fake-profile',
    targetVersion: TARGET,
    pluginManager: {
      listBundles: async () => [{ name: '@scope/plugin', enabled: true, installed: true, availability: 'profile' }],
      setBundleEnabled: async () => {},
    },
    loadEvaluator: () => ({ evaluate: () => undefined, readExemptions: () => ({}) }),
    readFileImpl: async () => JSON.stringify(manifest()),
    ...overrides,
  })
}

// Given 宿主兼容 API 缺失或损坏 When 严格扫描 Then 不可用且说明故障。
for (const [label, api, reason] of [
  ['整个 API 缺失', null, /宿主.*兼容/],
  ['evaluator 缺失', { readExemptions: () => ({}) }, /evaluate/],
  ['evaluator 不可调用', { evaluate: true, readExemptions: () => ({}) }, /evaluate/],
  ['readExemptions 缺失', { evaluate: () => undefined }, /readExemptions/],
  ['readExemptions 不可调用', { evaluate: () => undefined, readExemptions: true }, /readExemptions/],
]) {
  test('scanProfilePlugins:strict ' + label + ' 时不可放行', async () => {
    const report = await scanFixture({ strict: true, loadEvaluator: () => api })
    assert.equal(report.available, false)
    assert.equal(report.safeModeAvailable, false)
    assert.match(report.reason, reason)
  })
}

for (const strict of [false, true]) {
  test('scanProfilePlugins:' + (strict ? 'strict' : '默认') + ' 宿主 API 加载异常', async () => {
    const options = { loadEvaluator: () => { throw new Error('host-load-broken') } }
    if (!strict) {
      await assert.rejects(scanFixture(options), /host-load-broken/)
      return
    }
    const report = await scanFixture({ ...options, strict })
    assert.equal(report.available, false)
    assert.match(report.reason, /宿主.*兼容.*host-load-broken/)
  })
}

// Given 全局豁免读取失败 When 扫描 Then 仅严格模式不可用。
for (const strict of [false, true]) {
  test('scanProfilePlugins:' + (strict ? 'strict' : '默认') + ' 豁免读取异常', async () => {
    const report = await scanFixture({
      strict,
      loadEvaluator: () => ({ evaluate: () => undefined, readExemptions: async () => { throw new Error('exemptions-broken') } }),
    })
    assert.equal(report.available, !strict)
    if (strict) {
      assert.equal(report.safeModeAvailable, false)
      assert.match(report.reason, /豁免.*exemptions-broken/)
      assert.deepEqual(report.plugins, [])
    } else {
      assert.equal(report.plugins[0].status, PLUGIN_WARN)
      assert.match(report.plugins[0].reasons.join(' '), /未声明/)
    }
  })
}

// Given 单插件读取或判定失败 When 扫描 Then 仅该插件标为未知警告。
for (const [label, overrides, reason] of [
  ['manifest 读取失败', {
    readFileImpl: async () => { throw new Error('manifest-ENOENT') },
  }, /读取插件清单失败.*manifest-ENOENT/],
  ['manifest 解析失败', {
    readFileImpl: async () => '{broken-json',
  }, /读取插件清单失败/],
  ['evaluator 抛错', {
    loadEvaluator: () => ({ evaluate: () => { throw new Error('evaluator-broken') }, readExemptions: () => ({}) }),
  }, /兼容判定失败.*evaluator-broken/],
  ['manifest 缺少对象', {
    readFileImpl: async () => 'null',
  }, /读取插件清单失败/],
  ['manifest 抛出无法转为字符串的值', {
    readFileImpl: async () => { throw Object.create(null) },
  }, /读取插件清单失败.*未知错误/],
]) {
  for (const strict of [false, true]) {
    test('scanProfilePlugins:' + (strict ? 'strict' : '默认') + ' ' + label, async () => {
      const report = await scanFixture({ ...overrides, strict })
      assert.equal(report.available, true)
      assert.equal(report.reason, null)
      assert.equal(report.plugins.length, 1)
      assert.equal(report.plugins[0].status, PLUGIN_WARN)
      assert.match(report.plugins[0].reasons.join(' '), reason)
    })
  }
}

test('scanProfilePlugins:默认宿主 API 缺失时继续矩阵预检', async () => {
  const report = await scanFixture({ loadEvaluator: () => null })
  assert.equal(report.available, true)
  assert.equal(report.plugins[0].status, PLUGIN_WARN)
})

// Given 可用宿主 API When 严格扫描 Then 正常分类与启用插件筛选不变。
for (const [label, evaluate, status] of [
  ['无声明仍警告', () => undefined, PLUGIN_WARN],
  ['不兼容仍阻断', () => ({ requirements: { 'engines.dsh': '>=0.3.0' }, exempted: false }), PLUGIN_BLOCK],
]) {
  test('scanProfilePlugins:strict ' + label, async () => {
    const report = await scanFixture({
      strict: true,
      loadEvaluator: () => ({ evaluate, readExemptions: () => ({}) }),
    })
    assert.equal(report.available, true)
    assert.equal(report.plugins[0].status, status)
  })
}

test('scanProfilePlugins:strict 正常时向 evaluator 传递豁免与目标版本', async () => {
  const exemptions = { '@scope/plugin': true }
  const report = await scanFixture({
    strict: true,
    loadEvaluator: () => ({
      evaluate: (value, receivedExemptions, targetVersion) => {
        assert.equal(value.name, '@scope/plugin')
        assert.deepEqual(receivedExemptions, exemptions)
        assert.equal(targetVersion, TARGET)
      },
      readExemptions: () => exemptions,
    }),
    readFileImpl: async () => JSON.stringify(manifest({ dsh: { compatibility: { dshReleases: { [TARGET]: 'compatible' } } } })),
  })
  assert.equal(report.available, true)
  assert.equal(report.plugins[0].status, PLUGIN_OK)
})

test('scanProfilePlugins:strict 不读取已禁用、未安装、官方及非 bundle 插件的 manifest', async () => {
  const report = await scanFixture({
    strict: true,
    pluginManager: { listBundles: async () => [
      { name: '@scope/disabled', enabled: false, installed: true },
      { name: '@scope/uninstalled', enabled: true, installed: false },
      { name: '@scope/official', enabled: true, installed: true, official: true },
      { name: '@scope/installation', enabled: true, installed: true, availability: 'installation' },
      { name: '@scope/not-bundle', enabled: true, installed: true, error: { code: 'not-bundle' } },
    ] },
    readFileImpl: async () => { throw new Error('不应读取被筛除插件') },
  })
  assert.equal(report.available, true)
  assert.deepEqual(report.plugins, [])
})

test('scanProfilePlugins:strict 保护插件读取失败仍报告警告且不进入安全模式候选', async () => {
  const report = await scanFixture({
    strict: true,
    pluginManager: { listBundles: async () => [
      { name: '@scope/plugin', enabled: true, installed: true },
      { name: MAINTAIN_BUNDLE, enabled: true, installed: true },
    ] },
    readFileImpl: async (path) => {
      if (path.includes('dsh-maintain')) throw new Error('protected-manifest-broken')
      return JSON.stringify(manifest())
    },
  })
  assert.equal(report.available, true)
  const protectedPlugin = report.plugins.find((row) => row.name === MAINTAIN_BUNDLE)
  assert.equal(protectedPlugin.status, PLUGIN_WARN)
  assert.match(protectedPlugin.reasons.join(' '), /protected-manifest-broken/)
  assert.equal(protectedPlugin.safeModeProtected, true)
  assert.equal(protectedPlugin.safeModeCandidate, false)
})

// Given 候选中同时有明确不兼容和未知项 When Worker 严格复检 Then 两种顺序都保留明确阻断。
for (const [label, names] of [
  ['未知项在前', ['malformed', 'throws', 'blocked']],
  ['明确阻断在前', ['blocked', 'malformed', 'throws']],
]) {
  test('候选复检:' + label + ' 时只警告未知项并保留明确阻断', async (t) => {
    const root = await mkdtemp(join(tmpdir(), 'maintain-candidate-scan-'))
    t.after(() => rm(root, { recursive: true, force: true }))
    const candidateSlot = join(root, 'slot')
    const installAnchor = join(candidateSlot, 'package.json')
    const profileDir = join(root, 'profile')
    const evaluatorDir = join(candidateSlot, 'node_modules', '@deepseek-ai', 'dsh-app-boot')
    await mkdir(evaluatorDir, { recursive: true })
    await writeFile(join(evaluatorDir, 'index.js'), `exports.readProfileVersionExemptions = () => ({})
      exports.evaluatePluginCompatibility = ({ name }) => {
        if (name === 'throws') throw Symbol('evaluator-broken')
        return { requirements: { 'engines.dsh': '>=0.3.0' } }
      }`)
    for (const name of names) {
      const dir = join(profileDir, 'node_modules', name)
      await mkdir(dir, { recursive: true })
      await writeFile(join(dir, 'package.json'), name === 'malformed' ? '{broken-json' : JSON.stringify(manifest({ name })))
    }
    const report = await scanCandidatePlugins({
      profileDir, installAnchor, targetVersion: TARGET, candidateSlot,
      pluginManager: { listBundles: async () => names.map((name) => ({ name, enabled: true, installed: true })) },
    })
    assert.deepEqual(report.plugins.filter((row) => row.status === PLUGIN_BLOCK).map((row) => row.name), ['blocked'])
    assert.equal(report.available, true)
    assert.equal(report.reason, null)
    const warnings = report.plugins.filter((row) => row.status === PLUGIN_WARN)
    assert.deepEqual(warnings.map((row) => row.name), ['malformed', 'throws'])
    assert.match(warnings[0].reasons.join(' '), /读取插件清单失败/)
    assert.match(warnings[1].reasons.join(' '), /兼容判定失败.*evaluator-broken/)
  })
}

test('候选复检:拒绝解析到槽外的评估器,同槽重装后读取新评估器', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'maintain-candidate-scan-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const slot = join(root, 'slot')
  const anchor = join(slot, 'node_modules', '@deepseek-ai', 'dsh', 'package.json')
  const profileDir = join(root, 'profile')
  const pluginFile = join(profileDir, 'node_modules', '@scope', 'plugin', 'package.json')
  for (const file of [anchor, pluginFile]) {
    await mkdir(dirname(file), { recursive: true })
    await writeFile(file, JSON.stringify(manifest()))
  }
  async function installEvaluator(parent, verdict) {
    const file = join(parent, 'node_modules', '@deepseek-ai', 'dsh-app-boot', 'index.cjs')
    await mkdir(dirname(file), { recursive: true })
    await writeFile(join(dirname(file), 'package.json'), JSON.stringify({ main: 'index.cjs' }))
    await writeFile(file, `module.exports = { readProfileVersionExemptions: () => ({}), evaluatePluginCompatibility: () => ${verdict} }`)
  }
  await installEvaluator(root, 'undefined')
  const options = {
    profileDir, installAnchor: anchor, targetVersion: TARGET, strict: true, candidateSlot: slot,
    pluginManager: { listBundles: async () => [{ name: '@scope/plugin', enabled: true, installed: true }] },
  }
  const missing = await scanCandidatePlugins(options)
  assert.equal(missing.available, false)
  await installEvaluator(slot, 'undefined')
  const first = await scanCandidatePlugins(options)
  assert.equal(first.available, true)
  assert.equal(first.plugins[0].status, PLUGIN_WARN)
  await installEvaluator(slot, '({ requirements: { dsh: ">99" } })')
  const second = await scanCandidatePlugins(options)
  assert.equal(second.available, true)
  assert.equal(second.plugins[0].status, PLUGIN_BLOCK)
})

test('scanProfilePlugins:pluginManager 缺失时返回 unavailable,不抛错', async () => {
  const report = await scanProfilePlugins({ profileDir: 'C:/fake-profile', targetVersion: TARGET, pluginManager: null })
  assert.equal(report.available, false)
  assert.match(report.reason, /pluginManager/)
})
