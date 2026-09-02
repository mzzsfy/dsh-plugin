// 路由配置解析:compat 全控(按协议字段名单校验,值不可为 null)、
// 模型级 compat 浅合并覆盖路由级、模型表解析。纯函数,无 I/O。

import { GatewayError } from './errors.mjs'

/** 本包支持的 pi-ai 协议与其 api 模块子路径。 */
export const PROTOCOL_MODULES = {
  'anthropic-messages': '@earendil-works/pi-ai/api/anthropic-messages',
  'openai-completions': '@earendil-works/pi-ai/api/openai-completions',
  'openai-responses': '@earendil-works/pi-ai/api/openai-responses',
}

// compat 字段名单取自 pi-ai@0.84 各协议 compat 类型声明(类型即边界);
// 升级 pi-ai 依赖时必须同步核对本名单,新增/移除字段需同步。
const ANTHROPIC_COMPAT_FIELDS = [
  'supportsEagerToolInputStreaming',
  'supportsLongCacheRetention',
  'sendSessionAffinityHeaders',
  'supportsCacheControlOnTools',
  'supportsTemperature',
  'forceAdaptiveThinking',
  'allowEmptySignature',
  'supportsStrictTools',
  'supportsToolReferences',
]

const OPENAI_COMPLETIONS_COMPAT_FIELDS = [
  'supportsStore',
  'supportsDeveloperRole',
  'supportsReasoningEffort',
  'supportsUsageInStreaming',
  'supportsFinishReason',
  'maxTokensField',
  'requiresToolResultName',
  'requiresAssistantAfterToolResult',
  'requiresThinkingAsText',
  'requiresReasoningContentOnAssistantMessages',
  'thinkingFormat',
  'chatTemplateKwargs',
  'chatTemplateArgs',
  'supportsThinkingTokenBudget',
  'supportsStrictMode',
  'cacheControlFormat',
  'supportsLongCacheRetention',
  'openRouterRouting',
  'vercelGatewayRouting',
  'zaiToolStream',
  'supportsOpenAIGrammarTools',
  'sendSessionAffinityHeaders',
  'deferredToolsMode',
  'sessionAffinityFormat',
]

const OPENAI_RESPONSES_COMPAT_FIELDS = [
  'supportsDeveloperRole',
  'sessionAffinityFormat',
  'supportsLongCacheRetention',
  'supportsStrictMode',
  'supportsOpenAIGrammarTools',
  'supportsAdditionalTools',
  'supportsToolSearch',
  'supportsExplicitPromptCacheMode',
]

const COMPAT_FIELDS_BY_PROTOCOL = {
  'anthropic-messages': ANTHROPIC_COMPAT_FIELDS,
  'openai-completions': OPENAI_COMPLETIONS_COMPAT_FIELDS,
  'openai-responses': OPENAI_RESPONSES_COMPAT_FIELDS,
}

const MODALITIES = ['text', 'image']

/** 校验一个 compat 对象:字段须在该协议 compat 类型内,值不可为 null/undefined。 */
export function validateCompat(protocol, compat, where) {
  if (compat === undefined) return undefined
  if (typeof compat !== 'object' || compat === null || Array.isArray(compat)) {
    throw new GatewayError(`${where}: compat 必须是对象`, 'INVALID_CONFIG')
  }
  const known = COMPAT_FIELDS_BY_PROTOCOL[protocol]
  if (known === undefined) {
    throw new GatewayError(`${where}: 未知协议 "${protocol}"`, 'INVALID_CONFIG')
  }
  const allowed = new Set(known)
  for (const [key, value] of Object.entries(compat)) {
    if (!allowed.has(key)) {
      throw new GatewayError(
        `${where}: compat 字段 "${key}" 不在协议 ${protocol} 的 compat 类型内,可用字段: ${known.join(', ')}`,
        'INVALID_CONFIG',
      )
    }
    if (value === null || value === undefined) {
      throw new GatewayError(`${where}: compat 字段 "${key}" 的值不可为空`, 'INVALID_CONFIG')
    }
  }
  return { ...compat }
}

/** compat 浅合并:模型级字段优先于路由级。 */
export function mergeCompat(routeCompat, modelCompat) {
  return { ...routeCompat, ...modelCompat }
}

/**
 * 解析并校验一条路由配置,产出请求路径直接可用的路由对象。
 * @param {string} provider 路由名(LLM provider 名)
 * @param {object} profile settings 中的路由配置
 * @returns 路由对象:api/baseURL/apiKeyEnv/sessionMarker/metadata/headers/models 索引
 */
