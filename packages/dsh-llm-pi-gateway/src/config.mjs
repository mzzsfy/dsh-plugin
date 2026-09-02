// 路由配置解析:compat 全控(按协议字段名单校验,值不可为 null)、
// 模型级 compat 浅合并覆盖路由级、reasoningEfforts → thinkingLevelMap、
// 模型表与路由级请求旋钮解析。retryPolicy 经 dsh-llm 公共导出解析。
// 纯函数,无 I/O。

import { resolveRetryPolicy } from '@deepseek-ai/dsh-llm'
import { GatewayError } from './errors.mjs'
import { SETTINGS_NS } from './manager.mjs'

// 接管来源节命名空间:官方节由本包(官方 schema)消费,零感知替换官方插件
export const OFFICIAL_SETTINGS_NS = 'llm-pi-ai'

/**
 * 合并官方节与 gateway 节的 provider 声明:并集,同名时 gateway 节整体
 * 优先(不做字段级合并——混两节的字段会造出谁都没声明过的配置)。
 * 每条路由带 source = 声明所在节,供目录寻址与存量凭据回退。
 */
export function mergeProviderSections(officialProviders, gatewayProviders) {
  const merged = new Map()
  for (const [provider, profile] of Object.entries(officialProviders ?? {})) {
    merged.set(provider, { ...profile, source: OFFICIAL_SETTINGS_NS })
  }
  for (const [provider, profile] of Object.entries(gatewayProviders ?? {})) {
    merged.set(provider, { ...profile, source: SETTINGS_NS })
  }
  return merged
}

/** 本包支持的 pi-ai 协议与其 api 模块子路径。 */
export const PROTOCOL_MODULES = {
  'anthropic-messages': '@earendil-works/pi-ai/api/anthropic-messages',
  'openai-completions': '@earendil-works/pi-ai/api/openai-completions',
  'openai-responses': '@earendil-works/pi-ai/api/openai-responses',
}

// compat 字段名单取自 pi-ai@0.82 各协议 compat 类型声明(类型即边界),
// 与官方 dsh-llm-pi-ai 声明的 pi-ai 范围一致;
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
  'maxTokensField',
  'requiresToolResultName',
  'requiresAssistantAfterToolResult',
  'requiresThinkingAsText',
  'requiresReasoningContentOnAssistantMessages',
  'thinkingFormat',
  'chatTemplateKwargs',
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

// pi-ai 思考档位全集(官方 dsh-llm-pi-ai 同款常量,pi-ai 未导出);
// xhigh/max 与基础档位的默认支持性不对称,正是钉 null 语义存在的理由。
const THINKING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']

const TRANSPORTS = ['sse', 'websocket', 'websocket-cached', 'auto']

/**
 * reasoningEfforts 字典翻译为 pi-ai thinkingLevelMap(官方 resolveModelReasoning 同构)。
 * 已声明档位携带 wire 值,未声明档位钉 null(不支持);off 无值是唯一例外——
 * 从 map 缺席,pi-ai 读作"支持且不发参数"。
 */
