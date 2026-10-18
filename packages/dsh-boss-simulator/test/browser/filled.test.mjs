import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { readFile, readdir, mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { Readable } from 'node:stream'
import { chromium } from 'playwright'
import { expect } from 'playwright/test'
import { createBoardApi } from '../../lib/board.mjs'
import { makeSeedBoard } from '../fixtures/seed-board.mjs'
import { createSettings } from '../../lib/core/settings.mjs'

const repository = resolve(import.meta.dirname, '../../../..')
const evidenceDir = resolve(repository, '.compat/0.2.0-rc.2.aitk/frontend-evidence')
let browser
let live

before(async () => {
  live = JSON.parse(await readFile(resolve(repository, '.compat/0.2.0-rc.2.aitk/live.json'), 'utf8'))
  assert.equal(live.port, 9381, '浏览器测试仅允许专用隔离端口')
  assert.equal(resolve(live.homeDir), resolve(repository, '.compat/0.2.0-rc.2.aitk/home'))
  await mkdir(evidenceDir, { recursive: true })
  browser = await chromium.launch({ headless: true, channel: 'chrome' })
})
after(async () => { await browser?.close() })

async function mount(t, options = {}) {
  const fixture = makeSeedBoard()
  if (options.taskCount) {
    for (let index = fixture.tasks.length; index < options.taskCount; index += 1) {
      const copy = JSON.parse(JSON.stringify(fixture.tasks[index % 14]))
      copy.taskId = `fixture-extra-${index}`
      copy.title = `${copy.title} ${copy.taskId}`
      copy.createdAt += index
      fixture.tasks.push(copy)
    }
  }
  const records = new Map(fixture.tasks.map((task) => [task.taskId, task]))
  let control = { ...fixture.globalControl, now: () => Date.now() }
  let settings = createSettings(() => 123)
  const writes = []
  const requests = []
  const errors = []
  const expectedHttpErrors = []
  let adminBinding = options.adminBinding ?? null
  const store = {
    settings: true,
    listAggregates: async () => [...records.values()],
    loadAggregate: async (id) => records.get(id),
    saveAggregate: async (task) => records.set(task.taskId, task),
    updateAggregate: async (id, change) => records.set(id, await change(records.get(id))),
    loadControl: async () => control,
    updateControl: async (change) => { control = { ...(await change(control)), now: control.now }; return control },
    loadSettings: async () => settings,
    updateSettings: async (change) => { settings = await change(settings); return settings },
    loadAdminBinding: async () => adminBinding,
    updateAdminBinding: (change) => { adminBinding = change(adminBinding); return adminBinding },
  }
  let sessionCache = []
  let stubSessionId = null
  // stub 会话适配:ensureSession 返回宿主目录可见会话(导航可验证);prompt 调用即失败,钉住"创建不发消息"
  const adminDrive = options.adminAdapter ? { sessionAdapter: { ensureSession: async () => ({ sessionId: stubSessionId ?? sessionCache[0] }), dispatchPrompt: async () => { throw new Error('管理员入口禁止发送消息') } } } : undefined
  const api = createBoardApi({ store, drive: adminDrive })
  const context = await browser.newContext({ viewport: { width: 1500, height: 960 }, locale: 'zh-CN', reducedMotion: 'reduce' })
  const page = await context.newPage()
  page.on('pageerror', (error) => errors.push(error.message))
  page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()) })
  t.after(async () => {
    await page.screenshot({ path: resolve(evidenceDir, `${t.name.replace(/[^a-zA-Z0-9-]/g, '_')}.png`) })
    await context.close()
    const unexpected = errors.filter((message) => !expectedHttpErrors.some((status) => message === `Failed to load resource: the server responded with a status of ${status} (Conflict)`))
    assert.deepEqual(unexpected, [], '真实浏览器不得有未预期的 console/pageerror')
  })
  await page.route('**/api/boss-simulator/**', async (route) => {
    const request = route.request()
    const url = new URL(request.url())
    requests.push({ method: request.method(), path: url.pathname, search: url.search })
    if (request.method() !== 'GET') writes.push({ path: url.pathname, body: request.postDataJSON() })
    if (url.pathname.endsWith('/admin') && options.adminDelay) await new Promise((done) => setTimeout(done, options.adminDelay))
    if (url.searchParams.has('cursor') && options.cursorDelay) await new Promise((done) => setTimeout(done, options.cursorDelay))
    if (url.searchParams.has('taskId') && options.detailDelay) await new Promise((done) => setTimeout(done, options.detailDelay))
    if (url.searchParams.get('settings') === '1' && options.settingsDelay) await new Promise((done) => setTimeout(done, options.settingsDelay))
    if (url.searchParams.has('cursor') && options.onCursor) options.onCursor(records)
    const incoming = Readable.from(request.postData() ? [Buffer.from(request.postData())] : [])
    incoming.url = url.pathname + url.search
    incoming.method = request.method()
    incoming.headers = { ...request.headers(), host: url.host }
    const response = { status: 200, writeHead(status) { this.status = status }, end(body) { this.body = body } }
    const handler = url.pathname.endsWith('/board') ? api.handleBoard : url.pathname.endsWith('/settings') ? api.handleSettings : url.pathname.endsWith('/interrupt') ? api.handleInterrupt : url.pathname.endsWith('/admin') ? api.handleAdmin : null
    if (!handler) throw new Error(`测试不允许未知路由 ${url.pathname}`)
    await handler(incoming, response)
    if (response.status === 409) expectedHttpErrors.push(409)
    await route.fulfill({ status: response.status, contentType: 'application/json', body: response.body })
  })
  await page.goto(`http://127.0.0.1:${live.port}/?token=${encodeURIComponent(live.token)}`, { waitUntil: 'domcontentloaded' })
  const preview = page.getByRole('button', { name: '继续', exact: true })
  await page.locator('[title="公司管理"]').waitFor({ state: 'visible' })
  await preview.waitFor({ state: 'visible', timeout: 5 * 1000 }).catch((error) => { if (error.name !== 'TimeoutError') throw error })
  if (await preview.isVisible()) await preview.click({ force: true })
  // 冷首屏宿主渲染抖动会让 actionability 等待偶发超时;force 点击,真实到达仍由 .bs-root 可见断言兜底
  await page.locator('[title="公司管理"]').click({ force: true })
  await expect(page.locator('.bs-root')).toBeVisible()
  await expect(page.locator('.bs-card')).toHaveCount(Math.min(options.taskCount ?? 14, 50))
  if (options.width) {
    await page.locator('.bs-root').evaluate((root, width) => { root.style.width = `${width}px`; root.style.boxSizing = 'content-box' }, options.width)
    if (options.width <= 760) await page.getByRole('group', { name: '工作区视图' }).getByRole('button', { name: '任务', exact: true }).click({ force: true })
  }
  if (options.useExistingSession || options.adminAdapter || options.adminBinding) {
    const cache = await readdir(resolve(live.homeDir, 'storages/session_projcache/sessions'))
    assert.ok(cache.length > 0, '导航验证必须有宿主既有空会话')
    // 会话目录按宿主服务实际收录为准:逐个探测,目录不可见的历史文件换下一个,不盲选首文件
    sessionCache = cache.map((name) => name.replace(/\.json$/, ''))
    if (options.useExistingSession) records.get('fixture-running').runs['run-implementation'].sessionId = sessionCache[0]
  }
  return { page, records, writes, requests, store, getSettings: () => settings, getControl: () => control, sessionCache, getAdminBinding: () => adminBinding, setStubSessionId: (id) => { stubSessionId = id } }
}

