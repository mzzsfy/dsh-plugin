// d13:runner 失败账缺省兜底 + 事件循环饿死
// 猜想 13a:step.maxFail 与 budgets.maxStepFail 均未配置时,limit=undefined → failCount >= undefined 恒 false
//           → 失败步骤永远回 pending 无限重试:无上限、无退避、无 failed 终态
// 猜想 13b:该重试循环是纯微任务级联(runnerBatch await 已决议 promise + loop 无休眠),宏任务(定时器/HTTP)被饿死
import { mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createStore } from '../lib/store.mjs'
import { RunDriver } from '../lib/driver/index.mjs'
import { registry } from '../lib/driver/control.mjs'

const root = join(tmpdir(), `rsww-t2-d13-${Date.now()}-${Math.random().toString(36).slice(2)}`)
const findings = []
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const CAP = 2000
try {
  mkdirSync(join(root, 'runs'), { recursive: true })
  const store = createStore({ dir: root })
  const tpl = { id: 't13', label: 't', steps: [{ id: 'a', prompt: 'P', outputs: { o: 'o' } }] }
  // 自终止桩:CAP 次后放行成功,否则探针自身也被饿死无法收尾(此事实即 13b 的证据)
  const engine = { startCount: 0, start({ args }) {
    this.startCount++
    const done = this.startCount >= CAP
    return { result: Promise.resolve({ results: args.calls.map((c) => ({ callId: c.callId, ok: done, outputs: done ? { o: 'x' } : undefined, error: done ? undefined : '总是失败' })) }) }
  } }
  // 20ms 宏任务探针:若循环饿死事件循环,它只能在整个重试风暴结束后才触发
  const t0 = Date.now()
  let timerFiredAt = null
  setTimeout(() => { timerFiredAt = Date.now() }, 20)
  const driver = new RunDriver({ template: tpl, runId: 'r-retry', request: 'x', store, engine, budgets: {} })
  driver.start()
  await sleep(15000)
  const record = store.get('r-retry')
  const spun = engine.startCount
  const stepNeverFailed = driver.state.steps.a.status !== 'failed' || spun >= CAP
  const timerDelay = timerFiredAt === null ? null : timerFiredAt - t0
  const subVerdicts = []
  if (spun >= CAP && stepNeverFailed && record.status !== 'failed') {
    subVerdicts.push(`失败 ${spun} 次(观察窗上限 ${CAP})仍无 failed 终态(终态 ${record.status})——失败账上限缺省缺失`)
  }
  if (timerDelay !== null && timerDelay > 500) {
    subVerdicts.push(`20ms 定时器实际 ${timerDelay}ms 后才触发——重试风暴期间宏任务被完全饿死,宿主同进程 HTTP/定时器全部停摆`)
  }
  if (subVerdicts.length > 0) {
    findings.push(`CONFIRMED 13 ${subVerdicts.join(';')}`)
  } else {
    findings.push(`PASS 13 失败账有缺省兜底且事件循环健康(spun=${spun} timerDelay=${timerDelay} status=${record.status})`)
  }
  registry.drivers.delete('r-retry')
} catch (e) {
  findings.push(`INCONCLUSIVE 探针异常:${e && e.stack ? e.stack.split('\n')[0] : e}`)
} finally {
  rmSync(root, { recursive: true, force: true })
}
console.log(findings.join('\n'))
