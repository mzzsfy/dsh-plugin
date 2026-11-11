/**
 * 失败分类:决定一次 turn/end error 是否值得自动恢复。
 *
 * 永久性失败(鉴权、余额、模型不存在、上下文超限、非法请求)重试必然再失败,
 * 只会消耗额度;其余(网络、超时、5xx、429)按临时处理。
 */

/** 与错误类型绑定的路由码,即使消息缺失也需识别。 */
const NETWORK_CODES = /^(TRANSPORT|TIMEOUT|NETWORK|ECONN|ENOTFOUND|ETIMEDOUT|EAI_AGAIN|ENETUNREACH|EHOSTUNREACH)/i

/** 永久失败的文本特征;命中即不重试。 */
const PERMANENT_PATTERNS = [
  /unauthor|forbidden|api[\s_-]?key|\bauth\b|authentication|credential|permission denied|invalid token/i,
  /insufficient.*(balance|quota|funds)|billing|payment required|quota exceeded/i,
  /model.*not\s*found|unknown model|does not support model/i,
  /context.*(length|limit|overflow|exceeded)|token limit|max.*context/i,
  /invalid[_-]?request|bad[_-]?request/i,
  /prompt variable .* has no value/i,
]

/** 宿主会把 HTTP 状态并进 message 而非独立字段,文本里的 401/403 同样是永久信号。 */
const PERMANENT_STATUS = /(?:^|[^\d])(401|403)(?:[^\d]|$)/

/** 连接层失败的文本特征;只有这类值得先做连通性探测。 */
const NETWORK_PATTERNS =
  /network|fetch failed|econn|enotfound|eai_again|etimedout|enetunreach|ehostunreach|enetdown|getaddrinfo|socket hang up|offline|could not reach|connection (reset|refused|closed)|timed? ?out/i

/** 宿主 agent/error 消息里的网络与传输特征。 */
const TRANSIENT_AGENT_PATTERN = /network|timeout|timed ?out|econn|etimedout|socket|5\d\d|\b429\b|upstream|temporar/i

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
  if (failure?.status === 401 || failure?.status === 403) return false
  if (PERMANENT_STATUS.test(text)) return false
  if (failure?.code === 'MALFORMED_RESPONSE') return true
  return !PERMANENT_PATTERNS.some((pattern) => pattern.test(text))
}

/** agent/error 消息的分类:只放行明确的网络与传输类。 */
export function isTransientAgentError(message) {
  return typeof message === 'string' && TRANSIENT_AGENT_PATTERN.test(message)
}

/** 是否为连接层失败(断网、DNS、连接被拒、传输超时)。 */
export function isNetworkFailure(failure) {
  if (typeof failure?.code === 'string' && NETWORK_CODES.test(failure.code)) return true
  return typeof failure?.message === 'string' && NETWORK_PATTERNS.test(failure.message)
}
