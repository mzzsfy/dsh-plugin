// 用量统计数据路由:5 个 exact 端点共用守卫/校验/信封管线,粒度由路径分派。
// 协议契约见 docs/feat-usage-dash/host-design.md 端点章:成功 {ok:true,value},
// UsageError 回其 status 与 message(code 恒 usage_api_error),栅栏 forbidden,
// 未匹配 not_found,其余一切 500 固定文案不回显内部文本。

import { aggregateRange } from './query.js'
import {
  GRANULARITY_DAILY,
  GRANULARITY_HOURLY,
  GRANULARITY_MINUTE,
  MINUTE_BUCKET_SPAN_MINUTES,
  clampMinuteRetentionDays,
  minuteKey,
} from './store.js'

const ROUTE_PREFIX = '/api/usage-dash'
const MS_PER_DAY = 24 * 60 * 60 * 1000
export const MAX_RANGE_SPAN_DAYS = 366
const MAX_JSON_BODY_BYTES = 64 * 1024

const HTTP_STATUS_OK = 200
const HTTP_STATUS_BAD_REQUEST = 400
const HTTP_STATUS_FORBIDDEN = 403
const HTTP_STATUS_NOT_FOUND = 404
const HTTP_STATUS_METHOD_NOT_ALLOWED = 405
const HTTP_STATUS_PAYLOAD_TOO_LARGE = 413
const HTTP_STATUS_CONFLICT = 409
const HTTP_STATUS_INTERNAL_ERROR = 500

const ERROR_PREFIX = 'usage stats: '
const MESSAGE_BACKFILL_RUNNING = `${ERROR_PREFIX}backfill already running`
const MESSAGE_METHOD_NOT_ALLOWED = `${ERROR_PREFIX}method not allowed`
const MESSAGE_CROSS_ORIGIN = 'cross-origin request rejected'
const MESSAGE_CONTENT_TYPE = `${ERROR_PREFIX}content-type must be application/json`
const MESSAGE_RANGE_REQUIRED = `${ERROR_PREFIX}from and to are required`
const MESSAGE_INVALID_JSON = 'invalid json body'
const MESSAGE_INTERNAL_ERROR = 'internal error'

const CODE_USAGE_API_ERROR = 'usage_api_error'
const CODE_FORBIDDEN = 'forbidden'
const CODE_NOT_FOUND = 'not_found'

const METHOD_POST = 'POST'
const DEFAULT_METHOD = 'GET'
const CONTENT_TYPE_JSON = 'application/json'
const QUERY_SEPARATOR = /[?#]/
const EMPTY_BUCKET = ''

// 桶串形态锚定 + 本地时区分量回读,回滚形(13 月/25 时/60 分)当场拒绝,
// 与 query.js 桶串推导同源
const DAY_KEY_PARTS = /^(\d{4})-(\d{2})-(\d{2})$/
const HOUR_KEY_PARTS = /^(\d{4})-(\d{2})-(\d{2})T(\d{2})$/
const MINUTE_KEY_PARTS = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/

const DATE_COMPONENTS = [
  (date) => date.getFullYear(),
  (date) => date.getMonth() + 1,
  (date) => date.getDate(),
  (date) => date.getHours(),
  (date) => date.getMinutes(),
]

class UsageError extends Error {
  constructor(status, message, code = CODE_USAGE_API_ERROR) {
    super(message)
    this.status = status
    this.code = code
  }
}

const usageError = (status, message, code) => new UsageError(status, message, code)

function writeJson(res, value, status = HTTP_STATUS_OK) {
  res.statusCode = status
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(value))
}

function writeError(ctx, res, err) {
  if (err instanceof UsageError) {
    writeJson(res, { ok: false, error: { code: err.code, message: err.message } }, err.status)
    return
  }
  ctx.logger?.warn?.(`usage-dash: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`)
  writeJson(res, { ok: false, error: { code: CODE_USAGE_API_ERROR, message: MESSAGE_INTERNAL_ERROR } }, HTTP_STATUS_INTERNAL_ERROR)
}

