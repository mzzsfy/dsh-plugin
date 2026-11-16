// parity 测试:client.js LOGIC 标记段与 src/status-meta.mjs 同源对照(turn-notify 模式)。
// 状态元数据双实现同源是规约要求:改一侧必须同步另一侧,测试锁定。

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

import { RUN_STATUSES as coreRunStatuses, STATUS_META as coreStatusMeta, TRIGGER_META as coreTriggerMeta } from '../src/status-meta.mjs'

const PKG_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

// 从 client.js 提取 LOGIC 标记段,构造纯逻辑实现
function clientLogic() {
  const source = readFileSync(join(PKG_ROOT, 'src', 'client.js'), 'utf8')
  const begin = source.indexOf('/* LOGIC-BEGIN */')
  const end = source.indexOf('/* LOGIC-END */')
  assert.ok(begin >= 0 && end > begin, 'client.js 缺少 LOGIC 标记段')
  const section = source.slice(begin + '/* LOGIC-BEGIN */'.length, end)
  const factory = new Function(
    section + '; return { RUN_STATUSES, STATUS_META, TRIGGER_META, KIND_LABELS, MODE_LABELS, relativeTime, formatDateTime, formatDuration, statusMeta };',
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

test('parity:RUN_STATUSES 与 core 同源(client 镜像不了就漏状态词)', () => {
  assert.deepEqual(client.RUN_STATUSES, coreRunStatuses)
})

test('parity:TRIGGER_META 与 core 同源', () => {
  assert.deepEqual(client.TRIGGER_META, coreTriggerMeta)
})

test('parity:STATUS_META 覆盖全部落库状态,且无多余项(清单从常量派生)', () => {
  // 展示元数据 = 落库状态常量名单:少一项即英文状态码直接渲染,多一项即死代码
  assert.deepEqual(Object.keys(coreStatusMeta).sort(), [...coreRunStatuses].sort())
  for (const status of coreRunStatuses) {
    assert.ok(client.STATUS_META[status], 'client 缺少状态元数据: ' + status)
    assert.ok(client.STATUS_META[status].label.length > 0, '状态缺少中文标签: ' + status)
  }
})

test('parity:源码写入的运行状态字面量全部在 RUN_STATUSES 内(派生自实际写点)', () => {
  // Given core 各文件的落库写点
  const files = readdirSync(join(PKG_ROOT, 'src')).filter((name) => name.endsWith('.mjs'))
  const written = new Set()
  for (const name of files) {
    const source = readFileSync(join(PKG_ROOT, 'src', name), 'utf8')
    for (const match of source.matchAll(/status: '([a-z]+)'/g)) written.add(match[1])
  }
  // runUnit 的 result 三态是三元表达式,单独抽取(与 shell-runner 的终态判定同源)
  const shellRunner = readFileSync(join(PKG_ROOT, 'src', 'shell-runner.mjs'), 'utf8')
  const ternary = shellRunner.match(/status: (timedOut \? '([a-z]+)' : code === 0 \? '([a-z]+)' : '([a-z]+)')/)
  assert.ok(ternary, 'shell-runner 终态三元形态变化,需同步本用例')
  written.add(ternary[2])
  written.add(ternary[3])
  written.add(ternary[4])
  // Then 每个写入的状态都有展示元数据(新增状态必须同时补元数据与常量名单)
  for (const status of written) {
    assert.ok(coreRunStatuses.includes(status), '落库状态未登记进 RUN_STATUSES: ' + status)
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

test('parity:maskValue 同源——client LOGIC 段不存在独立实现(API 列表与 prompt 折叠共用 core)', () => {
  // client.js 打码仅经服务端列表返回的已打码值呈现,LOGIC 段不得再出现本地 maskValue 实现
  const source = readFileSync(join(PKG_ROOT, 'src', 'client.js'), 'utf8')
  const begin = source.indexOf('/* LOGIC-BEGIN */')
  const end = source.indexOf('/* LOGIC-END */')
  assert.doesNotMatch(source.slice(begin, end), /maskValue/, 'LOGIC 段出现独立打码实现,违反双实现同源')
})
