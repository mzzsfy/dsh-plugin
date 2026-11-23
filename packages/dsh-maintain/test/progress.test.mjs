// progress:升级阶段时间线与 npm 输出尾部。
// Given 升级进行中 When 推进阶段/追加输出 Then 快照含标签、耗时与受限尾部。

import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  OUTPUT_TAIL_LIMIT,
  PLUGIN_STEP_LABELS,
  UPGRADE_PHASE_LABELS,
  appendProgressOutput,
  createProgress,
  progressSnapshot,
  updateProgressItems,
  updateProgressPhase,
  updateProgressPlugin,
} from '../src/progress.mjs'

test('createProgress:初始阶段为 accepted,启动与阶段时间同源', () => {
  const progress = createProgress(1000)
  assert.equal(progress.phase, 'accepted')
  assert.equal(progress.startedAt, 1000)
  assert.equal(progress.phaseStartedAt, 1000)
  assert.equal(progress.outputTail, '')
  assert.equal(progress.plugin, null)
  assert.deepEqual(progress.items, [])
})

test('updateProgressPhase:推进阶段更新时间戳与标签', () => {
  const progress = updateProgressPhase(createProgress(1000), 'installing', 4000)
  const snapshot = progressSnapshot(progress, 10000)
  assert.equal(snapshot.phase, 'installing')
  assert.equal(snapshot.phaseLabel, UPGRADE_PHASE_LABELS.installing)
  assert.equal(snapshot.elapsedMs, 9000)
  assert.equal(snapshot.phaseElapsedMs, 6000)
})

test('updateProgressPhase:提交前插件阶段有独立标签', () => {
  const snapshot = progressSnapshot(updateProgressPhase(createProgress(1000), 'pre-switch', 2000), 3000)
  assert.equal(snapshot.phase, 'pre-switch')
  assert.equal(snapshot.phaseLabel, '提交前准备(插件升级与最终核验)')
})

test('updateProgressPlugin:阶段标签细化为当前插件与宿主步骤', () => {
  const base = updateProgressPhase(createProgress(1000), 'pre-switch', 2000)
  const removing = progressSnapshot(updateProgressPlugin(base, { name: '@scope/a', index: 2, total: 5, step: 'removing' }), 3000)
  assert.equal(removing.phaseLabel, PLUGIN_STEP_LABELS.removing + ' @scope/a(2/5)')
  assert.equal(removing.plugin.step, 'removing')
  const installing = progressSnapshot(updateProgressPlugin(base, { name: '@scope/a', index: 2, total: 5, step: 'installing' }), 3000)
  assert.equal(installing.phaseLabel, '正在启用插件 @scope/a(2/5)')
  const unknownStep = progressSnapshot(updateProgressPlugin(base, { name: '@scope/a', index: 1, total: 1 }), 3000)
  assert.equal(unknownStep.phaseLabel, '正在升级插件 @scope/a(1/1)')
  assert.equal(progressSnapshot(updateProgressPlugin(base, null), 3000).phaseLabel, UPGRADE_PHASE_LABELS['pre-switch'])
})

test('updateProgressItems:逐插件状态随快照输出', () => {
  const progress = updateProgressItems(createProgress(1000), [
    { name: '@scope/a', state: 'updated', from: '1.0.0', to: '1.1.0' },
    { name: '@scope/b', state: 'failed', error: 'network down' },
  ])
  const snapshot = progressSnapshot(progress, 2000)
  assert.deepEqual(snapshot.items.map((item) => item.state), ['updated', 'failed'])
  assert.equal(snapshot.items[1].error, 'network down')
})

test('appendProgressOutput:保留尾部并剥离 ANSI 控制码', () => {
  let progress = createProgress(0)
  progress = appendProgressOutput(progress, '\u001b[31mfirst line\u001b[0m\nsecond line', 100)
  const snapshot = progressSnapshot(progress, 200)
  assert.equal(snapshot.outputTail, 'first line\nsecond line')
  assert.equal(snapshot.outputUpdatedAt, 100)
})

test('appendProgressOutput:超过上限只保留最后一段', () => {
  let progress = createProgress(0)
  progress = appendProgressOutput(progress, 'a'.repeat(OUTPUT_TAIL_LIMIT), 1)
  progress = appendProgressOutput(progress, 'TAIL', 2)
  assert.equal(progress.outputTail.length, OUTPUT_TAIL_LIMIT)
  assert.ok(progress.outputTail.endsWith('TAIL'))
  assert.equal(progress.outputTail.includes('a'.repeat(OUTPUT_TAIL_LIMIT)), false)
})

test('appendProgressOutput:CRLF 归一为换行', () => {
  const progress = appendProgressOutput(createProgress(0), 'a\r\nb\rc', 1)
  assert.equal(progress.outputTail, 'a\nb\nc')
})
