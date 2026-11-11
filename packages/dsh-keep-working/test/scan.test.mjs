import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// 扫描日志必须落在临时目录,否则测试会写进真实 home
process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'keep-working-test-'))

import { resolveConfig } from '../src/config.mjs'
import { scanStoredSessions } from '../src/scan.mjs'

const TURN = 3
const NOW = 10_000_000

const event = (seq, type, data) => ({ seq, time: NOW, type, data })

const turnStart = (seq, turn) => event(seq, 'turn/start', { turn })
const turnEnd = (seq, turn, reason) => event(seq, 'turn/end', { turn, reason })
const assistant = (seq, turn, text) =>
  event(seq, 'assistant/message', {
    turn,
    step: 1,
    message: { role: 'assistant', content: [{ type: 'text', text }] },
    stream: [],
  })
const userMessage = (seq, kind = 'user') =>
  event(seq, 'user/message', { id: `m-${seq}`, source: { kind }, content: [{ type: 'text', text: 'go' }] })

const openTail = [
  turnStart(1, TURN),
  userMessage(2),
  assistant(3, TURN, '没结案'),
  turnEnd(4, TURN, { kind: 'completed' }),
]

const danglingTail = [
  turnStart(1, TURN),
  userMessage(2),
  assistant(3, TURN, '话说到一半'),
]

const closedTail = [
  turnStart(1, TURN),
  userMessage(2),
  assistant(3, TURN, '结论\n(TASK_DONE)'),
  turnEnd(4, TURN, { kind: 'completed' }),
]

function createHarness({ records, archived = [], goals, resumeFails = false, registryThrows = false } = {}) {
  const resumed = []
  const sent = []
  const agentsById = new Map()
  const query = {
    listSessions: async () => records,
    observeSession: async (id) => {
      const record = records.find((item) => item.header.id === id)
      return {
        header: record.header,
        events: record.events,
        [Symbol.dispose]() {},
      }
    },
  }
  const ctx = {
    get(name) {
      if (name === 'sessionQuery') return query
      if (name === 'goals') return goals
      if (name === 'workspaceRegistry') {
        if (registryThrows) throw new Error('workspace registry is not started yet')
        return { archivedSessionIds: archived }
      }
      return undefined
    },
    agents: {
      get: (id) => agentsById.get(id),
      resume: async ({ resumeSessionId }) => {
        if (resumeFails) throw new Error('resume failed')
        resumed.push(resumeSessionId)
        agentsById.set(resumeSessionId, {
          id: resumeSessionId,
          session: { id: resumeSessionId },
          inbox: { nextTurn: [] },
          followup: (message) => sent.push({ id: resumeSessionId, message }),
        })
        return { agent: agentsById.get(resumeSessionId) }
      },
    },
    workspaceRegistry: { archivedSessionIds: archived },
    logger: { info() {}, warn() {} },
  }
  return { ctx, resumed, sent, agentsById }
}

const record = (id, events, extra = {}) => ({
  header: { id, ...extra },
  events,
})

test('未闭合的存储会话被物化并补一条恢复消息', async () => {
  const h = createHarness({ records: [record('s1', danglingTail)] })
  const result = await scanStoredSessions({
    ctx: h.ctx,
    config: resolveConfig(),
    createUserMessage: (options) => ({ id: 'auto-1', ...options }),
    now: () => NOW,
    scanDirectory: () => undefined,
  })
  assert.equal(result.resumed, 1)
  assert.deepEqual(h.resumed, ['s1'])
  assert.equal(h.sent.length, 1)
})

test('已结案的会话不恢复', async () => {
  const h = createHarness({ records: [record('s1', closedTail)] })
  const result = await scanStoredSessions({
    ctx: h.ctx,
    config: resolveConfig(),
    createUserMessage: (options) => ({ id: 'auto-1', ...options }),
    now: () => NOW,
    scanDirectory: () => undefined,
  })
  assert.equal(result.resumed, 0)
  assert.equal(h.sent.length, 0)
})

