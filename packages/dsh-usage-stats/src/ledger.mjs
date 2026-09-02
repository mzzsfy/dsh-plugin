// 用量统计纯账本模块:调用记录聚合到日/会话,汇总与修剪;模型计价表。
// 只做数据变换,无 IO;host 半区直接 import 本模块。

const LEDGER_VERSION = 2
const TOKENS_PER_UNIT = 1000000

function dayKeyOf(ts) {
  const d = new Date(ts)
  const pad = (n) => (n < 10 ? '0' + n : String(n))
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate())
}

function createLedger() {
  return { version: LEDGER_VERSION, days: {}, sessions: {} }
}

// v1 旧账本无顶层 sessions 索引:载入时视为空并按新结构增量写入,不回填历史;结构升级后版本号置位。
function ensureSessionsIndex(ledger) {
  if (!ledger.sessions || typeof ledger.sessions !== 'object') ledger.sessions = {}
  ledger.version = LEDGER_VERSION
  return ledger
}

function ensureBucket(days, key) {
  if (!days[key]) {
    days[key] = { inputTokens: 0, cacheReadTokens: 0, outputTokens: 0, calls: 0, cost: 0, sessions: {} }
  }
  return days[key]
}

function ensureSession(day, sessionId) {
  const id = sessionId || 'unknown'
  if (!day.sessions[id]) {
    day.sessions[id] = { inputTokens: 0, cacheReadTokens: 0, outputTokens: 0, calls: 0, cost: 0, models: {} }
  }
  return day.sessions[id]
}

function addTokens(target, call) {
  if (Number.isFinite(call.inputTokens)) target.inputTokens += call.inputTokens
  if (Number.isFinite(call.cacheReadTokens)) target.cacheReadTokens += call.cacheReadTokens
  if (Number.isFinite(call.outputTokens)) target.outputTokens += call.outputTokens
}

// 记录一次模型调用;costUsd 为 null 时只计 token 不计金额。
function recordCall(ledger, call, costUsd) {
  ensureSessionsIndex(ledger)
  const day = ensureBucket(ledger.days, dayKeyOf(call.at))
  const session = ensureSession(day, call.sessionId)
  day.calls += 1
  addTokens(day, call)
  if (costUsd !== null && Number.isFinite(costUsd)) day.cost += costUsd
  session.calls += 1
  addTokens(session, call)
  if (costUsd !== null && Number.isFinite(costUsd)) session.cost += costUsd
  const modelName = call.model || 'unknown'
  if (!session.models[modelName]) session.models[modelName] = { calls: 0, inputTokens: 0, cacheReadTokens: 0, outputTokens: 0 }
  session.models[modelName].calls += 1
  addTokens(session.models[modelName], call)
  const id = call.sessionId || 'unknown'
  // 顶层会话索引:跨日合并,与按日聚合并存
  const at = Number.isFinite(call.at) ? call.at : 0
  if (!ledger.sessions[id]) {
    ledger.sessions[id] = { firstAt: at, lastAt: at, calls: 0, inputTokens: 0, cacheReadTokens: 0, outputTokens: 0, cost: 0 }
  }
  const indexed = ledger.sessions[id]
  indexed.firstAt = Math.min(indexed.firstAt, at)
  indexed.lastAt = Math.max(indexed.lastAt, at)
  indexed.calls += 1
  addTokens(indexed, call)
  if (costUsd !== null && Number.isFinite(costUsd)) indexed.cost += costUsd
}

// 顶层索引读数;索引缺失(v1 旧数据)返回 null。
function sessionTotals(ledger, sessionId) {
  const row = ledger.sessions ? ledger.sessions[sessionId] : undefined
  return row || null
}

function addTotals(target, source) {
  target.inputTokens += source.inputTokens
  target.cacheReadTokens += source.cacheReadTokens
  target.outputTokens += source.outputTokens
  target.calls += source.calls
  target.cost += source.cost
}

// todayKey 由调用方传入(宿主本地时区),保持纯函数可测。
function summarize(ledger, todayKey, recentCount) {
  const empty = { inputTokens: 0, cacheReadTokens: 0, outputTokens: 0, calls: 0, cost: 0 }
  const summary = {
    today: { ...empty },
    month: { ...empty },
    total: { ...empty },
    recentDays: [],
    todaySessions: [],
  }
  const monthPrefix = todayKey.slice(0, 7)
  const dayKeys = Object.keys(ledger.days).sort()
  for (const key of dayKeys) {
    const day = ledger.days[key]
    addTotals(summary.total, day)
    if (key === todayKey) {
      addTotals(summary.today, day)
      summary.todaySessions = Object.keys(day.sessions).map((sessionId) => ({
        sessionId,
        ...day.sessions[sessionId],
      }))
    }
    if (key.indexOf(monthPrefix) === 0) addTotals(summary.month, day)
  }
  summary.recentDays = dayKeys.slice(-recentCount).reverse().map((key) => ({
    date: key,
    ...ledger.days[key],
  }))
  return summary
}

