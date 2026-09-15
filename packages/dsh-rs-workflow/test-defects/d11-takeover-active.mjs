// d11:takeover 会话 active 账与 finish 包装
// 猜想 11a:finish 包装幂等(二次调用无害)(证伪预期)
// 猜想 11b:记录被外部移除后 finish → origFinish 内 store.finish 先置 finished 再抛错,包装中断:active 残留 + driver 不注销,post 恒 false → pre-step 首消息判定 next() 放行,该会话接管永久失效
// 猜想 11c:active 残留 + 僵尸 run(d4)时首消息判定仍受理入队,消息永无消费
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import assert from 'node:assert/strict'
import { createStore } from '../lib/store.mjs'
import { registerTakeover } from '../lib/takeover.mjs'
import { registry, post } from '../lib/driver/control.mjs'

const root = join(tmpdir(), `rsww-t2-d11-${Date.now()}-${Math.random().toString(36).slice(2)}`)
const findings = []
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const makeEngine = () => {
  let pending = []
  return {
    startCount: 0,
    start({ args }) {
      this.startCount++
      const calls = args.calls
      return { result: new Promise((resolve) => pending.push(() => resolve({
        results: calls.map((c) => ({ callId: c.callId, ok: true, outputs: { o: 'x' } })),
      }))) }
    },
    flush() { const p = pending; pending = []; for (const fn of p) fn() },
  }
}
try {
  mkdirSync(join(root, 'data', 'runs'), { recursive: true })
  const store = createStore({ dir: join(root, 'data') })
  const flowFile = join(root, 'flow.json5')
  writeFileSync(flowFile, `{ id: 'tk', label: 'TK', steps: [{ id: 'a', prompt: 'P', outputs: { o: 'o' } }] }`, 'utf8')
  const engine = makeEngine()
  const notes = []
  const ctx = {
    inject(deps, fn) {
      fn({
        workflowEngine: engine,
        effect: (reg) => reg(),
        on: (ev, handler) => { handlers[ev] = handler },
      })
    },
    get: () => undefined,
    logger: { warn: () => {}, error: () => {} },
  }
  const handlers = {}
  const api = registerTakeover(ctx, { flowFile }, { dshHome: root, store })
  const preStep = handlers['agent/pre-step']
  const mkAgent = (id) => ({ id, session: { id: `sess-${id}`, header: {}, append: (k, m) => notes.push(m.content[0].text) } })

  // 11c 僵尸链:发首消息接管 → 在飞时 pause → 放行批次 → gate 挂起 → cancel(成僵尸)→ 再发消息
  const agent = mkAgent('ag1')
  const r1 = preStep({ agent, messages: [{ content: '第一条' }] }, () => 'next')
  assert.equal(r1.kind, 'reject')
  await sleep(30)
  const driver = store.has(api.active.get('ag1').runId) ? registry.drivers.get(api.active.get('ag1').runId) : null
  driver.pause()
  engine.flush()
  await sleep(40)
  driver.cancel()
  await sleep(40)
  const r2 = preStep({ agent, messages: [{ content: '僵尸期消息' }] }, () => 'next')
  const queuedFrozen = store.get(driver.runId).queued?.includes('僵尸期消息')
  findings.push(r2.kind === 'reject' && queuedFrozen && !driver.finished
    ? 'CONFIRMED 11c active 残留僵尸 run:首消息判定只看 post 是否受理,僵尸 driver 仍受理 → reject 主会话,消息冻结 queued 永无消费,会话卡死在无进展编排上'
    : `PASS 11c(active 残留判定正常 r2=${JSON.stringify(r2)} queuedFrozen=${queuedFrozen})`)
  registry.drivers.delete(driver.runId)

  // 11a finish 包装幂等:人为走一遍包装
  const agent2 = mkAgent('ag2')
  const d2 = await api.startRun(agent2, '请求2')
  engine.flush()
  await sleep(40)
  d2.finish('completed', '手动补一次')
  const beforeNotes = notes.length
  d2.finish('completed', '二次')
  const idempotent = notes.length === beforeNotes // active 已清空:二次调用 origFinish no-op 且无通知,零副作用
  findings.push(idempotent
    ? 'PASS 11a finish 包装二次调用幂等(origFinish 有 finished 闸,active 已清空无重复通知)'
    : `CONFIRMED 11a finish 包装二次调用非幂等(notes 增量异常)`)
  api.active.delete('ag2')

  // 11b 记录被移除后的 finish:半完成态 + active 残留 + 接管失效
  const agent3 = mkAgent('ag3')
  const d3 = await api.startRun(agent3, '请求3')
  store.remove(d3.runId)
  let finishThrew = null
  try { d3.finish('failed', '收尾') } catch (e) { finishThrew = e }
  const staleActive = api.active.has('ag3')
  const driverLeft = registry.drivers.has(d3.runId)
  const postFalse = post(d3.runId, { kind: 'message', text: 'x' }) === false
  if (finishThrew && staleActive && driverLeft && postFalse) {
    findings.push('CONFIRMED 11b run-remove 后 finish 抛错且半完成(finished=true 但未注销 driver):active 残留 + post 恒 false → pre-step 判定 next() 放行,该会话接管永久静默失效')
  } else {
    findings.push(`PASS 11b(finishThrew=${!!finishThrew} staleActive=${staleActive} driverLeft=${driverLeft} postFalse=${postFalse})`)
  }
  registry.drivers.delete(d3.runId)
  api.active.delete('ag3')
} catch (e) {
  findings.push(`INCONCLUSIVE 探针异常:${e && e.stack ? e.stack.split('\n')[0] : e}`)
} finally {
  rmSync(root, { recursive: true, force: true })
}
console.log(findings.join('\n'))
