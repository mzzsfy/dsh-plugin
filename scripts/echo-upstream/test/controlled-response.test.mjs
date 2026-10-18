import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import test from 'node:test'

async function fixture(t, protocol, reply, onComplete = () => {}) {
  const { respondControlled } = await import('../controlled-response.mjs')
  const server = createServer(async (request, response) => {
    const chunks = []
    for await (const chunk of request) chunks.push(chunk)
    await respondControlled(response, { model: 'controlled-model', ...JSON.parse(Buffer.concat(chunks)) }, protocol, reply)
    onComplete(response)
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  t.after(() => new Promise((resolve) => {
    server.close(resolve)
    server.closeAllConnections()
  }))
  return (stream = false) => fetch(`http://127.0.0.1:${server.address().port}/reply`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'controlled-model', stream }),
  })
}

function eventsOf(wire) {
  return wire.trim().split(/\r?\n\r?\n/).map((frame) => {
    const data = frame.split(/\r?\n/).find((line) => line.startsWith('data: '))?.slice(6)
    return data === '[DONE]' ? data : JSON.parse(data)
  })
}

for (const protocol of ['openai', 'anthropic', 'responses']) {
  test(`${protocol} SSE: 思考与正文独立分片间隔且Unicode不拆坏`, async (t) => {
    // Given 两类流速度不同；When 读取真实HTTP分片；Then 内容、片数和各自延迟均可观察。
    const request = await fixture(t, protocol, {
      text: '甲😀乙丙', thinking: '一二三四',
      stream: { chunkSize: 1, intervalMs: 4, thinkingChunkSize: 2, thinkingIntervalMs: 9 },
    })
    const started = performance.now()
    const response = await request(true)
    const events = eventsOf(await response.text())
    const elapsed = performance.now() - started
    const text = protocol === 'openai' ? events.flatMap((event) => event.choices?.[0]?.delta.content === undefined ? [] : [event.choices[0].delta.content])
      : protocol === 'anthropic' ? events.filter((event) => event.delta?.type === 'text_delta').map((event) => event.delta.text)
        : events.filter((event) => event.type === 'response.output_text.delta').map((event) => event.delta)
    const thinking = protocol === 'openai' ? events.flatMap((event) => event.choices?.[0]?.delta.reasoning_content === undefined ? [] : [event.choices[0].delta.reasoning_content])
      : protocol === 'anthropic' ? events.filter((event) => event.delta?.type === 'thinking_delta').map((event) => event.delta.thinking)
        : events.filter((event) => event.type === 'response.reasoning_summary_text.delta').map((event) => event.delta)
    assert.deepEqual(text, ['甲', '😀', '乙', '丙'])
    assert.deepEqual(thinking, ['一二', '三四'])
    assert.ok(elapsed >= 9 + 3 * 4 - 3, `间隔未生效: ${elapsed}ms`)
  })

  test(`${protocol} SSE: 客户端断开立即停止后续分片并释放等待`, async (t) => {
    // Given 多片慢速回复；When 客户端取消HTTP读取；Then 发送任务提前结束且响应未正常写完。
    let complete
    const completed = new Promise((resolve) => { complete = resolve })
    const request = await fixture(t, protocol, { text: '一二三四五六七八九十', stream: { chunkSize: 1, intervalMs: 10 } }, complete)
    const response = await request(true)
    const reader = response.body.getReader()
    await reader.read()
    await reader.cancel()
    let timeout
    try {
      const finished = await Promise.race([
        completed,
        new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error('断开后仍等待完整发送')), 80) }),
      ])
      assert.equal(finished.writableEnded, false)
      assert.equal(finished.destroyed, true)
    } finally {
      clearTimeout(timeout)
    }
  })

  for (const stream of [false, true]) {
    test(`${protocol} ${stream ? 'SSE' : 'JSON'}: 仅工具回复不凭空添加正文`, async (t) => {
      // Given 回复仅有工具；When 发送HTTP请求；Then 不出现虚构的正文块且默认usage有效。
      const request = await fixture(t, protocol, { toolCalls: [{ name: 'alpha', arguments: {} }] })
      const response = await request(stream)
      const wire = await response.text()
      const events = stream ? eventsOf(wire) : []
      const payload = !stream ? JSON.parse(wire) : protocol === 'responses' ? events.at(-1).response : null
      if (protocol === 'openai') {
        if (stream) {
          assert.ok(events.every((event) => event.choices?.[0]?.delta.content === undefined))
          assert.equal(events.at(-2).usage.total_tokens, 2)
        } else {
          assert.equal(payload.choices[0].message.content, null)
          assert.equal(payload.usage.total_tokens, 2)
        }
      } else if (protocol === 'anthropic') {
        if (stream) {
          assert.deepEqual(events.filter((event) => event.type === 'content_block_start').map((event) => event.content_block.type), ['tool_use'])
          assert.equal(events.at(-2).usage.output_tokens, 1)
        } else {
          assert.deepEqual(payload.content.map((block) => block.type), ['tool_use'])
          assert.deepEqual(payload.content[0].input, {})
        }
      } else {
        assert.deepEqual(payload.output.map((item) => item.type), ['function_call'])
        assert.equal(payload.usage.total_tokens, 2)
      }
    })

    test(`${protocol} ${stream ? 'SSE' : 'JSON'}: 显式空正文与零usage不被默认值覆盖`, async (t) => {
      // Given 空正文和零计数；When 发 HTTP 请求；Then 空值和零值原样可见。
      const request = await fixture(t, protocol, { text: '', tokens: [0, 0] })
      const response = await request(stream)
      const wire = await response.text()
      const events = stream ? eventsOf(wire) : []
      const payload = !stream ? JSON.parse(wire) : protocol === 'responses' ? events.at(-1).response : null
      if (protocol === 'openai') {
        if (stream) {
          assert.ok(events.some((event) => event.choices?.[0]?.delta.content === ''))
          assert.equal(events.at(-2).usage.total_tokens, 0)
          assert.equal(events.at(-3).choices[0].finish_reason, 'stop')
        } else {
          assert.equal(payload.choices[0].message.content, '')
          assert.equal(payload.usage.total_tokens, 0)
        }
      } else if (protocol === 'anthropic') {
        if (stream) {
          assert.ok(events.some((event) => event.delta?.type === 'text_delta' && event.delta.text === ''))
          assert.equal(events[0].message.usage.input_tokens, 0)
          assert.equal(events.at(-2).usage.output_tokens, 0)
          assert.equal(events.at(-2).delta.stop_reason, 'end_turn')
        } else {
          assert.deepEqual(payload.content, [{ type: 'text', text: '' }])
          assert.deepEqual(payload.usage, { input_tokens: 0, output_tokens: 0 })
        }
      } else {
        assert.equal(payload.output[0].content[0].text, '')
        assert.equal(payload.usage.total_tokens, 0)
        if (stream) assert.ok(events.some((event) => event.type === 'response.output_text.delta' && event.delta === ''))
      }
    })

    test(`${protocol} ${stream ? 'SSE请求' : 'JSON请求'}: HTTP错误统一返回JSON`, async (t) => {
      // Given 注入HTTP错误；When 客户端请求任意传输；Then 返回错误状态与JSON而不是成功SSE。
      const request = await fixture(t, protocol, { status: 429, error: { type: 'rate_limit', message: '受控错误' } })
      const response = await request(stream)
      assert.equal(response.status, 429)
      assert.match(response.headers.get('content-type'), /application\/json/)
      assert.deepEqual(await response.json(), { error: { type: 'rate_limit', message: '受控错误' } })
    })
  }
  test(`${protocol} SSE: 思考、正文和多个工具事件完整且usage为终值`, async (t) => {
    // Given 混合多工具回复；When 通过 HTTP 请求 stream；Then 可按协议事件恢复所有内容。
    const request = await fixture(t, protocol, {
      text: '正文', thinking: '推理', tokens: [7, 9],
      toolCalls: [{ id: 'call-a', name: 'alpha', arguments: { value: 3 } }, { id: 'call-b', name: 'beta', arguments: '{"value":4}' }],
    })
    const response = await request(true)
    assert.match(response.headers.get('content-type'), /text\/event-stream/)
    const events = eventsOf(await response.text())
    if (protocol === 'openai') {
      assert.equal(events.at(-1), '[DONE]')
      const chunks = events.slice(0, -1)
      assert.equal(chunks.map((event) => event.choices[0]?.delta.content ?? '').join(''), '正文')
      assert.equal(chunks.map((event) => event.choices[0]?.delta.reasoning_content ?? '').join(''), '推理')
      assert.deepEqual(chunks.flatMap((event) => event.choices[0]?.delta.tool_calls ?? []), [
        { index: 0, id: 'call-a', type: 'function', function: { name: 'alpha', arguments: '{"value":3}' } },
        { index: 1, id: 'call-b', type: 'function', function: { name: 'beta', arguments: '{"value":4}' } },
      ])
      assert.equal(chunks.at(-2).choices[0].finish_reason, 'tool_calls')
      assert.deepEqual(chunks.at(-1).usage, { prompt_tokens: 7, completion_tokens: 9, total_tokens: 16 })
    } else if (protocol === 'anthropic') {
      assert.equal(events[0].type, 'message_start')
      assert.equal(events.at(-1).type, 'message_stop')
      const starts = events.filter((event) => event.type === 'content_block_start')
      assert.deepEqual(starts.map((event) => event.content_block.type), ['thinking', 'text', 'tool_use', 'tool_use'])
      assert.deepEqual(starts.map((event) => event.index), [0, 1, 2, 3])
      const deltas = events.filter((event) => event.type === 'content_block_delta')
      assert.deepEqual(deltas.map((event) => event.delta), [
        { type: 'thinking_delta', thinking: '推理' }, { type: 'text_delta', text: '正文' },
        { type: 'input_json_delta', partial_json: '{"value":3}' }, { type: 'input_json_delta', partial_json: '{"value":4}' },
      ])
      assert.equal(events.filter((event) => event.type === 'content_block_stop').length, 4)
      assert.equal(events.at(-2).delta.stop_reason, 'tool_use')
      assert.equal(events.at(-2).usage.output_tokens, 9)
      assert.equal(events[0].message.usage.input_tokens, 7)
    } else {
      assert.equal(events[0].type, 'response.created')
      assert.equal(events.at(-1).type, 'response.completed')
      assert.deepEqual(events.map((event) => event.sequence_number), events.map((_, index) => index))
      assert.deepEqual(events.filter((event) => event.type === 'response.output_item.added').map((event) => event.item.type), ['reasoning', 'message', 'function_call', 'function_call'])
      assert.equal(events.find((event) => event.type === 'response.reasoning_summary_text.delta').delta, '推理')
      assert.equal(events.find((event) => event.type === 'response.output_text.delta').delta, '正文')
      for (const [index, name, args] of [[2, 'alpha', '{"value":3}'], [3, 'beta', '{"value":4}']]) {
        const tool = events.filter((event) => event.output_index === index)
        assert.deepEqual(tool.map((event) => event.type), [
          'response.output_item.added', 'response.function_call_arguments.delta',
          'response.function_call_arguments.done', 'response.output_item.done',
        ])
        assert.equal(tool[0].item.name, name)
        assert.equal(tool[0].item.arguments, '')
        assert.equal(tool[1].delta, args)
        assert.equal(tool[2].arguments, args)
        assert.equal(tool[3].item.arguments, args)
        assert.equal(tool[1].item_id, tool[0].item.id)
      }
      assert.deepEqual(events.at(-1).response.usage, { input_tokens: 7, output_tokens: 9, total_tokens: 16 })
    }
  })

  test(`${protocol} JSON: 思考、正文及多个工具保留并正确记账`, async (t) => {
    // Given 统一回复含思考、正文、对象和字符串工具参数；When 发真实 HTTP 请求；Then 三协议内容完整。
    const request = await fixture(t, protocol, {
      text: '正文', thinking: '推理', tokens: [7, 9],
      toolCalls: [
        { id: 'call-a', name: 'alpha', arguments: { value: 3 } },
        { name: 'beta', arguments: '{"value":4}' },
      ],
    })
    const response = await request()
    assert.equal(response.status, 200)
    assert.match(response.headers.get('content-type'), /application\/json/)
    const payload = await response.json()
    assert.equal(payload.model, 'controlled-model')
    if (protocol === 'openai') {
      const choice = payload.choices[0]
      assert.equal(choice.message.content, '正文')
      assert.equal(choice.message.reasoning_content, '推理')
      assert.equal(choice.finish_reason, 'tool_calls')
      assert.deepEqual(choice.message.tool_calls.map((call) => call.function), [
        { name: 'alpha', arguments: '{"value":3}' }, { name: 'beta', arguments: '{"value":4}' },
      ])
      assert.equal(choice.message.tool_calls[0].id, 'call-a')
      assert.ok(choice.message.tool_calls[1].id)
      assert.deepEqual(payload.usage, { prompt_tokens: 7, completion_tokens: 9, total_tokens: 16 })
    } else if (protocol === 'anthropic') {
      assert.deepEqual(payload.content.map((block) => block.type), ['thinking', 'text', 'tool_use', 'tool_use'])
      assert.equal(payload.content[0].thinking, '推理')
      assert.equal(payload.content[1].text, '正文')
      assert.deepEqual(payload.content.slice(2).map((block) => block.input), [{ value: 3 }, { value: 4 }])
      assert.equal(payload.stop_reason, 'tool_use')
      assert.deepEqual(payload.usage, { input_tokens: 7, output_tokens: 9 })
    } else {
      assert.deepEqual(payload.output.map((item) => item.type), ['reasoning', 'message', 'function_call', 'function_call'])
      assert.deepEqual(payload.output[0].summary, [{ type: 'summary_text', text: '推理' }])
      assert.equal(payload.output[1].content[0].text, '正文')
      assert.deepEqual(payload.output.slice(2).map((item) => [item.name, item.arguments]), [
        ['alpha', '{"value":3}'], ['beta', '{"value":4}'],
      ])
      assert.equal(payload.output[2].call_id, 'call-a')
      assert.deepEqual(payload.usage, { input_tokens: 7, output_tokens: 9, total_tokens: 16 })
    }
  })
}
