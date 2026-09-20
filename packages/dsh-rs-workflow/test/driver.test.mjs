// driver 单测(v5):scheduler 剧本域/approve 外部裁决/prompts 剧本注入 BDD
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { nextBatch, scriptViewOf } from '../lib/driver/scheduler.mjs'
import { applyApproveResult, applyExternalVerdict, waitingPayload } from '../lib/driver/approve.mjs'
import { buildPrompt, schemaOf, resolvePlaceholders } from '../lib/driver/prompts.mjs'
import { RunDriver, collectSubOutputs, buildSeed } from '../lib/driver/index.mjs'

const init = (template, plan, { request = '需求', inputs = {} } = {}) => {
  const view = scriptViewOf(template, plan)
  const state = { status: 'running', request, inputs, steps: {}, approvals: {}, escalations: 0, queued: [], batchSeq: 0, slotCursor: {}, controlSeq: 0, redoInfo: {} }
  for (const step of view.steps) state.steps[step.id] = { status: 'pending', outputs: null, failCount: 0, instances: [] }
  return state
}

const CHAIN = {
  id: 't', label: 't',
  steps: [
    { id: 'a', prompt: 'P {request}', outputs: { o: '产出' } },
    { id: 'b', after: ['a'], prompt: 'Q {a.o}', outputs: { o: '产出' } },
    { id: 'c', prompt: 'R', outputs: { o: '产出' } },
  ],
}
// 剧本=全序,依赖由 gate 重算形态直接给
const fullPlan = (refs) => {
  const deps = {}
  refs.forEach((r, i) => { deps[r] = i === 0 ? [] : [refs[i - 1]] })
  return { source: 'model', brief: '口径', steps: refs.map((r) => ({ ref: r, note: '', done: '' })), deps }
}

test('Given 三步链式剧本 When 首批 Then 仅 a 就绪;依次推进至 terminal', () => {
  const plan = fullPlan(['a', 'b', 'c'])
  const script = scriptViewOf(CHAIN, plan)
  const state = init(CHAIN, plan)
  assert.deepEqual(nextBatch(state, script).calls.map((c) => c.stepId), ['a'])
  state.steps.a.status = 'done'
  state.steps.a.outputs = { o: 'A' }
  assert.deepEqual(nextBatch(state, script).calls.map((c) => c.stepId), ['b'])
  state.steps.b.status = 'done'
  state.steps.b.outputs = { o: 'B' }
  assert.deepEqual(nextBatch(state, script).calls.map((c) => c.stepId), ['c'])
  state.steps.c.status = 'done'
  state.steps.c.outputs = { o: 'C' }
  assert.equal(nextBatch(state, script).kind, 'terminal')
})

test('Given 裁剪剧本(c 不在剧本) When 推进 Then 引擎只见剧本步骤', () => {
  const plan = fullPlan(['a', 'b'])
  const script = scriptViewOf(CHAIN, plan)
  const state = init(CHAIN, plan)
  assert.equal('c' in state.steps, false)
  state.steps.a.status = 'done'
  state.steps.a.outputs = { o: 'A' }
  assert.deepEqual(nextBatch(state, script).calls.map((c) => c.stepId), ['b'])
  state.steps.b.status = 'done'
  state.steps.b.outputs = { o: 'B' }
  assert.equal(nextBatch(state, script).kind, 'terminal')
})

test('Given gate 压缩依赖(b 被裁,a 依赖压缩) When 调度 Then c 直接等 a', () => {
  const plan = { source: 'model', brief: '', steps: [{ ref: 'a' }, { ref: 'c' }].map((p) => ({ ...p, note: '', done: '' })), deps: { a: [], c: ['a'] } }
  const script = scriptViewOf(CHAIN, plan)
  const state = init(CHAIN, plan)
  assert.deepEqual(nextBatch(state, script).calls.map((c) => c.stepId), ['a'])
  state.steps.a.status = 'done'
  state.steps.a.outputs = { o: 'A' }
  assert.deepEqual(nextBatch(state, script).calls.map((c) => c.stepId), ['c'])
})

test('Given 显式无依赖六步 When 首批 Then 同批并行且并发上限 4', () => {
  const tpl = {
    id: 't', label: 't',
    steps: Array.from({ length: 6 }, (_, i) => ({ id: `s${i}`, prompt: 'P', outputs: { o: 'o' }, after: [] })),
  }
  const refs = tpl.steps.map((s) => s.id)
  const plan = { source: 'model', brief: '', steps: refs.map((r) => ({ ref: r, note: '', done: '' })), deps: Object.fromEntries(refs.map((r) => [r, []])) }
  const script = scriptViewOf(tpl, plan)
  const state = init(tpl, plan)
  assert.equal(nextBatch(state, script).calls.length, 4)
})

