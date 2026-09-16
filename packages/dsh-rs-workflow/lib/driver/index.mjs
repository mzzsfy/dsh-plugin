// RunDriver 聚合(v5):剧本驱动;runSegment 分段推进(审批到达/暂停/终态即返回 settle 负载);
// 外部裁决回写(waiting_approval 即时应用,paused 入队 resume 生效);取消优先;推进责任在主循环 resume
import { reportStore } from '../store.mjs'
import { nextBatch, scriptViewOf } from './scheduler.mjs'
import { applyApproveResult, applyExternalVerdict, waitingPayload } from './approve.mjs'
import { runBatch } from './runner.mjs'
import { registerDriver, unregisterDriver } from './control.mjs'
import { dbg } from './debug.mjs'

const TERMINAL_STATES = new Set(['completed', 'cancelled', 'failed', 'blocked'])

const CANCELLED_SUMMARY = '用户取消,已完成步骤保留,可在会话页签断点续跑'

// 批次间宏任务让步时长:防止失败重试微任务级联饿死宿主同进程定时器/HTTP
const BATCH_YIELD_MS = 0
const yieldToLoop = () => new Promise((resolve) => setTimeout(resolve, BATCH_YIELD_MS))

// 运行态初始化:仅剧本内步骤入账(调度域=剧本,被裁剪步骤对引擎不存在)
function initState(script, request, inputs) {
  const state = {
    status: 'running', request, inputs: inputs ?? {},
    steps: {}, approvals: {}, escalations: 0, queued: [], batchSeq: 0, slotCursor: {}, controlSeq: 0, redoInfo: {},
  }
  for (const step of script.steps) {
    state.steps[step.id] = { status: 'pending', outputs: null, failCount: 0, instances: [] }
  }
  return state
}

// 续跑种子:快照直读;fromStepId 及其后代(剧本序兜底)回 pending,已完成不重派
export function buildSeed(record, plan, fromStepId, inputs) {
  const state = JSON.parse(JSON.stringify(record.state ?? {}))
  state.status = 'running'
  state.request = record.request
  state.inputs = inputs && Object.keys(inputs).length > 0 ? { ...(record.inputs ?? {}), ...inputs } : (record.inputs ?? {})
  const scriptIds = (plan?.steps ?? []).map((p) => p.ref)
  for (const id of scriptIds) {
    state.steps[id] ??= { status: 'pending', outputs: null, failCount: 0, instances: [] }
  }
  const resetStep = (id) => {
    const s = state.steps[id]
    if (s) Object.assign(s, { status: 'pending', outputs: null, failCount: 0, instances: [] })
  }
  if (fromStepId && state.steps[fromStepId]) {
    resetStep(fromStepId)
    const idx = scriptIds.indexOf(fromStepId)
    for (let i = idx + 1; i < scriptIds.length; i++) {
      const s = state.steps[scriptIds[i]]
      if (s && s.status !== 'done') resetStep(scriptIds[i])
    }
  }
  for (const id of scriptIds) {
    const s = state.steps[id]
    if (!s) continue
    if (s.status === 'running') Object.assign(s, { status: 'pending', outputs: null })
    for (const inst of s.instances ?? []) {
      if (inst.status === 'running') inst.status = 'pending'
    }
  }
  state.pendingApprovals = []
  state.controlSeq = record.controls?.length ?? 0
  return state
}

export class RunDriver {
  constructor({ template, templateSet = [], plan, warnings = [], runId, request, inputs, state, engine, slots = {}, budgets = {}, sessionId = '', workspace = '', store = reportStore(), signal, subordinate = false, parent = undefined }) {
    this.template = template
    this.templateSet = templateSet
    this.plan = plan
    this.warnings = warnings
    this.script = scriptViewOf(template, plan)
    this.planStepOf = new Map((plan?.steps ?? []).map((p) => [p.ref, p]))
    this.runId = runId
    this.request = request
    this.inputs = inputs ?? {}
    this.state = state ?? initState(this.script, request, inputs)
    this.engine = engine
    this.slots = slots
    this.budgets = budgets
    this.sessionId = sessionId
    this.workspace = workspace
    this.store = store
    this.controller = new AbortController()
    this.signal = signal ?? this.controller.signal
    this.awaitingResume = false
    this.finished = false
    this.active = false
    this.subordinate = subordinate
    // 编排子代理的挂载父 agent(与 workflow 工具链对齐;undefined 时引擎派发行为未定义)
    this.parent = parent
  }

