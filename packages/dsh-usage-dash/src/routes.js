// 用量统计数据路由:14 个 exact 端点共用守卫/校验/信封管线,粒度由路径分派。
// 跨源与 content-type 由共享 withRouteGate 统一把关(大小写不敏感同源、媒体类型按
// essence 精确比较),pricing / budget / cycle / features 四个端点放宽方法策略(GET 读 /
// POST 写),POST 同样要求 JSON。
// 协议契约以本文件实现与 test/routes.test.mjs 为准:成功 {ok:true,value},
// UsageError 回其 status 与 message(code 恒 usage_api_error),未匹配 not_found,
// 其余一切 500 固定文案不回显内部文本;网关拒绝回共享 {error} 信封。

import { z } from 'zod'

import { withRouteGate } from './route-gate.mjs'
import { MAX_SLOTS, aggregateRange, attachCosts } from './query.js'
import { CYCLE_DEFAULT, cycleWindowOf } from './cycle.js'
import { buildBudgetStatus, buildSummary } from './summary.js'
import { simulateWhatIf } from './whatif.js'
import { CURRENCIES, CONDITION_KINDS, UNIT_PER_MILLION, isTwoSegmentModel } from './pricing.js'
import { FEATURE_KEYS, normalizeFeatures } from './features.js'
import {
  GRANULARITY_DAILY,
  GRANULARITY_HOURLY,
  GRANULARITY_MINUTE,
  HOUR_RETENTION_DAYS,
  MINUTE_BUCKET_SPAN_MINUTES,
  clampMinuteRetentionDays,
  dayKey,
  minuteKey,
} from './store.js'

const ROUTE_PREFIX = '/api/usage-dash'
const MS_PER_DAY = 24 * 60 * 60 * 1000
const MS_PER_HOUR = 60 * 60 * 1000
const MS_PER_MINUTE = 60 * 1000
const MINUTES_PER_HOUR = 60
const HOURS_PER_DAY = 24
export const MAX_RANGE_SPAN_DAYS = 366
// 跨度硬上限按粒度:H 与 15 天保留期同源;M 取 MAX_SLOTS 可枚举上限(13 天,
// 保留期外查询仍由 coveredFrom/coveredTo 标注,不因配置调小而拒绝)。
// 按桶键数校验,不物化桶序列,超限即 400(单请求不可拖垮宿主堆)
const MINUTE_SLOTS_PER_DAY = HOURS_PER_DAY * (MINUTES_PER_HOUR / MINUTE_BUCKET_SPAN_MINUTES)
export const MAX_HOUR_SPAN_DAYS = HOUR_RETENTION_DAYS
export const MAX_MINUTE_SPAN_DAYS = Math.floor(MAX_SLOTS / MINUTE_SLOTS_PER_DAY)
// 桶串闭区间含两端桶:N 天跨度 = N*24 小时差 + 端点槽;保留 15 天即 361 槽
export const MAX_HOUR_SLOTS = MAX_HOUR_SPAN_DAYS * HOURS_PER_DAY + 1
const MAX_MINUTE_SLOTS = MAX_MINUTE_SPAN_DAYS * MINUTE_SLOTS_PER_DAY
const MAX_JSON_BODY_BYTES = 64 * 1024

const HTTP_STATUS_OK = 200
const HTTP_STATUS_BAD_REQUEST = 400
const HTTP_STATUS_FORBIDDEN = 403
const HTTP_STATUS_NOT_FOUND = 404
const HTTP_STATUS_METHOD_NOT_ALLOWED = 405
const HTTP_STATUS_PAYLOAD_TOO_LARGE = 413
const HTTP_STATUS_CONFLICT = 409
const HTTP_STATUS_UNAVAILABLE = 503
const HTTP_STATUS_INTERNAL_ERROR = 500

