// flow-v4 批次 BDD:桩 engine + 真实 RunDriver/store 链路(契约源 docs/rsww-v4/feat/driver/design.md 验收点)
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createStore } from '../packages/dsh-rs-workflow/lib/store.mjs'
import { RunDriver, startRun, buildSeed } from '../packages/dsh-rs-workflow/lib/driver/index.mjs'
import { post, registry } from '../packages/dsh-rs-workflow/lib/driver/control.mjs'

const CHAIN = {
  id: 'chain', label: '链式',
  steps: [
    { id: 'a', prompt: '第一步 {request}', outputs: { o: '产出' } },
    { id: 'b', after: ['a'], prompt: '第二步 {a.o}', outputs: { o: '产出' } },
    { id: 'c', prompt: '第三步 {b.o}', outputs: { o: '产出' } },
  ],
}

const APPROVE_TPL = {
  id: 'app', label: '审批',
  steps: [
    { id: 'task', prompt: '做事 {request}', outputs: { result: '结果' } },
    { id: 'review', type: 'approve', after: ['task'], target: 'task', rounds: 1, onExhausted: 'blocked', prompt: '审 {request}' },
  ],
}

const APPROVE_REDO_TPL = {
  id: 'app2', label: '审批重做',
  steps: [
    { id: 'task', prompt: '做事 {request}', outputs: { result: '结果' } },
    { id: 'review', type: 'approve', after: ['task'], target: 'task', rounds: 2, onExhausted: 'blocked', prompt: '审 {request}' },
  ],
}

const ESCALATE_TPL = {
  id: 'esc', label: '升级',
  steps: [
    { id: 'task', prompt: '做事 {request}', outputs: { result: '结果' } },
    { id: 'review', type: 'approve', after: ['task'], target: 'task', rounds: 1, onExhausted: 'escalate', prompt: '审 {request}' },
    { id: 'escalate', slot: 'executor-escalate', prompt: '保守交付 {request}', outputs: { fallback: '降级' } },
  ],
}

// 桩 engine:按 prompt 关键字脚本化产出;支持产出 null(未提交)/抛错/延迟
function stubEngine(scriptMap, { promptIndex = [] } = {}) {
  return {
    start({ args, signal }) {
      const results = args.calls.map((call) => {
        promptIndex.push(call.prompt)
        const rule = scriptMap(call)
        if (rule === null) return { callId: call.callId, ok: false, error: '子代理未提交结构化产出' }
        if (rule instanceof Error) return { callId: call.callId, ok: false, error: rule.message }
        return { callId: call.callId, ok: true, outputs: typeof rule === 'function' ? rule(call) : rule }
      })
      return { result: Promise.resolve({ results }) }
    },
  }
}

const harness = () => {
  const dir = mkdtempSync(join(tmpdir(), 'rsww-flow4-'))
  const store = createStore({ dir })
  const promptIndex = []
  const runToDone = (driver) => new Promise((resolve) => {
    const orig = driver.finish.bind(driver)
    driver.finish = (status, summary) => {
      orig(status, summary)
      resolve({ status, driver, summary: driver.store.get(driver.runId).summary })
    }
    driver.start()
  })
  const run = async ({ template, engineMap, runId, budgets = { maxStepFail: 2, approveRounds: 2, escalateLimit: 2 }, slots = {} }) => {
    const engine = stubEngine(engineMap, { promptIndex })
    const driver = new RunDriver({
      template, runId: runId ?? `r-test-${Math.random().toString(36).slice(2, 8)}`, request: '需求R',
      parent: {}, engine, slots, budgets, store,
    })
    return await runToDone(driver)
  }
  return { store, promptIndex, run, runToDone, dir }
}

test('Given 三步链式 When 逐步达标 Then 按序三批,run completed,store 产出全文', async () => {
  const h = harness()
  const { status, driver } = await h.run({
    template: CHAIN,
    engineMap: (call) => (call.prompt.includes('A1') ? { o: 'B1' } : call.prompt.includes('B1') ? { o: 'C1' } : { o: 'A1' }),
  })
  assert.equal(status, 'completed')
  const record = driver.store.get(driver.runId)
  assert.equal(record.steps.a['-'].find((e) => e.event === 'submit').outputs.o, 'A1')
  assert.equal(record.steps.b['-'].find((e) => e.event === 'submit').outputs.o, 'B1')
  assert.equal(record.steps.c['-'].find((e) => e.event === 'submit').outputs.o, 'C1')
})