export function resolveModelReasoning(entry, where) {
  const efforts = entry.reasoningEfforts
  if (efforts === undefined || efforts === false) return { reasoning: false }
  if (efforts === null || typeof efforts !== 'object' || Array.isArray(efforts)
    || Object.keys(efforts).length === 0) {
    throw new GatewayError(
      `${where}: reasoningEfforts 必须是档位字典或 false;声明可提供的档位,false 表示非推理模型`,
      'INVALID_CONFIG',
    )
  }
  for (const key of Object.keys(efforts)) {
    if (!THINKING_LEVELS.includes(key)) {
      throw new GatewayError(
        `${where}: reasoningEfforts 含未知档位 "${key}",可用档位: ${THINKING_LEVELS.join(', ')}`,
        'INVALID_CONFIG',
      )
    }
  }
  const declared = THINKING_LEVELS
    .filter((level) => efforts[level] !== undefined)
    .map((level) => [level, efforts[level]])
  for (const [level, wire] of declared) {
    if (wire === null) {
      if (level !== 'off') {
        throw new GatewayError(
          `${where}: reasoningEfforts.${level} 需要发射的 wire 值;仅 off 可以留空`,
          'INVALID_CONFIG',
        )
      }
    } else if (typeof wire !== 'string' || wire.length === 0) {
      throw new GatewayError(
        `${where}: reasoningEfforts.${level} 的 wire 值必须是非空字符串`,
        'INVALID_CONFIG',
      )
    }
  }
  if (!declared.some(([level]) => level !== 'off')) {
    throw new GatewayError(
      `${where}: reasoningEfforts 除 off 外未声明任何档位;声明思考档位,或设 false 表示非推理模型`,
      'INVALID_CONFIG',
    )
  }
  const map = {}
  for (const level of THINKING_LEVELS) {
    const wire = efforts[level]
    if (wire === undefined) map[level] = null
    else if (wire !== null) map[level] = wire
  }
  return { reasoning: true, thinkingLevelMap: map }
}

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
 * 解析整张路由表:官方节 ∪ 本包节(mergeProviderSections 合并),每条
 * 路由经 resolveRoute 全量校验;任一路由不可服务即抛(fail loud)。
 */
