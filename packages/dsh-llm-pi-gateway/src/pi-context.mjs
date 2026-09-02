// harness 历史到 pi-ai Context 的转换(移植自 dsh-llm-pi-ai context/replay)。
// 文本路径与图片路径与官方逐项对表:图片管线复用 dsh-llm 公共导出
// (contentHasImage / offloadRequestImagesWithPolicy / requestImageHandleText),
// 图片仅 user 角色可表示,读出经 attachments 服务转 base64 块。
// finish 块产出官方同构 replayState(pi-ai kind, version 2),后续请求按其重建原生 assistant 历史。

import { contentHasImage, offloadRequestImagesWithPolicy, requestImageHandleText } from '@deepseek-ai/dsh-llm'
import { GatewayError } from './errors.mjs'

const TIMESTAMP_ZERO = 0
const NO_OUTPUT_TEXT = '(no output)'
const REPLAY_KIND = 'pi-ai'
const REPLAY_VERSION = 2
const FOREIGN_IDENTITY = 'dsh-foreign'

/** 拼接一条 harness 消息的全部 text 块。 */
function flattenText(message) {
  return message.content
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('')
}

/** 递归展平 tool result 内文本。 */
function toolResultText(blocks) {
  return blocks
    .map((block) => (block.type === 'text'
      ? block.text
      : block.type === 'tool-result' ? toolResultText(block.content) : ''))
    .join('')
}

/** 解析 tool-call 参数 JSON,模型畸形输出以 {} 容忍。 */
function parseArguments(raw) {
  try {
    const parsed = JSON.parse(raw)
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) return parsed
  } catch {
    // 模型畸形参数容忍为空对象
  }
  return {}
}

function emptyPiUsage() {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  }
}

/** 无 replay 状态(或不可用)时的 provider 中性 assistant 历史。 */
function foreignAssistant(message) {
  const content = []
  for (const block of message.content) {
    if (block.type === 'text') content.push({ type: 'text', text: block.text })
    else if (block.type === 'reasoning') content.push({ type: 'thinking', thinking: block.text })
    else if (block.type === 'tool-call') {
      content.push({ type: 'toolCall', id: block.id, name: block.name, arguments: parseArguments(block.arguments) })
    } else if (block.type === 'image') {
      throw new GatewayError('llm-pi-gateway 历史中不能表示结构化 assistant 图片输出', 'UNSUPPORTED_CONTENT')
    }
    // 其余插件块类型不在 pi-ai 词汇内,跳过
  }
  const source = message.source?.kind === 'model' ? message.source : undefined
  return {
    role: 'assistant',
    content,
    // 刻意不等于任何目录 api:无 replay 状态即外来历史
    api: FOREIGN_IDENTITY,
    provider: source?.provider ?? FOREIGN_IDENTITY,
    model: source?.model ?? FOREIGN_IDENTITY,
    usage: emptyPiUsage(),
    stopReason: content.some((block) => block.type === 'toolCall') ? 'toolUse' : 'stop',
    timestamp: TIMESTAMP_ZERO,
  }
}

/** 校验持久化 replay 信封,格式不符即抛 INVALID_REPLAY_STATE。 */
function readReplayState(value) {
  const invalid = (reason) => new GatewayError(`invalid pi-ai replay state: ${reason}`, 'INVALID_REPLAY_STATE')
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw invalid('expected a replay envelope')
  const response = value.response
  if (typeof response !== 'object' || response === null) throw invalid('expected a response object')
  if (response.kind !== REPLAY_KIND) throw invalid('unknown state kind')
  if (response.version !== REPLAY_VERSION) throw invalid(`unsupported version ${String(response.version)}`)
  for (const key of ['api', 'provider', 'model']) {
    if (typeof response[key] !== 'string' || response[key].length === 0) throw invalid(`${key} must be a non-empty string`)
  }
  if (!['stop', 'length', 'toolUse', 'error', 'aborted'].includes(response.stopReason)) {
    throw invalid('unknown stopReason')
  }
  if (!Array.isArray(value.blocks)) throw invalid('blocks must be an array')
  for (const block of value.blocks) {
    if (typeof block !== 'object' || block === null) throw invalid('block must be an object')
    if (!['text', 'reasoning', 'tool-call'].includes(block.type)) throw invalid('block has an unknown type')
  }
  return value
}

