// 用量面板纯解析层:各平台响应体 -> 归一化读数。
// 只做数据变换,无 IO;host 半区直接 import 本模块。

const QUOTA_PER_USD = 500000
const PERCENT_BASE = 100

function toStrictNumber(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : NaN
  if (typeof value === 'string') {
    const text = value.trim()
    if (text.length > 0 && /^[+-]?(\d+(\.\d+)?|\.\d+)([eE][+-]?\d+)?$/.test(text)) return Number(text)
    return NaN
  }
  return NaN
}

// 只读自有属性,阻断 __proto__/constructor 原型链逃逸。
function getPath(root, path) {
  if (typeof path !== 'string' || path.length === 0) return undefined
  let current = root
  for (const segment of path.split('.')) {
    if (current === null || current === undefined || typeof current !== 'object') return undefined
    if (!Object.hasOwn(current, segment)) return undefined
    current = current[segment]
  }
  return current
}

function extractByRule(data, rule) {
  if (rule === null || rule === undefined) return null
  if (typeof rule === 'number' && Number.isFinite(rule)) return rule
  if (typeof rule === 'string') {
    const value = getPath(data, rule)
    const num = toStrictNumber(value)
    if (Number.isFinite(num)) return num
    return typeof value === 'string' ? value : null
  }
  if (typeof rule === 'object' && !Array.isArray(rule)) {
    if (rule.op === 'subtract' && Array.isArray(rule.paths)) {
      if (rule.paths.length === 0) return null
      const values = rule.paths.map((path) => toStrictNumber(getPath(data, path)))
      if (!values.every(Number.isFinite)) return null
      return values.reduce((acc, value) => acc - value)
    }
    if (rule.op === 'add' && Array.isArray(rule.paths)) {
      const values = rule.paths.map((path) => toStrictNumber(getPath(data, path)))
      if (!values.every(Number.isFinite)) return null
      return values.reduce((acc, value) => acc + value, 0)
    }
    if (rule.op === 'divide' && typeof rule.path === 'string') {
      const value = toStrictNumber(getPath(data, rule.path))
      const by = toStrictNumber(rule.by)
      if (!Number.isFinite(value) || !Number.isFinite(by) || by === 0) return null
      return value / by
    }
    if (typeof rule.path === 'string') return extractByRule(data, rule.path)
  }
  return null
}

function requireOk(condition, message) {
  if (!condition) throw new Error(message)
}

// limit/remaining 三元组 -> 已用百分比口径(对齐 cc-switch)。
function makeTier(limitRaw, remainingRaw, resetsAt) {
  const limit = toStrictNumber(limitRaw)
  const remaining = toStrictNumber(remainingRaw)
  const used = Number.isFinite(limit) && Number.isFinite(remaining) ? Math.max(limit - remaining, 0) : null
  const utilization =
    Number.isFinite(limit) && limit > 0 && used !== null ? (used / limit) * PERCENT_BASE : null
  return { limit, remaining, used, utilization, resetsAt: typeof resetsAt === 'string' ? resetsAt : null }
}

function balanceEntry(currency, total, isAvailable, info) {
  const numOrNull = (value) => {
    const parsed = toStrictNumber(value)
    return Number.isFinite(parsed) ? parsed : null
  }
  return {
    currency,
    total,
    granted: numOrNull(info && info.granted_balance),
    toppedUp: numOrNull(info && info.topped_up_balance),
    isAvailable,
  }
}

function parseDeepSeek(body) {
  const error = body && body.error
  if (error) {
    throw new Error(String((error && error.message) || (error && error.type) || '接口返回错误'))
  }
  const infos = body && Array.isArray(body.balance_infos) ? body.balance_infos : null
  requireOk(infos !== null, '响应缺少 balance_infos 字段')
  const isAvailable = body.is_available !== false
  return {
    kind: 'balance',
    entries: infos.map((info) =>
      balanceEntry(String((info && info.currency) || 'CNY'), toStrictNumber(info && info.total_balance), isAvailable, info),
    ),
  }
}

