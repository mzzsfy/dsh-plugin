// takeover BDD:mock 宿主 ctx + stub engine 跑真实 RunDriver/pre-step 拦截链路
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { registerTakeover } from '../lib/takeover.mjs'
import { registry } from '../lib/driver/control.mjs'
import { createStore } from '../lib/store.mjs'

const FLOW = {
  id: 't-flow', label: '测试流',
  steps: [
    { id: 'a', prompt: '做 {request}', outputs: { o: '产出' } },
    { id: 'b', after: ['a'], prompt: '续 {a.o}', outputs: { o: '产出' } },
  ],
}

const stubEngine = (outputs) => ({
  start({ args }) {
    return { result: Promise.resolve({ results: args.calls.map((c) => ({ callId: c.callId, ok: true, outputs })) }) }
  },
})

// mock 宿主:inject 捕获 workflowEngine;pre-step 处理器可手动触发;notice 收集
const mockCtx = (engine) => {
  const notices = []
  let preStepHandler = null
  const effects = []
  const ctx = {
    notices,
    get: (name) => (name === 'settings' ? { get: () => ({}) } : undefined),
    inject: (names, fn) => {
      const engineCtx = {
        workflowEngine: engine,
        effect: (reg, label) => {
          effects.push(label)
          return reg()
        },
        on: (eventName, handler) => {
          if (eventName === 'agent/pre-step') preStepHandler = handler
        },
      }
      fn(engineCtx)
    },
    logger: { warn: () => {}, error: () => {} },
    firePreStep: async (payload) => {
      const nextCalls = []
      const result = await preStepHandler(payload, () => {
        nextCalls.push(true)
        return { kind: 'next' }
      })
      return { result, nextCalled: nextCalls.length > 0 }
    },
  }
  return { ctx, notices, firePreStep: ctx.firePreStep, effects }
}

const mockAgent = (sessionId, { parentSession } = {}) => {
  const agent = {
    id: `agent-${sessionId}`,
    session: {
      id: sessionId,
      header: parentSession === undefined ? {} : { parentSession },
      append: (kind, data) => notices.push({ kind, data }),
    },
  }
  const notices = agent.session.append ? [] : []
  return agent
}

// agent.session.append 需要闭包 notices,重建
const makeAgent = (sessionId, notices, { parentSession } = {}) => ({
  id: `agent-${sessionId}`,
  session: {
    id: sessionId,
    header: parentSession === undefined ? {} : { parentSession },
    append: (kind, data) => notices.push({ kind, data }),
  },
})

const setup = (engineOutputs = { o: 'X' }, flowText = JSON.stringify(FLOW, null, 2), engineOverride = null) => {
  const home = mkdtempSync(join(tmpdir(), 'rsww-takeover-'))
  mkdirSync(join(home, '.agent-presets', 'rs-t-flow'), { recursive: true })
  writeFileSync(join(home, '.agent-presets', 'rs-t-flow', 'flow.json5'), flowText ?? JSON.stringify(FLOW, null, 2))
  writeFileSync(join(home, '.agent-presets', 'rs-t-flow', '.dsh-rs-workflow-source.json'), JSON.stringify({ package: '@mzzsfy/dsh-rs-workflow', kind: 'flow', version: '1.0.0' }))
  const flowFile = join(home, 'flow-entry.json5')
  writeFileSync(flowFile, flowText ?? JSON.stringify(FLOW, null, 2))
  const store = createStore({ dir: join(home, 'runs-data') })
  const engine = engineOverride ?? stubEngine(engineOutputs)
  const h = mockCtx(engine)
  const takeover = registerTakeover(h.ctx, { kind: 'flow', flowFile }, { dshHome: home, store })
  return { ...h, takeover, store, home, flowFile }
}

const msgPayload = (agent, text) => ({ agent, messages: [{ role: 'user', content: text }] })

test('Given 激活时 flowFile 校验失败 When registerTakeover Then 抛错且不注册', () => {
  const home = mkdtempSync(join(tmpdir(), 'rsww-takeover-bad-'))
  const flowFile = join(home, 'bad.json5')
  writeFileSync(flowFile, JSON.stringify({ id: 'x', steps: [{ id: 'a', unknownField: 1, prompt: 'p', outputs: { o: 'o' } }] }))
  const h = mockCtx(null)
  assert.throws(() => registerTakeover(h.ctx, { kind: 'flow', flowFile }, { dshHome: home, store: createStore({ dir: join(home, 'd') }) }), /校验失败/)
})

