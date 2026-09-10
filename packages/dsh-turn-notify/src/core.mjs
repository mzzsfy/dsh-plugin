// 纯逻辑层:分类映射 / 过滤决策 / 投影 / 认领状态机 / webhook 组装 / 音效映射 / 上传校验。
// 无 npm 依赖,host 与 client 均可复用;readRawBody 与 sendWebhook 为 host 专属 I/O 辅助,
// 依赖经参数注入保持可测。时间与随机经参数注入。

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

// 扩展名到 MIME 的一比一映射:host 响应头使用,client 侧为镜像,由 parity 测试锁定
export const MIME_BY_EXT = { wav: 'audio/wav', ogg: 'audio/ogg', mp3: 'audio/mpeg' }

export const mimeOf = (ext) => MIME_BY_EXT[ext] ?? 'application/octet-stream'

// 未显式设置音量时的默认值。
export const DEFAULT_VOLUME = 0.6

// 音量解析:未设置或非法回落默认,显式零(静音)保留。
export function parseVolume(raw) {
  if (raw === null || raw === undefined) return DEFAULT_VOLUME
  const value = Number(raw)
  return value >= 0 && value <= 1 ? value : DEFAULT_VOLUME
}

export const PROJECTION_CAPACITY = 20
export const PROJECTION_TTL_MS = 60 * 1000
export const CLAIM_LOCK_TTL_MS = 30 * 1000
export const WEBHOOK_TIMEOUT_MS = 10 * 1000
export const MIN_TURN_DURATION_MS = 5 * 1000
export const UPLOAD_FILE_MAX_BYTES = 2 * 1024 * 1024
export const UPLOAD_TOTAL_MAX_BYTES = 10 * 1024 * 1024
export const TITLE_MAX_CHARS = 60

// IM 投递目标上限:settings 体积与面板列表的防护栏
const IM_TARGETS_MAX = 16

// ID 规格与 dsh-im delivery-service 的 BOT_ID/TARGET_ID 一致,写侧拦截防落库后投递静默失败
const IM_BOT_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/
const IM_TARGET_ID_PATTERN = /^[A-Za-z0-9._:@-]{1,128}$/

export const isValidImBotId = (value) => typeof value === 'string' && IM_BOT_ID_PATTERN.test(value)

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

// 子代理结束到父会话被唤醒的投递裕量;超过视为与子代理无关的新回合。
export const SUBAGENT_WAKE_WINDOW_MS = 30 * 1000

// 唤醒回合判定:父会话回合开始前窗口内,有其子代理会话结束(childDoneAt 为时间戳,null 表示无记录)。
export function isSubagentWakeTurn({ childDoneAt, turnStartMs, windowMs = SUBAGENT_WAKE_WINDOW_MS }) {
  if (typeof childDoneAt !== 'number') return false
  const elapsed = turnStartMs - childDoneAt
  return elapsed >= 0 && elapsed <= windowMs
}

const DURATION_FILTERED_KINDS = [TURN_END_KIND]

// 通知总决策:分类开关 + 子代理豁免 + 子代理相关静默(唤醒回执 / 等待委托,仅 completed)
// + 碎轮过滤(仅 turn/end 类)。
export function shouldNotify({ category, kind, durationMs, settings, header, wakeTurn, awaitingChildren }) {
  if (category === null) return false
  if ((settings.enabled || {})[category] === false) return false
  if (settings.rootsOnly !== false && isSubagent(header)) return false
  if ((wakeTurn === true || awaitingChildren === true) && category === CATEGORY_DONE && settings.suppressSubagentWake !== false) return false
  if (DURATION_FILTERED_KINDS.indexOf(kind) >= 0 && durationMs !== null && durationMs < settings.minTurnDurationMs) return false
  return true
}