function parseOpenRouter(body) {
  const data = body && body.data
  requireOk(data !== null && typeof data === 'object', '响应缺少 data 字段')
  const total = toStrictNumber(data.total_credits)
  const used = toStrictNumber(data.total_usage)
  requireOk(Number.isFinite(total) || Number.isFinite(used), '响应缺少 total_credits/total_usage 字段')
  return {
    kind: 'balance',
    entries: [
      {
        currency: 'USD',
        total: Number.isFinite(total) ? total : null,
        used: Number.isFinite(used) ? used : null,
        remaining:
          Number.isFinite(total) && Number.isFinite(used) ? Math.max(total - used, 0) : null,
      },
    ],
  }
}

function parseKimi(body) {
  const firstLimit = body && Array.isArray(body.limits) && body.limits.length ? body.limits[0] : null
  const detail = firstLimit && firstLimit.detail ? firstLimit.detail : null
  const usage = body && body.usage ? body.usage : null
  requireOk(detail !== null || usage !== null, '响应缺少 usage/limits 字段')
  const windows = []
  if (detail) windows.push({ label: '5小时', ...makeTier(detail.limit, detail.remaining, detail.resetTime) })
  if (usage) windows.push({ label: '7天', ...makeTier(usage.limit, usage.remaining, usage.resetTime) })
  const level = body && body.user && body.user.membership && body.user.membership.level
  return { kind: 'quota', windows, membership: typeof level === 'string' ? level : null }
}

// unit=3 -> 5小时窗,unit=6 -> 7天窗;未分类按重置时间升序回填空缺槽位。
// TOKENS_LIMIT(token 窗口)与 CREDIT_LIMIT(Credit 计费窗口,Pro/Lite 套餐)语义一致,一并接受。
function parseZhipu(body) {
  if (body && body.success === false) {
    throw new Error(String((body && body.msg) || '接口返回错误'))
  }
  const limits = body && body.data && Array.isArray(body.data.limits) ? body.data.limits : null
  requireOk(limits !== null, '响应缺少 data.limits 字段')
  const unclassified = []
  let fiveHour = null
  let weekly = null
  let prompts = null
  const seenTypes = []
  for (const item of limits) {
    if (!item || typeof item !== 'object') continue
    if (seenTypes.indexOf(item.type) < 0) seenTypes.push(String(item.type))
    const type = typeof item.type === 'string' ? item.type.toLowerCase() : ''
    if (type === 'time_limit') {
      // 工具用量窗口:currentValue/remaining 为调用次数,usageDetails 为按工具的次数明细
      if (prompts === null) {
        const details = Array.isArray(item.usageDetails)
          ? item.usageDetails
              .filter((d) => d && typeof d.modelCode === 'string' && Number.isFinite(toStrictNumber(d.usage)))
              .map((d) => ({ model: d.modelCode, usage: toStrictNumber(d.usage) }))
          : []
        prompts = {
          label: '工具用量',
          utilization: zhipuPercent(item),
          remaining: orNull(toStrictNumber(item.remaining)),
          limit: orNull(toStrictNumber(item.usage)),
          resetsAt: Number.isFinite(toStrictNumber(item.nextResetTime))
            ? new Date(toStrictNumber(item.nextResetTime)).toISOString()
            : null,
          details,
        }
      }
      continue
    }
    if (type !== 'tokens_limit' && type !== 'credit_limit') continue
    const resetMs = toStrictNumber(item.nextResetTime)
    const entry = {
      label: '',
      utilization: zhipuPercent(item),
      remaining: orNull(toStrictNumber(item.remaining)),
      limit: orNull(toStrictNumber(item.usage)),
      resetsAt: Number.isFinite(resetMs) ? new Date(resetMs).toISOString() : null,
    }
    const unit = toStrictNumber(item.unit)
    if (unit === 3 && fiveHour === null) fiveHour = entry
    else if (unit === 6 && weekly === null) weekly = entry
    else unclassified.push(entry)
  }
  unclassified.sort((a, b) => {
    const at = a.resetsAt ? Date.parse(a.resetsAt) : Infinity
    const bt = b.resetsAt ? Date.parse(b.resetsAt) : Infinity
    return at - bt
  })
  for (const entry of unclassified) {
    if (fiveHour === null) fiveHour = entry
    else if (weekly === null) weekly = entry
  }
  requireOk(
    fiveHour !== null || weekly !== null,
    '响应缺少可解析的额度窗口,见到的类型: ' + (seenTypes.join(', ') || '无'),
  )
  const windows = []
  if (fiveHour !== null) windows.push({ ...fiveHour, label: '5小时' })
  if (weekly !== null) windows.push({ ...weekly, label: '7天' })
  if (prompts !== null) windows.push(prompts)
  const level = body && body.data && body.data.level
  return { kind: 'quota', windows, level: typeof level === 'string' ? level : null }
}

