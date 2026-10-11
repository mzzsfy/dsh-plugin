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

test('cancelSession 请求取消并保留队列项由 updateQueue 移除', async () => {
  const { controller, calls } = stubController()
  const adapter = createSessionAdapter({ sessionController: controller })
  await adapter.cancelSession({ sessionId: 's1', pendingItemIds: ['i1', 'i2'] })
  assert.deepEqual(calls[0], ['cancel', { sessionId: 's1' }])
  assert.deepEqual(calls[1], ['updateQueue', { sessionId: 's1', itemId: 'i1', action: 'remove' }])
  assert.deepEqual(calls[2], ['updateQueue', { sessionId: 's1', itemId: 'i2', action: 'remove' }])
})
