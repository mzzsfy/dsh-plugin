// 模型发现(官方 dsh-llm-pi-ai 0.1.5-rc.2 discovery 同构,减去 catalog
// 分支——本包路由全为手写声明,无目录可用):openai 系共认 GET /models
// 形状,anthropic-messages 走原生 GET /v1/models;回复限量读取,坏行容忍,
// 探测键 = 草稿键或存量凭据。

import { normalizeApiKey, attributionHeaders } from '@deepseek-ai/dsh-llm'
import { GatewayError } from './errors.mjs'

// 可读模型清单的协议:openai 系共认 GET /models 形状,anthropic-messages
// 走原生清单端点;其余协议明确报告不支持,让配置面回退手写录入而非猜测
// 响应形状。
const LISTABLE_PROTOCOLS = new Set(['anthropic-messages', 'openai-completions', 'openai-responses'])

// Anthropic 清单端点要求的稳定 API 版本(官方同值)。
const ANTHROPIC_VERSION = '2023-06-01'

// Anthropic 公共清单端点单页模型上限,探测只读一页不跟随 has_more(官方同值)。
const ANTHROPIC_MODEL_LIMIT = 1000

// 探测端点是用户手输的 URL,按实际读取字节限量,声明超限先行拒收。
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024

function oversized(url) {
  return new GatewayError(`${url} answered with more than ${MAX_RESPONSE_BYTES} bytes`, 'DISCOVERY_FAILED')
}

// base 按前缀拼接而非 URL 解析,保住网关部署路径段;anthropic 根去尾斜杠
// 与一个尾随 /v1 段后接原生路径(官方同构),其余协议接 /models。
function listingUrl(baseURL, api) {
  const base = baseURL.replace(/\/+$/, '')
  if (api !== 'anthropic-messages') return `${base}/models`
  return `${base.endsWith('/v1') ? base.slice(0, -'/v1'.length) : base}/v1/models?limit=${ANTHROPIC_MODEL_LIMIT}`
}

async function readBounded(response, url) {
  const declared = Number(response.headers.get('content-length') ?? NaN)
  if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) {
    await response.body?.cancel?.()
    throw oversized(url)
  }
  if (response.body === null || response.body === undefined) return ''
  const reader = response.body.getReader?.()
  if (reader === undefined) {
    // 注入实现无流式读取器时的兜底:整读后仍按累计上限拒收
    const text = await response.body.text()
    if (Buffer.byteLength(text) > MAX_RESPONSE_BYTES) throw oversized(url)
    return text
  }
  const chunks = []
  let total = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > MAX_RESPONSE_BYTES) throw oversized(url)
      chunks.push(value)
    }
  } finally {
    await reader.cancel?.().catch(() => {})
  }
  const body = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    body.set(chunk, offset)
    offset += chunk.byteLength
  }
  return new TextDecoder().decode(body)
}

function capacity(...candidates) {
  for (const candidate of candidates) {
    if (typeof candidate === 'number' && Number.isInteger(candidate) && candidate > 0) return candidate
  }
}

function label(...candidates) {
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.length > 0) return candidate
  }
}

// 读取一种受支持的清单回复:标准 data 数组在场时优先;富集 models map 以
// 属性键为对外 id(嵌套 id 仅空键回退——网关可能把规范模型身份放在嵌套
// id,而请求接受的是别名),原始值属性不是模型记录,忽略。无 id 的条目
// 跳过而非整体失败:name 缺失回退 id,让 Web 表单拿到完整可读行(官方同构)。
function readListing(body) {
  const data = body?.data
  let listed
  if (Array.isArray(data)) {
    listed = data.map((raw) => ({ raw }))
  } else {
    const models = body?.models
    if (models === null || typeof models !== 'object' || Array.isArray(models)) {
      throw new GatewayError('the endpoint\'s model listing has neither a "data" array nor a "models" object; enter this provider\'s models by hand', 'DISCOVERY_FAILED')
    }
    listed = Object.entries(models)
      .filter(([, raw]) => raw !== null && typeof raw === 'object' && !Array.isArray(raw))
      .map(([key, raw]) => ({ key, raw }))
  }
  const models = []
  for (const { key, raw } of listed) {
    const id = label(key, raw?.id)
    if (id === undefined) continue
    const name = label(raw?.name, raw?.display_name, raw?.displayName) ?? id
    const contextWindow = capacity(raw?.contextWindow, raw?.context_window, raw?.context_length, raw?.max_input_tokens, raw?.limit?.context)
    const maxTokens = capacity(raw?.maxOutputTokens, raw?.max_output_tokens, raw?.maxTokens, raw?.max_tokens, raw?.limit?.output, raw?.top_provider?.max_completion_tokens)
    models.push({ id, name, ...(contextWindow === undefined ? {} : { contextWindow }), ...(maxTokens === undefined ? {} : { maxTokens }) })
  }
  return models
}