const ERROR_PREFIX = 'usage stats: '
const MESSAGE_BACKFILL_RUNNING = `${ERROR_PREFIX}backfill already running`
const MESSAGE_BACKUP_UNAVAILABLE = `${ERROR_PREFIX}backup snapshot unavailable`
const MESSAGE_METHOD_NOT_ALLOWED = `${ERROR_PREFIX}method not allowed`
const MESSAGE_RANGE_REQUIRED = `${ERROR_PREFIX}from and to are required`
const MESSAGE_INVALID_PRICING = `${ERROR_PREFIX}invalid pricing rules`
const MESSAGE_INVALID_FEATURES = `${ERROR_PREFIX}invalid feature switches`
const MESSAGE_FEATURES_UNAVAILABLE = `${ERROR_PREFIX}feature switches unavailable`
const MESSAGE_INVALID_CYCLE = `${ERROR_PREFIX}invalid billing cycle`
const MESSAGE_CYCLE_UNAVAILABLE = `${ERROR_PREFIX}billing cycle unavailable`
const MESSAGE_PRICING_UNAVAILABLE = `${ERROR_PREFIX}pricing unavailable`
const MESSAGE_BUDGET_UNAVAILABLE = `${ERROR_PREFIX}budget settings unavailable`
const MESSAGE_INVALID_BUDGET = `${ERROR_PREFIX}invalid budget settings`
const MESSAGE_INVALID_JSON = 'invalid json body'
const MESSAGE_INTERNAL_ERROR = 'internal error'

const CODE_USAGE_API_ERROR = 'usage_api_error'
const CODE_NOT_FOUND = 'not_found'