test('Given for_each sequential When 数据源 3 项 Then 首批仅实例1,完成后实例2 携带 carry', () => {
  const tpl = {
    id: 't', label: 't',
    steps: [
      { id: 'src', prompt: 'P', outputs: { items: '列表' }, listOutputs: ['items'] },
      { id: 'work', for_each: 'src.items', mode: 'sequential', prompt: '{item} 上一个:{work.r}', outputs: { r: '结果' } },
    ],
  }
  const plan = fullPlan(['src', 'work'])
  const script = scriptViewOf(tpl, plan)
  const state = init(tpl, plan)
  state.steps.src.status = 'done'
  state.steps.src.outputs = { items: ['甲', '乙', '丙'] }
  const b1 = nextBatch(state, script)
  assert.deepEqual(b1.calls.map((c) => c.instance.key), ['#1'])
  const inst1 = state.steps.work.instances[0]
  inst1.status = 'done'
  inst1.outputs = { r: 'R1' }
  const b2 = nextBatch(state, script)
  assert.deepEqual(b2.calls.map((c) => c.instance.key), ['#2'])
  assert.deepEqual(b2.calls[0].instance.carry, { r: 'R1' })
})

test('Given for_each 数据源空 When 展开 Then 该步 skipped', () => {
  const tpl = {
    id: 't', label: 't',
    steps: [
      { id: 'src', prompt: 'P', outputs: { items: '列表' }, listOutputs: ['items'] },
      { id: 'work', for_each: 'src.items', mode: 'parallel', prompt: '{item}', outputs: { r: '结果' } },
    ],
  }
  const plan = fullPlan(['src', 'work'])
  const script = scriptViewOf(tpl, plan)
  const state = init(tpl, plan)
  state.steps.src.status = 'done'
  state.steps.src.outputs = { items: [] }
  nextBatch(state, script)
  assert.equal(state.steps.work.status, 'skipped')
})

test('Given 依赖失败 When 下一步判定 Then skipped 沿剧本依赖传播', () => {
  const plan = fullPlan(['a', 'b', 'c'])
  const script = scriptViewOf(CHAIN, plan)
  const state = init(CHAIN, plan)
  state.steps.a.status = 'failed'
  nextBatch(state, script)
  assert.equal(state.steps.b.status, 'skipped')
  assert.equal(state.steps.c.status, 'skipped')
})

test('Given 全部失败 When 判定 Then terminal(failed 由终态判定处理)', () => {
  const plan = fullPlan(['a', 'b', 'c'])
  const script = scriptViewOf(CHAIN, plan)
  const state = init(CHAIN, plan)
  state.steps.a.status = 'failed'
  state.steps.b.status = 'skipped'
  state.steps.c.status = 'skipped'
  assert.equal(nextBatch(state, script).kind, 'terminal')
})

// ── 审批外部裁决(v5) ─────────────────────────────────────────────────────
const APPROVE_TPL = {
  id: 't', label: 't',
  steps: [
    { id: 'a', prompt: 'P', outputs: { o: 'o' } },
    { id: 'down', after: ['a'], prompt: 'D', outputs: { o: 'o' } },
    { id: 'rev', type: 'approve', target: 'a', rounds: 2, onExhausted: 'esc', prompt: 'R' },
    { id: 'esc', prompt: 'E', outputs: { o: 'o' } },
  ],
}
const approvePlan = () => fullPlan(['a', 'down', 'rev', 'esc'])

test('Given approve 步就绪 When nextBatch Then approve 侦测批(target done)', () => {
  const plan = approvePlan()
  const script = scriptViewOf(APPROVE_TPL, plan)
  const state = init(APPROVE_TPL, plan)
  state.steps.a.status = 'done'
  state.steps.a.outputs = { o: 'A' }
  state.steps.down.status = 'done'
  state.steps.down.outputs = { o: 'D' }
  const batch = nextBatch(state, script)
  assert.equal(batch.kind, 'approve')
  assert.equal(batch.step.id, 'rev')
})

test('Given 外部裁决 APPROVED When applyExternalVerdict Then approve done 且状态翻 running', () => {
  const plan = approvePlan()
  const script = scriptViewOf(APPROVE_TPL, plan)
  const state = init(APPROVE_TPL, plan)
  state.status = 'waiting_approval'
  state.steps.rev.status = 'pending'
  const r = applyExternalVerdict(state, script, APPROVE_TPL.steps[2], { verdict: 'APPROVED', comments: '达标' }, { approveRounds: 2 })
  assert.equal(r.applied, true)
  assert.equal(r.route.verdict, 'APPROVED')
  assert.equal(state.steps.rev.status, 'done')
  assert.equal(state.status, 'running')
})

