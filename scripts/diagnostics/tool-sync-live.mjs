// 完整隔离宿主双会话实验：仅替换 LLM 上游，插件与工具执行体保持原样。
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import fs from 'node:fs/promises'
import { createWriteStream } from 'node:fs'
import { createServer } from 'node:net'
import path from 'node:path'
import os from 'node:os'
import { setTimeout as delay } from 'node:timers/promises'
import { request as playwrightRequest } from 'playwright'

const repo = path.resolve(import.meta.dirname, '../..')
const host = process.env.TOOL_SYNC_HOST
assert.ok(host, '需设置 TOOL_SYNC_HOST，指向已安装的 @deepseek-ai/dsh 包目录')
const browserSource = process.env.TOOL_SYNC_BROWSER ?? (process.env.DSH_PROFILE_DIR && path.join(process.env.DSH_PROFILE_DIR, 'node_modules/dsh-browser-cdp'))
assert.ok(browserSource, '需设置 TOOL_SYNC_BROWSER 或 DSH_PROFILE_DIR')
const work = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-tool-sync-live-'))
const gate = !process.argv.includes('--without-gate')
const children = []
const streams = []
const evidence = { work, host, gate, phases: [], cleanup: [] }
let context, base, port, echoPort, home
const alive = pid => { try { process.kill(pid, 0); return true } catch { return false } }
const writeJson = (file, data) => fs.writeFile(file, JSON.stringify(data, null, 2) + '\n')
async function freePort(value = 0) {
  const server = createServer()
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(value, '127.0.0.1', resolve) })
  const actual = server.address().port
  await new Promise(resolve => server.close(resolve))
  return actual
}
async function waitFor(check, label, timeout = 150 * 1000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    const value = await check()
    if (value) return value
    await delay(300)
  }
  throw new Error(`等待超时：${label}`)
}
function start(args, logName, env, onData = () => {}) {
  const log = createWriteStream(path.join(work, logName), { flags: 'wx' })
  streams.push(log)
  const child = spawn(process.execPath, args, { cwd: repo, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
  children.push(child)
  child.stdout.pipe(log, { end: false }); child.stderr.pipe(log, { end: false })
  child.stdout.on('data', onData)
  child.settled = new Promise(resolve => { child.once('exit', (code, signal) => resolve({ code, signal })); child.once('error', error => resolve({ error: error.message })) })
  return child
}
async function json(response, label) {
  const text = await response.text()
  assert.ok(response.ok(), `${label} HTTP ${response.status()} ${text}`)
  return JSON.parse(text)
}
async function rpc(method, args = {}) {
  const rpcId = crypto.randomUUID()
  const result = await json(await context.post(`${base}/api/${method}`, {
    headers: { origin: base }, data: { type: 'client-request', rpcId, method, path: `/api/${method}`, payload: { args } }, timeout: 30 * 1000,
  }), method)
  assert.equal(result.result?.ok, true, JSON.stringify(result))
  return result.result.value
}
async function echo(endpoint, method = 'GET', data) {
  return json(await context.fetch(`http://127.0.0.1:${echoPort}${endpoint}`, { method, ...(data === undefined ? {} : { data }) }), endpoint)
}
async function history(sessionId) {
  const projection = await rpc('session/projections', { request: { sessionId } })
  const page = await rpc('session/page', { request: { address: { kind: 'session', sessionId }, throughSeq: projection.asOfSeq, maxMessages: 200 } })
  assert.equal(page.hasMore, false)
  return page.records.map(record => record.event)
}
async function prompt(sessionId, marker) {
  const before = await history(sessionId)
  const seq = before.at(-1)?.seq ?? -1
  const cursor = (await echo('/control/requests/latest'))?.id ?? 0
  const outcome = await rpc('session/prompt', { request: { sessionId, requestId: crypto.randomUUID(), mode: 'queue', content: [{ type: 'text', text: marker }] } })
  assert.equal(outcome.accepted, true)
  const events = await waitFor(async () => {
    const events = (await history(sessionId)).filter(e => e.seq > seq)
    const end = events.find(e => e.type === 'turn/end')
    if (!end) return false
    assert.equal(end.data.reason?.kind, 'completed', JSON.stringify(end))
    return events
  }, `完整回合 ${marker}`)
  const records = (await echo(`/control/requests?after=${cursor}&limit=100`)).requests
    .filter(r => JSON.stringify(r.messages ?? r.body?.messages ?? []).includes(marker))
  assert.ok(records.length, `${marker} 没有上游请求`)
  const phase = { marker, sessionId, events, requests: records }
  evidence.phases.push(phase)
  await writeJson(path.join(work, 'evidence.json'), evidence)
  return phase
}
const names = phase => phase.requests.at(-1).tools.map(t => t.function?.name ?? t.name).sort()
const bcdp = phase => names(phase).filter(n => n.startsWith('bcdp_'))
async function tool(sessionId, name, args, marker) {
  await echo('/control/replies', 'POST', { replies: [{ toolCalls: [{ name, arguments: args }] }, { text: `${marker}_DONE` }] })
  const phase = await prompt(sessionId, marker)
  const call = phase.events.find(e => e.type === 'tool/call' && e.data.name === name)
  assert.ok(call, `${name} 未实际派发`)
  const result = phase.events.find(e => e.type === 'tool/result' && e.data.message?.toolCallId === call.data.callId)
  assert.ok(result, `${name} 没有持久化结果`)
  assert.notEqual(result.data.message.isError, true, JSON.stringify(result))
  phase.toolCall = call; phase.toolResult = result
  return phase
}
async function main() {
  evidence.hostVersion = JSON.parse(await fs.readFile(path.join(host, 'package.json'), 'utf8')).version
  assert.equal(evidence.hostVersion, '0.2.1-rc.2')
  evidence.browserVersion = JSON.parse(await fs.readFile(path.join(browserSource, 'package.json'), 'utf8')).version
  assert.equal(evidence.browserVersion, '1.6.0')
  home = path.join(work, 'home')
  const profile = path.join(home, 'profiles/web')
  await fs.mkdir(path.join(profile, 'node_modules/@mzzsfy'), { recursive: true })
  await fs.cp(browserSource, path.join(profile, 'node_modules/dsh-browser-cdp'), { recursive: true,
    filter: source => !path.relative(browserSource, source).split(path.sep).some(part => ['node_modules', '.git'].includes(part)),
  })
  const targetGate = path.join(profile, 'node_modules/@mzzsfy/dsh-tool-gate')
  await fs.mkdir(targetGate)
  for (const entry of ['src', 'package.json', 'cordis.patch.yml']) await fs.cp(path.join(repo, 'packages/dsh-tool-gate', entry), path.join(targetGate, entry), { recursive: true })
  // 所有外部依赖均来自同一宿主闭包，隔离副本没有包内 devDependencies。
  const modules = path.join(host, 'node_modules')
  for (const entry of await fs.readdir(modules)) {
    if (entry === '.bin') continue
    await fs.symlink(path.join(modules, entry), path.join(profile, 'node_modules', entry), 'junction')
  }
  await writeJson(path.join(profile, 'package.json'), {
    name: 'tool-sync-live-isolated', private: true,
    dependencies: { 'dsh-browser-cdp': '1.6.0', ...(gate ? { '@mzzsfy/dsh-tool-gate': '0.1.1' } : {}) },
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'dsh-browser-cdp', ...(gate ? ['@mzzsfy/dsh-tool-gate'] : [])], patchReload: 'live' } },
  })
  await fs.writeFile(path.join(profile, 'cordis.yml'), '[]\n')
  const env = { ...process.env, DSH_HOME: home, DSH_PROFILE: 'web', DSH_PROFILE_DIR: profile, ECHO_KEY: 'isolated-test-key',
    DSH_CRON_BOARD_DATA_DIR: path.join(work, 'data/cron'), DSH_USAGE_PANEL_DATA_DIR: path.join(work, 'data/usage'),
    DSH_RS_WORKFLOW_DATA_DIR: path.join(work, 'data/workflow'), DSH_RS_WORKFLOW_PRESET_ROOT: path.join(work, 'data/presets'),
    EGO_LINUX_STATE_DIR: path.join(work, 'browser-state'), EGO_LINUX_USER_DATA_DIR: path.join(work, 'browser-data') }
  delete env.DSH_SESSION_ID
  let echoOut = ''
  const simulator = start([path.join(repo, 'scripts/echo-upstream/cli.mjs'), '--port', '0', '--log', path.join(work, 'echo-requests.jsonl')], 'echo.log', env, chunk => {
    echoOut += chunk; echoPort = Number(echoOut.match(/listening 127\.0\.0\.1:(\d+)/)?.[1]) || undefined
  })
  await waitFor(() => { assert.equal(simulator.exitCode, null, 'echo 提前退出'); return echoPort }, 'echo 就绪', 20 * 1000)
  port = await freePort(); assert.notEqual(port, 3080); base = `http://127.0.0.1:${port}`
  await fs.writeFile(path.join(profile, 'cordis.patch.yml'), [
    '- id: session-title-llm', '  disabled: true', '- id: agent-default-model', '  config:', '    provider: echo-openai', '    model: echo-model',
    '- id: llm-pi-ai', '  config:', '    providers:', '      echo-openai:', '        api: openai-completions', `        baseURL: http://127.0.0.1:${echoPort}`, '        apiKeyEnv: ECHO_KEY', '        models:', '          - id: echo-model', '            name: Echo model', '            input: [text]',
    '- id: dsh-browser-cdp', '  config:', '    toolInjection: lazy', '    idleTimeoutMin: 0', '    remoteEnabled: false',
    '- id: hmr', '  disabled: true', '',
  ].join('\n'))
  const boot = start([path.join(host, 'lib/bin.js'), 'web', '--no-open', '--port', String(port)], 'host.log', env)
  evidence.pids = children.map(c => c.pid); evidence.port = port; evidence.echoPort = echoPort
  console.log(JSON.stringify({ work, gate, port, echoPort, pids: evidence.pids }))
  const token = await waitFor(async () => {
    assert.equal(boot.exitCode, null, '宿主提前退出，检查host.log')
    let text
    try { text = await fs.readFile(path.join(work, 'host.log'), 'utf8') }
    catch (error) { if (error.code === 'ENOENT') return false; throw error }
    return [...text.matchAll(/token=([A-Za-z0-9_-]{8,})/g)].at(-1)?.[1]
  }, '宿主token')
  context = await playwrightRequest.newContext({ timeout: 30 * 1000 })
  await waitFor(async () => { try { return (await context.get(`${base}/?token=${token}`)).ok() } catch { return false } }, '宿主HTTP')
  const catalog = await waitFor(async () => { try { const c = await rpc('session/modelCatalog'); return c.groups?.some(g => g.id === 'echo-openai') && c } catch { return false } }, 'echo provider')
  evidence.catalog = catalog
  const workspace = path.join(work, 'workspace'); await fs.mkdir(workspace)
  const a = (await rpc('session/create', { request: { cwd: workspace } })).sessionId
  const b = (await rpc('session/create', { request: { cwd: workspace } })).sessionId
  assert.notEqual(a, b); evidence.sessions = { a, b }
  await echo('/control/default', 'PUT', { text: 'TOOL_SYNC_FINISHED' })
  await prompt(a, 'SYNC_A_BASELINE')
  const baseline = await prompt(b, 'SYNC_B_BASELINE')
  assert.deepEqual(bcdp(baseline), ['bcdp_doctor', 'bcdp_help', 'bcdp_navigate', 'bcdp_script', 'bcdp_snapshot', 'bcdp_space', 'bcdp_status'])
  assert.ok(bcdp(baseline).includes('bcdp_doctor'), '完整browser插件未注册doctor')
  assert.ok(!bcdp(baseline).includes('bcdp_click'), '冷启动已激活click，基线无效')
  if (gate) {
    const searched = await tool(a, 'tool_search', { pattern: '^bcdp_doctor$' }, 'SYNC_A_SEARCH_ONLY')
    const afterSearch = await prompt(b, 'SYNC_B_AFTER_SEARCH')
    assert.deepEqual(afterSearch.requests.at(-1).tools, baseline.requests.at(-1).tools, '仅搜索导致B实际请求schema变化')
    assert.deepEqual(bcdp(afterSearch), bcdp(baseline), '仅搜索导致B浏览器工具面变化')
    const searchText = searched.toolResult.data.message.content.filter(b => b.type === 'text').map(b => b.text).join('\n')
    assert.ok(searchText.includes('bcdp_doctor'), '搜索未返回doctor定义')
    assert.equal(afterSearch.events.some(e => e.type === 'developer/message' && e.data.message?.content?.some(b => b.type === 'tool-addition')), false)
    evidence.searchOnly = { bUnchanged: true, searchResults: searched.toolResult }
  }
  const called = await tool(a, 'bcdp_doctor', {}, 'SYNC_A_DOCTOR')
  const afterCall = await prompt(b, 'SYNC_B_AFTER_DOCTOR')
  const added = bcdp(afterCall).filter(n => !bcdp(baseline).includes(n))
  if (process.argv.includes('--assert-isolated')) {
    assert.deepEqual(afterCall.requests.at(-1).tools, baseline.requests.at(-1).tools, 'A调用doctor改变了B的实际tools数组')
    assert.equal(bcdp(called).length, 24, 'A自身应解锁第一批')
    assert.equal(afterCall.events.some(e => e.type === 'developer/message' && e.data.message?.content?.some(b => b.type === 'tool-addition')), false)
    const second = await tool(a, 'bcdp_help', {}, 'SYNC_A_SECOND')
    assert.equal(bcdp(second).length, 28)
    assert.deepEqual(bcdp(second).filter(n => !bcdp(called).includes(n)), ['bcdp_js', 'bcdp_page_info', 'bcdp_read_element', 'bcdp_screenshot'])
    const third = await tool(a, 'bcdp_help', {}, 'SYNC_A_THIRD')
    assert.equal(bcdp(third).length, 29)
    assert.deepEqual(bcdp(third).filter(n => !bcdp(second).includes(n)), ['bcdp_wait'])
    const bStill = await prompt(b, 'SYNC_B_STILL_COLD')
    assert.deepEqual(bStill.requests.at(-1).tools, baseline.requests.at(-1).tools)
    const c = (await rpc('session/create', { request: { cwd: workspace } })).sessionId
    const cCold = await prompt(c, 'SYNC_C_NEW_COLD')
    assert.deepEqual(cCold.requests.at(-1).tools, baseline.requests.at(-1).tools)
    const bFirst = await tool(b, 'bcdp_help', {}, 'SYNC_B_FIRST_OWN_CALL')
    assert.equal(bcdp(bFirst).length, 24, 'B第一次活动必须从第一批开始')
    const aStill = await prompt(a, 'SYNC_A_UNAFFECTED_BY_B')
    assert.deepEqual(aStill.requests.at(-1).tools, third.requests.at(-1).tools)
    evidence.result = { isolated: true, aCounts: [bcdp(called).length, bcdp(second).length, bcdp(third).length], bFirstCount: bcdp(bFirst).length, newSessionCount: bcdp(cCold).length }
    console.log(JSON.stringify({ gate, ...evidence.result }))
    return
  }
  assert.ok(added.includes('bcdp_click'), '实际doctor调用后B未新增click，原假设不成立')
  assert.equal(added.length, 17, `新增工具与17项预期不符：${JSON.stringify(added)}`)
  const notices = afterCall.events.filter(e => e.type === 'developer/message').flatMap(e => e.data.message?.content ?? [])
    .filter(b => b.type === 'tool-addition').map(b => b.toolName).sort()
  assert.deepEqual(notices, added, 'B的实际请求新增项与持久化通知不一致')
  assert.equal(afterCall.events.some(e => e.type === 'tool/call'), false, 'B对照会话不应执行工具')
  const click = afterCall.requests.at(-1).tools.find(t => (t.function?.name ?? t.name) === 'bcdp_click')
  const clickDescription = (click.function ?? click).description
  assert.equal(clickDescription.includes('延迟加载工具'), gate, '工具门折叠形态与开关不符')
  const doctorText = called.toolResult.data.message.content.filter(b => b.type === 'text').map(b => b.text).join('\n')
  assert.equal(JSON.parse(doctorText).ok, true, 'doctor未成功完成')
  evidence.result = { baselineB: bcdp(baseline), afterDoctorB: bcdp(afterCall), added, notices, clickDescription, doctorResult: called.toolResult }
  console.log(JSON.stringify({ gate, searchOnlyBUnchanged: evidence.searchOnly?.bUnchanged, addedToB: added }))
}
try { await main(); evidence.ok = true } catch (error) { evidence.ok = false; evidence.error = error.stack; console.error(error); process.exitCode = 1 }
finally {
  try { await context?.dispose() }
  catch (error) { evidence.contextCleanupError = error.message; process.exitCode = 1 }
  for (const child of children.reverse()) {
    if (!alive(child.pid)) continue
    if (process.platform === 'win32') {
      const kill = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
      await new Promise(resolve => kill.once('exit', resolve))
    } else child.kill('SIGTERM')
    await child.settled
  }
  for (let pass = 0; pass < 2; pass++) {
    const running = children.filter(c => alive(c.pid)).map(c => c.pid)
    const occupied = []
    for (const value of [port, echoPort].filter(Boolean)) try { await freePort(value) } catch { occupied.push(value) }
    evidence.cleanup.push({ running, occupied })
    if (running.length || occupied.length) process.exitCode = 1
    if (pass === 0) await delay(300)
  }
  evidence.cleanupOk = evidence.cleanup.length === 2 && evidence.cleanup.every(check => check.running.length === 0 && check.occupied.length === 0)
  evidence.ok = evidence.ok === true && evidence.cleanupOk
  for (const stream of streams) await new Promise(resolve => stream.end(resolve))
  await writeJson(path.join(work, 'evidence.json'), evidence)
  console.log(`证据：${path.join(work, 'evidence.json')}`)
}
