const GENERATION_PATHS = new Map([
  ['/chat/completions', 'openai'],
  ['/messages', 'anthropic'],
  ['/responses', 'responses'],
])
const REPLY_KEYS = ['text', 'thinking', 'toolCalls', 'tokens', 'status', 'error', 'stream']
const STREAM_KEYS = ['chunkSize', 'intervalMs', 'thinkingChunkSize', 'thinkingIntervalMs']
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)

function checkKeys(value, keys, label) {
  if (!object(value) || Object.keys(value).some(key => !keys.includes(key))) throw new TypeError(`${label}: invalid object or unknown fields`)
}

export function validateReply(reply) {
  checkKeys(reply, REPLY_KEYS, 'reply')
  for (const field of ['text', 'thinking']) {
    if (reply[field] !== undefined && typeof reply[field] !== 'string') throw new TypeError(`${field} must be a string`)
  }
  if (reply.toolCalls !== undefined) {
    if (!Array.isArray(reply.toolCalls)) throw new TypeError('toolCalls must be an array')
    for (const call of reply.toolCalls) {
      checkKeys(call, ['id', 'name', 'arguments'], 'toolCall')
      if (typeof call.name !== 'string' || !call.name.trim()) throw new TypeError('toolCall.name must not be empty')
      if (call.id !== undefined && (typeof call.id !== 'string' || !call.id.trim())) throw new TypeError('toolCall.id must not be empty')
      const args = typeof call.arguments === 'string' ? JSON.parse(call.arguments) : call.arguments
      if (!object(args)) throw new TypeError('toolCall.arguments must be a JSON object')
    }
    const ids = reply.toolCalls.filter(call => call.id !== undefined).map(call => call.id)
    if (new Set(ids).size !== ids.length) throw new TypeError('toolCall ids must be unique')
  }
  if (reply.tokens !== undefined && (!Array.isArray(reply.tokens) || reply.tokens.length !== 2 || reply.tokens.some(n => !Number.isSafeInteger(n) || n < 0))) throw new TypeError('tokens must be two nonnegative integers')
  if (reply.status !== undefined && (!Number.isInteger(reply.status) || reply.status < 400 || reply.status > 599)) throw new TypeError('status must be an HTTP error status')
  if (reply.error !== undefined && !object(reply.error)) throw new TypeError('error must be an object')
  if (reply.stream !== undefined) {
    checkKeys(reply.stream, STREAM_KEYS, 'stream')
    for (const [key, value] of Object.entries(reply.stream)) {
      const minimum = key.endsWith('Size') ? 1 : 0
      const maximum = key.endsWith('Ms') ? 2 ** 31 - 1 : Number.MAX_SAFE_INTEGER
      if (!Number.isSafeInteger(value) || value < minimum || value > maximum) throw new TypeError(`${key} must be an integer from ${minimum} to ${maximum}`)
    }
  }
  return structuredClone(reply)
}

const send = (response, status, value) => {
  response.writeHead(status, { 'content-type': 'application/json' })
  response.end(JSON.stringify(value))
}

// 每个监听实例拥有独立队列；控制请求不参与模型请求历史。
export function createControl() {
  let replies = []
  let defaultReply = null
  let requests = []
  let sequence = 0
  const state = () => ({ pendingCount: replies.length, requestCount: requests.length, lastRequestId: requests.at(-1)?.id ?? null, defaultReply })
  return {
    handle(request, response, parsedBody, validJson) {
      const route = String(request.url ?? '').split('?')[0]
      if (!route.startsWith('/control/')) return false
      try {
        const url = new URL(request.url, 'http://localhost')
        const method = request.method
        const path = url.pathname
        if (['POST', 'PUT', 'PATCH'].includes(method) && !validJson) throw new TypeError('invalid JSON body')
        if (path === '/control/replies' && method === 'POST') {
          const batch = object(parsedBody) && Object.hasOwn(parsedBody, 'replies') ? (checkKeys(parsedBody, ['replies'], 'batch'), parsedBody.replies) : [parsedBody]
          if (!Array.isArray(batch) || batch.length === 0) throw new TypeError('replies must be a nonempty array')
          const validated = batch.map(validateReply)
          replies.push(...validated)
          send(response, 201, { pendingCount: replies.length })
        } else if (path === '/control/replies' && method === 'GET') send(response, 200, { replies })
        else if (path === '/control/replies' && method === 'DELETE') { replies = []; send(response, 200, state()) }
        else if (path === '/control/default' && ['PUT', 'PATCH'].includes(method)) {
          const patch = validateReply(parsedBody)
          const candidate = method === 'PATCH' ? { ...defaultReply, ...patch, ...(patch.stream !== undefined ? { stream: { ...defaultReply?.stream, ...patch.stream } } : {}) } : patch
          defaultReply = validateReply(candidate)
          send(response, 200, defaultReply)
        } else if (path === '/control/default' && method === 'GET') send(response, 200, defaultReply)
        else if (path === '/control/default' && method === 'DELETE') { defaultReply = null; send(response, 200, null) }
        else if (path === '/control/requests/latest' && method === 'GET') send(response, 200, requests.at(-1) ?? null)
        else if (path === '/control/requests' && method === 'GET') {
          const after = Number(url.searchParams.get('after') ?? 0)
          const limit = Number(url.searchParams.get('limit') ?? 100)
          if (!Number.isSafeInteger(after) || after < 0 || !Number.isSafeInteger(limit) || limit < 1) throw new TypeError('after/limit must be nonnegative/positive integers')
          send(response, 200, { requests: requests.filter(row => row.id > after).slice(0, limit), lastRequestId: requests.at(-1)?.id ?? null })
        } else if (path === '/control/state' && method === 'GET') send(response, 200, state())
        else if (path === '/control/reset' && method === 'POST') { replies = []; requests = []; defaultReply = null; send(response, 200, state()) }
        else send(response, 404, { error: 'unknown control route or method' })
      } catch (error) {
        send(response, 400, { error: error.message })
      }
      return true
    },
    capture(request, body, raw) {
      const path = String(request.url ?? '').split('?')[0].replace(/^\/v1(?=\/)/, '')
      const protocol = request.method === 'POST' ? GENERATION_PATHS.get(path) : undefined
      if (protocol === undefined) return null
      const reply = replies.shift() ?? defaultReply
      const headers = Object.fromEntries(Object.entries(request.headers).filter(([name]) => !/authorization|cookie|api[-_]?key/i.test(name)))
      requests.push({ id: ++sequence, at: new Date().toISOString(), method: request.method, path: request.url, headers, raw, body, model: body?.model, stream: body?.stream === true, messages: body?.messages ?? [], tools: body?.tools ?? [], system: body?.system, input: body?.input, protocol, reply: structuredClone(reply) })
      return { protocol, reply }
    },
  }
}