async function readJsonBody(req, maxBytes = MAX_JSON_BODY_BYTES) {
  const chunks = []
  let total = 0
  for await (const chunk of req) {
    total += typeof chunk === 'string' ? Buffer.byteLength(chunk) : chunk.byteLength
    if (total > maxBytes) throw usageError(HTTP_STATUS_PAYLOAD_TOO_LARGE, `request body exceeds ${maxBytes} bytes`)
    chunks.push(chunk)
  }
  if (chunks.length === 0) return undefined
  const text = Buffer
    .concat(chunks.map((chunk) => (typeof chunk === 'string' ? Buffer.from(chunk) : chunk)))
    .toString('utf8')
  try {
    return JSON.parse(text)
  } catch {
    throw usageError(HTTP_STATUS_BAD_REQUEST, MESSAGE_INVALID_JSON)
  }
}

// 同源守卫:浏览器写请求恒带 Origin,与 Host 不符即拒;无 Origin 的非浏览器客户端放行
function rejectCrossOrigin(req) {
  const origin = req.headers?.origin
  if (!origin) return
  let sameOrigin = false
  try {
    sameOrigin = new URL(origin).host === req.headers?.host
  } catch {
    sameOrigin = false
  }
  if (!sameOrigin) throw usageError(HTTP_STATUS_FORBIDDEN, MESSAGE_CROSS_ORIGIN, CODE_FORBIDDEN)
}

function rejectNonJson(req) {
  const contentType = String(req.headers?.['content-type'] ?? '')
  if (!contentType.includes(CONTENT_TYPE_JSON)) throw usageError(HTTP_STATUS_BAD_REQUEST, MESSAGE_CONTENT_TYPE)
}

function rejectWrongMethod(req) {
  if ((req.method ?? DEFAULT_METHOD) !== METHOD_POST) {
    throw usageError(HTTP_STATUS_METHOD_NOT_ALLOWED, MESSAGE_METHOD_NOT_ALLOWED)
  }
}

function parseBucketParts(value, pattern) {
  if (typeof value !== 'string') return null
  const match = pattern.exec(value)
  if (!match) return null
  const parts = match.slice(1).map(Number)
  const date = new Date(parts[0], parts[1] - 1, parts[2], ...parts.slice(3))
  return DATE_COMPONENTS.slice(0, parts.length).every((component, i) => component(date) === parts[i]) ? parts : null
}

function requireBucketRange(body, pattern, keyLabel) {
  const from = body?.from
  const to = body?.to
  if (typeof from !== 'string' || typeof to !== 'string') {
    throw usageError(HTTP_STATUS_BAD_REQUEST, MESSAGE_RANGE_REQUIRED)
  }
  const fromParts = parseBucketParts(from, pattern)
  const toParts = parseBucketParts(to, pattern)
  if (!fromParts || !toParts) throw usageError(HTTP_STATUS_BAD_REQUEST, `${ERROR_PREFIX}invalid ${keyLabel}`)
  if (to < from) throw usageError(HTTP_STATUS_BAD_REQUEST, `${ERROR_PREFIX}to must not precede from`)
  return { from, to, fromParts, toParts }
}

const utcDayOf = (parts) => Date.UTC(parts[0], parts[1] - 1, parts[2])

async function respondAggregate(deps, res, granularity, from, to) {
  const rows = await deps.store.rangeRows(granularity, from, to)
  writeJson(res, { ok: true, value: aggregateRange(rows, granularity, from, to) })
}

const rangeHandler = (deps) => async (req, res) => {
  const { from, to, fromParts, toParts } = requireBucketRange(await readJsonBody(req), DAY_KEY_PARTS, 'day key')
  const spanDays = (utcDayOf(toParts) - utcDayOf(fromParts)) / MS_PER_DAY + 1
  if (spanDays > MAX_RANGE_SPAN_DAYS) {
    throw usageError(HTTP_STATUS_BAD_REQUEST, `${ERROR_PREFIX}span exceeds ${MAX_RANGE_SPAN_DAYS} days`)
  }
  await respondAggregate(deps, res, GRANULARITY_DAILY, from, to)
}

