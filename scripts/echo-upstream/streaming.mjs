// SSE 流式派发与场景注入:openai(chat.completion.chunk + [DONE])与
// anthropic(event 序列:message_start → content_block → message_delta → message_stop)。
// 场景(scenarios.resolveScenario)经模型名触发:thinking 块、错误码、流中断、慢速间隔。
import { resolveScenario, THINKING_TEXT, SLOW_CHUNK_INTERVAL_MS } from './scenarios.mjs'

const SSE_HEADERS = { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' }
const sleep = (ms) => new Promise((done) => setTimeout(done, ms))

function sseWrite(response, event, data) {
  response.write(event !== null ? `event: ${event}\ndata: ${data}\n\n` : `data: ${data}\n\n`)
}

function openaiUsage(tokens) {
  const [input = 1, output = 1] = tokens ?? []
  return { prompt_tokens: input, completion_tokens: output, total_tokens: input + output }
}

function anthropicUsage(tokens) {
  return { input_tokens: tokens?.[0] ?? 1, output_tokens: tokens?.[1] ?? 1 }
}

async function writeOpenaiStream(response, model, tokens, scenario) {
  response.writeHead(200, SSE_HEADERS)
  const chunk = (delta, extra = {}) => JSON.stringify({
    id: 'chatcmpl-echo-upstream', object: 'chat.completion.chunk', created: 0, model,
    choices: [{ index: 0, delta, finish_reason: null }], ...extra,
  })
  if (scenario === 'slow') await sleep(SLOW_CHUNK_INTERVAL_MS)
  sseWrite(response, null, chunk({ role: 'assistant', content: '' }))
  if (scenario === 'think') sseWrite(response, null, chunk({ reasoning_content: THINKING_TEXT }))
  if (scenario === 'slow') await sleep(SLOW_CHUNK_INTERVAL_MS)
  if (scenario === 'drop') { response.end(); return }
  sseWrite(response, null, chunk({ content: 'echo-upstream-fixed' }))
  if (scenario === 'slow') await sleep(SLOW_CHUNK_INTERVAL_MS)
  // usage 终块 choices 为空数组,对齐真实 openai stream_options.include_usage 形状
  sseWrite(response, null, chunk({}, { choices: [], finish_reason: null, usage: openaiUsage(tokens) }))
  sseWrite(response, null, '[DONE]')
  response.end()
}

async function writeAnthropicStream(response, model, tokens, scenario) {
  response.writeHead(200, SSE_HEADERS)
  sseWrite(response, 'message_start', JSON.stringify({
    type: 'message_start',
    message: { id: 'msg_echo-upstream', type: 'message', role: 'assistant', model, content: [], usage: { input_tokens: anthropicUsage(tokens).input_tokens, output_tokens: 0 } },
  }))
  const blockStart = (index, block) => sseWrite(response, 'content_block_start', JSON.stringify({ type: 'content_block_start', index, content_block: block }))
  const blockDelta = (index, delta) => sseWrite(response, 'content_block_delta', JSON.stringify({ type: 'content_block_delta', index, delta }))
  const blockStop = (index) => sseWrite(response, 'content_block_stop', JSON.stringify({ type: 'content_block_stop', index }))
  let index = 0
  if (scenario === 'think') {
    blockStart(index, { type: 'thinking', thinking: '' })
    blockDelta(index, { type: 'thinking_delta', thinking: THINKING_TEXT })
    blockStop(index)
    index += 1
  }
  if (scenario === 'slow') await sleep(SLOW_CHUNK_INTERVAL_MS)
  if (scenario === 'drop') { response.end(); return }
  blockStart(index, { type: 'text', text: '' })
  blockDelta(index, { type: 'text_delta', text: 'echo-upstream-fixed' })
  blockStop(index)
  sseWrite(response, 'message_delta', JSON.stringify({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: anthropicUsage(tokens).output_tokens } }))
  sseWrite(response, 'message_stop', JSON.stringify({ type: 'message_stop' }))
  response.end()
}

function respondError(response, status) {
  response.writeHead(status, { 'content-type': 'application/json' })
  response.end(JSON.stringify({ error: { type: 'echo-upstream-injected', status } }))
}

// 装配入口:返回带 delegate 与 resolveScenario 的完整 options,server 层先解析场景再留档,delegate 只消费。
// delegate 返回 true = 已处理响应;返回 undefined = 回退 server 非流式缺省路径。tokens 单一来源为 ctx.options。
export function installDelegate(options = {}) {
  return {
    ...options,
    resolveScenario: (ctx) => resolveScenario(ctx.parsedBody?.model),
    delegate: (ctx) => {
      const { request, response, parsedBody, scenario, options: startOptions } = ctx
      const model = parsedBody?.model ?? null
      if (scenario === 'err429') return respondError(response, 429), true
      if (scenario === 'err500') return respondError(response, 500), true
      if (!parsedBody?.stream) return undefined
      if (request.url.includes('/messages')) return void writeAnthropicStream(response, model, startOptions.tokens, scenario), true
      return void writeOpenaiStream(response, model, startOptions.tokens, scenario), true
    },
  }
}