  // 段推进唯一入口:跑到下一个段边界(审批到达/暂停/终态)返回 settle 负载;orchestrator 包装为 continuable job
  async runSegment() {
    if (this.finished || TERMINAL_STATES.has(this.state.status)) {
      return this.terminalPayload()
    }
    this.active = true
    try {
      this.drainPendingApprovals()
      return await this.loop()
    } catch (e) {
      if (this.signal.aborted) {
        this.finish('cancelled', CANCELLED_SUMMARY)
        return this.terminalPayload()
      }
      this.finish('failed', `驱动器异常:${e?.message ?? e}`)
      return this.terminalPayload()
    } finally {
      this.active = false
    }
  }

  startPersist() {
    registerDriver(this.runId, this)
    this.store.start({
      runId: this.runId, sessionId: this.sessionId, workspace: this.workspace,
      request: this.request, templateId: this.template.id, inputs: this.inputs,
      plan: this.plan, warnings: this.warnings, state: this.state,
    })
  }

  pause() {
    if (this.finished || TERMINAL_STATES.has(this.state.status)) return
    // 统一转 paused(与 waiting_approval 互斥,paused 优先);活跃段在飞批次收敛后于段顶 settle
    this.state.status = 'paused'
    this.persistState()
  }

  // 页签 control resume:仅标记恢复意图(不翻状态不拉段);主循环 rs_workflow_resume 执行翻转与推进
  tabResume() {
    if (this.finished || this.state.status !== 'paused') return
    this.awaitingResume = true
    this.store.step({ runId: this.runId, event: 'control', body: { kind: 'resume' } })
  }

  cancel() {
    if (this.finished) return
    dbg(`cancel() invoked status=${this.state.status} active=${this.active} stack=${new Error().stack?.split('\n').slice(1, 4).join(' | ')}`)
    if (this.state.status === 'waiting_approval' && !this.active) {
      // 取消优先:审批等待期无活跃段,即时终态
      this.finish('cancelled', CANCELLED_SUMMARY)
      return
    }
    this.controller.abort()
  }

  // 控制回写受理:approve/reject 外部裁决 + message 边界消息;返回 false = 未受理(状态不符)
  handlePost(event) {
    if (this.finished || TERMINAL_STATES.has(this.state.status)) return false
    if (event.kind === 'approve' || event.kind === 'reject') {
      return this.applyVerdictPost(event)
    }
    if (event.kind !== 'message') return false
    if (typeof event.text !== 'string' || event.text === '') return false
    this.store.step({ runId: this.runId, event: 'control', body: { kind: 'message', text: event.text, inject: !!event.inject } })
    const record = this.store.get(this.runId)
    this.store.update({ runId: this.runId, queued: [...(record.queued ?? []), event.text] })
    return true
  }

  // 裁决回写:waiting_approval 即时应用;paused 入队(resume 段首生效)
  applyVerdictPost(event) {
    const verdict = event.kind === 'approve' ? 'APPROVED' : 'REJECTED'
    if (this.state.status === 'paused') {
      this.state.pendingApprovals ??= []
      this.state.pendingApprovals.push({ stepId: this.state.waitingApproval, verdict, comments: event.reason ?? '', by: event.by })
      this.persistState()
      return true
    }
    if (this.state.status !== 'waiting_approval') return false
    const approveStep = this.script.steps.find((s) => s.id === this.state.waitingApproval)
    if (!approveStep) return false
    this.store.step({ runId: this.runId, event: 'control', body: { kind: event.kind, by: event.by, reason: event.reason } })
    const { applied, route } = applyExternalVerdict(this.state, this.script, approveStep, { verdict, comments: event.reason ?? '' }, this.budgets)
    if (applied) {
      this.state.waitingApproval = undefined
      if (route.verdict === 'REJECTED' && !route.exhausted) {
        this.state.redoInfo = { [route.redoTarget]: { comments: route.comments, prevOutputs: route.prevOutputs } }
      }
      this.persistState()
    }
    return applied
  }

