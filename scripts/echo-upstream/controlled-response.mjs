import { setTimeout as sleep } from 'node:timers/promises'
import { once } from 'node:events'
import { anthropicResponse, openaiResponse, responsesResponse } from './protocol.mjs'

function assemble(model, protocol, reply) {
  const [input = 1, output = 1] = reply.tokens ?? []
  const reserved = new Set((reply.toolCalls ?? []).filter(call => call.id !== undefined).map(call => call.id))
  let nextId = 0
  const allocateId = () => {
    while (reserved.has(`call_echo_${nextId}`)) nextId++
    const id = `call_echo_${nextId++}`
    reserved.add(id)
    return id
  }
  const tools = (reply.toolCalls ?? []).map((call) => ({
    id: call.id ?? allocateId(),
    name: call.name,
    arguments: typeof call.arguments === 'string' ? call.arguments : JSON.stringify(call.arguments),
  }))
  const hasText = reply.text !== undefined || tools.length === 0
  const content = [
    ...(reply.thinking !== undefined ? [{ type: 'thinking', thinking: reply.thinking }] : []),
    ...(hasText ? [{ type: 'text', text: reply.text ?? '' }] : []),
    ...tools.map((call) => ({ type: 'tool_use', id: call.id, name: call.name, input: protocol === 'anthropic' ? JSON.parse(call.arguments) : {} })),
  ]
  if (protocol === 'anthropic') return {
    ...anthropicResponse(model, { input_tokens: input, output_tokens: output }),
    content, stop_reason: tools.length ? 'tool_use' : 'end_turn',
  }
  if (protocol === 'responses') return {
    ...responsesResponse(model, { input_tokens: input, output_tokens: output, total_tokens: input + output }),
    output: [
      ...(reply.thinking !== undefined ? [{ type: 'reasoning', id: 'rs_echo-upstream', summary: [{ type: 'summary_text', text: reply.thinking }] }] : []),
      ...(hasText ? [{ type: 'message', id: 'msg_echo-upstream', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: reply.text ?? '', annotations: [] }] }] : []),
      ...tools.map((call, index) => ({ type: 'function_call', id: `fc_echo_${index}`, call_id: call.id, name: call.name, arguments: call.arguments, status: 'completed' })),
    ],
  }
  const message = {
    role: 'assistant', content: hasText ? reply.text ?? '' : null,
    ...(reply.thinking !== undefined ? { reasoning_content: reply.thinking } : {}),
    ...(tools.length ? { tool_calls: tools.map((call) => ({ id: call.id, type: 'function', function: { name: call.name, arguments: call.arguments } })) } : {}),
  }
  return {
    ...openaiResponse(model, { prompt_tokens: input, completion_tokens: output, total_tokens: input + output }, message),
    choices: [{ index: 0, message, finish_reason: tools.length ? 'tool_calls' : 'stop' }],
  }
}

function* openaiEvents(payload) {
  const choice = payload.choices[0]
  const chunk = (delta, finish_reason = null) => ({
    id: payload.id, object: 'chat.completion.chunk', created: payload.created, model: payload.model,
    choices: [{ index: 0, delta, finish_reason }],
  })
  yield chunk({ role: 'assistant' })
  if (choice.message.reasoning_content !== undefined) yield chunk({ reasoning_content: choice.message.reasoning_content })
  if (choice.message.content !== null) yield chunk({ content: choice.message.content })
  for (const [index, call] of (choice.message.tool_calls ?? []).entries()) yield chunk({ tool_calls: [{ index, ...call }] })
  yield chunk({}, choice.finish_reason)
  yield { ...chunk({}), choices: [], usage: payload.usage }
  yield '[DONE]'
}

function* anthropicEvents(payload) {
  yield { type: 'message_start', message: { ...payload, content: [], stop_reason: null, usage: { input_tokens: payload.usage.input_tokens, output_tokens: 0 } } }
  for (const [index, block] of payload.content.entries()) {
    const initial = block.type === 'thinking' ? { type: 'thinking', thinking: '' }
      : block.type === 'text' ? { type: 'text', text: '' }
        : { ...block, input: {} }
    const delta = block.type === 'thinking' ? { type: 'thinking_delta', thinking: block.thinking }
      : block.type === 'text' ? { type: 'text_delta', text: block.text }
        : { type: 'input_json_delta', partial_json: JSON.stringify(block.input) }
    yield { type: 'content_block_start', index, content_block: initial }
    yield { type: 'content_block_delta', index, delta }
    yield { type: 'content_block_stop', index }
  }
  yield { type: 'message_delta', delta: { stop_reason: payload.stop_reason, stop_sequence: null }, usage: { output_tokens: payload.usage.output_tokens } }
  yield { type: 'message_stop' }
}

