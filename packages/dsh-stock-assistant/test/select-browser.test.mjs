import test, { before, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// 聚合器把单元 HOME 重定向到一次性目录, playwright 按 HOME 解析浏览器注册表
// (linux: ~/.cache/ms-playwright, win: ~/AppData/Local/ms-playwright)会指到空目录。
// 注册表根在 playwright 模块加载时冻结, 必须在动态 import 之前赋值;
// CI 经 workflow 显式 export PLAYWRIGHT_BROWSERS_PATH(固定路径), 已设则不覆盖
if (!process.env.PLAYWRIGHT_BROWSERS_PATH && process.env.DSH_REAL_HOME) {
  const browsersRoot = process.platform === 'win32'
    ? join(process.env.DSH_REAL_HOME, 'AppData', 'Local', 'ms-playwright')
    : join(process.env.DSH_REAL_HOME, '.cache', 'ms-playwright')
  process.env.PLAYWRIGHT_BROWSERS_PATH = browsersRoot
}
const { chromium } = await import('playwright')

// 自绘下拉的验收: 原生 select 的菜单进不了 DOM, 自动化点不到; 这里用真实浏览器点开菜单并选值,
// 把「打开→选择→写盘」整条链路跑通。夹具是内存 app + 真 React 客户端, 不碰生产宿主。
let fixture, context, page, errors, fixtureExit

before(async () => {
  fixture = spawn(process.execPath, [fileURLToPath(new URL('./browser-fixture.mjs', import.meta.url))], { stdio: ['ignore', 'pipe', 'pipe'] })
  fixture.stderr.on('data', chunk => process.stderr.write(chunk))
  fixture.on('exit', code => { fixtureExit = code })
  const url = await new Promise((resolve, reject) => {
    let buffer = ''
    const timer = setTimeout(() => reject(new Error('夹具启动超时')), 30000)
    fixture.stdout.on('data', chunk => {
      buffer += chunk
      const hit = /FIXTURE_URL=(\S+)/.exec(buffer)
      if (hit) { clearTimeout(timer); resolve(hit[1]) }
    })
    fixture.on('exit', code => { if (!buffer) { clearTimeout(timer); reject(new Error(`夹具退出 ${code}`)) } })
  })
  // 浏览器渠道按环境选择: CI 用 playwright 内置 chromium(workflow 装配, Google
  // 不发 Linux arm64 系统版, amd64 预装的系统 Chrome 是环境差异不是契约);
  // 本地与 amd64 缺省走系统 Chrome, PLAYWRIGHT_BROWSER_CHANNEL=chromium 走内置
  // 完整 Chromium。不能置空 channel: Playwright 1.63 在 headless 下会优先找
  // chromium-headless-shell, 而缓存可能只恢复完整 Chromium。
  // 变量不能带 DSH_ 前缀:aggregate-tests 的隔离环境会剔除全部 DSH_*/STOCK_* 变量,
  // CI 的渠道选择因此到不了子进程。
  const profile = mkdtempSync(join(tmpdir(), 'select-browser-profile-'))
  context = await chromium.launchPersistentContext(profile, {
    headless: true,
    channel: process.env.PLAYWRIGHT_BROWSER_CHANNEL === 'chromium' ? 'chromium' : 'chrome',
    viewport: { width: 1280, height: 900 },
    locale: 'zh-CN',
    // branded Chrome 按 HOME/USERPROFILE 判定数据目录形态, 聚合器重定向后
    // 显式 user-data-dir 也会被误判为默认目录而拒绝 DevTools; 还原真实值,
    // 插件数据隔离由 DSH_HOME 承担, 不依赖这两个变量
    env: { ...process.env, ...(process.env.DSH_REAL_HOME ? { HOME: process.env.DSH_REAL_HOME, USERPROFILE: process.env.DSH_REAL_HOME } : {}) },
  })
  page = context.pages()[0]
  errors = []
  page.on('pageerror', error => errors.push(error.message))
  trackPreferenceResponses()
  await page.goto(url)
  await page.waitForSelector('.ssb-root')
})

after(async () => {
  await context?.close()
  fixture?.kill('SIGTERM')
})

async function openPreferences() {
  await page.getByRole('button', { name: '更多操作' }).click()
  await page.getByRole('button', { name: '设置', exact: true }).click()
  await page.getByRole('tab', { name: '显示偏好' }).click()
}

// preferences 写盘响应缓冲: 挤兑/CPU 饥饿下"注册等待窗口"与"click 完成"会互相吃掉
// 30s 时窗, page 级监听从用例开始就缓存全部响应, 断言侧按谓词取事件, 事件永不丢
const preferenceResponses = []
function trackPreferenceResponses() {
  page.on('response', response => {
    if (response.url().includes('/api/stock-assistant/preferences') && response.request().method() === 'POST') preferenceResponses.push(response)
  })
}
async function takePreferenceResponse() {
  // 预算上限: 挤兑下等待可长, 但超 120s 判真失败, 防断言侧无限挂死
  const deadline = Date.now() + 120 * 1000
  for (;;) {
    const hit = preferenceResponses.shift()
    if (hit) return hit
    if (Date.now() > deadline) throw new Error('120s 内未等到 preferences 写盘响应')
    await new Promise(resolve => setTimeout(resolve, 50))
  }
}

test('鼠标点开下拉并选择: 菜单进 DOM, 选择后写盘且菜单关闭', async () => {
  await openPreferences()
  const trigger = page.getByRole('combobox', { name: '悬浮盯盘刷新' })
  await trigger.click()
  const listbox = page.getByRole('listbox', { name: '悬浮盯盘刷新' })
  await listbox.waitFor({ state: 'visible' })
  const pending = takePreferenceResponse()
  await listbox.getByRole('option', { name: '30秒' }).click()
  const response = await pending
  assert.equal(response.status(), 200)
  const body = await response.json()
  assert.equal(body.ok, true)
  assert.equal(body.data.unchanged, false)
  assert.equal(await trigger.getAttribute('aria-expanded'), 'false')
  assert.match(await trigger.innerText(), /30秒/)
  await listbox.waitFor({ state: 'hidden', timeout: 1000 })
  assert.equal(errors.length, 0)
})

test('键盘打开与选择, Escape 只关菜单不关设置弹窗', async () => {
  const trigger = page.getByRole('combobox', { name: '刷新间隔' })
  await trigger.focus()
  await page.keyboard.press('Enter')
  const listbox = page.getByRole('listbox', { name: '刷新间隔' })
  await listbox.waitFor({ state: 'visible' })
  // 菜单打开时 active 初始化为当前值, 等 aria-activedescendant 就绪再导航:
  // open 与 active 是两次 setState, 快机器上 ArrowDown 可能落在 React 提交前
  await page.waitForFunction(([triggerSel, optionLabel]) => {
    const trigger = document.querySelector(triggerSel)
    const active = trigger?.getAttribute('aria-activedescendant')
    return active !== null && document.getElementById(active)?.textContent?.trim() === optionLabel
  }, ['[aria-label="刷新间隔"]', '15秒'])
  const pending = takePreferenceResponse()
  await page.keyboard.press('ArrowDown')
  // ArrowDown 的 active 更新是 React 另一次提交;慢架构上紧跟 Enter 会读回旧 active(15秒)
  await page.waitForFunction(([triggerSel, optionLabel]) => {
    const trigger = document.querySelector(triggerSel)
    const active = trigger?.getAttribute('aria-activedescendant')
    return active !== null && document.getElementById(active)?.textContent?.trim() === optionLabel
  }, ['[aria-label="刷新间隔"]', '30秒'])
  await page.keyboard.press('Enter')
  const response = await pending
  assert.equal(response.status(), 200)
  assert.match(await trigger.innerText(), /30秒/)
  // 再打开一次, Escape 只收菜单
  await trigger.click()
  await listbox.waitFor({ state: 'visible' })
  await page.keyboard.press('Escape')
  await listbox.waitFor({ state: 'hidden', timeout: 1000 })
  await page.getByRole('dialog', { name: '设置' }).waitFor({ state: 'visible' })
  await trigger.click()
  await page.getByRole('option', { name: '15秒' }).click()
  await page.getByRole('button', { name: '关闭' }).click()
  // 显式等弹窗退场: 遮罩退场动画中点「更多操作」会命中持续不稳定态
  await page.getByRole('dialog', { name: '设置' }).waitFor({ state: 'hidden' })
  assert.equal(errors.length, 0)
})

test('点击菜单外关闭下拉, 设置弹窗保持打开', async () => {
  await openPreferences()
  const trigger = page.getByRole('combobox', { name: '涨跌颜色' })
  const listbox = page.getByRole('listbox', { name: '涨跌颜色' })
  await trigger.click()
  await listbox.waitFor({ state: 'visible' })
  await trigger.click()
  await listbox.waitFor({ state: 'hidden', timeout: 1000 })
  await trigger.click()
  await listbox.waitFor({ state: 'visible' })
  await page.locator('.ssb-settings h3').first().click()
  await listbox.waitFor({ state: 'hidden', timeout: 1000 })
  await page.getByRole('dialog', { name: '设置' }).waitFor({ state: 'visible' })
})

// K4 交互: 夹具只注册 tushare, 默认实例引用的 eastmoney 等适配器已不存在 —— 下拉必须显示失效值
// 而不是静默显示第一个选项; 切到 tushare 后保存数据源, 草稿路由按 tushare 的能力矩阵剪枝,
// 不再提交服务端必拒的 kline/搜索/外市场引用(其余未注册实例先移除, 否则服务端契约本身就该拒)。
test('适配器下拉显示失效值, 切换后保存按新能力剪枝', async () => {
  // 上一个用例结束时设置弹窗仍开着且草稿跨会话保留(基线版本已过期); 重载拿到干净运行时
  const dialog = page.getByRole('dialog', { name: '设置' })
  await page.reload()
  await page.waitForSelector('.ssb-root')
  await page.getByRole('button', { name: '更多操作' }).click()
  await page.getByRole('button', { name: '设置', exact: true }).click()
  await page.getByRole('tab', { name: '数据源' }).click()
  // 夹具未注册的适配器实例先移除: 它们与本次剪枝无关, 留着会让服务端按 INVALID_ADAPTER 整次拒绝
  for (const id of ['sn-backup', 'tx-backup', 'xq-backup']) {
    const card = page.locator('.ssb-provider').filter({ hasText: id })
    await card.locator('.ssb-provider-toggle').click()
    await card.getByRole('button', { name: '移除' }).click()
    await card.waitFor({ state: 'detached' })
  }
  const card = page.locator('.ssb-provider').first()
  const providerId = (await card.locator('.ssb-provider-id').innerText()).trim()
  await card.locator('.ssb-provider-toggle').click()
  const trigger = page.getByRole('combobox', { name: '适配器' })
  assert.match(await trigger.innerText(), /eastmoney（不可用）/, '未注册的适配器值必须显示为异常项')
  await trigger.click()
  const listbox = page.getByRole('listbox', { name: '适配器' })
  await listbox.waitFor({ state: 'visible' })
  assert.equal(await listbox.getByRole('option', { name: 'eastmoney（不可用）' }).getAttribute('aria-disabled'), 'true')
  await listbox.getByRole('option', { name: 'tushare' }).click()
  await listbox.waitFor({ state: 'hidden', timeout: 1000 })
  assert.match(await trigger.innerText(), /tushare/)
  const pending = page.waitForResponse(response => response.url().includes('/api/stock-assistant/configuration') && response.request().method() === 'POST')
  await page.getByRole('button', { name: '保存数据源' }).click()
  const response = await pending
  const body = await response.json()
  assert.equal(response.status(), 200, JSON.stringify(body))
  assert.equal(body.ok, true)
  const savedControl = (await page.evaluate(async () => (await fetch('/api/stock-assistant/snapshot')).json())).data.control
  assert.equal(savedControl.providers.find(provider => provider.id === providerId).adapterId, 'tushare')
  const capabilities = ['catalog', 'quotes', 'calendar'], markets = ['XSHG', 'XSHE']
  const foreign = savedControl.routes.filter(route => route.primaryInstanceId === providerId).filter(route => !capabilities.includes(route.capability) || !markets.includes(route.market))
  assert.deepEqual(foreign, [], '切到 tushare 后不得留下 kline/搜索/外市场路由')
  assert.equal(errors.length, 0)
  await page.getByRole('button', { name: '关闭' }).click()
  await dialog.waitFor({ state: 'hidden' })
})

async function openSettings() {
  await page.reload()
  await page.waitForSelector('.ssb-root')
  await page.getByRole('button', { name: '更多操作' }).click()
  await page.getByRole('button', { name: '设置', exact: true }).click()
  await page.getByRole('tab', { name: '数据源' }).click()
  await page.getByRole('dialog', { name: '设置' }).waitFor({ state: 'visible' })
}

const assertBannerAboveOverlay = async () => {
  const banner = page.locator('.ssb-banner.ssb-error')
  await banner.waitFor({ state: 'visible' })
  const box = await banner.boundingBox()
  assert.ok(box, '错误横幅必须有可点击区域')
  const hit = await page.evaluate(([x, y]) => document.elementFromPoint(x, y)?.closest('.ssb-banner.ssb-error') !== null, [box.x + box.width / 2, box.y + box.height / 2])
  assert.equal(hit, true, '设置浮层打开时错误横幅必须位于浮层之上, 409/500 不能被遮住')
  assert.equal(await page.getByRole('dialog', { name: '设置' }).isVisible(), true)
}

// S2: 设置浮层 z-index 60 不能盖住保存错误横幅(409 真实由服务端返回)
test('S2 保存配置 409 时错误横幅位于浮层之上', async () => {
  await openSettings()
  const revision = await page.evaluate(async () => (await (await fetch('/api/stock-assistant/snapshot')).json()).data.control.revision)
  const bumped = await page.evaluate(async expectedRevision => {
    const response = await fetch('/api/stock-assistant/preferences', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ operationId: crypto.randomUUID(), expectedRevision, patch: { refreshSeconds: 60 } }) })
    return response.status
  }, revision)
  assert.equal(bumped, 200)
  const pending = page.waitForResponse(response => response.url().includes('/api/stock-assistant/configuration') && response.request().method() === 'POST')
  await page.getByRole('button', { name: '保存数据源' }).click()
  assert.equal((await pending).status(), 409)
  assert.match(await page.locator('.ssb-banner.ssb-error').innerText(), /数据已被其他页面修改/)
  await assertBannerAboveOverlay()
  assert.equal(errors.length, 0)
})

