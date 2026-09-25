// harness 历史到 pi-ai Context 的转换(移植自 dsh-llm-pi-ai context/replay)。
// 文本路径与图片路径与官方逐项对表:图片卸载管线经 images.offload 注入
// (src/image-offload.mjs 特性检测,0.1.7 routed / 0.1.2–0.1.5 transient 双形态),
// offloadedText 为 0.1.2 起导出,经 images.offloadedText 注入以兼容旧宿主,
// 图片仅 user 角色可表示,读出经 attachments 服务转 base64 块;
// systemPrompt 择取同官方 0.1.5 splitSystemPrompt:leading system 折叠为
// systemPrompt(非 leading system 仍投影为 user)。
// finish 块产出官方同构 replayState(pi-ai kind, version 2),后续请求按其重建原生 assistant 历史。
// 0.1.7 历史词汇:tool 结果改为顶层 role:"tool" 消息(旧宿主为 user 消息内
// tool-result 块),developer 角色与 tool-change 块不受支持即拒——两词汇同径兼容。

import { contentHasImage, requestImageHandleText } from '@deepseek-ai/dsh-llm'
import { DEFAULT_IMAGE_MAX_BYTES, DEFAULT_IMAGE_PIXEL_BUDGET } from './config.mjs'
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
  for (const key of ['responseModel', 'responseId', 'providerThinkingLevel']) {
    if (response[key] !== undefined && typeof response[key] !== 'string') throw invalid(`${key} must be a string`)
  }
  if (!Array.isArray(value.blocks)) throw invalid('blocks must be an array')
  for (const block of value.blocks) {
    if (typeof block !== 'object' || block === null) throw invalid('block must be an object')
    if (!['text', 'reasoning', 'tool-call'].includes(block.type)) throw invalid('block has an unknown type')
    for (const signature of ['textSignature', 'thinkingSignature', 'thoughtSignature']) {
      if (block[signature] !== undefined && typeof block[signature] !== 'string') {
        throw invalid(`${signature} must be a string`)
      }
    }
    if (block.redacted !== undefined && typeof block.redacted !== 'boolean') {
      throw invalid('redacted must be boolean')
    }
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
    // anthropic 路由名 ≠ 原生响应模型:发请求按原生模型(responseModel 挪移,官方 0.1.5 同构)
    model: state.response.api === 'anthropic-messages'
      ? state.response.responseModel ?? state.response.model
      : state.response.model,
    ...(state.response.responseModel !== undefined ? { responseModel: state.response.responseModel } : {}),
    ...(state.response.responseId !== undefined ? { responseId: state.response.responseId } : {}),
    ...(state.response.providerThinkingLevel !== undefined
      ? { providerThinkingLevel: state.response.providerThinkingLevel } : {}),
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

/** 成功响应投影为版本化 replay 信封,块序与流序一致。
 *  requestedModel 为请求路由模型(缺省取原生 model);anthropic 原生模型 ≠ 请求模型时
 *  记入 responseModel(官方 0.1.5 挪移同构),重建历史时还原原生模型发请求。
 *  未知块类型产出空洞槽位(官方 map 无 default 同语义):持久化序列化为 null,
 *  读侧形状校验拒整信封,降级 provider 中性历史,而非误标类型造成错位。 */
export function toPiReplayState(message, requestedModel = message.model) {
  const responseModel = message.api === 'anthropic-messages' && message.model !== requestedModel
    ? message.model
    : message.responseModel
  return {
    response: {
      kind: REPLAY_KIND,
      version: REPLAY_VERSION,
      api: message.api,
      provider: message.provider,
      model: requestedModel,
      ...(responseModel !== undefined ? { responseModel } : {}),
      ...(message.responseId !== undefined ? { responseId: message.responseId } : {}),
      ...(message.providerThinkingLevel !== undefined
        ? { providerThinkingLevel: message.providerThinkingLevel } : {}),
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
      if (block.type === 'toolCall') {
        return {
          type: 'tool-call',
          ...(block.thoughtSignature !== undefined ? { thoughtSignature: block.thoughtSignature } : {}),
        }
      }
      return undefined
    }),
  }
}