// 探测客户端会话目录实际收录的会话 id:uiWorkspace 只接受目录内会话(sessions.retain 校验)
async function findVisibleSessionId(page, records, sessionCache) {
  await open(page, 'fixture-running')
  const openButton = page.locator('aside.bs-detail').getByRole('button', { name: '打开会话', exact: true })
  let found = null
  for (const sessionId of sessionCache) {
    records.get('fixture-running').runs['run-implementation'].sessionId = sessionId
    // 等待须覆盖 3 秒轮询周期,否则标签更新晚于超时造成漏判
    if (await openButton.waitFor({ state: 'visible', timeout: 4 * 1000 }).then(() => true).catch(() => false)) { found = sessionId; break }
  }
  await page.locator('aside.bs-detail').getByRole('button', { name: '关闭', exact: true }).click({ force: true })
  assert.ok(found, '宿主目录必须至少收录一个 projcache 会话')
  return found
}

function card(page, taskId) { return page.locator('.bs-card').filter({ has: page.locator('.bs-card__id', { hasText: taskId }) }) }
// force 点击:轮询+时钟重渲染让 stability 等待偶发超时;真实到达由详情正文断言兜底
async function open(page, taskId) { await card(page, taskId).locator('.bs-card__open').click({ force: true }); await expect(page.locator('.bs-detail__body')).toContainText('目标与范围') }

