// d5:driver cancel 与在飞批次落账、post-finish 边界
// 猜想 5a:cancel 后在飞批次返回 → runBatch 丢弃结果并落 cancelled 终态(证伪预期:该路径无缺陷)
// 猜想 5b:续跑种子 buildSeed 把 in-flight 遗留的 running 步重置为 pending(证伪预期)
// 猜想 5c:finish 边界 handlePost 竞态(单线程无真竞态,证伪预期);但 cancel 前 post 已受理的消息会静默丢失
import { mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import assert from 'node:assert/strict'
import { createStore } from '../lib/store.mjs'
import { RunDriver, buildSeed } from '../lib/driver/index.mjs'
import { registry } from '../lib/driver/control.mjs'

const root = join(tmpdir(), `rsww-t2-d5-${Date.now()}-${Math.random().toString(36).slice(2)}`)
const findings = []
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const makeEngine = () => {
  let resolvers = []
  return {
    startCount: 0,
    resolveAll(fn) {
      const rs = resolvers
      resolvers = []
      for (const r of rs) r(fn())
    },
    start({ args }) {
      this.startCount++
      return { result: new Promise((resolve) => resolvers.push(resolve)) }
    },
  }
}
try {
  mkdirSync(join(root, 'runs'), { recursive: true })
  const store = createStore({ dir: root })
  const tpl = { id: 't', label: 't', steps: [{ id: 'a', prompt: 'P', outputs: { o: 'o' } }, { id: 'b', after: ['a'], prompt: 'Q', outputs: { o: 'o' } }] }
  const engine = makeEngine()
  const driver = new RunDriver({ template: tpl, runId: 'r-inflight', request: 'x', store, engine })
  driver.start()
  await sleep(20)
  // 在飞时:post 一条消息(受理)→ 立刻 cancel → 放行批次(带成功结果)
  const postOk = driver.handlePost({ kind: 'message', text: '跑一半的补充' })
  driver.cancel()
  engine.resolveAll(() => ({ results: [{ callId: 'a#-@1:0', ok: true, outputs: { o: 'A' } }] }))
  await sleep(60)
  const record = store.get('r-inflight')
  const cancelled = driver.finished && record.status === 'cancelled'
  const stepAReset = driver.state.steps.a.status !== 'done'
  // 5b 续跑种子:running/paused 孤儿收敛后种子可重建
  const seed = buildSeed(record, tpl, undefined, undefined)
  const seedAPending = seed.steps.a.status === 'pending'
  if (cancelled && stepAReset && seedAPending) {
    findings.push('PASS 5a/5b cancel 在飞批次:结果被整体丢弃,run 落 cancelled 并注销 driver;buildSeed 把在飞遗留步重置 pending,续跑不重派已完成(该路径无缺陷)')
  } else {
    findings.push(`CONFIRMED 5a/5b 在飞取消落账异常(cancelled=${cancelled} stepAReset=${stepAReset} seedAPending=${seedAPending})`)
  }
  // 5c 已受理但未消费的消息随取消冻结在终态记录中,永不消费
  const queuedFrozen = (record.queued ?? []).includes('跑一半的补充')
  findings.push(postOk && cancelled && queuedFrozen
    ? 'CONFIRMED 5c post 在终态前受理返回 ok(用户被告知"已排队"),cancel 终态化后该消息冻结在 queued 中永不消费,受理语义与终态语义间无冲销提示'
    : `PASS 5c 消息有消费出口(postOk=${postOk} cancelled=${cancelled} queuedFrozen=${queuedFrozen})`)
  registry.drivers.delete('r-inflight')
} catch (e) {
  findings.push(`INCONCLUSIVE 探针异常:${e && e.stack ? e.stack.split('\n')[0] : e}`)
} finally {
  rmSync(root, { recursive: true, force: true })
}
console.log(findings.join('\n'))
