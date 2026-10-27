// boss-simulator E2E 编排(隔离环境):铸 cookie → drive 造任务/派发 → 模拟器排队工具报告 → prompt 驱动 → 断言推进。
// 前置: 隔离宿主(9371, DSH_HOME=.compat home)+ 模拟器(18129) 已启动。
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { resolve, dirname } from 'node:path'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const compatWorkspaceCwd = `${repoRoot.replace(/\\/g, '/')}/.compat/0.2.0-rc.2/workspace`

const live = JSON.parse(readFileSync('.compat/0.2.0-rc.2/live.json', 'utf8'))
const base = `http://127.0.0.1:${live.port}`
const mint = await fetch(`${base}/?token=${live.token}`, { redirect: 'manual' })
const cookie = (mint.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]).join('; ')
const h = { cookie, origin: base, 'content-type': 'application/json' }
const post = async (p, b) => {
  const r = await fetch(`${base}/api/boss-simulator/${p}`, { method: 'POST', headers: h, body: JSON.stringify(b) })
  return { status: r.status, body: await r.text() }
}
const get = async (p) => {
  const r = await fetch(`${base}/api/boss-simulator/${p}`, { headers: h })
  return JSON.parse(await r.text())
}

console.log('create:', (await post('drive', { action: 'create', taskId: 't-e2e', title: '端到端任务', projectWorkspaceId: 'ws1', definition: { goal: '端到端目标', acceptanceCriteria: [{ criterionId: 'c1', text: '标准一' }] }, workItemId: 'w1' })).body)
console.log('dispatch:', (await post('drive', { action: 'dispatch', taskId: 't-e2e', workItemId: 'w1', phase: 'implement', runId: 'r1', requestId: 'req-r1', sessionCwd: compatWorkspaceCwd })).body)
const detail = await get('board?taskId=t-e2e')
const sessionId = detail.runs?.[0]?.sessionId
console.log('session:', sessionId)
const queue = await fetch('http://127.0.0.1:18129/control/replies', {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ replies: [
    { toolCalls: [{ name: 'boss_simulator', arguments: { tool: 'boss_simulator_report_result', args: { taskId: 't-e2e', runId: 'r1', reportId: 'rep-1', verdict: 'ready_for_review', coveredCriterionIds: ['c1'] } } }] },
    { text: '报告已提交。' },
  ] }),
})
console.log('queue:', queue.status)
console.log('prompt:', (await post('drive', { action: 'prompt', sessionId, requestId: 'req-cont', content: '请提交你的实施报告' })).body)
await new Promise((done) => setTimeout(done, 12_000))
const board = await get('board')
console.log('counts:', JSON.stringify(board.counts))
console.log('items:', JSON.stringify(board.items?.map((i) => [i.taskId, i.businessState, i.activeRunCount])))
const after = await get('board?taskId=t-e2e')
console.log('runs:', JSON.stringify(after.runs?.map((r) => [r.runId, r.state])))
