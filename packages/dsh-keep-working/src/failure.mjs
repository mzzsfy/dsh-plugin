/**
 * 失败分类:决定一次 turn/end error 是否值得自动恢复。
 *
 * 永久性失败(鉴权、余额、模型不存在、上下文超限、非法请求)重试必然再失败,
 * 只会消耗额度;其余(网络、超时、5xx、429)按临时处理。
 */

/**
 * 宿主规范错误码里的永久集合。
 *
 * 宿主明确要求按 code 路由而非解析文案,这些码的 message 常常是中性描述
 * (例如 "the request failed"),只看文本会把额度耗尽、缺少适配器当成
 * 临时错误反复重试,每次都在真实计费面上再失败一次。
 */
const PERMANENT_CODES = new Set([
  'QUOTA',
  'ACCOUNT_QUOTA',
  'AUTH',
  'INVALID_CREDENTIAL',
  'MISSING_CREDENTIAL',
  'CONTEXT_WINDOW_EXCEEDED',
  'NO_ADAPTER',
  'INVALID_ARGS',
])

/** 永久失败的文本特征;命中即不重试。 */
const PERMANENT_PATTERNS = [
  /unauthor|forbidden|api[\s_-]?key|\bauth\b|authentication|credential|permission denied|invalid token/i,
  /insufficient.*(balance|quota|funds)|billing|payment required|quota exceeded/i,
  // 各家额度耗尽的原文彼此不通用,补两条最常见的无码形态
  /credit balance is too low|resource has been exhausted/i,
  /model.*not\s*found|unknown model|does not support model/i,
  /context.*(length|limit|overflow|exceeded)|token limit|max.*context/i,
  /invalid[_-]?request|bad[_-]?request/i,
  /prompt variable .* has no value/i,
]

/** 宿主会把 HTTP 状态并进 message 而非独立字段,文本里的 401/403 同样是永久信号。 */
const PERMANENT_STATUS = /(?:^|[^\d])(401|403)(?:[^\d]|$)/

const textOf = (failure) => `${failure?.code ?? ''} ${failure?.status ?? ''} ${failure?.message ?? ''}`

/** 解析 turn/end 的 error 载荷;无法解释时返回 undefined。 */
export function parseFailureFacts(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
  const code = typeof value.code === 'string' && value.code.trim() !== '' ? value.code : undefined
  const message =
    typeof value.message === 'string' && value.message.trim() !== '' ? value.message : undefined
  const status =
    typeof value.status === 'number' && Number.isFinite(value.status) ? value.status : undefined
  if (code === undefined && message === undefined && status === undefined) return undefined
  return {
    code: code ?? 'UNKNOWN',
    message: message ?? code ?? `HTTP ${status}`,
    ...(status === undefined ? {} : { status }),
  }
}

/** 自定义片段按行填写,命中即视为可重试。 */
function matchesCustomPattern(text, patterns) {
  if (typeof patterns !== 'string' || patterns === '') return false
  return patterns
    .split(/\r?\n/)
    .map((pattern) => pattern.trim().toLowerCase())
    .filter((pattern) => pattern !== '')
    .some((pattern) => text.includes(pattern))
}

/**
 * 失败是否值得自动继续。
 * 401/403 与 MALFORMED_RESPONSE 是历史踩坑点:前者恒永久,后者的消息可能
 * 回显工具参数里的 "api_key" 之类字样,不能按文本判永久。
 */
export function isTransientFailure(failure, retryableErrorPatterns = '') {
  const text = textOf(failure).toLowerCase()
  if (matchesCustomPattern(text, retryableErrorPatterns)) return true
  // 规范码优先于文本:中性描述的额度与适配器错误只有 code 认得出来
  if (typeof failure?.code === 'string' && PERMANENT_CODES.has(failure.code)) return false
  if (failure?.status === 401 || failure?.status === 403) return false
  if (PERMANENT_STATUS.test(text)) return false
  if (failure?.code === 'MALFORMED_RESPONSE') return true
  return !PERMANENT_PATTERNS.some((pattern) => pattern.test(text))
}

