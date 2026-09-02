// 模型发现(官方 dsh-llm-pi-ai discovery 同构,减去 catalog 分支——
// 本包路由全为手写声明,无目录可用):仅 openai 系协议可探测,
// 回复限量读取,坏行容忍,探测键 = 草稿键或存量凭据。

import { normalizeApiKey, attributionHeaders } from '@deepseek-ai/dsh-llm'
import { GatewayError } from './errors.mjs'

// 可读模型清单的协议:双方共认 GET /models 形状;anthropic 等其余协议
// 明确报告不支持,让配置面回退手写录入而非猜测响应形状。
const LISTABLE_PROTOCOLS = new Set(['openai-completions', 'openai-responses'])

// 探测端点是用户手输的 URL,按实际读取字节限量,声明超限先行拒收。
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024

function oversized(url) {
  return new GatewayError(`${url} answered with more than ${MAX_RESPONSE_BYTES} bytes`, 'DISCOVERY_FAILED')
}

function listingUrl(baseURL) {
  return `${baseURL.replace(/\/+$/, '')}/models`
}

async function readBounded(response, url) {
  const declared = Number(response.headers.get('content-length') ?? NaN)
  if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) {
    await response.body?.cancel?.()
    throw oversized(url)
  }
  if (response.body === null || response.body === undefined) return ''
  const reader = response.body.getReader?.()
  if (reader === undefined) return await response.text()
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

function readListing(body) {
  const data = body?.data
  if (!Array.isArray(data)) {
    throw new GatewayError('the endpoint\'s model listing has no "data" array; enter this provider\'s models by hand', 'DISCOVERY_FAILED')
  }
  const models = []
  for (const raw of data) {
    const id = label(raw?.id)
    if (id === undefined) continue
    const name = label(raw?.name, raw?.display_name)
    const contextWindow = capacity(raw?.context_window, raw?.context_length)
    const maxTokens = capacity(raw?.max_output_tokens, raw?.max_tokens)
    models.push({
      id,
      ...(name === undefined ? {} : { name }),
      ...(contextWindow === undefined ? {} : { contextWindow }),
      ...(maxTokens === undefined ? {} : { maxTokens }),
    })
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
 * @param {object} request { provider?, api?, baseURL?, apiKey?, signal? }
 * @param {() => Promise<string|undefined>} resolveStoredKey 存量路由凭据,草稿未带键时使用
 * @param {typeof fetch} fetchImpl 注入的 fetch
 */
export async function discoverModels(request, resolveStoredKey, fetchImpl = fetch) {
  const api = request.api ?? 'openai-completions'
  if (!LISTABLE_PROTOCOLS.has(api)) {
    throw new GatewayError(`pi-ai protocol "${api}" has no model listing this build can read; enter this provider's models by hand`, 'DISCOVERY_UNSUPPORTED')
  }
  if (request.baseURL === undefined || request.baseURL.length === 0) {
    throw new GatewayError('this draft names no baseURL; set one, or enter this provider\'s models by hand', 'DISCOVERY_FAILED')
  }
  const url = listingUrl(request.baseURL)
  const supplied = request.apiKey ?? await resolveStoredKey?.()
  const apiKey = supplied === undefined ? undefined : usableProbeKey(supplied)
  let response
  try {
    response = await fetchImpl(url, {
      method: 'GET',
      headers: {
        accept: 'application/json',
        ...(apiKey === undefined ? {} : { authorization: `Bearer ${apiKey}` }),
        ...attributionHeaders(),
      },
      ...(request.signal === undefined ? {} : { signal: request.signal }),
    })
  } catch (error) {
    if (request.signal?.aborted) {
      throw Object.assign(new Error('model discovery aborted by caller'), { code: 'ABORTED', cause: error })
    }
    throw new GatewayError(`could not reach ${url}`, 'DISCOVERY_FAILED')
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
      throw Object.assign(new Error('model discovery aborted by caller'), { code: 'ABORTED', cause: error })
    }
    if (error instanceof GatewayError) throw error
    throw new GatewayError(`${url} could not be read`, 'DISCOVERY_FAILED')
  }
  let body
  try {
    body = JSON.parse(text)
  } catch (error) {
    throw new GatewayError(`${url} did not answer with JSON`, 'DISCOVERY_FAILED')
  }
  return readListing(body)
}