test('Given 外部裁决 REJECTED 未耗尽 When 回写 Then target 重做 rounds=1 状态翻 running', () => {
  const plan = approvePlan()
  const script = scriptViewOf(APPROVE_TPL, plan)
  const state = init(APPROVE_TPL, plan)
  state.status = 'waiting_approval'
  state.steps.a.status = 'done'
  state.steps.a.outputs = { o: 'A1' }
  state.steps.rev.status = 'pending'
  const r = applyExternalVerdict(state, script, APPROVE_TPL.steps[2], { verdict: 'REJECTED', comments: '改' }, { approveRounds: 2 })
  assert.equal(r.applied, true)
  assert.equal(state.approvals.rev.rounds, 1)
  assert.equal(state.steps.a.status, 'pending')
  assert.equal(state.steps.a.outputs, null)
  assert.equal(state.status, 'running')
  assert.equal(r.route.prevOutputs.includes('A1'), true)
})

test('Given 非等待态裁决回写 When applyExternalVerdict Then 不受理', () => {
  const plan = approvePlan()
  const script = scriptViewOf(APPROVE_TPL, plan)
  const state = init(APPROVE_TPL, plan)
  const r = applyExternalVerdict(state, script, APPROVE_TPL.steps[2], { verdict: 'APPROVED', comments: '' }, {})
  assert.equal(r.applied, false)
})

test('Given waiting_payload When 组装 Then 负载含 stepId/target 产出/待裁决口径/轮次', () => {
  const plan = approvePlan()
  const script = scriptViewOf(APPROVE_TPL, plan)
  const state = init(APPROVE_TPL, plan)
  state.status = 'waiting_approval'
  state.steps.a.status = 'done'
  state.steps.a.outputs = { o: 'A-OUT' }
  state.approvals.rev = { rounds: 1, lastComments: '上轮意见' }
  const payload = waitingPayload({ runId: 'r-1', state, script, planStepOf: new Map([['rev', { ref: 'rev', note: '审要点', done: '审口径' }]]), approveStep: APPROVE_TPL.steps[2] })
  assert.equal(payload.kind, 'waiting')
  assert.equal(payload.runId, 'r-1')
  assert.equal(payload.waiting.stepId, 'rev')
  assert.deepEqual(payload.waiting.target.outputs, { o: 'A-OUT' })
  assert.equal(payload.waiting.brief, '审口径')
  assert.equal(payload.waiting.comments, '上轮意见')
  assert.equal(payload.waiting.rounds, 1)
})

test('Given 升级步在剧本且 escalateReady When 常规判定 Then 升级步就绪派发', () => {
  const plan = approvePlan()
  const script = scriptViewOf(APPROVE_TPL, plan)
  const state = init(APPROVE_TPL, plan)
  state.steps.a.status = 'skipped'
  state.steps.down.status = 'skipped'
  state.steps.rev.status = 'done'
  state.steps.esc.status = 'pending'
  state.steps.esc.escalateReady = true
  const batch = nextBatch(state, script)
  assert.deepEqual(batch.calls.map((c) => c.stepId), ['esc'])
})

test('Given onExhausted=blocked When 耗尽 Then terminalBlocked 置位', () => {
  const tpl = {
    id: 't', label: 't',
    steps: [
      { id: 'a', prompt: 'P', outputs: { o: 'o' } },
      { id: 'rev', type: 'approve', target: 'a', onExhausted: 'blocked', prompt: 'R' },
    ],
  }
  const plan = fullPlan(['a', 'rev'])
  const script = scriptViewOf(tpl, plan)
  const state = init(tpl, plan)
  state.approvals.rev = { rounds: 3 }
  state.steps.rev.status = 'done'
  const route = applyApproveResult(state, script, tpl.steps[1], { outputs: { verdict: 'REJECTED', comments: '' } }, { approveRounds: 2, escalateLimit: 2 })
  assert.equal(route.routedTo, 'blocked')
  assert.equal(state.terminalBlocked.includes('耗尽'), true)
})

test('Given upgrades 达 escalateLimit When 耗尽升级 Then escalateLimitReached', () => {
  const plan = approvePlan()
  const script = scriptViewOf(APPROVE_TPL, plan)
  const state = init(APPROVE_TPL, plan)
  state.escalations = 1
  state.approvals.rev = { rounds: 9 }
  state.steps.rev.status = 'done'
  const route = applyApproveResult(state, script, APPROVE_TPL.steps[2], { outputs: { verdict: 'REJECTED', comments: '' } }, { approveRounds: 1, escalateLimit: 2 })
  assert.equal(state.escalations, 2)
  assert.equal(route.escalateLimitReached, true)
})

// ── prompts 剧本注入(v5) ─────────────────────────────────────────────────
test('Given 占位符 When 解析 Then request/input/step 输出/item/自引用空串', () => {
  const state = { steps: { a: { status: 'done', outputs: { o: 'OUT', list: ['x', 'y'] } } } }
  const ctx = { state, request: 'REQ', inputs: { topic: 'T' } }
  assert.equal(resolvePlaceholders('需求:{request} 主题:{input.topic} 产出:{a.o} 列表:{a.list}', ctx), '需求:REQ 主题:T 产出:OUT 列表:x\ny')
  assert.equal(resolvePlaceholders('自引:{b.o}', { ...ctx, selfId: 'b', carry: null }), '自引:')
  assert.equal(resolvePlaceholders('项:{item} 序:{item.index}', { ...ctx, item: '甲', index: 2 }), '项:甲 序:2')
})

