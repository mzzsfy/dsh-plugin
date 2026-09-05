// 通知纯逻辑层:规则合并 / 沿触发评估 / 投影 / 认领 / 配置校验。
// 无 IO 与 npm 依赖,host 半区与单测共用;时间经参数注入。

export const DEFAULT_QUOTA_THRESHOLD_PCT = 90
export const PROJECTION_CAPACITY = 20
export const PROJECTION_TTL_MS = 60 * 1000
export const CLAIM_LOCK_TTL_MS = 30 * 1000
export const WEBHOOK_TIMEOUT_MS = 10 * 1000

export const KIND_QUOTA = 'quota'
export const KIND_BALANCE = 'balance'
export const KIND_RESET = 'reset'
// 全局通知默认值:默认关闭,余额阈值未配置即不评估。
export function defaultNotifySettings() {
  return {
    enabled: false,
    quotaThresholdPct: DEFAULT_QUOTA_THRESHOLD_PCT,
    balanceThreshold: null,
    resetNotice: true,
    toast: true,
    webhookUrl: '',
    imTargets: [],
  }
}

// 账号可覆盖的字段:通道与总开关全局统一,账号仅覆盖规则本体。
const ACCOUNT_OVERRIDE_KEYS = ['quotaThresholdPct', 'balanceThreshold', 'resetNotice']

// 字段级合并:账号 notify 仅覆盖其设置的键,其余继承全局。
export function mergeAccountOverride(globalSettings, accountNotify) {
  const source = accountNotify !== null && typeof accountNotify === 'object' ? accountNotify : {}
  const merged = {}
  for (const key of ACCOUNT_OVERRIDE_KEYS) merged[key] = globalSettings[key]
  for (const key of ACCOUNT_OVERRIDE_KEYS) {
    if (source[key] !== undefined) merged[key] = source[key]
  }
  return merged
}

// 账号沿触发状态:窗口按 label 建基线,余额默认武装;plain object 便于 JSON 持久化。
export function createNotifyState() {
  return { windows: {}, balanceArmed: true }
}

// 沿触发状态读侧归一:形态异常回新状态,窗口条目仅保留三字段防脏数据扩散。
export function normalizeNotifyState(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return createNotifyState()
  const state = createNotifyState()
  state.balanceArmed = raw.balanceArmed !== false
  const windows = typeof raw.windows === 'object' && raw.windows !== null && !Array.isArray(raw.windows) ? raw.windows : {}
  for (const label of Object.keys(windows)) {
    const entry = windows[label]
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) continue
    state.windows[label] = {
      resetsAt: typeof entry.resetsAt === 'string' ? entry.resetsAt : null,
      // peak=null 是"无峰值"语义,不得经 Number(null) 伪装成 0
      peak: entry.peak === null || entry.peak === undefined ? null : (Number.isFinite(Number(entry.peak)) ? Number(entry.peak) : null),
      armed: entry.armed !== false,
    }
  }
  return state
}

const PERCENT_BASE = 100

// 沿触发评估:刷新读数越过逻辑点(阈值穿越/窗口重置)时产出事件,返回新状态不改入参。
// 仅在 last.ok 时由 host 调用;reading 缺失按无读数处理。
export function evaluateAccount({ account, rule, state, seq, ts }) {
  const events = []
  const reading = account.last && account.last.reading ? account.last.reading : null
  const next = createNotifyState()
  next.balanceArmed = state.balanceArmed !== false
  if (reading === null) return { events, state: next }
  if (reading.kind === 'quota') evaluateQuota({ account, rule, state, reading, events, next })
  if (reading.kind === 'balance') evaluateBalance({ account, rule, state, reading, events, next })
  return { events: events.map((event, index) => buildNotifyEvent(event, seq + index, ts)), state: next }
}

