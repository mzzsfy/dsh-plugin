// 会话标记派生:sessionId 单向哈希为稳定粘性标识。
// 注入位置在 adapter 装饰器层(anthropic → metadata.user_id);协议形状判别
// 与请求体注入 helper 已随接管形态退役。

import { createHash } from 'node:crypto'

// 标记截断长度(对齐 rscli session-marker.ts)
const MARKER_HASH_CHARS = 40
const DEFAULT_MARKER_PREFIX = 'dsh'

/**
 * 由 sessionId 派生粘性标记,格式 `<前缀>:<sha256 前 40 位 hex>`。
 * @param {string} sessionId 原始会话 id
 * @param {string} [prefix] 标记前缀,默认 dsh
 */
export function deriveMarker(sessionId, prefix = DEFAULT_MARKER_PREFIX) {
  const hash = createHash('sha256').update(sessionId).digest('hex')
  return `${prefix}:${hash.slice(0, MARKER_HASH_CHARS)}`
}

export { DEFAULT_MARKER_PREFIX }
