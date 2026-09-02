// 纯逻辑层测试:归档评估状态机、删除资格与失败矩阵、面板投影、归档集合差分、空白产物判定。
// BDD 场景对应 docs/design/dsh-session-manager.md。

import test from 'node:test'
import assert from 'node:assert/strict'

import {
  DAY_MS,
  DEFAULT_AUTO_ARCHIVE_DAYS,
  archiveToastStep,
  artifactLooksBlank,
  deleteEligibility,
  deleteOutcome,
  diffArchived,
  isSessionRunning,
  projectArchiveRows,
  selectArchiveCandidates,
  updatedAtOf,
} from '../src/core.mjs'

const NOW = Date.parse('2026-01-10T00:00:00Z')
const ACTIVE = NOW - 1 * DAY_MS
const STALE = NOW - 8 * DAY_MS

function record(overrides) {
  return { id: 's1', archived: false, running: false, blank: false, updatedAt: STALE, ...overrides }
}

test('阈值天数默认值与常量自洽', () => {
  assert.equal(DEFAULT_AUTO_ARCHIVE_DAYS, 7)
  assert.equal(DAY_MS, 24 * 60 * 60 * 1000)
})

test('新会话触发自动归档:超期候选被选中', () => {
  const picked = selectArchiveCandidates({ records: [record({})], nowMs: NOW, thresholdDays: 7 })
  assert.deepEqual(picked, ['s1'])
})

test('未超期与恰好等于阈值的会话不归档', () => {
  const records = [record({ updatedAt: ACTIVE }), record({ updatedAt: NOW - 7 * DAY_MS })]
  assert.deepEqual(selectArchiveCandidates({ records, nowMs: NOW, thresholdDays: 7 }), [])
})

test('运行中会话豁免', () => {
  const picked = selectArchiveCandidates({ records: [record({ running: true })], nowMs: NOW, thresholdDays: 7 })
  assert.deepEqual(picked, [])
})

test('空白会话豁免', () => {
  const picked = selectArchiveCandidates({ records: [record({ blank: true })], nowMs: NOW, thresholdDays: 7 })
  assert.deepEqual(picked, [])
})

test('已归档会话不参与评估:幂等', () => {
  const records = [record({ archived: true })]
  const first = selectArchiveCandidates({ records, nowMs: NOW, thresholdDays: 7 })
  assert.deepEqual(first, [])
})

test('阈值为零关闭功能', () => {
  const picked = selectArchiveCandidates({ records: [record({})], nowMs: NOW, thresholdDays: 0 })
  assert.deepEqual(picked, [])
})

test('updatedAt 取创建时间与最近活跃的较大者', () => {
  assert.equal(updatedAtOf({ createdAt: 100 }, 50), 100)
  assert.equal(updatedAtOf({ createdAt: 100 }, 500), 500)
  assert.equal(updatedAtOf({ createdAt: 100 }, undefined), 100)
})

test('归档面板投影:交集过滤且按更新时间倒序', () => {
  const rows = [
    { id: 'b', title: 'B', updatedAt: 200 },
    { id: 'a', title: 'A', updatedAt: 300 },
    { id: 'c', title: 'C', updatedAt: 100 },
    { id: 'd', title: 'D', updatedAt: 400 },
  ]
  const projected = projectArchiveRows({ rows, archivedIds: ['b', 'c', 'gone'] })
  assert.deepEqual(projected, [
    { id: 'b', title: 'B', updatedAt: 200 },
    { id: 'c', title: 'C', updatedAt: 100 },
  ])
})

test('归档集合差分只报新增,首帧基线不提示', () => {
  assert.deepEqual(diffArchived(undefined, ['x', 'y']), [])
  assert.deepEqual(diffArchived(['x'], ['x', 'y', 'z']), ['y', 'z'])
  assert.deepEqual(diffArchived(['x', 'y'], ['x']), [])
})

test('Toast 差分:pending 空态与基线首装不提示,ready 后新增才提示', () => {
  let previous
  let step = archiveToastStep(previous, { phase: 'pending', archivedSessionIds: [] })
  previous = step.state
  assert.deepEqual(step.added, [])
  // 基线安装:存量 29 个不算新增(模型 pending 期发射,notify 时序不定,两种相位都守卫)
  step = archiveToastStep(previous, { phase: 'pending', archivedSessionIds: ['a', 'b'] })
  previous = step.state
  assert.deepEqual(step.added, [])
  step = archiveToastStep(previous, { phase: 'ready', archivedSessionIds: ['a', 'b'] })
  previous = step.state
  assert.deepEqual(step.added, [])
  // ready 建立后:增量帧触发提示
  step = archiveToastStep(previous, { phase: 'ready', archivedSessionIds: ['a', 'b', 'c'] })
  assert.deepEqual(step.added, ['c'])
})

test('Toast 差分:订阅即 ready(无 pending 帧)时首帧守卫仍生效', () => {
  let previous
  const step = archiveToastStep(previous, { phase: 'ready', archivedSessionIds: ['a'] })
  previous = step.state
  assert.deepEqual(step.added, [])
  assert.deepEqual(archiveToastStep(previous, { phase: 'ready', archivedSessionIds: ['a', 'b'] }).added, ['b'])
})

test('非归档会话拒绝删除', () => {
  assert.equal(deleteEligibility({ archivedIds: ['a'], sessionId: 'a' }).ok, true)
  const denied = deleteEligibility({ archivedIds: ['a'], sessionId: 'b' })
  assert.equal(denied.ok, false)
  assert.equal(denied.code, 'not-archived')
})

test('删除失败矩阵逐格', () => {
  assert.equal(deleteOutcome({ located: false }).code, 'unsupported')
  assert.equal(deleteOutcome({ located: true, trashError: new Error('no trash') }).code, 'trash-failed')
  assert.equal(deleteOutcome({ located: true, detachError: new Error('boom') }).code, 'partial')
  assert.equal(deleteOutcome({ located: true }).code, 'deleted')
})

test('运行中判定:agent status running 即运行中,注册表缺失视为非运行', () => {
  const agents = new Map([['s1', { status: 'running' }], ['s2', { status: 'idle' }]])
  assert.equal(isSessionRunning({ agents, sessionId: 's1' }), true)
  assert.equal(isSessionRunning({ agents, sessionId: 's2' }), false)
  assert.equal(isSessionRunning({ agents, sessionId: 'gone' }), false)
  assert.equal(isSessionRunning({ agents: undefined, sessionId: 's1' }), false)
})

test('空白产物判定:JSONL 单行(仅 header)为空白', () => {
  assert.equal(artifactLooksBlank('{"header":1}\n', false), true)
  assert.equal(artifactLooksBlank('', false), true)
  assert.equal(artifactLooksBlank('{"header":1}\n{"event":0}\n', false), false)
  assert.equal(artifactLooksBlank('{"header":1}\n{"event":0', true), false)
})