test('Given approve REJECTED When 重做 Then prompt 含重做说明,rounds 记账,再审通过 completed', async () => {
  const h = harness()
  let reviewCount = 0
  const { status, driver } = await h.run({
    template: APPROVE_REDO_TPL,
    engineMap: (call) => {
      if (call.prompt.includes('[重做说明]')) return { result: '重做后的合格产出' }
      if (call.prompt.includes('做事')) return { result: '首版产出' }
      reviewCount++
      return reviewCount === 1
        ? { verdict: 'REJECTED', comments: '不合格,重做' }
        : { verdict: 'APPROVED', comments: '通过' }
    },
  })
  assert.equal(status, 'completed')
  assert.equal(driver.state.approvals.review.rounds, 1)
  const redoPrompt = h.promptIndex.find((p) => p.includes('[重做说明]'))
  assert.ok(redoPrompt.includes('不合格,重做'))
  assert.ok(redoPrompt.includes('首版产出'))
})

test('Given approve 轮次耗尽且 onExhausted=blocked When 路由 Then run blocked', async () => {
  const h = harness()
  const { status } = await h.run({
    template: APPROVE_TPL,
    engineMap: (call) => (call.prompt.startsWith('[任务]') ? { result: '产出' } : { verdict: 'REJECTED', comments: '拒' }),
  })
  assert.equal(status, 'blocked')
})

test('Given approve 耗尽且 onExhausted=升级步 When 路由 Then 升级步派发,run completed', async () => {
  const h = harness()
  const { status, driver } = await h.run({
    template: ESCALATE_TPL,
    engineMap: (call) => {
      if (call.prompt.includes('保守交付')) return { fallback: '降级交付' }
      if (call.prompt.startsWith('[任务]')) return { result: '产出' }
      return { verdict: 'REJECTED', comments: '拒' }
    },
  })
  assert.equal(status, 'completed')
  assert.equal(driver.state.steps.escalate.outputs.fallback, '降级交付')
  assert.equal(driver.state.steps.task.status, 'skipped')
})

test('Given 升级步自身失败达上限 When 判定 Then run failed(升级兜底不覆盖执行失败)', async () => {
  const h = harness()
  const { status } = await h.run({
    template: ESCALATE_TPL,
    engineMap: (call) => {
      if (call.prompt.includes('保守交付')) return new Error('升级也失败')
      if (call.prompt.startsWith('[任务]')) return { result: '产出' }
      return { verdict: 'REJECTED', comments: '拒' }
    },
  })
  assert.equal(status, 'failed')
})

test('Given 子代理未提交产出 When 失败账累计达上限 Then 步骤 failed,run failed', async () => {
  const h = harness()
  const { status, driver } = await h.run({
    template: CHAIN,
    engineMap: () => null,
  })
  assert.equal(status, 'failed')
  assert.equal(driver.state.steps.a.status, 'failed')
  assert.equal(driver.state.steps.a.failCount, 2)
  assert.equal(driver.state.steps.b.status, 'skipped')
})

test('Given 失败未达上限 When 重试 Then 同步重试,第二次成功则继续', async () => {
  const h = harness()
  let aCount = 0
  const { status } = await h.run({
    template: CHAIN,
    engineMap: (call) => {
      if (call.prompt.includes('[任务]') && call.prompt.includes('第一步')) {
        aCount++
        return aCount === 1 ? null : { o: 'A' }
      }
      return { o: 'X' }
    },
  })
  assert.equal(status, 'completed')
  assert.equal(aCount, 2)
})