test('子会话不单独恢复', async () => {
  const h = createHarness({ records: [record('s1', danglingTail, { origin: 'subagent' })] })
  const result = await scanStoredSessions({
    ctx: h.ctx,
    config: resolveConfig(),
    createUserMessage: (options) => ({ id: 'auto-1', ...options }),
    now: () => NOW,
    scanDirectory: () => undefined,
  })
  assert.equal(result.resumed, 0)
})

test('旧格式子会话(parentSession + delegationDepth)不恢复', async () => {
  for (const extra of [
    { parentSession: 'root', delegationDepth: 1 },
    { parentSession: 'root', delegationDepth: 2 },
  ]) {
    const h = createHarness({ records: [record('s1', danglingTail, extra)] })
    const result = await scanStoredSessions({
      ctx: h.ctx,
      config: resolveConfig(),
      createUserMessage: (options) => ({ id: 'auto-1', ...options }),
      now: () => NOW,
      scanDirectory: () => undefined,
    scanDirectory: () => undefined,
    })
    assert.equal(result.resumed, 0)
  }
  const fork = createHarness({ records: [record('s1', danglingTail, { parentSession: 'root', delegationDepth: 0 })] })
  const result = await scanStoredSessions({
    ctx: fork.ctx,
    config: resolveConfig(),
    createUserMessage: (options) => ({ id: 'auto-1', ...options }),
    now: () => NOW,
    scanDirectory: () => undefined,
  })
  assert.equal(result.resumed, 1, 'depth 0 是普通 fork,应参与恢复')
})

test('已归档会话不恢复', async () => {
  const h = createHarness({ records: [record('s1', openTail)], archived: ['s1'] })
  const result = await scanStoredSessions({
    ctx: h.ctx,
    config: resolveConfig(),
    createUserMessage: (options) => ({ id: 'auto-1', ...options }),
    now: () => NOW,
    scanDirectory: () => undefined,
  })
  assert.equal(result.resumed, 0)
})

test('超出新鲜窗口的会话不恢复', async () => {
  const stale = openTail.map((item) => ({ ...item, time: NOW - 60 * 60_000 }))
  const h = createHarness({ records: [record('s1', stale)] })
  const result = await scanStoredSessions({
    ctx: h.ctx,
    config: resolveConfig(),
    createUserMessage: (options) => ({ id: 'auto-1', ...options }),
    now: () => NOW,
    scanDirectory: () => undefined,
  })
  assert.equal(result.resumed, 0)
})

test('用户主动取消的会话不恢复', async () => {
  const tail = [...openTail.slice(0, 3), turnEnd(4, TURN, { kind: 'aborted', reason: { kind: 'user' } })]
  const h = createHarness({ records: [record('s1', tail)] })
  const result = await scanStoredSessions({
    ctx: h.ctx,
    config: resolveConfig(),
    createUserMessage: (options) => ({ id: 'auto-1', ...options }),
    now: () => NOW,
    scanDirectory: () => undefined,
  })
  assert.equal(result.resumed, 0)
})

test('未闭合的回合按未结案恢复', async () => {
  const tail = [turnStart(1, TURN), userMessage(2)]
  const h = createHarness({ records: [record('s1', tail)] })
  const result = await scanStoredSessions({
    ctx: h.ctx,
    config: resolveConfig(),
    createUserMessage: (options) => ({ id: 'auto-1', ...options }),
    now: () => NOW,
    scanDirectory: () => undefined,
  })
  assert.equal(result.resumed, 1)
})

test('scanLimit 限制单轮恢复数量', async () => {
  const records = [
    record('s1', openTail),
    record('s2', danglingTail),
    record('s3', danglingTail),
  ]
  const h = createHarness({ records })
  const result = await scanStoredSessions({
    ctx: h.ctx,
    config: resolveConfig({ scanLimit: 2 }),
    createUserMessage: (options) => ({ id: 'auto-1', ...options }),
    now: () => NOW,
    scanDirectory: () => undefined,
  })
  assert.equal(result.resumed, 2)
})

test('物化失败不阻断后续会话', async () => {
  const h = createHarness({ records: [record('s1', openTail)], resumeFails: true })
  const result = await scanStoredSessions({
    ctx: h.ctx,
    config: resolveConfig(),
    createUserMessage: (options) => ({ id: 'auto-1', ...options }),
    now: () => NOW,
    scanDirectory: () => undefined,
  })
  assert.equal(result.resumed, 0)
})

