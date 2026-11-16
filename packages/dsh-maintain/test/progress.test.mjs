// progress:升级阶段时间线与 npm 输出尾部。
// Given 升级进行中 When 推进阶段/追加输出 Then 快照含标签、耗时与受限尾部。

import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  OUTPUT_TAIL_LIMIT,
  UPGRADE_PHASE_LABELS,
  appendProgressOutput,
  createProgress,
  progressSnapshot,
  updateProgressPhase,
} from '../src/progress.mjs'

test('createProgress:初始阶段为 accepted,启动与阶段时间同源', () => {
  const progress = createProgress(1000)
  assert.equal(progress.phase, 'accepted')
  assert.equal(progress.startedAt, 1000)
  assert.equal(progress.phaseStartedAt, 1000)
  assert.equal(progress.outputTail, '')
})

test('updateProgressPhase:推进阶段更新时间戳与标签', () => {
  const progress = updateProgressPhase(createProgress(1000), 'installing', 4000)
  const snapshot = progressSnapshot(progress, 10000)
  assert.equal(snapshot.phase, 'installing')
  assert.equal(snapshot.phaseLabel, UPGRADE_PHASE_LABELS.installing)
  assert.equal(snapshot.elapsedMs, 9000)
  assert.equal(snapshot.phaseElapsedMs, 6000)
})

test('updateProgressPhase:插件同步升级阶段有独立标签', () => {
  const snapshot = progressSnapshot(updateProgressPhase(createProgress(1000), 'plugins', 2000), 3000)
  assert.equal(snapshot.phase, 'plugins')
  assert.equal(snapshot.phaseLabel, '升级插件')
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