test('existing-execution-session-opens-host-conversation-without-create-or-prompt', async (t) => {
  const { page, writes, records, sessionCache } = await mount(t, { useExistingSession: true })
  const forbiddenRequests = []
  page.on('request', (request) => { if (/\/api\/session\/(create|prompt|enqueue|fork)$/.test(new URL(request.url()).pathname)) forbiddenRequests.push(request.url()) })
  await open(page, 'fixture-running')
  const openButton = page.locator('aside.bs-detail').getByRole('button', { name: '打开会话', exact: true })
  for (const sessionId of sessionCache) {
    records.get('fixture-running').runs['run-implementation'].sessionId = sessionId
    const openable = await openButton.waitFor({ state: 'visible', timeout: 4 * 1000 }).then(() => true).catch(() => false)
    if (openable) break
  }
  await openButton.click({ force: true })
  await expect(page.locator('.bs-root')).toHaveCount(0)
  await expect(page.getByRole('textbox', { name: '描述你想要构建的内容, / 调用指令, @ 文件或对话', exact: true })).toBeVisible()
  assert.equal(writes.length, 0)
  assert.deepEqual(forbiddenRequests, [], '跳转不请求正式session创建或发消息RPC')
})

test('modal-detail-keeps-global-emergency-stop-action-reachable', async (t) => {
  const { page, writes, getControl } = await mount(t, { width: 700 })
  await page.getByRole('button', { name: '实施中 · 2', exact: true }).click({ force: true })
  await open(page, 'fixture-running')
  const dialog = page.getByRole('dialog', { name: /账务结算运行簿/ })
  await expect(dialog.getByRole('button', { name: '全局紧急停止', exact: true })).toBeVisible()
  await dialog.getByRole('button', { name: '全局紧急停止', exact: true }).click()
  await expect(page.locator('.bs-banner')).toContainText('已提交中断')
  assert.equal(writes.length, 1)
  assert.equal(writes[0].path, '/api/boss-simulator/interrupt')
  assert.equal(writes[0].body.global, true)
  assert.equal(writes[0].body.taskId, undefined)
  assert.equal(getControl().globalStopped, true)
})

test('workbench-first-message-remains-in-company-panel', async (t) => {
  const { page, writes, records, sessionCache, getAdminBinding, setStubSessionId } = await mount(t, { useExistingSession: true, adminAdapter: true })
  const visibleSession = await findVisibleSessionId(page, records, sessionCache)
  setStubSessionId(visibleSession)
  const chat = page.getByRole('region', { name: '管理员对话', exact: true })
  await expect(chat).toBeVisible()
  await chat.getByRole('textbox', { name: '给管理员安排工作', exact: true }).fill('先讨论项目目标，不执行')
  const submitted = []
  await page.route('**/api/session/prompt', async (route) => {
    const payload = route.request().postDataJSON()
    submitted.push(payload.payload.args.request)
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ type: 'server-response', rpcId: payload.rpcId, result: { ok: true, value: { accepted: true } } }) })
  })
  await chat.getByRole('button', { name: '发送', exact: true }).click()
  await expect(chat.getByRole('textbox')).toBeVisible()
  await expect.poll(() => submitted.length).toBe(1)
  await expect(page.locator('.bs-root')).toBeVisible()
  assert.equal(writes.filter((write) => write.path.endsWith('/admin')).length, 1)
  assert.equal(getAdminBinding()?.sessionId, visibleSession)
  assert.equal(submitted[0].sessionId, visibleSession)
  assert.deepEqual(submitted[0].content, [{ type: 'text', text: '先讨论项目目标，不执行' }])
})

