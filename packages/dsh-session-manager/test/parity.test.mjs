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
  archiveToastText as coreArchiveToastText,
  projectArchiveRows,
  projectDeletedRows,
} from '../src/core.mjs'

const PKG_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const CLIENT_SRC = readFileSync(join(PKG_ROOT, 'src', 'client.js'), 'utf8')
const INDEX_SRC = readFileSync(join(PKG_ROOT, 'src', 'index.js'), 'utf8')

// 切片:从首个镜像纯函数(workspaceTitleOf)起到最后一个镜像纯函数止,
// 均为无外部依赖纯函数
const MIRROR_START = CLIENT_SRC.indexOf('function workspaceTitleOf(')
const MIRROR_END_MARKER = 'function ArchiveRow('
const MIRROR_END = CLIENT_SRC.indexOf(MIRROR_END_MARKER)
assert.ok(MIRROR_START >= 0 && MIRROR_END > MIRROR_START, 'client.js 镜像函数切片定位失败')

const mirror = new Function(
  CLIENT_SRC.slice(MIRROR_START, MIRROR_END)
  + '; return { projectRows: projectRows, projectDeletedRows: projectDeletedRows, archiveToastStep: archiveToastStep, archiveToastText: archiveToastText }',
)()

// client 侧输入形态 byId 字典,core 侧 rows 数组:按 title/cwd 约定构造等价输入
function byIdOf(rows) {
  const byId = {}
  for (const row of rows) {
    byId[row.id] = { displayTitle: row.title, updatedAt: row.updatedAt }
    if (row.cwd !== undefined) byId[row.id].cwd = row.cwd
  }
  return byId
}

const PARITY_WORKSPACES = [
  { workspaceId: 'w1', path: 'C:\\work\\alpha', title: 'alpha', sessionIds: ['b'] },
  { workspaceId: 'w2', path: 'C:\\work\\beta', title: 'beta', sessionIds: ['c'] },
  { workspaceId: 'w3', path: 'C:\\work\\gamma', sessionIds: ['t'] },
]