// 窗口评估顺序:重置检测(重建基线并 re-arm)-> 峰值更新 -> 阈值判断。
// 基线以旧状态为底合并:上游偶发少返回某窗口时保留其基线,重现不误判新窗口。
function evaluateQuota({ account, rule, state, reading, events, next }) {
  next.windows = { ...state.windows }
  for (const window of reading.windows || []) {
    const label = String(window.label || '')
    if (label.length === 0) continue
    const utilization = Number(window.utilization)
    const resetsAt = typeof window.resetsAt === 'string' ? window.resetsAt : null
    const prev = state.windows[label] || null
    let armed = prev === null ? true : prev.armed !== false
    let peak = prev === null ? null : prev.peak
    // 窗口轮转:两侧 resetsAt 均有效且值不同;上一窗口峰值随 reset 事件上报
    if (prev !== null && resetsAt !== null && prev.resetsAt !== null && prev.resetsAt !== resetsAt) {
      if (rule.resetNotice !== false && prev.peak !== null) {
        events.push({
          kind: KIND_RESET,
          accountId: account.id,
          accountName: account.name,
          label,
          detail: { peak: prev.peak },
          text: '[dsh] ' + account.name + ' ' + label + '窗口已重置,上一窗口峰值用量 ' + Math.round(prev.peak) + '%',
        })
      }
      armed = true
      peak = null
    }
    if (Number.isFinite(utilization)) {
      peak = peak === null ? utilization : Math.max(peak, utilization)
      if (utilization >= rule.quotaThresholdPct && armed) {
        armed = false
        events.push({
          kind: KIND_QUOTA,
          accountId: account.id,
          accountName: account.name,
          label,
          detail: { value: utilization, threshold: rule.quotaThresholdPct },
          text: '[dsh] ' + account.name + ' ' + label + '窗口用量达 ' + Math.round(utilization) + '%(阈值 ' + rule.quotaThresholdPct + '%)',
        })
      }
    }
    next.windows[label] = { resetsAt, peak, armed }
  }
}

// 可用余额口径:remaining 优先,缺失(null/undefined 同视)回落 total
// (deepseek 无 remaining,total 即余额);null 不得经 Number() 伪装成 0。
function availableOf(entry) {
  const remaining = entry.remaining === null || entry.remaining === undefined ? NaN : Number(entry.remaining)
  if (Number.isFinite(remaining)) return remaining
  const total = entry.total === null || entry.total === undefined ? NaN : Number(entry.total)
  return Number.isFinite(total) ? total : null
}

// 余额评估:首个 entry 口径,下穿触发解除武装,回升到阈值上方恢复武装。
function evaluateBalance({ account, rule, state, reading, events, next }) {
  const entry = (reading.entries || []).find((item) => availableOf(item) !== null)
  if (entry === undefined || rule.balanceThreshold === null || rule.balanceThreshold === undefined) return
  const available = availableOf(entry)
  const threshold = Number(rule.balanceThreshold)
  let armed = state.balanceArmed !== false
  if (armed && available <= threshold) {
    armed = false
    const currency = String(entry.currency || '')
    events.push({
      kind: KIND_BALANCE,
      accountId: account.id,
      accountName: account.name,
      label: null,
      detail: { value: available, threshold, currency },
      text: '[dsh] ' + account.name + ' 余额 ' + available + ' ' + currency + ',低于阈值 ' + threshold + ' ' + currency,
    })
  } else if (available > threshold) {
    armed = true
  }
  next.balanceArmed = armed
}

// 事件构造唯一入口:评估产出与测试事件共用,防事件形态平行漂移。
export function buildNotifyEvent(event, seq, ts) {
  return { ...event, id: 'un-' + ts.toString(36) + '-' + String(seq) + '-' + event.kind, ts }
}

// ---- IM 目标与配置校验 ----

// ID 规格与 dsh-im delivery-service 的 BOT_ID/TARGET_ID 一致,写侧拦截防落库后投递静默失败。
const IM_TARGETS_MAX = 16
const IM_BOT_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/
const IM_TARGET_ID_PATTERN = /^[A-Za-z0-9._:@-]{1,128}$/

// imTargets 读侧归一化:非数组回空,剔除形态非法项,仅保留两字段。
export function normalizeImTargets(raw) {
  if (!Array.isArray(raw)) return []
  return raw
    .filter((item) => item !== null && typeof item === 'object' && !Array.isArray(item)
      && typeof item.botId === 'string' && item.botId.length > 0
      && typeof item.targetId === 'string' && item.targetId.length > 0)
    .map(({ botId, targetId }) => ({ botId, targetId }))
}

// 目标列表操作:与 client.js LOGIC 段同形,parity 测试锁定不漂移。
// botId/targetId 字符集均不含 '/',拼接键无歧义;与 dsh-im delivery-service 共用 ID 规格。
export function imTargetKey(item) {
  return item.botId + '/' + item.targetId
}

// 勾选幂等:同一 botId+targetId 只保留一份;勾选追加到尾部,取消即移除。
export function toggleImTargetList(list, botId, targetId, checked) {
  const wanted = { botId, targetId }
  const rest = list.filter((item) => imTargetKey(item) !== imTargetKey(wanted))
  return checked ? rest.concat([wanted]) : rest
}

export function removeImTargetFromList(list, botId, targetId) {
  return list.filter((item) => imTargetKey(item) !== botId + '/' + targetId)
}

