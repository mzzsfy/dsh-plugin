// orchestrator 工具行 BDD(v5):start 受理/拒单计数/status/resume 拉段/cancel 幂等/message 受理
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { registerOrchestrator, enabledTemplates } from '../lib/orchestrator.mjs'
import { MAX_NUDGE } from '../lib/guard.mjs'
import { saveJson } from '../lib/storage.mjs'
import { reportStore } from '../lib/store.mjs'
import { registry } from '../lib/driver/control.mjs'

// 隔离数据目录(须在首次 store 访问前设置)
const dataRoot = mkdtempSync(join(tmpdir(), 'rsww-orch-'))
process.env.DSH_RS_WORKFLOW_DATA_DIR = dataRoot

const TEMPLATE = {
  id: 'default', label: '通用默认', description: '评估需求后拆解执行、审查修正、交付汇总的通用流程。',
  steps: [
    { id: 'triage', label: 'triage', prompt: '评估 {request}', outputs: { brief: '简报' } },
    { id: 'execute', label: 'execute', after: ['triage'], prompt: '按 {triage.brief} 执行', outputs: { result: '结果' } },
    { id: 'review', label: 'review', type: 'approve', after: ['execute'], target: 'execute', onExhausted: 'blocked', prompt: '审查' },
    { id: 'deliver', label: 'deliver', after: ['review'], prompt: '汇总 {execute.result}', outputs: { report: '交付' } },
  ],
}
saveJson('templates.json', [{ id: 'default', label: '通用默认', description: '', enabled: true, json: JSON.stringify(TEMPLATE) }])
saveJson('config.json', {})

// 等待 run 到达期望状态(轮询 store,上限 5s)
async function waitStatus(runId, expect, ms = 5000) {
  const deadline = Date.now() + ms
  for (;;) {
    const record = reportStore().get(runId)
    if (record !== undefined && (expect.has(record.status) || record.finishedAt !== undefined)) return record
    if (Date.now() > deadline) throw new Error(`等待状态超时: 期望 ${[...expect].join('|')} 实际 ${record?.status}`)
    await new Promise((r) => setTimeout(r, 20))
  }
}

const fakeEngine = () => ({
  start({ args }) {
    return { result: Promise.resolve({ results: args.calls.map((c) => ({ callId: c.callId, ok: true, outputs: { brief: 'b', result: 'r', report: 'p' } })) }) }
  },
})

const registered = []
let currentJobs = []

function setup() {
  registered.length = 0
  currentJobs = []
  const handlers = new Map()
  const ctx = {
    logger: { info: () => {}, warn: () => {} },
    // 事件面:捕获守门监听器供契约级断言(真宿主按 scope 投递,此处只验监听器行为)
    on(name, fn) { handlers.set(name, fn) },
    inject(names, fn) {
      const tctx = {
        workflowEngine: fakeEngine(),
        jobs: {
          start(spec) {
            const hooks = spec.run()
            currentJobs.push(hooks)
            return `rsww-segment-${currentJobs.length}`
          },
        },
        tools: { register: (t) => registered.push(t) },
        effect: (reg) => reg(),
      }
      fn(tctx)
    },
  }
  registerOrchestrator(ctx, { templateId: 'default' })
  const tool = (name) => registered.find((t) => t.name === name)
  const agent = { id: `agent-${setup.seq = (setup.seq ?? 0) + 1}` }
  const exec = { agent, signal: { throwIfAborted: () => {}, aborted: false } }
  return { start: tool('rs_workflow_start'), status: tool('rs_workflow_status'), resume: tool('rs_workflow_resume'), cancel: tool('rs_workflow_cancel'), message: tool('rs_workflow_message'), verdict: tool('rs_workflow_verdict'), resumeFrom: tool('rs_workflow_resume_from'), agent, exec, handler: (name) => handlers.get(name) }
}

const fullPlan = (brief = '口径', refs = ['triage', 'execute', 'review', 'deliver']) => ({
  brief,
  steps: refs.map((ref) => ({ ref, note: `${ref} 要点`, done: `${ref} 口径` })),
})