const hoursHandler = (deps) => async (req, res) => {
  const { from, to } = requireBucketRange(await readJsonBody(req), HOUR_KEY_PARTS, 'hour key')
  await respondAggregate(deps, res, GRANULARITY_HOURLY, from, to)
}

// 分钟保留窗口(天)换算为起点桶串:起点晚于请求 from 即窗口外已清理,
// 标注实际可用范围;禁用(0)时恒无数据,covered 标注空串。
// retentionDays 经 clamp 归一(非法回落默认,超上限截断),与 store.pruneMinutes 同源
const minuteHandler = (deps) => async (req, res) => {
  const { from, to, fromParts } = requireBucketRange(await readJsonBody(req), MINUTE_KEY_PARTS, 'minute key')
  if (fromParts[fromParts.length - 1] % MINUTE_BUCKET_SPAN_MINUTES !== 0) {
    throw usageError(HTTP_STATUS_BAD_REQUEST, `${ERROR_PREFIX}minute key must align to ${MINUTE_BUCKET_SPAN_MINUTES} minutes`)
  }
  const rows = await deps.store.rangeRows(GRANULARITY_MINUTE, from, to)
  const value = aggregateRange(rows, GRANULARITY_MINUTE, from, to)
  const retention = clampMinuteRetentionDays(deps.retentionDays())
  if (retention > 0) {
    const windowStart = minuteKey(deps.now() - retention * MS_PER_DAY)
    if (windowStart > from) Object.assign(value, { coveredFrom: windowStart, coveredTo: to })
  } else {
    Object.assign(value, { coveredFrom: EMPTY_BUCKET, coveredTo: EMPTY_BUCKET })
  }
  writeJson(res, { ok: true, value })
}

const statusHandler = (deps) => async (req, res) => {
  writeJson(res, { ok: true, value: deps.collector.status() })
}

// 409 只拒 boot 期扫描;reset 自身引发的重扫同样 running 为真,经 rebuilding 放行
const resetHandler = (deps) => async (req, res) => {
  if (deps.collector.running && !deps.collector.rebuilding) {
    throw usageError(HTTP_STATUS_CONFLICT, MESSAGE_BACKFILL_RUNNING)
  }
  await deps.collector.resetAndRescan()
  writeJson(res, { ok: true, value: deps.collector.status() })
}

const ENDPOINTS = [
  { path: `${ROUTE_PREFIX}/range`, mount: rangeHandler },
  { path: `${ROUTE_PREFIX}/hours`, mount: hoursHandler },
  { path: `${ROUTE_PREFIX}/minutes`, mount: minuteHandler },
  { path: `${ROUTE_PREFIX}/status`, mount: statusHandler },
  { path: `${ROUTE_PREFIX}/reset`, mount: resetHandler },
]

const routePathOf = (req) => (req.url ?? '').split(QUERY_SEPARATOR, 1)[0]

export function registerUsageRoutes(ctx, { store, collector, retentionDays, now = Date.now }) {
  const deps = { store, collector, retentionDays, now }
  const handlers = new Map(ENDPOINTS.map((endpoint) => [endpoint.path, endpoint.mount(deps)]))
  // exact 注册下宿主只会命中自有路径,此处仍按路径精确等值分派,未匹配即 404
  const dispatch = async (req, res) => {
    try {
      const path = routePathOf(req)
      const handler = handlers.get(path)
      if (!handler) throw usageError(HTTP_STATUS_NOT_FOUND, `unknown endpoint ${path}`, CODE_NOT_FOUND)
      rejectWrongMethod(req)
      rejectCrossOrigin(req)
      rejectNonJson(req)
      await handler(req, res)
    } catch (err) {
      writeError(ctx, res, err)
    }
  }
  const disposers = ENDPOINTS.map(({ path }) =>
    ctx.effect(() => ctx.webServer.register({ kind: 'exact', path, handler: dispatch }), `usage-dash: route ${path}`))
  return () => disposers.forEach((dispose) => dispose?.())
}