test('S2 保存配置 500 时错误横幅可见', async () => {
  await openSettings()
  const route = '**/api/stock-assistant/configuration'
  await page.route(route, handler => handler.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ ok: false, error: { code: 'STORAGE_WRITE_FAILED', message: '保存失败，原数据未更改' } }) }))
  try {
    await page.getByRole('button', { name: '保存数据源' }).click()
    await page.locator('.ssb-banner.ssb-error').waitFor({ state: 'visible' })
    assert.match(await page.locator('.ssb-banner.ssb-error').innerText(), /保存失败，原数据未更改/)
    await assertBannerAboveOverlay()
    assert.equal(errors.length, 0)
  } finally { await page.unroute(route) }
})

test('目录同步部分失败时给出错误 toast', async () => {
  await openSettings()
  await page.getByRole('tab', { name: '市场与能力' }).click()
  const route = '**/api/stock-assistant/catalog-sync'
  await page.route(route, handler => handler.fulfill({
    status: 200, contentType: 'application/json',
    body: JSON.stringify({ ok: true, data: [{ capability: 'catalog', ok: true, count: 1 }, { capability: 'calendar', ok: false, error: { code: 'NO_ROUTE', message: '未配置该市场的数据来源' } }] }),
  }))
  try {
    await page.getByRole('button', { name: '同步沪 A' }).click()
    await page.getByText('未配置该市场的数据来源').waitFor({ state: 'visible' })
    assert.equal(errors.length, 0)
  } finally { await page.unroute(route) }
})