test('Given 合法 plan When rs_workflow_start Then 受理返回 runId 且首段 job 启动', async () => {
  const { start, exec } = setup()
  const r = await start.execute({ request: '整理仓库', templateId: 'default', inputs: {}, plan: fullPlan() }, exec)
  assert.equal(r.ok, true)
  assert.equal(r.status, 'running')
  assert.match(r.runId, /^r-/)
  assert.equal(currentJobs.length, 1)
  const record = reportStore().get(r.runId)
  assert.equal(record.status, 'running')
  assert.equal(record.plan.source, 'model')
})

test('Given 非法 ref When start 三连 Then 逐次 errors 且第 3 次起恒失败', async () => {
  const { start, exec } = setup()
  const bad = () => fullPlan('口径', ['triage', 'ghost'])
  const r1 = await start.execute({ request: 'x', templateId: 'default', plan: bad() }, exec)
  assert.equal(r1.ok, false)
  assert.ok(Array.isArray(r1.errors) && r1.errors.length > 0)
  const r2 = await start.execute({ request: 'x', templateId: 'default', plan: bad() }, exec)
  assert.equal(r2.ok, false)
  const r3 = await start.execute({ request: 'x', templateId: 'default', plan: bad() }, exec)
  assert.equal(r3.ok, false)
  assert.ok(r3.hint.includes('回退'))
  const r4 = await start.execute({ request: 'x', templateId: 'default', plan: fullPlan() }, exec)
  assert.equal(r4.ok, false)
  assert.ok(r4.hint.includes('编排入口关闭'))
})

test('Given templateId 与锚定不符 When start Then 拒单', async () => {
  const { start, exec } = setup()
  const r = await start.execute({ request: 'x', templateId: 'novel', plan: fullPlan() }, exec)
  assert.equal(r.ok, false)
  assert.ok(r.errors.some((e) => String(e.message).includes('锚定') || String(e.message).includes('不存在')))
})

test('Given 编排推进到 waiting_approval When status Then waiting 摘要与轮次可见', async () => {
  const { start, status, exec } = setup()
  const r = await start.execute({ request: '整理仓库', templateId: 'default', plan: fullPlan() }, exec)
  const record = await waitStatus(r.runId, new Set(['waiting_approval']))
  assert.equal(record.status, 'waiting_approval')
  const s = await status.execute({ runId: r.runId }, exec)
  assert.equal(s.status, 'waiting_approval')
  assert.equal(s.waiting[0].stepId, 'review')
  assert.equal(s.steps.execute.status, 'done')
})

test('Given 裁决后 resume When 段推进 Then 至终态', async () => {
  const { start, status, resume, exec } = setup()
  const r = await start.execute({ request: '整理仓库', templateId: 'default', plan: fullPlan() }, exec)
  await waitStatus(r.runId, new Set(['waiting_approval']))
  const driver = registry.drivers.get(r.runId)
  driver.handlePost({ kind: 'approve', by: 'user' })
  const resumed = await resume.execute({ runId: r.runId }, exec)
  assert.equal(resumed.ok, true)
  const record = await waitStatus(r.runId, new Set(['completed', 'failed', 'blocked']))
  assert.equal(record.status, 'completed')
  const s = await status.execute({ runId: r.runId }, exec)
  assert.equal(s.status, 'completed')
})

test('Given paused When tabResume 后 resume Then 翻 running 并拉段', async () => {
  const { start, resume, exec } = setup()
  const r = await start.execute({ request: '整理仓库', templateId: 'default', plan: fullPlan() }, exec)
  await waitStatus(r.runId, new Set(['waiting_approval']))
  const driver = registry.drivers.get(r.runId)
  driver.pause()
  driver.tabResume()
  const resumed = await resume.execute({ runId: r.runId }, exec)
  assert.equal(resumed.ok, true)
  assert.equal(driver.state.status, 'running')
})

test('Given 活跃段在跑 When resume Then skipped 不重复拉起', async () => {
  const { start, resume, exec } = setup()
  const r = await start.execute({ request: '整理仓库', templateId: 'default', plan: fullPlan() }, exec)
  const driver = registry.drivers.get(r.runId)
  const resumed = await resume.execute({ runId: r.runId }, exec)
  assert.equal(resumed.skipped, true)
  driver.cancel()
})

test('Given running When cancel 两次 Then 第一次收敛终态第二次幂等', async () => {
  const { start, cancel, exec } = setup()
  const r = await start.execute({ request: '整理仓库', templateId: 'default', plan: fullPlan() }, exec)
  const c1 = await cancel.execute({ runId: r.runId }, exec)
  assert.equal(c1.ok, true)
  const c2 = await cancel.execute({ runId: r.runId }, exec)
  assert.equal(c2.ok, true)
  assert.equal(c2.status, 'cancelled')
})