/** 用持久化内容 + replay 元数据重建原生 pi-ai assistant 消息。 */
function replayedAssistant(message, source, rawState) {
  const state = readReplayState(rawState)
  const invalid = (reason) => {
    throw new GatewayError(`invalid pi-ai replay state: ${reason}`, 'INVALID_REPLAY_STATE')
  }
  if (state.response.provider !== source.provider) invalid('provider does not match assistant source')
  if (state.response.model !== source.model) invalid('model does not match assistant source')
  if (state.blocks.length !== message.content.length) invalid('block count does not match assistant content')
  const content = message.content.map((block, index) => {
    const replay = state.blocks[index]
    if (replay === undefined || replay.type !== block.type) invalid(`block ${index} does not match assistant content`)
    if (block.type === 'text') {
      return {
        type: 'text',
        text: block.text,
        ...(replay.textSignature !== undefined ? { textSignature: replay.textSignature } : {}),
      }
    }
    if (block.type === 'reasoning') {
      return {
        type: 'thinking',
        thinking: block.text,
        ...(replay.thinkingSignature !== undefined ? { thinkingSignature: replay.thinkingSignature } : {}),
        ...(replay.redacted !== undefined ? { redacted: replay.redacted } : {}),
      }
    }
    return {
      type: 'toolCall',
      id: block.id,
      name: block.name,
      arguments: parseArguments(block.arguments),
      ...(replay.thoughtSignature !== undefined ? { thoughtSignature: replay.thoughtSignature } : {}),
    }
  })
  return {
    role: 'assistant',
    content,
    api: state.response.api,
    provider: state.response.provider,
    model: state.response.model,
    ...(state.response.responseModel !== undefined ? { responseModel: state.response.responseModel } : {}),
    ...(state.response.responseId !== undefined ? { responseId: state.response.responseId } : {}),
    usage: emptyPiUsage(),
    stopReason: state.response.stopReason,
    timestamp: TIMESTAMP_ZERO,
  }
}

/**
 * harness assistant 消息转 pi-ai 历史:持久化内容是权威,replay 元数据只恢复
 * 原生保真度(签名等);不可用的 replay 降级为 provider 中性历史而非失败。
 * @param {object} message harness assistant 消息
 * @param {(reason: string) => void} [onDegrade] 降级诊断回调
 */
export function toPiAssistant(message, onDegrade) {
  const source = message.source
  if (source?.kind !== 'model' || source.replayState === undefined) return foreignAssistant(message)
  try {
    return replayedAssistant(message, source, source.replayState)
  } catch (error) {
    if (error?.code !== 'INVALID_REPLAY_STATE') throw error
    onDegrade?.(error.message)
    return foreignAssistant(message)
  }
}

/** 成功响应投影为版本化 replay 信封,块序与流序一致。 */
export function toPiReplayState(message) {
  return {
    response: {
      kind: REPLAY_KIND,
      version: REPLAY_VERSION,
      api: message.api,
      provider: message.provider,
      model: message.model,
      ...(message.responseModel !== undefined ? { responseModel: message.responseModel } : {}),
      ...(message.responseId !== undefined ? { responseId: message.responseId } : {}),
      stopReason: message.stopReason,
    },
    blocks: message.content.map((block) => {
      if (block.type === 'text') {
        return { type: 'text', ...(block.textSignature !== undefined ? { textSignature: block.textSignature } : {}) }
      }
      if (block.type === 'thinking') {
        return {
          type: 'reasoning',
          ...(block.thinkingSignature !== undefined ? { thinkingSignature: block.thinkingSignature } : {}),
          ...(block.redacted !== undefined ? { redacted: block.redacted } : {}),
        }
      }
      return {
        type: 'tool-call',
        ...(block.thoughtSignature !== undefined ? { thoughtSignature: block.thoughtSignature } : {}),
      }
    }),
  }
}