const METHOD_GET = 'GET'
const METHOD_POST = 'POST'
const QUERY_SEPARATOR = /[?#]/
const EMPTY_BUCKET = ''

// D 端点按同窗口 H 行折叠费用:H 桶串字典序大于日键,读 H 行时上界补足当日末小时
const HOUR_LABEL_WIDTH = 2
const LAST_HOUR_OF_DAY = `T${String(HOURS_PER_DAY - 1).padStart(HOUR_LABEL_WIDTH, '0')}`

// 定价规则 wire 契约:kind 判别取 pricing 模块常量,单一来源;未知键由 zod 剥离
const WEEKDAY_MIN = 0
const WEEKDAY_MAX = 6

const CONDITION_FIELD_SCHEMAS = {
  dailyWindow: { from: z.string(), to: z.string() },
  weekdays: { days: z.array(z.number().int().min(WEEKDAY_MIN).max(WEEKDAY_MAX)) },
  monthDays: { from: z.number().int(), to: z.number().int() },
  dateRange: { from: z.string(), to: z.string() },
}

const conditionSchema = z.union(
  CONDITION_KINDS.map((kind) => z.object({ kind: z.literal(kind), ...CONDITION_FIELD_SCHEMAS[kind] })),
)

const pricingRuleShape = z.object({
  // 模型键强制两段式 vendor/model(段可通配),单段旧形态提交即拒
  model: z.string().refine(isTwoSegmentModel),
  unit: z.literal(UNIT_PER_MILLION).optional(),
  currency: z.enum(CURRENCIES).nullable(),
  price: z.object({
    input: z.number().min(0),
    output: z.number().min(0),
    cacheRead: z.number().min(0),
    cacheWrite: z.number().min(0),
  }),
  conditions: z.array(conditionSchema),
})

const pricingRulesSchema = z.array(pricingRuleShape).refine(
  // 表级单币约束(F15):定价聚合按数值直接相加,混币相加无意义;
  // 非空币种全表必须同一种(null 视为未指定,不参与币种一致对账)
  (rules) => new Set(rules.map((rule) => rule.currency).filter((c) => c !== null)).size <= 1,
  { message: '定价表必须单币种:非空 currency 全表一致' },
)

// 四个开关全量提交:缺键即视为非法,避免半套开关被当成"其余关闭"静默落盘
const featuresSchema = z.object(
  Object.fromEntries(FEATURE_KEYS.map((key) => [key, z.boolean()])),
).strict()

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

// 同源与 content-type 由共享 withRouteGate 负责(大小写不敏感、媒体类型精确比较),
// 本文件只保留各端点的方法策略:标准端点 POST-only,pricing GET 读 POST 写
function rejectWrongMethod(req) {
  if ((req.method ?? METHOD_GET) !== METHOD_POST) {
    throw usageError(HTTP_STATUS_METHOD_NOT_ALLOWED, MESSAGE_METHOD_NOT_ALLOWED)
  }
}

// 读写端点放宽:GET 读 POST 写均放行,其余方法照拒
function rejectWritableMethod(req) {
  const method = req.method ?? METHOD_GET
  if (method !== METHOD_GET && method !== METHOD_POST) {
    throw usageError(HTTP_STATUS_METHOD_NOT_ALLOWED, MESSAGE_METHOD_NOT_ALLOWED)
  }
}

// 只读端点(摘要、哨兵、沙盘):参数在查询串,GET-only
function rejectReadMethod(req) {
  if ((req.method ?? METHOD_GET) !== METHOD_GET) {
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
const utcStampOf = (parts) => Date.UTC(parts[0], parts[1] - 1, parts[2], parts[3] ?? 0, parts[4] ?? 0)

// 桶键数上界:按步长算术求键数,不枚举桶串;超限在聚合前拒绝
function requireSlotCount(fromParts, toParts, stepMs, maxSlots, maxDays) {
  const slots = (utcStampOf(toParts) - utcStampOf(fromParts)) / stepMs + 1
  if (slots > maxSlots) {
    throw usageError(HTTP_STATUS_BAD_REQUEST, `${ERROR_PREFIX}span exceeds ${maxDays} days`)
  }
}

// 会话索引窗口策略:天/小时视图按同粒度行取并集;分钟视图没有会话行,
// 把窗口截到覆盖小时按小时行近似(边界最多外扩一小时)
const HOUR_KEY_WIDTH = 'YYYY-MM-DDTHH'.length
const SESSION_WINDOW_QUERIES = {
  [GRANULARITY_DAILY]: (store, from, to) => store.sessionRangeRows(GRANULARITY_DAILY, from, to),
  [GRANULARITY_HOURLY]: (store, from, to) => store.sessionRangeRows(GRANULARITY_HOURLY, from, to),
  [GRANULARITY_MINUTE]: (store, from, to) =>
    store.sessionRangeRows(GRANULARITY_HOURLY, from.slice(0, HOUR_KEY_WIDTH), to.slice(0, HOUR_KEY_WIDTH)),
}

// 聚合 + 定价注入:pricing 激活才挂 cost/unpriced,缺省响应形状与现状一致;
// D 端点费用优先按同窗口 H 行折叠,H 行已过保留期的历史日回落到日桶行计价
async function aggregateWithPricing(deps, granularity, from, to) {
  const sessionRows = await SESSION_WINDOW_QUERIES[granularity](deps.store, from, to)
  const rows = await deps.store.rangeRows(granularity, from, to)
  let value = aggregateRange(rows, granularity, from, to, sessionRows)
  const pricing = deps.pricing
  if (pricing?.active) {
    const costRows = granularity === GRANULARITY_DAILY
      ? await deps.store.rangeRows(GRANULARITY_HOURLY, from, `${to}${LAST_HOUR_OF_DAY}`)
      : rows
    const fallbackRows = granularity === GRANULARITY_DAILY ? rows : []
    value = attachCosts(value, costRows, granularity, pricing.rules(), fallbackRows)
  }
  return value
}

async function respondAggregate(deps, res, granularity, from, to) {
  const value = await aggregateWithPricing(deps, granularity, from, to)
  // 聚合响应对齐的宿主日历随值下发,客户端可据此校正范围时区
  writeJson(res, { ok: true, value: { ...value, timeZone: deps.timeZone } })
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
  const { from, to, fromParts, toParts } = requireBucketRange(await readJsonBody(req), HOUR_KEY_PARTS, 'hour key')
  requireSlotCount(fromParts, toParts, MS_PER_HOUR, MAX_HOUR_SLOTS, MAX_HOUR_SPAN_DAYS)
  await respondAggregate(deps, res, GRANULARITY_HOURLY, from, to)
}

// 分钟保留窗口(天)换算为起点桶串:起点晚于请求 from 即窗口外已清理,
// 标注实际可用范围;禁用(0)时恒无数据,covered 标注空串。
// retentionDays 经 clamp 归一(非法回落默认,超上限截断),与 store.pruneMinutes 同源
const minuteHandler = (deps) => async (req, res) => {
  const { from, to, fromParts, toParts } = requireBucketRange(await readJsonBody(req), MINUTE_KEY_PARTS, 'minute key')
  if (fromParts[fromParts.length - 1] % MINUTE_BUCKET_SPAN_MINUTES !== 0) {
    throw usageError(HTTP_STATUS_BAD_REQUEST, `${ERROR_PREFIX}minute key must align to ${MINUTE_BUCKET_SPAN_MINUTES} minutes`)
  }
  requireSlotCount(fromParts, toParts, MS_PER_MINUTE * MINUTE_BUCKET_SPAN_MINUTES, MAX_MINUTE_SLOTS, MAX_MINUTE_SPAN_DAYS)
  const value = await aggregateWithPricing(deps, GRANULARITY_MINUTE, from, to)
  const retention = clampMinuteRetentionDays(deps.retentionDays())
  if (retention > 0) {
    const windowStart = minuteKey(deps.now() - retention * MS_PER_DAY)
    if (windowStart > from) Object.assign(value, { coveredFrom: windowStart, coveredTo: to })
  } else {
    Object.assign(value, { coveredFrom: EMPTY_BUCKET, coveredTo: EMPTY_BUCKET })
  }
  writeJson(res, { ok: true, value: { ...value, timeZone: deps.timeZone } })
}

// pricing 端点:GET 回 {revision, rules};POST 整表替换经 zod 校验后写入并回读。
// settings 未激活时能力缺席,GET 走空值桩,POST 拒 503——能力缺席属服务暂
// 不可用而非请求状态冲突,不用 409
const INACTIVE_PRICING = { active: false, rules: () => [], revision: () => 0 }

const pricingHandler = (deps) => async (req, res) => {
  const pricing = deps.pricing ?? INACTIVE_PRICING
  if ((req.method ?? METHOD_GET) === METHOD_GET) {
    writeJson(res, { ok: true, value: { revision: pricing.revision(), rules: pricing.rules() } })
    return
  }
  if (!pricing.active) throw usageError(HTTP_STATUS_UNAVAILABLE, MESSAGE_PRICING_UNAVAILABLE)
  const parsed = pricingRulesSchema.safeParse((await readJsonBody(req))?.rules)
  if (!parsed.success) throw usageError(HTTP_STATUS_BAD_REQUEST, MESSAGE_INVALID_PRICING)
  const rules = await pricing.replace(parsed.data)
  writeJson(res, { ok: true, value: { revision: pricing.revision(), rules } })
}

const statusHandler = (deps) => async (req, res) => {
  writeJson(res, {
    ok: true,
    value: {
      ...deps.collector.status(),
      backup: deps.store.backupInfo(),
      // 桶键按宿主本地日历聚合;面板必须用同一 IANA 时区生成 from/to,
      // 否则宿主 UTC、浏览器 +8 时日/小时/热力图日界整体平移
      timeZone: deps.timeZone,
    },
  })
}

// 扫描冲突谓词:409 只拒 boot 期扫描;reset 自身引发的重扫同样 running 为真,
// 经 rebuilding 放行。reset 与 restore 互斥动作共用同一谓词,避免守卫口径漂移
const scanConflicts = (collector) => collector.running && !collector.rebuilding

const resetHandler = (deps) => async (req, res) => {
  if (scanConflicts(deps.collector)) {
    throw usageError(HTTP_STATUS_CONFLICT, MESSAGE_BACKFILL_RUNNING)
  }
  await deps.collector.resetAndRescan()
  writeJson(res, { ok: true, value: deps.collector.status() })
}

// 回退到最近一次重建(或恢复)前的快照;扫描冲突判定与 reset 同源。
// 无快照时回退会把全表与游标清空(等于静默清库),先按 backupInfo 拒绝
const restoreHandler = (deps) => async (req, res) => {
  if (scanConflicts(deps.collector)) {
    throw usageError(HTTP_STATUS_CONFLICT, MESSAGE_BACKFILL_RUNNING)
  }
  if (deps.store.backupInfo().available !== true) {
    throw usageError(HTTP_STATUS_CONFLICT, MESSAGE_BACKUP_UNAVAILABLE)
  }
  const result = await deps.store.restoreFromBackup()
  writeJson(res, { ok: true, value: result })
}

const STANDARD_GUARDS = [rejectWrongMethod]
const WRITABLE_GUARDS = [rejectWritableMethod]
const READ_GUARDS = [rejectReadMethod]

// —— 成本控制端点:摘要、预算(读 + 写)、异常哨兵、省钱沙盘 ——
const DEFAULT_WHATIF_DAYS = 30

const clampRangeDays = (value) =>
  Number.isFinite(value) && value >= 1 ? Math.min(Math.floor(value), MAX_RANGE_SPAN_DAYS) : DEFAULT_WHATIF_DAYS

const INACTIVE_BUDGET = {
  active: false,
  config: () => null,
  replace: async () => {
    throw usageError(HTTP_STATUS_UNAVAILABLE, MESSAGE_BUDGET_UNAVAILABLE)
  },
}

const INACTIVE_FEATURES = {
  active: false,
  current: () => normalizeFeatures({}),
  replace: async () => {
    throw usageError(HTTP_STATUS_UNAVAILABLE, MESSAGE_FEATURES_UNAVAILABLE)
  },
}

const INACTIVE_CYCLE = {
  active: false,
  config: () => ({ ...CYCLE_DEFAULT }),
  replace: async () => {
    throw usageError(HTTP_STATUS_UNAVAILABLE, MESSAGE_CYCLE_UNAVAILABLE)
  },
}

const summaryHandler = (deps) => async (req, res) => {
  writeJson(res, { ok: true, value: await buildSummary(deps) })
}

// 沙盘输入取天桶聚合结果(含各模型四桶拆分),按当前规则重算,不做写操作
const whatifHandler = (deps) => async (req, res) => {
  const params = new URL(req.url ?? '', 'http://localhost').searchParams
  const days = clampRangeDays(Number(params.get('days')))
  const nowMs = deps.now()
  const to = dayKey(nowMs, deps.timeZone)
  const from = dayKey(nowMs - (days - 1) * MS_PER_DAY, deps.timeZone)
  const value = await aggregateWithPricing(deps, GRANULARITY_DAILY, from, to)
  // 聚合不产出币种:费用显示口径取规则表首个非空币种,与面板一致
  const rules = deps.pricing?.rules?.() ?? []
  const outcome = simulateWhatIf({
    models: value.models ?? [],
    rules,
    currency: deps.pricing?.active ? (rules.find((rule) => rule.currency)?.currency ?? null) : null,
    now: deps.now(),
    options: {
      targetModel: params.get('targetModel') ?? '',
      targetHitRate: Number(params.get('targetHitRate')),
      shiftRatio: Number(params.get('shiftRatio')),
    },
  })
  writeJson(res, { ok: true, value: { ...outcome, from, to } })
}

// 四模块开关:GET 回当前开关与可用性,POST 整体替换(客户端提交全量四键)
const featuresHandler = (deps) => async (req, res) => {
  const features = deps.features ?? INACTIVE_FEATURES
  if ((req.method ?? METHOD_GET) === METHOD_GET) {
    writeJson(res, { ok: true, value: { active: features.active === true, features: features.current?.() ?? null } })
    return
  }
  if (features.active !== true) throw usageError(HTTP_STATUS_UNAVAILABLE, MESSAGE_FEATURES_UNAVAILABLE)
  const parsed = featuresSchema.safeParse((await readJsonBody(req))?.features)
  if (!parsed.success) throw usageError(HTTP_STATUS_BAD_REQUEST, MESSAGE_INVALID_FEATURES)
  const beforeSentinel = features.current?.()?.sentinel === true
  const saved = await features.replace(parsed.data)
  // 重算条件取并集:请求意图变了(充分条件,不依赖回读时序)或结论与实际开关不一致(兜住交错写入)。
  // 只有两者都不需要时才是稳态,改 whatif 不该顺手查一遍日/小时/分钟桶
  const want = features.current?.()?.sentinel === true
  if (beforeSentinel !== (parsed.data.sentinel === true) || (deps.sentinel?.status?.()?.config?.enabled === true) !== want) {
    await deps.sentinel?.refresh?.()
  }
  writeJson(res, { ok: true, value: { active: features.active === true, features: saved } })
}

const budgetHandler = (deps) => async (req, res) => {
  const budget = deps.budget ?? INACTIVE_BUDGET
  if ((req.method ?? METHOD_GET) === METHOD_GET) {
    writeJson(res, {
      ok: true,
      value: {
        active: budget.active === true,
        config: budget.config(),
        status: await buildBudgetStatus(deps),
        // 熔断态来自进程内拦截器,不落存储:读数缓存与阻断时刻只有 Guard 知道
        guard: deps.guard?.() ?? null,
      },
    })
    return
  }
  if (budget.active !== true) throw usageError(HTTP_STATUS_UNAVAILABLE, MESSAGE_BUDGET_UNAVAILABLE)
  const body = await readJsonBody(req)
  // 缺 budget 键时不能当成「清空」:会把整节预算重置成默认值
  if (body === null || typeof body !== 'object' || !('budget' in body)) {
    throw usageError(HTTP_STATUS_BAD_REQUEST, MESSAGE_INVALID_BUDGET)
  }
  // budget 为 null 表示清空,其余非对象或数组一律拒绝
  if (body.budget !== null && (typeof body.budget !== 'object' || Array.isArray(body.budget))) {
    throw usageError(HTTP_STATUS_BAD_REQUEST, MESSAGE_INVALID_BUDGET)
  }
  const config = await budget.replace(body.budget)
  writeJson(res, { ok: true, value: { config } })
}

const sentinelHandler = (deps) => async (req, res) => {
  writeJson(res, { ok: true, value: deps.sentinel?.status?.() ?? { events: [], baseline: null } })
}

const sentinelAckHandler = (deps) => async (req, res) => {
  const ids = (await readJsonBody(req))?.ids ?? []
  writeJson(res, { ok: true, value: deps.sentinel?.ack?.(ids) ?? { acked: 0 } })
}

// 计费周期:GET 回当前窗口与配置,POST 整体替换(套餐口径由用户填)
const cycleHandler = (deps) => async (req, res) => {
  const cycle = deps.cycle ?? INACTIVE_CYCLE
  if ((req.method ?? METHOD_GET) === METHOD_GET) {
    const config = cycle.config()
    const nowMs = deps.now()
    writeJson(res, {
      ok: true,
      value: { active: cycle.active === true, config, window: cycleWindowOf(config, nowMs, deps.timeZone) },
    })
    return
  }
  if (cycle.active !== true) throw usageError(HTTP_STATUS_UNAVAILABLE, MESSAGE_CYCLE_UNAVAILABLE)
  const body = await readJsonBody(req)
  // 缺 cycle 键时不能当成「重置」:会把用户填的套餐口径清掉
  if (body === null || typeof body !== 'object' || !('cycle' in body)) {
    throw usageError(HTTP_STATUS_BAD_REQUEST, MESSAGE_INVALID_CYCLE)
  }
  if (body.cycle !== null && (typeof body.cycle !== 'object' || Array.isArray(body.cycle))) {
    throw usageError(HTTP_STATUS_BAD_REQUEST, MESSAGE_INVALID_CYCLE)
  }
  const config = await cycle.replace(body.cycle)
  writeJson(res, { ok: true, value: { config, window: cycleWindowOf(config, deps.now(), deps.timeZone) } })
}

const COST_ENDPOINTS = [
  { path: `${ROUTE_PREFIX}/summary`, mount: summaryHandler, guards: READ_GUARDS },
  { path: `${ROUTE_PREFIX}/budget`, mount: budgetHandler, guards: WRITABLE_GUARDS },
  { path: `${ROUTE_PREFIX}/cycle`, mount: cycleHandler, guards: WRITABLE_GUARDS },
  { path: `${ROUTE_PREFIX}/sentinel`, mount: sentinelHandler, guards: READ_GUARDS },
  { path: `${ROUTE_PREFIX}/sentinel/ack`, mount: sentinelAckHandler },
  { path: `${ROUTE_PREFIX}/whatif`, mount: whatifHandler, guards: READ_GUARDS },
  { path: `${ROUTE_PREFIX}/features`, mount: featuresHandler, guards: WRITABLE_GUARDS },
]

const ENDPOINTS = [
  { path: `${ROUTE_PREFIX}/range`, mount: rangeHandler },
  { path: `${ROUTE_PREFIX}/hours`, mount: hoursHandler },
  { path: `${ROUTE_PREFIX}/minutes`, mount: minuteHandler },
  { path: `${ROUTE_PREFIX}/status`, mount: statusHandler },
  { path: `${ROUTE_PREFIX}/reset`, mount: resetHandler },
  { path: `${ROUTE_PREFIX}/restore`, mount: restoreHandler },
  { path: `${ROUTE_PREFIX}/pricing`, mount: pricingHandler, guards: WRITABLE_GUARDS },
  ...COST_ENDPOINTS,
]

const routePathOf = (req) => (req.url ?? '').split(QUERY_SEPARATOR, 1)[0]

export const HOST_TIME_ZONE = Intl.DateTimeFormat().resolvedOptions().timeZone

export function registerUsageRoutes(
  ctx,
  { store, collector, retentionDays, now = Date.now, pricing, budget, cycle, sentinel, features, guard, timeZone = HOST_TIME_ZONE },
) {
  const deps = {
    store, collector, retentionDays, now, pricing, budget, cycle, sentinel, features, guard, timeZone,
    // 摘要与预算只需要配置只读面,门面对象留给 /cycle 自己用(isActive/replace)
    cycleConfig: () => cycle?.config?.() ?? CYCLE_DEFAULT,
  }
  const handlers = new Map(ENDPOINTS.map((endpoint) => [endpoint.path, {
    handler: endpoint.mount(deps),
    guards: endpoint.guards ?? STANDARD_GUARDS,
  }]))
  // exact 注册下宿主只会命中自有路径,此处仍按路径精确等值分派,未匹配即 404
  const dispatch = async (req, res) => {
    try {
      // 定价域在 apply 之后才打开完成:首请求先等就绪,免把已配规则当未定价
      await pricing?.ready?.()
      const path = routePathOf(req)
      const matched = handlers.get(path)
      if (!matched) throw usageError(HTTP_STATUS_NOT_FOUND, `unknown endpoint ${path}`, CODE_NOT_FOUND)
      for (const guard of matched.guards) guard(req)
      await matched.handler(req, res)
    } catch (err) {
      writeError(ctx, res, err)
    }
  }
  const disposers = ENDPOINTS.map(({ path }) =>
    ctx.effect(
      () => ctx.webServer.register({ kind: 'exact', path, handler: withRouteGate(ctx, dispatch) }),
      `usage-dash: route ${path}`,
    ))
  return () => disposers.forEach((dispose) => dispose?.())
}
