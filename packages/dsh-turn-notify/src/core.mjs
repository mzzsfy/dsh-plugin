// 纯逻辑层:分类映射 / 过滤决策 / 投影 / 认领状态机 / webhook 组装 / 音效映射 / 上传校验。
// 无外部依赖,host 与 client 均可复用;时间与随机经参数注入。

export const CATEGORY_DONE = 'completed'
export const CATEGORY_ERROR = 'error'
export const CATEGORY_INTERRUPTED = 'interrupted'
export const CATEGORY_APPROVAL = 'approval'
export const CATEGORY_ASK = 'ask'
export const CATEGORY_MAX_TOKENS = 'max-tokens'

export const CATEGORIES = [CATEGORY_DONE, CATEGORY_ERROR, CATEGORY_INTERRUPTED, CATEGORY_APPROVAL, CATEGORY_ASK, CATEGORY_MAX_TOKENS]

export const CATEGORY_LABELS = {
  [CATEGORY_DONE]: '任务完成',
  [CATEGORY_ERROR]: '任务出错',
  [CATEGORY_INTERRUPTED]: '被中断',
  [CATEGORY_APPROVAL]: '等待审批',
  [CATEGORY_ASK]: 'AI 提问',
  [CATEGORY_MAX_TOKENS]: '达到上限',
}

// 内置合成音名(参数见 client 音色表),按分类给默认映射。
export const TONE_UP_ARPEGGIO = 'up-arpeggio'
export const TONE_BELL = 'bell'
export const TONE_DUO = 'duo'
export const TONE_ALARM_SQUARE = 'alarm-square'
export const TONE_LOW_HUM = 'low-hum'
export const TONE_DOUBLE_PING = 'double-ping'
export const TONE_TICK = 'tick'
export const TONE_DOWN_SLIDE = 'down-slide'

export const DEFAULT_TONES = {
  [CATEGORY_DONE]: TONE_UP_ARPEGGIO,
  [CATEGORY_ERROR]: TONE_ALARM_SQUARE,
  [CATEGORY_INTERRUPTED]: TONE_ALARM_SQUARE,
  [CATEGORY_APPROVAL]: TONE_DOUBLE_PING,
  [CATEGORY_ASK]: TONE_DOUBLE_PING,
  [CATEGORY_MAX_TOKENS]: TONE_DOWN_SLIDE,
}

// 同类可换的内置备选。
export const BUILTIN_TONES = {
  [TONE_UP_ARPEGGIO]: '上行琶音',
  [TONE_BELL]: '铃铛',
  [TONE_DUO]: '清脆双音',
  [TONE_ALARM_SQUARE]: '警报方波',
  [TONE_LOW_HUM]: '低鸣',
  [TONE_DOUBLE_PING]: '双音提示',
  [TONE_TICK]: '嘀嗒',
  [TONE_DOWN_SLIDE]: '低音下滑',
}

export const AUDIO_EXTS = ['wav', 'mp3', 'ogg']

export const PROJECTION_CAPACITY = 20
export const PROJECTION_TTL_MS = 60 * 1000
export const CLAIM_LOCK_TTL_MS = 30 * 1000
export const WEBHOOK_TIMEOUT_MS = 10 * 1000
export const MIN_TURN_DURATION_MS = 5 * 1000
export const UPLOAD_FILE_MAX_BYTES = 2 * 1024 * 1024
export const UPLOAD_TOTAL_MAX_BYTES = 10 * 1024 * 1024
export const TITLE_MAX_CHARS = 60

const TURN_END_KIND = 'turn/end'

// turn/end reason.kind 到通知分类的映射;未知 kind(插件可扩展)返回 null。
const REASON_KIND_TO_CATEGORY = {
  [CATEGORY_DONE]: CATEGORY_DONE,
  [CATEGORY_ERROR]: CATEGORY_ERROR,
  aborted: CATEGORY_ERROR,
  [CATEGORY_INTERRUPTED]: CATEGORY_INTERRUPTED,
  blocked: CATEGORY_APPROVAL,
  [CATEGORY_MAX_TOKENS]: CATEGORY_MAX_TOKENS,
}

export function mapEventToCategory(type, data) {
  if (type === TURN_END_KIND) {
    const kind = data && data.reason && data.reason.kind
    return Object.prototype.hasOwnProperty.call(REASON_KIND_TO_CATEGORY, kind) ? REASON_KIND_TO_CATEGORY[kind] : null
  }
  if (type === 'tool/call' && data && data.name === 'ask_user_question') return CATEGORY_ASK
  return null
}

// SessionHeader 判定子代理会话:origin 标记优先,辅以委托深度。
export function isSubagent(header) {
  const source = header || {}
  return source.origin === 'subagent' || (source.delegationDepth ?? 0) > 0
}

const DURATION_FILTERED_KINDS = [TURN_END_KIND]

