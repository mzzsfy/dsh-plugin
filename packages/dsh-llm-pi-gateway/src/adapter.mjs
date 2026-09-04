// 网关 adapter:按路由构造 pi-ai Model 与 StreamOptions 并调协议模块 streamSimple。
// 请求选项装配与官方 dsh-llm-pi-ai 逐项对表(effort 校验链 / profileOptions /
// attribution 头 / 凭据链),差异仅为本包的标记器与 metadata 模板注入。
// 纯对象满足 LlmAdapter 协议;路由表经 getter 读取,支持热更新原地换表。

import { getSupportedThinkingLevels } from '@earendil-works/pi-ai'
import { ReasoningEffortId, contentHasImage } from '@deepseek-ai/dsh-llm'
import { GatewayError } from './errors.mjs'
import { modelOf, PROTOCOL_MODULES } from './config.mjs'
import { deriveMarker, markerOnPayload } from './marker.mjs'
import { renderTemplate } from './template.mjs'
import { toPiContext, toPiContextWithImages } from './pi-context.mjs'
import { toStreamChunks } from './pi-stream.mjs'
import { requestHeaders } from './headers.mjs'
import { createCredentialResolver } from './credentials.mjs'

/**
 * 校验请求/路由档位确为该模型支持,不支持即拒(请求路径严格,同官方)。
 */
function resolveReasoningLevel(model, effort) {
  if (effort === undefined) return undefined
  if (getSupportedThinkingLevels(model).some((level) => level === effort)) return effort
  throw new GatewayError(
    `pi-ai provider "${model.provider}" model "${model.id}" does not support reasoning effort "${effort}"`,
    'UNSUPPORTED_REASONING_EFFORT',
  )
}

/**
 * 模型可描述的默认档位:不支持时省略而非抛出——目录描述失败会把整个
 * 路由从选择器里藏掉(官方同款取舍),坏配置在请求路径拒绝。
 */
function describableReasoningLevel(model, effort) {
  if (effort === undefined) return undefined
  return getSupportedThinkingLevels(model).some((level) => level === effort) ? effort : undefined
}

/** 模型可选档位声明;非推理模型不声明(官方 reasoningInfo 同构)。 */
function reasoningInfo(model, defaultLevel) {
  if (!model.reasoning) return {}
  return {
    reasoning: {
      efforts: getSupportedThinkingLevels(model).map((level) => ({
        id: ReasoningEffortId(level),
        name: `${level.charAt(0).toUpperCase()}${level.slice(1)}`,
      })),
      ...(defaultLevel === undefined ? {} : { defaultEffort: ReasoningEffortId(defaultLevel) }),
    },
  }
}

/**
 * 构造网关 adapter 实例。
 * @param {Map<string, object> | () => Map<string, object>} routes 路由表或其 getter
 * @param {(api: string) => Promise<object>} [loadProtocol] 协议模块加载器,默认动态
 *   import pi-ai api 子路径;测试注入 mock。
 * @param {(provider: string, ref?: string) => Promise<string|undefined>} [resolveCredential]
 *   凭据解析器,默认走官方链(无凭据服务时回落启动环境)。
 * @param {() => object|undefined} [resolveAttachments] attachments 服务读取器
 * @param {(reason: string) => void} [onDegrade] replay 降级诊断回调
 * @param {(attachments: object, ref: object) => object|undefined} [resolveImageAccess] 图片恢复路径解析:attachments 与引用解析为工具执行世界访问,无映射即 undefined
 * @param {(ref: object, access: object|undefined) => string} offloadedText 被预算裁掉的图片占位文本(dsh-llm offloadedImageText,0.1.2 起提供,宿主探测后必传;图片路径硬依赖)
 */