function usableProbeKey(raw) {
  const checked = normalizeApiKey(raw)
  if (checked.ok) return checked.value
  throw new GatewayError(
    checked.reason === 'empty'
      ? 'this provider\'s API key is blank; enter it on the Models page, or clear it to probe unauthenticated'
      : 'this provider\'s API key contains characters no HTTP header can carry; paste the raw key only',
    'INVALID_CREDENTIAL',
  )
}

/**
 * 探测一个草稿端点。请求描述尚未存储的草稿,不读写任何设置或凭据。
 * @param {object} request { provider?, api?, baseURL?, apiKey?, headers?, signal? }
 * @param {() => Promise<string|undefined>} resolveStoredKey 存量路由凭据,草稿未带键时使用
 * @param {typeof fetch} fetchImpl 注入的 fetch
 */
export async function discoverModels(request, resolveStoredKey, fetchImpl = fetch) {
  if (request.baseURL === undefined || request.baseURL.length === 0) {
    throw new GatewayError('this draft names no baseURL; set one, or enter this provider\'s models by hand', 'DISCOVERY_FAILED')
  }
  const api = request.api ?? 'openai-completions'
  if (!LISTABLE_PROTOCOLS.has(api)) {
    throw new GatewayError(`pi-ai protocol "${api}" has no model listing this build can read; enter this provider's models by hand`, 'DISCOVERY_UNSUPPORTED')
  }
  const url = listingUrl(request.baseURL, api)
  const supplied = request.apiKey ?? await resolveStoredKey?.()
  const apiKey = supplied === undefined ? undefined : usableProbeKey(supplied)
  // 路由自定义头先行,accept/探测认证/attribution 后写覆盖:openai 系走
  // bearer,anthropic-messages 走 anthropic-version + x-api-key(官方同构);
  // 保留头(attribution)不可被路由配置顶掉;构造入 try:草稿路径的
  // headers 不经配置期校验,非法头名归因 DISCOVERY_FAILED
  let response
  try {
    const headers = new Headers(request.headers)
    headers.set('accept', 'application/json')
    if (api === 'anthropic-messages') {
      headers.set('anthropic-version', ANTHROPIC_VERSION)
      if (apiKey !== undefined) headers.set('x-api-key', apiKey)
    } else if (apiKey !== undefined) {
      headers.set('authorization', `Bearer ${apiKey}`)
    }
    for (const [name, value] of Object.entries(attributionHeaders())) headers.set(name, value)
    response = await fetchImpl(url, {
      method: 'GET',
      headers,
      ...(request.signal === undefined ? {} : { signal: request.signal }),
    })
  } catch (error) {
    if (request.signal?.aborted) {
      throw new GatewayError('model discovery aborted by caller', 'ABORTED', { cause: error })
    }
    throw new GatewayError(`could not reach ${url}`, 'DISCOVERY_FAILED', { cause: error })
  }
  if (!response.ok) {
    throw new GatewayError(
      `${url} answered ${response.status}${response.status === 401 || response.status === 403 ? '; check the API key' : ''}`,
      'DISCOVERY_FAILED',
    )
  }
  let text
  try {
    text = await readBounded(response, url)
  } catch (error) {
    if (request.signal?.aborted) {
      throw new GatewayError('model discovery aborted by caller', 'ABORTED', { cause: error })
    }
    if (error instanceof GatewayError) throw error
    throw new GatewayError(`${url} could not be read`, 'DISCOVERY_FAILED')
  }
  let body
  try {
    body = JSON.parse(text)
  } catch (error) {
    throw new GatewayError(`${url} did not answer with JSON`, 'DISCOVERY_FAILED', { cause: error })
  }
  return readListing(body)
}
