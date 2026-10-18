// Given 全新隔离宿主与公共 echo，When 用户在公司面板讨论，Then 真实会话、工具与历史均留在面板。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { chromium } from 'playwright'
import { expect as playwrightExpect } from 'playwright/test'

const repository = resolve(import.meta.dirname, '../../../..')
const work = resolve(repository, '.compat/0.2.0-rc.2.company-live')
const base = 'http://127.0.0.1:9382'
const officialPlaceholder = '发消息或创建任务, / 调用指令, @ 文件或对话'
const ordinaryPrompt = 'LIVE 普通聊天只讨论，不执行任何任务。'
const firstPrompt = 'LIVE 管理员先讨论项目目标，不授权执行。'
const firstReply = 'LIVE 管理员正在逐字回复。此消息只讨论目标和验收标准，所有工作安排留在公司管理面板。'
const draftPrompt = 'LIVE 创建任务草稿 live-draft-test，先不要授权执行。'
const draftReply = 'LIVE 草稿已通过公司管理工具创建，尚未授权执行。'
const continuedPrompt = 'LIVE 继续讨论刚才的草稿，不执行。'
const continuedReply = 'LIVE 历史已恢复，可以继续在公司管理内讨论。'
const titleInstruction = 'Create a concise title for an AI coding-assistant session from the supplied human messages.'
const titleProvider = 'session-title-first-prompt-llm'
const timeout = 45 * 1000
const expect = playwrightExpect.configure({ timeout })

async function launchBrowser() {
  const errors = []
  for (const options of [{}, { channel: 'chrome' }, { channel: 'msedge' }]) {
    try { return await chromium.launch({ headless: true, ...options }) }
    catch (error) { errors.push(error.message.split('\n')[0]) }
  }
  throw new Error(`无法启动 Chromium：${errors.join('\n')}`)
}

async function json(response, label) {
  const text = await response.text()
  assert.ok(response.ok(), `${label} HTTP ${response.status()}：${text}`)
  return JSON.parse(text)
}

function envelope(endpoint, args) {
  return { type: 'client-request', rpcId: `company-live-${endpoint.replaceAll('/', '-')}-${crypto.randomUUID()}`,
    method: endpoint, path: `/api/${endpoint}`, payload: { args } }
}

function toolNames(request) {
  return request.tools.map(tool => tool.function?.name ?? tool.name)
}
function systemText(request) {
  const body = JSON.parse(request.raw)
  assert.deepEqual(body, request.body, 'HTTP 查询必须保留原始请求 body/raw')
  const messages = (body.messages ?? []).filter(message => ['system', 'developer'].includes(message.role))
  return JSON.stringify([body.system ?? '', ...messages])
}
function requestKind(request) {
  return systemText(request).includes(titleInstruction) ? 'session-title' : 'conversation'
}

async function readHistory(rpc, sessionId) {
  const projection = await rpc('session/projections', { request: { sessionId } })
  assert.ok(projection, '真实会话必须存在')
  const page = await rpc('session/page', { request: {
    address: { kind: 'session', sessionId }, throughSeq: projection.asOfSeq, maxMessages: 100,
  } })
  assert.equal(page.hasMore, false, '本轮短会话应完整包含在一页')
  return page.records
}

function assistant(chat) { return chat.locator('[data-chat-flow-kind="assistant-step"]') }
async function sendOfficial(chat, text) {
  const composer = chat.getByRole('textbox', { name: officialPlaceholder, exact: true })
  await expect(composer).toBeVisible()
  await composer.fill(text)
  await composer.press('Enter')
}
async function openCompany(page) {
  // 全新 home 首启有预览版说明模态；像用户一样先正常关闭，再进入面板。
  const intro = page.getByRole('button', { name: '继续', exact: true })
  await intro.waitFor({ state: 'visible', timeout: 15 * 1000 }).catch(error => { if (error.name !== 'TimeoutError') throw error })
  if (await intro.isVisible()) {
    await intro.click()
    await intro.waitFor({ state: 'hidden', timeout: 10 * 1000 })
  }
  const entry = page.locator('[title="公司管理"]')
  // 预览模态关闭后首次 store 写入可能不驱动主区切换；用户重点一次即恢复，重试直到面板真实挂载。
  await expect(async () => {
    await entry.click({ timeout: 5 * 1000 })
    await expect(page.locator('.bs-root')).toBeVisible({ timeout: 2 * 1000 })
  }).toPass({ timeout: 30 * 1000 })
  await expect(page.getByRole('region', { name: '管理员对话', exact: true })).toBeVisible()
}