export function createGatewayAdapter(routes, loadProtocol, resolveCredential = createCredentialResolver({ get: () => undefined }), resolveAttachments = () => undefined, onDegrade, resolveImageAccess, offloadedText) {
  const routesOf = () => (typeof routes === 'function' ? routes() : routes)
  const load = loadProtocol ?? ((api) => import(PROTOCOL_MODULES[api]))

  function routeOf(provider) {
    const route = routesOf().get(provider)
    if (route === undefined) {
      throw new GatewayError(`llm-pi-gateway adapter does not own provider "${provider}"`, 'NO_ADAPTER')
    }
    return route
  }

  function modelInfo(route, model) {
    const entry = modelOf(route, model)
    const piModel = toPiModel(route, entry)
    const defaultLevel = describableReasoningLevel(piModel, route.reasoning)
    return {
      provider: route.provider,
      id: entry.id,
      name: entry.name,
      inputModalities: entry.input ?? route.defaultInput,
      context: { contextWindow: entry.contextWindow ?? route.defaultContextWindow },
      ...(entry.maxTokens === undefined ? {} : { defaultMaxTokens: entry.maxTokens }),
      ...reasoningInfo(piModel, defaultLevel),
    }
  }

  /** 由路由与模型条目组装 pi-ai Model 对象(pi-ai 要求 cost/maxTokens 字段)。 */
  function toPiModel(route, entry) {
    return {
      id: entry.id,
      name: entry.name,
      api: route.api,
      provider: route.provider,
      baseUrl: route.baseURL,
      reasoning: entry.reasoning,
      ...(entry.thinkingLevelMap === undefined ? {} : { thinkingLevelMap: entry.thinkingLevelMap }),
      input: entry.input ?? route.defaultInput,
      cost: zeroCost(),
      contextWindow: entry.contextWindow ?? route.defaultContextWindow,
      maxTokens: entry.maxTokens ?? route.defaultMaxTokens,
      compat: entry.compat,
    }
  }

  async function* stream(options) {
    const route = routeOf(options.provider)
    const entry = modelOf(route, options.model)
    // 纯入参校验先于凭据解析:坏请求不消耗凭据链副作用
    if (typeof options.sessionId !== 'string' || options.sessionId.length === 0) {
      throw new GatewayError('sessionId 必须为非空字符串', 'INVALID_REQUEST')
    }
    const sessionId = options.sessionId
    const piModel = toPiModel(route, entry)
    const reasoning = resolveReasoningLevel(piModel, options.reasoningEffort ?? route.reasoning)
    const enabledReasoning = reasoning === 'off' ? undefined : reasoning
    const apiKey = await resolveCredential(options.provider, route.apiKeyEnv)
    const marker = deriveMarker(sessionId, route.sessionMarker.prefix)
    // 模板先渲染;pi-ai 原生只转发 metadata.user_id,其余模板键由 onPayload 合入请求体
    const renderedTemplate = renderTemplate(route.metadata ?? {}, { sessionId, marker })
    const containsImage = options.messages.some((message) => contentHasImage(message.content))
    if (containsImage && !piModel.input.includes('image')) {
      throw new GatewayError(`pi-ai model "${piModel.id}" does not support image input`, 'UNSUPPORTED_CONTENT')
    }
    const attachments = containsImage ? resolveAttachments() : undefined
    if (containsImage && attachments === undefined) {
      throw new GatewayError('pi-ai image input requires the durable attachment service', 'UNSUPPORTED_CONTENT')
    }
    const context = attachments === undefined
      ? toPiContext(options, onDegrade)
      : await toPiContextWithImages(options, {
        attachments,
        resolveImageAccess: (ref) => resolveImageAccess?.(attachments, ref),
        maxRequestImageBytes: route.maxRequestImageBytes,
        offloadedText,
        requestImagePolicy: {
          maxPixels: route.requestImagePixelBudget,
          maxBytes: route.requestImageMaxBytes,
        },
      }, onDegrade)
    const protocol = await load(route.api)
    const events = protocol.streamSimple(piModel, context, {
      ...(apiKey === undefined ? {} : { apiKey }),
      ...(enabledReasoning === undefined ? {} : { reasoning: enabledReasoning }),
      ...(route.thinkingBudgets === undefined ? {} : { thinkingBudgets: route.thinkingBudgets }),
      ...(route.cacheRetention === undefined ? {} : { cacheRetention: route.cacheRetention }),
      ...(route.transport === undefined ? {} : { transport: route.transport }),
      ...(route.timeoutMs === undefined ? {} : { timeoutMs: route.timeoutMs }),
      ...(route.websocketConnectTimeoutMs === undefined ? {} : { websocketConnectTimeoutMs: route.websocketConnectTimeoutMs }),
      maxRetries: 0,
      ...(options.temperature === undefined ? {} : { temperature: options.temperature }),
      ...(options.maxTokens === undefined ? {} : { maxTokens: options.maxTokens }),
      sessionId,
      signal: options.signal,
      headers: requestHeaders(route.headers),
      metadata: renderedTemplate,
      onPayload: markerOnPayload(sessionId, {
        api: route.api,
        prefix: route.sessionMarker.prefix,
        enabled: route.sessionMarker.enabled,
        template: renderedTemplate,
        marker,
      }),
    })
    yield* toStreamChunks(events, piModel.contextWindow, options.signal)
  }

  return {
    providerInfo: (provider) => ({ id: provider, name: routeOf(provider).displayName ?? provider }),
    providerRetryPolicy: (provider) => routeOf(provider).retryPolicy,
    listModels: (provider) => {
      const route = routeOf(provider)
      return Promise.resolve([...route.models.values()].map((entry) => ({
        provider,
        id: entry.id,
        name: entry.name,
        inputModalities: entry.input ?? route.defaultInput,
      })))
    },
    resolveModel: (provider, model) => Promise.resolve(modelInfo(routeOf(provider), model)),
    prepareCall: (provider, model) => {
      const route = routeOf(provider)
      return Promise.resolve({
        model: modelInfo(route, model),
        stream: (options) => stream(options),
      })
    },
    stream,
  }
}

function zeroCost() {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
}
