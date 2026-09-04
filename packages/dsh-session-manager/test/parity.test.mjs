// 镜像逻辑 parity:client.js 与 core.mjs 双实现同源(仓库规约"双实现同源必须 parity 测试")。
// client.js 为单文件自包含格式无法 import,此处按标记切片提取镜像函数段,
// 经 new Function 实例化后与 core.mjs 同输入断言同输出。

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  archiveToastStep as coreArchiveToastStep,
  projectArchiveRows,
  projectDeletedRows,
} from '../src/core.mjs'

const PKG_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const CLIENT_SRC = readFileSync(join(PKG_ROOT, 'src', 'client.js'), 'utf8')
const INDEX_SRC = readFileSync(join(PKG_ROOT, 'src', 'index.js'), 'utf8')

// 切片:从 projectRows 定义起到 archiveToastStep 函数结束,三函数均为无外部依赖纯函数
const MIRROR_START = CLIENT_SRC.indexOf('function projectRows(')
const MIRROR_END_MARKER = 'function ArchiveRow('
const MIRROR_END = CLIENT_SRC.indexOf(MIRROR_END_MARKER)
assert.ok(MIRROR_START >= 0 && MIRROR_END > MIRROR_START, 'client.js 镜像函数切片定位失败')

const mirror = new Function(
  CLIENT_SRC.slice(MIRROR_START, MIRROR_END)
  + '; return { projectRows: projectRows, projectDeletedRows: projectDeletedRows, archiveToastStep: archiveToastStep }',
)()

// client 侧输入形态 byId 字典,core 侧 rows 数组:按 title 约定构造等价输入
function byIdOf(rows) {
  const byId = {}
  for (const row of rows) byId[row.id] = { displayTitle: row.title, updatedAt: row.updatedAt }
  return byId
}

function assertArchiveProjectionParity(rows, archivedIds) {
  const clientRows = mirror.projectRows({ byId: byIdOf(rows) }, archivedIds)
  const coreRows = projectArchiveRows({ rows, archivedIds })
  assert.deepEqual(clientRows, coreRows)
}

test('parity 归档投影:常规交集与倒序', () => {
  assertArchiveProjectionParity([
    { id: 'b', title: 'B', updatedAt: 200 },
    { id: 'a', title: 'A', updatedAt: 300 },
    { id: 'c', title: 'C', updatedAt: 100 },
    { id: 'd', title: 'D', updatedAt: 400 },
  ], ['b', 'c', 'gone'])
})

test('parity 归档投影:空输入与空集合', () => {
  assertArchiveProjectionParity([], ['a'])
  assertArchiveProjectionParity([{ id: 'a', title: 'A', updatedAt: 1 }], [])
})

test('parity 归档投影:标题缺失回退会话 id', () => {
  assertArchiveProjectionParity([{ id: 'a', title: '', updatedAt: 5 }], ['a'])
})

test('parity 归档投影:updatedAt 并列时排序不漂移(同数组序)', () => {
  assertArchiveProjectionParity([
    { id: 'x', title: 'X', updatedAt: 100 },
    { id: 'y', title: 'Y', updatedAt: 100 },
    { id: 'z', title: 'Z', updatedAt: 100 },
  ], ['x', 'y', 'z'])
})

function assertDeletedProjectionParity(deleted, sessionsById) {
  const clientRows = mirror.projectDeletedRows(deleted, { byId: sessionsById })
  const coreRows = projectDeletedRows(deleted, sessionsById)
  assert.deepEqual(clientRows, coreRows)
}

test('parity 已删除投影:倒序与标题回退', () => {
  assertDeletedProjectionParity([
    { sessionId: 'a', path: 'C:\\w\\a', deletedAt: 100 },
    { sessionId: 'b', path: 'C:\\w\\b', deletedAt: 300 },
    { sessionId: 'c', path: 'C:\\w\\c', deletedAt: 200 },
  ], { a: { displayTitle: '会话 A' } })
  assertDeletedProjectionParity([], {})
  assertDeletedProjectionParity([{ sessionId: 's', path: 'p', deletedAt: 1 }], undefined)
})

function assertToastStepParity(frames) {
  let clientPrevious
  let corePrevious
  for (const frame of frames) {
    const clientStep = mirror.archiveToastStep(clientPrevious, frame)
    const coreStep = coreArchiveToastStep(corePrevious, frame)
    assert.deepEqual(clientStep, coreStep, '帧 ' + JSON.stringify(frame) + ' 差分不一致')
    clientPrevious = clientStep.state
    corePrevious = coreStep.state
  }
}

test('parity Toast 差分:pending 首装 / ready 增量 / 重连 / 缩减全序列', () => {
  assertToastStepParity([
    { phase: 'pending', archivedSessionIds: [] },
    { phase: 'pending', archivedSessionIds: ['a', 'b'] },
    { phase: 'ready', archivedSessionIds: ['a', 'b'] },
    { phase: 'ready', archivedSessionIds: ['a', 'b', 'c'] },
    { phase: 'ready', archivedSessionIds: ['a', 'c'] },
    { phase: 'pending', archivedSessionIds: ['a', 'c'] },
    { phase: 'ready', archivedSessionIds: ['a', 'c', 'd'] },
  ])
})

test('parity Toast 差分:订阅即 ready(无 pending 帧)首帧守卫', () => {
  assertToastStepParity([
    { phase: 'ready', archivedSessionIds: ['a'] },
    { phase: 'ready', archivedSessionIds: ['a', 'b'] },
  ])
})

test('parity Toast 差分:大集合增量性能形态一致性(n=5000)', () => {
  const big = Array.from({ length: 5000 }, (_, i) => 'id-' + i)
  assertToastStepParity([
    { phase: 'ready', archivedSessionIds: [] },
    { phase: 'ready', archivedSessionIds: big },
  ])
})

test('parity 文案:client 确认态文案与 host MESSAGES.unsupportedBackend 同值', () => {
  const match = INDEX_SRC.match(/unsupportedBackend: '([^']+)'/)
  assert.ok(match, 'index.js 缺少 unsupportedBackend 文案')
  assert.ok(CLIENT_SRC.includes(match[1]), 'client.js 确认态文案与 host 漂移')
})