function* responsesEvents(payload) {
  yield { type: 'response.created', response: { ...payload, status: 'in_progress', output: [], usage: null } }
  for (const [output_index, item] of payload.output.entries()) {
    const position = { item_id: item.id, output_index }
    const initial = item.type === 'function_call' ? { ...item, arguments: '', status: 'in_progress' }
      : item.type === 'reasoning' ? { ...item, summary: [] }
        : { ...item, status: 'in_progress', content: [] }
    yield { type: 'response.output_item.added', output_index, item: initial }
    if (item.type === 'function_call') {
      yield { type: 'response.function_call_arguments.delta', ...position, delta: item.arguments }
      yield { type: 'response.function_call_arguments.done', ...position, arguments: item.arguments }
    } else if (item.type === 'reasoning') {
      const part = item.summary[0]
      yield { type: 'response.reasoning_summary_part.added', ...position, summary_index: 0, part: { type: 'summary_text', text: '' } }
      yield { type: 'response.reasoning_summary_text.delta', ...position, summary_index: 0, delta: part.text }
      yield { type: 'response.reasoning_summary_text.done', ...position, summary_index: 0, text: part.text }
      yield { type: 'response.reasoning_summary_part.done', ...position, summary_index: 0, part }
    } else {
      const part = item.content[0]
      yield { type: 'response.content_part.added', ...position, content_index: 0, part: { ...part, text: '' } }
      yield { type: 'response.output_text.delta', ...position, content_index: 0, delta: part.text }
      yield { type: 'response.output_text.done', ...position, content_index: 0, text: part.text }
      yield { type: 'response.content_part.done', ...position, content_index: 0, part }
    }
    yield { type: 'response.output_item.done', output_index, item }
  }
  yield { type: 'response.completed', response: payload }
}

const eventFactories = { openai: openaiEvents, anthropic: anthropicEvents, responses: responsesEvents }

function deltaField(event, protocol) {
  if (protocol === 'openai') {
    const delta = event.choices?.[0]?.delta
    if (delta?.reasoning_content !== undefined) return { value: delta.reasoning_content, thinking: true, replace: (value) => ({ ...event, choices: [{ ...event.choices[0], delta: { reasoning_content: value } }] }) }
    if (delta?.content !== undefined) return { value: delta.content, thinking: false, replace: (value) => ({ ...event, choices: [{ ...event.choices[0], delta: { content: value } }] }) }
  } else if (protocol === 'anthropic' && event.type === 'content_block_delta') {
    const key = event.delta.type === 'thinking_delta' ? 'thinking' : event.delta.type === 'text_delta' ? 'text' : null
    if (key) return { value: event.delta[key], thinking: key === 'thinking', replace: (value) => ({ ...event, delta: { ...event.delta, [key]: value } }) }
  } else if (protocol === 'responses' && ['response.output_text.delta', 'response.reasoning_summary_text.delta'].includes(event.type)) {
    return { value: event.delta, thinking: event.type === 'response.reasoning_summary_text.delta', replace: (value) => ({ ...event, delta: value }) }
  }
  return null
}

function* pacedEvents(payload, protocol, stream) {
  for (const event of eventFactories[protocol](payload)) {
    const field = deltaField(event, protocol)
    if (!field) { yield { event, delay: 0 }; continue }
    const characters = Array.from(field.value)
    const size = (field.thinking ? stream.thinkingChunkSize : stream.chunkSize) ?? Math.max(characters.length, 1)
    const interval = (field.thinking ? stream.thinkingIntervalMs : stream.intervalMs) ?? 0
    if (characters.length === 0) yield { event, delay: 0 }
    for (let offset = 0; offset < characters.length; offset += size) {
      yield { event: field.replace(characters.slice(offset, offset + size).join('')), delay: offset === 0 ? 0 : interval }
    }
  }
}

export async function respondControlled(response, parsedBody, protocol, reply) {
  if (reply.error !== undefined || (reply.status ?? 200) >= 400) {
    const status = reply.status ?? 500
    response.writeHead(status, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ error: reply.error ?? { type: 'echo-upstream-injected', status } }))
    return true
  }
  const payload = assemble(parsedBody?.model ?? null, protocol, reply)
  if (!parsedBody?.stream) {
    response.writeHead(reply.status ?? 200, { 'content-type': 'application/json' })
    response.end(JSON.stringify(payload))
    return true
  }
  response.writeHead(reply.status ?? 200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' })
  const controller = new AbortController()
  const cancel = () => controller.abort()
  response.once('close', cancel)
  let sequence = 0
  try {
    for (const { event, delay } of pacedEvents(payload, protocol, reply.stream ?? {})) {
      if (controller.signal.aborted || response.destroyed) break
      if (delay > 0) await sleep(delay, undefined, { signal: controller.signal })
      if (controller.signal.aborted || response.destroyed) break
      const data = protocol === 'responses' ? { ...event, sequence_number: sequence++ } : event
      const prefix = protocol === 'openai' ? '' : `event: ${data.type}\n`
      const writable = response.write(`${prefix}data: ${typeof data === 'string' ? data : JSON.stringify(data)}\n\n`)
      if (!writable) await once(response, 'drain', { signal: controller.signal })
    }
    if (!response.destroyed && !controller.signal.aborted) response.end()
  } catch (error) {
    if (!controller.signal.aborted) throw error
  } finally {
    response.removeListener('close', cancel)
  }
  return true
}
