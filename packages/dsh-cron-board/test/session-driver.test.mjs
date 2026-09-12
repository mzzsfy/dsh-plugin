// session-driver 测试:HostApiDriver 会话编排语义(设计 §4.3、§7 BDD 会话组)。
// 桩替 sessionController/agents/sessionQuery/workspaceRegistry,验证 fresh/pinned/忙跳过/未绑定与丢失自愈/投递即终态/分组挂载。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createSessionDriver } from '../src/session-driver.mjs'

// 可控桩:会话注册表 + 控制器(autoIdle 模拟宿主投递后处理完成转 idle;投递即终态下仅影响忙判定)
function makeStubs({ autoIdle = true } = {}) {
  const sessions = new Map()
  let nextId = 0
  const created = []
  const createRequests = []
  const prompts = []
  const sessionController = {
    async create(request) {
      const sessionId = 'sess-' + (++nextId)
      const cwd = request && request.cwd
      sessions.set(sessionId, { id: sessionId, cwd, status: 'running' })
      created.push({ sessionId, cwd })
      createRequests.push(request)
      return { sessionId }
    },
    // 镜像宿主 facade 契约(dsh-api-session-controller):prompt 准入首行非可选链校验 signal
    async prompt(args, signal) {
      signal.throwIfAborted()
      prompts.push(args)
      if (autoIdle) {
        queueMicrotask(() => {
          const entry = sessions.get(args.sessionId)
          if (entry) entry.status = 'idle'
        })
      }
      return { accepted: true }
    },
  }
  const agents = {
    get: (id) => sessions.get(id),
  }
  const sessionQuery = {
    // 镜像宿主最严准入契约:守护 driver 总是传信号(真实宿主各版本为可选链,将来收紧不崩)
    async listSessions(signal) {
      signal.throwIfAborted()
      return [...sessions.values()].map((entry) => ({ id: entry.id }))
    },
  }
  return { sessions, created, createRequests, prompts, sessionController, agents, sessionQuery }
}

// workspaceRegistry 桩:resolveByPath 按规范化 path 命中,createCanonical 建新组
function makeRegistry({ paths = {}, archived = [] } = {}) {
  const workspaces = new Map(Object.entries(paths))
  let nextId = 0
  return {
    archivedSessionIds: archived,
    async resolveByPath(path) {
      const id = workspaces.get(path)
      return id ? { id, path } : undefined
    },
    async createCanonical(canonical) {
      const id = 'w-' + (++nextId)
      workspaces.set(canonical, id)
      return { id, path: canonical }
    },
  }
}

function makeDriver(stubs) {
  return createSessionDriver({
    getSessionController: () => stubs.sessionController,
    getWorkspaceRegistry: stubs.getWorkspaceRegistry,
    agents: stubs.agents,
    sessionQuery: stubs.sessionQuery,
  })
}

const BASE_JOB = { id: 'j1', kind: 'session', prompt: '跑日报', session: { mode: 'fresh' } }
const PINNED_S1 = { ...BASE_JOB, session: { mode: 'pinned', pinnedSessionId: 's-1' } }
const PINNED_GONE = { ...BASE_JOB, session: { mode: 'pinned', pinnedSessionId: 'gone' } }

test('session-driver:fresh 每次新建,两次触发不同 sessionId', async () => {
  const stubs = makeStubs()
  const driver = makeDriver(stubs)
  // When 同一 fresh 任务发起两次
  const first = await driver.run({ job: BASE_JOB, env: {} })
  const second = await driver.run({ job: BASE_JOB, env: {} })
  // Then 两个不同会话,均被投递
  assert.notEqual(first.sessionId, second.sessionId)
  assert.equal(stubs.created.length, 2)
  assert.equal(stubs.prompts.length, 2)
  assert.equal(first.status, 'success')
})

test('session-driver:pinned 复用同一会话,投递指向 S1', async () => {
  const stubs = makeStubs()
  stubs.sessions.set('s-1', { id: 's-1', status: 'idle' })
  const driver = makeDriver(stubs)
  // When pinned 任务触发
  const outcome = await driver.run({ job: PINNED_S1, env: {} })
  // Then 向 S1 投递且 outcome.sessionId=S1
  assert.equal(outcome.status, 'success')
  assert.equal(outcome.sessionId, 's-1')
  assert.equal(stubs.prompts[0].sessionId, 's-1')
  assert.equal(stubs.prompts[0].mode, 'queue')
  assert.equal(stubs.created.length, 0)
})

