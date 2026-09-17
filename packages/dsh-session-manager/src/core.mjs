// 纯逻辑层:归档评估状态机、删除资格与失败矩阵、面板投影、归档集合差分。
// 全部为无副作用纯函数,host 与测试共用。

export const DAY_MS = 24 * 60 * 60 * 1000
export const DEFAULT_AUTO_ARCHIVE_DAYS = 7
export const DEFAULT_AUTO_ARCHIVE_INTERVAL_HOURS = 24

/**
 * 自动归档配置的提交判定:输入框文本对照已提交值分类。
 * @param committedText - 该字段已提交值的字符串形态
 * @param text - 输入框当前文本
 * @returns noop 值未变 | invalid 非非负整数 | post 可提交(携带解析后的数值)
 */
export function classifyAutoArchiveInput(committedText, text) {
  const trimmed = text.trim()
  if (trimmed === committedText) return { action: 'noop' }
  const value = Number(trimmed)
  if (trimmed === '' || !Number.isInteger(value) || value < 0) return { action: 'invalid' }
  return { action: 'post', value }
}

/** 更新时间 = max(createdAt, 最近活跃时间)。 */
export function updatedAtOf(header, activityAtMs) {
  return Math.max(header.createdAt, activityAtMs ?? 0)
}

/**
 * 归档评估状态机:按阈值筛出待归档会话 id。
 * @param records - 候选行 {id, archived, running, blank, updatedAt}
 * @returns 超期且未归档、非运行中、非空白的会话 id
 */
export function selectArchiveCandidates({ records, nowMs, thresholdDays }) {
  if (!Number.isFinite(thresholdDays) || thresholdDays <= 0) return []
  const cutoff = nowMs - thresholdDays * DAY_MS
  return records
    .filter((item) => !item.archived && !item.running && !item.blank && item.updatedAt < cutoff)
    .map((item) => item.id)
}

/**
 * 会话所属工作区标题解析(与 client 镜像同规):workspace 账本(sessionIds)
 * 一级映射与官方 dsh-client-ui-workspace 的 workspaceBySession 同构;回退链为本
 * 插件收紧决策——官方对账本缺失回退会话 cwd 的 basename(无需命中登记工作区),
 * 此处要求 cwd 命中某登记工作区路径才回退其标题,否则未分组(null),避免把未
 * 登记目录名冒充工作区。工作区 title 缺失时回退路径末段(官方 workspaceTitleOf
 * 同构);title 与 path 皆缺返回 null。
 */
export function workspaceTitleOf(path) {
  const trimmed = String(path).replace(/[/\\]+$/, '')
  const separator = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'))
  return trimmed.slice(separator + 1)
}

export function workspaceTitleForSession({ workspaces, sessionId, cwd }) {
  const items = Array.isArray(workspaces) ? workspaces : []
  for (const workspace of items) {
    if (workspace && Array.isArray(workspace.sessionIds) && workspace.sessionIds.includes(sessionId)) {
      return workspace.title || (workspace.path ? workspaceTitleOf(workspace.path) : null)
    }
  }
  const normalizedCwd = cwd ? String(cwd).replace(/[/\\]+$/, '') : ''
  if (!normalizedCwd) return null
  for (const workspace of items) {
    if (workspace && workspace.path && String(workspace.path).replace(/[/\\]+$/, '') === normalizedCwd) {
      return workspace.title || workspaceTitleOf(workspace.path)
    }
  }
  return null
}

/** 归档面板行:session.list 行与归档集合的交集,按更新时间倒序;标题缺失回退会话 id;workspace 为所属工作区标题或 null(与 client 镜像同规)。 */
export function projectArchiveRows({ rows, archivedIds, workspaces }) {
  const archived = new Set(archivedIds)
  return rows
    .filter((row) => archived.has(row.id))
    .map((row) => ({
      id: row.id,
      title: row.title || row.id,
      updatedAt: row.updatedAt,
      workspace: workspaceTitleForSession({ workspaces, sessionId: row.id, cwd: row.cwd }),
    }))
    .sort((left, right) => right.updatedAt - left.updatedAt)
}

/** 归档集合差分:previous 缺省(基线首帧)不产生提示。 */
export function diffArchived(previousIds, nextIds) {
  if (previousIds === undefined) return []
  const previous = new Set(previousIds)
  return nextIds.filter((id) => !previous.has(id))
}

