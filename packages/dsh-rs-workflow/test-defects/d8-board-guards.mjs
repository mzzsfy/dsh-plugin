// d8:board 路由守卫(control-paused / resume-from 活跃源 / run-remove 活跃源 / config-save 边界)
// 猜想 8a:control 对 paused run 发 message → 按契约受理入队(证伪预期)
// 猜想 8b:resume-from 源 run 仍活跃 → 无守卫直接再启动第二个 run(破坏"同会话同一时刻至多一个 run"不变量)
// 猜想 8c:run-remove 对活跃 run 无守卫 → 记录被删,driver 后续落账即抛错
// 猜想 8d:config-save 空对象/未知顶层键(证伪预期:空对象 no-op,未知顶层键静默忽略)
import { EventEmitter } from 'node:events'
import { rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import assert from 'node:assert/strict'
import { registerBoardRoutes } from '../lib/board.mjs'
import { registerInitiator, registerDriver, registry } from '../lib/driver/control.mjs'

const root = join(tmpdir(), `rsww-t2-d8-${Date.now()}-${Math.random().toString(36).slice(2)}`)
// board 走 reportStore() 单例:用环境变量把数据目录钉到临时目录,避免污染真实数据
process.env.DSH_RS_WORKFLOW_DATA_DIR = root
const { reportStore } = await import('../lib/store.mjs')
const findings = []

function makeSettings(initial) {
  let value = initial
  return {
    get: () => value,
    update: async (ns, patch) => { value = { ...value, ...patch } },
  }
}
function makeCtx(settings) {
  const routes = new Map()
  const ctx = {
    inject(deps, fn) {
      fn({
        effect: (reg) => reg(),
        webServer: { register: (r) => routes.set(r.path, r.handler) },
      })
    },
    get: (name) => (name === 'settings' ? settings : undefined),
  }
  return { routes, ctx }
}
function callPost(handler, body) {
  const req = new EventEmitter()
  req.method = 'POST'
  req.headers = { 'content-type': 'application/json' }
  const res = { code: 0, payload: null, writeHead(c) { this.code = c }, end(p) { this.payload = JSON.parse(p) } }
  const done = handler(req, res)
  req.emit('data', Buffer.from(JSON.stringify(body)))
  req.emit('end')
  return done.then(() => ({ code: res.code, body: res.payload }))
}
try {
  const store = reportStore()
  const tplJson5 = `{ id: 'demo', label: '演示', steps: [{ id: 'a', prompt: 'P', outputs: { o: 'o' } }] }`
  const settings = makeSettings({ templates: [{ id: 'demo', label: '演示', enabled: true, json5: tplJson5 }] })
  const { routes, ctx } = makeCtx(settings)
  registerBoardRoutes(ctx)
  assert.ok(routes.get('/api/rsww/resume-from'))

  // 8a control message 到 paused run:注册一个假 paused driver
  const pausedDriver = { handlePost: (ev) => ev.kind === 'message' }
  registerDriver('r-paused', pausedDriver)
  const r8a = await callPost(routes.get('/api/rsww/control'), { runId: 'r-paused', kind: 'message', text: '插话' })
  findings.push(r8a.body.ok === true
    ? 'PASS 8a control message 到 paused run 受理并入队(契约:paused 未终态,消息排队待恢复后消费)'
    : `CONFIRMED 8a paused run 的消息未受理(${JSON.stringify(r8a.body)})`)

  // 8b resume-from 源 run 仍活跃(store 中 status running 且有 driver 注册)
  store.start({ runId: 'r-live', sessionId: 'sess-1', templateId: 'demo', request: '原始请求' })
  registerDriver('r-live', { handlePost: () => true })
  let launched = 0
  registerInitiator('sess-1', async (payload) => { launched++; return { runId: `r-new-${launched}`, payload } })
  const r8b = await callPost(routes.get('/api/rsww/resume-from'), { runId: 'r-live' })
  findings.push(r8b.code === 200 && r8b.body.ok === true && launched === 1
    ? 'CONFIRMED 8b resume-from 源 run 活跃且有 driver 注册时无任何守卫:直接启动第二个 run——同会话双 run 并发,破坏 takeover"同会话同一时刻至多一个 run"不变量(active 账被覆盖,旧 run 完成通知丢失)'
    : `PASS 8b resume-from 有活跃守卫(${JSON.stringify(r8b.body)})`)

  // 8c run-remove 对活跃 run
  const r8c = await callPost(routes.get('/api/rsww/run-remove'), { runId: 'r-live' })
  let updateThrew = null
  try { store.update({ runId: 'r-live', status: 'running' }) } catch (e) { updateThrew = e }
  findings.push(r8c.body.ok === true && updateThrew
    ? 'CONFIRMED 8c run-remove 对活跃 run 无守卫:记录与文件即删,在跑 driver 下一次落账(store.update/step)即抛"运行记录不存在",loop().catch 内 finish 将二次失败'
    : `PASS 8c run-remove 有活跃守卫(${JSON.stringify(r8c.body)} updateThrew=${!!updateThrew})`)

  // 8d config-save 边界
  const rEmpty = await callPost(routes.get('/api/rsww/config-save'), {})
  const rUnknown = await callPost(routes.get('/api/rsww/config-save'), { unknownTop: 1, slots: { executor: 'm1' } })
  const rBadSlot = await callPost(routes.get('/api/rsww/config-save'), { slots: { ghost: 'x' } })
  const rClamp = await callPost(routes.get('/api/rsww/config-save'), { budgets: { escalateLimit: 0 } })
  const saved = settings.get()
  const emptyNoop = rEmpty.code === 200 && rEmpty.body.ok === true
  const unknownIgnored = rUnknown.code === 200 && rUnknown.body.ok === true && saved.slots?.executor === 'm1' && !('unknownTop' in saved)
  const badSlot400 = rBadSlot.code === 400
  const clampOk = rClamp.code === 200 && saved.budgets?.escalateLimit === 1
  if (emptyNoop && unknownIgnored && badSlot400 && clampOk) {
    findings.push('PASS 8d config-save:空对象合法 no-op,未知顶层键静默忽略(未知槽位键 400,预算 0 clamp 到 1)——无挂死无损坏')
  } else {
    findings.push(`CONFIRMED 8d config-save 边界异常(empty=${rEmpty.code} unknown=${rUnknown.code} badSlot=${rBadSlot.code} clamp=${rClamp.code} saved=${JSON.stringify(saved.budgets)})`)
  }
} catch (e) {
  findings.push(`INCONCLUSIVE 探针异常:${e && e.stack ? e.stack.split('\n')[0] : e}`)
} finally {
  rmSync(root, { recursive: true, force: true })
}
console.log(findings.join('\n'))