/**
 * systemPrompt 来源择取(官方 0.1.5 splitSystemPrompt 同构,两转换路径共用):
 * options.system 定义即胜出,历史原样(含 leading system,其仍投 user);
 * 否则 leading system 消息文本升为 systemPrompt 并移出历史,空文本不发 prompt。
 */
function splitSystemPrompt(options) {
  if (options.system !== undefined) {
    return { systemPrompt: options.system, messages: options.messages }
  }
  const [first, ...rest] = options.messages
  if (first?.role !== 'system') {
    return { systemPrompt: undefined, messages: options.messages }
  }
  const text = flattenText(first)
  return { systemPrompt: text.length > 0 ? text : undefined, messages: rest }
}

/** 组装请求级 pi-ai context 信封(官方 toolsOf 同构:延迟加载工具即拒)。 */
function piContext(systemPrompt, options, messages) {
  if (options.tools?.some((tool) => tool.deferLoading === true)) {
    throw new GatewayError('Deferred tool loading is not supported yet', 'UNSUPPORTED_CONTENT')
  }
  const tools = options.tools?.map((tool) => ({
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
  }))
  return {
    ...(systemPrompt !== undefined ? { systemPrompt } : {}),
    messages,
    ...(tools !== undefined && tools.length > 0 ? { tools } : {}),
  }
}