  // 段首:应用 paused 期间入队的裁决(resume 后生效)
  drainPendingApprovals() {
    const pending = this.state.pendingApprovals ?? []
    if (pending.length === 0) return
    this.state.pendingApprovals = []
    for (const p of pending) {
      const approveStep = this.script.steps.find((s) => s.id === p.stepId)
      if (!approveStep) continue
      const verdict = p.verdict === 'APPROVED' ? 'APPROVED' : 'REJECTED'
      this.state.status = 'waiting_approval'
      const { route } = applyExternalVerdict(this.state, this.script, approveStep, { verdict, comments: p.comments }, this.budgets)
      this.state.status = 'running'
      if (route.verdict === 'REJECTED' && !route.exhausted) {
        this.state.redoInfo = { [route.redoTarget]: { comments: route.comments, prevOutputs: route.prevOutputs } }
      }
    }
  }

  // 边界通道 drain:消费 controls 中未消费的 message 事件
  drainControls() {
    const record = this.store.get(this.runId)
    const pending = (record.controls ?? []).slice(this.state.controlSeq ?? 0)
    const inject = []
    const queued = []
    for (const c of pending) {
      if (c.kind !== 'message') continue
      if (c.inject) inject.push(c.text)
      else queued.push(c.text)
    }
    this.state.controlSeq = (record.controls ?? []).length
    this.store.update({ runId: this.runId, queued: [] })
    return { inject, queued }
  }

  persistState() {
    this.store.update({ runId: this.runId, state: this.state, status: this.state.status })
  }

  finish(status, summary) {
    if (this.finished) return
    this.finished = true
    this.state.status = status
    if (this.subordinate) return
    this.store.update({ runId: this.runId, queued: [] })
    this.store.finish({ runId: this.runId, status, summary: summary ?? '' })
    unregisterDriver(this.runId)
  }

  outputsIndex() {
    const out = {}
    for (const [id, s] of Object.entries(this.state.steps)) {
      if (s.status === 'done' && s.outputs) out[id] = s.outputs
    }
    return out
  }

  terminalPayload() {
    return { kind: 'terminal', runId: this.runId, status: this.state.status, summary: this.store.get(this.runId)?.summary ?? '', outputsIndex: this.outputsIndex() }
  }

  async loop() {
    for (;;) {
      if (this.signal.aborted) {
        this.finish('cancelled', CANCELLED_SUMMARY)
        return this.terminalPayload()
      }
      // 暂停即段边界:在飞批次收敛后回到此处,本段以 paused settle
      if (this.state.status === 'paused') {
        this.persistState()
        return { kind: 'paused', runId: this.runId, status: 'paused' }
      }
      await yieldToLoop()
      const { inject, queued } = this.drainControls()
      const batch = nextBatch(this.state, this.script, this.budgets)
      if (batch.kind === 'terminal') {
        // 升级账/审批耗尽置账后,blocked 终态先于 pending 残留判定
        if (this.state.terminalBlocked) {
          this.finish('blocked', this.state.terminalBlocked)
        } else {
          this.judgeTerminal()
        }
        return this.terminalPayload()
      }
      if (batch.kind === 'blocked') {
        this.finish('blocked', this.state.terminalBlocked ?? batch.reason)
        return this.terminalPayload()
      }
      if (batch.kind === 'idle') {
        this.persistState()
        await new Promise((r) => setTimeout(r, 50))
        continue
      }
      if (batch.kind === 'flow') {
        await this.runFlowStep(batch.step)
        if (this.finished) return this.terminalPayload()
        this.persistState()
        continue
      }
      if (batch.kind === 'approve') {
        // v5 外部裁决:不派发,置 waiting_approval 即段边界
        const step = batch.step
        this.state.status = 'waiting_approval'
        this.state.waitingApproval = step.id
        this.persistState()
        return waitingPayload({ runId: this.runId, state: this.state, script: this.script, planStepOf: this.planStepOf, approveStep: step })
      }
      const outcome = await runBatch({
        state: this.state, script: this.script, template: this.template,
        batch: batch.calls,
        ctx: {
          store: this.store, runId: this.runId, engine: this.engine, parent: this.parent,
          signal: this.signal, slots: this.slots, budgets: this.budgets,
          request: this.request, inputs: this.inputs, injectMessages: inject, queuedMessages: queued,
          readDoc: this.readDoc, planStepOf: this.planStepOf,
        },
      })
      // 重做说明只服务紧邻的重做批次,派发后即清
      this.state.redoInfo = {}
      if (outcome.cancelled) {
        this.finish('cancelled', CANCELLED_SUMMARY)
        return this.terminalPayload()
      }
      this.persistState()
    }
  }