// 通知总决策:分类开关 + 子代理豁免 + 碎轮过滤(仅 turn/end 类)。
export function shouldNotify({ category, kind, durationMs, settings, header }) {
  if (category === null) return false
  if ((settings.enabled || {})[category] === false) return false
  if (settings.rootsOnly !== false && isSubagent(header)) return false
  if (DURATION_FILTERED_KINDS.indexOf(kind) >= 0 && durationMs !== null && durationMs < settings.minTurnDurationMs) return false
  return true
}

export function buildUnit({ id, category, status, sessionTitle, workspace, durationMs, ts }) {
  const label = CATEGORY_LABELS[category] || category
  return {
    id,
    category,
    status,
    session: sessionTitle,
    workspace,
    durationMs,
    ts,
    text: '[dsh] ' + label + (sessionTitle ? ': ' + sessionTitle : ''),
  }
}

// 投影单元字段到 webhook 结构化字段的一比一映射(text 随行)。
export function buildWebhookPayload(unit) {
  return {
    text: unit.text,
    event: unit.id,
    category: unit.category,
    status: unit.status,
    session: unit.session,
    workspace: unit.workspace,
    durationMs: unit.durationMs,
    ts: unit.ts,
  }
}

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

// 发声通道判定:页内提示与系统弹窗各自独立开关,聚焦静默仅压声音与系统弹窗;
// 系统弹窗须授权,想弹而未授权时降级标题闪烁(调用方再按降级提示开关呈现)。
export function chooseChannels({ hasFocus, permission, focusQuiet = true, toastEnabled = true, systemEnabled = true }) {
  const quiet = hasFocus && focusQuiet
  return {
    toast: toastEnabled,
    sound: !quiet,
    system: !quiet && systemEnabled && permission === 'granted',
    blink: !quiet && systemEnabled && permission !== 'granted',
  }
}

// 分类音效解析:映射指向已上传音效则用自定义;指向内置音名则用该内置;否则(未配置/已失效)回落内置默认。
export function resolveSound({ category, mapping, uploadedIds }) {
  const wanted = (mapping || {})[category]
  if (typeof wanted === 'string' && wanted.length > 0) {
    if (uploadedIds.indexOf(wanted) >= 0) return { kind: 'custom', id: wanted }
    if (Object.prototype.hasOwnProperty.call(BUILTIN_TONES, wanted)) return { kind: 'builtin', name: wanted }
  }
  return { kind: 'builtin', name: DEFAULT_TONES[category] }
}

// 删除音效后清除映射中的引用,残留键回落由 resolveSound 兜底。
export function pruneMapping(mapping, removedId) {
  const next = {}
  for (const key of Object.keys(mapping || {})) {
    if (mapping[key] !== removedId) next[key] = mapping[key]
  }
  return next
}

export function uploadExt(filename) {
  const match = /\.([^.]+)$/.exec(String(filename || ''))
  return match ? match[1].toLowerCase() : ''
}

// 上传校验:扩展名白名单 + 单文件上限 + 总量上限。
export function validateUpload({ filename, size, totalBytes }) {
  const ext = uploadExt(filename)
  if (AUDIO_EXTS.indexOf(ext) < 0) return { ok: false, reason: '仅支持 ' + AUDIO_EXTS.join(' / ') }
  if (!(size >= 1) || size > UPLOAD_FILE_MAX_BYTES) return { ok: false, reason: '单文件超过上限' }
  if (totalBytes + size > UPLOAD_TOTAL_MAX_BYTES) return { ok: false, reason: '音效总量超过上限' }
  return { ok: true, ext }
}

// 从会话事件流提取首个用户文本作为标题,超长截断;无用户文本返回 null。
export function sessionTitle(events) {  for (const event of events) {
    if (event.type !== 'user/message') continue
    const blocks = event.data && Array.isArray(event.data.content) ? event.data.content : []
    for (const block of blocks) {
      if (block && typeof block.text === 'string' && block.text.trim().length > 0) {
        const text = block.text.trim()
        return text.length <= TITLE_MAX_CHARS ? text : text.slice(0, TITLE_MAX_CHARS)
      }
    }
  }
  return null
}

// 会话事件有界累积:仅 user/message 入库;标题一旦可提取即封账,
// 该会话后续事件不再累积,store 与 titled 原位更新。
export function collectSessionEvents(store, titled, sessionId, event) {
  if (event.type !== 'user/message') return
  if (titled.has(sessionId)) return
  const events = (store.get(sessionId) || []).concat([event])
  store.set(sessionId, events)
  if (sessionTitle(events) !== null) titled.add(sessionId)
}

// 映射路由音效 id 校验:空串(清除映射)放行,其余须为已上传 id 或内置音名。
export function validateMappingId(id, uploadedIds) {
  if (typeof id !== 'string' || id.length === 0) return true
  return uploadedIds.indexOf(id) >= 0 || Object.prototype.hasOwnProperty.call(BUILTIN_TONES, id)
}