// 可证伪：全局泄漏工具、首发跳转、流式被整块替代、工具未落库、刷新自动发言或历史丢失均使场景失败。
test('live-company-workbench-isolates-tools-streams-creates-draft-and-restores-history', { timeout: 5 * 60 * 1000 }, async (t) => {
  assert.equal(process.env.DSH_COMPANY_LIVE_WORK && resolve(process.env.DSH_COMPANY_LIVE_WORK), work,
    '必须由 scripts/compat/company-workbench-live.mjs 启动，禁止直连其他宿主')
  const echoPort = Number(process.env.DSH_COMPANY_LIVE_ECHO_PORT)
  assert.ok(Number.isSafeInteger(echoPort) && echoPort > 0 && echoPort !== 3080 && echoPort !== 9381 && echoPort !== 9382)
  const echoBase = `http://127.0.0.1:${echoPort}`
  const live = JSON.parse(await readFile(resolve(work, 'live.json'), 'utf8'))
  assert.equal(live.port, 9382)
  assert.equal(resolve(live.homeDir), resolve(work, 'home'))
  const run = JSON.parse(await readFile(resolve(work, 'run.json'), 'utf8'))
  assert.equal(run.hostPid, live.pid)
  assert.equal(run.echoPort, echoPort)
  assert.equal(String(run.keeperPid), process.env.DSH_COMPANY_LIVE_KEEPER_PID)
  const evidence = resolve(work, 'live-workbench-evidence')
  await mkdir(evidence, { recursive: true })
  const browser = await launchBrowser()
  const context = await browser.newContext({ locale: 'zh-CN', viewport: { width: 1600, height: 1000 } })
  const page = await context.newPage()
  page.setDefaultTimeout(timeout)
  const browserErrors = []
  const httpFailures = []
  const writes = []
  const observedPrompts = []
  const evidenceState = { phases: [], browserErrors, httpFailures, writes, observedPrompts }
  page.on('console', message => {
    if (message.type() === 'error') browserErrors.push({ kind: 'console', text: message.text(), location: message.location() })
  })
  page.on('pageerror', error => browserErrors.push({ kind: 'pageerror', text: error.message, stack: error.stack }))
  page.on('response', response => {
    if (response.status() >= 400) httpFailures.push({ status: response.status(), url: response.url() })
  })
  page.on('request', request => {
    const pathname = new URL(request.url()).pathname
    if (request.method() !== 'GET' && pathname.startsWith('/api/boss-simulator/')) {
      writes.push({ pathname, method: request.method(), body: request.postDataJSON() })
    }
    if (pathname === '/api/session/prompt') observedPrompts.push(request.postDataJSON())
  })
  t.after(async () => {
    const failures = []
    try {
      evidenceState.echoRequests = await echo('/control/requests?after=0&limit=100')
      evidenceState.requestClassification = evidenceState.echoRequests.requests.map(request => ({ id: request.id, kind: requestKind(request) }))
      await page.screenshot({ path: resolve(evidence, 'final.png'), fullPage: true })
      await writeFile(resolve(evidence, 'page.html'), await page.content())
      await writeFile(resolve(evidence, 'evidence.json'), JSON.stringify(evidenceState, null, 2))
    } catch (error) { failures.push(error) }
    try { await context.close(); await browser.close() } catch (error) { failures.push(error) }
    // 宿主基础设施错误也原样留档并失败，不以白名单吞掉。
    if (browserErrors.length) failures.push(new Error(`console/pageerror 必须零错：${JSON.stringify(browserErrors)}`))
    if (httpFailures.length) failures.push(new Error(`浏览器 HTTP 错误：${JSON.stringify(httpFailures)}`))
    if (failures.length) throw new AggregateError(failures, '真实浏览器留档或零错门槛失败')
  })
  async function rpc(endpoint, args = {}) {
    const body = envelope(endpoint, args)
    const response = await context.request.post(`${base}/api/${endpoint}`, { data: body, headers: { origin: base } })
    const result = await json(response, endpoint)
    assert.equal(result.type, 'server-response')
    assert.equal(result.rpcId, body.rpcId)
    assert.equal(result.result?.ok, true, `${endpoint}：${JSON.stringify(result.result)}`)
    return result.result.value
  }
  async function echo(path, method = 'GET', body) {
    const response = await context.request.fetch(`${echoBase}${path}`, { method, ...(body === undefined ? {} : { data: body }) })
    return json(response, path)
  }
  async function board() { return json(await context.request.get(`${base}/api/boss-simulator/board`), 'board') }
  async function allRequests() {
    const { requests } = await echo('/control/requests?after=0&limit=100')
    assert.ok(requests.length < 100, '生成请求超过留档页容量必须失败')
    return requests
  }
  async function waitRequests(count) {
    await expect.poll(async () => (await allRequests()).filter(request => requestKind(request) === 'conversation').length, { timeout }).toBe(count)
    return (await allRequests()).filter(request => requestKind(request) === 'conversation')
  }
  async function waitTitleComplete(sessionId, prompt) {
    let history
    await expect.poll(async () => {
      history = await readHistory(rpc, sessionId)
      return history.some(({ event }) => event.type === 'session/title' && event.data.source.kind === 'provider' && event.data.source.provider === titleProvider)
    }, { timeout }).toBe(true)
    const events = history.map(record => record.event)
    const starts = events.filter(event => event.type === 'session/title-llm-request')
    const finished = events.filter(event => event.type === 'session/title' && event.data.source.kind === 'provider')
    assert.equal(starts.length, 1, '每个新会话只有首条自动标题请求')
    assert.equal(finished.length, 1, '辅助标题流须真实成功完成，不接受 fallback')
    assert.equal(starts[0].data.titleProvider, titleProvider)
    assert.equal(finished[0].data.source.provider, titleProvider)
    assert.ok(finished[0].seq > starts[0].seq)
    assert.deepEqual(finished[0].data.messageSeqs, starts[0].data.messageSeqs)
    assert.deepEqual(finished[0].data.source.model, { provider: 'echo-openai', model: 'echo-model' })
    const titles = (await allRequests()).filter(request => requestKind(request) === 'session-title' && JSON.stringify(request.messages).includes(prompt))
    assert.equal(titles.length, 1, 'raw 标题请求须与该会话首条消息匹配')
    assert.equal(toolNames(titles[0]).length, 0)
    assert.equal(titles[0].reply?.toolCalls?.length ?? 0, 0, '标题请求不得消费工具回复')
    evidenceState.titleCompletions ??= []
    evidenceState.titleCompletions.push({ sessionId, requestId: titles[0].id, started: starts[0], finished: finished[0] })
  }
  async function waitIdle(sessionId) {
    await expect.poll(async () => {
      const listing = await rpc('session/list', { _request: {} })
      return listing.items.find(item => item.sessionId === sessionId)?.running
    }, { timeout }).toBe(false)
  }

  // 工作区在页面挂载前经真实公开 RPC 建立，避免宿主首次使用在用户 Documents 创建目录。
  await context.request.get(`${base}/?token=${encodeURIComponent(live.token)}`)
  const workspacePath = resolve(work, 'workspace')
  await mkdir(workspacePath)
  const workspaceResult = await rpc('workspace/create', { request: { path: workspacePath } })
  assert.equal(workspaceResult.created, true)
  const workspaceId = workspaceResult.workspace.workspaceId
  assert.ok(workspaceId)
  assert.equal(resolve(workspaceResult.workspace.path), workspacePath)
  evidenceState.workspace = workspaceResult.workspace
  const catalog = await rpc('session/modelCatalog')
  assert.deepEqual(catalog.default, { provider: 'echo-openai', model: 'echo-model' })
  assert.ok(catalog.groups.find(group => group.id === 'echo-openai')?.models.some(model => model.id === 'echo-model'))
  evidenceState.modelCatalog = catalog
  const empty = await board()
  assert.equal(empty.administrator, null)
  assert.deepEqual(empty.items, [])
  assert.equal((await echo('/control/state')).requestCount, 0)

  // Given 普通公开会话，When 真实 prompt，Then 原始 system/tools 中没有公司管理能力。
  await echo('/control/default', 'PUT', { text: 'LIVE 普通聊天回复。' })
  const ordinary = await rpc('session/create', { request: { workspaceId } })
  assert.equal(ordinary.agentPreset, 'standard')
  await rpc('session/prompt', { request: { sessionId: ordinary.sessionId, requestId: crypto.randomUUID(), mode: 'queue', content: [{ type: 'text', text: ordinaryPrompt }] } })
  const [normalRequest] = await waitRequests(1)
  await waitIdle(ordinary.sessionId)
  await waitTitleComplete(ordinary.sessionId, ordinaryPrompt)
  assert.equal(normalRequest.model, 'echo-model')
  assert.equal(toolNames(normalRequest).some(name => /boss_simulator/.test(name)), false)
  assert.doesNotMatch(systemText(normalRequest), /boss_simulator|公司管理控制室/)
  assert.ok(JSON.stringify(normalRequest.messages).includes(ordinaryPrompt))
  assert.ok(JSON.stringify(await readHistory(rpc, ordinary.sessionId)).includes('LIVE 普通聊天回复。'))
  assert.equal((await board()).administrator, null)
  evidenceState.phases.push('ordinary-isolation')

  await page.goto(`${base}/?token=${encodeURIComponent(live.token)}`, { waitUntil: 'domcontentloaded' })
  await page.locator('[title="公司管理"]').waitFor({ state: 'visible' })
  await openCompany(page)
  let chat = page.getByRole('region', { name: '管理员对话', exact: true })
  const firstComposer = chat.getByRole('textbox', { name: '给管理员安排工作', exact: true })
  await expect(firstComposer).toBeVisible()
  await expect(chat.getByRole('button', { name: '发送', exact: true })).toBeDisabled()
  await expect(page.locator('.bs-card')).toHaveCount(0)
  assert.equal(writes.length, 0, '查看空面板不得写入')
  assert.equal((await waitRequests(1)).length, 1)
  assert.equal((await allRequests()).filter(request => requestKind(request) === 'session-title').length, 1)

  // Given 空管理员，When 首条发送，Then 真创建 adminPreset 且 partial→完整回复始终在插件。
  await echo('/control/default', 'PUT', { text: firstReply, stream: { chunkSize: 1, intervalMs: 120 } })
  await firstComposer.fill(firstPrompt)
  const createdResponse = page.waitForResponse(response => new URL(response.url()).pathname === '/api/boss-simulator/admin' && response.request().method() === 'POST')
  await chat.getByRole('button', { name: '发送', exact: true }).click()
  const adminResponse = await createdResponse
  assert.equal(adminResponse.status(), 200)
  const admin = await adminResponse.json()
  assert.equal(admin.ok, true)
  assert.equal(admin.created, true)
  assert.ok(admin.sessionId)
  const [ , adminRequest] = await waitRequests(2)
  assert.equal(adminRequest.model, 'echo-model')
  assert.equal(adminRequest.stream, true)
  assert.ok(toolNames(adminRequest).includes('boss_simulator'))
  assert.ok(JSON.stringify(adminRequest.messages).includes(firstPrompt))
  await expect.poll(async () => {
    const text = await assistant(chat).allTextContents()
    return text.some(value => value.includes('LIVE 管理员') && !value.includes(firstReply))
  }, { timeout }).toBe(true)
  await expect(page.locator('.bs-root')).toBeVisible()
  await page.screenshot({ path: resolve(evidence, 'partial.png'), fullPage: true })
  await expect(assistant(chat).filter({ hasText: firstReply })).toBeVisible()
  await waitIdle(admin.sessionId)
  await waitTitleComplete(admin.sessionId, firstPrompt)
  const adminHistory = await readHistory(rpc, admin.sessionId)
  assert.ok(JSON.stringify(adminHistory).includes(firstPrompt))
  assert.ok(JSON.stringify(adminHistory).includes(firstReply))
  const adminCreated = writes.filter(write => write.pathname.endsWith('/admin'))
  assert.equal(adminCreated.length, 1)
  assert.equal(adminCreated[0].body.action, 'create')
  assert.equal(observedPrompts.length, 1)
  assert.equal(observedPrompts[0].payload.args.request.sessionId, admin.sessionId)
  assert.equal((await board()).administrator, admin.sessionId)
  const adopted = await rpc('session/create', { request: { sessionId: admin.sessionId } })
  assert.equal(adopted.sessionId, admin.sessionId)
  assert.equal(adopted.agentPreset, 'boss-simulator-admin', '首发必须创建真实管理员预设会话')
  evidenceState.adminSessionId = admin.sessionId
  evidenceState.adminHistory = adminHistory
  evidenceState.phases.push('admin-first-stream')

  // Given 管理员真实工具，When echo 队列发 create_task，Then 持久化草稿与看板一致。
  const requestsBeforeTools = await allRequests()
  assert.equal(requestsBeforeTools.filter(request => requestKind(request) === 'session-title').length, 2)
  assert.equal(evidenceState.titleCompletions.length, 2, '两个首条标题均成功终结后才能投 FIFO 工具回复')
  assert.equal((await echo('/control/state')).pendingCount, 0)
  await echo('/control/default', 'PUT', { text: 'LIVE_UNEXPECTED_AUTOMATIC_MESSAGE' })
  await echo('/control/replies', 'POST', { replies: [
    { toolCalls: [{ name: 'boss_simulator', arguments: { tool: 'boss_simulator_create_task', args: {
      taskId: 'live-draft', title: 'live-draft-test', projectWorkspaceId: workspaceId,
      definition: { goal: 'LIVE 验证公司管理内嵌真实对话与草稿创建', acceptanceCriteria: [{ criterionId: 'live-c1', text: '工具创建草稿后在公司管理看板可见，未授权执行' }] },
    } } }] },
    { text: draftReply },
  ] })
  await sendOfficial(chat, draftPrompt)
  const taskRequests = await waitRequests(4)
  await expect(assistant(chat).filter({ hasText: draftReply })).toBeVisible()
  await waitIdle(admin.sessionId)
  assert.ok(toolNames(taskRequests[2]).includes('boss_simulator'))
  assert.equal(taskRequests[2].reply.toolCalls[0].arguments.args.projectWorkspaceId, workspaceId)
  assert.ok(taskRequests[3].messages.some(message => message.role === 'tool'), '工具执行后的真实续轮应含 tool result')
  assert.equal((await echo('/control/state')).pendingCount, 0)
  const newToolRequests = (await allRequests()).filter(request => request.id > requestsBeforeTools.at(-1).id)
  assert.equal(newToolRequests.length, 2, '工具队列只能由建草稿与工具结果续轮消费')
  assert.ok(newToolRequests.every(request => requestKind(request) === 'conversation'))
  assert.equal(newToolRequests[0].id, taskRequests[2].id)
  assert.equal(newToolRequests[1].reply.text, draftReply)
  const draftCard = page.locator('.bs-card').filter({ has: page.locator('.bs-card__id', { hasText: /^live-draft$/ }) })
  await expect(draftCard).toBeVisible()
  await expect(draftCard).toContainText('live-draft-test')
  await expect(draftCard).toContainText('草稿')
  const saved = await board()
  assert.equal(saved.items.length, 1)
  assert.equal(saved.items[0].taskId, 'live-draft')
  assert.equal(saved.items[0].businessState, 'draft')
  assert.equal(saved.items[0].projectWorkspaceId, workspaceId)
  assert.equal(saved.items[0].activeRunCount, 0)
  assert.equal(writes.length, 1, '业务草稿只能由真实工具写入，禁止测试调用 drive/seed')
  await expect(page.locator('.bs-root')).toBeVisible()
  await page.screenshot({ path: resolve(evidence, 'draft.png'), fullPage: true })
  evidenceState.board = saved
  evidenceState.phases.push('real-tool-draft')

  // Given 已有历史，When 刷新重开面板，Then 历史保留且无自动消息；下一次发送复用同一会话。
  const durableBefore = await readHistory(rpc, admin.sessionId)
  const requestsBeforeReload = await allRequests()
  const writesBefore = writes.length
  const promptsBefore = observedPrompts.length
  await page.reload({ waitUntil: 'domcontentloaded' })
  await openCompany(page)
  chat = page.getByRole('region', { name: '管理员对话', exact: true })
  await expect(assistant(chat).filter({ hasText: firstReply })).toBeVisible()
  await expect(assistant(chat).filter({ hasText: draftReply })).toBeVisible()
  await expect(chat.getByRole('textbox', { name: officialPlaceholder, exact: true })).toBeVisible()
  await expect(page.locator('.bs-card')).toHaveCount(1)
  // 有界静默观察覆盖看板轮询周期，证明自动消息没有延迟触发。
  await page.waitForTimeout(4 * 1000)
  assert.deepEqual(await allRequests(), requestsBeforeReload, '刷新不得触发任何会话或辅助标题请求')
  assert.equal(writes.length, writesBefore)
  assert.equal(observedPrompts.length, promptsBefore)
  assert.deepEqual(await readHistory(rpc, admin.sessionId), durableBefore)
  await echo('/control/default', 'PUT', { text: continuedReply, stream: { chunkSize: 2, intervalMs: 30 } })
  await sendOfficial(chat, continuedPrompt)
  const continuedRequests = await waitRequests(5)
  await expect(assistant(chat).filter({ hasText: continuedReply })).toBeVisible()
  await waitIdle(admin.sessionId)
  await expect(page.locator('.bs-root')).toBeVisible()
  assert.ok(toolNames(continuedRequests[4]).includes('boss_simulator'))
  assert.ok(JSON.stringify(continuedRequests[4].messages).includes(firstPrompt), '续轮须携带历史')
  assert.ok(JSON.stringify(continuedRequests[4].messages).includes(draftReply))
  assert.equal(observedPrompts.at(-1).payload.args.request.sessionId, admin.sessionId)
  assert.equal(writes.length, 1, '续轮不得重新创建管理员')
  evidenceState.finalHistory = await readHistory(rpc, admin.sessionId)
  evidenceState.phases.push('reload-no-auto-prompt-and-continue')
})