  judgeTerminal() {
    const failed = Object.values(this.state.steps).some((s) => s.status === 'failed')
    if (failed) {
      this.finish('failed', '存在失败步骤(失败账耗尽),下游已跳过')
      return
    }
    this.finish('completed', '全部步骤完成')
  }

  // 嵌套子流程:解析路由 → 模板集查找 → 递归子循环;route 空即 done
  async runFlowStep(step) {
    const s = this.state.steps[step.id]
    s.status = 'running'
    const route = this.resolveFlowRoute(step)
    if (!route) {
      s.status = 'done'
      s.outputs = {}
      return
    }
    const sub = this.templateSet?.find((t) => t.id === route)
    if (!sub) {
      s.status = 'failed'
      s.error = `子流程模板不存在:${route}`
      return
    }
    const subScript = scriptViewOf(sub, { steps: sub.steps.map((x) => ({ ref: x.id })), deps: {} })
    const subState = initState(subScript, this.request, this.resolveFlowInputs(step))
    const subDriver = new RunDriver({
      template: sub, plan: { source: 'fallback', brief: '', steps: sub.steps.map((x) => ({ ref: x.id, note: '', done: '' })), deps: {} },
      runId: this.runId, request: this.request,
      inputs: subState.inputs, state: subState, engine: this.engine,
      slots: this.slots, budgets: this.budgets, sessionId: this.sessionId, workspace: this.workspace,
      store: this.store, signal: this.signal, subordinate: true,
    })
    this.store.step({ runId: this.runId, stepId: step.id, event: 'dispatch', body: { prompt: `[嵌套子流程] ${route}`, callLabel: route } })
    await subDriver.loop()
    if (this.signal.aborted) return
    if (subState.status === 'completed') {
      s.status = 'done'
      s.outputs = {}
      for (const child of sub.steps) {
        const cs = subState.steps[child.id]
        if (cs?.outputs) s.outputs[`${child.id}.${Object.keys(cs.outputs)[0] ?? 'out'}`] = Object.values(cs.outputs)[0]
      }
      this.store.step({ runId: this.runId, stepId: step.id, event: 'submit', body: { outputs: s.outputs } })
    } else {
      s.status = 'failed'
      s.error = `子流程 ${route} 终态 ${subState.status}`
      this.store.step({ runId: this.runId, stepId: step.id, event: 'fail', body: { error: s.error } })
    }
  }

  resolveFlowRoute(step) {
    const m = /^\{([^{}]+)\}$/.exec(String(step.flow).trim())
    if (!m) return String(step.flow).trim()
    const [refId, refOut] = m[1].split('.')
    const ref = this.state.steps[refId]
    const v = ref?.outputs?.[refOut]
    if (Array.isArray(v)) return v[0] ?? ''
    return typeof v === 'string' ? v.trim() : ''
  }

  resolveFlowInputs(step) {
    const out = {}
    for (const [k, v] of Object.entries(step.input ?? {})) {
      const m = /^\{([^{}]+)\}$/.exec(String(v).trim())
      if (!m) continue
      const [refId, refOut] = m[1].split('.')
      const ref = this.state.steps[refId]
      out[k] = ref?.outputs?.[refOut] ?? ''
    }
    return out
  }
}

// 发起入口(v5):创建 driver 并落盘注册,不启动段;首段由 orchestrator 包装 continuable job 调 runSegment
export function startRun({ template, templateSet = [], plan, warnings = [], runId, request, inputs, engine, slots, budgets, sessionId, workspace, state, parent }) {
  const store = reportStore()
  RunDriver.seq = (RunDriver.seq ?? 0) + 1
  const id = runId ?? `r-${Date.now().toString(36)}-${RunDriver.seq}`
  const driver = new RunDriver({ template, templateSet, plan, warnings, runId: id, request, inputs, engine, slots, budgets, sessionId, workspace, store, state, parent })
  driver.startPersist()
  return driver
}