export function buildUnit({ id, category, status, sessionTitle, workspace, durationMs, ts, tokens, summary }) {
  const label = CATEGORY_LABELS[category] || category
  return {
    id,
    category,
    status,
    session: sessionTitle,
    workspace,
    durationMs,
    tokens: typeof tokens === 'number' && tokens > 0 ? tokens : null,
    summary: typeof summary === 'string' && summary.length > 0 ? summary : null,
    ts,
    text: '[dsh] ' + label + (sessionTitle ? ': ' + sessionTitle : ''),
  }
}

// 通知一句话小结:耗时 + tokens + 回答前缀,均缺省返回 null(各通道按需拼装)。
// 前缀为最终回答的首个文本块,host 侧已按码点截断,此处原样拼装。
export function buildSummary({ durationMs, tokens, prefix }) {
  const parts = []
  if (typeof durationMs === 'number' && durationMs >= 0) {
    parts.push('耗时 ' + (durationMs >= 1000 ? Math.round(durationMs / 1000) + ' 秒' : Math.round(durationMs) + ' 毫秒'))
  }
  if (typeof tokens === 'number' && tokens > 0) parts.push(formatTokenCount(tokens) + ' tokens')
  if (typeof prefix === 'string' && prefix.trim().length > 0) parts.push(prefix.trim())
  return parts.length > 0 ? parts.join(' · ') : null
}

// tokens 紧凑格式:千以下原样,以上 k 计一位小数
export function formatTokenCount(tokens) {
  if (tokens < 1000) return String(tokens)
  const k = tokens / 1000
  return (k >= 100 ? Math.round(k) : Math.round(k * 10) / 10) + 'k'
}

// 回答前缀截断:按码点截断防切断代理对,与 sessionTitle 同策略
export const ANSWER_PREFIX_MAX_CHARS = 80

// assistant/message 事件 → 会话尾部统计累积:tokens 跨 step 累加(一回合多步),
// 回答前缀取本回合最后一条含文本的消息(后到覆盖);usage 缺失不减不崩。
export function collectAssistantTail(tail, sessionId, data) {
  const message = data && data.message
  const blocks = message !== null && typeof message === 'object' && Array.isArray(message.content) ? message.content : []
  let prefix = null
  for (const block of blocks) {
    if (block && typeof block.text === 'string' && block.text.trim().length > 0) {
      const text = block.text.trim()
      prefix = text.length <= ANSWER_PREFIX_MAX_CHARS
        ? text
        : Array.from(text.slice(0, ANSWER_PREFIX_MAX_CHARS + 1)).slice(0, ANSWER_PREFIX_MAX_CHARS).join('')
      break
    }
  }
  const usage = data && typeof data.usage === 'object' && data.usage !== null ? data.usage : null
  let tokens = 0
  if (usage !== null) {
    tokens = (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0) + (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0)
  }
  const prev = tail.get(sessionId)
  const next = {
    tokens: (prev?.tokens ?? 0) + tokens,
    prefix: prefix !== null ? prefix : (prev?.prefix ?? null),
  }
  tail.set(sessionId, next)
  return next
}

// 投影单元字段到 webhook 结构化字段的一比一映射(text/summary 随行)。
export function buildWebhookPayload(unit) {
  return {
    text: unit.text,
    summary: unit.summary,
    event: unit.id,
    category: unit.category,
    status: unit.status,
    session: unit.session,
    workspace: unit.workspace,
    durationMs: unit.durationMs,
    tokens: unit.tokens,
    ts: unit.ts,
  }
}

