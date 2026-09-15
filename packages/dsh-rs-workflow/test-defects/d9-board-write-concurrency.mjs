// d9:board 写并发
// 猜想 9a:两个 template-save 并发 → settings 读-算-写非原子,后写整表覆盖,先到模板丢失
// 猜想 9b:template-save 与 release 并发 → release 使用入口快照,无共享可变态(证伪预期)
import { EventEmitter } from 'node:events'
import { rmSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import assert from 'node:assert/strict'
import { registerBoardRoutes } from '../lib/board.mjs'

const root = join(tmpdir(), `rsww-t2-d9-${Date.now()}-${Math.random().toString(36).slice(2)}`)
process.env.DSH_RS_WORKFLOW_DATA_DIR = join(root, 'data')
process.env.DSH_HOME = join(root, 'home')
const { reportStore } = await import('../lib/store.mjs')
const findings = []

// settings 桩:barrier 模式下第二个 update 到达才放行,迫使两次读-算-写交错;plain 模式立即生效
function makeSettings(initial) {
  let value = initial
  let mode = 'plain'
  let pending = 0
  let open = null
  return {
    get: () => value,
    setMode: (m) => { mode = m; pending = 0; open = null },
    update: async (ns, patch) => {
      if (mode === 'plain') { value = { ...value, ...patch }; return }
      pending++
      if (pending >= 2) { const r = open; open = null; r?.() }
      await new Promise((r) => { if (pending >= 2) r(); else open = r })
      pending--
      value = { ...value, ...patch }
    },
  }
}
function makeCtx(settingsRef) {
  const routes = new Map()
  const ctx = {
    inject(deps, fn) { fn({ effect: (reg) => reg(), webServer: { register: (r) => routes.set(r.path, r.handler) } }) },
    get: (name) => (name === 'settings' ? settingsRef.current : undefined),
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
const tplOf = (id) => ({ id, json5: `{ id: '${id}', label: 'T${id}', steps: [{ id: 'a', prompt: 'P', outputs: { o: 'o' } }] }` })
try {
  const settingsRef = { current: null }
  const settings = makeSettings({ templates: [] })
  settingsRef.current = settings
  const { routes, ctx } = makeCtx(settingsRef)
  registerBoardRoutes(ctx)
  reportStore() // 提前物化单例(数据目录已钉到临时目录)

  // 9a 并发双保存(barrier 强制交错)
  settings.setMode('barrier')
  const saveA = callPost(routes.get('/api/rsww/template-save'), { id: 'ta', ...tplOf('ta') })
  const saveB = callPost(routes.get('/api/rsww/template-save'), { id: 'tb', ...tplOf('tb') })
  const [ra, rb] = await Promise.all([saveA, saveB])
  settings.setMode('plain')
  const finalIds = (settings.get().templates ?? []).map((t) => t.id).sort()
  const bothOk = ra.body.ok === true && rb.body.ok === true
  if (bothOk && !(finalIds.includes('ta') && finalIds.includes('tb'))) {
    findings.push(`CONFIRMED 9a 并发 template-save 丢失更新:两次请求均返回 ok,settings 最终仅剩 [${finalIds}],先完成写被后完成写整表覆盖——读-算-写窗口无串行化`)
  } else {
    findings.push(`PASS 9a 并发保存无丢失(final=[${finalIds}])`)
  }

  // 9b template-save 与 release 并发
  await callPost(routes.get('/api/rsww/template-save'), { id: 'tc', ...tplOf('tc') })
  const saveC = callPost(routes.get('/api/rsww/template-save'), { id: 'tc', label: 'TC改名', json5: tplOf('tc').json5 })
  const rel = callPost(routes.get('/api/rsww/release'), { id: 'tc' })
  const [rc, rr] = await Promise.all([saveC, rel])
  const flowFile = join(root, 'home', '.agent-presets', 'rs-tc', 'flow.json5')
  const markerFile = join(root, 'home', '.agent-presets', 'rs-tc', '.dsh-rs-workflow-source.json')
  const released = existsSync(flowFile) && existsSync(markerFile)
  const flowText = released ? readFileSync(flowFile, 'utf8') : ''
  const consistent = released && flowText.includes("id: 'tc'")
  if (rr.body.ok === true && rc.body.ok === true && consistent) {
    findings.push('PASS 9b template-save 与 release 并发:release 使用入口快照落盘,产物完整自洽,无损坏(最坏释放旧文案,可接受)')
  } else {
    findings.push(`CONFIRMED 9b 并发保存+释放产物异常(ok=${rr.body?.ok}/${rc.body?.ok} released=${released})`)
  }
} catch (e) {
  findings.push(`INCONCLUSIVE 探针异常:${e && e.stack ? e.stack.split('\n')[0] : e}`)
} finally {
  rmSync(root, { recursive: true, force: true })
}
console.log(findings.join('\n'))