// Given 首发等待创建，When 用户离开插件，Then 创建结果不会触发后台首发，草稿重进后仍可恢复。
test('workbench-leaving-during-create-does-not-send-and-preserves-draft', async (t) => {
  const { page, writes, records, sessionCache, setStubSessionId } = await mount(t, { useExistingSession: true, adminAdapter: true, adminDelay: 3 * 1000 })
  setStubSessionId(await findVisibleSessionId(page, records, sessionCache))
  const submitted = []
  await page.route('**/api/session/prompt', async (route) => {
    const payload = route.request().postDataJSON()
    submitted.push(payload.payload.args.request)
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ type: 'server-response', rpcId: payload.rpcId, result: { ok: true, value: { accepted: true } } }) })
  })
  await page.getByRole('textbox', { name: '给管理员安排工作', exact: true }).fill('离开前的待发送目标')
  await page.getByRole('button', { name: '发送', exact: true }).click({ force: true })
  await expect.poll(() => writes.length).toBe(1)
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(4 * 1000)
  await page.locator('[title="公司管理"]').click({ force: true })
  await expect(page.locator('.bs-root')).toBeVisible()
  await expect(page.getByRole('textbox', { name: '给管理员安排工作', exact: true })).toHaveValue('离开前的待发送目标')
  assert.deepEqual(submitted, [], '卸载后不允许首次prompt')
})

// Given 首发响应未确认，When 刷新后显式重试，Then 保留输入且重用同一requestId。
test('workbench-unconfirmed-first-send-reloads-and-retries-the-same-request', async (t) => {
  const { page, records, sessionCache, setStubSessionId } = await mount(t, { useExistingSession: true, adminAdapter: true })
  setStubSessionId(await findVisibleSessionId(page, records, sessionCache))
  const submitted = []
  await page.route('**/api/session/prompt', async (route) => {
    const payload = route.request().postDataJSON()
    submitted.push(payload.payload.args.request)
    const result = submitted.length === 1 ? { ok: false, error: { code: 'gateway/internal', message: '首发响应丢失', details: {} } } : { ok: true, value: { accepted: true } }
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ type: 'server-response', rpcId: payload.rpcId, result }) })
  })
  await page.getByRole('textbox', { name: '给管理员安排工作', exact: true }).fill('需要核对的第一条')
  await page.getByRole('button', { name: '发送', exact: true }).click({ force: true })
  await expect(page.locator('.bs-banner')).toContainText('发送结果未确认')
  await expect(page.getByRole('textbox', { name: '给管理员安排工作', exact: true })).toHaveValue('需要核对的第一条')
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.locator('[title="公司管理"]').click({ force: true })
  await expect(page.getByRole('textbox', { name: '给管理员安排工作', exact: true })).toHaveValue('需要核对的第一条')
  await page.getByRole('button', { name: '发送', exact: true }).click({ force: true })
  // 重试需重新 retain 并打开会话，冷宿主偶发超过默认5秒。
  await expect.poll(() => submitted.length, { timeout: 20 * 1000 }).toBe(2)
  assert.equal(submitted[1].requestId, submitted[0].requestId)
  assert.equal(submitted[1].sessionId, submitted[0].sessionId)
  await expect(page.getByRole('textbox', { name: '给管理员安排工作', exact: true })).toHaveCount(0)
  await expect.poll(() => page.evaluate(() => sessionStorage.getItem('@mzzsfy/dsh-boss-simulator:first-message'))).toBe(null)
})

// Given 首发等待创建，When 仅卸载面板（不销毁页面），Then 守卫取消后续发送，重进草稿保留。
test('workbench-panel-unmount-cancels-pending-first-send-without-reload', async (t) => {
  const { page, writes, records, sessionCache, setStubSessionId } = await mount(t, { useExistingSession: true, adminAdapter: true, adminDelay: 3 * 1000 })
  setStubSessionId(await findVisibleSessionId(page, records, sessionCache))
  const submitted = []
  await page.route('**/api/session/prompt', async (route) => {
    const payload = route.request().postDataJSON()
    submitted.push(payload.payload.args.request)
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ type: 'server-response', rpcId: payload.rpcId, result: { ok: true, value: { accepted: true } } }) })
  })
  await page.getByRole('textbox', { name: '给管理员安排工作', exact: true }).fill('卸载面板前的待发送目标')
  await page.getByRole('button', { name: '发送', exact: true }).click({ force: true })
  await expect.poll(() => writes.length).toBe(1)
  // 不销毁文档：切到宿主插件面板触发本面板卸载，守卫必须取消入场等待后的发送。
  await page.locator('nav[aria-label="全局面板"]').getByRole('button', { name: '插件', exact: true }).click({ force: true })
  await expect(page.locator('.bs-root')).toHaveCount(0)
  await page.waitForTimeout(5 * 1000)
  assert.deepEqual(submitted, [], '面板卸载后不允许首次prompt')
  await page.locator('nav[aria-label="全局面板"]').getByRole('button', { name: '公司管理', exact: true }).click({ force: true })
  await expect(page.locator('.bs-root')).toBeVisible()
  await expect(page.getByRole('textbox', { name: '给管理员安排工作', exact: true })).toHaveValue('卸载面板前的待发送目标')
})