test('Given 剧本 note/done When 组装 Then [任务要点] 在任务后且 done 以本任务口径追加', () => {
  const step = { id: 'a', prompt: '做:{request}', outputs: { o: '产出说明' } }
  const prompt = buildPrompt({
    state: { steps: {} }, request: 'R', inputs: {}, step,
    planStep: { ref: 'a', note: '先列清单再执行', done: '清单覆盖全部条目' },
  })
  const idxTask = prompt.indexOf('[任务]')
  const idxNote = prompt.indexOf('[任务要点]')
  const idxOut = prompt.indexOf('[产出要求]')
  assert.ok(idxTask >= 0 && idxNote > idxTask && idxOut > idxNote)
  assert.ok(prompt.includes('先列清单再执行'))
  assert.ok(prompt.includes('本任务口径:清单覆盖全部条目'))
  assert.ok(prompt.trim().endsWith('本任务口径:清单覆盖全部条目'))
})

test('Given fallback 剧本(无 planStep) When 组装 Then 无注入节', () => {
  const step = { id: 'a', prompt: '做:{request}', outputs: { o: '产出说明' } }
  const prompt = buildPrompt({ state: { steps: {} }, request: 'R', inputs: {}, step })
  assert.equal(prompt.includes('[任务要点]'), false)
  assert.equal(prompt.includes('本任务口径:'), false)
})

test('Given 指令组装 When 各节存在 Then 节顺序固定', () => {
  const step = { id: 'a', prompt: '做:{request}', outputs: { o: '产出说明' }, load: ['skill:web-search'] }
  const prompt = buildPrompt({
    state: { steps: {} }, request: 'R', inputs: {}, step,
    queuedMessages: ['排队消息'], injectMessages: ['注入消息'], redo: { comments: '改好点', prevOutputs: '旧产出' },
  })
  const order = ['[任务]', '[产出要求]', '[参考资料]', '[用户补充]', '[运行中用户消息]', '[重做说明]']
  const idx = order.map((s) => prompt.indexOf(s))
  assert.ok(idx.every((v) => v >= 0))
  assert.deepEqual(idx, [...idx].sort((a, b) => a - b))
  assert.ok(prompt.includes('structured_output'))
  assert.ok(prompt.includes('web-search'))
  assert.ok(prompt.includes('改好点'))
})

test('Given approve 步 When schemaOf Then 固定裁决契约', () => {
  const schema = schemaOf({ type: 'approve' })
  assert.deepEqual(schema.required, ['verdict', 'comments'])
})

// ── RunDriver 段推进(v5) ──────────────────────────────────────────────────
const fakeEngine = (resultsByCall) => ({
  start({ args }) {
    return {
      result: Promise.resolve({
        results: args.calls.map((c) => resultsByCall(c)),
      }),
    }
  },
})

const makeDriver = ({ template, plan, engineResults }) => {
  const driver = new RunDriver({
    template, plan, runId: 'r-test-1', request: '需求', engine: fakeEngine(engineResults),
    store: memoryStore(), budgets: { approveRounds: 2, escalateLimit: 2, maxStepFail: 2 },
  })
  return driver
}

const memoryStore = () => {
  const records = new Map()
  return {
    start: (r) => { records.set(r.runId, { ...r, controls: [], stepsTrace: {}, queued: [] }) },
    step: ({ runId, stepId, event, body }) => {
      const rec = records.get(runId)
      if (event === 'control') rec.controls.push(body)
      else {
        rec.stepsTrace[stepId] ??= {}
        ;(rec.stepsTrace[stepId]['-'] ??= []).push({ event, ...body })
      }
    },
    update: ({ runId, state, status, queued, waiting }) => {
      const rec = records.get(runId)
      if (state !== undefined) rec.state = state
      if (status !== undefined) rec.status = status
      if (queued !== undefined) rec.queued = queued
      if (waiting !== undefined) rec.waiting = waiting ?? undefined
    },
    finish: ({ runId, status, summary }) => { const rec = records.get(runId); rec.status = status; rec.summary = summary },
    get: (runId) => records.get(runId),
  }
}

const SINGLE = {
  id: 't', label: 't',
  steps: [{ id: 'only', prompt: 'P {request}', outputs: { o: '产出' } }],
}

test('Given 单步剧本 When runSegment Then 推进至终态返回 terminal 负载', async () => {
  const plan = fullPlan(['only'])
  const driver = makeDriver({ template: SINGLE, plan, engineResults: (c) => ({ callId: c.callId, ok: true, outputs: { o: 'OUT' } }) })
  driver.startPersist()
  const payload = await driver.runSegment()
  assert.equal(payload.kind, 'terminal')
  assert.equal(driver.state.status, 'completed')
  assert.deepEqual(payload.outputsIndex.only, { o: 'OUT' })
})

