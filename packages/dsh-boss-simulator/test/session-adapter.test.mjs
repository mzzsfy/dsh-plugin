// 会话适配测试:创建幂等、prompt requestId 铸造、cancel 与队列清理
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { createSessionAdapter } from '../lib/session-adapter.mjs'

function stubController() {
  const calls = []
  const sessions = new Map()
  return {
    calls,
    controller: {
      async create(request) {
        calls.push(['create', request])
        const sessionId = request.sessionId ?? `s${sessions.size + 1}`
        if (request.sessionId && sessions.has(request.sessionId) && sessions.get(request.sessionId).cwd !== request.cwd) {
          throw new Error('ApiSessionCwdConflict')
        }
        sessions.set(sessionId, request)
        return { sessionId, agentPreset: request.agentPreset }
      },
      async prompt(request) {
        calls.push(['prompt', request])
        if (request.requestId && calls.filter((c) => c[0] === 'prompt' && c[1].requestId === request.requestId).length > 1) {
          return { accepted: false }
        }
        return { accepted: true }
      },
      async *follow(request) {
        calls.push(['follow', request])
        yield { type: 'snapshot', records: [
          { event: { type: 'turn/start', seq: 1, time: 90, data: { turn: 7 } } },
          { event: { type: 'user/message', seq: 2, time: 100, data: { turn: 7, message: { source: { kind: 'user', rpcId: 'req-7' } } } } },
          { event: { type: 'assistant/message', seq: 4 } },
          { event: { type: 'turn/end', seq: 5 } },
        ] }
        yield { type: 'assistant-stream', frame: { type: 'chunk', index: 1 } }
        yield { type: 'event', event: { type: 'assistant/message', seq: 6 } }
      },
      cancel(request) { calls.push(['cancel', request]); return { requested: true } },
      async updateQueue(request) { calls.push(['updateQueue', request]); return {} },
    },
  }
}

test('ensureSession 无 sessionId 时新建,带 sessionId 幂等收养', async () => {
  const { controller, calls } = stubController()
  const adapter = createSessionAdapter({ sessionController: controller })
  const first = await adapter.ensureSession({ workspaceId: 'w1', cwd: 'C:/p', agentPreset: 'p1' })
  const again = await adapter.ensureSession({ sessionId: first.sessionId, workspaceId: 'w1', cwd: 'C:/p', agentPreset: 'p1' })
  assert.equal(again.sessionId, first.sessionId)
  assert.equal(calls.filter((c) => c[0] === 'create').length, 2)
})

test('dispatchPrompt 携带稳定 requestId,重复投递由宿主去重', async () => {
  const { controller, calls } = stubController()
  const adapter = createSessionAdapter({ sessionController: controller })
  const intent = { sessionId: 's1', requestId: 'req-1', content: [{ type: 'text', text: 'hello' }] }
  const first = await adapter.dispatchPrompt(intent)
  const second = await adapter.dispatchPrompt(intent)
  assert.equal(first.accepted, true)
  assert.equal(second.accepted, false)
  assert.equal(calls.filter((c) => c[0] === 'prompt').length, 2)
})

test('followSessionEvents exposes durable snapshot/events but skips transient stream frames', async () => {
  const { controller, calls } = stubController()
  const adapter = createSessionAdapter({ sessionController: controller })
  const events = []
  for await (const event of adapter.followSessionEvents('s1', new AbortController().signal)) events.push(event)
  assert.deepEqual(events.map(({ type, seq }) => [type, seq]), [['turn/start', 1], ['user/message', 2], ['assistant/message', 4], ['turn/end', 5], ['assistant/message', 6]])
  assert.deepEqual(calls[0], ['follow', { address: { kind: 'session', sessionId: 's1' } }])
})