test('admin-entry-creates-empty-session-in-panel-without-prompt', async (t) => {
  const { page, writes, records, sessionCache, getAdminBinding, setStubSessionId } = await mount(t, { useExistingSession: true, adminAdapter: true })
  const forbiddenRequests = []
  page.on('request', (request) => { if (/\/api\/session\/(create|prompt|enqueue|fork)$/.test(new URL(request.url()).pathname)) forbiddenRequests.push(request.url()) })
  const visibleSession = await findVisibleSessionId(page, records, sessionCache)
  setStubSessionId(visibleSession)
  const entry = page.locator('.bs-head').getByRole('button', { name: '创建管理员会话', exact: true })
  await expect(entry).toBeVisible()
  await entry.click({ force: true })
  await expect(page.locator('.bs-root')).toBeVisible()
  await expect(page.getByRole('region', { name: '管理员对话', exact: true }).getByRole('textbox')).toBeVisible()
  assert.equal(writes.length, 1)
  assert.equal(writes[0].path, '/api/boss-simulator/admin')
  assert.equal(writes[0].body.action, 'create')
  assert.equal(writes[0].body.replace, undefined, '普通创建不得携带重建语义')
  assert.equal(getAdminBinding()?.sessionId, visibleSession)
  assert.deepEqual(forbiddenRequests, [], '创建入口不触碰正式session创建或prompt RPC')
})

test('admin-entry-opens-existing-administrator-without-any-write', async (t) => {
  const { page, writes, records, sessionCache, store } = await mount(t, { useExistingSession: true })
  const visibleSession = await findVisibleSessionId(page, records, sessionCache)
  store.updateAdminBinding(() => ({ sessionId: visibleSession, createdAt: 1 }))
  const entry = page.locator('.bs-head').getByRole('button', { name: '管理员对话', exact: true })
  await expect(entry).toBeVisible({ timeout: 10 * 1000 })
  await entry.click({ force: true })
  await expect(page.locator('.bs-root')).toBeVisible()
  await expect(page.getByRole('region', { name: '管理员对话', exact: true }).getByRole('textbox')).toBeVisible()
  assert.equal(writes.length, 0, '收养管理员只加载历史,零写请求')
})

test('admin-entry-rebuilds-unreachable-session-after-explicit-confirm', async (t) => {
  const { page, writes, records, sessionCache, getAdminBinding, setStubSessionId } = await mount(t, { useExistingSession: true, adminBinding: { sessionId: 'session-gone', createdAt: 1 }, adminAdapter: true })
  const visibleSession = await findVisibleSessionId(page, records, sessionCache)
  setStubSessionId(visibleSession)
  const entry = page.locator('.bs-head').getByRole('button', { name: '管理员会话不可用', exact: true })
  await expect(entry).toBeVisible()
  await entry.click({ force: true })
  const confirm = page.locator('.bs-head').getByRole('button', { name: '再次点击确认重建', exact: true })
  await expect(confirm).toBeVisible()
  await confirm.click({ force: true })
  await expect(page.locator('.bs-root')).toBeVisible()
  await expect(page.getByRole('region', { name: '管理员对话', exact: true }).getByRole('textbox')).toBeVisible()
  assert.equal(writes.length, 1)
  assert.equal(writes[0].body.action, 'create')
  assert.equal(writes[0].body.replace, true, '重建必须显式携带 replace')
  assert.equal(getAdminBinding()?.sessionId, visibleSession, '重建覆盖旧绑定')
})