// 取消注册:移除该 bot 全部目标。
export function unregisterImBotList(list, botId) {
  return list.filter((item) => item.botId !== botId)
}

// 已绑 bot:按首次绑定顺序去重。
export function imBoundBotIds(list) {
  const botIds = []
  for (const item of list) {
    if (!botIds.includes(item.botId)) botIds.push(item.botId)
  }
  return botIds
}

const WEBHOOK_SCHEMES = ['https:', 'http:']

function isValidWebhookUrl(value) {
  if (typeof value !== 'string') return false
  const trimmed = value.trim()
  if (trimmed.length === 0) return true
  try {
    return WEBHOOK_SCHEMES.indexOf(new URL(trimmed).protocol) >= 0
  } catch {
    return false
  }
}

// 全局通知配置写侧校验:顶层键白名单,值域内即归一通过。
export function validateNotifyPatch(patch) {
  if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) return { ok: false, reason: '补丁须为对象' }
  const known = ['enabled', 'quotaThresholdPct', 'balanceThreshold', 'resetNotice', 'toast', 'webhookUrl', 'imTargets']
  for (const key of Object.keys(patch)) {
    if (known.indexOf(key) < 0) return { ok: false, reason: '未知配置项: ' + key }
  }
  const next = {}
  if ('enabled' in patch) {
    if (typeof patch.enabled !== 'boolean') return { ok: false, reason: 'enabled 须为布尔' }
    next.enabled = patch.enabled
  }
  if ('quotaThresholdPct' in patch) {
    const pct = patch.quotaThresholdPct
    if (typeof pct !== 'number' || !Number.isFinite(pct) || pct <= 0 || pct > PERCENT_BASE) return { ok: false, reason: 'quotaThresholdPct 须为 (0,100] 内数值' }
    next.quotaThresholdPct = pct
  }
  if ('balanceThreshold' in patch) {
    const value = patch.balanceThreshold
    if (value !== null && (typeof value !== 'number' || !Number.isFinite(value) || value < 0)) return { ok: false, reason: 'balanceThreshold 须为非负数值或 null' }
    next.balanceThreshold = value
  }
  if ('resetNotice' in patch) {
    if (typeof patch.resetNotice !== 'boolean') return { ok: false, reason: 'resetNotice 须为布尔' }
    next.resetNotice = patch.resetNotice
  }
  if ('toast' in patch) {
    if (typeof patch.toast !== 'boolean') return { ok: false, reason: 'toast 须为布尔' }
    next.toast = patch.toast
  }
  if ('webhookUrl' in patch) {
    if (!isValidWebhookUrl(patch.webhookUrl)) return { ok: false, reason: 'webhookUrl 须为 http(s) URL 或空串' }
    next.webhookUrl = String(patch.webhookUrl).trim()
  }
  if ('imTargets' in patch) {
    const list = patch.imTargets
    if (!Array.isArray(list)) return { ok: false, reason: 'imTargets 须为数组' }
    if (list.length > IM_TARGETS_MAX) return { ok: false, reason: 'imTargets 超过上限' }
    const seen = new Set()
    const targets = []
    for (const item of list) {
      const normalized = normalizeImTargets([item])[0]
      if (normalized === undefined) return { ok: false, reason: 'imTargets 项须为含 botId 与 targetId 的对象' }
      // 字符集规格与 dsh-im delivery-service 一致:落库前拦截,防投递静默失败
      if (!IM_BOT_ID_PATTERN.test(normalized.botId)) return { ok: false, reason: 'botId 格式非法' }
      if (!IM_TARGET_ID_PATTERN.test(normalized.targetId)) return { ok: false, reason: 'targetId 格式非法' }
      const key = normalized.botId + '/' + normalized.targetId
      if (seen.has(key)) return { ok: false, reason: 'imTargets 存在重复项' }
      seen.add(key)
      targets.push(normalized)
    }
    next.imTargets = targets
  }
  return { ok: true, patch: next }
}

// 账号 notify 覆盖归一:仅保留三字段中值域合法的键,值域与全局校验一致。
export function normalizeAccountNotify(raw) {
  const source = raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
  const result = {}
  if ('quotaThresholdPct' in source) {
    const pct = source.quotaThresholdPct
    if (typeof pct === 'number' && Number.isFinite(pct) && pct > 0 && pct <= PERCENT_BASE) result.quotaThresholdPct = pct
  }
  if ('balanceThreshold' in source) {
    const value = source.balanceThreshold
    if (value === null || (typeof value === 'number' && Number.isFinite(value) && value >= 0)) result.balanceThreshold = value
  }
  if ('resetNotice' in source && typeof source.resetNotice === 'boolean') result.resetNotice = source.resetNotice
  return result
}

