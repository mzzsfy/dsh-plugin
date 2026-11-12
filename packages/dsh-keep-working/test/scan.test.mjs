import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// 扫描日志必须落在临时目录,否则测试会写进真实 home
process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'keep-working-test-'))

import { resolveConfig } from '../src/config.mjs'
import { listFreshByDirectory, scanSettled, scanStoredSessions } from '../src/scan.mjs'

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