test('missing-execution-session-is-disabled-without-create-or-prompt', async (t) => {
  const { page, writes } = await mount(t)
  await open(page, 'fixture-running')
  const runs = page.locator('aside.bs-detail .bs-run')
  await expect(runs.getByRole('button', { name: '会话不可用', exact: true }).first()).toBeDisabled()
  await expect(runs.first()).toContainText('session-fixture-running-run-implementation')
  assert.equal(writes.length, 0)
})

test('snapshot-conflict-retains-loaded-page-target-and-restarts-atomically', async (t) => {
  const options = { taskCount: 64 }
  const { page } = await mount(t, options)
  await page.getByRole('button', { name: '加载更多任务', exact: true }).click()
  await expect(page.locator('.bs-card')).toHaveCount(64)
  options.onCursor = (records) => {
    records.get('fixture-running').title = '快照冲突后的新标题'
    options.onCursor = null
  }
  await expect(page.locator('.bs-banner')).toContainText('连接中断', { timeout: 8 * 1000 })
  await expect(page.locator('.bs-card')).toHaveCount(64)
  await expect(page.locator('.bs-banner')).not.toContainText('连接中断', { timeout: 10 * 1000 })
  await expect(card(page, 'fixture-running')).toContainText('快照冲突后的新标题')
  await expect(page.locator('.bs-card')).toHaveCount(64)
})

test('page-outside-model-task-opens-independent-detail-and-timeline', async (t) => {
  const { page, records } = await mount(t, { taskCount: 64, detailDelay: 2 * 1000 })
  const visibleIds = await page.locator('.bs-card__id').allTextContents()
  const outside = [...records.values()].find((task) => !visibleIds.includes(task.taskId) && Object.keys(task.usageLedger).length)
  assert.ok(outside)
  await page.getByRole('tab', { name: '模型任务', exact: true }).click()
  const taskButton = page.getByRole('row').filter({ hasText: 'orion' }).getByRole('button', { name: outside.title, exact: true }).last()
  await taskButton.click()
  await expect(page.locator('aside.bs-detail')).toBeVisible()
  await expect(page.locator('.bs-detail__body')).toContainText('目标与范围', { timeout: 8 * 1000 })
  await page.locator('.bs-root').evaluate((root) => { root.style.width = '1300px' })
  await page.getByRole('tab', { name: '实际时间线', exact: true }).click()
  await expect(page.locator('.bs-run')).not.toHaveCount(0)
})

test('slow-load-more-is-not-cancelled-by-board-poll', async (t) => {
  const options = { taskCount: 64, cursorDelay: 0 }
  const { page } = await mount(t, options)
  options.cursorDelay = 4 * 1000
  await page.getByRole('button', { name: '加载更多任务', exact: true }).click()
  await expect(page.locator('.bs-card')).toHaveCount(64, { timeout: 12 * 1000 })
})

test('filled-pagination-retains-all-loaded-pages-and-model-totals', async (t) => {
  const { page } = await mount(t, { taskCount: 64 })
  const total = (await page.locator('.bs-col__count').allTextContents()).reduce((sum, count) => sum + Number(count), 0)
  assert.equal(total, 64)
  await page.getByRole('button', { name: '加载更多任务', exact: true }).click()
  await expect(page.locator('.bs-card')).toHaveCount(64)
  await expect(page.getByRole('button', { name: '加载更多任务', exact: true })).toHaveCount(0)
  await page.waitForTimeout(4 * 1000)
  await expect(page.locator('.bs-card')).toHaveCount(64)
  await page.getByLabel('搜索任务标题或标识').fill('fixture-running')
  await expect(page.locator('.bs-card')).toHaveCount(1)
  assert.deepEqual(await page.locator('.bs-col__count').allTextContents(), ['0', '0', '1', '0', '0', '0', '0'])
  await page.getByLabel('搜索任务标题或标识').fill('')
  await expect(page.locator('.bs-card')).toHaveCount(50)
  await page.getByRole('tab', { name: '模型任务', exact: true }).click()
  const row = page.getByRole('row').filter({ hasText: 'orion' })
  await expect(row).toContainText('提供方待核对')
  assert.ok(Number(await row.getByRole('cell').nth(1).textContent()) > 10)
})

