// preflight:升级前检查报告聚合与单项判定。
// Given 环境检查与插件扫描结果 When 生成报告 Then block/warn/pass 与安全模式可用性一致。

import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  CHECK_BLOCK,
  CHECK_PASS,
  CHECK_WARN,
  buildPreflightReport,
  checkDiskSpace,
  checkNodeEngine,
  checkStateStatus,
  formatBytes,
} from '../src/preflight.mjs'

test('buildPreflightReport:任一环境 block 时总体不通过,安全模式不能掩盖', () => {
  const report = buildPreflightReport({
    targetVersion: '0.2.2-rc.3',
    checks: [
      { id: 'disk', label: '磁盘空间', status: CHECK_BLOCK, detail: '空间不足' },
      { id: 'plugins', label: '插件兼容', status: CHECK_BLOCK, detail: '2 个插件不兼容' },
    ],
    pluginScan: {
      available: true,
      safeModeAvailable: true,
      plugins: [
        { name: '@scope/a', status: 'block', reasons: ['不兼容'], safeModeCandidate: true },
        { name: '@scope/b', status: 'warn', reasons: ['未验证'], safeModeCandidate: true },
      ],
      safeModeCandidates: [
        { name: '@scope/a', version: '1.0.0', status: 'block', reasons: ['不兼容'] },
        { name: '@scope/b', version: '1.0.0', status: 'warn', reasons: ['未验证'] },
      ],
    },
    now: 100,
  })
  assert.equal(report.ok, false)
  assert.equal(report.environmentOk, false)
  assert.equal(report.okWithSafeMode, false)
  assert.equal(report.summary.block, 2)
  assert.equal(report.safeMode.candidates.length, 2)
})

test('buildPreflightReport:仅插件 block 且安全模式可用时,安全模式路径可通过', () => {
  const report = buildPreflightReport({
    targetVersion: '0.2.2-rc.3',
    checks: [{ id: 'disk', label: '磁盘空间', status: CHECK_PASS, detail: 'ok' }],
    pluginScan: {
      available: true,
      safeModeAvailable: true,
      plugins: [{ name: '@scope/a', status: 'block', reasons: ['不兼容'], safeModeCandidate: true }],
      safeModeCandidates: [{ name: '@scope/a', version: '1.0.0', status: 'block', reasons: ['不兼容'] }],
    },
    now: 100,
  })
  assert.equal(report.ok, false)
  assert.equal(report.okWithSafeMode, true)
  assert.equal(report.safeMode.available, true)
})

test('buildPreflightReport:默认保护插件不兼容时不允许用安全模式掩盖', () => {
  const report = buildPreflightReport({
    targetVersion: '0.2.2-rc.3',
    checks: [{ id: 'disk', label: '磁盘空间', status: CHECK_PASS, detail: 'ok' }],
    pluginScan: {
      available: true,
      safeModeAvailable: true,
      plugins: [{ name: '@mzzsfy/dsh-auto-trust-all', status: 'block', reasons: ['不兼容'], safeModeProtected: true, safeModeCandidate: false }],
      safeModeCandidates: [],
      protectedPlugins: [{ name: '@mzzsfy/dsh-auto-trust-all' }],
    },
    now: 100,
  })
  assert.equal(report.ok, false)
  assert.equal(report.okWithSafeMode, false)
  assert.equal(report.safeMode.available, false)
  assert.match(report.safeMode.reason, /保护项/)
  assert.deepEqual(report.safeMode.protected, ['@mzzsfy/dsh-auto-trust-all'])
})

test('buildPreflightReport:插件扫描不可用时只降级为 warn,不阻断', () => {
  const report = buildPreflightReport({
    targetVersion: '0.2.2-rc.3',
    checks: [{ id: 'plugins', label: '插件兼容', status: CHECK_WARN, detail: 'pluginManager 不可用' }],
    pluginScan: { available: false, reason: 'pluginManager 不可用', plugins: [], safeModeCandidates: [] },
    now: 100,
  })
  assert.equal(report.ok, true)
  assert.equal(report.summary.warn, 1)
})

test('checkDiskSpace:剩余空间不足以容纳当前槽位加余量时 block', () => {
  const result = checkDiskSpace({ freeBytes: 1000, requiredBytes: 900, marginBytes: 200 })
  assert.equal(result.status, CHECK_BLOCK)
  assert.match(result.detail, /不足/)
})

test('checkDiskSpace:空间充足时 pass 并展示可读大小', () => {
  const result = checkDiskSpace({ freeBytes: 4096, requiredBytes: 1024, marginBytes: 512 })
  assert.equal(result.status, CHECK_PASS)
  assert.match(result.detail, /KB|MB|GB/)
})

test('checkNodeEngine:>= 范围满足时 pass,不满足时 block,无法解析时 warn', () => {
  assert.equal(checkNodeEngine({ currentVersion: '24.14.1', range: '>=24.9.0' }).status, CHECK_PASS)
  assert.equal(checkNodeEngine({ currentVersion: '22.0.0', range: '>=24.9.0' }).status, CHECK_BLOCK)
  assert.equal(checkNodeEngine({ currentVersion: '24.14.1', range: '^24.0.0' }).status, CHECK_WARN)
})

test('checkStateStatus:indeterminate block,awaiting-restart warn,其余 pass', () => {
  assert.equal(checkStateStatus({ phase: 'indeterminate' }).status, CHECK_BLOCK)
  assert.equal(checkStateStatus({ phase: 'awaiting-restart' }).status, CHECK_WARN)
  assert.equal(checkStateStatus({ phase: 'healthy' }).status, CHECK_PASS)
  assert.equal(checkStateStatus(null).status, CHECK_PASS)
})

test('formatBytes:按量级输出 GB/MB/KB', () => {
  assert.equal(formatBytes(1024), '1.0 KB')
  assert.equal(formatBytes(1024 * 1024), '1.0 MB')
  assert.equal(formatBytes(1024 * 1024 * 1024), '1.0 GB')
})
