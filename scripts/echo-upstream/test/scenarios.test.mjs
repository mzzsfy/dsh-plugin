// BDD 场景 7-10:thinking 块与最小错误注入,经模型名后缀触发。
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { start } from '../server.mjs'
import { installDelegate } from '../streaming.mjs'
import { parseSse } from './helpers.mjs'

async function launch(options = {}) {
  const log = join(mkdtempSync(join(tmpdir(), 'echo-upstream-test-')), 'requests.jsonl')
  const server = await start({ port: 0, log, ...installDelegate(options), ...options })
  const base = `http://127.0.0.1:${server.address().port}`
  return { base, log, close: () => { server.close(); server.closeIdleConnections() } }
}

const post = (base, path, body) => fetch(base + path, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
})

test('thinking 模型流式含 reasoning 块(openai reasoning_content + anthropic thinking)', async () => {
  const { base, close } = await launch()
  try {
    const o = await post(base, '/v1/chat/completions', { model: 'echo-model-think', stream: true })
    const chunks = parseSse(await o.text()).map((e) => e.data).filter((d) => d !== '[DONE]').map((d) => JSON.parse(d))
    const reasoning = chunks.find((c) => c.choices?.[0]?.delta?.reasoning_content)
    assert.equal(reasoning.choices[0].delta.reasoning_content, 'echo-upstream-thinking')

    const a = await post(base, '/v1/messages', { model: 'echo-model-think', stream: true })
    const events = parseSse(await a.text())
    const thinkStart = events.find((e) => JSON.parse(e.data).content_block?.type === 'thinking')
    assert.ok(thinkStart)
    const thinkDelta = events.map((e) => JSON.parse(e.data)).find((d) => d.delta?.type === 'thinking_delta')
    assert.equal(thinkDelta.delta.thinking, 'echo-upstream-thinking')
  } finally { close() }
})

test('thinking 模型非流式含 reasoning 内容块', async () => {
  const { base, close } = await launch()
  try {
    const o = await post(base, '/v1/chat/completions', { model: 'echo-model-think' })
    const ob = await o.json()
    assert.equal(ob.choices[0].message.reasoning_content, 'echo-upstream-thinking')
    assert.equal(ob.choices[0].message.content, 'echo-upstream-fixed')

    const a = await post(base, '/v1/messages', { model: 'echo-model-think' })
    const ab = await a.json()
    assert.equal(ab.content[0].type, 'thinking')
    assert.equal(ab.content[0].thinking, 'echo-upstream-thinking')
    assert.equal(ab.content[1].text, 'echo-upstream-fixed')
  } finally { close() }
})

test('错误码注入 -err429 与 -err500', async () => {
  const { base, close } = await launch()
  try {
    const r429 = await post(base, '/v1/chat/completions', { model: 'echo-model-err429' })
    assert.equal(r429.status, 429)
    const r500 = await post(base, '/v1/messages', { model: 'echo-model-err500' })
    assert.equal(r500.status, 500)
  } finally { close() }
})

test('drop 模型流式部分块后中断', async () => {
  const { base, close } = await launch()
  try {
    const res = await post(base, '/v1/chat/completions', { model: 'echo-model-drop', stream: true })
    const text = await res.text()
    const payloads = parseSse(text).map((e) => e.data)
    assert.equal(payloads.includes('[DONE]'), false)
    assert.ok(payloads.length >= 1 && payloads.length < 4)
  } finally { close() }
})

test('slow 模型流式块间有间隔', async () => {
  const { base, close } = await launch()
  try {
    const t0 = Date.now()
    const res = await post(base, '/v1/chat/completions', { model: 'echo-model-slow', stream: true })
    await res.text()
    assert.ok(Date.now() - t0 >= 400, `耗时 ${Date.now() - t0}ms,慢速块间隔未生效`)
  } finally { close() }
})

test('非流式不受 drop/slow 影响,仅流式注入生效', async () => {
  const { base, close } = await launch()
  try {
    const res = await post(base, '/v1/chat/completions', { model: 'echo-model-drop' })
    assert.equal(res.status, 200)
    assert.equal((await res.json()).object, 'chat.completion')
  } finally { close() }
})

test('tool 模型非流式产出 tool_calls/tool_use(name=shell)', async () => {
  const { base, close } = await launch()
  try {
    const o = await post(base, '/v1/chat/completions', { model: 'echo-model-tool' })
    const ob = await o.json()
    assert.equal(ob.choices[0].finish_reason, 'tool_calls')
    const call = ob.choices[0].message.tool_calls[0]
    assert.equal(call.function.name, 'shell')
    assert.deepEqual(JSON.parse(call.function.arguments), { command: 'echo echo-upstream-tool', description: 'echo-upstream tool probe' })

    const a = await post(base, '/v1/messages', { model: 'echo-model-tool' })
    const ab = await a.json()
    assert.equal(ab.stop_reason, 'tool_use')
    assert.equal(ab.content[0].type, 'tool_use')
    assert.equal(ab.content[0].name, 'shell')
    assert.deepEqual(ab.content[0].input, { command: 'echo echo-upstream-tool', description: 'echo-upstream tool probe' })
  } finally { close() }
})

