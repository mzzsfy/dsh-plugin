// parity 测试:client.js LOGIC 标记段与 src/status-meta.mjs 同源对照(turn-notify 模式)。
// 状态元数据双实现同源是规约要求:改一侧必须同步另一侧,测试锁定。

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

import { STATUS_META as coreStatusMeta, TRIGGER_META as coreTriggerMeta } from '../src/status-meta.mjs'

const PKG_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

// 从 client.js 提取 LOGIC 标记段,构造纯逻辑实现
function clientLogic() {
  const source = readFileSync(join(PKG_ROOT, 'src', 'client.js'), 'utf8')
  const begin = source.indexOf('/* LOGIC-BEGIN */')
  const end = source.indexOf('/* LOGIC-END */')
  assert.ok(begin >= 0 && end > begin, 'client.js 缺少 LOGIC 标记段')
  const section = source.slice(begin + '/* LOGIC-BEGIN */'.length, end)
  const factory = new Function(
    section + '; return { STATUS_META, TRIGGER_META, KIND_LABELS, MODE_LABELS, ONMISS_LABELS, relativeTime, formatDateTime, formatDuration, statusMeta };',
  )
  return factory()
}

const client = clientLogic()
const MINUTE = 60 * 1000
const HOUR = 60 * MINUTE
const NOW = 1750000000000

test('parity:STATUS_META 与 core 同源', () => {
  assert.deepEqual(client.STATUS_META, coreStatusMeta)
})

test('parity:TRIGGER_META 与 core 同源', () => {
  assert.deepEqual(client.TRIGGER_META, coreTriggerMeta)
})

test('parity:STATUS_META 覆盖全部落库状态', () => {
  // store/scheduler/executor 可能落库的状态必须都有展示元数据
  for (const status of ['success', 'fail', 'timeout', 'skipped', 'interrupted', 'running']) {
    assert.ok(coreStatusMeta[status], '缺少状态元数据: ' + status)
  }
})

test('parity:relativeTime 未来/过去方向与粒度', () => {
  assert.equal(client.relativeTime(NOW + 3 * HOUR, NOW), '3 小时后')
  assert.equal(client.relativeTime(NOW - 5 * MINUTE, NOW), '5 分钟前')
  assert.equal(client.relativeTime(NOW + 2 * 24 * HOUR, NOW), '2 天后')
  assert.equal(client.relativeTime(undefined, NOW), '-')
})

test('parity:formatDuration 分级呈现', () => {
  assert.equal(client.formatDuration(500), '500ms')
  assert.equal(client.formatDuration(1500), '1.5s')
  assert.equal(client.formatDuration(90 * MINUTE), '90min')
  assert.equal(client.formatDuration(undefined), '-')
})

test('parity:statusMeta 未知状态回退 mute', () => {
  assert.equal(client.statusMeta('whatever').tone, 'mute')
  assert.equal(client.statusMeta(undefined).label, '-')
})