// 请求体读取:超限先 reject 再断流;'close' 兜底 reject,防 destroy 后悬挂。
export function readRawBody(req, maxBytes) {
  return new Promise((resolve, reject) => {
    let settled = false
    const fail = (error) => {
      if (settled) return
      settled = true
      reject(error)
    }
    const done = (value) => {
      if (settled) return
      settled = true
      resolve(value)
    }
    let size = 0
    const chunks = []
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > maxBytes) {
        fail(new Error('请求体超过上限'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => done(Buffer.concat(chunks)))
    req.on('error', fail)
    req.on('close', () => {
      if (!req.readableEnded) fail(new Error('请求连接中断'))
    })
  })
}

// 审批观察器包装:notify 异步投递,next() 同步立即放行,不阻塞 waterfall。
export function createApprovalTap(notify, schedule) {
  return function approvalTap(_req, next) {
    schedule(() => notify({ category: CATEGORY_APPROVAL }))
    return next()
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
    // webhook 不可达不打扰主循环,失败即弃,错误信息仅供测试路径呈现
    return { ok: false, detail: error && error.message ? error.message : String(error) }
  }
}

const CONFIG_WEBHOOK_SCHEMES = ['http:', 'https:']

// 配置补丁校验:顶层键白名单,webhookUrl 空串(禁用)或 http(s) URL,
// 时长须非负整数,开关须布尔,enabled 分类须已知。返回归一化后的补丁。
export function validateConfigPatch(patch) {
  if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) return { ok: false, reason: '补丁须为对象' }
  const known = ['webhookUrl', 'minTurnDurationMs', 'rootsOnly', 'enabled']
  for (const key of Object.keys(patch)) {
    if (known.indexOf(key) < 0) return { ok: false, reason: '未知配置项: ' + key }
  }
  const next = {}
  if ('webhookUrl' in patch) {
    const url = patch.webhookUrl
    if (typeof url !== 'string') return { ok: false, reason: 'webhookUrl 须为字符串' }
    const trimmed = url.trim()
    if (trimmed.length > 0) {
      try {
        const parsed = new URL(trimmed)
        if (CONFIG_WEBHOOK_SCHEMES.indexOf(parsed.protocol) < 0) return { ok: false, reason: 'webhookUrl 仅支持 http(s)' }
      } catch {
        return { ok: false, reason: 'webhookUrl 不是合法 URL' }
      }
    }
    next.webhookUrl = trimmed
  }
  if ('minTurnDurationMs' in patch) {
    const ms = patch.minTurnDurationMs
    if (typeof ms !== 'number' || !Number.isInteger(ms) || ms < 0) return { ok: false, reason: 'minTurnDurationMs 须为非负整数' }
    next.minTurnDurationMs = ms
  }
  if ('rootsOnly' in patch) {
    if (typeof patch.rootsOnly !== 'boolean') return { ok: false, reason: 'rootsOnly 须为布尔' }
    next.rootsOnly = patch.rootsOnly
  }
  if ('enabled' in patch) {
    const enabled = patch.enabled
    if (enabled === null || typeof enabled !== 'object' || Array.isArray(enabled)) return { ok: false, reason: 'enabled 须为对象' }
    for (const key of Object.keys(enabled)) {
      if (CATEGORIES.indexOf(key) < 0) return { ok: false, reason: '未知分类: ' + key }
      if (typeof enabled[key] !== 'boolean') return { ok: false, reason: '分类开关须为布尔: ' + key }
    }
    next.enabled = { ...enabled }
  }
  return { ok: true, patch: next }
}

// 面板读取的解析形态:enabled 缺省键按开补全,字段类型异常回退默认值;
// 时长统一取整到非负整数,与写路径校验宽松度一致(yaml 手写小数不产生读存差)。
export function resolvedConfig(settings) {
  const source = settings || {}
  const enabled = (typeof source.enabled === 'object' && source.enabled !== null) ? source.enabled : {}
  const soundMapping = (typeof source.soundMapping === 'object' && source.soundMapping !== null) ? source.soundMapping : {}
  const duration = Number.isFinite(source.minTurnDurationMs) ? Math.max(0, Math.floor(source.minTurnDurationMs)) : MIN_TURN_DURATION_MS
  return {
    webhookUrl: typeof source.webhookUrl === 'string' ? source.webhookUrl : '',
    minTurnDurationMs: duration,
    rootsOnly: source.rootsOnly !== false,
    enabled: Object.fromEntries(CATEGORIES.map((key) => [key, enabled[key] !== false])),
    soundMapping: { ...soundMapping },
  }
}

// 面板可见配置:webhookUrl 属凭据不出主机,仅回是否已配置。
export function publicConfig(settings) {
  const resolved = resolvedConfig(settings)
  return {
    minTurnDurationMs: resolved.minTurnDurationMs,
    rootsOnly: resolved.rootsOnly,
    enabled: resolved.enabled,
    soundMapping: resolved.soundMapping,
    webhookConfigured: resolved.webhookUrl.trim().length > 0,
  }
}