/** 组装请求级 pi-ai context 信封。 */
function piContext(options, messages) {
  const tools = options.tools?.map((tool) => ({
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
  }))
  return {
    ...(options.system !== undefined ? { systemPrompt: options.system } : {}),
    messages,
    ...(tools !== undefined && tools.length > 0 ? { tools } : {}),
  }
}

/**
 * 文本 harness 历史转 pi-ai Context;tool result 名从前置 assistant tool-call 恢复。
 * 遇图片即拒(官方文本路径同语义:图片输入需要 attachments 服务)。
 * @param {object} options harness 请求
 * @param {(reason: string) => void} [onDegrade] replay 降级回调
 */
export function toPiContext(options, onDegrade) {
  for (const message of options.messages) {
    if (contentHasImage(message.content)) {
      throw new GatewayError('pi-ai image conversion requires the durable attachment service', 'UNSUPPORTED_CONTENT')
    }
  }
  const toolNames = new Map()
  const messages = []
  for (const message of options.messages) {
    if (message.role === 'system') {
      messages.push({ role: 'user', content: flattenText(message), timestamp: TIMESTAMP_ZERO })
      continue
    }
    if (message.role === 'assistant') {
      const assistant = toPiAssistant(message, onDegrade)
      for (const block of assistant.content) {
        if (block.type === 'toolCall') toolNames.set(block.id, block.name)
      }
      messages.push(assistant)
      continue
    }
    const text = flattenText(message)
    const results = message.content.filter((block) => block.type === 'tool-result')
    if (text.length > 0 || results.length === 0) {
      messages.push({ role: 'user', content: text, timestamp: TIMESTAMP_ZERO })
    }
    for (const result of results) {
      messages.push({
        role: 'toolResult',
        toolCallId: result.toolCallId,
        toolName: toolNames.get(result.toolCallId) ?? 'unknown',
        content: [{ type: 'text', text: toolResultText(result.content) || NO_OUTPUT_TEXT }],
        isError: result.isError ?? false,
        timestamp: TIMESTAMP_ZERO,
      })
    }
  }
  return piContext(options, messages)
}

/** 图片仅 user 角色可表示(官方 assertSupportedImageRoles 同语义)。 */
function assertSupportedImageRoles(messages) {
  for (const message of messages) {
    if (message.role !== 'user' && contentHasImage(message.content)) {
      throw new GatewayError(
        `pi-ai cannot represent an image in an in-history ${message.role} message`,
        'UNSUPPORTED_CONTENT',
      )
    }
  }
}

/** 递归展开 user 内容块;全文本归并为字符串(官方 userContent 同构)。 */
async function userContent(blocks, requestImages) {
  const content = []
  for (const block of blocks) {
    if (block.type === 'text') {
      if (block.text.length > 0) content.push({ type: 'text', text: block.text })
    } else if (block.type === 'image') {
      const version = requestImages.get(block.attachment.attachmentId)
      content.push({ type: 'text', text: requestImageHandleText(version) })
      content.push({
        type: 'image',
        data: Buffer.from(version.data).toString('base64'),
        mimeType: version.mediaType,
      })
    } else if (block.type === 'tool-result') {
      const nested = await userContent(block.content, requestImages)
      if (typeof nested === 'string') {
        if (nested.length > 0) content.push({ type: 'text', text: nested })
      } else {
        content.push(...nested)
      }
    }
  }
  if (content.every((block) => block.type === 'text')) return content.map((block) => block.text).join('')
  return content
}

function collectImageRefs(blocks, refs) {
  for (const block of blocks) {
    if (block.type === 'image') refs.set(block.attachment.attachmentId, block.attachment)
    else if (block.type === 'tool-result') collectImageRefs(block.content, refs)
  }
}

