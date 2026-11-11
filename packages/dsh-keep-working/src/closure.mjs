/**
 * 结案判定:纯函数层,不依赖宿主服务。
 *
 * 判定对象是一个 turn 的事件切片。结案凭据有两种:
 * - present:本回合成功交付文件,且交付之后没有再改文件
 * - marker:末行独占 (TASK_DONE) 或 (TASK_BLOCKED: ...)
 *
 * 有文件写入的回合只认 present,否则模型会退化成写一行标记就交差。
 */

export const DONE_MARKER = '(TASK_DONE)'
export const BLOCKED_PREFIX = '(TASK_BLOCKED'

/** 宿主写文件的工具名;新增写入面时在此登记。 */
export const FILE_WRITE_TOOLS = new Set(['write', 'edit', 'apply_patch', 'str_replace_editor'])

/** 末行尾部的句号与包裹反引号属于排版噪声,不参与匹配。 */
const TRAILING_NOISE = /[.。]+$/
const WRAPPING_TICKS = /^`+|`+$/g

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

/** 末行标记;仅识别独占最后一行的写法。 */
export function matchMarker(text) {
  if (typeof text !== 'string' || text === '') return null
  const lines = text.trimEnd().split('\n')
  const last = (lines.at(-1) ?? '')
    .trim()
    .replace(WRAPPING_TICKS, '')
    .trim()
    .replace(TRAILING_NOISE, '')
    .trim()
  if (last === DONE_MARKER) return 'done'
  if (last.startsWith(BLOCKED_PREFIX)) return 'blocked'
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

/** 维护轮由 message-ops 标记,不参与结案与恢复。 */
export function isMaintenanceTurnStart(event) {
  return event?.data?.reason === 'message-ops'
}

/** 本回合首个用户消息的来源类型;缺失表示无用户输入。 */
export function turnInitiator(events, turn) {
  const slice = turnSlice(events, turn)
  for (const event of slice) {
    if (event?.type === 'user/message') return event.data?.source?.kind
  }
  return undefined
}

/** 用户在本回合中途插话:结案提醒让路,避免与人的意图抢方向。 */
export function userTookOver(events, turn, excludeIds) {
  const slice = turnSlice(events, turn)
  const first = slice.findIndex((event) => event?.type === 'user/message')
  if (first === -1) return false
  return slice
    .slice(first + 1)
    .some(
      (event) =>
        event?.type === 'user/message' &&
        event.data?.source?.kind === 'user' &&
        excludeIds?.has?.(event.data?.id) !== true,
    )
}

const isFileWrite = (event) => event?.type === 'tool/call' && FILE_WRITE_TOOLS.has(event.data?.name)

/** 结案判定;reason 供日志与提醒文案选择。 */
export function closureVerdict(events, turn) {
  const slice = turnSlice(events, turn)
  const writes = slice.filter(isFileWrite)
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