test('Given follow snapshot 截断历史 When 订阅 Then page 补齐并按 seq 消费所有 durable 事件', async () => {
  const calls = []
  const controller = {
    async *follow() { yield { type: 'snapshot', cursor: 6, hasMore: true, records: [{ event: { type: 'turn/end', seq: 6 } }] } },
    async page(request) { calls.push(request); return { hasMore: false, records: [{ event: { type: 'user/message', seq: 1 } }, { event: { type: 'assistant/message', seq: 5 } }] } },
  }
  const events = []
  for await (const event of createSessionAdapter({ sessionController: controller }).followSessionEvents('s1', new AbortController().signal)) events.push(event)
  assert.deepEqual(events.map(event => event.seq), [1, 5, 6])
  assert.equal(calls[0].throughSeq, 6)
  assert.equal(calls[0].beforeSeq, 6)
})

test('Given idle 会话仍有排队输入 When inspectSession Then 返回真实pending队列且不判定停止', async () => {
  const calls = []
  const adapter = createSessionAdapter({ sessionController: {
    async projections(request, signal) { calls.push(['projections', request]); assert.ok(signal instanceof AbortSignal); return { asOfSeq: 9, values: { inbox: { 'next-turn': [{ id: 'queued-1' }], 'next-step': [{ id: 'steer-1' }] } } } },
    async list(request, signal) { calls.push(['list', request]); assert.ok(signal instanceof AbortSignal); return { items: [{ sessionId: 's1', running: false }] } },
  } })
  const inspected = await adapter.inspectSession({ sessionId: 's1' })
  assert.equal(inspected.running, false)
  assert.deepEqual(inspected.pendingItemIds, ['queued-1', 'steer-1'])
  assert.equal(inspected.stopped, false)
  assert.deepEqual(calls, [['projections', { sessionId: 's1' }], ['list', {}], ['projections', { sessionId: 's1' }]])
})

test('Given inbox在list读取期间变化 When inspectSession Then 不接受旧空队列停止证据', async () => {
  let reads = 0
  const adapter = createSessionAdapter({ sessionController: {
    async projections() { reads += 1; return { asOfSeq: reads, values: { inbox: { 'next-turn': reads === 1 ? [] : [{ id: 'new-q' }], 'next-step': [] } } } },
    async list() { return { items: [{ sessionId: 's1', running: false }] } },
  } })
  await assert.rejects(() => adapter.inspectSession({ sessionId: 's1' }), /变化/)
})

test('Given inbox投影不可用 When inspectSession Then 拒绝把idle当已停', async () => {
  const adapter = createSessionAdapter({ sessionController: {
    async projections() { return { asOfSeq: 9, values: {} } },
    async list() { return { items: [{ sessionId: 's1', running: false }] } },
  } })
  await assert.rejects(() => adapter.inspectSession({ sessionId: 's1' }), /inbox/)
})

test('Given list中会话不可达 When inspectSession Then 不推断会话已停', async () => {
  const adapter = createSessionAdapter({ sessionController: {
    async projections() { return { asOfSeq: 9, values: { inbox: { 'next-turn': [], 'next-step': [] } } } },
    async list() { return { items: [] } },
  } })
  await assert.rejects(() => adapter.inspectSession({ sessionId: 'missing' }), /运行状态/)
})

test('Given pending队列删除失败 When cancelSession Then 返回错误供停止状态保持未确认', async () => {
  const adapter = createSessionAdapter({ sessionController: {
    cancel() { return { accepted: true } },
    async updateQueue() { throw new Error('queue removal failed') },
  } })
  await assert.rejects(() => adapter.cancelSession({ sessionId: 's1', pendingItemIds: ['q1'] }), /queue removal failed/)
})

test('cancelSession 请求取消并保留队列项由 updateQueue 移除', async () => {
  const { controller, calls } = stubController()
  const adapter = createSessionAdapter({ sessionController: controller })
  await adapter.cancelSession({ sessionId: 's1', pendingItemIds: ['i1', 'i2'] })
  assert.deepEqual(calls[0], ['cancel', { sessionId: 's1' }])
  assert.deepEqual(calls[1], ['updateQueue', { sessionId: 's1', itemId: 'i1', action: { kind: 'remove' } }])
  assert.deepEqual(calls[2], ['updateQueue', { sessionId: 's1', itemId: 'i2', action: { kind: 'remove' } }])
})