test('Given waiting_approval When message Then 受理入队', async () => {
  const { start, message, exec } = setup()
  const r = await start.execute({ request: '整理仓库', templateId: 'default', plan: fullPlan() }, exec)
  await waitStatus(r.runId, new Set(['waiting_approval']))
  const m = await message.execute({ runId: r.runId, text: '补充口径', inject: true }, exec)
  assert.equal(m.ok, true)
})

test('Given enabledTemplates When 读取 Then 返回 gate 形态(entry+parsed)', () => {
  const list = enabledTemplates()
  assert.equal(list.length, 1)
  assert.equal(list[0].entry.id, 'default')
  assert.equal(list[0].parsed.steps.length, 4)
})

test('Given verdict When approve 缺 reason Then 拒(审计必填)', async () => {
  const { start, verdict, exec } = setup()
  const r0 = await start.execute({ request: '整理仓库', templateId: 'default', inputs: {}, plan: fullPlan() }, exec)
  const runId = r0.runId
  await waitStatus(runId, new Set(['waiting_approval', 'completed']))
  const v = await verdict.execute({ runId, verdict: 'approve', reason: '  ' }, exec)
  assert.equal(v.ok, false)
  assert.ok(v.error.includes('reason'))
})

test('Given waiting run When verdict reject(by=user) Then 受理且 redoInfo 生效', async () => {
  const { start, verdict, resume, exec } = setup()
  const r0 = await start.execute({ request: '整理仓库', templateId: 'default', inputs: {}, plan: fullPlan() }, exec)
  const runId = r0.runId
  const record = await waitStatus(runId, new Set(['waiting_approval']))
  assert.equal(record.status, 'waiting_approval')
  const v = await verdict.execute({ runId, verdict: 'reject', reason: '口径未达', by: 'user' }, exec)
  assert.equal(v.ok, true)
  await resume.execute({ runId }, exec)
  const after = reportStore().get(runId)
  assert.equal(after.controls.some((c) => c.kind === 'reject' && c.by === 'user' && c.reason === '口径未达'), true)
})

test('Given 页签先裁 When verdict 后到 Then 不重复裁决且代拉下一段', async () => {
  const { start, verdict, exec } = setup()
  const r0 = await start.execute({ request: '整理仓库', templateId: 'default', inputs: {}, plan: fullPlan() }, exec)
  const runId = r0.runId
  await waitStatus(runId, new Set(['waiting_approval']))
  registry.drivers.get(runId).handlePost({ kind: 'approve', by: 'user' })
  const v = await verdict.execute({ runId, verdict: 'approve', reason: '后到' }, exec)
  // 竞态契约(5d4e996):后到裁决不受理,但 run 已被页签翻 running 且无活跃段时,
  // 主循环代拉下一段(推进责任唯一在主循环),返回 ok:true + hint 说明先到先得
  assert.equal(v.ok, true)
  assert.ok(String(v.hint).includes('先裁'))
  assert.equal(v.status, 'running')
})

test('Given verdict When verdict 非法枚举 Then 拒', async () => {
  const { verdict, exec } = setup()
  const v = await verdict.execute({ runId: 'r-x', verdict: 'maybe', reason: 'r' }, exec)
  assert.equal(v.ok, false)
})

test('Given 终态 run When resume_from Then 种子新 run 继承 done 且首段拉起', async () => {
  const { start, cancel, resumeFrom, exec } = setup()
  const r0 = await start.execute({ request: '整理仓库', templateId: 'default', inputs: {}, plan: fullPlan() }, exec)
  await waitStatus(r0.runId, new Set(['waiting_approval']))
  await cancel.execute({ runId: r0.runId }, exec)
  const before = reportStore().get(r0.runId)
  assert.equal(before.status, 'cancelled')
  assert.equal(before.state.steps.execute.status, 'done')
  const rf = await resumeFrom.execute({ runId: r0.runId }, exec)
  assert.equal(rf.ok, true)
  assert.notEqual(rf.runId, r0.runId)
  assert.equal(currentJobs.length > 1, true)
  const seed = reportStore().get(rf.runId)
  assert.equal(seed.status, 'running')
  assert.equal(seed.state.steps.execute.status, 'done')
  assert.equal(seed.state.steps.triage.status, 'done')
  registry.drivers.get(rf.runId)?.cancel()
})

