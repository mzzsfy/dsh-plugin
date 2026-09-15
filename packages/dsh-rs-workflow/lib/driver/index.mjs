// RunDriver 聚合:start/pause/resume/cancel/seed;批次派发循环与终态判定
import { reportStore } from '../store.mjs'
import { nextBatch, stepTypeOf, DEFAULT_CONCURRENCY } from './scheduler.mjs'
import { applyApproveResult } from './approve.mjs'
import { runBatch } from './runner.mjs'
import { registerDriver, unregisterDriver, registry } from './control.mjs'

const TERMINAL_STATES = new Set(['completed', 'cancelled', 'failed', 'blocked'])

const CANCELLED_SUMMARY = '用户取消,已完成步骤保留,可在运行中心续跑'

// 批次间宏任务让步时长:防止失败重试微任务级联饿死宿主同进程定时器/HTTP
const BATCH_YIELD_MS = 0
const yieldToLoop = () => new Promise((resolve) => setTimeout(resolve, BATCH_YIELD_MS))

function initState(template, request, inputs) {
  const state = {
    status: 'running', request, inputs: inputs ?? {},
    steps: {}, approvals: {}, escalations: 0, queued: [], batchSeq: 0, slotCursor: {},
  }
  for (const step of template.steps) {
    state.steps[step.id] = { status: 'pending', outputs: null, failCount: 0, instances: [] }
  }
  return state
}

// 续跑种子:快照直读;fromStepId 及其后代(文档序兜底)回 pending,已完成不重派
export function buildSeed(record, template, fromStepId, inputs) {
  const state = JSON.parse(JSON.stringify(record.state ?? {}))
  state.status = 'running'
  state.request = record.request
  state.inputs = inputs && Object.keys(inputs).length > 0 ? { ...(record.inputs ?? {}), ...inputs } : (record.inputs ?? {})
  for (const step of template.steps) {
    state.steps[step.id] ??= { status: 'pending', outputs: null, failCount: 0, instances: [] }
  }
  const resetStep = (id) => {
    const s = state.steps[id]
    if (s) Object.assign(s, { status: 'pending', outputs: null, failCount: 0, instances: [] })
  }
  if (fromStepId && state.steps[fromStepId]) {
    resetStep(fromStepId)
    const idx = template.steps.findIndex((s) => s.id === fromStepId)
    for (let i = idx + 1; i < template.steps.length; i++) {
      const s = state.steps[template.steps[i].id]
      if (s && s.status !== 'done') resetStep(template.steps[i].id)
    }
  }
  for (const step of template.steps) {
    const s = state.steps[step.id]
    if (s.status === 'running') Object.assign(s, { status: 'pending', outputs: null })
    for (const inst of s.instances ?? []) {
      if (inst.status === 'running') inst.status = 'pending'
    }
  }
  // 尾窗:快照后未消费控制事件由 controlSeq 之后的 controls 补齐
  state.pendingControls = (record.controls ?? []).slice(state.controlSeq ?? 0)
  return state
}

export class RunDriver {
  constructor({ template, templateSet = [], runId, request, inputs, state, parent, engine, slots = {}, budgets = {}, sessionId = '', workspace = '', store = reportStore(), signal, subordinate = false }) {
    this.template = template
    this.templateSet = templateSet
    this.runId = runId
    this.request = request
    this.inputs = inputs ?? {}
    this.state = state ?? initState(template, request, inputs)
    this.parent = parent
    this.engine = engine
    this.slots = slots
    this.budgets = budgets
    this.sessionId = sessionId
    this.workspace = workspace
    this.store = store
    this.controller = new AbortController()
    this.signal = signal ?? this.controller.signal
    this.pauseResolve = null
    this.paused = false
    this.finished = false
    // 嵌套子流程:记账由父 driver 汇总,终态不落 store、不注销父注册
    this.subordinate = subordinate
  }

  start() {
    registerDriver(this.runId, this)
    this.store.start({
      runId: this.runId, sessionId: this.sessionId, workspace: this.workspace,
      request: this.request, templateId: this.template.id, inputs: this.inputs, state: this.state,
    })
    this.loop().catch((e) => {
      this.finish('failed', `驱动器异常:${e?.message ?? e}`)
    })
    return this.runId
  }

  pause() {
    if (this.finished) return
    this.paused = true
    this.state.status = 'paused'
    this.onNotice?.('若水编排已暂停,页签可恢复')
  }

  resume() {
    if (this.finished) return
    this.paused = false
    this.pauseResolve?.()
    this.pauseResolve = null
    this.onNotice?.('若水编排已恢复运行')
  }

  cancel() {
    if (this.finished) return
    this.controller.abort()
    this.pauseResolve?.()
    this.pauseResolve = null
    this.onNotice?.('若水编排已取消,已完成步骤保留,可在运行中心续跑')
  }