test('Given 含审批步剧本 When runSegment Then 段以 waiting settle 且状态 waiting_approval', async () => {
  const plan = fullPlan(['a', 'down', 'rev', 'esc'])
  const driver = makeDriver({
    template: APPROVE_TPL, plan,
    engineResults: (c) => ({ callId: c.callId, ok: true, outputs: c.label.startsWith('down') ? { o: 'D' } : { o: 'A' } }),
  })
  driver.startPersist()
  const payload = await driver.runSegment()
  assert.equal(payload.kind, 'waiting')
  assert.equal(payload.waiting.stepId, 'rev')
  assert.equal(driver.state.status, 'waiting_approval')
  // 待裁决摘要落盘:页签 /run 路由据此渲染
  assert.deepEqual(driver.store.get('r-test-1').waiting, payload.waiting)
  // 裁决应用后摘要清除
  driver.handlePost({ kind: 'approve', by: 'user' })
  assert.equal(driver.store.get('r-test-1').waiting, undefined)
})

test('Given waiting_approval When 裁决回写 APPROVED 再 runSegment Then 推进至终态', async () => {
  const plan = fullPlan(['a', 'down', 'rev', 'esc'])
  const driver = makeDriver({
    template: APPROVE_TPL, plan,
    engineResults: (c) => ({ callId: c.callId, ok: true, outputs: c.label.startsWith('down') ? { o: 'D2' } : { o: 'A' } }),
  })
  driver.startPersist()
  await driver.runSegment()
  const applied = driver.handlePost({ kind: 'approve', by: 'user' })
  assert.equal(applied, true)
  assert.equal(driver.state.status, 'running')
  const payload = await driver.runSegment()
  assert.equal(payload.kind, 'terminal')
  assert.equal(driver.state.status, 'completed')
})

test('Given waiting_approval When handlePost reject Then 重做说明置位且状态 running', async () => {
  const plan = fullPlan(['a', 'down', 'rev', 'esc'])
  const driver = makeDriver({
    template: APPROVE_TPL, plan,
    engineResults: (c) => ({ callId: c.callId, ok: true, outputs: { o: 'X' } }),
  })
  driver.startPersist()
  await driver.runSegment()
  driver.handlePost({ kind: 'reject', by: 'main-agent', reason: '口径未达' })
  assert.equal(driver.state.status, 'running')
  assert.ok(driver.state.redoInfo.a, JSON.stringify(driver.state.redoInfo))
  assert.equal(driver.state.approvals.rev.rounds, 1)
})

test('Given running 段中 pause When runSegment 收敛 Then 段以 paused settle', async () => {
  const plan = fullPlan(['a', 'down', 'rev', 'esc'])
  const driver = makeDriver({
    template: APPROVE_TPL, plan,
    engineResults: (c) => { driver.pause(); return { callId: c.callId, ok: true, outputs: { o: 'A' } } },
  })
  driver.startPersist()
  const payload = await driver.runSegment()
  assert.equal(payload.kind, 'paused')
  assert.equal(driver.state.status, 'paused')
})

test('Given paused When tabResume+裁决入队 When resume 段首 Then 裁决生效', async () => {
  const plan = fullPlan(['a', 'down', 'rev', 'esc'])
  const driver = makeDriver({
    template: APPROVE_TPL, plan,
    engineResults: (c) => ({ callId: c.callId, ok: true, outputs: { o: 'A' } }),
  })
  driver.startPersist()
  await driver.runSegment()
  // 进入 waiting 后暂停(互斥转换),再回写裁决 → 入队
  driver.pause()
  assert.equal(driver.state.status, 'paused')
  driver.tabResume()
  assert.equal(driver.awaitingResume, true)
  const accepted = driver.handlePost({ kind: 'approve', by: 'user' })
  assert.equal(accepted, true)
  assert.equal(driver.state.status, 'paused')
  // 主循环 resume:翻 running + 段首应用入队裁决
  driver.state.status = 'running'
  const payload = await driver.runSegment()
  assert.equal(payload.kind, 'terminal')
  assert.equal(driver.state.status, 'completed')
})

test('Given 已标记恢复意图 When 再次 pause Then 撤销恢复意图(防陈旧标记催 resume)', async () => {
  const plan = fullPlan(['a', 'down', 'rev', 'esc'])
  const driver = makeDriver({
    template: APPROVE_TPL, plan,
    engineResults: (c) => ({ callId: c.callId, ok: true, outputs: { o: 'A' } }),
  })
  driver.startPersist()
  await driver.runSegment()
  driver.pause()
  driver.tabResume()
  assert.equal(driver.awaitingResume, true)
  // 用户改主意再暂停:恢复意图必须被撤销,否则守门按陈旧标记持续判欠 resume
  driver.pause()
  assert.equal(driver.state.status, 'paused')
  assert.equal(driver.awaitingResume, false)
})

