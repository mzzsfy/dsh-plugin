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

const msgPayload = (agent, text, source) => ({ agent, messages: [{ role: 'user', content: [{ type: 'text', text }], ...(source ? { source } : { source: { kind: 'user', rpcId: 'rpc-' + text } }) }] })

test('Given 激活时 flowFile 校验失败 When registerTakeover Then 抛错且不注册', () => {
  const home = mkdtempSync(join(tmpdir(), 'rsww-takeover-bad-'))
  const flowFile = join(home, 'bad.json5')
  writeFileSync(flowFile, JSON.stringify({ id: 'x', steps: [{ id: 'a', unknownField: 1, prompt: 'p', outputs: { o: 'o' } }] }))
  const h = mockCtx(null)
  assert.throws(() => registerTakeover(h.ctx, { kind: 'flow', flowFile }, { dshHome: home, store: createStore({ dir: join(home, 'd') }) }), /校验失败/)
})

test('Given 主会话首条消息 When pre-step Then reject,请求按宿主同形落盘+notice 写入,run 落 store 并 completed', async () => {
  const h = setup({ o: 'OUT' })
  const notices = []
  const agent = makeAgent('s1', notices)
  const { result, nextCalled } = await h.firePreStep(msgPayload(agent, '帮我做需求'))
  assert.equal(nextCalled, false)
  assert.equal(result.kind, 'reject')
  assert.equal(notices.length, 2)
  const mirrored = notices[0]
  assert.equal(mirrored.kind, 'user/message')
  assert.equal(mirrored.data.source.kind, 'user')
  assert.ok(mirrored.data.source.rpcId)
  assert.equal(mirrored.data.role, 'user')
  assert.equal(mirrored.data.content[0].text, '帮我做需求')
  assert.ok(notices[1].data.content[0].text.includes('已接管'))
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
  // 批次间宏任务让步后派发非同步,等首批挂起进入在飞窗口
  while (pending.length === 0) await new Promise((r) => setTimeout(r, 5))
  // 在飞窗口内第二条:入队
  const second = await h.firePreStep(msgPayload(agent, '补充要求'))
  assert.equal(second.result.kind, 'reject')
  assert.ok(notices.some((n) => n.data.content[0].text.includes('已排队')))
  const queuedMirror = notices.filter((n) => n.kind === 'user/message' && n.data.source.kind === 'user')
  assert.equal(queuedMirror.length, 2)
  assert.equal(queuedMirror[1].data.content[0].text, '补充要求')
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
  // 终态后 active 残账构造 post=false 分支:放行进主模型,宿主自行落盘,本行不镜像
  h.takeover.active.set(agent.id, { runId: 'r-gone', agent })
  const beforeThird = notices.length
  const third = await h.firePreStep(msgPayload(agent, '新请求'))
  assert.equal(third.nextCalled, true)
  assert.equal(notices.length, beforeThird)
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

test('Given 在飞 run When 控制命令与注入消息 Then notice 转写控制文案且为扁平原生形态', async () => {
  // 可控引擎:首批次挂起,driver 停在 runBatch await,gate 未进入,pause/resume/cancel 的 onNotice 同步触发
  const pending = []
  const engine = {
    start: ({ args }) => {
      const promise = new Promise((res) => {
        pending.push(() => res({ results: args.calls.map((c) => ({ callId: c.callId, ok: true, outputs: { o: 'X' } })) }))
      })
      return { result: promise }
    },
  }
  const h = setup(null, null, engine)
  const notices = []
  const agent = makeAgent('s-ctrl', notices)
  await h.firePreStep(msgPayload(agent, '控制请求'))
  await new Promise((r) => setTimeout(r, 80))
  const runId = h.store.list()[0].runId
  const driver = registry.drivers.get(runId)
  assert.ok(driver)
  // 控制命令与注入消息经 driver 即时通道触发 onNotice → 会话 notice
  driver.pause()
  driver.resume()
  assert.equal(driver.handlePost({ kind: 'message', text: '注入内容', inject: true }), true)
  driver.cancel()
  const textOf = (n) => n.data.content[0].text
  assert.ok(notices.some((n) => textOf(n).includes('已暂停')))
  assert.ok(notices.some((n) => textOf(n).includes('已恢复运行')))
  assert.ok(notices.some((n) => textOf(n).includes('已收到注入消息')))
  assert.ok(notices.some((n) => textOf(n).includes('已取消')))
  // 扁平原生形态:user/message + role user + source.form notice + 单段 text
  const notice = notices.find((n) => textOf(n).includes('已暂停'))
  assert.equal(notice.kind, 'user/message')
  assert.equal(notice.data.role, 'user')
  assert.equal(notice.data.source.form, 'notice')
  assert.equal(notice.data.content[0].type, 'text')
  // 收尾:放行挂起批次,abort 语义走 finish('cancelled') 收敛
  pending[0]()
  await new Promise((r) => setTimeout(r, 60))
})

test('Given notice 写入抛错 When pre-step 首消息 Then 仍 reject 且 run 启动且 logger.warn 降级', async () => {
  const h = setup()
  const warns = []
  h.ctx.logger = { warn: (m) => warns.push(m), error: () => {} }
  let appendCalls = 0
  const agent = {
    id: 'agent-err',
    session: {
      id: 's-err',
      header: {},
      append: () => {
        appendCalls++
        throw new Error('会话通道损坏')
      },
    },
  }
  const { result, nextCalled } = await h.firePreStep(msgPayload(agent, '首消息'))
  assert.equal(nextCalled, false)
  assert.equal(result.kind, 'reject')
  await new Promise((r) => setTimeout(r, 100))
  // 写入失败不阻断接管与编排:run 正常落 store 并完成,请求落盘与接管/终态 notice 均降级为 warn
  assert.equal(h.store.list().length, 1)
  assert.equal(h.store.list()[0].status, 'completed')
  assert.ok(appendCalls >= 3)
  assert.ok(warns.length >= 3)
  assert.ok(warns.every((m) => m.includes('失败') && m.includes('rs-workflow')))
})