test('tool 模型流式产出 tool_calls delta 与 finish_reason=tool_calls / stop_reason=tool_use', async () => {
  const { base, close } = await launch()
  try {
    const o = await post(base, '/v1/chat/completions', { model: 'echo-model-tool', stream: true })
    const chunks = parseSse(await o.text()).map((e) => e.data).filter((d) => d !== '[DONE]').map((d) => JSON.parse(d))
    const callDelta = chunks.find((c) => c.choices?.[0]?.delta?.tool_calls)
    assert.equal(callDelta.choices[0].delta.tool_calls[0].function.name, 'shell')
    assert.equal(callDelta.choices[0].delta.tool_calls[0].function.arguments, '{"command":"echo echo-upstream-tool","description":"echo-upstream tool probe"}')
    assert.ok(chunks.some((c) => c.choices?.[0]?.finish_reason === 'tool_calls'))
    assert.ok(chunks.some((c) => Array.isArray(c.choices) && c.choices.length === 0 && c.usage))

    const a = await post(base, '/v1/messages', { model: 'echo-model-tool', stream: true })
    const events = parseSse(await a.text()).map((e) => JSON.parse(e.data))
    const toolStart = events.find((e) => e.content_block?.type === 'tool_use')
    assert.equal(toolStart.content_block.name, 'shell')
    const jsonDelta = events.find((e) => e.delta?.type === 'input_json_delta')
    assert.equal(jsonDelta.delta.partial_json, '{"command":"echo echo-upstream-tool","description":"echo-upstream tool probe"}')
    assert.ok(events.some((e) => e.delta?.stop_reason === 'tool_use'))
    assert.ok(events.some((e) => e.type === 'message_stop'))
  } finally { close() }
})

test('call 模型产出 rs_workflow_start 工具调用(非流式双协议)', async () => {
  const { base, close } = await launch()
  try {
    const expected = { request: 'compat rsww run probe', templateId: 'compat-test', plan: { brief: 'compat acceptance', steps: [{ ref: 'first', note: 'echo-upstream -call probe', done: 'result 回填' }] } }
    const o = await post(base, '/v1/chat/completions', { model: 'echo-model-call' })
    const ob = await o.json()
    assert.equal(ob.choices[0].finish_reason, 'tool_calls')
    const call = ob.choices[0].message.tool_calls[0]
    assert.equal(call.function.name, 'rs_workflow_start')
    assert.deepEqual(JSON.parse(call.function.arguments), expected)

    const a = await post(base, '/v1/messages', { model: 'echo-model-call' })
    const ab = await a.json()
    assert.equal(ab.stop_reason, 'tool_use')
    assert.equal(ab.content[0].type, 'tool_use')
    assert.equal(ab.content[0].name, 'rs_workflow_start')
    assert.deepEqual(ab.content[0].input, expected)
  } finally { close() }
})

test('call 模型流式产出 rs_workflow_start delta 与终止原因', async () => {
  const { base, close } = await launch()
  try {
    const o = await post(base, '/v1/chat/completions', { model: 'echo-model-call', stream: true })
    const chunks = parseSse(await o.text()).map((e) => e.data).filter((d) => d !== '[DONE]').map((d) => JSON.parse(d))
    const callDelta = chunks.find((c) => c.choices?.[0]?.delta?.tool_calls)
    assert.equal(callDelta.choices[0].delta.tool_calls[0].function.name, 'rs_workflow_start')
    assert.ok(chunks.some((c) => c.choices?.[0]?.finish_reason === 'tool_calls'))
    assert.ok(chunks.some((c) => Array.isArray(c.choices) && c.choices.length === 0 && c.usage))

    const a = await post(base, '/v1/messages', { model: 'echo-model-call', stream: true })
    const events = parseSse(await a.text()).map((e) => JSON.parse(e.data))
    const toolStart = events.find((e) => e.content_block?.type === 'tool_use')
    assert.equal(toolStart.content_block.name, 'rs_workflow_start')
    const jsonDelta = events.find((e) => e.delta?.type === 'input_json_delta')
    assert.deepEqual(JSON.parse(jsonDelta.delta.partial_json).templateId, 'compat-test')
    assert.ok(events.some((e) => e.delta?.stop_reason === 'tool_use'))
  } finally { close() }
})

test('tool 场景默认模型不受影响(default 仍为纯文本 stop)', async () => {
  const { base, close } = await launch()
  try {
    const res = await post(base, '/v1/chat/completions', { model: 'echo-model' })
    const body = await res.json()
    assert.equal(body.choices[0].finish_reason, 'stop')
    assert.equal(body.choices[0].message.content, 'echo-upstream-fixed')
    assert.equal(body.choices[0].message.tool_calls, undefined)
  } finally { close() }
})