function assertArchiveProjectionParity(rows, archivedIds, workspaceState) {
  // workspaceState 缺省时传 undefined,同步覆盖 client 侧快照缺省守卫与 core 侧
  // workspaces 缺省守卫(双侧均回退无工作区,输出 workspace 全 null)
  const clientWorkspaceState = workspaceState === undefined ? undefined : { items: workspaceState }
  const clientRows = mirror.projectRows({ byId: byIdOf(rows) }, archivedIds, clientWorkspaceState ?? { items: PARITY_WORKSPACES })
  const coreRows = projectArchiveRows({ rows, archivedIds, workspaces: workspaceState ?? PARITY_WORKSPACES })
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

test('parity 归档投影:workspaceState 缺省守卫(双侧均回退全 null)', () => {
  assertArchiveProjectionParity([{ id: 'a', title: 'A', updatedAt: 1, cwd: 'C:\\work\\alpha' }], ['a'], undefined)
  assertArchiveProjectionParity([{ id: 'a', title: 'A', updatedAt: 1 }], ['a'], [])
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

test('parity 归档投影:工作区映射账本/cwd/未分组/缺 title 回退全路径', () => {
  assertArchiveProjectionParity([
    { id: 'b', title: 'B', updatedAt: 400 },
    { id: 'a', title: 'A', updatedAt: 300, cwd: 'C:\\work\\alpha' },
    { id: 'u', title: 'U', updatedAt: 200 },
    { id: 't', title: 'T', updatedAt: 100 },
    { id: 'm', title: 'M', updatedAt: 50, cwd: 'C:\\elsewhere\\other' },
  ], ['b', 'a', 'u', 't', 'm'])
  assertArchiveProjectionParity([{ id: 'a', title: 'A', updatedAt: 1, cwd: 'C:\\work\\alpha' }], ['a'])
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

function assertToastTextParity(addedIds, rows) {
  assert.equal(mirror.archiveToastText(addedIds, rows), coreArchiveToastText(addedIds, rows),
    '归档通知文案不一致: ' + JSON.stringify(addedIds))
}

test('parity 归档通知文案:单标题/多标题/截断/回退/非数组行同输入同输出', () => {
  const rows = [
    { id: 'a', title: 'A' },
    { id: 'b', title: ' B ' },
    { id: 'c' },
    { id: 'd', title: '  ' },
  ]
  assertToastTextParity(['a'], rows)
  assertToastTextParity(['a', 'b'], rows)
  assertToastTextParity(['a', 'b', 'c', 'd'], rows)
  assertToastTextParity(['missing'], rows)
  assertToastTextParity(['a', 'b'], undefined)
})

test('parity Toast 差分:大集合增量性能形态一致性(n=5000)', () => {
  const big = Array.from({ length: 5000 }, (_, i) => 'id-' + i)
  assertToastStepParity([
    { phase: 'ready', archivedSessionIds: [] },
    { phase: 'ready', archivedSessionIds: big },
  ])
})

test('源码契约:client fetchInputs 必须解包 host 响应信封 { inputs }', () => {
  // host 与 client 对信封各自测试自洽时,信封形状漂移只会以运行时 TypeError 暴露;
  // 此守卫锁定解包点存在,防消费侧把信封对象当数组使用
  const guard = /Array\.isArray\((\w+)\.inputs\)/
  assert.ok(guard.test('Array.isArray(payload.inputs)'), '守卫正则必须命中合规样本')
  const fetchStart = CLIENT_SRC.indexOf('function fetchInputs(')
  const fetchBody = fetchStart >= 0 ? CLIENT_SRC.slice(fetchStart, CLIENT_SRC.indexOf('}', fetchStart)) : ''
  assert.ok(fetchBody.includes('api(INPUTS_URL'), '未找到 fetchInputs 的 host 请求')
  assert.ok(guard.test(fetchBody), 'fetchInputs 缺少 payload.inputs 数组解包')
})

test('parity 文案:client 确认态文案与 host MESSAGES.unsupportedBackend 同值', () => {
  const match = INDEX_SRC.match(/unsupportedBackend: '([^']+)'/)
  assert.ok(match, 'index.js 缺少 unsupportedBackend 文案')
  assert.ok(CLIENT_SRC.includes(match[1]), 'client.js 确认态文案与 host 漂移')
})

test('parity API 路径:client 字面量与 host 路由注册互为镜像', () => {
  // 跨半区契约拼错只会在运行时 404,双向集合相等断言防漂移
  const clientUrls = new Set([...CLIENT_SRC.matchAll("'(/api/session-manager/[^']*)'")].map((m) => m[1])
    .filter((url) => !url.endsWith('/*')))
  assert.ok(clientUrls.size >= 7, 'client.js API 路径字面量异常减少')
  const hostPaths = new Set([...INDEX_SRC.matchAll(/path: '(\/api\/session-manager\/[^']*)'/g)].map((m) => m[1]))
  assert.deepEqual([...hostPaths].sort(), [...clientUrls].sort(), 'client 与 host 的 API 路径集合不一致')
})

test('源码契约:Toast 差分 Set 每帧构建一次(禁止 filter 谓词内 new Set)', () => {
  // 违规必为 new Set(...).has(...) 紧邻链式;合规形态是 new Set 赋值与 baseline.has 分离。
  // 元断言先自证正则能命中回归样本,防正则本身失效时守卫恒绿
  const regression = "ids.filter((id) => !new Set(previous.ids).has(id))"
  const guard = /new Set\([^)]*\)\.has\(/
  assert.ok(guard.test(regression), '守卫正则必须命中回归样本')
  const slice = CLIENT_SRC.slice(MIRROR_START, MIRROR_END)
  assert.ok(!guard.test(slice), '差分 new Set 必须逐帧构建一次,禁止谓词内逐元素重建')
})