test('Given waiting_approval(无活跃段) When cancel Then 即时终态 cancelled', () => {
  const plan = fullPlan(['a', 'down', 'rev', 'esc'])
  const driver = makeDriver({ template: APPROVE_TPL, plan, engineResults: () => ({ callId: 'x', ok: true, outputs: {} }) })
  driver.startPersist()
  driver.state.status = 'waiting_approval'
  driver.state.waitingApproval = 'rev'
  driver.cancel()
  assert.equal(driver.state.status, 'cancelled')
  assert.equal(driver.finished, true)
})

test('Given paused(无活跃段) When cancel Then 即时终态 cancelled 而非滞留', () => {
  const plan = fullPlan(['a', 'down', 'rev', 'esc'])
  const driver = makeDriver({ template: APPROVE_TPL, plan, engineResults: () => ({ callId: 'x', ok: true, outputs: {} }) })
  driver.startPersist()
  driver.state.status = 'paused'
  driver.cancel()
  assert.equal(driver.state.status, 'cancelled')
  assert.equal(driver.finished, true)
  assert.equal(driver.controller.signal.aborted, false)
})

// ── 纠偏注入边界链(v5):handlePost 记账 → 段边界 drainControls → 下段 prompt 注入 ──
// 段边界 = 审批到达/暂停/终态;纠偏在下一段 runSegment 的 drainControls 生效。
// 可观测的下段 = REJECTED 后的重做段(通过时无重做,审批链即收敛终态)。

test('Given waiting 段收到 inject 纠偏 When REJECTED 后下段重做 Then 重做 prompt 含[运行中用户消息]', async () => {
  const plan = fullPlan(['a', 'down', 'rev', 'esc'])
  const promptsSeen = []
  const driver = new RunDriver({
    template: APPROVE_TPL, plan, runId: 'r-inject-2', request: '需求',
    engine: {
      start({ args }) {
        promptsSeen.push(...args.calls.map((c) => ({ label: c.label, prompt: c.prompt })))
        return { result: Promise.resolve({ results: args.calls.map((c) => ({ callId: c.callId, ok: true, outputs: { o: 'OUT' } })) }) }
      },
    },
    store: memoryStore(), budgets: { approveRounds: 2, escalateLimit: 2, maxStepFail: 2 },
  })
  driver.startPersist()
  await driver.runSegment()
  assert.equal(driver.state.status, 'waiting_approval')
  // waiting 期间用户纠偏(注入式)
  const accepted = driver.handlePost({ kind: 'message', text: '口径改为一行', inject: true })
  assert.equal(accepted, true)
  driver.handlePost({ kind: 'reject', by: 'user', reason: '口径未达' })
  const payload = await driver.runSegment()
  assert.equal(payload.kind, 'waiting')
  const redoA = promptsSeen.filter((p) => p.label.startsWith('a'))[1]
  assert.ok(redoA, JSON.stringify(promptsSeen.map((p) => p.label)))
  assert.ok(redoA.prompt.includes('[运行中用户消息]'), redoA.prompt)
  assert.ok(redoA.prompt.includes('口径改为一行'))
  assert.equal(redoA.prompt.includes('[用户补充]'), false)
})

test('Given 非注入纠偏 When REJECTED 后下段重做 Then 重做 prompt 含[用户补充]且不含[运行中用户消息]', async () => {
  const plan = fullPlan(['a', 'down', 'rev', 'esc'])
  const promptsSeen = []
  const driver = new RunDriver({
    template: APPROVE_TPL, plan, runId: 'r-queue-1', request: '需求',
    engine: {
      start({ args }) {
        promptsSeen.push(...args.calls.map((c) => ({ label: c.label, prompt: c.prompt })))
        return { result: Promise.resolve({ results: args.calls.map((c) => ({ callId: c.callId, ok: true, outputs: { o: 'OUT' } })) }) }
      },
    },
    store: memoryStore(), budgets: { approveRounds: 2, escalateLimit: 2, maxStepFail: 2 },
  })
  driver.startPersist()
  await driver.runSegment()
  driver.handlePost({ kind: 'message', text: '补充一点', inject: false })
  driver.handlePost({ kind: 'reject', by: 'user', reason: '口径未达' })
  await driver.runSegment()
  const redoA = promptsSeen.filter((p) => p.label.startsWith('a'))[1]
  assert.ok(redoA.prompt.includes('[用户补充]'), redoA.prompt)
  assert.ok(redoA.prompt.includes('补充一点'))
  assert.equal(redoA.prompt.includes('[运行中用户消息]'), false)
})

