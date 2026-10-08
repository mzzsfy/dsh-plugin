// 三协议非流式响应装配:路径含 /responses 走 openai responses 形状,
// 含 /messages 走 anthropic message 形状,
// GET /models 按客户端协议(anthropic-version 头)回双形态列表,其余回 openai chat.completion 形状。
// 模型名回显请求 model;usage 为固定最小值,由场景层(--tokens)覆写。
import { THINKING_TEXT, TOOL_NAME, TOOL_ARGUMENTS } from './scenarios.mjs'

export const FIXED_CONTENT = 'echo-upstream-fixed'
export const MODEL_ID = 'echo-model'

export function anthropicResponse(model, usage = { input_tokens: 1, output_tokens: 1 }) {
  return {
    id: 'msg_echo-upstream', type: 'message', role: 'assistant', model,
    content: [{ type: 'text', text: FIXED_CONTENT }],
    stop_reason: 'end_turn', stop_sequence: null,
    usage,
  }
}

export function openaiResponse(model, usage = { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }, message = { role: 'assistant', content: FIXED_CONTENT }) {
  return {
    id: 'chatcmpl-echo-upstream', object: 'chat.completion', created: 0, model,
    choices: [{ index: 0, message, finish_reason: 'stop' }],
    usage,
  }
}

export function responsesResponse(model, usage = { input_tokens: 1, output_tokens: 1, total_tokens: 2 }) {
  return {
    id: 'resp_echo-upstream', object: 'response', created: 0, status: 'completed', model,
    output: [{ type: 'message', id: 'msg_echo-upstream', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: FIXED_CONTENT, annotations: [] }] }],
    usage,
  }
}

export function modelListResponse(headers, models = [MODEL_ID]) {
  const list = models?.length ? models : [MODEL_ID]
  if (headers['anthropic-version'] !== undefined) {
    return { data: list.map((id) => ({ id, type: 'model', display_name: id })), has_more: false }
  }
  return { object: 'list', data: list.map((id) => ({ id, object: 'model', created: 0, owned_by: 'echo-upstream' })) }
}

// 协议判定与 usage 装配集中于此;usage 覆写由 options.tokens 提供;thinking 场景注入 reasoning 内容块
export function respondFor(method, path, headers, parsedBody, options = {}) {
  const model = parsedBody?.model ?? null
  if (method === 'GET' && path.includes('/models')) return modelListResponse(headers, options.models)
  const thinking = options.scenario === 'think'
  const scenarioTool = options.scenario === 'tool'
  const [input = 1, output = 1] = options.tokens ?? []
  if (path.includes('/responses')) {
    const usage = { input_tokens: input, output_tokens: output, total_tokens: input + output }
    return thinking
      ? { ...responsesResponse(model, usage), output: [{ type: 'reasoning', id: 'rs_echo-upstream', summary: [] }, ...responsesResponse(model, usage).output] }
      : responsesResponse(model, usage)
  }
  if (path.includes('/messages')) {
    const content = thinking
      ? [{ type: 'thinking', thinking: THINKING_TEXT }, { type: 'text', text: FIXED_CONTENT }]
      : scenarioTool
        ? [{ type: 'tool_use', id: 'toolu_echo-upstream', name: TOOL_NAME, input: JSON.parse(TOOL_ARGUMENTS) }]
        : [{ type: 'text', text: FIXED_CONTENT }]
    const stopReason = scenarioTool ? 'tool_use' : 'end_turn'
    return { ...anthropicResponse(model, { input_tokens: input, output_tokens: output }), content, stop_reason: stopReason }
  }
  const message = thinking
    ? { role: 'assistant', reasoning_content: THINKING_TEXT, content: FIXED_CONTENT }
    : scenarioTool
      ? { role: 'assistant', content: null, tool_calls: [{ id: 'call_echo-upstream', type: 'function', function: { name: TOOL_NAME, arguments: TOOL_ARGUMENTS } }] }
      : { role: 'assistant', content: FIXED_CONTENT }
  const finishReason = scenarioTool ? 'tool_calls' : 'stop'
  return { ...openaiResponse(model, { prompt_tokens: input, completion_tokens: output, total_tokens: input + output }, message), choices: [{ index: 0, message, finish_reason: finishReason }] }
}
