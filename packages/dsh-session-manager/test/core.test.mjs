// 纯逻辑层测试:归档评估状态机、删除资格与失败矩阵、面板投影、归档集合差分、空白产物判定。
// BDD 场景对应 docs/design/dsh-session-manager.md。

import test from 'node:test'
import assert from 'node:assert/strict'

import {
  ARCHIVE_PAGE_SIZE,
  DAY_MS,
  DEFAULT_AUTO_ARCHIVE_DAYS,
  DELETE_MESSAGES,
  TOAST_MAX_TITLES,
  aggregateDeleteOutcome,
  aggregateInputs,
  archiveToastStep,
  archiveToastText,
  artifactLooksBlank,
  deleteEligibility,
  diffArchived,
  extractUserInputs,
  filterArchiveRows,
  groupArchiveRowsByWorkspace,
  isSessionRunning,
  mergeDeletedEntry,
  pageArchiveRows,
  projectArchiveRows,
  projectDeletedRows,
  removeDeletedEntry,
  selectArchiveCandidates,
  updatedAtOf,
  workspaceTitleForSession,
  workspaceTitleOf,
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

test('阈值负值与非有限值防御性关闭', () => {
  assert.deepEqual(selectArchiveCandidates({ records: [record({})], nowMs: NOW, thresholdDays: -1 }), [])
  assert.deepEqual(selectArchiveCandidates({ records: [record({})], nowMs: NOW, thresholdDays: Number.NaN }), [])
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
    { id: 'b', title: 'B', updatedAt: 200, workspace: null },
    { id: 'c', title: 'C', updatedAt: 100, workspace: null },
  ])
})

test('归档面板投影:标题缺失回退会话 id(与 client 镜像同规)', () => {
  const projected = projectArchiveRows({ rows: [{ id: 'a', title: '', updatedAt: 5 }], archivedIds: ['a'] })
  assert.deepEqual(projected, [{ id: 'a', title: 'a', updatedAt: 5, workspace: null }])
})

const WORKSPACES = [
  { workspaceId: 'w1', path: 'C:\\work\\alpha', title: 'alpha', sessionIds: ['a', 'b'] },
  { workspaceId: 'w2', path: 'C:\\work\\beta', title: 'beta', sessionIds: ['c'] },
]

test('归档面板投影:会话经 workspace 账本映射到工作区标题', () => {
  const rows = [
    { id: 'a', title: 'A', updatedAt: 300 },
    { id: 'c', title: 'C', updatedAt: 100 },
  ]
  const projected = projectArchiveRows({ rows, archivedIds: ['a', 'c'], workspaces: WORKSPACES })
  assert.deepEqual(projected, [
    { id: 'a', title: 'A', updatedAt: 300, workspace: 'alpha' },
    { id: 'c', title: 'C', updatedAt: 100, workspace: 'beta' },
  ])
})

test('归档面板投影:账本缺失时 cwd 匹配工作区路径回退', () => {
  const rows = [{ id: 'x', title: 'X', updatedAt: 1, cwd: 'C:\\work\\beta' }]
  const projected = projectArchiveRows({ rows, archivedIds: ['x'], workspaces: WORKSPACES })
  assert.deepEqual(projected, [{ id: 'x', title: 'X', updatedAt: 1, workspace: 'beta' }])
})

test('归档面板投影:无匹配工作区输出 null,账本缺 title 回退路径末段', () => {
  const rows = [
    { id: 'x', title: 'X', updatedAt: 3 },
    { id: 'y', title: 'Y', updatedAt: 2, cwd: 'C:\\nowhere\\lost\\' },
    { id: 'z', title: 'Z', updatedAt: 1 },
  ]
  const workspaces = [
    ...WORKSPACES,
    { workspaceId: 'w3', path: 'C:\\work\\titleless', sessionIds: ['z'] },
  ]
  const projected = projectArchiveRows({ rows, archivedIds: ['x', 'y', 'z'], workspaces })
  assert.deepEqual(projected, [
    { id: 'x', title: 'X', updatedAt: 3, workspace: null },
    { id: 'y', title: 'Y', updatedAt: 2, workspace: null },
    { id: 'z', title: 'Z', updatedAt: 1, workspace: 'titleless' },
  ])
})