/** 官方 toolResultOf 同构:role:"tool" 消息(0.1.7 词汇)转 pi-ai toolResult。 */
function toolResultMessage(message, toolNames, content) {
  return {
    role: 'toolResult',
    toolCallId: message.toolCallId,
    toolName: toolNames.get(message.toolCallId) ?? 'unknown',
    content: typeof content === 'string'
      ? [{ type: 'text', text: content || NO_OUTPUT_TEXT }]
      : content,
    isError: message.isError ?? false,
    timestamp: TIMESTAMP_ZERO,
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
  const split = splitSystemPrompt(options)
  const toolNames = new Map()
  const messages = []
  for (const message of split.messages) {
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
    if (message.role === 'tool') {
      messages.push(toolResultMessage(message, toolNames, flattenText(message)))
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
  return piContext(split.systemPrompt, options, messages)
}

/** 历史支持性断言(官方 assertSupportedHistory 同语义):
 * developer 角色与 tool-change 块不受支持即拒(0.1.7 词汇,旧宿主不出现);
 * 图片仅 user/tool 结果内可表示。 */
function assertSupportedHistory(messages) {
  for (const message of messages) {
    if (message.role === 'developer') {
      throw new GatewayError('Developer messages are not supported yet', 'UNSUPPORTED_CONTENT')
    }
    if (message.content.some((block) => block.type === 'tool-addition' || block.type === 'tool-removal')) {
      throw new GatewayError('Tool-change blocks require developer role', 'UNSUPPORTED_CONTENT')
    }
    if (message.role !== 'user' && message.role !== 'tool' && contentHasImage(message.content)) {
      throw new GatewayError(
        `pi-ai cannot represent an image in an in-history ${message.role} message`,
        'UNSUPPORTED_CONTENT',
      )
    }
  }
}

/** 递归展开 user 内容块;全文本归并为字符串(官方 userContent 同构)。 */
async function userContent(blocks, requestImages, resolveImageAccess) {
  const content = []
  for (const block of blocks) {
    if (block.type === 'text') {
      if (block.text.length > 0) content.push({ type: 'text', text: block.text })
    } else if (block.type === 'image') {
      const version = requestImages.get(block.attachment.attachmentId)
      content.push({ type: 'text', text: requestImageHandleText(block.attachment, version, resolveImageAccess(block.attachment)) })
      content.push({
        type: 'image',
        data: Buffer.from(version.data).toString('base64'),
        mimeType: version.mediaType,
      })
    } else if (block.type === 'tool-result') {
      const nested = await userContent(block.content, requestImages, resolveImageAccess)
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
    if (block.type === 'image' && block.offloaded !== true) refs.set(block.attachment.attachmentId, block.attachment)
    else if (block.type === 'tool-result') collectImageRefs(block.content, refs)
  }
}

/** 按首次出现顺序读出全部保留请求图片(官方 prepareRequestImages 同构):
 * 读出第二参经 images.offload.requestTarget 适配宿主契约——routed 形态传
 * 精确目标尺寸,transient 形态传预算策略本体。 */
async function prepareRequestImages(messages, attachments, budget, offload, signal) {
  const refs = new Map()
  for (const message of messages) collectImageRefs(message.content, refs)
  const orderedRefs = [...refs.values()]
  const prepared = await Promise.all(orderedRefs.map((ref) => attachments.readImageRequest(
    ref,
    offload.kind === 'routed' ? offload.requestTarget(ref, budget) : budget,
    signal,
  )))
  const versions = new Map()
  for (const [index, ref] of orderedRefs.entries()) versions.set(ref.attachmentId, prepared[index])
  return versions
}

/**
 * 图片路径 harness 历史转 pi-ai Context(官方 toPiContextWithImages 同构):
 * routed(0.1.7+)——先按精确请求字节判定必需卸载量,超限抛
 * IMAGE_OFFLOAD_REQUIRED 由上游标记最旧图片并重试,已标记块投影为占位文本;
 * transient(0.1.2–0.1.5)——两段瞬时投影,声明字节先验预算,读出后按实际
 * 字节精确重排,被裁图片替换为占位文本,恢复路径经 resolveImageAccess 解析。
 * @param {object} options harness 请求
 * @param {object} images 图片路径参数集:{attachments, resolveImageAccess, maxRequestImageBytes, requestImagePolicy, offload(image-offload.mjs 适配器,必填), offloadedText(必填,缺失且图片被裁即抛)}
 * @param {(reason: string) => void} [onDegrade] replay 降级回调
 */
export async function toPiContextWithImages(options, images, onDegrade) {
  const { attachments, resolveImageAccess, maxRequestImageBytes, offloadedText, offload } = images
  const requestImagePolicy = images.requestImagePolicy ?? {
    maxPixels: DEFAULT_IMAGE_PIXEL_BUDGET,
    maxBytes: DEFAULT_IMAGE_MAX_BYTES,
  }
  assertSupportedHistory(options.messages)
  const split = splitSystemPrompt(options)
  const placeholder = (ref) => offloadedText(ref, resolveImageAccess(ref))
  let requestImages
  let exactMessages
  if (offload.kind === 'routed') {
    requestImages = await prepareRequestImages(split.messages, attachments, requestImagePolicy, offload, options.signal)
    const required = offload.required(
      split.messages,
      maxRequestImageBytes,
      (block) => requestImages.get(block.attachment.attachmentId).bytes,
    )
    if (required > 0) throw offload.requiredError(maxRequestImageBytes, required)
    exactMessages = offload.project(split.messages, placeholder)
  } else {
    const requestMessages = offload.project(split.messages, {
      representation: 'base64',
      ...(maxRequestImageBytes === undefined ? {} : { maxBytes: maxRequestImageBytes }),
      byteQuantum: 1,
      byteLength: (ref) => Math.min(ref.bytes, requestImagePolicy.maxBytes),
      placeholder,
    })
    requestImages = await prepareRequestImages(requestMessages, attachments, requestImagePolicy, offload, options.signal)
    exactMessages = offload.project(requestMessages, {
      representation: 'base64',
      ...(maxRequestImageBytes === undefined ? {} : { maxBytes: maxRequestImageBytes }),
      byteQuantum: 1,
      byteLength: (ref) => requestImages.get(ref.attachmentId).bytes,
      placeholder,
    })
  }
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
    if (message.role === 'tool') {
      messages.push(toolResultMessage(message, toolNames, await userContent(message.content, requestImages, resolveImageAccess)))
      continue
    }
    const content = await userContent(message.content.filter((block) => block.type !== 'tool-result'), requestImages, resolveImageAccess)
    const results = message.content.filter((block) => block.type === 'tool-result')
    if (content.length > 0 || results.length === 0) {
      messages.push({ role: 'user', content, timestamp: TIMESTAMP_ZERO })
    }
    for (const result of results) {
      const resultContent = await userContent(result.content, requestImages, resolveImageAccess)
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
  return piContext(split.systemPrompt, options, messages)
}