export function resolveRoute(provider, profile) {
  const where = `llm-pi-gateway 路由 "${provider}"`
  if (typeof profile !== 'object' || profile === null) {
    throw new GatewayError(`${where}: 配置必须是对象`, 'INVALID_CONFIG')
  }
  const { api, baseURL } = profile
  if (!(api in PROTOCOL_MODULES)) {
    throw new GatewayError(
      `${where}: api 必须是 ${Object.keys(PROTOCOL_MODULES).join(' / ')},实际为 "${api}"`,
      'INVALID_CONFIG',
    )
  }
  if (typeof baseURL !== 'string' || baseURL.length === 0) {
    throw new GatewayError(`${where}: baseURL 必须是非空字符串`, 'INVALID_CONFIG')
  }
  if (profile.apiKeyEnv !== undefined && (typeof profile.apiKeyEnv !== 'string' || profile.apiKeyEnv.length === 0)) {
    throw new GatewayError(`${where}: apiKeyEnv 必须是非空字符串`, 'INVALID_CONFIG')
  }
  const marker = profile.sessionMarker ?? {}
  const sessionMarker = {
    enabled: marker.enabled !== false,
    prefix: typeof marker.prefix === 'string' && marker.prefix.length > 0 ? marker.prefix : undefined,
  }
  if (profile.metadata !== undefined
    && (typeof profile.metadata !== 'object' || profile.metadata === null || Array.isArray(profile.metadata))) {
    throw new GatewayError(`${where}: metadata 必须是对象`, 'INVALID_CONFIG')
  }
  if (profile.headers !== undefined
    && (typeof profile.headers !== 'object' || profile.headers === null || Array.isArray(profile.headers))) {
    throw new GatewayError(`${where}: headers 必须是对象`, 'INVALID_CONFIG')
  }
  const routeCompat = validateCompat(api, profile.compat, where) ?? {}
  const models = resolveModels(api, profile.models, routeCompat, where)
  return {
    provider,
    api,
    baseURL,
    apiKeyEnv: profile.apiKeyEnv,
    sessionMarker,
    metadata: profile.metadata,
    headers: profile.headers,
    contextWindow: positiveInt(profile.contextWindow, `${where}: contextWindow`),
    cacheRetention: profile.cacheRetention,
    models,
  }
}

function positiveInt(value, label) {
  if (value === undefined) return undefined
  if (!Number.isInteger(value) || value <= 0) {
    throw new GatewayError(`${label} 必须为正整数`, 'INVALID_CONFIG')
  }
  return value
}

/** 解析模型表,产出按 id 索引的模型对象(id/contextWindow/compat/name/input)。 */
function resolveModels(api, rawModels, routeCompat, where) {
  if (!Array.isArray(rawModels) || rawModels.length === 0) {
    throw new GatewayError(`${where}: models 必须是非空数组`, 'INVALID_CONFIG')
  }
  const byId = new Map()
  for (const entry of rawModels) {
    if (typeof entry !== 'object' || entry === null) {
      throw new GatewayError(`${where}: models 项必须是对象`, 'INVALID_CONFIG')
    }
    const { id } = entry
    if (typeof id !== 'string' || id.length === 0) {
      throw new GatewayError(`${where}: models 项缺少非空 id`, 'INVALID_CONFIG')
    }
    if (byId.has(id)) {
      throw new GatewayError(`${where}: 模型 "${id}" 重复声明`, 'INVALID_CONFIG')
    }
    const modelCompat = validateCompat(api, entry.compat, `${where} 模型 "${id}"`) ?? {}
    if (entry.contextWindow !== undefined) positiveInt(entry.contextWindow, `${where} 模型 "${id}": contextWindow`)
    if (entry.maxTokens !== undefined) positiveInt(entry.maxTokens, `${where} 模型 "${id}": maxTokens`)
    if (entry.reasoning !== undefined && typeof entry.reasoning !== 'boolean') {
      throw new GatewayError(`${where} 模型 "${id}": reasoning 必须为布尔值`, 'INVALID_CONFIG')
    }
    if (entry.input !== undefined) {
      for (const modality of entry.input) {
        if (!MODALITIES.includes(modality)) {
          throw new GatewayError(`${where} 模型 "${id}": 未知模态 "${modality}"`, 'INVALID_CONFIG')
        }
      }
    }
    byId.set(id, {
      id,
      name: typeof entry.name === 'string' && entry.name.length > 0 ? entry.name : id,
      contextWindow: entry.contextWindow,
      input: entry.input,
      maxTokens: entry.maxTokens,
      reasoning: entry.reasoning,
      compat: mergeCompat(routeCompat, modelCompat),
    })
  }
  return byId
}

/**
 * 按请求 model 字段取路由内模型,未命中即 UNKNOWN_MODEL(同官方语义)。
 * @param {ReturnType<typeof resolveRoute>} route 路由对象
 * @param {string} model 请求模型 id
 */
export function modelOf(route, model) {
  const resolved = route.models.get(model)
  if (resolved === undefined) {
    throw new GatewayError(
      `llm-pi-gateway provider "${route.provider}" has no configured model "${model}"`,
      'UNKNOWN_MODEL',
    )
  }
  return resolved
}

/** 请求时解析凭据:apiKeyEnv 引用的环境变量缺失即 MISSING_CREDENTIAL,不回退。 */
export function resolveApiKey(route) {
  if (route.apiKeyEnv === undefined) return undefined
  const value = process.env[route.apiKeyEnv]
  if (typeof value !== 'string' || value.length === 0) {
    throw new GatewayError(
      `llm-pi-gateway provider "${route.provider}" 引用的凭据环境变量 ${route.apiKeyEnv} 不存在`,
      'MISSING_CREDENTIAL',
    )
  }
  return value
}
