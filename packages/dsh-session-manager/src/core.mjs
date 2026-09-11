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

// 历史输入回溯参数:host 聚合路由使用(client 单文件自包含不经此,展示侧另行内联)。
// 范围按 ←/→ 切换序排列:索引 0 为常用提示词(个人收藏),索引 1 为当前会话
// (浮层默认落点),→ 向更大范围,← 返回收藏
// 对齐 = 后台解压范围内会话产物与持久缓存合并;两次对齐最小间隔防持续解压。
// 解压是 CPU 操作:启动零解压(历史直接读磁盘缓存),全量对齐延迟 STARTUP_DELAY
// 再跑、只回溯最近 STARTUP_SCAN 个会话;超 MAX_ARTIFACT 的巨产物跳过——
// 上限防的是解压耗时与事件对象内存峰值失控,非阻塞主循环;跳过线按宿主版本
// 黑名单取值(见 isLegacyDecompressHost),对齐中连续解压占用超 SLICE 即让出 YIELD。
// 运行中会话(当前会话)提取结果只保留内存不落盘——产物持续变化,落盘指纹立即失效
export const HISTORY_SESSION_SCAN_LIMIT = 20
export const HISTORY_INPUT_LIMIT = 200
export const HISTORY_INPUT_MAX_CHARS = 20 * 1000
export const HISTORY_SCOPES = ['prompts', 'session', 'workspace', 'global']
export const HISTORY_PROMPTS_MAX = 100
export const HISTORY_ALIGN_THROTTLE_MS = 30 * 1000
export const HISTORY_STARTUP_DELAY_MS = 30 * 1000
export const HISTORY_STARTUP_SCAN_LIMIT = 100
export const HISTORY_ALIGN_SLICE_MS = 200
export const HISTORY_ALIGN_YIELD_MS = 100
// 巨产物跳过线(压缩字节数):现役最大产物约 3.5MiB。新解压线 16MiB 留 4 倍余量,
// 超线产物解压后可达数百 MB(压缩比约 1:3.4,事件对象再放大),内存峰值失控;
// 旧解压线 8MiB 面向 0.1.1/0.1.2 黑名单宿主——其解压实现尚无周期让出,从严
export const HISTORY_ALIGN_MODERN_MAX_ARTIFACT_BYTES = 16 * 1024 * 1024
export const HISTORY_ALIGN_LEGACY_MAX_ARTIFACT_BYTES = 8 * 1024 * 1024
// 与官方 semver 语义对齐的宽松校验:黑名单判定只取主/次/修订号,prerelease 无关
const SEMVER_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)/
// 旧解压实现黑名单:仅 0.1.1 与 0.1.2 系列(含各 prerelease);0.1.5 实测
// readZstdPrefix 逐帧解压 + 周期让出。版本非法/缺失按黑名单保守回退旧线
export function isLegacyDecompressHost(version) {
  const match = SEMVER_PATTERN.exec(typeof version === 'string' ? version.trim() : '')
  if (!match) return true
  const major = Number(match[1])
  const minor = Number(match[2])
  const patch = Number(match[3])
  return major === 0 && minor === 1 && (patch === 1 || patch === 2)
}
export function maxArtifactBytesForHost(version) {
  return isLegacyDecompressHost(version) ? HISTORY_ALIGN_LEGACY_MAX_ARTIFACT_BYTES : HISTORY_ALIGN_MODERN_MAX_ARTIFACT_BYTES
}
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
 * 条目可携带 sid(来源会话)用于 session 范围过滤,聚合时原样保留。
 * 首条保护:被 limit 挤出时,每个来源会话在去重后集合中的最早条目仍保留——
 * 会话开场提示词是最有复用价值也最旧的一批,时间倒序截断总会先挤掉它们;
 * 保护在去重后集合上计算,文本已被更新的会话复用时不再按旧会话重复追加。 */
export function aggregateInputs(entries, { limit, maxChars }) {
  const latestByText = new Map()
  for (const entry of entries || []) {
    const known = latestByText.get(entry.text)
    if (known === undefined || entry.at > known.at) latestByText.set(entry.text, entry)
  }
  const earliestBySid = new Map()
  for (const entry of latestByText.values()) {
    if (entry.sid === undefined) continue
    const known = earliestBySid.get(entry.sid)
    if (known === undefined || entry.at < known.at) earliestBySid.set(entry.sid, entry)
  }
  const kept = [...latestByText.values()].sort((left, right) => right.at - left.at).slice(0, limit)
  const keptTexts = new Set(kept.map((entry) => entry.text))
  for (const first of earliestBySid.values()) {
    if (!keptTexts.has(first.text)) kept.push(first)
  }
  return kept
    .sort((left, right) => right.at - left.at)
    .map((entry) => ({
      text: entry.text.slice(0, maxChars),
      at: entry.at,
      ...(entry.sid !== undefined ? { sid: entry.sid } : {}),
    }))
}
