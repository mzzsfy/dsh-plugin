// preflight-runner:环境检查汇总的宿主编排。
// Given 注入布局/文件/registry/插件扫描 When 生成预检报告 Then 硬失败阻断、缺能力降级。

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { CHECK_BLOCK, CHECK_PASS, CHECK_WARN, runPreflight } from '../src/preflight.mjs'

const LAYOUT = {
  prefix: 'C:/prefix',
  root: 'C:/prefix/.dsh-maintain',
  a: 'C:/prefix/.dsh-maintain/install-a',
  b: 'C:/prefix/.dsh-maintain/install-b',
}

function baseOptions(overrides = {}) {
  return {
    targetVersion: '0.2.2-rc.3',
    layout: LAYOUT,
    runningPackage: 'C:/prefix/.dsh-maintain/install-a/node_modules/@deepseek-ai/dsh',
    profileDir: 'C:/profile',
    installAnchor: 'C:/host/package.json',
    pluginManager: { listBundles: async () => [], setBundleEnabled: async () => {} },
    registryBase: 'https://registry.example',
    requiredBytes: 1024,
    now: 100,
    findNpmCliImpl: async () => 'C:/npm-cli.js',
    fetchVersionManifestImpl: async () => ({ version: '0.2.2-rc.3', engines: { node: '>=20.0.0' }, unpackedSize: null }),
    statfsImpl: async () => ({ bsize: 4096, bavail: 1024 * 1024 }),
    accessImpl: async () => {},
    statImpl: async () => { const error = new Error('not found'); error.code = 'ENOENT'; throw error },
    readManagedStateImpl: async () => null,
    scanPluginsImpl: async () => ({ available: true, safeModeAvailable: true, reason: null, plugins: [], safeModeCandidates: [] }),
    selectInactiveSlotImpl: async () => LAYOUT.a,
    ...overrides,
  }
}

test('runPreflight:安装根不存在视为首次升级可创建', async () => {
  const report = await runPreflight(baseOptions())
  const layout = report.checks.find((check) => check.id === 'layout')
  assert.equal(layout.status, CHECK_PASS)
  assert.match(layout.detail, /首次升级将创建/)
})

test('runPreflight:全部检查通过时 ok=true', async () => {
  const report = await runPreflight(baseOptions())
  assert.equal(report.ok, true)
  assert.equal(report.summary.block, 0)
  assert.equal(report.checks.find((check) => check.id === 'disk').status, CHECK_PASS)
})

test('runPreflight:残留 upgrade.lock 触发 block', async () => {
  const report = await runPreflight(baseOptions({
    statImpl: async () => ({ isFile: () => true }),
  }))
  assert.equal(report.ok, false)
  assert.equal(report.checks.find((check) => check.id === 'lock').status, CHECK_BLOCK)
})

test('runPreflight:插件不兼容且安全模式可用时 okWithSafeMode=true', async () => {
  const report = await runPreflight(baseOptions({
    scanPluginsImpl: async () => ({
      available: true,
      safeModeAvailable: true,
      reason: null,
      plugins: [{ name: '@scope/a', status: 'block', reasons: ['不兼容'], safeModeCandidate: true }],
      safeModeCandidates: [{ name: '@scope/a', version: '1.0.0', status: 'block', reasons: ['不兼容'] }],
    }),
  }))
  assert.equal(report.ok, false)
  assert.equal(report.okWithSafeMode, true)
  assert.equal(report.safeMode.available, true)
})

test('runPreflight:插件扫描不可用时仅 warn,不阻断', async () => {
  const report = await runPreflight(baseOptions({
    scanPluginsImpl: async () => ({ available: false, reason: 'pluginManager 不可用', plugins: [], safeModeCandidates: [] }),
  }))
  assert.equal(report.ok, true)
  assert.equal(report.checks.find((check) => check.id === 'plugins').status, CHECK_WARN)
})

test('runPreflight:目标清单体积加安装余量后无空间时 block', async () => {
  const report = await runPreflight(baseOptions({
    requiredBytes: null,
    fetchVersionManifestImpl: async () => ({ version: '0.2.2-rc.3', engines: { node: '>=20.0.0' }, unpackedSize: 1024 }),
    statfsImpl: async () => ({ bsize: 4096, bavail: 0 }),
  }))
  assert.equal(report.ok, false)
  assert.equal(report.checks.find((check) => check.id === 'disk').status, CHECK_BLOCK)
})

test('runPreflight:布局不可用直接 block,不继续读取磁盘', async () => {
  const report = await runPreflight(baseOptions({ layoutError: '不支持的全局安装布局' }))
  assert.equal(report.ok, false)
  assert.equal(report.checks.find((check) => check.id === 'layout').status, CHECK_BLOCK)
})