/**
 * Toast 差分步进:连续两个 ready 快照才计新增。
 * 模型订阅即时发射 pending 空态,基线(存量归档)成为第二帧;基线是重连权威而非
 * 归档事件,任一单帧都无法与事件区分,故以「上一帧也是 ready」为差分启用条件,
 * 启动与重连首装不误报,重连基线携带的离期新增仍会提示。
 * client.js 有一份镜像实现(单文件自包含无法跨文件 require),修改需两处同步。
 */
export function archiveToastStep(previous, snapshot) {
  const ready = Boolean(snapshot && snapshot.phase === 'ready')
  const ids = (snapshot && snapshot.archivedSessionIds) || []
  const added = previous !== undefined && previous.ready && ready ? diffArchived(previous.ids, ids) : []
  return { state: { ready, ids }, added }
}

/** 归档通知标题列举上限:超过该数只列前段并以「 等」收尾。 */
export const TOAST_MAX_TITLES = 3

/**
 * 归档通知文案:单个报标题,多个为计数加列举标题,标题数超展示阈值只列前段并以
 * 「 等」收尾,计数恒为真实总数。标题按去除首尾空白取值,缺失、空白或行不存在
 * 回退会话 id,行数据非数组视为空。client.js 有镜像实现(单文件自包含无法跨文件
 * require),修改需两处同步。
 */
export function archiveToastText(addedIds, rows) {
  const added = Array.isArray(addedIds) ? addedIds : []
  if (added.length === 0) return ''
  const safeRows = Array.isArray(rows) ? rows : []
  const titleById = new Map()
  for (const row of safeRows) {
    if (!row || row.id === undefined || row.id === null) continue
    const trimmed = String(row.title ?? '').trim()
    if (trimmed !== '') titleById.set(String(row.id), trimmed)
  }
  const names = added.map((id) => titleById.get(String(id)) || String(id))
  if (names.length === 1) return '会话「' + names[0] + '」已归档'
  const listed = names.slice(0, TOAST_MAX_TITLES)
  return '有 ' + names.length + ' 个会话已归档:' + listed.join('、') + (names.length > TOAST_MAX_TITLES ? ' 等' : '')
}

/** 删除资格:仅已归档会话,其余拒绝(竞态防护的 client 前置与 host 权威共用判定)。 */
export function deleteEligibility({ archivedIds, sessionId }) {
  return archivedIds.includes(sessionId)
    ? { ok: true }
    : { ok: false, code: 'not-archived' }
}

/** 运行中判定:agent 注册表 status 为 running 即运行中,与归档评估同款判据。 */
export function isSessionRunning({ agents, sessionId }) {
  const entry = agents ? agents.get(sessionId) : undefined
  return Boolean(entry && entry.status === 'running')
}

// 删除半失败聚合文案:trash 成功后各收尾失败点的主文案与后缀,host 响应逐键消费。
// 基础前缀与警告措辞按处置模式区分(系统回收站 / 插件回收区):两种模式找回路径不同
export function deleteOutcomeMessages(quarantined) {
  const base = quarantined ? '已移入插件回收区' : '已移入回收站'
  return {
    partial: base + ',但移除列表记录失败',
    archiveCleanup: base + ',但移除归档记录失败',
    ledgerFailed: base + ',但重挂载记录失败',
    runningDuringTrash: quarantined
      ? '警告:回收期间会话恢复运行,产物已移入插件回收区;建议检查会话状态'
      : '警告:回收期间会话恢复运行,产物已移入回收站;建议检查会话状态',
  }
}

// OS 回收站模式文案:保留常量导出供既有测试与文案对照
export const DELETE_MESSAGES = {
  ...deleteOutcomeMessages(false),
  ledgerSuffix: ',且重挂载记录失败',
}

/**
 * 删除收尾半失败聚合:trash 成功后的失败矩阵折叠为单一响应体。
 * 主文案优先级 detach → 归档清理 → 台账,台账失败以后缀并入前两者,运行中翻转
 * 以警告后缀并入一切形态。三形态逐键一致:{ok} / {ok,message} / {ok,partial,message}。
 * quarantined 为处置模式:系统回收站失败降级插件回收区时置真,基础前缀与警告措辞随之切换。
 */
