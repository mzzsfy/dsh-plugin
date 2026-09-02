// 网关 adapter:按路由构造 pi-ai Model 与 StreamOptions 并调协议模块 streamSimple。
// 纯对象满足 LlmAdapter 协议(dsh 注册处为鸭子类型调用);pi-ai 在流式调用时
// 动态加载,包装载不依赖其可解析性。

import { GatewayError } from './errors.mjs'
import { modelOf, resolveApiKey } from './config.mjs'
import { deriveMarker, markerOnPayload } from './marker.mjs'
import { renderTemplate } from './template.mjs'
import { toPiContext } from './pi-context.mjs'
import { toStreamChunks } from './pi-stream.mjs'

// 模型表未声明 maxTokens 时的请求级输出上限默认值
const DEFAULT_MODEL_MAX_TOKENS = 8192
const DEFAULT_CONTEXT_WINDOW = 200000
const DEFAULT_MODALITIES = ['text']

function zeroCost() {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
}

/**
 * 构造网关 adapter 实例。
 * @param {Map<string, object>} routes 已解析路由表(provider 名 → resolveRoute 产物)
 * @param {(api: string) => Promise<object>} [loadProtocol] 协议模块加载器,默认动态
 *   import pi-ai api 子路径;测试注入 mock。
 */
export function createGatewayAdapter(routes, loadProtocol) {
  const load = loadProtocol ?? ((api) => import(`@earendil-works/pi-ai/api/${api}`))

  function routeOf(provider) {
    const route = routes.get(provider)
    if (route === undefined) {
      throw new GatewayError(`llm-pi-gateway adapter does not own provider "${provider}"`, 'NO_ADAPTER')
    }
    return route
  }

  function modelInfo(route, model) {
    const entry = modelOf(route, model)
    return {
      provider: route.provider,
      id: entry.id,
      name: entry.name,
      inputModalities: entry.input ?? DEFAULT_MODALITIES,
      context: { contextWindow: entry.contextWindow ?? route.contextWindow ?? DEFAULT_CONTEXT_WINDOW },
    }
  }

  /** 由路由与模型条目组装 pi-ai Model 对象(pi-ai 要求 cost/maxTokens 字段)。 */
  function toPiModel(route, entry, contextWindow) {
    return {
      id: entry.id,
      name: entry.name,
      api: route.api,
      provider: route.provider,
      baseUrl: route.baseURL,
      reasoning: entry.reasoning ?? true,
      input: entry.input ?? DEFAULT_MODALITIES,
      cost: zeroCost(),
      contextWindow,
      maxTokens: entry.maxTokens ?? DEFAULT_MODEL_MAX_TOKENS,
      compat: entry.compat,
    }
  }

  async function* stream(options) {
    const route = routeOf(options.provider)
    const entry = modelOf(route, options.model)
    const apiKey = resolveApiKey(route)
    if (typeof options.sessionId !== 'string' || options.sessionId.length === 0) {
      throw new GatewayError('sessionId 必须为非空字符串', 'INVALID_REQUEST')
    }
    const sessionId = options.sessionId
    const marker = deriveMarker(sessionId, route.sessionMarker.prefix)
    // 模板先渲染;pi-ai 原生只转发 metadata.user_id,其余模板键由 onPayload 合入请求体
    const renderedTemplate = renderTemplate(route.metadata ?? {}, { sessionId, marker })
    const context = toPiContext(options)
    const protocol = await load(route.api)
    const events = protocol.streamSimple(toPiModel(route, entry, modelInfo(route, options.model).context.contextWindow), context, {
      ...(apiKey === undefined ? {} : { apiKey }),
      ...(route.cacheRetention === undefined ? {} : { cacheRetention: route.cacheRetention }),
      ...(options.temperature === undefined ? {} : { temperature: options.temperature }),
      ...(options.maxTokens === undefined ? {} : { maxTokens: options.maxTokens }),
      sessionId,
      signal: options.signal,
      headers: route.headers,
      metadata: renderedTemplate,
      onPayload: markerOnPayload(sessionId, {
        api: route.api,
        prefix: route.sessionMarker.prefix,
        enabled: route.sessionMarker.enabled,
        template: renderedTemplate,
      }),
    })
    yield* toStreamChunks(events, options.signal)
  }

  return {
    providerInfo: (provider) => ({ id: provider, name: routeOf(provider).displayName ?? provider }),
    listModels: (provider) => {
      const route = routeOf(provider)
      return Promise.resolve([...route.models.values()].map((entry) => ({
        provider,
        id: entry.id,
        name: entry.name,
        inputModalities: entry.input ?? DEFAULT_MODALITIES,
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
