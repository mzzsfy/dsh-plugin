// 纯逻辑层:归档评估状态机、删除资格与失败矩阵、面板投影、归档集合差分。
// 全部为无副作用纯函数,host 与测试共用。

export const DAY_MS = 24 * 60 * 60 * 1000
export const DEFAULT_AUTO_ARCHIVE_DAYS = 7
export const TOAST_HOLD_MS = 4 * 1000

export const DELETE_CODES = {
  UNSUPPORTED: 'unsupported',
  TRASH_FAILED: 'trash-failed',
  PARTIAL: 'partial',
  DELETED: 'deleted',
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

/** 归档面板行:session.list 行与归档集合的交集,按更新时间倒序。 */
export function projectArchiveRows({ rows, archivedIds }) {
  const archived = new Set(archivedIds)
  return rows
    .filter((row) => archived.has(row.id))
    .map((row) => ({ id: row.id, title: row.title, updatedAt: row.updatedAt }))
    .sort((left, right) => right.updatedAt - left.updatedAt)
}

/** 归档集合差分:previous 缺省(基线首帧)不产生提示。 */
export function diffArchived(previousIds, nextIds) {
  if (previousIds === undefined) return []
  const previous = new Set(previousIds)
  return nextIds.filter((id) => !previous.has(id))
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

/** 删除失败矩阵:locate → trash → detach 各失败点映射为稳定结果码。 */
export function deleteOutcome({ located, trashError, detachError }) {
  if (!located) return { code: DELETE_CODES.UNSUPPORTED }
  if (trashError !== undefined) return { code: DELETE_CODES.TRASH_FAILED, error: trashError }
  if (detachError !== undefined) return { code: DELETE_CODES.PARTIAL, error: detachError }
  return { code: DELETE_CODES.DELETED }
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
