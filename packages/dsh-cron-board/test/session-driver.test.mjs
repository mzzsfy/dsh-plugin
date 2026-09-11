// session-driver 测试:HostApiDriver 会话编排语义(设计 §4.3、§7 BDD 会话组)。
// 桩替 sessionController/agents/sessionQuery,验证 fresh/pinned/忙跳过/丢失自愈/超时/完成判定。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { setTimeout as delay } from 'node:timers/promises'

import { createSessionDriver } from '../src/session-driver.mjs'

// 可控桩:会话注册表 + 控制器(autoIdle 模拟宿主投递后处理完成转 idle;超时场景关掉)
function makeStubs({ autoIdle = true } = {}) {
  const sessions = new Map()
  let nextId = 0
  const created = []
  const prompts = []
  const sessionController = {
    async create({ cwd } = {}) {
      const sessionId = 's-' + (++nextId)
      sessions.set(sessionId, { id: sessionId, cwd, status: 'running' })
      created.push({ sessionId, cwd })
      return { sessionId }
    },
    async prompt(args) {
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
    async listSessions() {
      return [...sessions.values()].map((entry) => ({ id: entry.id }))
    },
  }
  return { sessions, created, prompts, sessionController, agents, sessionQuery }
}

function makeDriver(stubs, overrides = {}) {
  return createSessionDriver({
    getSessionController: () => stubs.sessionController,
    agents: stubs.agents,
    sessionQuery: stubs.sessionQuery,
    pollIntervalMs: 5,
    ...overrides,
  })
}

const BASE_JOB = { id: 'j1', kind: 'session', prompt: '跑日报', session: { mode: 'fresh' }, timeoutMs: 60 * 1000 }
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
  assert.equal(outcome.pinnedNewId, 's-1')
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

test('session-driver:会话 idle 即完成(success)', async () => {
  const stubs = makeStubs()
  const driver = makeDriver(stubs)
  // When 发起后把会话置 idle(模拟完成)
  const pending = driver.run({ job: BASE_JOB, env: {} })
  await delay(30)
  const sessionId = stubs.created[0].sessionId
  stubs.sessions.get(sessionId).status = 'idle'
  const outcome = await pending
  // Then success 且 RunRecord.sessionId 已写
  assert.equal(outcome.status, 'success')
  assert.equal(outcome.sessionId, sessionId)
})

test('session-driver:timeoutMs 到点记 timeout', async () => {
  // 会话持续 running(autoIdle 关),轮询到超时
  const stubs = makeStubs({ autoIdle: false })
  const driver = makeDriver(stubs, { pollIntervalMs: 5 })
  const outcome = await driver.run({ job: { ...BASE_JOB, timeoutMs: 40 }, env: {} })
  assert.equal(outcome.status, 'timeout')
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