test('filled-board-seven-states-and-text-escaping', async (t) => {
  const { page, records, writes } = await mount(t)
  assert.deepEqual(await page.locator('.bs-col__count').allTextContents(), ['2', '2', '2', '2', '2', '2', '2'])
  assert.equal(writes.length, 0, '进入页面不创建、不派发、不发送消息')
  await expect(card(page, 'fixture-running')).toContainText('已知 4820 token · 不完整')
  await expect(card(page, 'fixture-draft-1')).toContainText('token 未知')
  const task = records.get('fixture-blocked-1')
  task.control.state = 'paused'
  task.definition.goal = '<img src=x onerror="window.fixtureExecuted=true">'
  await open(page, task.taskId)
  await expect(page.locator('.bs-detail__body')).toContainText('受阻原因：等待上游 API 冻结')
  await expect(page.locator('.bs-detail__body')).toContainText('已暂停')
  await expect(page.locator('.bs-detail__body')).toContainText(task.definition.goal)
  assert.equal(await page.locator('.bs-detail__body img').count(), 0)
  assert.equal(await page.evaluate(() => window.fixtureExecuted), undefined)
  const openerStyle = await card(page, task.taskId).locator('.bs-card__open').evaluate((button) => ({ align: getComputedStyle(button).textAlign, background: getComputedStyle(button).backgroundColor }))
  assert.equal(openerStyle.align, 'left', '任务卡不是原生灰底居中按钮')
})

test('filled-detail-selection-does-not-reuse-old-task-and-refreshes-stop-facts', async (t) => {
  const { page, records } = await mount(t)
  await open(page, 'fixture-running')
  await expect(page.locator('aside.bs-detail')).toContainText('第 2 次')
  const close = page.locator('aside.bs-detail').getByRole('button', { name: '关闭', exact: true })
  await close.click()
  await open(page, 'fixture-ready-1')
  await expect(page.locator('.bs-detail__body')).toContainText('尚无 Run 记录')
  await expect(page.locator('.bs-detail__body')).not.toContainText('run-repair')
  records.get('fixture-ready-1').control.state = 'paused'
  await expect(page.locator('.bs-detail__body')).toContainText('已暂停', { timeout: 12 * 1000 })
  await close.focus()
  await page.waitForTimeout(6 * 1000)
  await expect(close).toBeFocused()
})

test('filled-settings-return-preserves-draft-and-conflict-can-be-explicitly-retried', async (t) => {
  const { page, store, writes } = await mount(t)
  await page.locator('.bs-head').getByRole('button', { name: '设置', exact: true }).click()
  await page.getByLabel('全局并发参考值').fill('3')
  await page.getByRole('button', { name: '返回面板', exact: true }).click()
  await expect(page.getByRole('alertdialog')).toBeVisible()
  await page.getByRole('button', { name: '继续编辑', exact: true }).click()
  await expect(page.getByRole('button', { name: '返回面板', exact: true })).toBeFocused()
  await expect(page.getByLabel('全局并发参考值')).toHaveValue('3')
  assert.equal(writes.length, 0, '编辑与取消不保存')
  await store.updateSettings((settings) => ({ ...settings, configRevision: settings.configRevision + 1, values: { concurrencyReference: 5 } }))
  await page.getByRole('button', { name: '保存', exact: true }).click()
  await expect(page.getByRole('status')).toContainText('本地草稿已保留')
  await expect(page.getByLabel('全局并发参考值')).toHaveValue('3')
  await expect(page.getByRole('status')).toContainText('服务端当前为 5')
  await page.getByRole('button', { name: '保存', exact: true }).click()
  await expect(page.getByRole('status')).toContainText('已保存')
})

test('narrow-detail-is-bounded-by-plugin-not-host-viewport', async (t) => {
  const { page } = await mount(t, { width: 700 })
  await page.getByRole('button', { name: '实施中 · 2', exact: true }).click({ force: true })
  await open(page, 'fixture-running')
  const bounds = await page.locator('.bs-root').boundingBox()
  const detail = await page.locator('aside.bs-detail').boundingBox()
  assert.ok(detail.x >= bounds.x, '详情不能盖住宿主侧栏')
  assert.ok(detail.x + detail.width <= bounds.x + bounds.width + 1, '详情不能超出插件右边界')
  assert.ok(detail.y >= bounds.y, '详情不能越过插件顶部')
})

