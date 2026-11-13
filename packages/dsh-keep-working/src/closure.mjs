/**
 * 结案判定:纯函数层,不依赖宿主服务。
 *
 * 判定对象是一个 turn 的事件切片。结案凭据有两种:
 * - present:本回合成功交付文件,且交付之后没有再改文件
 * - marker:末行独占 TASK_DONE 或 TASK_BLOCKED: ...
 *
 * 有文件写入的回合只认 present,否则模型会退化成写一行标记就交差。
 */

export const DONE_MARKER = 'TASK_DONE'
export const BLOCKED_PREFIX = 'TASK_BLOCKED'

const BLOCKED_LINE = new RegExp(`^${BLOCKED_PREFIX}:\\s*\\S.*$`)

/** 宿主写文件的工具名;新增写入面时在此登记。 */
export const FILE_WRITE_TOOLS = new Set(['write', 'edit', 'apply_patch', 'str_replace_editor'])

/** 取 assistant 消息里的可见文本,工具块不计入。 */
export function assistantText(message) {
  const content = message?.content
  if (!Array.isArray(content)) return ''
  return content
    .filter((block) => block?.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('')
}

/** 本回合事件切片:从该 turn 的 turn/start 起,到同号 turn/end 止。 */
export function turnSlice(events, turn) {
  if (!Array.isArray(events)) return []
  let start = -1
  let end = events.length
  for (let index = 0; index < events.length; index += 1) {
    const event = events[index]
    if (event?.type === 'turn/start' && event.data?.turn === turn) start = index
    if (event?.type === 'turn/end' && event.data?.turn === turn) {
      end = index
      break
    }
  }
  return events.slice(Math.max(start, 0), end)
}

/** 末行标记;严格匹配裸标记,括号、下划线、连字符等装饰都不算。 */
export function matchMarker(text) {
  if (typeof text !== 'string' || text === '') return null
  const last = (text.trimEnd().split('\n').at(-1) ?? '').trim()
  if (last === DONE_MARKER) return 'done'
  if (BLOCKED_LINE.test(last)) return 'blocked'
  return null
}

/** 本回合最后一条带可见文本的 assistant 消息文本;纯工具调用步骤跳过。 */
export function lastAssistantText(events, turn) {
  const slice = turnSlice(events, turn)
  for (let index = slice.length - 1; index >= 0; index -= 1) {
    const event = slice[index]
    if (event?.type !== 'assistant/message') continue
    const text = assistantText(event.data?.message)
    if (text.trim() !== '') return text
  }
  return ''
}

/** 本回合是否产生过可见输出。 */
export function hasVisibleOutput(events) {
  return events.some(
    (event) => event?.type === 'assistant/message' && assistantText(event.data?.message).trim() !== '',
  )
}

/** 真人消息:来源是 user,且不是本插件补发的。 */
const isHumanMessage = (event, excludeIds) =>
  event?.type === 'user/message' &&
  event.data?.source?.kind === 'user' &&
  excludeIds?.has?.(event.data?.id) !== true

/**
 * 回合前导段里的真人发起消息。
 *
 * 宿主把各类上下文(指令文件、工作目录、任务事件、定时唤醒等)作为
 * user/message 注入在真人消息之前,kind 由各生产者自定且持续增加,不能靠白名单。
 * 这里只看 turn/start 之后的第一段:跳过非 user 来源,遇到本插件自投递或
 * 模型、工具事件即结束。返回 undefined 表示本回合不是真人发起的。
 */
function leadingHumanMessage(events, turn, excludeIds) {
  for (const event of turnSlice(events, turn)) {
    if (event?.type === 'user/message') {
      if (event.data?.source?.kind !== 'user') continue
      // 本插件补发的消息是回合发起者,但不是真人
      if (excludeIds?.has?.(event.data?.id) === true) return undefined
      return event
    }
    if (event?.type === 'assistant/message' || event?.type === 'tool/call' || event?.type === 'tool/result') {
      return undefined
    }
  }
  return undefined
}

/** 回合发起来源;跳过注入上下文后取第一条 user 来源消息(含本插件补发)。 */
export function turnInitiator(events, turn) {
  for (const event of turnSlice(events, turn)) {
    if (event?.type === 'user/message') {
      if (event.data?.source?.kind !== 'user') continue
      return 'user'
    }
    if (event?.type === 'assistant/message' || event?.type === 'tool/call' || event?.type === 'tool/result') {
      return undefined
    }
  }
  return undefined
}

/** 回合由真人发起:第一条非注入消息是真人且不是本插件自投递。 */
export function humanInitiatedTurn(events, turn, excludeIds) {
  return leadingHumanMessage(events, turn, excludeIds) !== undefined
}

/** 用户在本回合中途插话:结案提醒让路,避免与人的意图抢方向。 */
export function userTookOver(events, turn, excludeIds) {
  const humans = turnSlice(events, turn).filter((event) => isHumanMessage(event, excludeIds))
  if (humans.length === 0) return false
  // 发起者不是真人(插件补发的回合)时,第一条真人消息就是插话
  return leadingHumanMessage(events, turn, excludeIds) === undefined || humans.length > 1
}

const isFileWrite = (event) => event?.type === 'tool/call' && FILE_WRITE_TOOLS.has(event.data?.name)

/** 只读子命令:编辑器工具的 view 不改文件,不该逼出交付。 */
function isReadOnlyCall(call) {
  if (call?.data?.name !== 'str_replace_editor') return false
  try {
    return JSON.parse(call.data?.arguments ?? '{}')?.command === 'view'
  } catch {
    return false
  }
}

/**
 * 本回合真正改动过文件的调用。
 *
 * 失败的写(沙箱拒绝、审批驳回、参数错误)没有产生改动,按结果消息自带的 callId
 * 精确剔除;没有 callId 的旧日志退化为不剔除,宁可多要求一次 present。
 */
function effectiveWrites(slice) {
  const failed = new Set()
  for (const event of slice) {
    if (event?.type !== 'tool/result' || event.data?.message?.isError !== true) continue
    const callId = event.data?.message?.toolCallId ?? event.data?.message?.source?.callId
    if (callId !== undefined) failed.add(callId)
  }
  return slice
    .filter(isFileWrite)
    .filter((call) => !failed.has(call.data?.callId) && !isReadOnlyCall(call))
}

/** 结案判定;reason 供日志与提醒文案选择。 */
export function closureVerdict(events, turn) {
  const slice = turnSlice(events, turn)
  const writes = effectiveWrites(slice)
  const presents = slice.filter(
    (event) => event?.type === 'deliverables/presented' && event.data?.turn === turn,
  )
  const lastPresent = presents.at(-1)
  const presentInvalidated =
    lastPresent !== undefined && writes.some((event) => event.seq > lastPresent.seq)

  if (lastPresent !== undefined && !presentInvalidated) return { closed: true, reason: 'present' }
  if (writes.length > 0) return { closed: false, reason: 'file-write-requires-present' }
  if (matchMarker(lastAssistantText(slice, turn)) !== null) return { closed: true, reason: 'marker' }
  return { closed: false, reason: 'no-signal' }
}
