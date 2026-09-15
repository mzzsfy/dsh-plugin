// d4:driver pause 后立刻 cancel(批次完成后的 gate 等待窗口)→ 僵尸 run
// 猜想 4a:cancel 落在 gate 等待期 → loop 直接 break,不 finish、不注销 driver、记录停留 paused
// 猜想 4b:僵尸 run 上 handlePost 仍受理,消息永久堆积无消费
import { mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import assert from 'node:assert/strict'
import { createStore } from '../lib/store.mjs'
import { RunDriver } from '../lib/driver/index.mjs'
import { registry } from '../lib/driver/control.mjs'

const root = join(tmpdir(), `rsww-t2-d4-${Date.now()}-${Math.random().toString(36).slice(2)}`)
const findings = []
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const makeEngine = () => {
  let resolvers = []
  return {
    startCount: 0,
    resolveAll(outputs) {
      const rs = resolvers
      resolvers = []
      for (const r of rs) r({ results: Object.keys(outputs).map((callId) => ({ callId, ok: true, outputs: outputs[callId] })) })
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
  const driver = new RunDriver({ template: tpl, runId: 'r-zombie', request: 'x', store, engine })
  driver.start()
  await sleep(30)
  assert.equal(engine.startCount, 1)
  // 批次在飞时 pause,放行批次 → 循环推进到 gate 挂起
  driver.pause()
  engine.resolveAll({ 'a#-@1:0': { o: 'A' } })
  await sleep(60)
  assert.equal(driver.paused, true)
  assert.equal(driver.finished, false)
  // gate 挂起中 cancel
  driver.cancel()
  await sleep(60)
  const record = store.get('r-zombie')
  const zombie = !driver.finished
  const registryLeft = registry.drivers.has('r-zombie')
  const statusStuck = record.status
  // 4b 僵尸受理消息
  const accepted = driver.handlePost({ kind: 'message', text: '救命' })
  const queuedGrown = (record.queued ?? []).includes('救命')
  if (zombie && registryLeft && statusStuck === 'paused' && accepted && queuedGrown) {
    findings.push(`CONFIRMED 4a/4b pause 后 cancel 在 gate 等待期触发:loop 直接 break,不 finish、driver 不注销、记录停留 paused;此后 post 仍受理且消息只进 queued 永不消费(僵尸 run 吞消息,通知词"已取消"与实际状态不符)`)
  } else {
    findings.push(`PASS 4 cancel 在 gate 期正确收尾(zombie=${zombie} registryLeft=${registryLeft} status=${statusStuck} accepted=${accepted})`)
  }
  registry.drivers.delete('r-zombie')
} catch (e) {
  findings.push(`INCONCLUSIVE 探针异常:${e && e.stack ? e.stack.split('\n')[0] : e}`)
} finally {
  rmSync(root, { recursive: true, force: true })
}
console.log(findings.join('\n'))