test('Given 终态 run When handlePost message Then 不受理', async () => {
  const plan = fullPlan(['a', 'down', 'rev', 'esc'])
  const driver = new RunDriver({
    template: APPROVE_TPL, plan, runId: 'r-final-1', request: '需求',
    engine: {
      start({ args }) {
        return { result: Promise.resolve({ results: args.calls.map((c) => ({ callId: c.callId, ok: true, outputs: { o: 'OUT' } })) }) }
      },
    },
    store: memoryStore(), budgets: { approveRounds: 2, escalateLimit: 2, maxStepFail: 2 },
  })
  driver.startPersist()
  await driver.runSegment()
  driver.handlePost({ kind: 'approve', by: 'user' })
  const payload = await driver.runSegment()
  assert.equal(payload.kind, 'terminal')
  const accepted = driver.handlePost({ kind: 'message', text: '晚了', inject: true })
  assert.equal(accepted, false)
})

test('Given 批次运行期纠偏随后到审批边界 When reject 后重做批 Then prompt 含[运行中用户消息](边界不丢)', async () => {
  const plan = fullPlan(['a', 'down', 'rev', 'esc'])
  const promptsSeen = []
  let driver
  driver = new RunDriver({
    template: APPROVE_TPL, plan, runId: 'r-inject-3', request: '需求',
    engine: {
      start({ args }) {
        promptsSeen.push(...args.calls.map((c) => ({ label: c.label, prompt: c.prompt })))
        // 首批(a+down)运行期用户纠偏:游标未消费,须穿过 approve 边界存活
        driver.handlePost({ kind: 'message', text: '运行期纠偏', inject: true })
        return { result: Promise.resolve({ results: args.calls.map((c) => ({ callId: c.callId, ok: true, outputs: { o: 'OUT' } })) }) }
      },
    },
    store: memoryStore(), budgets: { approveRounds: 2, escalateLimit: 2, maxStepFail: 2 },
  })
  driver.startPersist()
  await driver.runSegment()
  assert.equal(driver.state.status, 'waiting_approval')
  driver.handlePost({ kind: 'reject', by: 'user', reason: '口径未达' })
  await driver.runSegment()
  const redoA = promptsSeen.filter((p) => p.label.startsWith('a'))[1]
  assert.ok(redoA, JSON.stringify(promptsSeen.map((p) => p.label)))
  assert.ok(redoA.prompt.includes('[运行中用户消息]'), redoA.prompt)
  assert.ok(redoA.prompt.includes('运行期纠偏'))
})

test('Given 超过120字注入纠偏 When 消费 Then prompt 含全文(queued 为权威,controls 只留摘要)', async () => {
  const plan = fullPlan(['a', 'down', 'rev', 'esc'])
  const longText = '长'.repeat(300) + 'END'
  const promptsSeen = []
  let driver
  driver = new RunDriver({
    template: APPROVE_TPL, plan, runId: 'r-inject-4', request: '需求',
    engine: {
      start({ args }) {
        promptsSeen.push(...args.calls.map((c) => ({ label: c.label, prompt: c.prompt })))
        driver.handlePost({ kind: 'message', text: longText, inject: true })
        return { result: Promise.resolve({ results: args.calls.map((c) => ({ callId: c.callId, ok: true, outputs: { o: 'OUT' } })) }) }
      },
    },
    store: memoryStore(), budgets: { approveRounds: 2, escalateLimit: 2, maxStepFail: 2 },
  })
  driver.startPersist()
  await driver.runSegment()
  driver.handlePost({ kind: 'reject', by: 'user', reason: '口径未达' })
  await driver.runSegment()
  const redoA = promptsSeen.filter((p) => p.label.startsWith('a'))[1]
  assert.ok(redoA.prompt.includes(longText), '注入内容须为全文')
})

test('Given paused 期间同一审批步两次裁决 When resume Then 第二条不受理(先到先得)', async () => {
  const plan = fullPlan(['a', 'down', 'rev', 'esc'])
  const driver = makeDriver({ template: APPROVE_TPL, plan, engineResults: (c) => ({ callId: c.callId, ok: true, outputs: { o: 'OUT' } }) })
  driver.startPersist()
  await driver.runSegment()
  driver.pause()
  driver.handlePost({ kind: 'reject', by: 'user', reason: '第一次' })
  const second = driver.handlePost({ kind: 'approve', by: 'main-agent' })
  assert.equal(second, false)
  assert.equal(driver.state.pendingApprovals.length, 1)
})

test('Given 子流程状态 When collectSubOutputs Then 普通步取首产出,for_each 步收编实例数组', () => {
  const sub = {
    id: 'sub', label: 'sub',
    steps: [
      { id: 'plan', prompt: 'P', outputs: { items: '列表' }, listOutputs: ['items'] },
      { id: 'write', for_each: 'plan.items', prompt: '{item}', outputs: { line: '行' } },
      { id: 'void', prompt: 'V', outputs: { x: 'x' } },
    ],
  }
  const subState = {
    steps: {
      plan: { status: 'done', outputs: { items: ['甲', '乙'] }, instances: [] },
      write: {
        status: 'done', outputs: null,
        instances: [
          { key: '#1', status: 'done', outputs: { line: '甲行' } },
          { key: '#2', status: 'done', outputs: { line: '乙行' } },
        ],
      },
      void: { status: 'skipped', outputs: null, instances: [] },
    },
  }
  const out = collectSubOutputs(sub, subState)
  assert.deepEqual(out['plan.items'], ['甲', '乙'])
  assert.deepEqual(out['write.line'], ['甲行', '乙行'])
  assert.equal('void.x' in out, false)
})

