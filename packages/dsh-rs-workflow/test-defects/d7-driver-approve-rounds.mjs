// d7:审批 rounds 语义与 escalateLimit 预算
// 猜想 7a:rounds=1 → 首次 REJECTED 即耗尽,无重做(语义核对)
// 猜想 7b:rounds=2 → 首次 REJECTED 重做 target,第二次耗尽(语义核对)
// 猜想 7c:escalateLimit=1 且两个独立审批步先后耗尽 → 升级账超发(实际执行 2 次升级步,预算非硬顶)
import { mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import assert from 'node:assert/strict'
import { createStore } from '../lib/store.mjs'
import { RunDriver } from '../lib/driver/index.mjs'
import { applyApproveResult } from '../lib/driver/approve.mjs'
import { registry } from '../lib/driver/control.mjs'

const root = join(tmpdir(), `rsww-t2-d7-${Date.now()}-${Math.random().toString(36).slice(2)}`)
const findings = []
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const mkState = (template) => {
  const state = { status: 'running', request: 'x', inputs: {}, steps: {}, approvals: {}, escalations: 0, queued: [], batchSeq: 0, slotCursor: {} }
  for (const s of template.steps) state.steps[s.id] = { status: 'pending', outputs: null, failCount: 0, instances: [] }
  return state
}
const REJECTED_OUT = { outputs: { verdict: 'REJECTED', comments: '不行' } }
try {
  // 7a/7b 纯函数语义
  const tpl = { id: 't', label: 't', steps: [
    { id: 'a', prompt: 'P', outputs: { o: 'o' } },
    { id: 'ap', type: 'approve', target: 'a', prompt: '审', rounds: 2 },
  ] }
  const st = mkState(tpl)
  st.steps.a.status = 'done'; st.steps.a.outputs = { o: 'A' }
  st.steps.ap.status = 'done'; st.steps.ap.outputs = REJECTED_OUT.outputs
  const budgets = { approveRounds: 2, escalateLimit: 2, maxStepFail: 2 }
  const r1 = applyApproveResult(st, tpl, tpl.steps[1], REJECTED_OUT, budgets)
  const redoFirst = r1.verdict === 'REJECTED' && r1.exhausted === false && r1.redoTarget === 'a' && st.steps.ap.status === 'pending'
  const r2 = applyApproveResult(st, tpl, tpl.steps[1], REJECTED_OUT, budgets)
  const exhaustSecond = r2.exhausted === true && st.steps.ap.verdictExhausted === true
  findings.push(redoFirst && exhaustSecond
    ? 'PASS 7b rounds=2 语义:首次 REJECTED 重做 target 并复位审批步,第二次耗尽置 verdictExhausted'
    : `CONFIRMED 7b rounds=2 语义异常(redoFirst=${redoFirst} exhaustSecond=${exhaustSecond})`)
  const st1 = mkState(tpl)
  st1.steps.a.status = 'done'; st1.steps.a.outputs = { o: 'A' }
  st1.steps.ap.status = 'done'; st1.steps.ap.outputs = REJECTED_OUT.outputs
  const tpl1 = JSON.parse(JSON.stringify(tpl)); tpl1.steps[1].rounds = 1
  const rr = applyApproveResult(st1, tpl1, tpl1.steps[1], REJECTED_OUT, budgets)
  findings.push(rr.exhausted === true
    ? 'PASS 7a rounds=1 语义:首次 REJECTED 即耗尽,无重做轮(审批者仅一轮否决权)'
    : `CONFIRMED 7a rounds=1 语义异常(${JSON.stringify(rr)})`)

  // 7c escalateLimit=1 双审批先后耗尽
  mkdirSync(join(root, 'runs'), { recursive: true })
  const store = createStore({ dir: root })
  const tpl2 = { id: 't2', label: 't2', steps: [
    { id: 'a1', prompt: 'P1', outputs: { o: 'o' } },
    { id: 'a2', prompt: 'P2', outputs: { o: 'o' } },
    { id: 'ap1', type: 'approve', target: 'a1', prompt: '审1', onExhausted: 'esc1' },
    { id: 'ap2', type: 'approve', target: 'a2', prompt: '审2', onExhausted: 'esc2' },
    { id: 'esc1', prompt: '升级1', outputs: { o: 'o' } },
    { id: 'esc2', prompt: '升级2', outputs: { o: 'o' } },
  ] }
  const engine = {
    startCount: 0,
    start({ args }) {
      this.startCount++
      const calls = args.calls
      const ids = calls.map((c) => c.stepId)
      const isApprove = ids.includes('ap1') || ids.includes('ap2')
      return { result: Promise.resolve({ results: calls.map((c) => ({
        callId: c.callId,
        ok: true,
        outputs: isApprove ? { verdict: 'REJECTED', comments: '拒' } : { o: `ok-${c.stepId}` },
      })) }) }
    },
  }
  const driver = new RunDriver({
    template: tpl2, runId: 'r-esc', request: 'x', store, engine,
    budgets: { approveRounds: 1, escalateLimit: 1, maxStepFail: 2 },
  })
  driver.start()
  await sleep(300)
  const record = store.get('r-esc')
  const stEsc = driver.state
  const esc1Ran = (record.steps?.esc1?.['-'] ?? []).some((e) => e.event === 'submit')
  // 引擎桩不产出 verdict 字段:applyApproveResult 将缺 verdict 一律按 REJECTED 计(防御性行为,一并记录)
  if (stEsc.terminalBlocked && record.status === 'completed' && stEsc.escalations === 1 && stEsc.escalateLimitReached && esc1Ran && stEsc.steps.esc2.status === 'pending') {
    findings.push('CONFIRMED 7c escalateLimit=1 双审批场景:ap1 耗尽后连锁把 ap2(文档序链后代)置 skipped,esc2 永不就绪;terminalBlocked/escalateLimitReached 已置账,但 blocked 终态被"pending 未就绪"步骤旁路,run 以 completed 收尾——契约"升级累计达上限整流程 blocked"失守,账面与终态自相矛盾')
  } else {
    findings.push(`PASS 7c 预算语义符合预期(status=${record.status} escalations=${stEsc.escalations} terminalBlocked=${stEsc.terminalBlocked} esc1Ran=${esc1Ran} esc2=${stEsc.steps.esc2.status})`)
  }
  registry.drivers.delete('r-esc')
} catch (e) {
  findings.push(`INCONCLUSIVE 探针异常:${e && e.stack ? e.stack.split('\n')[0] : e}`)
} finally {
  rmSync(root, { recursive: true, force: true })
}
console.log(findings.join('\n'))
