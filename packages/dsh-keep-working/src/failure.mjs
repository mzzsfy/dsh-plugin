/**
 * 失败分类:决定一次 turn/end error 是否值得自动恢复。
 *
 * 只有重试同一请求必然同样失败的结构性问题才判永久(上下文超限、参数非法、
 * 本地缺适配器/凭据、prompt 变量缺失)。鉴权、余额、模型不存在等属于上游级
 * 错误:中转服务后面通常对接多个上游,换一条通道就可能成功,一律按临时处理。
 */

/**
 * 宿主规范错误码里的永久集合。
 *
 * 宿主明确要求按 code 路由而非解析文案,这些码的 message 常常是中性描述。
 * 只收请求结构/本地配置类;QUOTA、AUTH、模型不存在等上游级码不进集合。
 */
const PERMANENT_CODES = new Set([
  'CONTEXT_WINDOW_EXCEEDED',
  'INVALID_ARGS',
  'NO_ADAPTER',
  'MISSING_CREDENTIAL',
])

/**
 * 永久失败的文本特征;只认请求结构问题。
 *
 * 不匹配 invalid/bad request:中转层常把任意失败包成 `BadRequestError` 或
 * `"type":"invalid_request_error"`,按这个词判永久会把鉴权、余额等上游错误吞掉。
 */
const PERMANENT_PATTERNS = [
  /context[\s._-]*(?:window|length|limit|size)[\s._-]*(?:exceeded|overflow)?|context[\s._-]*(?:exceeded|overflow)|max(?:imum)? context|token limit/i,
  /prompt variable .* has no value/i,
]

/**
 * 传输层/网关故障特征。上游常把断流包装成 INVALID_REQUEST 之类的通用码,
 * 只看码会当成非法请求永久放弃,实际重试就能恢复。
 */
const TRANSIENT_PATTERNS = [
  /apiconnectionerror|connectionreseterror|remote\s*disconnected|incompleteread|chunkedencodingerror|transferencodingerror/i,
  /connection\s*(?:reset|refused|aborted|closed|error)|connection reset by peer/i,
  /response payload is not completed|not enough data to satisfy transfer length header/i,
  /econnreset|econnrefused|etimedout|esockettimeout|socket hang up|network is unreachable/i,
  /upstream connect error|reset before headers|no healthy upstream|broken pipe|unexpected eof/i,
  /deadline exceeded|context canceled|context cancelled|i\/o timeout|request timeout/i,
  /bad gateway|gateway timeout|service (?:temporarily )?unavailable|temporarily unavailable/i,
]

/** 文本判定只看 message 与 status:code 有自己的规范码集合,通用码不代表语义。 */
const textOf = (failure) => `${failure?.status ?? ''} ${failure?.message ?? ''}`

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
 * 401/403 与 MALFORMED_RESPONSE 是历史踩坑点:前者可能只是某条上游通道的凭据,
 * 换通道即可成功;后者可能回显工具参数里的 "api_key" 之类字样,都不能按文本判永久。
 */
export function isTransientFailure(failure, retryableErrorPatterns = '') {
  const text = textOf(failure).toLowerCase()
  // 自定义片段额外匹配 code,便于用户按规范码覆盖内置永久判定
  const customText = `${failure?.code ?? ''} ${text}`.toLowerCase()
  if (matchesCustomPattern(customText, retryableErrorPatterns)) return true
  // 规范码优先于文本:中性描述的请求结构错误只有 code 认得出来
  if (typeof failure?.code === 'string' && PERMANENT_CODES.has(failure.code)) return false
  // MALFORMED_RESPONSE 可能回显工具参数里的 token 数字,必须先于文本判定
  if (failure?.code === 'MALFORMED_RESPONSE') return true
  // 断流/网关故障优先于文本永久判定:message 里常带 status=400 之类的包装信息
  if (TRANSIENT_PATTERNS.some((pattern) => pattern.test(text))) return true
  return !PERMANENT_PATTERNS.some((pattern) => pattern.test(text))
}