// ── 审计回归:runner 记账 / dispose / buildSeed 对齐 / drain 收口 ─────────────

test('Given stopReason 非 completed When runSegment Then 全批失败入账且 dispose 被调', async () => {
  let disposed = 0
  const plan = fullPlan(['only'])
  const engine = {
    start() {
      return { result: Promise.resolve({ value: null, stopReason: 'error', error: '引擎炸了' }), dispose: async () => { disposed += 1 } }
    },
  }
  const driver = new RunDriver({
    template: SINGLE, plan, runId: 'r-stop-1', request: '需求', engine,
    store: memoryStore(), budgets: { approveRounds: 2, escalateLimit: 2, maxStepFail: 2 },
  })
  driver.startPersist()
  await driver.runSegment()
  // stopReason 分支也须逐 call 记账(否则步骤滞留 running,调度 idle 死循环);
  // 全批失败重试至上限(maxStepFail=2)后步骤 failed,run 收敛 failed;
  // 每个批次(首跑+重试)结束都 dispose,无泄漏
  assert.equal(disposed, 2)
  assert.notEqual(driver.state.status, 'running')
  assert.equal(driver.state.steps.only.failCount, 2)
  assert.equal(driver.state.steps.only.status, 'failed')
})

test('Given engine.start 同步抛 When runSegment Then run 为空不崩,按引擎异常记账', async () => {
  const engine = { start() { throw new Error('start 即抛') } }
  const plan = fullPlan(['only'])
  const driver = new RunDriver({
    template: SINGLE, plan, runId: 'r-stop-2', request: '需求', engine,
    store: memoryStore(), budgets: { approveRounds: 2, escalateLimit: 2, maxStepFail: 2 },
  })
  driver.startPersist()
  await driver.runSegment()
  assert.notEqual(driver.state.status, 'running')
})

test('Given 引擎无 dispose(桩缺省) When runSegment Then 不抛(可选链容忍)', async () => {
  const engine = { start() { return { result: Promise.resolve({ results: [] }) } } }
  const plan = fullPlan(['only'])
  const driver = new RunDriver({
    template: SINGLE, plan, runId: 'r-stop-3', request: '需求', engine,
    store: memoryStore(), budgets: { approveRounds: 2, escalateLimit: 2, maxStepFail: 2 },
  })
  driver.startPersist()
  const payload = await driver.runSegment()
  assert.equal(payload.kind, 'terminal')
})

test('Given 有 controlSeq 与步级 escalateReady 的终态记录 When buildSeed Then 计数归零且逐步清标志', () => {
  const record = {
    runId: 'r-old', templateId: 't', request: '需求', inputs: { a: 'x' },
    plan: { steps: [{ ref: 'only', note: '', done: '' }] },
    state: {
      status: 'blocked', controlSeq: 5, escalateLimitReached: true, terminalBlocked: true,
      steps: { only: { status: 'done', outputs: { o: 'OUT' }, failCount: 0, escalateReady: true } },
    },
    controls: [{ seq: 1 }, { seq: 2 }],
  }
  const seed = buildSeed(record, record.plan, undefined, undefined)
  // 续跑生成全新 store 记录(controls 空),沿用旧计数会吞掉新记录前缀消息
  assert.equal(seed.controlSeq, 0)
  // escalateReady 是步级标记,顶层清零无效
  assert.equal(seed.steps.only.escalateReady, false)
  assert.equal(seed.escalateLimitReached, false)
})

test('Given pause 期裁决已入队且 waitingApproval 残留 When drain Then 收口(防幽灵 redo)', () => {
  const plan = fullPlan(['a', 'down', 'rev', 'esc'])
  const driver = makeDriver({
    template: APPROVE_TPL, plan,
    engineResults: (c) => ({ callId: c.callId, ok: true, outputs: { o: 'A' } }),
  })
  driver.startPersist()
  // 构造残留现场:waitingApproval 指向已收口审批步 + 入队裁决
  driver.state.status = 'running'
  driver.state.waitingApproval = 'rev'
  driver.state.pendingApprovals = [{ stepId: 'rev', verdict: 'REJECTED', comments: '重做' }]
  driver.drainPendingApprovals()
  // drain 应用后若残留 waitingApproval,下次 pause+裁决会对非等待步幽灵生效
  assert.equal(driver.state.waitingApproval, undefined)
  assert.equal(driver.state.pendingApprovals.length, 0)
})