test('filled-drawer-traps-focus-and-releases-background-across-container-breakpoints', async (t) => {
  const { page } = await mount(t, { width: 1000 })
  await open(page, 'fixture-running')
  const detail = page.locator('aside.bs-detail')
  await expect(detail).toHaveAttribute('role', 'dialog')
  await expect(detail).toHaveAttribute('aria-modal', 'true')
  assert.equal(await page.locator('.bs-head').evaluate((head) => Boolean(head.closest('[inert]'))), true)
  const buttons = detail.locator('button:enabled')
  await buttons.last().focus()
  await page.keyboard.press('Tab')
  await expect(buttons.first()).toBeFocused()
  await page.locator('.bs-root').evaluate((root) => { root.style.width = '700px' })
  await expect(detail).toHaveAttribute('data-modality', 'mobile')
  await expect(detail.getByRole('button', { name: '全局紧急停止', exact: true })).toBeVisible()
  await page.locator('.bs-root').evaluate((root) => { root.style.width = '1300px' })
  await expect(detail).toHaveAttribute('data-modality', 'panel')
  assert.equal(await page.locator('.bs-head').evaluate((head) => Boolean(head.closest('[inert]'))), false)
  await page.keyboard.press('Escape')
  await expect(detail).toHaveCount(0)
  await expect(card(page, 'fixture-running').locator('.bs-card__open')).toBeFocused()
})

test('slow-detail-read-completes-despite-faster-board-polling', async (t) => {
  const { page } = await mount(t, { detailDelay: 4 * 1000 })
  await card(page, 'fixture-running').locator('.bs-card__open').click()
  await expect(page.locator('.bs-detail__body')).toContainText('目标与范围', { timeout: 10 * 1000 })
})

test('pending-settings-read-cannot-reopen-after-cancel', async (t) => {
  const { page } = await mount(t, { settingsDelay: 2 * 1000 })
  await page.locator('.bs-head').getByRole('button', { name: '设置', exact: true }).click()
  await page.getByRole('button', { name: '返回面板', exact: true }).click()
  await page.waitForTimeout(3 * 1000)
  await expect(page.getByRole('tab', { name: '看板', exact: true })).toBeVisible()
  await expect(page.locator('#bs-concurrency')).toHaveCount(0)
})

test('removed-selected-task-releases-modal-background', async (t) => {
  const { page, records } = await mount(t, { width: 1000 })
  await open(page, 'fixture-running')
  const task = records.get('fixture-running')
  await page.locator('.bs-root').evaluate((root) => { root.style.width = '1300px' })
  // 等模态真正解除(inert 释放)再操作背景搜索框,否则 fill 落在 inert 输入上不触发 onChange
  await expect(page.locator('aside.bs-detail')).toHaveAttribute('data-modality', 'panel', { timeout: 10 * 1000 })
  await page.getByLabel('搜索任务标题或标识').fill('fixture-ready-1')
  assert.ok(task, '保留服务端详情，只让列表筛选排除选中任务')
  await expect(page.locator('aside.bs-detail')).toHaveCount(0, { timeout: 10 * 1000 })
  assert.equal(await page.locator('.bs-head').evaluate((head) => Boolean(head.closest('[inert]'))), false)
})

test('filled-timeline-queued-run-and-model-table-enter-the-same-detail', async (t) => {
  const { page } = await mount(t)
  await page.getByRole('tab', { name: '实际时间线', exact: true }).click()
  const queued = page.locator('.bs-run').filter({ hasText: 'fixture-awaiting_acceptance-1' }).filter({ hasText: '独立验收' })
  await expect(queued).toContainText('尚未开始')
  await expect(queued.locator('.bs-run__line')).toHaveCount(0)
  await queued.getByRole('button').click()
  await expect(page.locator('aside.bs-detail')).toBeVisible()
  await page.keyboard.press('Escape')
  await page.getByRole('tab', { name: '模型任务', exact: true }).click()
  await expect(page.getByRole('table', { name: '模型参与任务' })).toBeVisible()
  const row = page.getByRole('row').filter({ hasText: 'orion' })
  await expect(row.getByRole('cell').nth(1)).toHaveText('10')
  await row.getByRole('button').first().click()
  await expect(page.locator('aside.bs-detail')).toBeVisible()
})