test('session-driver:pinned 忙时跳过,不投递', async () => {
  const stubs = makeStubs()
  stubs.sessions.set('s-1', { id: 's-1', status: 'running' })
  const driver = makeDriver(stubs)
  // When pinned 会话正在运行
  const outcome = await driver.run({ job: PINNED_S1, env: {} })
  // Then skipped(上一轮仍在进行)且未新建未投递
  assert.equal(outcome.status, 'skipped')
  assert.equal(outcome.message, '上一轮仍在进行')
  assert.equal(stubs.prompts.length, 0)
  assert.equal(stubs.created.length, 0)
})

test('session-driver:pinned 会话丢失自愈:新建并回写', async () => {
  const stubs = makeStubs()
  const driver = makeDriver(stubs)
  // When pinned 指向的会话不存在
  const outcome = await driver.run({ job: PINNED_GONE, env: {} })
  // Then 新建会话顶替,message 含「原会话丢失已重建」
  assert.equal(outcome.status, 'success')
  assert.equal(outcome.pinnedNewId, outcome.sessionId)
  assert.ok(String(outcome.message).includes('原会话丢失已重建'))
  assert.equal(stubs.created.length, 1)
})

test('session-driver:投递被拒绝记 fail', async () => {
  const stubs = makeStubs()
  stubs.sessionController.prompt = async () => ({ accepted: false })
  const driver = makeDriver(stubs)
  const outcome = await driver.run({ job: BASE_JOB, env: {} })
  assert.equal(outcome.status, 'fail')
  assert.ok(outcome.message)
})

test('session-driver:发起成功即写 RunRecord.sessionId', async () => {
  const stubs = makeStubs()
  const driver = makeDriver(stubs)
  const updates = []
  // When 发起(updateRecord 回调捕获)
  await driver.run({ job: BASE_JOB, env: {}, updateRecord: (patch) => updates.push(patch) })
  // Then sessionId 在完成等待前已写入
  assert.ok(updates.some((patch) => typeof patch.sessionId === 'string' && patch.sessionId !== ''))
})

test('session-driver:投递即终态,会话持续 running 也不等待', async () => {
  // 会话持续 running(autoIdle 关):投递成功立即返回,不等执行
  const stubs = makeStubs({ autoIdle: false })
  const driver = makeDriver(stubs)
  const outcome = await driver.run({ job: BASE_JOB, env: {} })
  assert.equal(outcome.status, 'success')
  assert.equal(outcome.message, '已投递会话')
  assert.equal(stubs.prompts.length, 1)
})

test('session-driver:prompt 携带变量折叠文本', async () => {
  const stubs = makeStubs()
  const driver = makeDriver(stubs)
  // When 带环境变量发起
  await driver.run({ job: BASE_JOB, env: { CITY: 'hangzhou' }, mask: false })
  // Then 投递文本含 prompt 与变量段
  const text = stubs.prompts[0].content[0].text
  assert.ok(text.includes('跑日报'))
  assert.ok(text.includes('CITY=hangzhou'))
})

test('session-driver:prompt 必须携带非中止 AbortSignal(宿主 facade 准入契约)', async () => {
  const seen = []
  const stubs = makeStubs()
  stubs.sessionController.prompt = (args, signal) => {
    seen.push(signal)
    queueMicrotask(() => {
      const entry = stubs.sessions.get(args.sessionId)
      if (entry) entry.status = 'idle'
    })
    return Promise.resolve({ accepted: true })
  }
  const driver = makeDriver(stubs)
  // When 正常发起
  const outcome = await driver.run({ job: BASE_JOB, env: {} })
  // Then 传入 AbortSignal 且非中止(宿主首行 throwIfAborted 可通过)
  assert.equal(outcome.status, 'success')
  assert.equal(seen.length, 1)
  assert.ok(seen[0] instanceof AbortSignal)
  assert.equal(seen[0].aborted, false)
})

test('session-driver:pinned 首跑未绑定报「已创建并绑定」而非丢失', async () => {
  const stubs = makeStubs()
  const driver = makeDriver(stubs)
  // When pinned 任务尚未绑定会话(pinnedSessionId 为空)
  const job = { ...BASE_JOB, session: { mode: 'pinned', pinnedSessionId: '' } }
  const outcome = await driver.run({ job, env: {} })
  // Then 文案区分:首次绑定,非丢失重建;pinnedNewId 回写供 executor 落库
  assert.equal(outcome.status, 'success')
  assert.equal(outcome.message, '首次运行已创建并绑定会话')
  assert.equal(outcome.pinnedNewId, outcome.sessionId)
})