test('Given 主会话首条消息 When pre-step Then reject,notice 写入,run 落 store 并 completed', async () => {
  const h = setup({ o: 'OUT' })
  const notices = []
  const agent = makeAgent('s1', notices)
  const { result, nextCalled } = await h.firePreStep(msgPayload(agent, '帮我做需求'))
  assert.equal(nextCalled, false)
  assert.equal(result.kind, 'reject')
  assert.equal(notices.length, 1)
  assert.ok(notices[0].data.content[0].text.includes('已接管'))
  await new Promise((r) => setTimeout(r, 80))
  const records = h.store.list()
  assert.equal(records.length, 1)
  assert.equal(records[0].status, 'completed')
  assert.equal(notices.filter((n) => n.data.content[0].text.includes('编排完成')).length, 1)
})

test('Given 子代理消息 When pre-step Then 放行不接管', async () => {
  const h = setup()
  const notices = []
  const agent = makeAgent('child', notices, { parentSession: 's-parent' })
  const { nextCalled } = await h.firePreStep(msgPayload(agent, '子代理请求'))
  assert.equal(nextCalled, true)
  assert.equal(h.store.list().length, 0)
})

test('Given 在飞时第二条消息 When pre-step Then 入队+notice+reject,批次边界消费;终态后放行', async () => {
  // 可控引擎:首 run 挂起制造在飞窗口
  const makeOk = (c) => ({ callId: c.callId, ok: true, outputs: { o: 'X' } })
  const pending = []
  const engine = {
    start: ({ args }) => {
      const promise = new Promise((res) => {
        pending.push(() => res({ results: args.calls.map(makeOk) }))
      })
      return { result: promise }
    },
  }
  const h = setup(null, null, engine)
  const notices = []
  const agent = makeAgent('s2', notices)
  await h.firePreStep(msgPayload(agent, '第一条'))
  const runId = h.store.list()[0].runId
  // 在飞窗口内第二条:入队
  const second = await h.firePreStep(msgPayload(agent, '补充要求'))
  assert.equal(second.result.kind, 'reject')
  assert.ok(notices.some((n) => n.data.content[0].text.includes('已排队')))
  assert.deepEqual(h.store.get(runId).queued, ['补充要求'])
  // 放行两批:第一批挂起的 a,第二批 b 消费排队消息
  pending[0]()
  await new Promise((r) => setTimeout(r, 60))
  pending[1]()
  await new Promise((r) => setTimeout(r, 80))
  const record = h.store.get(runId)
  assert.equal(record.status, 'completed')
  const bDispatch = record.steps.b['-'].find((e) => e.event === 'dispatch')
  assert.ok(bDispatch.prompt.includes('[用户补充]'))
  assert.ok(bDispatch.prompt.includes('补充要求'))
  assert.deepEqual(record.queued, [])
  // 终态后 active 残账构造 post=false 分支:放行进主模型
  h.takeover.active.set(agent.id, { runId: 'r-gone', agent })
  const third = await h.firePreStep(msgPayload(agent, '新请求'))
  assert.equal(third.nextCalled, true)
})

test('Given run 落定 When 收敛 Then driver 注销注册表,active 清空', async () => {
  const h = setup()
  const notices = []
  const agent = makeAgent('s3', notices)
  await h.firePreStep(msgPayload(agent, '请求'))
  await new Promise((r) => setTimeout(r, 80))
  assert.equal(registry.drivers.size, 0)
  assert.equal(h.takeover.active.size, 0)
})

test('Given 发起器注册 When resume 经 initiatorOf Then 同会话再起 run', async () => {
  const h = setup()
  const notices = []
  const agent = makeAgent('s4', notices)
  await h.firePreStep(msgPayload(agent, '首请求'))
  await new Promise((r) => setTimeout(r, 80))
  const initiator = registry.initiators.get('s4')
  assert.ok(initiator)
  await initiator({ agent, request: '恢复请求', inputs: {}, seed: undefined })
  await new Promise((r) => setTimeout(r, 80))
  const records = h.store.list()
  assert.equal(records.length, 2)
})
