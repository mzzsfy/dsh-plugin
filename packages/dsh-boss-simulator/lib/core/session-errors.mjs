// 托管会话错误归类:会话不存在/已删除属终态,重试与核对都不会恢复。
// 停止核对、恢复核对与事件跟随共用同一判据,避免"跟随停了、停止核对还卡死"的分叉。
const TERMINAL_CODES = new Set(['SESSION_NOT_FOUND', 'SESSION_DELETED', 'session_not_found', 'session_deleted'])
const TERMINAL_MESSAGE = /(session|会话)[^\n]{0,40}(not found|missing|deleted|不存在|已删除)|ENOENT[^\n]*session/i

export function isSessionGoneError(error) {
  if (!error) return false
  if (TERMINAL_CODES.has(error.code)) return true
  return TERMINAL_MESSAGE.test(String(error.message ?? error))
}