test('归档面板投影:workspaces 缺省时全部回退 null', () => {
  const rows = [{ id: 'a', title: 'A', updatedAt: 1, cwd: 'C:\\work\\alpha' }]
  assert.deepEqual(
    projectArchiveRows({ rows, archivedIds: ['a'] }),
    [{ id: 'a', title: 'A', updatedAt: 1, workspace: null }],
  )
})

test('workspaceTitleOf 路径末段边界', () => {
  assert.equal(workspaceTitleOf('C:\\work\\alpha'), 'alpha')
  assert.equal(workspaceTitleOf('/home/user/project/'), 'project')
  assert.equal(workspaceTitleOf('C:\\work\\mixed/slash\\path'), 'path')
  assert.equal(workspaceTitleOf('C:\\'), 'C:')
  assert.equal(workspaceTitleOf('/'), '')
  assert.equal(workspaceTitleOf('///'), '')
})

test('workspaceTitleForSession 直接边界:title 与 path 皆缺为 null,title 空串回退路径末段', () => {
  assert.equal(workspaceTitleForSession({ workspaces: [{ sessionIds: ['a'] }], sessionId: 'a' }), null)
  assert.equal(
    workspaceTitleForSession({ workspaces: [{ path: 'C:\\work\\x', title: '', sessionIds: ['a'] }], sessionId: 'a' }),
    'x',
  )
  assert.equal(workspaceTitleForSession({ workspaces: 'bad', sessionId: 'a' }), null)
  assert.equal(workspaceTitleForSession({ workspaces: [{ path: 'C:\\w\\a', sessionIds: ['a'] }], sessionId: 'a', cwd: undefined }), 'a')
})

// ── 归档库:主列表分页 / 工作区分组 / 标题搜索 ──

test('归档库分页:页粒度常量', () => {
  assert.equal(ARCHIVE_PAGE_SIZE, 100)
})

test('归档库分页:默认只取前 100 条,剩余数准确', () => {
  const rows = Array.from({ length: 250 }, (_, i) => ({ id: 's' + i, title: 'T' + i, updatedAt: 1000 - i, workspace: null }))
  const page = pageArchiveRows(rows, ARCHIVE_PAGE_SIZE)
  assert.equal(page.visible.length, 100)
  assert.equal(page.remaining, 150)
  assert.equal(page.visible[0].id, 's0')
  assert.equal(page.visible[99].id, 's99')
})

test('归档库分页:增量展开与全量边界', () => {
  const rows = Array.from({ length: 250 }, (_, i) => ({ id: 's' + i, title: 'T' + i, updatedAt: i, workspace: null }))
  assert.equal(pageArchiveRows(rows, 200).visible.length, 200)
  assert.equal(pageArchiveRows(rows, 200).remaining, 50)
  assert.deepEqual(pageArchiveRows(rows, rows.length), { visible: rows, remaining: 0 })
  assert.equal(pageArchiveRows(rows, rows.length + 10).remaining, 0)
})

test('归档库分页:空列表与非有限可见数防御', () => {
  assert.deepEqual(pageArchiveRows([], ARCHIVE_PAGE_SIZE), { visible: [], remaining: 0 })
  const single = [{ id: 'a', title: 'A', updatedAt: 1, workspace: null }]
  assert.deepEqual(pageArchiveRows(single, Number.NaN).visible, [])
  assert.equal(pageArchiveRows(single, Number.NaN).remaining, 1)
  assert.equal(pageArchiveRows(single, -5).remaining, 1)
  assert.deepEqual(pageArchiveRows(single, Infinity).visible, [])
  assert.equal(pageArchiveRows(single, Infinity).remaining, 1)
})

test('归档库分组:按工作区标题分桶,组内保持输入序,组间按最新活跃倒序', () => {
  const rows = [
    { id: 'a', title: 'A', updatedAt: 400, workspace: 'alpha' },
    { id: 'b', title: 'B', updatedAt: 300, workspace: 'beta' },
    { id: 'c', title: 'C', updatedAt: 200, workspace: 'alpha' },
  ]
  assert.deepEqual(groupArchiveRowsByWorkspace(rows), [
    { workspace: 'alpha', rows: [rows[0], rows[2]] },
    { workspace: 'beta', rows: [rows[1]] },
  ])
})

