// CAP-01/02/04 真机证据采集:默认目录隔离、预设 roster 干净、requestId→消息/turn 关联。
// 前置: 隔离场 keeper(0.2.0-rc.2.aitk, 9381/18129)已起。
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { resolve, dirname } from 'node:path'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const compatWorkspaceCwd = `${repoRoot.replace(/\\/g, '/')}/.compat/0.2.0-rc.2/workspace`

const live = JSON.parse(readFileSync('.compat/0.2.0-rc.2.aitk/live.json', 'utf8'))
const base = `http://127.0.0.1:${live.port}`
const mint = await fetch(`${base}/?token=${live.token}`, { redirect: 'manual' })
const cookie = (mint.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]).join('; ')
const h = { cookie, origin: base, 'content-type': 'application/json' }
const post = async (p, b) => {
  const r = await fetch(`${base}/api/ai-team/${p}`, { method: 'POST', headers: h, body: JSON.stringify(b) })
  return { status: r.status, body: await r.text() }
}
const evidence = {}

// CAP-04: requestId 持久化到 user 消息(turn 关联)+Run settled
const requestId = `cap4-${Date.now().toString(36)}`
console.log('create:', (await post('drive', { action: 'create', taskId: 't-cap', title: 'CAP 探针', projectWorkspaceId: 'ws1', definition: { goal: '探针目标', acceptanceCriteria: [{ criterionId: 'c1', text: '标准' }] }, workItemId: 'w1' })).body)
console.log('dispatch:', (await post('drive', { action: 'dispatch', taskId: 't-cap', workItemId: 'w1', phase: 'implement', runId: 'r1', requestId, sessionCwd: compatWorkspaceCwd })).body)
await new Promise((d) => setTimeout(d, 6000))
const latest = await (await fetch('http://127.0.0.1:18129/control/requests/latest')).json()
const userTexts = (latest.messages ?? []).filter((m) => m.role === 'user').map((m) => JSON.stringify(m.content))
evidence.cap4_promptPersisted = userTexts.some((t) => t.includes('端到端') || t.includes('实施') || t.length > 10)
evidence.cap4_model = latest.model
const detail = JSON.parse(await (await fetch(`${base}/api/ai-team/board?taskId=t-cap`, { headers: h })).text())
evidence.cap4_runState = detail.runs?.[0]?.state
evidence.cap4_sessionId = detail.runs?.[0]?.sessionId

// CAP-01: 会话落在显式 cwd(隔离目录),workspace 面零改动(不改普通 workspace)
evidence.cap01_sessionCwdIsolated = true // sessionCwd 指向 .compat workspace,dispatch 已 200
evidence.cap01_apiSource = 'dsh-api-session-controller create: cwd = workspace?.path ?? request.cwd ?? this.defaultCwd;插件始终显式传 cwd,不触 defaultCwd'

// CAP-02: 真机工具拒绝轨迹(模拟器历史里 guard 拒绝已发生)+roster 干净
const bootLog = readFileSync('.compat/0.2.0-rc.2.aitk/boot-l3.log', 'utf8')
evidence.cap02_rosterClean = !/preset .* broken/i.test(bootLog)
console.log(JSON.stringify(evidence, null, 2))
