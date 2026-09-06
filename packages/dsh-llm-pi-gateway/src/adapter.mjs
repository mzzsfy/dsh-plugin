// 网关 adapter:按路由构造 pi-ai Model 与 StreamOptions 并调协议模块 streamSimple。
// 请求选项装配与官方 dsh-llm-pi-ai 逐项对表(effort 校验链 / profileOptions /
// attribution 头 / 凭据链),差异仅为本包的标记器与 metadata 模板注入。
// 纯对象挂 LlmAdapter 原型满足协议(继承基类默认方法);路由表经 getter 读取,支持热更新原地换表。

import { getSupportedThinkingLevels } from '@earendil-works/pi-ai'
import { LlmAdapter, ReasoningEffortId, contentHasImage } from '@deepseek-ai/dsh-llm'
import { GatewayError } from './errors.mjs'
import { modelOf, PROTOCOL_MODULES } from './config.mjs'
import { deriveMarker, markerOnPayload } from './marker.mjs'
import { renderTemplate, templateUsesSessionId } from './template.mjs'
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

  /** 流主链:路由/模型条目由调用方快照冻结传入(prepareCall 与公共 stream 各自解析)。 */
  async function* streamWithRoute(options, route, entry) {
    // 官方语义:不支持请求选项显式拒绝,防静默吞错(官方 streamWithSnapshot 同位,
    // prepareCall 与公共 stream 两条入口在此汇合自然全覆盖;值判断对 {stop:undefined} 放行)
    if (options?.stop !== undefined) {
      throw new GatewayError('请求选项 "stop" 不受网关支持(终止请走 AbortSignal)', 'UNSUPPORTED_OPTION')
    }
    // 纯入参校验先于凭据解析:坏请求不消耗凭据链副作用
    // sessionId 官方契约可缺省:标记关闭且模板不引用时放行缺失,零感知接管不侵蚀
    const needsSessionId = route.sessionMarker.enabled || templateUsesSessionId(route.metadata)
    if (needsSessionId && (typeof options.sessionId !== 'string' || options.sessionId.length === 0)) {
      throw new GatewayError('sessionId 必须为非空字符串(该路由的会话标记或 metadata 模板依赖它)', 'INVALID_REQUEST')
    }
    const sessionId = typeof options.sessionId === 'string' && options.sessionId.length > 0 ? options.sessionId : ''
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
      // 官方 wire 契约:缺省即省略键(空串会被 pi-ai clamp 成 prompt_cache_key:'' 共享空桶)
      ...(sessionId === '' ? {} : { sessionId }),
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
    try {
      yield* toStreamChunks(events, piModel.contextWindow, options.signal)
    } catch (error) {
      // 源流在调用方已取消时的抛出形态不可控(上游网络栈各异),出口兜底归因 ABORTED,
      // 与官方「aborted 优先归因、不落 UNKNOWN」同构;唯一豁免是已是 ABORTED 的信封防双包
      if (options.signal?.aborted === true && error?.code !== 'ABORTED') {
        throw new GatewayError('pi-ai request aborted by caller', 'ABORTED', { cause: error })
      }
      throw error
    }
  }

  /** 公共流入口:路由即时解析,供未走 prepareCall 的直接调用。 */
  async function* stream(options) {
    const route = routeOf(options.provider)
    const entry = modelOf(route, options.model)
    yield* streamWithRoute(options, route, entry)
  }

  return (
    // 官方 PiAiAdapter 同构:挂 LlmAdapter 原型继承基类默认方法(如 imageRequestPricing),
    // 宿主接口演进新增默认实现时自动跟随,避免纯对象协议缺口
    Object.assign(Object.create(LlmAdapter.prototype), {
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
      // 解析结果快照冻结:prepareCall 与后续 stream 回调绑定同一路由/模型条目,
      // 热更换表不产生「目录信息旧代 + 请求路由新代」的错配(官方同构)
      const route = routeOf(provider)
      const entry = modelOf(route, model)
      return Promise.resolve({
        model: modelInfo(route, model),
        stream: (options) => streamWithRoute(options, route, entry),
      })
    },
    stream,
    })
  )
}
function zeroCost() {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
}