function pruneLedger(ledger, todayKey, keepDays) {
  const keys = Object.keys(ledger.days).sort()
  const cutoff = new Date(todayKey + 'T00:00:00')
  cutoff.setDate(cutoff.getDate() - (keepDays - 1))
  const cutoffKey = dayKeyOf(cutoff.getTime())
  for (const key of keys) {
    if (key < cutoffKey) delete ledger.days[key]
  }
  // 顶层会话索引按 lastAt 同步修剪,不无限增长
  ensureSessionsIndex(ledger)
  for (const id of Object.keys(ledger.sessions)) {
    if (ledger.sessions[id].lastAt < cutoff.getTime()) delete ledger.sessions[id]
  }
}

// 单价:USD / 百万 token;价格表缺失或全空返回 null(不估金额)。
function costOfCall(call, price) {
  if (!price) return null
  const hasAny = Number.isFinite(call.inputTokens) || Number.isFinite(call.outputTokens) || Number.isFinite(call.cacheReadTokens)
  if (!hasAny) return null
  let cost = 0
  if (Number.isFinite(call.inputTokens) && Number.isFinite(price.input)) {
    cost += (call.inputTokens / TOKENS_PER_UNIT) * price.input
  }
  if (Number.isFinite(call.outputTokens) && Number.isFinite(price.output)) {
    cost += (call.outputTokens / TOKENS_PER_UNIT) * price.output
  }
  if (Number.isFinite(call.cacheReadTokens) && Number.isFinite(price.cacheRead)) {
    cost += (call.cacheReadTokens / TOKENS_PER_UNIT) * price.cacheRead
  }
  return cost
}

// models.dev api.json -> [{key, input, output, cacheRead}];key 同时含 provider/model 与裸模型名。
function flattenPricing(raw) {
  const table = []
  if (!raw || typeof raw !== 'object') return table
  for (const providerId of Object.keys(raw)) {
    const provider = raw[providerId]
    if (!provider || typeof provider !== 'object' || !provider.models) continue
    for (const modelId of Object.keys(provider.models)) {
      const model = provider.models[modelId]
      const cost = model && typeof model === 'object' ? model.cost : null
      if (!cost || typeof cost !== 'object') continue
      if (!Number.isFinite(Number(cost.input)) && !Number.isFinite(Number(cost.output))) continue
      const entry = {
        keys: [providerId + '/' + modelId.toLowerCase(), modelId.toLowerCase()],
        input: Number(cost.input),
        output: Number(cost.output),
        cacheRead: Number.isFinite(Number(cost.cache_read)) ? Number(cost.cache_read) : null,
      }
      table.push(entry)
    }
  }
  return table
}

// 匹配顺序:provider/model 精确 -> 任意条目 key 精确 -> 模型名前缀(最长优先)。
function priceFor(table, provider, model) {
  if (!model) return null
  const modelLower = String(model).toLowerCase()
  const full = (provider || '') + '/' + modelLower
  for (const entry of table) {
    if (entry.keys[0] === full) return entry
  }
  for (const entry of table) {
    if (entry.keys.indexOf(modelLower) >= 0) return entry
  }
  let best = null
  for (const entry of table) {
    for (const key of entry.keys) {
      const suffix = key.indexOf('/') >= 0 ? key.slice(key.indexOf('/') + 1) : key
      if (modelLower.indexOf(suffix) === 0 && (best === null || suffix.length > best.suffixLen)) {
        best = { entry, suffixLen: suffix.length }
      }
    }
  }
  return best ? best.entry : null
}

// models.dev 拉取失败时的兜底单价,USD / 百万 token(对齐 dsh-balance 内置表)。
const FALLBACK_PRICING = [
  { keys: ['deepseek/deepseek-chat', 'deepseek-chat'], input: 0.14, output: 0.28, cacheRead: 0.0028 },
  { keys: ['deepseek/deepseek-reasoner', 'deepseek-reasoner'], input: 0.14, output: 0.28, cacheRead: 0.0028 },
]

export {
  createLedger,
  dayKeyOf,
  recordCall,
  summarize,
  pruneLedger,
  ensureSessionsIndex,
  sessionTotals,
  costOfCall,
  flattenPricing,
  priceFor,
  FALLBACK_PRICING,
}
