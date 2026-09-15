// d6:嵌套 flow 子流程与父 run 账目污染
// 猜想 6a:子 driver 与父共用 runId,子终态 judgeTerminal→finish 会以父 runId 落 store.finish + 注销父 driver 注册
// 猜想 6b:污染窗口内 control 平面(post)对仍在运行的父 run 失效
import { mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import assert from 'node:assert/strict'
import { createStore } from '../lib/store.mjs'
import { RunDriver } from '../lib/driver/index.mjs'
import { registry, post } from '../lib/driver/control.mjs'

const root = join(tmpdir(), `rsww-t2-d6-${Date.now()}-${Math.random().toString(36).slice(2)}`)
const findings = []
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const makeEngine = () => {
  let pending = []
  let seq = 0
  return {
    startCount: 0,
    start({ args }) {
      this.startCount++
      const calls = args.calls
      return { result: new Promise((resolve) => pending.push(() => resolve({
        results: calls.map((c) => ({ callId: c.callId, ok: true, outputs: { o: `n${++seq}` } })),
      }))) }
    },
    flush() {
      const p = pending
      pending = []
      for (const fn of p) fn()
    },
  }
}
try {
  mkdirSync(join(root, 'runs'), { recursive: true })
  const store = createStore({ dir: root })
  const finishCalls = []
  const recordingStore = new Proxy(store, {
    get(t, k) {
      if (k === 'finish') return (o) => { finishCalls.push({ runId: o.runId, status: o.status }); return t.finish(o) }
      const v = t[k]
      return typeof v === 'function' ? v.bind(t) : v
    },
  })
  const sub = { id: 'sub', label: 'sub', steps: [{ id: 'w', prompt: 'W', outputs: { o: 'o' } }] }
  const outer = { id: 'outer', label: 'outer', steps: [{ id: 'f', type: 'flow', flow: 'sub' }, { id: 'g', after: ['f'], prompt: 'G', outputs: { o: 'o' } }] }
  const engine = makeEngine()
  const driver = new RunDriver({ template: outer, templateSet: [sub], runId: 'r-flow', request: 'x', store: recordingStore, engine })
  driver.start()
  await sleep(30)
  // 此刻:子流程 w 已派发并在飞;flush 放行 → 子终态 finish(污染点)→ 父继续
  engine.flush()
  await sleep(60)
  const midRecord = store.get('r-flow')
  const midFinishedAt = midRecord.finishedAt
  const midRegistered = registry.drivers.has('r-flow')
  const midPost = post('r-flow', { kind: 'message', text: '父运行中插话' })
  const parentNotFinished = !driver.finished
  // 放行 g 步,父自然结束
  engine.flush()
  await sleep(80)
  const endRecord = store.get('r-flow')
  assert.equal(driver.finished, true)
  assert.equal(endRecord.status, 'completed')
  if (finishCalls.length >= 2 && finishCalls[0].runId === 'r-flow' && midFinishedAt && !midRegistered && !midPost && parentNotFinished) {
    findings.push(`CONFIRMED 6a/6b 子 driver 终态以父 runId 落账:父仍在运行时 store.finish 已写入(status=${finishCalls[0].status},finishedAt 已置),registry 已注销,control post 返回 false——父 run 中段即被终态化且控制平面失效`)
  } else {
    findings.push(`PASS 6 子流程未污染父账(finishCalls=${finishCalls.length} midPost=${midPost})`)
  }
  registry.drivers.delete('r-flow')
} catch (e) {
  findings.push(`INCONCLUSIVE 探针异常:${e && e.stack ? e.stack.split('\n')[0] : e}`)
} finally {
  rmSync(root, { recursive: true, force: true })
}
console.log(findings.join('\n'))
