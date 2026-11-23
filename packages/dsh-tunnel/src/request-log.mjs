// 请求日志: 内存环形缓冲, 只保留最近若干条经隧道转发的请求。
// 用途是排障(路径/状态/耗时/错误), 不做审计: 不落盘、不记录请求响应体与头部。

export const DEFAULT_REQUEST_LOG_LIMIT = 500
export const REQUEST_LOG_LIMIT_MIN = 0
export const REQUEST_LOG_LIMIT_MAX = 2000
// 单次查询返回上限与容量上限同源: 不留下查询不到的尾部
export const REQUEST_LOG_QUERY_MAX = REQUEST_LOG_LIMIT_MAX
export const REQUEST_LOG_PATH_MAX = 400
export const REQUEST_LOG_ERROR_MAX = 200
export const REQUEST_LOG_METHOD_MAX = 16
export const REQUEST_LOG_TUNNEL_MAX = 64

export const REQUEST_LOG_KIND_HTTP = 'http'
export const REQUEST_LOG_KIND_WS = 'ws'
const ENTRY_KINDS = new Set([REQUEST_LOG_KIND_HTTP, REQUEST_LOG_KIND_WS])

function clampText(value, max) {
  return String(value ?? '').slice(0, max)
}

function normalizeEntry(raw) {
  const entry = {
    at: clampText(raw?.at, 32),
    tunnel: clampText(raw?.tunnel, REQUEST_LOG_TUNNEL_MAX),
    kind: ENTRY_KINDS.has(raw?.kind) ? raw.kind : REQUEST_LOG_KIND_HTTP,
    method: clampText(raw?.method ?? 'GET', REQUEST_LOG_METHOD_MAX),
    path: clampText(raw?.path ?? '/', REQUEST_LOG_PATH_MAX),
    status: Number.isInteger(raw?.status) ? raw.status : 0,
    ms: Number.isFinite(raw?.ms) ? Math.max(0, Math.round(raw.ms)) : 0,
  }
  if (raw?.error !== undefined) entry.error = clampText(raw.error, REQUEST_LOG_ERROR_MAX)
  return entry
}

// 容量从偏好实时读取: 设置改动立即生效, 0 表示停止记录
export function createRequestLog(limitOf) {
  const entries = []
  let sequence = 0
  const capacity = () => {
    const value = Number(limitOf?.())
    if (!Number.isInteger(value) || value < REQUEST_LOG_LIMIT_MIN || value > REQUEST_LOG_LIMIT_MAX) return DEFAULT_REQUEST_LOG_LIMIT
    return value
  }
  return {
    record(raw) {
      const limit = capacity()
      if (limit === REQUEST_LOG_LIMIT_MIN) return
      sequence += 1
      entries.unshift({ ...normalizeEntry(raw), seq: sequence })
      if (entries.length > limit) entries.length = limit
    },
    // 设置变更时立即按新容量物理裁剪: 调高容量不得让已隐藏的旧条目复现
    trim() {
      const limit = capacity()
      if (entries.length > limit) entries.length = limit
    },
    list({ name, limit } = {}) {
      const max = capacity()
      if (max === REQUEST_LOG_LIMIT_MIN) return []
      const matched = typeof name === 'string' && name !== '' ? entries.filter((entry) => entry.tunnel === name) : entries
      const count = Number.isInteger(limit) && limit > 0 ? Math.min(limit, max) : max
      return matched.slice(0, count).map((entry) => ({ ...entry }))
    },
  }
}