/** 按首次出现顺序读出全部请求图片(官方 prepareRequestImages 同构)。 */
async function prepareRequestImages(messages, attachments, policy, signal) {
  const refs = new Map()
  for (const message of messages) collectImageRefs(message.content, refs)
  const orderedRefs = [...refs.values()]
  const prepared = await Promise.all(orderedRefs.map((ref) => attachments.readImageRequest(ref, policy, signal)))
  const versions = new Map()
  for (const [index, ref] of orderedRefs.entries()) versions.set(ref.attachmentId, prepared[index])
  return versions
}

/**
 * 图片路径 harness 历史转 pi-ai Context(官方 toPiContextWithImages 同构):
 * 两段 offload——声明字节先验预算,读出后按实际字节精确重排;图片转 base64 块。
 * @param {object} options harness 请求
 * @param {object} attachments attachments 服务(readImageRequest)
 * @param {(reason: string) => void} [onDegrade] replay 降级回调
 * @param {number} [maxRequestImageBytes] 路由级请求图片字节预算
 * @param {{maxPixels: number, maxBytes: number}} requestImagePolicy 单图读出预算
 */
export async function toPiContextWithImages(options, attachments, onDegrade, maxRequestImageBytes, requestImagePolicy = {
  maxPixels: DEFAULT_IMAGE_PIXEL_BUDGET,
  maxBytes: DEFAULT_IMAGE_MAX_BYTES,
}) {
  assertSupportedImageRoles(options.messages)
  const requestMessages = offloadRequestImagesWithPolicy(options.messages, {
    representation: 'base64',
    ...(maxRequestImageBytes === undefined ? {} : { maxBytes: maxRequestImageBytes }),
    byteQuantum: 1,
    byteLength: (ref) => Math.min(ref.bytes, requestImagePolicy.maxBytes),
  })
  const requestImages = await prepareRequestImages(requestMessages, attachments, requestImagePolicy, options.signal)
  const exactMessages = offloadRequestImagesWithPolicy(requestMessages, {
    representation: 'base64',
    ...(maxRequestImageBytes === undefined ? {} : { maxBytes: maxRequestImageBytes }),
    byteQuantum: 1,
    byteLength: (ref) => requestImages.get(ref.attachmentId).bytes,
  })
  const toolNames = new Map()
  const messages = []
  for (const message of exactMessages) {
    if (message.role === 'system') {
      messages.push({ role: 'user', content: flattenText(message), timestamp: TIMESTAMP_ZERO })
      continue
    }
    if (message.role === 'assistant') {
      const assistant = toPiAssistant(message, onDegrade)
      for (const block of assistant.content) {
        if (block.type === 'toolCall') toolNames.set(block.id, block.name)
      }
      messages.push(assistant)
      continue
    }
    const content = await userContent(message.content.filter((block) => block.type !== 'tool-result'), requestImages)
    const results = message.content.filter((block) => block.type === 'tool-result')
    if (content.length > 0 || results.length === 0) {
      messages.push({ role: 'user', content, timestamp: TIMESTAMP_ZERO })
    }
    for (const result of results) {
      const resultContent = await userContent(result.content, requestImages)
      messages.push({
        role: 'toolResult',
        toolCallId: result.toolCallId,
        toolName: toolNames.get(result.toolCallId) ?? 'unknown',
        content: typeof resultContent === 'string'
          ? [{ type: 'text', text: resultContent || NO_OUTPUT_TEXT }]
          : resultContent,
        isError: result.isError ?? false,
        timestamp: TIMESTAMP_ZERO,
      })
    }
  }
  return piContext(options, messages)
}

// 单图读出预算缺省,与官方 DEFAULT_REQUEST_IMAGE_PIXEL_BUDGET / DEFAULT_REQUEST_IMAGE_MAX_BYTES 一致
const DEFAULT_IMAGE_PIXEL_BUDGET = 4 * 1024 * 1024
const DEFAULT_IMAGE_MAX_BYTES = 1024 * 1024
