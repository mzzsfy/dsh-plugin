// ai-team L3 HTTP 探针 v2:token 铸 cookie → board 查询投影/中断信封幂等/单任务语义。用法: node probe-ai-team.mjs
import { readFileSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const work = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '.compat', '0.2.0-rc.2')
const live = JSON.parse(readFileSync(join(work, 'live.json'), 'utf8'))
const base = `http://127.0.0.1:${live.port}`
const origin = base

const mint = await fetch(`${base}/?token=${live.token}`, { redirect: 'manual' })
const setCookie = mint.headers.getSetCookie?.() ?? []
const cookie = setCookie.map((c) => c.split(';')[0]).join('; ')
console.log('mint status', mint.status, 'cookie len', cookie.length)

const headers = { cookie, origin, referer: `${base}/` }

async function get(path) {
  const res = await fetch(base + path, { headers })
  return { status: res.status, body: await res.text() }
}
async function post(path, payload, extra = {}) {
  const res = await fetch(base + path, { method: 'POST', headers: { ...headers, 'content-type': 'application/json', ...extra }, body: JSON.stringify(payload) })
  return { status: res.status, body: await res.text() }
}

const commandId = `probe-${Date.now().toString(36)}`
const results = {}
results.board = await get('/api/ai-team/board')
results.interruptGlobal = await post('/api/ai-team/interrupt', { global: true, commandId, payloadHash: 'probe' })
results.interruptGlobalRetry = await post('/api/ai-team/interrupt', { global: true, commandId, payloadHash: 'probe' })
results.interruptUnknownTask = await post('/api/ai-team/interrupt', { taskId: 'nope', commandId: commandId + '-t' })
results.boardAfter = await get('/api/ai-team/board')
results.crossOrigin = await post('/api/ai-team/interrupt', { global: true, commandId: 'x' }, { origin: 'http://evil.example', cookie: '' })

const board1 = JSON.parse(results.board.body)
const retry = JSON.parse(results.interruptGlobalRetry.body)
const board2 = JSON.parse(results.boardAfter.body)
console.log('board', results.board.status, 'counts', JSON.stringify(board1.counts), 'items', board1.items?.length)
console.log('interruptGlobal', results.interruptGlobal.status, results.interruptGlobal.body.slice(0, 160))
console.log('retry generation', retry.globalStopGeneration, 'replayed', retry.replayed)
console.log('unknownTask', results.interruptUnknownTask.status, results.interruptUnknownTask.body.slice(0, 120))
console.log('crossOrigin', results.crossOrigin.status)
console.log('boardAfter globalStopped', board2.envelope ? 'envelope-ok' : 'envelope-missing', 'generation', board2.envelope?.viewRevision)
console.log('activation broken', (() => { try { const a = JSON.parse(results.activation.body); return JSON.stringify(a.brokenPlugins ?? a.broken ?? null) } catch { return 'parse-fail' } })())

writeFileSync(join(work, 'probe-ai-team-out.json'), JSON.stringify(results, null, 2))
