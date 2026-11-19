import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// 扫描日志必须落在临时目录,否则测试会写进真实 home
process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'keep-working-test-'))

import { DEFAULTS, resolveConfig } from '../src/config.mjs'
import { pendingInbox } from '../src/inbox.mjs'
import {
  createTraceThrottle,
  listFreshByDirectory,
  nextScanRetryMs,
  SCAN_RETRY_MAX_MS,
  SCAN_RETRY_MIN_MS,
  scanSettled,
  scanStoredSessions,
} from '../src/scan.mjs'

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
const queuedMessage = (seq, text = '排队消息') => ({
  id: `q-${seq}`,
  role: 'user',
  content: [{ type: 'text', text }],
  source: { kind: 'user' },
})
const inboxSpliced = (seq, target, inserted, start = 0, removedCount = 0) =>
  event(seq, 'agent/inbox/spliced', { target, start, removedCount, inserted })
const presented = (seq, turn) =>
  event(seq, 'deliverables/presented', { turn, callId: `p-${seq}`, files: [{ path: 'out.md' }] })

const textOf = (entry) => entry.message.content.map((block) => block.text).join('')

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

const closedDanglingTail = [
  turnStart(1, TURN),
  userMessage(2),
  assistant(3, TURN, '结论\nTASK_DONE'),
]

const closedTail = [
  turnStart(1, TURN),
  userMessage(2),
  assistant(3, TURN, '结论\nTASK_DONE'),
  turnEnd(4, TURN, { kind: 'completed' }),
]