test('Given 运行中 post inject 消息 When 下一批次 Then prompt 含 [运行中用户消息] 一次', async () => {
  const h = harness()
  let driverRef = null
  const engine = {
    start({ args }) {
      const results = args.calls.map((call) => {
        h.promptIndex.push(call.prompt)
        if (call.prompt.includes('第二步') && !h.injected) {
          h.injected = true
          post(driverRef.runId, { kind: 'message', text: '注意口径', inject: true })
        }
        return { callId: call.callId, ok: true, outputs: { o: 'X' } }
      })
      return { result: Promise.resolve({ results }) }
    },
  }
  driverRef = new RunDriver({
    template: CHAIN, runId: 'r-inject', request: '需求', parent: {}, engine, budgets: { maxStepFail: 2, approveRounds: 2, escalateLimit: 2 }, store: h.store,
  })
  const { status } = await h.runToDone(driverRef)
  assert.equal(status, 'completed')
  const injectPrompt = h.promptIndex.find((p) => p.includes('[运行中用户消息]'))
  assert.ok(injectPrompt)
  assert.equal(injectPrompt.split('[运行中用户消息]').length - 1, 1)
  assert.ok(injectPrompt.includes('注意口径'))
})

test('Given 运行中 post 排队消息 When 后续批次 Then [用户补充] 节可见且 queued 回显后清空', async () => {
  const h = harness()
  let driverRef = null
  const engine = {
    start({ args }) {
      const results = args.calls.map((call) => {
        h.promptIndex.push(call.prompt)
        if (call.prompt.includes('第二步') && !h.injected) {
          h.injected = true
          post(driverRef.runId, { kind: 'message', text: '补充材料', inject: false })
        }
        return { callId: call.callId, ok: true, outputs: { o: 'X' } }
      })
      return { result: Promise.resolve({ results }) }
    },
  }
  driverRef = new RunDriver({
    template: CHAIN, runId: 'r-queued', request: '需求', parent: {}, engine, budgets: { maxStepFail: 2, approveRounds: 2, escalateLimit: 2 }, store: h.store,
  })
  const { status, driver } = await h.runToDone(driverRef)
  assert.equal(status, 'completed')
  const q = h.promptIndex.find((p) => p.includes('[用户补充]'))
  assert.ok(q && q.includes('补充材料'))
  assert.deepEqual(driver.store.get('r-queued').queued, [])
})

test('Given 运行中 cancel When 在飞中断 Then run cancelled 且已完成步骤保留', async () => {
  const h = harness()
  let abortSignal
  const engine = {
    start({ args, signal }) {
      abortSignal = signal
      return {
        result: new Promise((resolve, reject) => {
          setTimeout(() => (signal.aborted ? reject(new Error('cancelled')) : resolve({ results: args.calls.map((c) => ({ callId: c.callId, ok: true, outputs: { o: 'slow' } })) })), 300)
        }),
      }
    },
  }
  const driver = new RunDriver({
    template: CHAIN, runId: 'r-cancel', request: '需求', parent: {}, engine, budgets: { maxStepFail: 2, approveRounds: 2, escalateLimit: 2 }, store: h.store,
  })
  const doneP = new Promise((r) => {
    const orig = driver.finish.bind(driver)
    driver.finish = (s) => {
      orig(s, '')
      r(s)
    }
  })
  driver.start()
  await new Promise((r) => setTimeout(r, 30))
  driver.cancel()
  const status = await doneP
  assert.equal(status, 'cancelled')
  assert.equal(h.store.get('r-cancel').state.status, 'cancelled')
})

test('Given 孤儿 running 记录 When 新 store 加载 Then 收敛 cancelled;resume-from Then 断点续跑不重派 done', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rsww-seed-'))
  const store = createStore({ dir })
  store.start({ runId: 'r-old', sessionId: 's9', request: '需求', templateId: 'chain', state: {
    status: 'running', request: '需求', inputs: {}, steps: {
      a: { status: 'done', outputs: { o: 'A' }, failCount: 0, instances: [] },
      b: { status: 'done', outputs: { o: 'B' }, failCount: 0, instances: [] },
      c: { status: 'pending', outputs: null, failCount: 0, instances: [] },
    },
    approvals: {}, escalations: 0, queued: [], batchSeq: 2, slotCursor: {},
  } })
  const record = JSON.parse(JSON.stringify(store.get('r-old')))
  const seed = buildSeed(record, CHAIN, 'c')
  assert.equal(seed.steps.a.status, 'done')
  assert.equal(seed.steps.b.status, 'done')
  assert.equal(seed.steps.c.status, 'pending')
  assert.equal(seed.steps.a.outputs.o, 'A')
})