// ---- 投影 / 认领 / webhook(turn-notify 同构语义) ----

// 通知投影:环形容量 + 读取时过期清理;now 注入便于测试。
export function createProjection({ capacity = PROJECTION_CAPACITY, ttlMs = PROJECTION_TTL_MS, now = Date.now }) {
  const ring = []
  return {
    push(unit) {
      const current = now()
      while (ring.length > 0 && current - ring[0].ts > ttlMs) ring.shift()
      ring.push(unit)
      while (ring.length > capacity) ring.shift()
    },
    list() {
      const current = now()
      while (ring.length > 0 && current - ring[0].ts > ttlMs) ring.shift()
      return ring.slice()
    },
  }
}

// 认领决策(读阶段):done 标记终态只补已读;有效他锁跳过;过期锁接管;无锁认领。
// 值非法视为无锁接管;锁归属自己视为继续(重试补完成标记)。
export function decideClaim({ stored, done, now, windowId, lockTtlMs = CLAIM_LOCK_TTL_MS }) {
  if (done !== null && done !== undefined) return 'done'
  if (stored === null || stored === undefined) return 'claim'
  let lock = null
  try {
    lock = JSON.parse(stored)
  } catch {
    lock = null
  }
  if (lock === null || typeof lock !== 'object' || typeof lock.at !== 'number' || typeof lock.wid !== 'string') return 'takeover'
  if (now - lock.at >= lockTtlMs) return 'takeover'
  return lock.wid === windowId ? 'claim' : 'skip'
}

// 通知事件字段到 webhook 结构化字段的一比一映射(text 随行)。
export function buildWebhookPayload(unit) {
  return {
    text: unit.text,
    event: unit.id,
    kind: unit.kind,
    account: unit.accountName,
    accountId: unit.accountId,
    label: unit.label,
    detail: unit.detail,
    ts: unit.ts,
  }
}

// webhook 直发:未配置跳过;任何失败不抛出(fire-and-forget,不重试)。
// 返回真实投递结果供测试按钮呈现,真实通知路径以 void 忽略。
export async function sendWebhook({ url, payload, fetchImpl = fetch }) {
  if (typeof url !== 'string' || url.trim().length === 0) return { ok: false, detail: '未配置 webhook' }
  try {
    const response = await fetchImpl(url.trim(), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(WEBHOOK_TIMEOUT_MS),
    })
    return { ok: response.ok, detail: 'HTTP ' + response.status }
  } catch (error) {
    return { ok: false, detail: error && error.message ? error.message : String(error) }
  }
}

// settings 读数归一:字段类型异常回退默认值,读侧宽松与写侧校验宽松度一致。
export function resolvedNotifySettings(raw) {
  const source = raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
  const fallback = defaultNotifySettings()
  const bool = (value, fallbackValue) => (typeof value === 'boolean' ? value : fallbackValue)
  const pct = Number(source.quotaThresholdPct)
  const balance = source.balanceThreshold === null || source.balanceThreshold === undefined
    ? null
    : Number(source.balanceThreshold)
  return {
    enabled: bool(source.enabled, fallback.enabled),
    quotaThresholdPct: Number.isFinite(pct) && pct > 0 && pct <= PERCENT_BASE ? pct : fallback.quotaThresholdPct,
    balanceThreshold: Number.isFinite(balance) && balance >= 0 ? balance : null,
    resetNotice: bool(source.resetNotice, fallback.resetNotice),
    toast: bool(source.toast, fallback.toast),
    webhookUrl: typeof source.webhookUrl === 'string' ? source.webhookUrl : '',
    imTargets: normalizeImTargets(source.imTargets),
  }
}

// 面板可见配置:webhookUrl 属凭据不出主机,仅回是否已配置。
export function publicNotify(resolved) {
  return {
    enabled: resolved.enabled,
    quotaThresholdPct: resolved.quotaThresholdPct,
    balanceThreshold: resolved.balanceThreshold,
    resetNotice: resolved.resetNotice,
    toast: resolved.toast,
    imTargets: resolved.imTargets,
    webhookConfigured: resolved.webhookUrl.trim().length > 0,
  }
}

// botId 写侧校验:与 dsh-im delivery-service 的 BOT_ID 规格一致。
export function isValidImBotId(value) {
  return typeof value === 'string' && IM_BOT_ID_PATTERN.test(value)
}
