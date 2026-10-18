// Given 全新隔离宿主与 echo，When 唯一管理员安排任务，Then 标准实施/验收会话的 durable 报告驱动结案。
// 用法：node scripts/compat/company-entry-live.mjs [--host-dir <已安装隔离宿主闭包>]
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createServer } from 'node:net'
import { createWriteStream } from 'node:fs'
import { access, mkdir, readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { chromium } from 'playwright'

const repository = resolve(import.meta.dirname, '../..')
const hostVersion = '0.2.0-rc.2'
const version = `${hostVersion}.company-entry-${Date.now()}-${process.pid}`
const work = resolve(repository, '.compat', version)
const options = process.argv.slice(2)
assert.ok(options.length === 0 || (options.length === 2 && options[0] === '--host-dir'), '参数仅支持 --host-dir <已安装隔离宿主闭包>')
const host = resolve(repository, options[1] ?? `.compat/${hostVersion}/dsh-host`)
const timeout = 90 * 1000
const children = []
const logs = []
const evidence = { version, host, phases: [], toolResults: [], durableReports: [], cleanup: [] }
let port, echoPort, hostPid, keeper, browser, context, base, stopped, signalFailure

function alive(pid) {
  if (!pid) return false
  try { process.kill(pid, 0); return true } catch (error) { if (error.code === 'ESRCH') return false; throw error }
}
async function bindPort(value = 0) {
  const server = createServer()
  await new Promise((done, reject) => { server.once('error', reject); server.listen(value, '127.0.0.1', done) })
  const actual = server.address().port
  await new Promise((done, reject) => server.close(error => error ? reject(error) : done()))
  return actual
}
function start(args, logName, onStdout = () => {}) {
  if (signalFailure || stopped) throw signalFailure ?? new Error('已停止，拒绝启动新进程')
  const log = createWriteStream(resolve(work, logName), { flags: 'wx' })
  logs.push(log)
  const child = spawn(process.execPath, args, {
    cwd: repository, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, DSH_HOME: resolve(work, 'home'), ECHO_KEY: 'echo-compat' },
  })
  children.push(child)
  child.stdout.pipe(log, { end: false })
  child.stderr.pipe(log, { end: false })
  child.stdout.on('data', onStdout)
  child.settled = new Promise(done => {
    child.once('error', error => done({ error }))
    child.once('exit', (code, signal) => done({ code, signal }))
  })
  return child
}
async function waitFor(check, label, maximum = timeout) {
  const deadline = Date.now() + maximum
  while (Date.now() < deadline) {
    if (signalFailure) throw signalFailure
    const result = await check()
    if (result) return result
    await delay(250)
  }
  throw new Error(`${label}超时`)
}
async function bounded(promise, maximum, label) {
  let timer
  try {
    return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(label)), maximum) })])
  } finally { clearTimeout(timer) }
}
async function killPid(pid) {
  if (!alive(pid)) return
  if (process.platform === 'win32') {
    const child = spawn('taskkill.exe', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
    await new Promise((done, reject) => {
      child.once('error', reject)
      child.once('exit', code => code === 0 || !alive(pid) ? done() : reject(new Error(`无法停止本次进程树 ${pid}`)))
    })
  } else process.kill(pid, 'SIGKILL')
}
async function readLive(previousPid) {
  return waitFor(async () => {
    if (keeper.exitCode !== null) throw new Error(`keeper 早退 ${keeper.exitCode}`)
    let live
    try { live = JSON.parse(await readFile(resolve(work, 'live.json'), 'utf8')) }
    catch (error) { if (error.code === 'ENOENT' || error instanceof SyntaxError) return false; throw error }
    assert.equal(live.port, port)
    assert.equal(resolve(live.homeDir), resolve(work, 'home'))
    assert.deepEqual(live.bundles.slice().sort(), ['@mzzsfy/dsh-boss-simulator', '@mzzsfy/dsh-llm-pi-gateway'].sort())
    assert.ok(Number.isSafeInteger(live.pid) && live.pid > 0)
    if (live.pid === previousPid || !alive(live.pid)) return false
    hostPid = live.pid
    return live
  }, '隔离宿主就绪', 10 * 60 * 1000)
}
async function responseJson(response, label) {
  const text = await response.text()
  assert.ok(response.ok(), `${label} HTTP ${response.status()}：${text}`)
  return JSON.parse(text)
}
async function rpc(endpoint, args = {}) {
  const rpcId = `company-entry-${crypto.randomUUID()}`
  const response = await context.request.post(`${base}/api/${endpoint}`, {
    headers: { origin: base }, timeout,
    data: { type: 'client-request', rpcId, method: endpoint, path: `/api/${endpoint}`, payload: { args } },
  })
  const result = await responseJson(response, endpoint)
  assert.equal(result.type, 'server-response')
  assert.equal(result.rpcId, rpcId)
  assert.equal(result.result?.ok, true, `${endpoint}：${JSON.stringify(result.result)}`)
  return result.result.value
}
async function echo(path, method = 'GET', body) {
  return responseJson(await context.request.fetch(`http://127.0.0.1:${echoPort}${path}`, {
    method, ...(body === undefined ? {} : { data: body }), timeout,
  }), path)
}
async function detail(taskId) {
  return responseJson(await context.request.get(`${base}/api/boss-simulator/board?taskId=${encodeURIComponent(taskId)}`, { timeout }), '任务详情')
}
async function history(sessionId) {
  const projection = await rpc('session/projections', { request: { sessionId } })
  const page = await rpc('session/page', { request: { address: { kind: 'session', sessionId }, throughSeq: projection.asOfSeq, maxMessages: 200 } })
  assert.equal(page.hasMore, false, '会话超过本脚本证据页容量')
  return page.records.map(record => record.event)
}
function textOf(content) { return (content ?? []).filter(block => block.type === 'text').map(block => block.text).join('\n') }
function requestTurn(events, requestId) {
  const user = events.find(event => event.type === 'user/message' && event.data.source?.rpcId === requestId)
  if (!user) return null
  // user/message 的 data 就是 UserMessage，turn 由它前置的 turn/start 决定。
  const start = events.filter(event => event.type === 'turn/start' && event.seq < user.seq).at(-1)
  assert.ok(start, '真实用户消息前必须存在 turn/start')
  return { user, turn: start.data.turn }
}
async function idleAndTitle(sessionId) {
  await waitFor(async () => {
    const listing = await rpc('session/list', { _request: {} })
    if (listing.items.find(item => item.sessionId === sessionId)?.running !== false) return false
    const events = await history(sessionId)
    const titleStarts = events.filter(event => event.type === 'session/title-llm-request')
    const titleEnds = events.filter(event => event.type === 'session/title' && event.data.source?.kind === 'provider')
    return titleStarts.length === 1 && titleEnds.length === 1 && titleEnds[0].seq > titleStarts[0].seq
  }, `会话 ${sessionId} 正文与辅助标题结束`)
}
async function prompt(sessionId, text) {
  const requestId = crypto.randomUUID()
  const outcome = await rpc('session/prompt', { request: { sessionId, requestId, mode: 'queue', content: [{ type: 'text', text }] } })
  assert.equal(outcome.accepted, true)
  await waitFor(async () => {
    const events = await history(sessionId)
    evidence.lastPromptObservation = { sessionId, requestId, events }
    const association = requestTurn(events, requestId)
    if (!association) return false
    const ending = events.find(event => event.type === 'turn/end' && event.data.turn === association.turn)
    if (!ending) return false
    assert.equal(ending.data.reason?.kind, 'completed', `请求 ${requestId} 未正常结束：${JSON.stringify(ending)}`)
    return true
  }, `请求 ${requestId} 的 durable 用户消息与对应回合结束`)
  return requestId
}
async function tool(adminId, action, args, defaultText = 'COMPANY_ENTRY_TOOL_COMPLETE') {
  await echo('/control/default', 'PUT', { text: defaultText })
  assert.equal((await echo('/control/state')).pendingCount, 0)
  const before = await history(adminId)
  const through = before.at(-1)?.seq ?? -1
  // 只排管理员这一条工具回复；worker、管理员续轮及辅助标题均消费无工具 default。
  await echo('/control/replies', 'POST', { toolCalls: [{ name: 'boss_simulator', arguments: { tool: action, args } }] })
  const requestId = await prompt(adminId, `COMPANY_ENTRY ${action}：按本条用户授权与指定参数完成管理操作。`)
  await idleAndTitle(adminId)
  const events = (await history(adminId)).filter(event => event.seq > through)
  const association = requestTurn(events, requestId)
  assert.ok(association, '管理员工具必须由本次真实用户 prompt 触发')
  const call = events.find(event => event.type === 'tool/call' && event.data.name === 'boss_simulator' && event.data.turn === association.turn)
  assert.ok(call, `未发生真实管理工具调用 ${action}`)
  assert.equal(JSON.parse(call.data.arguments).tool, action)
  const result = events.find(event => event.type === 'tool/result' && event.data.message?.toolCallId === call.data.callId)
  assert.ok(result, `管理工具 ${action} 未产生 durable result`)
  assert.notEqual(result.data.message.isError, true, JSON.stringify(result))
  assert.equal(result.data.error, undefined, JSON.stringify(result))
  const value = JSON.parse(textOf(result.data.message.content))
  assert.equal(value.ok, true, JSON.stringify(value))
  assert.equal((await echo('/control/state')).pendingCount, 0)
  evidence.toolResults.push({ action, requestId, call, result, value })
  return value
}
async function checkRoster() {
  const roster = await rpc('agentPresets/list')
  const company = roster.presets.filter(preset => /^(?:boss-simulator|ai-team)(?:-|$)/.test(preset.id))
  assert.deepEqual(company.map(preset => preset.id), ['boss-simulator-admin'])
  assert.ok(roster.presets.every(preset => preset.broken === undefined), JSON.stringify(roster))
  assert.equal(roster.presets.find(preset => preset.isDefault)?.id, 'standard')
  const declaration = await rpc('agentPresets/read', { agentPreset: 'boss-simulator-admin' })
  assert.match(declaration.content, /role: tools-row/)
  evidence.roster = roster
  evidence.declaration = declaration
}
async function checkRun(taskId, runId, requestId, verdict) {
  const task = await waitFor(async () => {
    const current = await detail(taskId)
    return current.runs.find(run => run.runId === runId)?.state === 'settled' ? current : false
  }, `${runId} durable 报告归并`)
  const run = task.runs.find(item => item.runId === runId)
  const report = task.reports.find(item => item.runId === runId)
  assert.ok(report)
  assert.equal(report.verdict, verdict)
  assert.equal(report.historical, false)
  const session = await rpc('session/create', { request: { sessionId: run.sessionId, workspaceId: task.projectWorkspaceId } })
  assert.equal(session.agentPreset, 'standard')
  await idleAndTitle(run.sessionId)
  const events = await history(run.sessionId)
  const association = requestTurn(events, requestId)
  assert.ok(association)
  const { user, turn } = association
  const assistant = events.find(event => event.type === 'assistant/message' && `${run.sessionId}:${event.seq}` === report.reportId)
  assert.ok(assistant, '报告 ID 必须指向真实 durable assistant 事件')
  assert.equal(assistant.data.turn, turn)
  assert.notEqual(assistant.data.interrupted, true)
  const ending = events.find(event => event.type === 'turn/end' && event.data.turn === turn)
  assert.equal(ending?.data.reason?.kind, 'completed')
  const body = JSON.parse(textOf(assistant.data.message.content))
  assert.equal(body.verdict, verdict)
  assert.deepEqual(body.coveredCriterionIds, ['c1'])
  const { requests } = await echo('/control/requests?after=0&limit=100')
  assert.ok(requests.length < 100, 'echo 留档超过本脚本证据页容量')
  const workerRequests = requests.filter(request => (request.messages ?? []).some(message => message.role === 'user' && JSON.stringify(message.content).includes(`COMPANY_ENTRY_WORKER_${runId}`)))
  assert.ok(workerRequests.length > 0)
  for (const request of workerRequests) {
    assert.equal(request.model, 'echo-model')
    assert.equal(request.tools.some(item => (item.function?.name ?? item.name) === 'boss_simulator'), false)
  }
  evidence.durableReports.push({ run, report, user, assistant, ending, workerRequests })
  return { run, report, task }
}
async function launchBrowser() {
  const errors = []
  for (const settings of [{}, { channel: 'chrome' }, { channel: 'msedge' }]) {
    try { return await chromium.launch({ headless: true, ...settings }) }
    catch (error) { errors.push(error.message.split('\n')[0]) }
  }
  throw new Error(`Chromium 不可用：${errors.join('\n')}`)
}
async function stop() {
  if (stopped) return stopped
  stopped = (async () => {
    const errors = []
    try { await browser?.close() } catch (error) { errors.push(error) }
    if (keeper?.pid && alive(keeper.pid)) {
      try {
        await writeFile(resolve(work, 'boot-keep.stop'), 'stop\n', { flag: 'wx' })
        await bounded(keeper.settled, 20 * 1000, 'keeper 停止超时')
      } catch (error) { errors.push(error); try { await killPid(keeper.pid) } catch (failure) { errors.push(failure) } }
    }
    for (const pid of [...new Set([hostPid, ...children.map(child => child.pid)].filter(Boolean))]) {
      try { await killPid(pid) } catch (error) { errors.push(error) }
    }
    for (let pass = 1; pass <= 2; pass += 1) {
      const running = [...new Set([hostPid, ...children.map(child => child.pid)].filter(Boolean))].filter(alive)
      const occupied = []
      for (const value of [port, echoPort].filter(Boolean)) {
        try { await bindPort(value) } catch (error) { occupied.push({ port: value, error: error.message }) }
      }
      evidence.cleanup.push({ pass, running, occupied })
      if (running.length || occupied.length) errors.push(new Error(`清理复查失败 ${JSON.stringify(evidence.cleanup.at(-1))}`))
      if (pass === 1) await delay(500)
    }
    if (errors.length) throw new AggregateError(errors, '隔离进程未全部清理')
  })()
  return stopped
}
async function main() {
  await access(resolve(host, 'node_modules/@deepseek-ai/dsh/lib/bin.js'))
  const manifest = JSON.parse(await readFile(resolve(host, 'node_modules/@deepseek-ai/dsh/package.json'), 'utf8'))
  assert.equal(manifest.version, hostVersion, '仅复用指定版本的隔离闭包')
  await mkdir(work)
  const onSignal = signal => { signalFailure = new Error(`收到 ${signal}`); void stop().catch(console.error) }
  const onInt = () => onSignal('SIGINT'), onTerm = () => onSignal('SIGTERM')
  process.once('SIGINT', onInt)
  process.once('SIGTERM', onTerm)
  let failure
  try {
    port = await bindPort()
    assert.notEqual(port, 3080)
    base = `http://127.0.0.1:${port}`
    let stdout = ''
    const simulator = start(['scripts/echo-upstream/cli.mjs', '--port', '0', '--log', resolve(work, 'llm-echo.jsonl')], 'echo.log', chunk => {
      stdout += chunk
      echoPort = Number(stdout.match(/listening 127\.0\.0\.1:(\d+)/)?.[1]) || undefined
    })
    await waitFor(() => { if (simulator.exitCode !== null) throw new Error('echo 早退'); return echoPort }, 'echo 随机端口', 20 * 1000)
    keeper = start(['scripts/compat/boot-keep.mjs', '--daemon', '--version', version, '--host-dir', host,
      '--only', 'dsh-boss-simulator,dsh-llm-pi-gateway', '--port', String(port), '--llm-port', String(echoPort),
      '--refuse-port-owner', '--keep-sessions'], 'keeper.log')
    const live = await readLive()
    evidence.initialLive = live
    evidence.ports = { port, echoPort }
    browser = await launchBrowser()
    context = await browser.newContext({ locale: 'zh-CN' })
    const authenticated = await context.request.get(`${base}/?token=${encodeURIComponent(live.token)}`, { timeout })
    assert.ok(authenticated.ok(), `隔离宿主认证 HTTP ${authenticated.status()}`)
    const workspacePath = resolve(work, 'workspace')
    await mkdir(workspacePath)
    const workspace = await rpc('workspace/create', { request: { path: workspacePath } })
    assert.equal(workspace.created, true)
    evidence.workspace = workspace.workspace
    const catalog = await rpc('session/modelCatalog')
    assert.deepEqual(catalog.default, { provider: 'echo-openai', model: 'echo-model' })
    assert.ok(catalog.groups.some(group => group.id === 'echo-openai' && group.models.some(model => model.id === 'echo-model')))
    evidence.catalog = catalog
    await checkRoster()
    const admin = await responseJson(await context.request.post(`${base}/api/boss-simulator/admin`, { headers: { origin: base }, data: { action: 'create' }, timeout }), '管理员入口')
    assert.equal(admin.ok, true)
    const adminId = admin.sessionId
    assert.equal((await rpc('session/create', { request: { sessionId: adminId } })).agentPreset, 'boss-simulator-admin')
    evidence.adminId = adminId
    await echo('/control/default', 'PUT', { text: 'COMPANY_ENTRY 管理员已准备，仅讨论不执行。' })
    await prompt(adminId, 'COMPANY_ENTRY 先准备管理员对话，等待下一条明确任务授权。')
    await idleAndTitle(adminId)
    const taskId = 'company-entry-task'
    await tool(adminId, 'boss_simulator_create_task', { taskId, title: '公司管理真实闭环', projectWorkspaceId: workspace.workspace.workspaceId,
      definition: { goal: '验证唯一管理入口驱动标准会话与 durable 报告', scope: '仅本次隔离测试工作区', acceptanceCriteria: [{ criterionId: 'c1', text: '实施与独立验收结果均从真实宿主事件归并' }] } })
    assert.equal((await detail(taskId)).businessState, 'draft')
    await tool(adminId, 'boss_simulator_define_workitem', { taskId, workItemId: 'w1', title: '隔离验证项', requiredCriterionIds: ['c1'] })
    const authorizationRequest = await prompt(adminId, 'COMPANY_ENTRY 明确授权：在本次隔离工作区执行公司单入口链路验证；范围仅为模拟会话，不修改文件；验收标准 c1 为实施与独立验收报告从真实宿主事件归并。允许实施、独立验收及通过后结案。')
    await idleAndTitle(adminId)
    const source = requestTurn(await history(adminId), authorizationRequest)?.user
    assert.ok(source)
    await tool(adminId, 'boss_simulator_authorize_task', { taskId, sourceMessageRef: { sessionId: adminId, eventSeq: source.seq } })
    assert.equal((await detail(taskId)).businessState, 'ready')
    evidence.phases.push('real-roster-admin-create-define-authorize')
    const reportText = verdict => JSON.stringify({ summary: 'COMPANY_ENTRY 结构化阶段报告', verdict, coveredCriterionIds: ['c1'], issues: [], evidence: ['本次隔离宿主真实会话事件'] })
    await tool(adminId, 'boss_simulator_dispatch_run', { taskId, workItemId: 'w1', runId: 'implementation', requestId: 'company-entry-implement', phase: 'implement', content: 'COMPANY_ENTRY_WORKER_implementation：只验证隔离链路，不修改任何文件。' }, reportText('ready_for_review'))
    const implementation = await checkRun(taskId, 'implementation', 'company-entry-implement', 'ready_for_review')
    assert.equal(implementation.task.businessState, 'awaiting_acceptance')
    evidence.phases.push('standard-implementation-durable-report')
    // 已结算后冷重启，验证 JSON 持久化复读；不把此场景当成未结 Run 的 follow 恢复证明。
    const beforeRestart = await detail(taskId)
    const oldPid = hostPid
    await killPid(oldPid)
    const restarted = await readLive(oldPid)
    evidence.restartedLive = restarted
    await context.clearCookies()
    const reauthenticated = await context.request.get(`${base}/?token=${encodeURIComponent(restarted.token)}`, { timeout })
    assert.ok(reauthenticated.ok(), `冷启动认证 ${reauthenticated.status()}`)
    await checkRoster()
    const afterRestart = await detail(taskId)
    assert.equal(afterRestart.businessState, beforeRestart.businessState)
    assert.deepEqual(afterRestart.reports, beforeRestart.reports)
    assert.deepEqual(afterRestart.runs, beforeRestart.runs)
    await idleAndTitle(adminId)
    evidence.phases.push('cold-restart-persisted-report')
    await tool(adminId, 'boss_simulator_dispatch_run', { taskId, workItemId: 'w1', runId: 'acceptance', requestId: 'company-entry-accept', phase: 'accept', content: 'COMPANY_ENTRY_WORKER_acceptance：独立验证隔离链路，不修改任何文件。' }, reportText('pass'))
    const acceptance = await checkRun(taskId, 'acceptance', 'company-entry-accept', 'pass')
    assert.notEqual(acceptance.run.sessionId, implementation.run.sessionId)
    assert.notEqual(acceptance.run.sessionId, adminId)
    assert.notEqual(implementation.run.sessionId, adminId)
    await tool(adminId, 'boss_simulator_close_task', { taskId, passReportId: acceptance.report.reportId, conclusion: '真实独立验收报告通过' })
    const final = await detail(taskId)
    assert.equal(final.businessState, 'completed')
    assert.equal(final.activeRunCount, 0)
    assert.equal(final.reports.length, 2)
    evidence.final = final
    evidence.phases.push('independent-standard-acceptance-and-close')
    evidence.adminHistory = await history(adminId)
    evidence.echoRequests = await echo('/control/requests?after=0&limit=100')
    assert.ok(evidence.echoRequests.requests.length < 100)
    assert.ok(evidence.echoRequests.requests.every(request => request.model === 'echo-model'))
    const page = await context.newPage()
    await page.goto(base, { waitUntil: 'domcontentloaded', timeout })
    await page.screenshot({ path: resolve(work, 'final.png'), fullPage: true })
  } catch (error) { failure = error; evidence.failure = { message: error.message, stack: error.stack } }
  finally {
    try { await stop() } catch (error) { failure = failure ? new AggregateError([failure, error], '验证与清理失败') : error }
    process.removeListener('SIGINT', onInt)
    process.removeListener('SIGTERM', onTerm)
    await Promise.all(logs.map(log => new Promise(done => log.end(done))))
    await writeFile(resolve(work, 'evidence.json'), JSON.stringify(evidence, null, 2), { flag: 'wx' })
  }
  console.log(`公司单入口闭环证据：${work}`)
  if (failure) throw failure
}
main().catch(error => { console.error(error); process.exitCode = 1 })