test('凭据保存失败时在实例卡内提示', async () => {
  await page.reload()
  await page.waitForSelector('.ssb-root')
  const configured = await page.evaluate(async () => {
    const snapshot = (await (await fetch('/api/stock-assistant/snapshot')).json()).data
    const provider = { ...snapshot.control.providers[0], credentialRef: 'DSH_STOCK_TUSHARE_TOKEN' }
    const response = await fetch('/api/stock-assistant/configuration', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ operationId: crypto.randomUUID(), expectedRevision: snapshot.control.revision, providers: [provider], routes: [] }) })
    return response.status
  })
  assert.equal(configured, 200)
  await page.reload()
  await page.waitForSelector('.ssb-root')
  await page.getByRole('button', { name: '更多操作' }).click()
  await page.getByRole('button', { name: '设置', exact: true }).click()
  await page.getByRole('tab', { name: '数据源' }).click()
  const card = page.locator('.ssb-provider').first()
  await card.locator('.ssb-provider-toggle').click()
  const input = card.locator('.ssb-credential input[type="password"]')
  await input.waitFor({ state: 'visible' })
  const route = '**/api/stock-assistant/credential'
  await page.route(route, handler => handler.fulfill({ status: 422, contentType: 'application/json', body: JSON.stringify({ ok: false, error: { code: 'INVALID_CREDENTIAL', message: '凭据校验失败' } }) }))
  try {
    await input.fill('bad-secret')
    await card.getByRole('button', { name: '保存密钥' }).click()
    await card.locator('[role="status"]', { hasText: '凭据校验失败' }).waitFor({ state: 'visible' })
    assert.equal(errors.length, 0)
  } finally { await page.unroute(route) }
})