export function resolveRoutes(officialProviders, gatewayProviders) {
  const merged = mergeProviderSections(officialProviders, gatewayProviders)
  const routes = new Map()
  for (const [provider, profile] of merged) {
    routes.set(provider, resolveRoute(provider, profile))
  }
  return routes
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
  // 官方节路由的形状由官方 schema 担保(含其规范化产物,如 modelOverrides
  // 与目录 compat),不适用本包对手写配置的字段级拒绝
  const officialSourced = profile.source === OFFICIAL_SETTINGS_NS
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
  if (profile.displayName !== undefined && (typeof profile.displayName !== 'string' || profile.displayName.length === 0)) {
    throw new GatewayError(`${where}: displayName 必须是非空字符串`, 'INVALID_CONFIG')
  }
  const routeReasoning = profile.reasoning
  if (routeReasoning !== undefined && !THINKING_LEVELS.includes(routeReasoning)) {
    throw new GatewayError(
      `${where}: reasoning 必须是 ${THINKING_LEVELS.join(' / ')},实际为 "${routeReasoning}"`,
      'INVALID_CONFIG',
    )
  }
  if (profile.thinkingBudgets !== undefined
    && (typeof profile.thinkingBudgets !== 'object' || profile.thinkingBudgets === null || Array.isArray(profile.thinkingBudgets))) {
    throw new GatewayError(`${where}: thinkingBudgets 必须是对象`, 'INVALID_CONFIG')
  }
  if (profile.transport !== undefined && !TRANSPORTS.includes(profile.transport)) {
    throw new GatewayError(
      `${where}: transport 必须是 ${TRANSPORTS.join(' / ')},实际为 "${profile.transport}"`,
      'INVALID_CONFIG',
    )
  }
  if (profile.timeoutMs !== undefined && (!Number.isInteger(profile.timeoutMs) || profile.timeoutMs < 0)) {
    throw new GatewayError(`${where}: timeoutMs 必须是非负整数`, 'INVALID_CONFIG')
  }
  if (profile.websocketConnectTimeoutMs !== undefined
    && (!Number.isInteger(profile.websocketConnectTimeoutMs) || profile.websocketConnectTimeoutMs < 0)) {
    throw new GatewayError(`${where}: websocketConnectTimeoutMs 必须是非负整数`, 'INVALID_CONFIG')
  }
  if (profile.cacheRetention !== undefined && !['none', 'short', 'long'].includes(profile.cacheRetention)) {
    throw new GatewayError(`${where}: cacheRetention 必须是 none / short / long`, 'INVALID_CONFIG')
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
  const routeCompat = officialSourced
    ? { ...(profile.compat ?? {}) }
    : validateCompat(api, profile.compat, where) ?? {}
  const models = resolveModels(api, profile.models, routeCompat, where, officialSourced)
  return {
    provider,
    api,
    baseURL,
    apiKeyEnv: profile.apiKeyEnv,
    source: profile.source,
    displayName: profile.displayName ?? provider,
    sessionMarker,
    metadata: profile.metadata,
    headers: profile.headers,
    reasoning: routeReasoning,
    thinkingBudgets: profile.thinkingBudgets,
    transport: profile.transport,
    timeoutMs: profile.timeoutMs,
    websocketConnectTimeoutMs: profile.websocketConnectTimeoutMs,
    cacheRetention: profile.cacheRetention,
    defaultContextWindow: positiveInt(profile.defaultContextWindow, `${where}: defaultContextWindow`) ?? DEFAULT_CONTEXT_WINDOW,
    defaultMaxTokens: positiveInt(profile.defaultMaxTokens, `${where}: defaultMaxTokens`) ?? DEFAULT_MAX_TOKENS,
    defaultInput: profile.defaultInput === undefined ? [...DEFAULT_INPUT] : validateInput(profile.defaultInput, `${where}: defaultInput`),
    maxRequestImageBytes: positiveInt(profile.maxRequestImageBytes, `${where}: maxRequestImageBytes`) ?? DEFAULT_MAX_REQUEST_IMAGE_BYTES,
    requestImagePixelBudget: positiveInt(profile.requestImagePixelBudget, `${where}: requestImagePixelBudget`) ?? DEFAULT_IMAGE_PIXEL_BUDGET,
    requestImageMaxBytes: positiveInt(profile.requestImageMaxBytes, `${where}: requestImageMaxBytes`) ?? DEFAULT_IMAGE_MAX_BYTES,
    retryPolicy: resolveRetryPolicy(profile.retryPolicy, `llm-pi-gateway: provider "${provider}" retryPolicy`),
    models,
  }
}

// 路由级缺省容量,与官方 dsh-llm-pi-ai resolveProfiles 的缺省值一致
const DEFAULT_CONTEXT_WINDOW = 262144
const DEFAULT_MAX_TOKENS = 32768
const DEFAULT_INPUT = ['text']

// 路由级图片预算缺省,与官方一致
const DEFAULT_MAX_REQUEST_IMAGE_BYTES = 20 * 1024 * 1024
const DEFAULT_IMAGE_PIXEL_BUDGET = 4 * 1024 * 1024
const DEFAULT_IMAGE_MAX_BYTES = 1024 * 1024

function validateInput(input, label) {
  if (!Array.isArray(input) || input.length === 0) {
    throw new GatewayError(`${label} 必须是非空数组`, 'INVALID_CONFIG')
  }
  for (const modality of input) {
    if (!MODALITIES.includes(modality)) {
      throw new GatewayError(`${label}: 未知模态 "${modality}"`, 'INVALID_CONFIG')
    }
  }
  return [...input]
}

function positiveInt(value, label) {
  if (value === undefined) return undefined
  if (!Number.isInteger(value) || value <= 0) {
    throw new GatewayError(`${label} 必须为正整数`, 'INVALID_CONFIG')
  }
  return value
}

/** 解析模型表,产出按 id 索引的模型对象;官方来源路由跳过 compat 名单校验。 */
function resolveModels(api, rawModels, routeCompat, where, officialSourced = false) {
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
    const modelWhere = `${where} 模型 "${id}"`
    const modelCompat = officialSourced
      ? { ...(entry.compat ?? {}) }
      : validateCompat(api, entry.compat, modelWhere) ?? {}
    // 官方 schema 对未声明 input 的模型补全空数组(目录语义:未声明);
    // 本包无目录,空数组落回路由 defaultInput
    const declaredInput = officialSourced && Array.isArray(entry.input) && entry.input.length === 0
      ? undefined
      : entry.input
    const contextWindow = positiveInt(entry.contextWindow, `${modelWhere}: contextWindow`)
    const maxTokens = positiveInt(entry.maxTokens, `${modelWhere}: maxTokens`)
    if (declaredInput !== undefined) validateInput(declaredInput, `${modelWhere}: input`)
    const reasoning = resolveModelReasoning(entry, modelWhere)
    byId.set(id, {
      id,
      name: typeof entry.name === 'string' && entry.name.length > 0 ? entry.name : id,
      contextWindow,
      input: declaredInput,
      maxTokens,
      ...reasoning,
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