// 通知投影:环形容量 + 读取时过期清理;now 注入便于测试。
// version 单调递增支撑长轮询:push 与 bump 各递增一次并唤醒全部等待者,
// wait 在无更新版本时挂起至唤醒或超时,超时与 dispose 均以当前版本收尾不报错。
export function createProjection({ capacity = PROJECTION_CAPACITY, ttlMs = PROJECTION_TTL_MS, now = Date.now }) {
  const ring = []
  let version = 0
  const waiters = new Set()
  const settle = (waiter) => {
    clearTimeout(waiter.timer)
    waiters.delete(waiter)
    waiter.resolve(version)
  }
  const wakeAll = () => { for (const waiter of [...waiters]) settle(waiter) }
  return {
    push(unit) {
      const current = now()
      while (ring.length > 0 && current - ring[0].ts > ttlMs) ring.shift()
      ring.push(unit)
      while (ring.length > capacity) ring.shift()
      version += 1
      wakeAll()
    },
    bump() {
      version += 1
      wakeAll()
    },
    version: () => version,
    wait(cursor, timeoutMs) {
      if (version > cursor) return Promise.resolve(version)
      return new Promise((resolve) => {
        const waiter = { resolve, timer: null }
        waiter.timer = setTimeout(() => settle(waiter), timeoutMs)
        waiters.add(waiter)
      })
    },
    dispose: wakeAll,
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

// 用户行动空闲满此时长视为离开:聚焦静默不再适用,通知全通道齐发。
export const USER_IDLE_AWAY_MS = 5 * 60 * 1000

// 呈现通道名单:事件→通道路由(kindRoutes)的合法取值;host 直发通道
// (webhook/im)由 host 侧过滤,投影单元携带 routes 供浏览器侧过滤呈现通道。
export const CHANNELS = ['sound', 'system', 'toast', 'blink', 'webhook', 'im']

// 发声通道判定:页内提示、提示音与系统弹窗各自独立开关,聚焦静默仅压声音与系统弹窗;
// 提示音另受分类配置约束:soundCategories 中该分类显式 false 即静音,缺省键与空分类放行。
// 系统弹窗须授权,想弹而未授权时降级标题闪烁(调用方再按降级提示开关呈现)。
// idleMs 为距上次用户行动的时长,满阈值视为离开,等效未聚焦。
// pageSound 为页内提示音:页内提示弹出且通知声音未播时补一声(聚焦场景的听觉提醒),
// 不受聚焦静默压制,受页内总开关、页内分类配置(pageSoundCategories,独立于提示音分类)
// 与通知声音互斥约束(同一通知至多一声)。
// routes 为事件→通道路由放行名单(null=未配置全放行):单元级 AND 叠加在本机偏好之上,
// 名单外的呈现通道一律不出。
export function chooseChannels({ hasFocus, permission, focusQuiet = true, toastEnabled = true, soundEnabled = true, soundCategories = null, category = null, systemEnabled = true, idleMs = null, idleThresholdMs = USER_IDLE_AWAY_MS, pageSoundEnabled = false, pageSoundCategories = null, routes = null }) {
  const idleAway = typeof idleMs === 'number' && idleMs >= idleThresholdMs
  const quiet = hasFocus && focusQuiet && !idleAway
  const categoryMuted = soundCategories != null && category != null && soundCategories[category] === false
  const pageCategoryMuted = pageSoundCategories != null && category != null && pageSoundCategories[category] === false
  const routed = (channel) => routes === null || routes.indexOf(channel) >= 0
  const sound = !quiet && soundEnabled && !categoryMuted && routed('sound')
  return {
    toast: toastEnabled && routed('toast'),
    sound,
    system: !quiet && systemEnabled && permission === 'granted' && routed('system'),
    blink: !quiet && systemEnabled && permission !== 'granted' && routed('blink'),
    pageSound: pageSoundEnabled && toastEnabled && !pageCategoryMuted && !sound && routed('toast'),
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

// 映射双作用域合并:全局为底,本地键覆盖(空串=显式内置默认,同样覆盖);
// 两参均容错空值,返回新对象不改入参。
export function mergeMapping(globalMapping, localMapping) {
  const merged = {}
  for (const key of Object.keys(globalMapping || {})) merged[key] = globalMapping[key]
  for (const key of Object.keys(localMapping || {})) merged[key] = localMapping[key]
  return merged
}

// 死链识别:映射值既非内置音名也非已上传 id 即失效引用,去重并按首次出现排序,
// 供面板呈现死链与发声回退归因。
export function deadCustomIds(mapping, uploadedIds) {
  const uploaded = uploadedIds || []
  const dead = []
  for (const value of Object.values(mapping || {})) {
    if (typeof value !== 'string' || value.length === 0) continue
    if (Object.prototype.hasOwnProperty.call(BUILTIN_TONES, value)) continue
    if (uploaded.indexOf(value) >= 0) continue
    if (dead.indexOf(value) < 0) dead.push(value)
  }
  return dead
}

// 音效展示名长度上限:超长截断提示不佳,直接拒绝。
export const SOUND_NAME_MAX_CHARS = 64

// 展示名黑名单:分隔符与点防注入索引键或文件名形态,控制字符与 Windows 非法字符防后续落盘复用失败。
const SOUND_NAME_FORBIDDEN = /[\\/:*?"<>|.\u0000-\u001f]/

// 展示名校验:trim 归一化随结果返回;名称仅存展示名索引,不进文件名;
// 与内置音色重名会污染映射 id 命名空间,一并拒绝。
export function validateSoundName(rawName) {
  const name = String(rawName ?? '').trim()
  if (name.length === 0) return { ok: false, reason: '名称不能为空' }
  if (name.length > SOUND_NAME_MAX_CHARS) return { ok: false, reason: '名称超过长度上限' }
  if (SOUND_NAME_FORBIDDEN.test(name)) return { ok: false, reason: '名称含非法字符' }
  if (Object.prototype.hasOwnProperty.call(BUILTIN_TONES, name)) return { ok: false, reason: '名称与内置音色冲突' }
  return { ok: true, name }
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

// 回合起始记录滞留上限:会话异常终止不发 turn/end 时按超时回收
export const OPEN_TURN_STALE_MS = 60 * 60 * 1000

// 未封账会话的事件保留上限:标题只依赖首个文本块,超限截尾防无文本消息无限累积
export const SESSION_EVENTS_MAX = 8

// 惰性过期:删除时间戳早于 maxAgeMs 的条目,防异常时序下按会话容器无界滞留。
export function pruneTimestamps(map, now, maxAgeMs) {
  for (const [key, at] of map) {
    if (now - at > maxAgeMs) map.delete(key)
  }
}

// 从会话事件流提取首个用户文本作为标题,超长按码点截断防切断代理对;无用户文本返回 null。
export function sessionTitle(events) {
  for (const event of events) {
    if (event.type !== 'user/message') continue
    const blocks = event.data && Array.isArray(event.data.content) ? event.data.content : []
    for (const block of blocks) {
      if (block && typeof block.text === 'string' && block.text.trim().length > 0) {
        const text = block.text.trim()
        if (text.length <= TITLE_MAX_CHARS) return text
        // 先按码元粗截再按码点收尾,避免对超长文本全量分配码点数组
        const head = text.slice(0, TITLE_MAX_CHARS + 1)
        return Array.from(head).slice(0, TITLE_MAX_CHARS).join('')
      }
    }
  }
  return null
}

// 会话事件有界累积:仅 user/message 入库;标题一旦可提取即封账,封账后 store 中
// 以标题字符串替代事件数组,未封账会话超上限截尾,store 与 titled 原位更新。
export function collectSessionEvents(store, titled, sessionId, event) {
  if (event.type !== 'user/message') return
  if (titled.has(sessionId)) return
  const events = store.get(sessionId)
  const merged = (Array.isArray(events) ? events : []).concat([event]).slice(-SESSION_EVENTS_MAX)
  const title = sessionTitle(merged)
  if (title === null) store.set(sessionId, merged)
  else {
    titled.add(sessionId)
    store.set(sessionId, title)
  }
}

// 会话标题读取:封账会话为字符串,未封账为事件数组,空缺为 null。
export function storedSessionTitle(store, sessionId) {
  const value = store.get(sessionId)
  if (typeof value === 'string') return value
  if (Array.isArray(value)) return sessionTitle(value)
  return null
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

// imTargets 读侧归一化:非数组回空,剔除形态非法项,仅保留两字段
export function normalizeImTargets(raw) {
  if (!Array.isArray(raw)) return []
  return raw
    .filter((item) => item !== null && typeof item === 'object' && !Array.isArray(item)
      && typeof item.botId === 'string' && item.botId.length > 0
      && typeof item.targetId === 'string' && item.targetId.length > 0)
    .map(({ botId, targetId }) => ({ botId, targetId }))
}

// ---- IM 目标列表操作(client LOGIC 段镜像,parity 测试保证不漂移) ----

// botId/targetId 字符集均不含 '/',拼接键无歧义
export const imTargetKeyOf = (item) => item.botId + '/' + item.targetId

// 勾选幂等:同一 botId+targetId 只保留一份;勾选追加到尾部,取消即移除
export function toggleImTargetList(list, botId, targetId, checked) {
  const wanted = { botId, targetId }
  const rest = list.filter((item) => imTargetKeyOf(item) !== imTargetKeyOf(wanted))
  return checked ? rest.concat([wanted]) : rest
}

export function removeImTargetFromList(list, botId, targetId) {
  return list.filter((item) => imTargetKeyOf(item) !== botId + '/' + targetId)
}

// 取消注册:移除该 bot 全部目标
export function unregisterImBotList(list, botId) {
  return list.filter((item) => item.botId !== botId)
}

// 已绑 bot:按首次绑定顺序去重
export function imBoundBotIds(list) {
  const botIds = []
  for (const item of list) {
    if (!botIds.includes(item.botId)) botIds.push(item.botId)
  }
  return botIds
}

// 配置补丁校验:顶层键白名单,webhookUrl 空串(禁用)或 http(s) URL,
// 时长须非负整数,开关须布尔,enabled 分类须已知,kindRoutes 条目须合法通道名单。
// 返回归一化后的补丁。
export function validateConfigPatch(patch) {
  if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) return { ok: false, reason: '补丁须为对象' }
  const known = ['webhookUrl', 'minTurnDurationMs', 'rootsOnly', 'suppressSubagentWake', 'enabled', 'imTargets', 'kindRoutes']
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
  if ('imTargets' in patch) {
    const list = patch.imTargets
    if (!Array.isArray(list)) return { ok: false, reason: 'imTargets 须为数组' }
    if (list.length > IM_TARGETS_MAX) return { ok: false, reason: 'imTargets 超过上限' }
    const seen = new Set()
    const targets = []
    for (const item of list) {
      if (item === null || typeof item !== 'object' || Array.isArray(item)) return { ok: false, reason: 'imTargets 项须为对象' }
      const keys = Object.keys(item)
      if (keys.length !== 2 || !keys.includes('botId') || !keys.includes('targetId')) return { ok: false, reason: 'imTargets 项仅含 botId 与 targetId' }
      const botId = typeof item.botId === 'string' ? item.botId.trim() : ''
      const targetId = typeof item.targetId === 'string' ? item.targetId.trim() : ''
      if (!IM_BOT_ID_PATTERN.test(botId)) return { ok: false, reason: 'botId 格式非法' }
      if (!IM_TARGET_ID_PATTERN.test(targetId)) return { ok: false, reason: 'targetId 格式非法' }
      const key = botId + '/' + targetId
      if (seen.has(key)) return { ok: false, reason: 'imTargets 存在重复项' }
      seen.add(key)
      targets.push({ botId, targetId })
    }
    next.imTargets = targets
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
  if ('suppressSubagentWake' in patch) {
    if (typeof patch.suppressSubagentWake !== 'boolean') return { ok: false, reason: 'suppressSubagentWake 须为布尔' }
    next.suppressSubagentWake = patch.suppressSubagentWake
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
  if ('kindRoutes' in patch) {
    next.kindRoutes = normalizeKindRoutes(patch.kindRoutes).routes
  }
  return { ok: true, patch: next }
}

// kindRoutes 读侧归一化:分类 → 放行通道名单。非对象回空(全通道);未知分类的
// 条目剔除、名单内未知通道剔除,余项去重保序(与 normalizeImTargets 同宽松读侧:
// 剔除非法而非整体拒绝);全空名单等价全禁(合法,用户显式配置),与缺省键(全放行)区分。
// 写侧校验(validateConfigPatch)对未知分类/通道拒绝,两侧严格度分工不同。
export function normalizeKindRoutes(raw) {
  if (raw === null || raw === undefined || typeof raw !== 'object' || Array.isArray(raw)) return { ok: true, routes: {} }
  const routes = {}
  for (const key of Object.keys(raw)) {
    if (CATEGORIES.indexOf(key) < 0) continue
    const list = raw[key]
    if (!Array.isArray(list)) continue
    const seen = new Set()
    for (const channel of list) {
      if (typeof channel !== 'string' || CHANNELS.indexOf(channel) < 0) continue
      if (!seen.has(channel)) seen.add(channel)
    }
    routes[key] = [...seen]
  }
  return { ok: true, routes }
}

// 投影单元放行名单读取:kindRoutes 未配置该分类即全放行(null),配置即名单。
export function unitRoutes(kindRoutes, category) {
  if (kindRoutes === null || typeof kindRoutes !== 'object') return null
  const list = kindRoutes[category]
  return Array.isArray(list) ? list : null
}

// 面板读取的解析形态:enabled 缺省键按开补全,字段类型异常回退默认值;
// 时长统一取整到非负整数,与写路径校验宽松度一致(yaml 手写小数不产生读存差)。
// soundMapping 仅保留非空字符串值:settings.update 深合并无法物理删除嵌套键,
// 清除信号经 schema 归一落为 null 或空串,此处过滤使逻辑删除对下游透明。
export function resolvedConfig(settings) {
  const source = settings || {}
  const enabled = (typeof source.enabled === 'object' && source.enabled !== null) ? source.enabled : {}
  const rawMapping = (typeof source.soundMapping === 'object' && source.soundMapping !== null) ? source.soundMapping : {}
  const soundMapping = {}
  for (const key of Object.keys(rawMapping)) {
    const value = rawMapping[key]
    if (typeof value === 'string' && value.length > 0) soundMapping[key] = value
  }
  const duration = Number.isFinite(source.minTurnDurationMs) ? Math.max(0, Math.floor(source.minTurnDurationMs)) : MIN_TURN_DURATION_MS
  const routesVerdict = normalizeKindRoutes(source.kindRoutes)
  return {
    webhookUrl: typeof source.webhookUrl === 'string' ? source.webhookUrl : '',
    minTurnDurationMs: duration,
    rootsOnly: source.rootsOnly !== false,
    suppressSubagentWake: source.suppressSubagentWake !== false,
    enabled: Object.fromEntries(CATEGORIES.map((key) => [key, enabled[key] !== false])),
    soundMapping,
    imTargets: normalizeImTargets(source.imTargets),
    kindRoutes: routesVerdict.ok ? routesVerdict.routes : {},
  }
}

// 面板可见配置:webhookUrl 原文随响应回显,面板所见即所存。
export function publicConfig(settings) {
  const resolved = resolvedConfig(settings)
  return {
    minTurnDurationMs: resolved.minTurnDurationMs,
    rootsOnly: resolved.rootsOnly,
    suppressSubagentWake: resolved.suppressSubagentWake,
    enabled: resolved.enabled,
    soundMapping: resolved.soundMapping,
    imTargets: resolved.imTargets,
    kindRoutes: resolved.kindRoutes,
    webhookUrl: resolved.webhookUrl,
  }
}