  // 控制队列受理面(post 入口):message 落控制事件账+回显队列;即时通道由 pause/resume/cancel 方法承载
  handlePost(event) {
    if (this.finished || TERMINAL_STATES.has(this.state.status)) return false
    if (event.kind !== 'message') return false
    if (typeof event.text !== 'string' || event.text === '') return false
    this.store.step({ runId: this.runId, event: 'control', body: { kind: 'message', text: event.text, inject: !!event.inject } })
    const record = this.store.get(this.runId)
    this.store.update({ runId: this.runId, queued: [...(record.queued ?? []), event.text] })
    if (event.inject === true) this.onNotice?.('若水编排已收到注入消息,下一批次生效')
    return true
  }

  async gate() {
    while (this.paused && !this.signal.aborted) {
      await new Promise((resolve) => {
        this.pauseResolve = resolve
      })
    }
  }

  // 边界通道 drain:消费 controls 中未消费的 message 事件
  drainControls() {
    const record = this.store.get(this.runId)
    const pending = record.controls.slice(this.state.controlSeq ?? 0)
    const inject = []
    const queued = []
    for (const c of pending) {
      if (c.kind !== 'message') continue
      if (c.inject) inject.push(c.text)
      else queued.push(c.text)
    }
    this.state.controlSeq = record.controls.length
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

  async loop() {
    for (;;) {
      await this.gate()
      if (this.signal.aborted) {
        this.finish('cancelled', CANCELLED_SUMMARY)
        return
      }
      await yieldToLoop()
      const { inject, queued } = this.drainControls()
      const batch = nextBatch(this.state, this.template, this.budgets)
      if (batch.kind === 'terminal') {
        // 升级账/审批耗尽置账后,blocked 终态先于 pending 残留判定
        if (this.state.terminalBlocked) {
          this.finish('blocked', this.state.terminalBlocked)
        } else {
          this.judgeTerminal()
        }
        return
      }
      if (batch.kind === 'blocked') {
        this.finish('blocked', this.state.terminalBlocked ?? batch.reason)
        return
      }
      if (batch.kind === 'idle') {
        this.persistState()
        await new Promise((r) => setTimeout(r, 50))
        continue
      }
      if (batch.kind === 'flow') {
        await this.runFlowStep(batch.step)
        if (this.finished) return
        this.persistState()
        continue
      }
      // approve 独占批次与普通批次都经 runner
      const outcome = await runBatch({
        state: this.state, template: this.template,
        batch: batch.kind === 'approve' ? [{ stepId: batch.step.id }] : batch.calls,
        ctx: {
          store: this.store, runId: this.runId, engine: this.engine, parent: this.parent,
          signal: this.signal, slots: this.slots, budgets: this.budgets,
          request: this.request, inputs: this.inputs, injectMessages: inject, queuedMessages: queued,
          readDoc: this.readDoc,
        },
      })
      // 重做说明只服务紧邻的重做批次,派发后即清
      this.state.redoInfo = {}
      if (outcome.cancelled) {
        this.finish('cancelled', CANCELLED_SUMMARY)
        return
      }
      // 审批路由:批次中若含 approve 步已完成,走裁决
      if (batch.kind === 'approve') {
        const s = this.state.steps[batch.step.id]
        if (s.status === 'done' && !s.verdictExhausted) {
          const route = applyApproveResult(this.state, this.template, batch.step, { outputs: s.outputs }, this.budgets)
          if (route.verdict === 'REJECTED' && !route.exhausted) {
            this.state.redoInfo = { [route.redoTarget]: { comments: route.comments, prevOutputs: route.prevOutputs } }
          }
          if (route.exhausted && route.routedTo === 'blocked') {
            this.finish('blocked', this.state.terminalBlocked)
            return
          }
        }
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
    const sub = this.templateSet.find((t) => t.id === route)
    if (!sub) {
      s.status = 'failed'
      s.error = `子流程模板不存在:${route}`
      return
    }
    const subState = initState(sub, this.request, this.resolveFlowInputs(step))
    const subDriver = new RunDriver({
      template: sub, templateSet: this.templateSet, runId: this.runId, request: this.request,
      inputs: subState.inputs, state: subState, parent: this.parent, engine: this.engine,
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

// 发起入口:runId 生成走 store;返回 driver 实例
export function startRun({ template, templateSet, request, inputs, parent, engine, slots, budgets, sessionId, workspace }) {
  const store = reportStore()
  RunDriver.seq = (RunDriver.seq ?? 0) + 1
  const runId = `r-${Date.now().toString(36)}-${RunDriver.seq}`
  const driver = new RunDriver({ template, templateSet, runId, request, inputs, parent, engine, slots, budgets, sessionId, workspace, store })
  driver.start()
  return driver
}