function createHarness({
  records,
  archived = [],
  goals,
  resumeFails = false,
  resumeFailures = {},
  resumeNoAgent = false,
  observeFailures = {},
  sendFailures = {},
  registryThrows = false,
  onObserve,
  archivedRead,
} = {}) {
  const resumed = []
  const sent = []
  const agentsById = new Map()
  let noAgentRemaining = typeof resumeNoAgent === 'number' ? resumeNoAgent : (resumeNoAgent ? Infinity : 0)
  const query = {
    listSessions: async () => records,
    observeSession: async (id, options) => {
      onObserve?.(id, options)
      if ((observeFailures[id] ?? 0) > 0) {
        observeFailures[id] -= 1
        throw new Error(`observe failed: ${id}`)
      }
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
        return { archivedSessionIds: archivedRead === undefined ? archived : archivedRead() }
      }
      return undefined
    },
    agents: {
      get: (id) => agentsById.get(id),
      resume: async ({ resumeSessionId }) => {
        if (resumeFails) throw new Error('resume failed')
        if ((resumeFailures[resumeSessionId] ?? 0) > 0) {
          resumeFailures[resumeSessionId] -= 1
          throw new Error(`resume failed: ${resumeSessionId}`)
        }
        resumed.push(resumeSessionId)
        if (noAgentRemaining > 0) {
          noAgentRemaining -= 1
          return { agent: undefined }
        }
        agentsById.set(resumeSessionId, {
          id: resumeSessionId,
          session: { id: resumeSessionId },
          inbox: { nextTurn: [] },
          followup: (message) => {
            if ((sendFailures[resumeSessionId] ?? 0) > 0) {
              sendFailures[resumeSessionId] -= 1
              throw new Error(`send failed: ${resumeSessionId}`)
            }
            sent.push({ id: resumeSessionId, message, via: 'followup' })
          },
          steer: (message) => {
            if ((sendFailures[resumeSessionId] ?? 0) > 0) {
              sendFailures[resumeSessionId] -= 1
              throw new Error(`send failed: ${resumeSessionId}`)
            }
            sent.push({ id: resumeSessionId, message, via: 'steer' })
          },
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

test('目录扫描成功但没有近期会话时收工,不再每秒重扫', async () => {
  const h = createHarness({ records: [] })
  const base = h.ctx.get.bind(h.ctx)
  // 目录路径需要持久层提供会话头,否则无法区分子会话
  h.ctx.get = (name) => (name === 'sessionPersistence' ? { async list() { return [] }, async stat() { return undefined } } : base(name))
  const result = await scanStoredSessions({
    ctx: h.ctx,
    config: resolveConfig(),
    createUserMessage: (options) => ({ id: 'auto-1', ...options }),
    now: () => NOW,
    scanDirectory: () => ({ items: [], partial: false }),
  })
  assert.equal(result.source, 'directory')
  assert.equal(scanSettled(result), true, '目录快照为空表示近期无会话需恢复,不应继续重试')
})

test('目录部分可读时不当作权威快照', async () => {
  const h = createHarness({ records: [] })
  const base = h.ctx.get.bind(h.ctx)
  h.ctx.get = (name) => (name === 'sessionPersistence' ? { async list() { return [] }, async stat() { return undefined } } : base(name))
  // 有子目录读取失败:快照不完整,不能宣称近期没有待恢复会话
  const result = await scanStoredSessions({
    ctx: h.ctx,
    config: resolveConfig(),
    createUserMessage: (options) => ({ id: 'auto-1', ...options }),
    now: () => NOW,
    scanDirectory: () => ({ items: [], partial: true }),
  })
  assert.equal(result.source, 'partial')
  assert.equal(scanSettled(result), false, '快照不完整时必须重试')
})

test('目录部分可读但仍有候选时也不收工', async () => {
  // 快照不完整时找到的候选只是全部候选的子集,漏掉的部分无从得知
  assert.equal(scanSettled({ complete: true, source: 'partial', listed: 3 }), false)
})

test('目录不可用且持久层给出空快照时不算收工', async () => {
  const h = createHarness({ records: [] })
  const base = h.ctx.get.bind(h.ctx)
  // 持久层能连上但列出空快照:服务尚未就绪的典型形态,不能与目录快照混为一谈
  h.ctx.get = (name) => (name === 'sessionPersistence' ? { async list() { return [] } } : base(name))
  const result = await scanStoredSessions({
    ctx: h.ctx,
    config: resolveConfig(),
    createUserMessage: (options) => ({ id: 'auto-1', ...options }),
    now: () => NOW,
    scanDirectory: () => undefined,
  })
  assert.equal(result.source, 'persistence')
  assert.equal(scanSettled(result), false, '空快照可能只是尚未就绪,必须重试')
})

test('目录与持久层都不可用时全量回退且不算收工', async () => {
  const h = createHarness({ records: [] })
  const result = await scanStoredSessions({
    ctx: h.ctx,
    config: resolveConfig(),
    createUserMessage: (options) => ({ id: 'auto-1', ...options }),
    now: () => NOW,
    scanDirectory: () => undefined,
  })
  assert.equal(result.source, 'query')
  assert.equal(scanSettled(result), false)
})

test('本轮预算未跑完时不收工', () => {
  assert.equal(scanSettled({ complete: false, source: 'directory', listed: 0 }), false)
})

test('持久层给出候选会话时收工', () => {
  assert.equal(scanSettled({ complete: true, source: 'persistence', listed: 3 }), true)
})

test('候选多于本轮恢复上限时不算扫完', async () => {
  const h = createHarness({ records: [record('s1', danglingTail), record('s2', danglingTail), record('s3', danglingTail)] })
  const items = ['s1', 's2', 's3'].map((id) => ({ id, path: `p/${id}`, mtimeMs: NOW }))
  const result = await scanStoredSessions({
    ctx: h.ctx,
    config: resolveConfig({ scanLimit: 1 }),
    createUserMessage: (options) => ({ id: 'auto-1', ...options }),
    now: () => NOW,
    scanDirectory: () => ({ items, partial: false }),
  })
  assert.equal(result.resumed, 1)
  assert.equal(result.complete, false, '还有候选未处理,不能宣称扫完')
  assert.equal(scanSettled(result), false, '未扫完就必须继续重试')
})

test('持久层读会话头失败时不算快照完整', async () => {
  const h = createHarness({ records: [] })
  const base = h.ctx.get.bind(h.ctx)
  h.ctx.get = (name) => (name === 'sessionPersistence' ? { async list() { return [] }, async stat() { throw new Error('service not ready') } } : base(name))
  const result = await scanStoredSessions({
    ctx: h.ctx,
    config: resolveConfig(),
    createUserMessage: (options) => ({ id: 'auto-1', ...options }),
    now: () => NOW,
    scanDirectory: () => ({ items: [{ id: 's1', path: 'p/s1', mtimeMs: NOW }], partial: false }),
  })
  assert.equal(result.source, 'partial', '服务读失败不能让候选静默消失')
  assert.equal(scanSettled(result), false)
})

test('拿不到会话头时不凭 id 伪装主会话恢复', async () => {
  const h = createHarness({ records: [record('s1', danglingTail, { origin: 'subagent' })] })
  const base = h.ctx.get.bind(h.ctx)
  h.ctx.get = (name) => (name === 'sessionPersistence' ? { async list() { return [] }, async stat() { return undefined } } : base(name))
  const result = await scanStoredSessions({
    ctx: h.ctx,
    config: resolveConfig(),
    createUserMessage: (options) => ({ id: 'auto-1', ...options }),
    now: () => NOW,
    scanDirectory: () => ({ items: [{ id: 's1', path: 'p/s1', mtimeMs: NOW }], partial: false }),
  })
  assert.equal(result.resumed, 0, '无法判定子会话身份时不得恢复')
  assert.equal(h.sent.length, 0)
  assert.equal(result.source, 'directory', '拿不到头部不等于读取失败,不该误报快照不完整')
})

test('会话根目录不存在时视为权威空快照', async () => {
  const { mkdtempSync: mkdtemp } = await import('node:fs')
  const { tmpdir: temp } = await import('node:os')
  const { join: joinPath } = await import('node:path')
  const { listFreshByDirectory } = await import('../src/scan.mjs')
  // 新装或被清空:home 下没有 sessions 目录
  const home = mkdtemp(joinPath(temp(), 'keep-working-nodir-'))
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = home
  try {
    const found = listFreshByDirectory(resolveConfig(), NOW)
    assert.deepEqual(found.items, [])
    assert.equal(found.partial, false, '目录不存在等于没有会话,不是读取失败')
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
  }
})

test('目录命中且能读到会话头时按头部信息恢复', async () => {
  const h = createHarness({ records: [record('s1', danglingTail)] })
  const base = h.ctx.get.bind(h.ctx)
  h.ctx.get = (name) => (name === 'sessionPersistence' ? {
    async list() { return [] },
    async stat(id) { return { header: { id, agentPreset: 'default' }, eventCount: danglingTail.length } },
  } : base(name))
  const result = await scanStoredSessions({
    ctx: h.ctx,
    config: resolveConfig(),
    createUserMessage: (options) => ({ id: 'auto-1', ...options }),
    now: () => NOW,
    scanDirectory: () => ({ items: [{ id: 's1', path: 'p/s1', mtimeMs: NOW }], partial: false }),
  })
  assert.equal(result.resumed, 1, '目录命中且头部可读时应恢复')
  assert.equal(result.source, 'directory')
  assert.deepEqual(h.resumed, ['s1'])
})

test('会话头没有 preset 时仍按主会话恢复', async () => {
  // 老会话的头部可能没有 agentPreset:这不影响是不是子会话的判定
  const h = createHarness({ records: [record('s1', danglingTail)] })
  const base = h.ctx.get.bind(h.ctx)
  h.ctx.get = (name) => (name === 'sessionPersistence' ? {
    async list() { return [] },
    async stat(id) { return { header: { id }, eventCount: danglingTail.length } },
  } : base(name))
  const result = await scanStoredSessions({
    ctx: h.ctx,
    config: resolveConfig(),
    createUserMessage: (options) => ({ id: 'auto-1', ...options }),
    now: () => NOW,
    scanDirectory: () => ({ items: [{ id: 's1', path: 'p/s1', mtimeMs: NOW }], partial: false }),
  })
  assert.equal(result.resumed, 1, '缺少 preset 不是跳过候选的理由')
})

test('部分会话头读取失败仍算快照不完整', async () => {
  const h = createHarness({ records: [record('s1', danglingTail), record('s2', danglingTail)] })
  const base = h.ctx.get.bind(h.ctx)
  h.ctx.get = (name) => (name === 'sessionPersistence' ? {
    async list() { return [] },
    async stat(id) {
      if (id === 's2') throw new Error('read failed')
      return { header: { id, agentPreset: 'default' }, eventCount: danglingTail.length }
    },
  } : base(name))
  const items = ['s1', 's2'].map((id) => ({ id, path: `p/${id}`, mtimeMs: NOW }))
  const result = await scanStoredSessions({
    ctx: h.ctx,
    config: resolveConfig(),
    createUserMessage: (options) => ({ id: 'auto-1', ...options }),
    now: () => NOW,
    scanDirectory: () => ({ items, partial: false }),
  })
  assert.equal(result.source, 'partial', '只要有一个读失败,快照就不完整')
  assert.equal(scanSettled(result), false)
})

test('会话根路径不是目录时交给持久层回退', async () => {
  const { mkdtempSync: mkdtemp, writeFileSync } = await import('node:fs')
  const { tmpdir: temp } = await import('node:os')
  const { join: joinPath } = await import('node:path')
  const { listFreshByDirectory } = await import('../src/scan.mjs')
  const home = mkdtemp(joinPath(temp(), 'keep-working-notdir-'))
  // sessions 是普通文件:ENOTDIR 不同于 ENOENT,不能当成"没有会话"
  writeFileSync(joinPath(home, 'sessions'), 'x')
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = home
  try {
    assert.equal(listFreshByDirectory(resolveConfig(), NOW), undefined, '非 ENOENT 应回退持久层')
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
  }
})

test('会话根目录不存在时整轮扫描直接收工', async () => {
  const { mkdtempSync: mkdtemp } = await import('node:fs')
  const { tmpdir: temp } = await import('node:os')
  const { join: joinPath } = await import('node:path')
  const home = mkdtemp(joinPath(temp(), 'keep-working-settle-'))
  const h = createHarness({ records: [] })
  const base = h.ctx.get.bind(h.ctx)
  h.ctx.get = (name) => (name === 'sessionPersistence' ? { async list() { return [] }, async stat() { return undefined } } : base(name))
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = home
  try {
    // 走真实的 listFreshByDirectory:根目录不存在必须让整轮直接收工,而不是回退持久层重试
    const result = await scanStoredSessions({
      ctx: h.ctx,
      config: resolveConfig(),
      createUserMessage: (options) => ({ id: 'auto-1', ...options }),
      now: () => NOW,
    })
    assert.equal(result.source, 'directory')
    assert.equal(scanSettled(result), true, '没有会话目录就是没有会话,不应继续重试')
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
  }
})

test('单个产物缺失不算快照不完整', async () => {
  const { mkdtempSync: mkdtemp, mkdirSync, writeFileSync } = await import('node:fs')
  const { tmpdir: temp } = await import('node:os')
  const { join: joinPath } = await import('node:path')
  const { listFreshByDirectory } = await import('../src/scan.mjs')
  const home = mkdtemp(joinPath(temp(), 'keep-working-partial-'))
  const dir = joinPath(home, 'sessions', 'ws', 'session-a')
  mkdirSync(dir, { recursive: true })
  // 只有非 zstd 形态的产物:可能是别的后端或旧代际,属常态
  writeFileSync(joinPath(dir, 'session.v4.jsonl'), 'x')
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = home
  try {
    const found = listFreshByDirectory(resolveConfig(), NOW)
    assert.equal(found.partial, false, '缺少 zstd 产物不代表目录不可读')
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
  }
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

test('没闭合即使已输出 TASK_DONE:仍恢复中断', async () => {
  const h = createHarness({ records: [record('s1', closedDanglingTail)] })
  const result = await scanStoredSessions({
    ctx: h.ctx,
    config: resolveConfig(),
    createUserMessage: (options) => ({ id: 'auto-1', ...options }),
    now: () => NOW,
    scanDirectory: () => undefined,
  })
  assert.equal(result.resumed, 1)
  assert.equal(h.sent.length, 1)
  assert.equal(h.sent[0].message.content[0].text, DEFAULTS.restartText, '重启恢复用独立文案')
})

test('未闭合即使已有 present:仍恢复中断', async () => {
  const events = [...danglingTail, presented(4, TURN)]
  const h = createHarness({ records: [record('s1', events)] })
  const result = await scanStoredSessions({
    ctx: h.ctx,
    config: resolveConfig(),
    createUserMessage: (options) => ({ id: 'auto-1', ...options }),
    now: () => NOW,
    scanDirectory: () => undefined,
  })
  assert.equal(result.resumed, 1)
  assert.equal(h.sent.length, 1)
  assert.equal(h.sent[0].message.content[0].text, DEFAULTS.restartText, '重启恢复用独立文案')
})

test('interrupted 即使已输出 TASK_DONE:仍恢复中断', async () => {
  const tail = [
    turnStart(1, TURN),
    userMessage(2),
    assistant(3, TURN, '结论\nTASK_DONE'),
    turnEnd(4, TURN, { kind: 'interrupted' }),
  ]
  const h = createHarness({ records: [record('s1', tail)] })
  const result = await scanStoredSessions({
    ctx: h.ctx,
    config: resolveConfig(),
    createUserMessage: (options) => ({ id: 'auto-1', ...options }),
    now: () => NOW,
    scanDirectory: () => undefined,
  })
  assert.equal(result.resumed, 1)
  assert.equal(h.sent.length, 1)
  assert.equal(h.sent[0].message.content[0].text, DEFAULTS.restartText, '重启恢复用独立文案')
})

test('宿主重启取消即使已输出 TASK_DONE:仍恢复中断', async () => {
  const tail = [
    turnStart(1, TURN),
    userMessage(2),
    assistant(3, TURN, '结论\nTASK_DONE'),
    turnEnd(4, TURN, { kind: 'aborted', reason: { kind: 'disposed' } }),
  ]
  const h = createHarness({ records: [record('s1', tail)] })
  const result = await scanStoredSessions({
    ctx: h.ctx,
    config: resolveConfig(),
    createUserMessage: (options) => ({ id: 'auto-1', ...options }),
    now: () => NOW,
    scanDirectory: () => undefined,
  })
  assert.equal(result.resumed, 1)
  assert.equal(h.sent.length, 1)
})

test('重启恢复文案可单独配置,且不吞掉截断 / 空回合的专项文案', async () => {
  const interrupted = [
    turnStart(1, TURN),
    userMessage(2),
    assistant(3, TURN, '话说到一半'),
    turnEnd(4, TURN, { kind: 'interrupted' }),
  ]
  const truncated = [
    turnStart(1, TURN),
    userMessage(2),
    assistant(3, TURN, '话说到一半'),
    turnEnd(4, TURN, { kind: 'max-tokens' }),
  ]
  const custom = resolveConfig({}, { restartText: '继续,dsh 刚重启' })

  const interruptedRun = createHarness({ records: [record('s1', interrupted)] })
  await scanStoredSessions({
    ctx: interruptedRun.ctx,
    config: custom,
    createUserMessage: (options) => ({ id: 'auto-1', ...options }),
    now: () => NOW,
    scanDirectory: () => undefined,
  })
  assert.equal(interruptedRun.sent[0].message.content[0].text, '继续,dsh 刚重启')

  const truncatedRun = createHarness({ records: [record('s1', truncated)] })
  await scanStoredSessions({
    ctx: truncatedRun.ctx,
    config: custom,
    createUserMessage: (options) => ({ id: 'auto-1', ...options }),
    now: () => NOW,
    scanDirectory: () => undefined,
  })
  assert.equal(truncatedRun.sent[0].message.content[0].text, DEFAULTS.continueTextMaxTokens)
})

test('冷启动错误回合:默认重试,开启区分永久错误后只跳过请求结构错误', async () => {
  const errorTail = (code, message) => [
    turnStart(1, TURN),
    userMessage(2),
    turnEnd(3, TURN, { kind: 'error', error: { code, message } }),
  ]
  const scan = async (tail, config) => {
    const h = createHarness({ records: [record('s1', tail)] })
    const result = await scanStoredSessions({
      ctx: h.ctx,
      config,
      createUserMessage: (options) => ({ id: 'auto-1', ...options }),
      now: () => NOW,
      scanDirectory: () => undefined,
    })
    return { result, h }
  }

  const defaults = await scan(errorTail('CONTEXT_WINDOW_EXCEEDED', 'the request failed'), resolveConfig())
  assert.equal(defaults.result.resumed, 1, '默认全部重试')
  assert.equal(defaults.h.sent.length, 1)

  const structured = await scan(
    errorTail('CONTEXT_WINDOW_EXCEEDED', 'the request failed'),
    resolveConfig({ classify: true }),
  )
  assert.equal(structured.result.resumed, 0, '请求结构错误在开启区分后不恢复')
  assert.equal(structured.h.sent.length, 0)

  const upstream = await scan(errorTail('AUTH', 'invalid api key'), resolveConfig({ classify: true }))
  assert.equal(upstream.result.resumed, 1, '鉴权属上游级错误,即使开启区分仍重试')
  assert.equal(upstream.h.sent.length, 1)
})

test('最近 10 条消息里有 present 的会话不恢复', async () => {
  const tail = [
    turnStart(1, TURN),
    userMessage(2),
    assistant(3, TURN, '完成'),
    presented(4, TURN),
    turnEnd(5, TURN, { kind: 'max-tokens' }),
  ]
  const h = createHarness({ records: [record('s1', tail)] })
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

test('present 超出最近 10 条消息的会话仍恢复', async () => {
  const tail = [
    turnStart(1, TURN),
    userMessage(2),
    presented(3, TURN),
    assistant(4, TURN, '进展 1'),
    assistant(5, TURN, '进展 2'),
    assistant(6, TURN, '进展 3'),
    assistant(7, TURN, '进展 4'),
    assistant(8, TURN, '进展 5'),
    assistant(9, TURN, '进展 6'),
    assistant(10, TURN, '进展 7'),
    assistant(11, TURN, '进展 8'),
    assistant(12, TURN, '进展 9'),
    assistant(13, TURN, '进展 10'),
    turnEnd(14, TURN, { kind: 'max-tokens' }),
  ]
  const h = createHarness({ records: [record('s1', tail)] })
  const result = await scanStoredSessions({
    ctx: h.ctx,
    config: resolveConfig(),
    createUserMessage: (options) => ({ id: 'auto-1', ...options }),
    now: () => NOW,
    scanDirectory: () => undefined,
  })
  assert.equal(result.resumed, 1)
  assert.equal(h.sent.length, 1)
})

test('上一回合的 done 不当作新回合的结案', async () => {
  const events = [
    turnStart(1, 1),
    userMessage(2),
    assistant(3, 1, '结论\nTASK_DONE'),
    turnEnd(4, 1, { kind: 'completed' }),
    turnStart(5, 2),
    userMessage(6),
  ]
  const h = createHarness({ records: [record('s1', events)] })
  const result = await scanStoredSessions({
    ctx: h.ctx,
    config: resolveConfig(),
    createUserMessage: (options) => ({ id: 'auto-1', ...options }),
    now: () => NOW,
    scanDirectory: () => undefined,
  })
  assert.equal(result.resumed, 1)
  assert.equal(h.sent.length, 1)
})

test('写入且无可见回答的正常结束会话仍要 present', async () => {
  const tail = [
    turnStart(1, TURN),
    userMessage(2),
    event(3, 'tool/call', {
      turn: TURN,
      step: 1,
      callId: 'c-3',
      name: 'write',
      arguments: JSON.stringify({ file_path: 'C:/tmp/restart-watchdog.ps1' }),
    }),
    turnEnd(4, TURN, { kind: 'completed' }),
  ]
  const h = createHarness({ records: [record('s1', tail)] })
  const result = await scanStoredSessions({
    ctx: h.ctx,
    config: resolveConfig(),
    createUserMessage: (options) => ({ id: 'auto-1', ...options }),
    now: () => NOW,
    scanDirectory: () => undefined,
  })
  assert.equal(result.resumed, 1)
  assert.equal(h.sent.length, 1)
  assert.match(h.sent[0].message.content[0].text, /present|TASK_DONE/)
})

test('写入但有可见回答的会话重启不恢复', async () => {
  const tail = [
    turnStart(1, TURN),
    userMessage(2),
    event(3, 'tool/call', {
      turn: TURN,
      step: 1,
      callId: 'c-3',
      name: 'write',
      arguments: JSON.stringify({ file_path: 'C:/tmp/restart-watchdog.ps1' }),
    }),
    assistant(4, TURN, '结论'),
    turnEnd(5, TURN, { kind: 'completed' }),
  ]
  const h = createHarness({ records: [record('s1', tail)] })
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

test('有可见回答的正常结束会话不恢复', async () => {
  const h = createHarness({ records: [record('s1', openTail)] })
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

test('正常结束但仍有排队消息的会话被恢复,恢复消息插队发送', async () => {
  for (const tail of [openTail, closedTail]) {
    const events = [...tail, inboxSpliced(5, 'next-turn', [queuedMessage(5)])]
    const h = createHarness({ records: [record('s1', events)] })
    const result = await scanStoredSessions({
      ctx: h.ctx,
      config: resolveConfig(),
      createUserMessage: (options) => ({ id: 'auto-1', ...options }),
      now: () => NOW,
      scanDirectory: () => undefined,
    })
    assert.equal(result.resumed, 1)
    assert.equal(h.sent.length, 1)
    assert.equal(h.sent[0].via, 'steer', '排队消息存在时必须插队,不能追加到 next-turn 队尾')
    assert.equal(h.sent[0].message.content[0].text, '继续')
  }
})

test('pendingInbox 删除事件不刷新最后入队时间', () => {
  const queued = queuedMessage(1)
  const events = [
    { seq: 1, time: 1_000, type: 'agent/inbox/spliced', data: { target: 'next-turn', start: 0, removedCount: 0, inserted: [queued] } },
    { seq: 2, time: 2_000, type: 'agent/inbox/spliced', data: { target: 'next-turn', start: 0, removedCount: 1, inserted: [] } },
  ]
  const inbox = pendingInbox(events)
  assert.equal(inbox.count, 0)
  assert.equal(inbox.lastAt, 1_000, '删除事件不能刷新 lastAt')
})

test('未闭合回合带排队消息时同样插队恢复', async () => {
  const events = [...danglingTail, inboxSpliced(4, 'next-turn', [queuedMessage(4)])]
  const h = createHarness({ records: [record('s1', events)] })
  const result = await scanStoredSessions({
    ctx: h.ctx,
    config: resolveConfig(),
    createUserMessage: (options) => ({ id: 'auto-1', ...options }),
    now: () => NOW,
    scanDirectory: () => undefined,
  })
  assert.equal(result.resumed, 1)
  assert.equal(h.sent[0].via, 'steer')
})

test('next-step 的运行时上下文不算排队消息,真人插话才算', async () => {
  const context = [{ id: 'c-1', role: 'user', content: [], source: { kind: 'runtime-context' } }]
  const withContext = createHarness({
    records: [record('s1', [...openTail, inboxSpliced(5, 'next-step', context)])],
  })
  const contextResult = await scanStoredSessions({
    ctx: withContext.ctx,
    config: resolveConfig(),
    createUserMessage: (options) => ({ id: 'auto-1', ...options }),
    now: () => NOW,
    scanDirectory: () => undefined,
  })
  assert.equal(contextResult.resumed, 0)

  const withSteering = createHarness({
    records: [record('s1', [...openTail, inboxSpliced(5, 'next-step', [queuedMessage(5)])])],
  })
  const steeringResult = await scanStoredSessions({
    ctx: withSteering.ctx,
    config: resolveConfig(),
    createUserMessage: (options) => ({ id: 'auto-1', ...options }),
    now: () => NOW,
    scanDirectory: () => undefined,
  })
  assert.equal(steeringResult.resumed, 1)
  assert.equal(withSteering.sent[0].via, 'steer')
})

test('用户主动取消的回合即使有排队消息也不恢复', async () => {
  const events = [
    ...openTail.slice(0, 3),
    turnEnd(4, TURN, { kind: 'aborted', reason: { kind: 'user' } }),
    inboxSpliced(5, 'next-turn', [queuedMessage(5)]),
  ]
  const h = createHarness({ records: [record('s1', events)] })
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

test('排队消息本身超出新鲜窗口时不恢复', async () => {
  const stale = [...openTail, inboxSpliced(5, 'next-turn', [queuedMessage(5)])].map((item) => ({
    ...item,
    time: NOW - 60 * 60_000,
  }))
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

const blockedTail = [
  turnStart(1, TURN),
  userMessage(2),
  assistant(3, TURN, '做到一半'),
  turnEnd(4, TURN, { kind: 'blocked' }),
]

test('宿主预检拒绝(blocked)按中断恢复', async () => {
  const h = createHarness({ records: [record('s1', blockedTail)] })
  const result = await scanStoredSessions({
    ctx: h.ctx,
    config: resolveConfig(),
    createUserMessage: (options) => ({ id: 'auto-1', ...options }),
    now: () => NOW,
    scanDirectory: () => undefined,
  })
  assert.deepEqual(h.resumed, ['s1'])
  assert.equal(result.resumed, 1)
  assert.match(h.sent[0].message.content[0].text, /dsh已重启/)
})

test('blocked 但末行已结案:不恢复', async () => {
  const tail = [
    turnStart(1, TURN),
    userMessage(2),
    assistant(3, TURN, '结论\nTASK_DONE'),
    turnEnd(4, TURN, { kind: 'blocked' }),
  ]
  const h = createHarness({ records: [record('s1', tail)] })
  await scanStoredSessions({
    ctx: h.ctx,
    config: resolveConfig(),
    createUserMessage: (options) => ({ id: 'auto-1', ...options }),
    now: () => NOW,
    scanDirectory: () => undefined,
  })
  assert.deepEqual(h.resumed, [])
  assert.equal(h.sent.length, 0)
})

test('预检拒绝落下的 blocked 目标重新武装,不再补消息', async () => {
  const resumedGoals = []
  const goals = {
    get: () => ({
      id: 'g1',
      revision: 2,
      phase: 'blocked',
      activation: 'disarmed',
      blockedReason: { code: 'prompt-rejected', message: 'Goal round was rejected before entering its step.' },
    }),
    resume: (agent, ref) => resumedGoals.push({ agent: agent.id, ref }),
  }
  const h = createHarness({ records: [record('s1', blockedTail)], goals })
  await scanStoredSessions({
    ctx: h.ctx,
    config: resolveConfig({ resumeGoals: true }),
    createUserMessage: (options) => ({ id: 'auto-1', ...options }),
    now: () => NOW,
    scanDirectory: () => undefined,
  })
  assert.deepEqual(resumedGoals, [{ agent: 's1', ref: { id: 'g1', revision: 2 } }])
  assert.equal(h.sent.length, 0, '交回 driver 后不得再补消息')
})

test('非预检拒绝的 blocked 目标不接管', async () => {
  const resumedGoals = []
  const goals = {
    get: () => ({ id: 'g1', revision: 2, phase: 'blocked', blockedReason: { code: 'needs-input', message: '缺凭据' } }),
    resume: (agent, ref) => resumedGoals.push({ agent: agent.id, ref }),
  }
  const h = createHarness({ records: [record('s1', blockedTail)], goals })
  await scanStoredSessions({
    ctx: h.ctx,
    config: resolveConfig({ resumeGoals: true }),
    createUserMessage: (options) => ({ id: 'auto-1', ...options }),
    now: () => NOW,
    scanDirectory: () => undefined,
  })
  assert.deepEqual(resumedGoals, [])
  assert.equal(h.sent.length, 1, '模型自述受阻不是预检拒绝,按普通中断续跑')
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

test('归档集合字段缺失时按未知处理,不当作空集', async () => {
  const h = createHarness({ records: [record('s1', danglingTail)] })
  const base = h.ctx.get.bind(h.ctx)
  h.ctx.get = (name) => (name === 'workspaceRegistry' ? {} : base(name))
  const result = await scanStoredSessions({
    ctx: h.ctx,
    config: resolveConfig(),
    createUserMessage: (options) => ({ id: 'auto-1', ...options }),
    now: () => NOW,
    scanDirectory: () => undefined,
  })
  assert.equal(result.resumed, 0, '未就绪的集合不是空集,不能恢复')
  assert.equal(result.complete, false)
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
    assert.equal(found.partial, false, '全部子项可读时快照完整')
    assert.deepEqual(found.items.map((item) => item.id), ['session-fresh'])
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
  }
})

test('会话查询服务缺失是终态,本轮直接收工', async () => {
  const result = await scanStoredSessions({
    ctx: { get: () => undefined, agents: { get: () => undefined } },
    config: resolveConfig(),
    createUserMessage: () => ({ id: 'auto-1' }),
    scanDirectory: () => undefined,
  })
  assert.equal(result.settled, true)
  assert.equal(scanSettled(result), true, '缺服务不能按秒重试到新鲜窗口耗尽')
})

test('扫描关闭与全局暂停同样是终态', async () => {
  for (const overrides of [{ scanOnBoot: false }, { paused: true }]) {
    const result = await scanStoredSessions({
      ctx: { get: () => undefined, agents: { get: () => undefined } },
      config: resolveConfig(overrides),
      createUserMessage: () => ({ id: 'auto-1' }),
      scanDirectory: () => undefined,
    })
    assert.equal(scanSettled(result), true)
  }
})

test('空回合恢复开关关闭时重启扫描不补发', async () => {
  const silentTail = [
    turnStart(1, TURN),
    userMessage(2),
    turnEnd(4, TURN, { kind: 'completed' }),
  ]
  for (const [resumeSilentTurns, expected] of [
    [false, 0],
    [true, 1],
  ]) {
    const h = createHarness({ records: [record('s-silent', silentTail)] })
    const result = await scanStoredSessions({
      ctx: h.ctx,
      config: resolveConfig({ resumeSilentTurns }),
      createUserMessage: (options) => ({ id: 'auto-1', ...options }),
      now: () => NOW,
      scanDirectory: () => undefined,
    })
    assert.equal(result.resumed, expected, `resumeSilentTurns=${resumeSilentTurns}`)
    assert.equal(h.sent.length, expected)
  }
})

test('关闭结案强制后重启扫描不再补 present 提醒', async () => {
  const writeSilentTail = [
    turnStart(1, TURN),
    userMessage(2),
    event(3, 'tool/call', { turn: TURN, step: 1, callId: 'c-1', name: 'write', arguments: '{}' }),
    turnEnd(4, TURN, { kind: 'completed' }),
  ]
  for (const [label, overrides, expected] of [
    ['默认', {}, 1],
    ['关闭强制且关闭空回合', { enforceClosure: false, resumeSilentTurns: false }, 0],
    ['关闭强制但开空回合', { enforceClosure: false }, 1],
  ]) {
    const h = createHarness({ records: [record('s-write-silent', writeSilentTail)] })
    const result = await scanStoredSessions({
      ctx: h.ctx,
      config: resolveConfig(overrides),
      createUserMessage: (options) => ({ id: 'auto-1', ...options }),
      now: () => NOW,
      scanDirectory: () => undefined,
    })
    assert.equal(result.resumed, expected, label)
    assert.equal(h.sent.length, expected, label)
    if (label === '关闭强制但开空回合') {
      assert.equal(textOf(h.sent[0]), DEFAULTS.continueTextSilent, '不得再发结案提醒文案')
    }
  }
})

test('第零代与多代际产物都能被目录扫描识别', async () => {
  const home = mkdtempSync(join(tmpdir(), 'keep-working-gen-'))
  const workspace = join(home, 'sessions', 'ws')
  const nowSeconds = NOW / 1000
  const make = (sessionId, fileName) => {
    const dir = join(workspace, sessionId)
    mkdirSync(dir, { recursive: true })
    const file = join(dir, fileName)
    writeFileSync(file, 'x')
    utimesSync(file, nowSeconds, nowSeconds)
  }
  make('session-zero', 'session.jsonl.zstd')
  make('session-v3', 'session.v3.jsonl.zstd')
  make('session-v5', 'session.v5.jsonl.zstd')

  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = home
  try {
    const found = listFreshByDirectory(resolveConfig(), NOW)
    assert.equal(found.partial, false)
    assert.deepEqual(found.items.map((item) => item.id).sort(), ['session-v3', 'session-v5', 'session-zero'])
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
  }
})

test('目录冷启动识别 import-* 与裸 UUID 主会话', async () => {
  const home = mkdtempSync(join(tmpdir(), 'keep-working-import-'))
  const ids = ['import-20261114-abc', '550e8400-e29b-41d4-a716-446655440000']
  const nowSeconds = NOW / 1000
  for (const id of ids) {
    const dir = join(home, 'sessions', 'ws', id)
    mkdirSync(dir, { recursive: true })
    const file = join(dir, 'session.v4.jsonl.zstd')
    writeFileSync(file, 'x')
    utimesSync(file, nowSeconds, nowSeconds)
  }
  const h = createHarness({ records: ids.map((id) => record(id, danglingTail)) })
  const base = h.ctx.get.bind(h.ctx)
  h.ctx.get = (name) => (name === 'sessionPersistence'
    ? { stat: async (id) => ({ header: { id }, eventCount: 1 }) }
    : base(name))
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = home
  try {
    const result = await scanStoredSessions({
      ctx: h.ctx,
      config: resolveConfig(),
      createUserMessage: (options) => ({ id: 'auto-1', ...options }),
      now: () => NOW,
    })
    assert.equal(result.source, 'directory')
    assert.deepEqual(h.resumed.sort(), [...ids].sort())
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
  }
})

test('非会话产物不参与代际筛选,不遮蔽真实产物', () => {
  const home = mkdtempSync(join(tmpdir(), 'keep-working-artifact-'))
  const nowSeconds = NOW / 1000
  const make = (sessionId, fileName) => {
    const dir = join(home, 'sessions', 'ws', sessionId)
    mkdirSync(dir, { recursive: true })
    const file = join(dir, fileName)
    writeFileSync(file, 'x')
    utimesSync(file, nowSeconds, nowSeconds)
  }
  // 只有迁移中间产物的目录不构成候选
  make('session-temp-only', 'session.jsonl.tmp-1')
  make('session-real', 'session.jsonl.zstd')
  make('session-real', 'session.jsonl.tmp-1')

  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = home
  try {
    const found = listFreshByDirectory(resolveConfig(), NOW)
    assert.deepEqual(found.items.map((item) => item.id), ['session-real'])
    assert.match(found.items[0].path, /session\.jsonl\.zstd$/)
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
  }
})

test('待接管项先复核归档集合:已归档会话不得被补投', async () => {
  const h = createHarness({ records: [], archived: ['s1'] })
  const agent = {
    id: 's1',
    session: { id: 's1' },
    inbox: { nextTurn: [] },
    followup: () => { throw new Error('已归档会话不得 followup') },
    steer: () => { throw new Error('已归档会话不得 steer') },
  }
  h.agentsById.set('s1', agent)
  const pendingTakeovers = new Map([
    ['s1', { sessionId: 's1', agent, inbox: { count: 0 }, verdict: 'resume:interrupted' }],
  ])
  const result = await scanStoredSessions({
    ctx: h.ctx,
    config: resolveConfig(),
    createUserMessage: (options) => ({ id: 'auto-1', ...options }),
    now: () => NOW,
    scanDirectory: () => undefined,
    pendingTakeovers,
  })
  assert.equal(result.resumed, 0)
  assert.equal(pendingTakeovers.has('s1'), false, '已归档待接管项必须丢弃')
  assert.equal(h.sent.length, 0)
})

test('待接管项按新代结案开关重判:不补结案提醒,空回合照常恢复', async () => {
  for (const [resumeSilentTurns, expected] of [
    [true, 1],
    [false, 0],
  ]) {
    const h = createHarness({ records: [] })
    const sent = []
    const agent = {
      id: 's1',
      session: { id: 's1' },
      inbox: { nextTurn: [] },
      followup: (message) => sent.push(message),
    }
    h.agentsById.set('s1', agent)
    const pendingTakeovers = new Map([
      ['s1', { sessionId: 's1', agent, inbox: { count: 0 }, verdict: 'resume:closure' }],
    ])
    const result = await scanStoredSessions({
      ctx: h.ctx,
      config: resolveConfig({ enforceClosure: false, resumeSilentTurns }),
      createUserMessage: (options) => ({ id: 'auto-1', ...options }),
      now: () => NOW,
      scanDirectory: () => undefined,
      pendingTakeovers,
    })
    assert.equal(result.resumed, expected, `resumeSilentTurns=${resumeSilentTurns}`)
    assert.equal(sent.length, expected)
    assert.equal(pendingTakeovers.has('s1'), false)
    if (expected === 1) {
      assert.equal(sent[0].content.map((block) => block.text).join(''), DEFAULTS.continueTextSilent, '不得再发结案提醒文案')
    }
  }
})

test('归档集合在观察期间变化时,物化前复核并跳过', async () => {
  const archived = []
  const h = createHarness({
    records: [record('s1', danglingTail)],
    archived,
    onObserve: (id) => archived.push(id),
  })
  const result = await scanStoredSessions({
    ctx: h.ctx,
    config: resolveConfig(),
    createUserMessage: (options) => ({ id: 'auto-1', ...options }),
    now: () => NOW,
    scanDirectory: () => undefined,
  })
  assert.equal(result.resumed, 0)
  assert.deepEqual(h.resumed, [], '观察后已归档的会话不得物化恢复')
  assert.equal(h.sent.length, 0)
})

test('物化前归档集合复核失败时跳过且下一轮可重试', async () => {
  let reads = 0
  const h = createHarness({
    records: [record('s1', danglingTail)],
    archivedRead: () => {
      reads += 1
      if (reads === 2) throw new Error('workspace registry is not started yet')
      return []
    },
  })
  const seen = new Set()
  const result = await scanStoredSessions({
    ctx: h.ctx,
    config: resolveConfig(),
    createUserMessage: (options) => ({ id: 'auto-1', ...options }),
    now: () => NOW,
    scanDirectory: () => undefined,
    seen,
  })
  assert.equal(result.resumed, 0)
  assert.equal(result.complete, false, '复核失败不能宣称本轮扫完')
  assert.equal(seen.has('s1'), false, '未裁决的会话不能被跨轮去重吞掉')

  const retry = await scanStoredSessions({
    ctx: h.ctx,
    config: resolveConfig(),
    createUserMessage: (options) => ({ id: 'auto-1', ...options }),
    now: () => NOW,
    scanDirectory: () => undefined,
    seen,
  })
  assert.equal(retry.resumed, 1, '权威集合恢复后应能重试成功')
})

test('扫描重试间隔从 1s 指数退避到 60s', () => {
  let delay = SCAN_RETRY_MIN_MS
  const delays = []
  for (let index = 0; index < 8; index += 1) {
    delays.push(delay)
    delay = nextScanRetryMs(delay)
  }
  assert.deepEqual(delays.slice(0, 7), [1_000, 2_000, 4_000, 8_000, 16_000, 32_000, 60_000])
  assert.equal(delay, SCAN_RETRY_MAX_MS, '退避封顶后保持 60s')
})

test('重复扫描日志按最小间隔降频', () => {
  const allow = createTraceThrottle(60_000)
  assert.equal(allow('扫描开始', 1_000), true)
  assert.equal(allow('扫描开始', 30_000), false, '间隔内重复内容不写')
  assert.equal(allow('已归档 2 个', 30_001), true, '不同内容不受影响')
  assert.equal(allow('扫描开始', 61_000), true, '超过间隔后恢复一次')
})

test('单会话读取失败:本轮标未完成且下一轮重试成功', async () => {
  const h = createHarness({
    records: [record('s1', danglingTail), record('s2', danglingTail)],
    observeFailures: { s1: 1 },
  })
  const seen = new Set()
  const first = await scanStoredSessions({
    ctx: h.ctx,
    config: resolveConfig(),
    createUserMessage: (options) => ({ id: 'auto-1', ...options }),
    now: () => NOW,
    scanDirectory: () => undefined,
    seen,
  })
  assert.equal(first.resumed, 1, '另一个会话照常恢复')
  assert.equal(first.complete, false, '单会话失败不得宣称本轮扫完')
  assert.equal(seen.has('s1'), false, '失败会话必须回到待重试集合')

  const retry = await scanStoredSessions({
    ctx: h.ctx,
    config: resolveConfig(),
    createUserMessage: (options) => ({ id: 'auto-1', ...options }),
    now: () => NOW,
    scanDirectory: () => undefined,
    seen,
  })
  assert.equal(retry.resumed, 1, '下一轮重试成功')
  assert.deepEqual(h.resumed, ['s2', 's1'])
})

test('扫描 observeSession 传 projectionMode:none 与 AbortSignal,投影失败下一轮重试', async () => {
  const controller = new AbortController()
  let observedOptions
  const h = createHarness({
    records: [record('s1', danglingTail)],
    observeFailures: { s1: 1 },
    onObserve: (_id, options) => { observedOptions = options },
  })
  const seen = new Set()
  const first = await scanStoredSessions({
    ctx: h.ctx,
    config: resolveConfig(),
    createUserMessage: (options) => ({ id: 'auto-1', ...options }),
    now: () => NOW,
    scanDirectory: () => undefined,
    signal: controller.signal,
    seen,
  })
  assert.deepEqual(observedOptions, { projectionMode: 'none', signal: controller.signal })
  assert.equal(first.resumed, 0)
  assert.equal(first.complete, false, '投影失败不能宣称本轮扫完')
  assert.equal(seen.has('s1'), false, '投影失败会话必须下一轮重试')

  const retry = await scanStoredSessions({
    ctx: h.ctx,
    config: resolveConfig(),
    createUserMessage: (options) => ({ id: 'auto-1', ...options }),
    now: () => NOW,
    scanDirectory: () => undefined,
    signal: controller.signal,
    seen,
  })
  assert.equal(retry.resumed, 1)
})

test('物化未得到 live agent 视为失败:本轮不完成且下一轮重试', async () => {
  const h = createHarness({ records: [record('s1', danglingTail)], resumeNoAgent: 1 })
  const seen = new Set()
  const first = await scanStoredSessions({
    ctx: h.ctx,
    config: resolveConfig(),
    createUserMessage: (options) => ({ id: 'auto-1', ...options }),
    now: () => NOW,
    scanDirectory: () => undefined,
    seen,
  })
  assert.equal(first.resumed, 0)
  assert.equal(first.complete, false)
  assert.equal(seen.has('s1'), false)
  assert.deepEqual(h.resumed, ['s1'], 'resume 已调用但未得到 agent,仍算失败')

  const retry = await scanStoredSessions({
    ctx: h.ctx,
    config: resolveConfig(),
    createUserMessage: (options) => ({ id: 'auto-1', ...options }),
    now: () => NOW,
    scanDirectory: () => undefined,
    seen,
  })
  assert.equal(retry.resumed, 1)
  assert.equal(h.sent.length, 1)
})

test('冷启动会话已被客户端打开(空闲 live agent):补恢复消息且不重复物化', async () => {
  // 崩溃后浏览器重连会打开上次的会话并物化 agent;打开不等于接管,中断的回合仍要续跑
  const h = createHarness({ records: [record('s1', danglingTail)] })
  const sent = []
  h.agentsById.set('s1', {
    id: 's1',
    session: { id: 's1' },
    status: 'idle',
    inbox: { nextTurn: [] },
    followup: (message) => sent.push({ via: 'followup', message }),
    steer: (message) => sent.push({ via: 'steer', message }),
  })
  const result = await scanStoredSessions({
    ctx: h.ctx,
    config: resolveConfig(),
    createUserMessage: (options) => ({ id: 'auto-1', ...options }),
    now: () => NOW,
    scanDirectory: () => undefined,
  })
  assert.equal(result.resumed, 1)
  assert.deepEqual(h.resumed, [], '已 live 的会话不得再 resume')
  assert.equal(sent.length, 1, '空闲 live agent 必须收到恢复消息')
  assert.equal(sent[0].via, 'followup')
})

test('候选会话正在跑回合:不判定也不补消息', async () => {
  let observed = 0
  const h = createHarness({ records: [record('s1', danglingTail)], onObserve: () => { observed += 1 } })
  h.agentsById.set('s1', {
    id: 's1',
    session: { id: 's1' },
    status: 'running',
    inbox: { nextTurn: [] },
    followup: () => { throw new Error('must not followup a running session') },
    steer: () => { throw new Error('must not steer a running session') },
  })
  const result = await scanStoredSessions({
    ctx: h.ctx,
    config: resolveConfig(),
    createUserMessage: (options) => ({ id: 'auto-1', ...options }),
    now: () => NOW,
    scanDirectory: () => undefined,
  })
  assert.equal(result.resumed, 0)
  assert.equal(observed, 0, '正在跑回合的会话不进入判定')
})

test('判定期间客户端打开会话:空闲则复用 live agent 补消息', async () => {
  let h
  const sent = []
  h = createHarness({
    records: [record('s1', danglingTail)],
    onObserve: () => {
      h.agentsById.set('s1', {
        id: 's1',
        session: { id: 's1' },
        status: 'idle',
        inbox: { nextTurn: [] },
        followup: (message) => sent.push({ via: 'followup', message }),
        steer: (message) => sent.push({ via: 'steer', message }),
      })
    },
  })
  const result = await scanStoredSessions({
    ctx: h.ctx,
    config: resolveConfig(),
    createUserMessage: (options) => ({ id: 'auto-1', ...options }),
    now: () => NOW,
    scanDirectory: () => undefined,
  })
  assert.equal(result.resumed, 1)
  assert.deepEqual(h.resumed, [])
  assert.equal(sent.length, 1)
})

test('判定期间会话进入运行:不得补消息', async () => {
  let h
  h = createHarness({
    records: [record('s1', danglingTail)],
    onObserve: () => {
      h.agentsById.set('s1', {
        id: 's1',
        session: { id: 's1' },
        status: 'running',
        inbox: { nextTurn: [] },
        followup: () => { throw new Error('must not followup a running session') },
        steer: () => { throw new Error('must not steer a running session') },
      })
    },
  })
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

test('scan 在途失效:isActive 变为 false 后不再物化恢复', async () => {
  let active = true
  const h = createHarness({
    records: [record('s1', danglingTail)],
    onObserve: () => { active = false },
  })
  const result = await scanStoredSessions({
    ctx: h.ctx,
    config: resolveConfig(),
    createUserMessage: (options) => ({ id: 'auto-1', ...options }),
    now: () => NOW,
    scanDirectory: () => undefined,
    isActive: () => active,
  })
  assert.equal(result.cancelled, true)
  assert.deepEqual(h.resumed, [])
})

test('scan 在途失效:AbortSignal 触发后停止后续会话', async () => {
  const abort = new AbortController()
  const h = createHarness({
    records: [record('s1', danglingTail), record('s2', danglingTail)],
    onObserve: () => abort.abort(),
  })
  const result = await scanStoredSessions({
    ctx: h.ctx,
    config: resolveConfig(),
    createUserMessage: (options) => ({ id: 'auto-1', ...options }),
    now: () => NOW,
    scanDirectory: () => undefined,
    signal: abort.signal,
  })
  assert.equal(result.cancelled, true)
  assert.deepEqual(h.resumed, [])
})

test('投递 followup 短暂失败:live agent 保留待重排并下一轮重试', async () => {
  const h = createHarness({
    records: [record('s1', danglingTail)],
    sendFailures: { s1: 1 },
  })
  const pendingTakeovers = new Map()
  const seen = new Set()
  const first = await scanStoredSessions({
    ctx: h.ctx,
    config: resolveConfig(),
    createUserMessage: (options) => ({ id: 'auto-1', ...options }),
    now: () => NOW,
    scanDirectory: () => undefined,
    pendingTakeovers,
    seen,
  })
  assert.equal(first.resumed, 0)
  assert.equal(first.complete, false, '本次投递失败不能宣称扫完')
  assert.equal(pendingTakeovers.has('s1'), true, '失败投递必须保留待重排')
  assert.equal(h.sent.length, 0)

  const retry = await scanStoredSessions({
    ctx: h.ctx,
    config: resolveConfig(),
    createUserMessage: (options) => ({ id: 'auto-1', ...options }),
    now: () => NOW,
    scanDirectory: () => undefined,
    pendingTakeovers,
    seen,
  })
  assert.equal(retry.resumed, 1)
  assert.equal(h.sent.length, 1, '下一轮必须重试同一条恢复消息')
  assert.equal(pendingTakeovers.has('s1'), false)
})
