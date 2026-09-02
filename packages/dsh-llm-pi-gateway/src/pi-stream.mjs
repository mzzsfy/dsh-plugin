// pi-ai 事件流到 harness StreamChunk 的转换(移植自 dsh-llm-pi-ai stream)。
// 错误分类与超窗判定复用 dsh-llm / pi-ai 公共导出,与官方逐项对表;
// pi-ai 失败以终态 error 事件送达,映射为 error/aborted finish 块而非抛出。

import { isContextOverflow } from '@earendil-works/pi-ai'
import {
  QUOTA_EXCEEDED_CODE,
  isContextWindowExceededError,
  isQuotaExceededError,
} from '@deepseek-ai/dsh-llm'
import { toPiReplayState } from './pi-context.mjs'
import { GatewayError } from './errors.mjs'

/** pi-ai usage 映射为 harness 计数;cache 字段仅非零时出现。 */
export function mapUsage(usage) {
  return {
    inputTokens: usage.input,
    outputTokens: usage.output,
    totalTokens: usage.totalTokens,
    ...(usage.cacheRead > 0 ? { cacheReadTokens: usage.cacheRead } : {}),
    ...(usage.cacheWrite > 0 ? { cacheWriteTokens: usage.cacheWrite } : {}),
  }
}

// 错误分类分支与官方 classifyPiAiError 同序:quota 判定优先于 rate limit。
export function classifyPiAiError(message) {
  if (/\b(?:401|403)\b/.test(message)) return 'AUTH'
  if (isQuotaExceededError(message)) return QUOTA_EXCEEDED_CODE
  if (/\b429\b|rate.?limit/i.test(message)) return 'RATE_LIMIT'
  if (/\b413\b|payload too large|request body too large/i.test(message)) return 'INVALID_REQUEST'
  if (/\b400\b|invalid.?request/i.test(message)) return 'INVALID_REQUEST'
  if (/\b5\d\d\b/.test(message)) return 'SERVER'
  if (/\btime(?:d)?\s*out\b|timeout/i.test(message)) return 'TIMEOUT'
  if (/stream ended (?:before|without)\b/i.test(message)) return 'TRANSPORT'
  if (/\b(?:network|connection|socket|fetch)\b|\bECONN[A-Z]+\b/i.test(message)
    || /\bterminated\b|premature close/i.test(message)) {
    return 'TRANSPORT'
  }
  return 'PI_AI_ERROR'
}

/**
 * pi-ai 终态事件映射为 harness finish 原因。
 * 超窗判定双通道(pi-ai usage 判定器 + dsh-llm 官方文本判定器),与官方同构。
 * @param {object} message done/error 事件携带的 assistant 消息
 * @param {number} contextWindow 解析出的目录容量,usage 超窗判定用
 * @param {boolean} callerAborted 调用方已取消时终态错误按 aborted 送达
 */
export function mapStopReason(message, contextWindow, callerAborted = false) {
  const effective = callerAborted && message.stopReason === 'error'
    ? { ...message, stopReason: 'aborted' }
    : message
  const text = effective.errorMessage
  const usageOverflow = isContextOverflow(effective, contextWindow)
  const textOverflow = effective.stopReason === 'error' && text !== undefined && isContextWindowExceededError(text)
  if (usageOverflow || textOverflow) {
    return {
      kind: 'error',
      failure: {
        message: text ?? `pi-ai detected context overflow for model "${effective.model}"`,
        code: 'CONTEXT_WINDOW_EXCEEDED',
      },
    }
  }
  switch (effective.stopReason) {
    case 'stop':
      if (effective.content.length === 0) {
        return {
          kind: 'error',
          failure: {
            message: `model "${effective.model}" returned a completed response with no content`,
            code: 'EMPTY_RESPONSE',
          },
        }
      }
      return { kind: 'stop' }
    case 'length': return { kind: 'max-tokens' }
    case 'toolUse': return { kind: 'tool-calls' }
    case 'pending':
      return {
        kind: 'error',
        failure: { message: `pi-ai stream for model "${effective.model}" ended pending`, code: 'PI_AI_ERROR' },
      }
    case 'deferred':
      return {
        kind: 'error',
        failure: { message: `pi-ai deferred response for model "${effective.model}" is not supported`, code: 'PI_AI_ERROR' },
      }
    case 'aborted':
      return { kind: 'aborted', failure: { message: text ?? 'pi-ai stream aborted', code: 'ABORTED' } }
    case 'error':
      return { kind: 'error', failure: { message: text ?? 'pi-ai stream error', code: classifyPiAiError(text ?? '') } }
    default:
      return { kind: 'error', failure: { message: text ?? 'pi-ai stream error', code: 'PI_AI_ERROR' } }
  }
}

/**
 * pi-ai 事件流转为 harness StreamChunk,以 usage + finish 收尾;
 * 源流无终态事件即抛 STREAM_CLOSED。
 * @param {AsyncIterable<object>} events pi-ai 事件流
 * @param {number} contextWindow 解析出的目录容量,usage 超窗判定用
 * @param {AbortSignal} [callerSignal] 调用方取消信号
 */
export async function* toStreamChunks(events, contextWindow, callerSignal) {
  const toolIds = new Map()
  for await (const event of events) {
    switch (event.type) {
      case 'start':
        break
      case 'text_start':
        yield { type: 'block-start', index: event.contentIndex, blockType: 'text' }
        break
      case 'text_delta':
        yield { type: 'text-delta', index: event.contentIndex, text: event.delta }
        break
      case 'text_end':
        yield { type: 'block-end', index: event.contentIndex, block: { type: 'text', text: event.content } }
        break
      case 'thinking_start':
        yield { type: 'block-start', index: event.contentIndex, blockType: 'reasoning' }
        break
      case 'thinking_delta':
        yield { type: 'reasoning-delta', index: event.contentIndex, text: event.delta }
        break
      case 'thinking_end':
        yield { type: 'block-end', index: event.contentIndex, block: { type: 'reasoning', text: event.content } }
        break
      case 'toolcall_start': {
        const partial = event.partial.content[event.contentIndex]
        const id = partial?.type === 'toolCall' ? partial.id : ''
        const name = partial?.type === 'toolCall' ? partial.name : ''
        toolIds.set(event.contentIndex, { id, name })
        yield { type: 'block-start', index: event.contentIndex, blockType: 'tool-call' }
        break
      }
      case 'toolcall_delta': {
        const known = toolIds.get(event.contentIndex)
        yield {
          type: 'tool-call-delta',
          index: event.contentIndex,
          id: known?.id ?? '',
          ...(known?.name !== undefined && known.name.length > 0 ? { name: known.name } : {}),
          argumentsDelta: event.delta,
        }
        break
      }
      case 'toolcall_end':
        yield {
          type: 'block-end',
          index: event.contentIndex,
          block: {
            type: 'tool-call',
            id: event.toolCall.id,
            name: event.toolCall.name,
            arguments: JSON.stringify(event.toolCall.arguments),
          },
        }
        break
      case 'done':
        if (event.message.usage != null) yield { type: 'usage', usage: mapUsage(event.message.usage) }
        yield { type: 'finish', reason: mapStopReason(event.message, contextWindow), replayState: toPiReplayState(event.message) }
        return
      case 'error':
        if (event.error.usage != null) yield { type: 'usage', usage: mapUsage(event.error.usage) }
        yield { type: 'finish', reason: mapStopReason(event.error, contextWindow, callerSignal?.aborted === true) }
        return
      default:
        break
    }
  }
  throw new GatewayError('pi-ai event stream ended without done/error', 'STREAM_CLOSED')
}
