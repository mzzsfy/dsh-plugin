// d12:template-v4 校验器边界
// 猜想 12a:循环 after 引用被检出(证伪预期)
// 猜想 12b:flow 字面量路由指向自身模板 id → 校验通过(validateTemplateSet 排除自边),运行期无界递归
// 猜想 12c:for_each 空列表 + 下游 approve → 步骤 skipped 而 approve 永不就绪 → run blocked"依赖链缺陷"
// 猜想 12d:步骤 id "input" 与入参命名空间遮蔽:校验放行,运行期 {input.x} 解析为入参,步骤产出被同名入参遮蔽
import { mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import assert from 'node:assert/strict'
import { validateTemplate, validateTemplateSet } from '../lib/template-v4.mjs'
import { resolvePlaceholders } from '../lib/driver/prompts.mjs'
import { nextBatch } from '../lib/driver/scheduler.mjs'
import { RunDriver } from '../lib/driver/index.mjs'
import { createStore } from '../lib/store.mjs'
import { registry } from '../lib/driver/control.mjs'

const root = join(tmpdir(), `rsww-t2-d12-${Date.now()}-${Math.random().toString(36).slice(2)}`)
const findings = []
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const mkState = (template) => {
  const state = { status: 'running', request: 'x', inputs: {}, steps: {}, approvals: {}, escalations: 0, queued: [], batchSeq: 0, slotCursor: {} }
  for (const s of template.steps) state.steps[s.id] = { status: 'pending', outputs: null, failCount: 0, instances: [] }
  return state
}
try {
  // 12a 循环 after
  const cyc = { id: 'cyc', label: 'c', steps: [
    { id: 'a', after: ['b'], prompt: 'P', outputs: { o: 'o' } },
    { id: 'b', after: ['a'], prompt: 'Q', outputs: { o: 'o' } },
  ] }
  const cycErrs = validateTemplate(cyc)
  const selfRef = { id: 'sr', label: 's', steps: [{ id: 'a', after: ['a'], prompt: 'P', outputs: { o: 'o' } }] }
  const selfErrs = validateTemplate(selfRef)
  findings.push(cycErrs.some((e) => /依赖环/.test(e.message)) && selfErrs.length > 0
    ? 'PASS 12a 循环 after 与 after 自引用均被检出(依赖环错误)'
    : `CONFIRMED 12a 环引用漏检(cyc=${cycErrs.length} self=${selfErrs.length})`)

  // 12b flow 字面量自路由
  const selfFlow = { id: 'loop', label: 'l', steps: [
    { id: 'gate', prompt: 'G', outputs: { o: 'o' }, after: [] },
    { id: 'sub', type: 'flow', flow: 'loop', after: ['gate'] },
  ] }
  const single = validateTemplate(selfFlow)
  const setErrs = validateTemplateSet([selfFlow])
  if (single.length === 0 && setErrs.length === 0) {
    // 运行期深度演示:每层子流程各派发一次 gate;depth>25 后 gate 置败收口(maxStepFail=1 使失败收敛)
    mkdirSync(join(root, 'runs'), { recursive: true })
    const store = createStore({ dir: root })
    const engine = { startCount: 0, start({ args }) {
      this.startCount++
      const fail = this.startCount > 25
      return { result: Promise.resolve({ results: args.calls.map((c) => ({ callId: c.callId, ok: !fail, outputs: { o: 'x' }, error: fail ? 'depth-guard' : undefined })) }) }
    } }
    const driver = new RunDriver({ template: selfFlow, templateSet: [selfFlow], runId: 'r-self', request: 'x', store, engine, budgets: { maxStepFail: 1 } })
    driver.start()
    await sleep(400)
    const record = store.get('r-self')
    const deepRecursion = engine.startCount > 3
    findings.push(deepRecursion && record.status === 'failed'
      ? `CONFIRMED 12b flow 字面量自引用路由({flow:'自身id'})校验零报错,运行期无界嵌套递归(嵌套 ${engine.startCount} 层 >> 契约上限 3,注入失败后才收敛为 failed)——自嵌套模板可无界展开`
      : `PASS 12b 自路由被拦截或深度受限(count=${engine.startCount} status=${record.status})`)
    registry.drivers.delete('r-self')
  } else {
    findings.push(`PASS 12b 自引用路由被校验拦截(single=${single.length} set=${setErrs.length})`)
  }

  // 12c for_each 空列表 + 下游 approve
  const tplC = { id: 'c12', label: 'c', steps: [
    { id: 'src', prompt: 'S', outputs: { items: '列表' }, listOutputs: ['items'] },
    { id: 'work', for_each: 'src.items', mode: 'parallel', prompt: '{item}', outputs: { r: 'r' } },
    { id: 'ap', type: 'approve', target: 'work', prompt: '审', onExhausted: 'blocked' },
  ] }
  const st = mkState(tplC)
  st.steps.src.status = 'done'
  st.steps.src.outputs = { items: [] }
  const b1 = nextBatch(st, tplC)
  assert.equal(st.steps.work.status, 'skipped')
  const b2 = nextBatch(st, tplC)
  findings.push(b2.kind === 'blocked'
    ? `CONFIRMED 12c for_each 空数据源把 work 置 skipped 后,下游 approve 以 skipped 步为目标/依赖永不就绪 → run blocked"无就绪且无在飞但存在未完成步骤(依赖链缺陷)"——空列表语义应为"无事项即通过",当前把合法空跑打死为 blocked(b1.kind=${b1.kind})`
    : `PASS 12c 空列表下游 approve 可收敛(b2=${JSON.stringify(b2)})`)

  // 12d inputs 遮蔽步骤产出
  const tplD = { id: 'd12', label: 'd', inputs: { o: '与步骤 input 的产出同名' }, steps: [
    { id: 'input', prompt: 'P', outputs: { o: '产出' } },
    { id: 'b', after: ['input'], prompt: '取 {input.o}', outputs: { o: 'o' } },
  ] }
  const errsD = validateTemplate(tplD)
  const shadowState = { steps: { input: { status: 'done', outputs: { o: '步骤产出' } } } }
  const resolved = resolvePlaceholders('取 {input.o}', { request: 'r', inputs: { o: '运行入参' }, state: shadowState })
  if (errsD.length === 0 && resolved.includes('运行入参')) {
    findings.push('CONFIRMED 12d 步骤 id "input" 合法但 {input.o} 在校验与运行期均被入参命名空间抢占:模板校验放行,运行期解析为 inputs.o(运行入参),步骤产出被静默遮蔽且无任何告警')
  } else {
    findings.push(`PASS 12d 遮蔽被处理(errs=${errsD.length} resolved=${resolved})`)
  }
} catch (e) {
  findings.push(`INCONCLUSIVE 探针异常:${e && e.stack ? e.stack.split('\n')[0] : e}`)
} finally {
  rmSync(root, { recursive: true, force: true })
}
console.log(findings.join('\n'))