test('归档库分组:workspace 假值并桶为未分组(null)', () => {
  const rows = [
    { id: 'u1', title: 'U1', updatedAt: 100, workspace: null },
    { id: 'g', title: 'G', updatedAt: 350, workspace: 'gamma' },
    { id: 'u2', title: 'U2', updatedAt: 500, workspace: '' },
    { id: 'u3', title: 'U3', updatedAt: 50, workspace: null },
  ]
  assert.deepEqual(groupArchiveRowsByWorkspace(rows), [
    { workspace: null, rows: [rows[0], rows[2], rows[3]] },
    { workspace: 'gamma', rows: [rows[1]] },
  ])
})

test('归档库分组:空输入与非数组防御', () => {
  assert.deepEqual(groupArchiveRowsByWorkspace([]), [])
  assert.deepEqual(groupArchiveRowsByWorkspace(undefined), [])
})

test('归档库搜索:标题不区分大小写子串匹配,空查询返回全量', () => {
  const rows = [
    { id: 'a', title: '修复登录页', updatedAt: 3, workspace: null },
    { id: 'b', title: 'Refactor API', updatedAt: 2, workspace: null },
    { id: 'c', title: '登录超时排查', updatedAt: 1, workspace: null },
  ]
  assert.deepEqual(filterArchiveRows(rows, '登录'), [rows[0], rows[2]])
  assert.deepEqual(filterArchiveRows(rows, 'REFACT'), [rows[1]])
  assert.deepEqual(filterArchiveRows(rows, '不存在'), [])
})

test('归档库搜索:空查询与空白查询原样返回全量,非数组防御', () => {
  const rows = [{ id: 'a', title: 'A', updatedAt: 1, workspace: null }]
  assert.deepEqual(filterArchiveRows(rows, ''), rows)
  assert.deepEqual(filterArchiveRows(rows, '  '), rows)
  assert.deepEqual(filterArchiveRows(undefined, 'A'), [])
})