test('Given fromStepId When resume_from Then 该步及其后代重置', async () => {
  const { start, cancel, resumeFrom, exec } = setup()
  const r0 = await start.execute({ request: '整理仓库', templateId: 'default', inputs: {}, plan: fullPlan() }, exec)
  await waitStatus(r0.runId, new Set(['waiting_approval']))
  await cancel.execute({ runId: r0.runId }, exec)
  const rf = await resumeFrom.execute({ runId: r0.runId, fromStepId: 'execute' }, exec)
  assert.equal(rf.ok, true)
  const seed = reportStore().get(rf.runId)
  assert.equal(seed.state.steps.triage.status, 'done')
  assert.equal(seed.state.steps.execute.status, 'pending')
  assert.equal(seed.state.steps.review.status, 'pending')
  registry.drivers.get(rf.runId)?.cancel()
})

test('Given 活跃 run When resume_from Then 拒', async () => {
  const { start, resumeFrom, exec } = setup()
  const r0 = await start.execute({ request: 'x', templateId: 'default', inputs: {}, plan: fullPlan() }, exec)
  const rf = await resumeFrom.execute({ runId: r0.runId }, exec)
  assert.equal(rf.ok, false)
  assert.ok(rf.error.includes('进行中'))
  registry.drivers.get(r0.runId)?.cancel()
})

test('Given 非法 fromStepId When resume_from Then 拒且不建 run', async () => {
  const { start, cancel, resumeFrom, exec } = setup()
  const r0 = await start.execute({ request: 'x', templateId: 'default', inputs: {}, plan: fullPlan() }, exec)
  await waitStatus(r0.runId, new Set(['waiting_approval']))
  await cancel.execute({ runId: r0.runId }, exec)
  const rf = await resumeFrom.execute({ runId: r0.runId, fromStepId: 'ghost' }, exec)
  assert.equal(rf.ok, false)
  assert.ok(rf.error.includes('fromStepId'))
})

test('Given 跨会话 run When resume_from Then 拒', async () => {
  const { start, cancel, resumeFrom, exec } = setup()
  const r0 = await start.execute({ request: 'x', templateId: 'default', inputs: {}, plan: fullPlan() }, exec)
  await waitStatus(r0.runId, new Set(['waiting_approval']))
  await cancel.execute({ runId: r0.runId }, exec)
  const other = { agent: { id: 'agent-other-1' }, signal: { throwIfAborted: () => {}, aborted: false } }
  const rf = await resumeFrom.execute({ runId: r0.runId }, other)
  assert.equal(rf.ok, false)
  assert.ok(rf.error.includes('其他会话'))
})

// ── 会话守门(agent/turn-stopping)契约级验证 ─────────────────────────────────

// 发送记录器:捕获守门 steer 的消息文本与来源标记
const steerRecorder = (id) => {
  const steered = []
  return { agent: { id, steer: (msg) => steered.push(msg) }, steered }
}

test('Given 编排等待裁决 When 轮次将停 Then 监听器 steer 提醒且文本指向裁决', async () => {
  const { start, exec, handler } = setup()
  const onTurnStopping = handler('agent/turn-stopping')
  assert.equal(typeof onTurnStopping, 'function')
  const r = await start.execute({ request: '整理仓库', templateId: 'default', plan: fullPlan() }, exec)
  await waitStatus(r.runId, new Set(['waiting_approval']))
  const spy = steerRecorder(exec.agent.id)
  await onTurnStopping({ agent: spy.agent, turn: 1, signal: { throwIfAborted: () => {} } })
  assert.equal(spy.steered.length, 1)
  const text = spy.steered[0].content[0].text
  assert.match(text, new RegExp(r.runId))
  assert.match(text, /欠动作=裁决/)
  assert.equal(spy.steered[0].source.plugin, 'rs-workflow')
})