// 已用百分比:percentage 优先;缺失时 currentValue/usage 反推;均无效为 null。
function zhipuPercent(item) {
  const percentage = toStrictNumber(item.percentage)
  if (Number.isFinite(percentage)) return percentage
  const current = toStrictNumber(item.currentValue)
  const usage = toStrictNumber(item.usage)
  if (Number.isFinite(current) && Number.isFinite(usage) && usage > 0) {
    return (current / usage) * PERCENT_BASE
  }
  return null
}

function orNull(value) {
  return Number.isFinite(value) ? value : null
}

function parseMiniMax(body) {
  const baseResp = body && body.base_resp
  const statusCode = baseResp ? toStrictNumber(baseResp.status_code) : NaN
  if (baseResp && statusCode !== 0) {
    throw new Error(String(baseResp.status_msg || '接口返回错误'))
  }
  const remains = body && Array.isArray(body.model_remains) ? body.model_remains : []
  const item = remains.find((m) => m && m.model_name === 'general')
  requireOk(item !== undefined, '响应缺少 general 条目')
  const windows = []
  const intervalRemain = toStrictNumber(item.current_interval_remaining_percent)
  const endMs = toStrictNumber(item.end_time)
  if (Number.isFinite(intervalRemain)) {
    windows.push({
      label: '5小时',
      utilization: PERCENT_BASE - intervalRemain,
      resetsAt: Number.isFinite(endMs) ? new Date(endMs).toISOString() : null,
    })
  }
  if (toStrictNumber(item.current_weekly_status) === 1) {
    const weeklyRemain = toStrictNumber(item.current_weekly_remaining_percent)
    const weeklyEndMs = toStrictNumber(item.weekly_end_time)
    if (Number.isFinite(weeklyRemain)) {
      windows.push({
        label: '7天',
        utilization: PERCENT_BASE - weeklyRemain,
        resetsAt: Number.isFinite(weeklyEndMs) ? new Date(weeklyEndMs).toISOString() : null,
      })
    }
  }
  requireOk(windows.length > 0, '响应缺少用量窗口字段')
  return { kind: 'quota', windows }
}

function parseNewApi(body) {
  if (body && typeof body.message === 'string' && body.code !== 200) {
    throw new Error(body.message)
  }
  const data = body && body.data
  requireOk(data !== null && typeof data === 'object', '响应缺少 data 字段')
  if (data.unlimited_quota === true) {
    throw new Error('无限额度 token 无 total_available,无法读取剩余')
  }
  const total = toStrictNumber(data.total_granted)
  const used = toStrictNumber(data.total_used)
  const remaining = toStrictNumber(data.total_available)
  requireOk(
    Number.isFinite(total) || Number.isFinite(remaining),
    '响应缺少 total_granted/total_available 字段',
  )
  return {
    kind: 'balance',
    entries: [
      {
        currency: 'USD',
        total: Number.isFinite(total) ? total / QUOTA_PER_USD : null,
        used: Number.isFinite(used) ? used / QUOTA_PER_USD : null,
        remaining: Number.isFinite(remaining) ? remaining / QUOTA_PER_USD : null,
      },
    ],
  }
}

function extractCustom(data, extract) {
  const remaining = extractByRule(data, extract && extract.remaining)
  requireOk(remaining !== null && Number.isFinite(Number(remaining)), 'extract.remaining 缺失或非数值')
  const num = (value) => {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : null
  }
  const maxBudget = extract && extract.maxBudget !== undefined ? num(extractByRule(data, extract.maxBudget)) : null
  const spend = extract && extract.spend !== undefined ? num(extractByRule(data, extract.spend)) : null
  const unit =
    extract && typeof extract.unit === 'string' && extract.unit.length > 0 ? extract.unit : 'USD'
  return {
    currency: unit,
    remaining: Number(remaining),
    total: maxBudget,
    used: spend,
  }
}

export {
  toStrictNumber,
  getPath,
  extractByRule,
  parseDeepSeek,
  parseOpenRouter,
  parseKimi,
  parseZhipu,
  parseMiniMax,
  parseNewApi,
  extractCustom,
}
