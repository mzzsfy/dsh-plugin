// orchestrator 工具行 BDD(v5):start 受理/拒单计数/status/resume 拉段/cancel 幂等/message 受理
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { registerOrchestrator, enabledTemplates } from '../lib/orchestrator.mjs'
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
    return { result: Promise.resolve({ results: args.calls.map(() => ({ callId: 'c', ok: true, outputs: { brief: 'b', result: 'r', report: 'p' } })) }) }
  },
})

const registered = []
let currentJobs = []

function setup() {
  registered.length = 0
  currentJobs = []
  const ctx = {
    logger: { info: () => {}, warn: () => {} },
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
  return { start: tool('rs_workflow_start'), status: tool('rs_workflow_status'), resume: tool('rs_workflow_resume'), cancel: tool('rs_workflow_cancel'), message: tool('rs_workflow_message'), agent, exec }
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

// 编排异步链与 node:test runner IPC 组合存在悬挂句柄(PipeWrap),断言完成后强制收尾。
// runner 主进程依据子进程 reporter 流判定失败,子进程 exit(0) 不影响失败计数;失败明细由子进程流式输出可见。
let __orchTestFailed = false
test.afterEach((t) => { if (t.result?.status === 'failed') __orchTestFailed = true })
after(() => process.exit(__orchTestFailed ? 1 : 0))