test('Given 同一 run 连续轮次将停 Then 提醒达上限后停止 steer', async () => {
  const { start, exec, handler } = setup()
  const onTurnStopping = handler('agent/turn-stopping')
  const r = await start.execute({ request: '整理仓库', templateId: 'default', plan: fullPlan() }, exec)
  await waitStatus(r.runId, new Set(['waiting_approval']))
  const spy = steerRecorder(exec.agent.id)
  for (let i = 0; i < MAX_NUDGE + 2; i += 1) await onTurnStopping({ agent: spy.agent, turn: i, signal: { throwIfAborted: () => {} } })
  assert.equal(spy.steered.length, MAX_NUDGE)
})

test('Given 已终态或段在飞 When 轮次将停 Then 不 steer', async () => {
  const { start, cancel, exec, handler } = setup()
  const onTurnStopping = handler('agent/turn-stopping')
  const r = await start.execute({ request: '整理仓库', templateId: 'default', plan: fullPlan() }, exec)
  const spy = steerRecorder(exec.agent.id)
  // 段在飞:编排正常等待,轮次停是合理行为
  await onTurnStopping({ agent: spy.agent, turn: 0, signal: { throwIfAborted: () => {} } })
  assert.equal(spy.steered.length, 0)
  // 终态
  const driver = registry.drivers.get(r.runId)
  await waitStatus(r.runId, new Set(['waiting_approval']))
  await cancel.execute({ runId: r.runId }, exec)
  await onTurnStopping({ agent: spy.agent, turn: 1, signal: { throwIfAborted: () => {} } })
  assert.equal(spy.steered.length, 0)
  assert.equal(driver.state.status, 'cancelled')
})

test('Given 本会话无现役 run When 轮次将停 Then 不 steer', async () => {
  const { exec, handler } = setup()
  const onTurnStopping = handler('agent/turn-stopping')
  const spy = steerRecorder(exec.agent.id)
  await onTurnStopping({ agent: spy.agent, turn: 0, signal: { throwIfAborted: () => {} } })
  assert.equal(spy.steered.length, 0)
})

test('Given 他会话的 agent When 轮次将停 Then 不 steer(守门按会话隔离)', async () => {
  const { start, exec, handler } = setup()
  const onTurnStopping = handler('agent/turn-stopping')
  await start.execute({ request: '整理仓库', templateId: 'default', plan: fullPlan() }, exec)
  await waitStatus(registry.drivers.get([...registry.drivers.keys()].at(-1)).runId, new Set(['waiting_approval']))
  // 另一会话轮次停:本会话的欠动作不得算到它头上
  const spy = steerRecorder('agent-other-session')
  await onTurnStopping({ agent: spy.agent, turn: 0, signal: { throwIfAborted: () => {} } })
  assert.equal(spy.steered.length, 0)
})

test('Given 欠动作被处置后再次欠动作 When 轮次将停 Then 提醒额度按欠动作周期重置', async () => {
  const { start, resume, exec, handler } = setup()
  const onTurnStopping = handler('agent/turn-stopping')
  const r = await start.execute({ request: '整理仓库', templateId: 'default', plan: fullPlan() }, exec)
  await waitStatus(r.runId, new Set(['waiting_approval']))
  const spy = steerRecorder(exec.agent.id)
  // 第一轮欠裁决:提醒到上限
  for (let i = 0; i < MAX_NUDGE + 1; i += 1) await onTurnStopping({ agent: spy.agent, turn: i, signal: { throwIfAborted: () => {} } })
  assert.equal(spy.steered.length, MAX_NUDGE)
  // 处置:裁决 + 推进到终态,期间一次不欠动作的轮次即清计数
  const driver = registry.drivers.get(r.runId)
  driver.handlePost({ kind: 'approve', by: 'user' })
  await resume.execute({ runId: r.runId }, exec)
  await waitStatus(r.runId, new Set(['completed', 'failed', 'blocked']))
  await onTurnStopping({ agent: spy.agent, turn: 99, signal: { throwIfAborted: () => {} } })
  assert.equal(spy.steered.length, MAX_NUDGE)
  // 新 run 欠动作:额度独立
  const r2 = await start.execute({ request: '再来一次', templateId: 'default', plan: fullPlan() }, exec)
  await waitStatus(r2.runId, new Set(['waiting_approval']))
  await onTurnStopping({ agent: spy.agent, turn: 100, signal: { throwIfAborted: () => {} } })
  assert.equal(spy.steered.length, MAX_NUDGE + 1)
})

// 收尾钩子置于末尾:提前注册会截杀其后声明的用例
// probe: hook removed