test('归档库搜索:标题缺失经投影回退会话 id 后可被命中(与投影组合)', () => {
  const projected = projectArchiveRows({
    rows: [{ id: 'abc-123', title: '', updatedAt: 1 }],
    archivedIds: ['abc-123'],
  })
  assert.deepEqual(filterArchiveRows(projected, 'ABC-'), projected)
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

test('Toast 差分:ready→pending→ready 重连序列不误报存量', () => {
  let previous
  let step = archiveToastStep(previous, { phase: 'ready', archivedSessionIds: ['a'] })
  previous = step.state
  // 断连:pending 帧中断 ready 链
  step = archiveToastStep(previous, { phase: 'pending', archivedSessionIds: ['a', 'b'] })
  previous = step.state
  assert.deepEqual(step.added, [])
  // 重连基线首装:不提示存量(离期新增的提示语义见 core 注释)
  step = archiveToastStep(previous, { phase: 'ready', archivedSessionIds: ['a', 'b'] })
  previous = step.state
  assert.deepEqual(step.added, [])
  // 重连建立后:增量照常提示
  assert.deepEqual(archiveToastStep(previous, { phase: 'ready', archivedSessionIds: ['a', 'b', 'c'] }).added, ['c'])
})

test('归档通知文案:截断阈值常量', () => {
  assert.equal(TOAST_MAX_TITLES, 3)
})

test('归档通知文案:单个会话报标题', () => {
  assert.equal(archiveToastText(['a'], [{ id: 'a', title: '修复登录页' }]), '会话「修复登录页」已归档')
})

test('归档通知文案:多个会话列举标题,计数为真实总数', () => {
  const rows = [
    { id: 'a', title: 'A' },
    { id: 'b', title: 'B' },
  ]
  assert.equal(archiveToastText(['a', 'b'], rows), '有 2 个会话已归档:A、B')
})

test('归档通知文案:恰好等于展示阈值不截断', () => {
  const rows = [
    { id: 'a', title: 'A' },
    { id: 'b', title: 'B' },
    { id: 'c', title: 'C' },
  ]
  assert.equal(archiveToastText(['a', 'b', 'c'], rows), '有 3 个会话已归档:A、B、C')
})

test('归档通知文案:超展示阈值只列前段并以「 等」收尾,计数仍为真实总数', () => {
  const rows = [
    { id: 'a', title: 'A' },
    { id: 'b', title: 'B' },
    { id: 'c', title: 'C' },
    { id: 'd', title: 'D' },
  ]
  assert.equal(archiveToastText(['a', 'b', 'c', 'd'], rows), '有 4 个会话已归档:A、B、C 等')
})

test('归档通知文案:标题缺失、空白与行缺失回退会话 id,标题按去除首尾空白取值', () => {
  const rows = [{ id: 'a' }, { id: 'b', title: '   ' }, { id: 'x', title: 'X' }]
  assert.equal(archiveToastText(['a', 'b', 'c'], rows), '有 3 个会话已归档:a、b、c')
  assert.equal(archiveToastText(['t'], [{ id: 't', title: '  T  ' }]), '会话「T」已归档')
})

test('归档通知文案:行数据非数组按空处理,标题全部回退会话 id', () => {
  assert.equal(archiveToastText(['a', 'b'], undefined), '有 2 个会话已归档:a、b')
})

test('非归档会话拒绝删除', () => {
  assert.equal(deleteEligibility({ archivedIds: ['a'], sessionId: 'a' }).ok, true)
  const denied = deleteEligibility({ archivedIds: ['a'], sessionId: 'b' })
  assert.equal(denied.ok, false)
  assert.equal(denied.code, 'not-archived')
})

test('删除收尾聚合:失败矩阵折叠为三形态响应体', () => {
  const R = DELETE_MESSAGES.runningDuringTrash
  // 全成功无警告:无多余键(index.test deepEqual 锁定同形态)
  assert.deepEqual(aggregateDeleteOutcome({}), { ok: true })
  // 单一失败:主文案优先级 detach → 归档清理 → 台账
  assert.deepEqual(aggregateDeleteOutcome({ detachFailed: true }), { ok: true, partial: true, message: DELETE_MESSAGES.partial })
  assert.deepEqual(aggregateDeleteOutcome({ archiveCleanupFailed: true }), { ok: true, partial: true, message: DELETE_MESSAGES.archiveCleanup })
  assert.deepEqual(aggregateDeleteOutcome({ ledgerFailed: true }), { ok: true, partial: true, message: DELETE_MESSAGES.ledgerFailed })
  // 双失败:高优先级主文案 + 台账后缀
  assert.deepEqual(
    aggregateDeleteOutcome({ detachFailed: true, ledgerFailed: true }),
    { ok: true, partial: true, message: DELETE_MESSAGES.partial + DELETE_MESSAGES.ledgerSuffix },
  )
  // 运行中翻转警告后缀并入一切形态
  assert.deepEqual(
    aggregateDeleteOutcome({ detachFailed: true, ledgerFailed: true, runningDuringTrash: true }),
    { ok: true, partial: true, message: DELETE_MESSAGES.partial + DELETE_MESSAGES.ledgerSuffix + ';' + R },
  )
  // 全失败
  assert.deepEqual(
    aggregateDeleteOutcome({ detachFailed: true, archiveCleanupFailed: true, ledgerFailed: true, runningDuringTrash: true }),
    { ok: true, partial: true, message: DELETE_MESSAGES.partial + DELETE_MESSAGES.ledgerSuffix + ';' + R },
  )
  // 全成功警告态:非 partial 形态(ok+message,无 partial 键)
  assert.deepEqual(aggregateDeleteOutcome({ runningDuringTrash: true }), { ok: true, message: R })
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

test('空白产物判定:整块边界与 CRLF 行尾', () => {
  // 恰满整块且换行不足两行:hasMore=true 判非空白(保守方向,防漏读)
  assert.equal(artifactLooksBlank('{"header":1}\n', true), false)
  // CRLF 行尾:\r 不计数,单行 CRLF header 仍为空白
  assert.equal(artifactLooksBlank('{"header":1}\r\n', false), true)
  assert.equal(artifactLooksBlank('{"header":1}\r\n{"event":0}\r\n', false), false)
})

test('已删除面板投影:标题回退会话 id,按删除时间倒序', () => {
  const deleted = [
    { sessionId: 'a', path: 'C:\\w\\a', deletedAt: 100 },
    { sessionId: 'b', path: 'C:\\w\\b', deletedAt: 300 },
    { sessionId: 'c', path: 'C:\\w\\c', deletedAt: 200 },
  ]
  const rows = projectDeletedRows(deleted, { a: { displayTitle: '会话 A' } })
  assert.deepEqual(rows, [
    { sessionId: 'b', path: 'C:\\w\\b', deletedAt: 300, title: 'b' },
    { sessionId: 'c', path: 'C:\\w\\c', deletedAt: 200, title: 'c' },
    { sessionId: 'a', path: 'C:\\w\\a', deletedAt: 100, title: '会话 A' },
  ])
})

test('已删除面板投影:空台账投影为空', () => {
  assert.deepEqual(projectDeletedRows([], {}), [])
})

test('台账合并:同 id 替换置顶,新 id 插入头部,入参不变', () => {
  const existing = [{ sessionId: 'a', path: 'p1', deletedAt: 1 }]
  assert.deepEqual(
    mergeDeletedEntry(existing, { sessionId: 'a', path: 'p2', deletedAt: 2 }),
    [{ sessionId: 'a', path: 'p2', deletedAt: 2 }],
  )
  assert.deepEqual(
    mergeDeletedEntry(existing, { sessionId: 'b', path: 'p3', deletedAt: 3 }),
    [{ sessionId: 'b', path: 'p3', deletedAt: 3 }, { sessionId: 'a', path: 'p1', deletedAt: 1 }],
  )
  assert.deepEqual(existing, [{ sessionId: 'a', path: 'p1', deletedAt: 1 }])
})

test('台账移除:命中删除并报变化,未命中幂等不报变化', () => {
  const existing = [
    { sessionId: 'a', path: 'p1', deletedAt: 1 },
    { sessionId: 'b', path: 'p2', deletedAt: 2 },
  ]
  const hit = removeDeletedEntry(existing, 'a')
  assert.deepEqual(hit.deleted, [{ sessionId: 'b', path: 'p2', deletedAt: 2 }])
  assert.equal(hit.removed, true)
  const miss = removeDeletedEntry(existing, 'z')
  assert.deepEqual(miss.deleted, existing)
  assert.equal(miss.removed, false)
})

// ── 历史输入:事件提取(G1-G3)──

function userEvent(overrides, text, at) {
  return {
    type: 'user/message',
    seq: 1,
    time: at,
    ...overrides,
    data: {
      id: 'm1',
      role: 'user',
      source: { kind: 'user' },
      content: text === undefined ? [] : [{ type: 'text', text }],
      ...overrides?.data,
    },
  }
}

test('历史输入提取:user/message 且 kind=user 产出文本与时间', () => {
  const events = [userEvent(null, '修复归档面板', 500)]
  assert.deepEqual(extractUserInputs(events), [{ text: '修复归档面板', at: 500 }])
})

test('历史输入提取:tool 结果与 plugin 注入不产出', () => {
  const tool = userEvent({ data: { source: { kind: 'tool', callId: 'c1' }, content: [{ type: 'tool-result', toolCallId: 'c1', content: [] }] } }, undefined, 100)
  const plugin = userEvent({ data: { source: { kind: 'plugin', plugin: 'x', form: 'instructions' }, content: [{ type: 'text', text: '注入' }] } }, undefined, 200)
  assert.deepEqual(extractUserInputs([tool, plugin]), [])
})

test('历史输入提取:纯图与空文本跳过', () => {
  const image = userEvent({ data: { content: [{ type: 'image', attachment: { id: 'a1' } }] } }, undefined, 100)
  const blank = userEvent(null, '', 200)
  const whitespace = userEvent(null, ' \n ', 300)
  assert.deepEqual(extractUserInputs([image, blank, whitespace]), [])
})

test('历史输入提取:多 text block 按行拼接为单条', () => {
  const events = [userEvent({ data: { content: [{ type: 'text', text: '第一段' }, { type: 'text', text: '第二段' }] } }, undefined, 300)]
  assert.deepEqual(extractUserInputs(events), [{ text: '第一段\n第二段', at: 300 }])
})

// ── 历史输入:聚合(G4-G5)──

test('历史输入聚合:同文本去重保留最新时间,按时间倒序', () => {
  const merged = aggregateInputs([
    { text: 'a', at: 1 },
    { text: 'b', at: 5 },
    { text: 'a', at: 9 },
  ], { limit: 10, maxChars: 100 })
  assert.deepEqual(merged, [{ text: 'a', at: 9 }, { text: 'b', at: 5 }])
})

test('历史输入聚合:limit 裁剪与单条截断', () => {
  const merged = aggregateInputs([
    { text: 'abcdef', at: 1 },
    { text: 'xy', at: 2 },
  ], { limit: 1, maxChars: 3 })
  assert.deepEqual(merged, [{ text: 'xy', at: 2 }])
})
