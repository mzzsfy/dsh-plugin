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

// 发声形态:聚焦页内轻提示;Notification 可用走全量;否则降级 toast + 标题闪烁。
export function choosePresentation({ hasFocus, notificationPermission }) {
  if (hasFocus) return 'toast'
  return notificationPermission === 'granted' ? 'full' : 'fallback'
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

// webhook 直发:未配置跳过;任何失败吞错(fire-and-forget,不重试)。
export async function sendWebhook({ url, payload, fetchImpl = fetch }) {
  if (typeof url !== 'string' || url.trim().length === 0) return
  try {
    await fetchImpl(url.trim(), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(WEBHOOK_TIMEOUT_MS),
    })
  } catch {
    // webhook 不可达不打扰主循环,失败即弃
  }
}