export function aggregateDeleteOutcome({ detachFailed = false, archiveCleanupFailed = false, ledgerFailed = false, runningDuringTrash = false, quarantined = false }) {
  const M = deleteOutcomeMessages(quarantined)
  const warningSuffix = runningDuringTrash ? ';' + M.runningDuringTrash : ''
  const ledgerSuffix = ledgerFailed ? DELETE_MESSAGES.ledgerSuffix : ''
  if (detachFailed) return { ok: true, partial: true, message: M.partial + ledgerSuffix + warningSuffix }
  if (archiveCleanupFailed) return { ok: true, partial: true, message: M.archiveCleanup + ledgerSuffix + warningSuffix }
  if (ledgerFailed) return { ok: true, partial: true, message: M.ledgerFailed + warningSuffix }
  return runningDuringTrash
    ? { ok: true, message: M.runningDuringTrash }
    : { ok: true }
}

/** 空白产物判定:读到 EOF 且换行数不足两行,即仅 header(或空)视为空白。 */
export function artifactLooksBlank(headText, hasMore) {
  let breaks = 0
  for (const char of headText) {
    if (char === '\n') breaks += 1
    if (breaks >= 2) return false
  }
  return !hasMore && breaks < 2
}

/** 台账合并:同 id 替换,新条目置顶;返回新数组,不改入参。client.js 有镜像,修改需两处同步。 */
export function mergeDeletedEntry(deleted, entry) {
  return [entry, ...deleted.filter((item) => item.sessionId !== entry.sessionId)]
}

/** 台账移除:幂等;removed 标记是否发生变化,调用方据此决定是否写回。 */
export function removeDeletedEntry(deleted, sessionId) {
  const next = deleted.filter((item) => item.sessionId !== sessionId)
  return { deleted: next, removed: next.length !== deleted.length }
}

/** 已删除面板行:标题取会话行展示标题,缺失回退会话 id,按删除时间倒序。client.js 有镜像,修改需两处同步。 */
export function projectDeletedRows(deleted, sessionsById) {
  const byId = sessionsById || {}
  return [...deleted]
    .sort((left, right) => right.deletedAt - left.deletedAt)
    .map((item) => ({
      sessionId: item.sessionId,
      path: item.path,
      deletedAt: item.deletedAt,
      title: (byId[item.sessionId] && byId[item.sessionId].displayTitle) || item.sessionId,
    }))
}

// ── 归档库投影:主列表分页 / 工作区分组 / 标题搜索 ──

/** 归档库主列表默认展开行数与手动展开步长。 */
export const ARCHIVE_PAGE_SIZE = 100

/**
 * 归档列表分页:取前 visibleCount 条并报告剩余量,非有限或非正可见数按 0 处理。
 * client.js 有镜像实现(单文件自包含无法跨文件 require),修改需两处同步。
 */
export function pageArchiveRows(rows, visibleCount) {
  const list = Array.isArray(rows) ? rows : []
  const count = Number.isFinite(visibleCount) && visibleCount > 0 ? visibleCount : 0
  const visible = list.slice(0, count)
  return { visible, remaining: list.length - visible.length }
}

/**
 * 归档列表按工作区分组:workspace 假值并桶为未分组(null),组内保持输入序
 * (调用方输入恒为时间倒序投影),组间按组内最新 updatedAt 倒序。
 * client.js 有镜像实现(单文件自包含无法跨文件 require),修改需两处同步。
 */
export function groupArchiveRowsByWorkspace(rows) {
  const list = Array.isArray(rows) ? rows : []
  const byKey = new Map()
  for (const row of list) {
    const title = row.workspace ? String(row.workspace) : ''
    if (!byKey.has(title)) byKey.set(title, { workspace: title === '' ? null : title, latest: row.updatedAt, rows: [] })
    const group = byKey.get(title)
    group.rows.push(row)
    if (row.updatedAt > group.latest) group.latest = row.updatedAt
  }
  return [...byKey.values()]
    .sort((left, right) => right.latest - left.latest)
    .map(({ workspace, rows: groupRows }) => ({ workspace, rows: groupRows }))
}

/**
 * 归档列表标题搜索:查询词去首尾空白后按不区分大小写子串匹配标题,
 * 空查询原样返回全量。client.js 有镜像实现(单文件自包含无法跨文件 require),修改需两处同步。
 */
export function filterArchiveRows(rows, query) {
  const list = Array.isArray(rows) ? rows : []
  const needle = String(query ?? '').trim().toLowerCase()
  if (needle === '') return list
  return list.filter((row) => String(row.title ?? '').toLowerCase().includes(needle))
}

