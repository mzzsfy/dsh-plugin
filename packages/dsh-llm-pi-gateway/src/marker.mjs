// 全协议会话标记器:sessionId 单向派生稳定粘性标识,按协议 api 显式分派注入。
// 手法同 rscli session-marker.ts;api 未提供时按形状判别兜底,未知形状原样返回。

import { createHash } from 'node:crypto'

// 协议常量:对齐 rscli session-marker.ts 的截断长度
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

/** anthropic-messages 请求体形状:有 system,或有 max_tokens 且无 openai 系分页字段。 */
export function isAnthropicPayload(payload) {
  if (typeof payload !== 'object' || payload === null) return false
  if ('system' in payload) return true
  return 'max_tokens' in payload
    && !('stream_options' in payload)
    && !('store' in payload)
    && !('max_completion_tokens' in payload)
}

/** openai 系请求体形状:有 messages(completions)或 input(responses)。 */
export function isOpenAIPayload(payload) {
  return typeof payload === 'object' && payload !== null
    && ('messages' in payload || 'input' in payload)
}

function injectAnthropic(payload, marker, template) {
  return { ...payload, metadata: { ...payload.metadata, ...template, user_id: marker } }
}

function injectOpenAI(payload, marker) {
  return { ...payload, prompt_cache_key: marker }
}

// api → 注入方式;调用方(adapter)已知路由 api,形状判别仅为兜底
const INJECT_BY_PROTOCOL = {
  'anthropic-messages': injectAnthropic,
  'openai-completions': injectOpenAI,
  'openai-responses': injectOpenAI,
}

/**
 * 注入派生标记:按协议 api 显式分派——anthropic → metadata.user_id(模板其余键
 * 合入,标记恒覆盖 user_id);openai 系 → prompt_cache_key;api 未提供时按形状
 * 判别兜底;未知形状原样返回。恒定返回新对象,不改动入参。
 * @param {object} payload 协议请求体
 * @param {string} sessionId 原始会话 id
 * @param {{api?: string, prefix?: string, template?: object}} [options]
 */
export function injectSessionMarker(payload, sessionId, { api, prefix, template } = {}) {
  const marker = deriveMarker(sessionId, prefix)
  const inject = INJECT_BY_PROTOCOL[api]
  if (inject !== undefined) return inject(payload, marker, template)
  if (isAnthropicPayload(payload)) return injectAnthropic(payload, marker, template)
  if (isOpenAIPayload(payload)) return injectOpenAI(payload, marker)
  return payload
}

/**
 * 构造挂到 pi-ai StreamOptions.onPayload 的标记回调;
 * enabled 为 false 时返回 undefined,由调用方不挂回调。
 * @param {string} sessionId 原始会话 id
 * @param {{api: string, prefix?: string, enabled?: boolean, template?: object}} routeOptions
 */
export function markerOnPayload(sessionId, { api, prefix, enabled = true, template = {} } = {}) {
  if (!enabled) return undefined
  return (payload) => injectSessionMarker(payload, sessionId, { api, prefix, template })
}
