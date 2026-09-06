// 纯逻辑层:归档评估状态机、删除资格与失败矩阵、面板投影、归档集合差分。
// 全部为无副作用纯函数,host 与测试共用。

export const DAY_MS = 24 * 60 * 60 * 1000
export const DEFAULT_AUTO_ARCHIVE_DAYS = 7
export const DEFAULT_AUTO_ARCHIVE_INTERVAL_HOURS = 24

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

/** 归档面板行:session.list 行与归档集合的交集,按更新时间倒序;标题缺失回退会话 id(与 client 镜像同规)。 */
export function projectArchiveRows({ rows, archivedIds }) {
  const archived = new Set(archivedIds)
  return rows
    .filter((row) => archived.has(row.id))
    .map((row) => ({ id: row.id, title: row.title || row.id, updatedAt: row.updatedAt }))
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

// 删除半失败聚合文案:trash 成功后各收尾失败点的主文案与后缀,host 响应逐键消费
export const DELETE_MESSAGES = {
  partial: '已移入回收站,但移除列表记录失败',
  archiveCleanup: '已移入回收站,但移除归档记录失败',
  ledgerFailed: '已移入回收站,但重挂载记录失败',
  ledgerSuffix: ',且重挂载记录失败',
  runningDuringTrash: '警告:回收期间会话恢复运行,产物已移入回收站;建议检查会话状态',
}

/**
 * 删除收尾半失败聚合:trash 成功后的失败矩阵折叠为单一响应体。
 * 主文案优先级 detach → 归档清理 → 台账,台账失败以后缀并入前两者,运行中翻转
 * 以警告后缀并入一切形态。三形态逐键一致:{ok} / {ok,message} / {ok,partial,message}。
 */
export function aggregateDeleteOutcome({ detachFailed = false, archiveCleanupFailed = false, ledgerFailed = false, runningDuringTrash = false }) {
  const warningSuffix = runningDuringTrash ? ';' + DELETE_MESSAGES.runningDuringTrash : ''
  const ledgerSuffix = ledgerFailed ? DELETE_MESSAGES.ledgerSuffix : ''
  if (detachFailed) return { ok: true, partial: true, message: DELETE_MESSAGES.partial + ledgerSuffix + warningSuffix }
  if (archiveCleanupFailed) return { ok: true, partial: true, message: DELETE_MESSAGES.archiveCleanup + ledgerSuffix + warningSuffix }
  if (ledgerFailed) return { ok: true, partial: true, message: DELETE_MESSAGES.ledgerFailed + warningSuffix }
  return runningDuringTrash
    ? { ok: true, message: DELETE_MESSAGES.runningDuringTrash }
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

// 历史输入回溯参数:host 聚合路由使用(client 单文件自包含不经此,展示侧另行内联)。
// 范围从窄到宽排列,client ←/→ 切换即在此数组上移动索引。
// 对齐 = 后台解压范围内会话产物与持久缓存合并;两次对齐最小间隔防持续解压。
// 解压是同步 CPU 操作会阻塞主循环:启动零解压(历史直接读磁盘缓存),
// 全量对齐延迟 STARTUP_DELAY 再跑、只回溯最近 STARTUP_SCAN 个会话、
// 跳过超 MAX_ARTIFACT 的巨产物(单次 readSession 内部不可让出,巨产物一解卡死主循环);
// 对齐中连续解压占用超 SLICE 即让出 YIELD。
// 运行中会话(当前会话)提取结果只保留内存不落盘——产物持续变化,落盘指纹立即失效
export const HISTORY_SESSION_SCAN_LIMIT = 20
export const HISTORY_INPUT_LIMIT = 200
export const HISTORY_INPUT_MAX_CHARS = 20 * 1000
export const HISTORY_SCOPES = ['session', 'workspace', 'global']
export const HISTORY_ALIGN_THROTTLE_MS = 30 * 1000
export const HISTORY_STARTUP_DELAY_MS = 30 * 1000
export const HISTORY_STARTUP_SCAN_LIMIT = 100
export const HISTORY_ALIGN_SLICE_MS = 200
export const HISTORY_ALIGN_YIELD_MS = 100
export const HISTORY_ALIGN_MAX_ARTIFACT_BYTES = 8 * 1024 * 1024
// 会话范围路由触发焦点对齐后就地等待的时限:首条数据可见预算(3s)内
// 留出解压+读盘份额,超时改走轮询流式补齐
export const HISTORY_FOCUS_WAIT_MS = 2 * 1000

/**
 * 从会话事件流提取人类输入:仅 user/message 且来源为用户本人,
 * 文本块按行拼接;工具结果回填、插件注入与空白输入(纯图/空/纯空白)均不产出。
 * @param events - readSession 返回的原始事件数组
 * @returns 条目 { text, at },时间取事件时间
 */
export function extractUserInputs(events) {
  const entries = []
  for (const event of events || []) {
    if (!event || event.type !== 'user/message') continue
    const message = event.data
    if (!message || !message.source || message.source.kind !== 'user') continue
    const text = (message.content || [])
      .filter((block) => block && block.type === 'text' && block.text !== '')
      .map((block) => block.text)
      .join('\n')
    if (text.trim() === '') continue
    entries.push({ text, at: event.time })
  }
  return entries
}

/** 历史输入聚合:精确文本去重保留最新时间,时间倒序,截 limit 条,单条截 maxChars 字符。
 * 条目可携带 sid(来源会话)用于 session 范围过滤,聚合时原样保留。 */
export function aggregateInputs(entries, { limit, maxChars }) {
  const latestByText = new Map()
  for (const entry of entries || []) {
    const known = latestByText.get(entry.text)
    if (known === undefined || entry.at > known.at) latestByText.set(entry.text, entry)
  }
  return [...latestByText.values()]
    .sort((left, right) => right.at - left.at)
    .slice(0, limit)
    .map((entry) => ({
      text: entry.text.slice(0, maxChars),
      at: entry.at,
      ...(entry.sid !== undefined ? { sid: entry.sid } : {}),
    }))
}