test('session-driver:pinned 会话已归档视为丢失,重建并回写', async () => {
  const stubs = makeStubs()
  stubs.sessions.set('s-1', { id: 's-1', status: 'idle' })
  stubs.getWorkspaceRegistry = () => makeRegistry({ archived: ['s-1'] })
  const driver = makeDriver(stubs)
  // When pinned 指向的会话存在于持久层但已归档
  const outcome = await driver.run({ job: PINNED_S1, env: {} })
  // Then 归档视同丢失:新建会话 + 丢失文案 + pinnedNewId 回写
  assert.equal(outcome.status, 'success')
  assert.notEqual(outcome.sessionId, 's-1')
  assert.equal(outcome.message, '原会话丢失已重建')
  assert.equal(outcome.pinnedNewId, outcome.sessionId)
  assert.equal(stubs.created.length, 1)
})

test('session-driver:pinned 会话已删除视为丢失(既有语义守护)', async () => {
  const stubs = makeStubs()
  stubs.getWorkspaceRegistry = () => makeRegistry()
  const driver = makeDriver(stubs)
  const outcome = await driver.run({ job: PINNED_GONE, env: {} })
  assert.equal(outcome.status, 'success')
  assert.equal(outcome.message, '原会话丢失已重建')
})

test('session-driver:workdir 命中已有分组时以 workspaceId 建会话(dsh-im 同构)', async () => {
  const stubs = makeStubs()
  stubs.getWorkspaceRegistry = () => makeRegistry({ paths: { 'C:\\work\\demo': 'w-1' } })
  const driver = makeDriver(stubs)
  // When 任务 workdir 与已有分组 path 一致
  const outcome = await driver.run({ job: { ...BASE_JOB, workdir: 'C:\\work\\demo' }, env: {} })
  // Then create 收到 workspaceId 而非 cwd
  assert.equal(outcome.status, 'success')
  assert.deepEqual(stubs.createRequests[0], { workspaceId: 'w-1' })
})

test('session-driver:agentPreset 非空时并入 create 请求', async () => {
  const stubs = makeStubs()
  const driver = makeDriver(stubs)
  // When 任务配置了执行预设
  await driver.run({ job: { ...BASE_JOB, session: { mode: 'fresh', agentPreset: 'coder' } }, env: {} })
  // Then create 请求携带 agentPreset
  assert.deepEqual(stubs.createRequests[0], { agentPreset: 'coder' })
})

test('session-driver:agentPreset 缺省时请求不带该字段(跟随宿主默认)', async () => {
  const stubs = makeStubs()
  const driver = makeDriver(stubs)
  // When 任务未配置执行预设
  await driver.run({ job: BASE_JOB, env: {} })
  // Then create 请求无 agentPreset 键(空载时请求体整体缺省)
  const request = stubs.createRequests[0] || {}
  assert.ok(!('agentPreset' in request))
})

test('session-driver:pinned 复用已有会话不触发 create(preset 不改写)', async () => {
  const stubs = makeStubs()
  stubs.sessions.set('s-1', { id: 's-1', status: 'idle' })
  const driver = makeDriver(stubs)
  // When pinned 命中可用会话且配置了执行预设
  await driver.run({ job: { ...PINNED_S1, session: { mode: 'pinned', pinnedSessionId: 's-1', agentPreset: 'coder' } }, env: {} })
  // Then preset 是 create 语义,复用路径零 create
  assert.equal(stubs.createRequests.length, 0)
  assert.equal(stubs.prompts[0].sessionId, 's-1')
})

test('session-driver:workdir 未命中分组时建组再挂载', async (t) => {
  // createCanonical 前有 realpath 校验,须用真实存在的目录
  const dir = await mkdtemp(join(tmpdir(), 'cron-board-ws-'))
  t.after(() => rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }))
  const stubs = makeStubs()
  stubs.getWorkspaceRegistry = () => makeRegistry()
  const driver = makeDriver(stubs)
  // When 任务 workdir 无对应分组
  const outcome = await driver.run({ job: { ...BASE_JOB, workdir: dir }, env: {} })
  // Then create 收到新建分组的 workspaceId
  assert.equal(outcome.status, 'success')
  assert.deepEqual(stubs.createRequests[0], { workspaceId: 'w-1' })
})

test('session-driver:registry 缺失时降级 cwd 建会话', async () => {
  const stubs = makeStubs()
  const driver = makeDriver(stubs)
  // When 未注入 workspaceRegistry
  const outcome = await driver.run({ job: { ...BASE_JOB, workdir: 'C:\\work\\x' }, env: {} })
  // Then 回落 cwd 形态(旧行为),不影响可用性
  assert.equal(outcome.status, 'success')
  assert.deepEqual(stubs.createRequests[0], { cwd: 'C:\\work\\x' })
})