test('goal 失活时重新武装', async () => {
  const resumedGoals = []
  const goals = {
    get: (agent) => ({ id: 'g1', revision: 4, phase: 'active', activation: 'disarmed', agent: agent.id }),
    resume: (agent, ref) => resumedGoals.push({ agent: agent.id, ref }),
  }
  const h = createHarness({ records: [record('s1', danglingTail)], goals })
  await scanStoredSessions({
    ctx: h.ctx,
    config: resolveConfig({ resumeGoals: true }),
    createUserMessage: (options) => ({ id: 'auto-1', ...options }),
    now: () => NOW,
    scanDirectory: () => undefined,
  })
  assert.deepEqual(resumedGoals, [{ agent: 's1', ref: { id: 'g1', revision: 4 } }])
})

test('scanOnBoot 关闭时不扫描', async () => {
  const h = createHarness({ records: [record('s1', openTail)] })
  const result = await scanStoredSessions({
    ctx: h.ctx,
    config: resolveConfig({ scanOnBoot: false }),
    createUserMessage: (options) => ({ id: 'auto-1', ...options }),
    now: () => NOW,
    scanDirectory: () => undefined,
  })
  assert.equal(result.resumed, 0)
  assert.equal(h.resumed.length, 0)
})

test('预算用尽时标记未完成', async () => {
  const h = createHarness({ records: [record('s1', openTail), record('s2', danglingTail)] })
  const result = await scanStoredSessions({
    ctx: h.ctx,
    config: resolveConfig(),
    createUserMessage: (options) => ({ id: 'auto-1', ...options }),
    now: () => NOW,
    scanDirectory: () => undefined,
    budgetMs: 0,
  })
  assert.equal(result.complete, false)
  assert.equal(result.resumed, 0)
})

test('下一轮跳过已裁决会话,继续处理剩余', async () => {
  const h = createHarness({ records: [record('s1', closedTail), record('s2', danglingTail)] })
  const seen = new Set(['s1'])
  const result = await scanStoredSessions({
    ctx: h.ctx,
    config: resolveConfig(),
    createUserMessage: (options) => ({ id: 'auto-1', ...options }),
    now: () => NOW,
    scanDirectory: () => undefined,
    seen,
  })
  assert.equal(result.complete, true)
  assert.equal(result.scanned, 1)
  assert.deepEqual(h.resumed, ['s2'])
})

test('归档集合未就绪时本轮不恢复', async () => {
  const h = createHarness({ records: [record('s1', danglingTail)], registryThrows: true })
  const result = await scanStoredSessions({
    ctx: h.ctx,
    config: resolveConfig(),
    createUserMessage: (options) => ({ id: 'auto-1', ...options }),
    now: () => NOW,
    scanDirectory: () => undefined,
  })
  assert.equal(result.resumed, 0)
  assert.equal(result.complete, false)
  assert.deepEqual(h.resumed, [])
})

test('目录扫描按修改时间筛出近期会话', async () => {
  const { mkdtempSync, mkdirSync, writeFileSync, utimesSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const { listFreshByDirectory } = await import('../src/scan.mjs')

  const home = mkdtempSync(join(tmpdir(), 'keep-working-dir-'))
  const artifact = (id) => {
    const dir = join(home, 'sessions', 'ws', id)
    mkdirSync(dir, { recursive: true })
    const file = join(dir, 'session.v4.jsonl.zstd')
    writeFileSync(file, 'x')
    return file
  }
  const freshPath = artifact('session-fresh')
  const stalePath = artifact('session-stale')
  const nowSeconds = NOW / 1000
  utimesSync(freshPath, nowSeconds, nowSeconds)
  utimesSync(stalePath, nowSeconds - 3600, nowSeconds - 3600)

  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = home
  try {
    const found = listFreshByDirectory(resolveConfig(), NOW)
    assert.deepEqual(found.map((item) => item.id), ['session-fresh'])
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
  }
})
