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

// 菜单开关的确定性条件: aria-expanded 与 listbox hidden 在同一次 React 提交落地。
// click 返回只代表事件已派发, 不代表 React 已提交——下一步动作若落在提交窗口里,
// trigger 的 onClick 会按旧 open 状态走错分支(该关的开、该开的关)。先等双信号到位再继续
async function waitMenuState(label, open) {
  await page.waitForFunction(([labelText, expectedOpen]) => {
    const trigger = document.querySelector(`[aria-label="${labelText}"]`)
    const menu = trigger?.closest('.ssb-select')?.querySelector('[role="listbox"]')
    return trigger?.getAttribute('aria-expanded') === String(expectedOpen) && menu?.hidden === !expectedOpen
  }, [label, open])
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
  await waitMenuState('悬浮盯盘刷新', true)
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
  await waitMenuState('悬浮盯盘刷新', false)
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
  await waitMenuState('刷新间隔', true)
  await listbox.waitFor({ state: 'visible' })
  await page.keyboard.press('Escape')
  await waitMenuState('刷新间隔', false)
  await listbox.waitFor({ state: 'hidden', timeout: 1000 })
  await page.getByRole('dialog', { name: '设置' }).waitFor({ state: 'visible' })
  await trigger.click()
  await waitMenuState('刷新间隔', true)
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
  await waitMenuState('涨跌颜色', true)
  await listbox.waitFor({ state: 'visible' })
  await trigger.click()
  await waitMenuState('涨跌颜色', false)
  await listbox.waitFor({ state: 'hidden', timeout: 1000 })
  await trigger.click()
  await waitMenuState('涨跌颜色', true)
  await listbox.waitFor({ state: 'visible' })
  await page.locator('.ssb-settings h3').first().click()
  await waitMenuState('涨跌颜色', false)
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

test('长自选列表用满面板剩余高度，宽屏仍有宽度上限', async () => {
  const route = '**/api/stock-assistant/snapshot'
  await page.route(route, async handler => {
    const response = await handler.fetch()
    const body = await response.json()
    const order = Array.from({ length: 40 }, (_, index) => `XSHG:equity:${600000 + index}`)
    body.data.control.watchlist = { order, items: Object.fromEntries(order.map(id => [id, { id, exchange: 'XSHG', code: id.split(':').at(-1), officialName: '测试标的' }])) }
    body.data.ensureError = { message: '测试目录错误' }
    await handler.fulfill({ response, json: body })
  })
  try {
    for (const width of [1600, 640]) {
      await page.setViewportSize({ width, height: 900 })
      await page.reload()
      const list = page.getByRole('tabpanel', { name: '全部' })
      await list.waitFor()
      const bounds = await list.evaluate(node => {
        const root = node.closest('.ssb-root'), pane = node.closest('.ssb-page')
        return { bottomGap: root.getBoundingClientRect().bottom - node.getBoundingClientRect().bottom, pageWidth: pane.clientWidth, rootWidth: root.clientWidth, rootOverflow: root.scrollHeight - root.clientHeight, listOverflow: node.scrollHeight - node.clientHeight }
      })
      assert.ok(bounds.bottomGap >= 0 && bounds.bottomGap <= 32, `列表底部只留页面内边距：${JSON.stringify(bounds)}`)
      assert.equal(bounds.rootOverflow, 0, '纵向滚动留在列表内')
      assert.ok(bounds.listOverflow > 0, '长列表仍可滚动')
      assert.equal(bounds.pageWidth, Math.min(bounds.rootWidth, 1280))
      assert.equal(await page.getByText('价格与涨跌来自同一数据源。', { exact: false }).count(), 0)
    }
    await page.setViewportSize({ width: 640, height: 220 })
    const shortList = page.getByRole('tabpanel', { name: '全部' })
    assert.ok((await shortList.boundingBox()).height >= 40, '短面板有横幅时仍能滚动查看自选行')
  } finally {
    await page.unroute(route)
    await page.setViewportSize({ width: 1280, height: 900 })
  }
})

test('自选行情列保持间距，窄面板将次要指标放到下一行', async () => {
  const route = '**/api/stock-assistant/snapshot'
  const id = 'XSHG:index:000001'
  await page.route(route, async handler => {
    const response = await handler.fetch()
    const body = await response.json()
    body.data.control.watchlist = { order: [id], items: { [id]: { id, exchange: 'XSHG', code: '000001', officialName: '上证指数', priceScale: 2 } } }
    body.data.quotes = { [id]: { health: 'ok', quote: { last: '3526.12', changePct: '-0.22', change: '-7.67', open: '3503.52', high: '3544.60', low: '3476.65', previousClose: '3533.79', amount: '683890000000' } } }
    await handler.fulfill({ response, json: body })
  })
  try {
    await page.reload()
    const list = page.getByRole('tabpanel', { name: '全部' })
    await list.getByText('3503.52', { exact: true }).first().waitFor()
    const columns = await list.evaluate(node => {
      const cells = [...node.querySelector('.ssb-row-main').children].slice(2, -1)
      const edges = cells.map(cell => cell.getBoundingClientRect())
      const headers = [...node.querySelector('.ssb-row-head').children].slice(2, -1)
      return { gaps: edges.slice(1).map((edge, i) => edge.left - edges[i].right), aligned: headers.every((header, i) => Math.abs(header.getBoundingClientRect().right - edges[i].right) < 1), rangeFits: cells[4].scrollWidth <= cells[4].clientWidth }
    })
    assert.ok(columns.gaps.every(gap => gap >= 11), `相邻行情列需要留白：${columns.gaps.join(', ')}`)
    assert.ok(columns.aligned && columns.rangeFits, '表头和数据对齐，最高/最低完整可读')
    assert.equal(await list.locator('.ssb-row-main .ssb-cell-range').textContent(), '3544.60 / 3476.65')
    await page.setViewportSize({ width: 920, height: 900 })
    await list.locator('.ssb-row-sub').waitFor()
    assert.match(await list.locator('.ssb-row-sub').textContent(), /开3503\.52高3544\.60低3476\.65/)
    assert.equal(await list.evaluate(node => node.scrollWidth - node.clientWidth), 0)
    await page.setViewportSize({ width: 320, height: 900 })
    assert.ok((await list.getByRole('button', { name: /上证指数/ }).boundingBox()).width >= 80, '极窄面板仍给证券名留出空间')
    assert.equal(await list.getByText('涨跌额-7.67', { exact: true }).isVisible(), true, '涨跌额在次要行仍可见')
    assert.equal(await list.evaluate(node => node.scrollWidth - node.clientWidth), 0)
  } finally {
    await page.unroute(route)
    await page.setViewportSize({ width: 1280, height: 900 })
  }
})

test('自选拖动重排同步到悬浮盯盘，不额外请求行情', async () => {
  const base = '**/api/stock-assistant/'
  const [a, b, c] = ['600001', '600002', '600003'].map(code => `XSHG:equity:${code}`)
  let order = [a, b, c], refreshes = 0
  const trends = []
  const items = Object.fromEntries(order.map((id, index) => [id, { id, exchange: 'XSHG', code: id.split(':').at(-1), officialName: `标的${index + 1}` }]))
  await page.route(`${base}snapshot`, async handler => {
    const response = await handler.fetch()
    const body = await response.json()
    body.data.control.watchlist = { order, items }
    body.data.control.preferences.floatRefreshSeconds = 30
    body.data.serverEpoch = 1
    body.data.routingRevision = 1
    await handler.fulfill({ response, json: body })
  })
  await page.route(`${base}refresh`, handler => {
    refreshes++
    return handler.fulfill({ json: { ok: true, data: { quotes: {} } } })
  })
  await page.route(`${base}kline?*`, handler => {
    trends.push(new URL(handler.request().url()).searchParams.get('securityId'))
    const candles = Array.from({ length: 241 }, (_, index) => ({
      at: 1_700_000_000 + index * 60,
      open: 10 + index / 100,
      high: 10.02 + index / 100,
      low: 9.98 + index / 100,
      close: 10 + index / 100,
      volume: 100 + index,
    }))
    return handler.fulfill({ json: { ok: true, data: { candles, preClose: 10, routeEpoch: 0, serverEpoch: 1, routingRevision: 1 } } })
  })
  await page.route(`${base}watchlist`, handler => {
    const { action, payload, expectedRevision } = handler.request().postDataJSON()
    assert.equal(action, 'reorder')
    order = payload.order
    return handler.fulfill({ json: { ok: true, data: { revision: expectedRevision + 1 } } })
  })
  try {
    await page.evaluate(ids => localStorage.setItem('ssb-floating', JSON.stringify({ open: true, ids })), [a, b])
    await Promise.all([page.waitForResponse(`${base}refresh`), page.reload()])
    const float = page.getByRole('complementary', { name: '悬浮盯盘' })
    const names = float.locator('.ssb-float-row-name')
    assert.deepEqual(await names.allTextContents(), ['标的1', '标的2'])
    assert.equal(refreshes, 1)
    await page.locator(`.ssb-row[data-security-id="${b}"]`).dragTo(page.locator(`.ssb-row[data-security-id="${a}"]`), { targetPosition: { x: 28, y: 5 } })
    await names.first().filter({ hasText: '标的2' }).waitFor()
    assert.deepEqual(await names.allTextContents(), ['标的2', '标的1'])
    assert.equal(refreshes, 1)
    await float.getByRole('button', { name: '选择观测目标' }).click()
    await float.getByText('跟随自选页手动排序', { exact: true }).waitFor()
    assert.deepEqual(await float.locator('.ssb-float-picker label').allTextContents(), ['标的2', '标的1', '标的3'])
    await float.getByRole('button', { name: '完成选择' }).click()
    // 列表单选后仍可换选同组另一只，只有再次激活当前行才进入图。
    const first = float.getByRole('button', { name: /标的1/ })
    const second = float.getByRole('button', { name: /标的2/ })
    const listMode = float.getByRole('button', { name: '列表', exact: true })
    const selectedRow = float.locator('.ssb-float-row-on')
    await first.click()
    assert.equal(await listMode.getAttribute('aria-pressed'), 'true')
    assert.equal(await first.getAttribute('aria-pressed'), 'true')
    assert.equal(await second.getAttribute('aria-pressed'), 'false')
    await second.click()
    assert.equal(await selectedRow.count(), 1)
    assert.match(await selectedRow.textContent(), /标的2/)
    assert.equal(await listMode.getAttribute('aria-pressed'), 'true')
    assert.deepEqual(trends, [], '列表换选不请求分时')
    await Promise.all([page.waitForResponse(`${base}kline?*`), second.press('Enter')])
    const spark = float.locator('.ssb-float-spark-wrap')
    await spark.waitFor()
    const before = await spark.locator('.ssb-float-line').getAttribute('d')
    const box = await spark.boundingBox()
    const plotRatio = 0.7 / (224 / 264)
    const anchorBefore = Math.round(plotRatio * 240)
    await page.mouse.move(box.x + box.width * 0.7, box.y + box.height / 2)
    await page.mouse.wheel(0, -240)
    await page.waitForTimeout(50)
    const zoomed = await spark.locator('.ssb-float-line').getAttribute('d')
    assert.notEqual(zoomed, before, '滚轮要改变时间窗')
    assert.ok(zoomed.split('L').length < before.split('L').length, '上滚缩小时间窗')
    const zoomStart = Number(await spark.getAttribute('data-window-start'))
    const zoomSpan = Number(await spark.getAttribute('data-window-span'))
    assert.ok(zoomSpan < 241)
    assert.ok(Math.abs(zoomStart + Math.round(plotRatio * (zoomSpan - 1)) - anchorBefore) <= 1, '缩放锚点停在指针那一分钟')
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
    await page.mouse.down()
    await page.mouse.move(box.x + box.width / 2 + 40, box.y + box.height / 2)
    await page.mouse.up()
    await page.waitForTimeout(50)
    assert.ok(Number(await spark.getAttribute('data-window-start')) < zoomStart, '向右拖动查看更早历史')
    await spark.dblclick()
    await page.waitForFunction(() => document.querySelector('.ssb-float-spark-wrap')?.getAttribute('data-window-span') === '241')
    assert.equal(await spark.locator('.ssb-float-line').getAttribute('d'), before, '双击恢复全天')
    await page.locator(`.ssb-row[data-security-id="${a}"]`).dragTo(page.locator(`.ssb-row[data-security-id="${b}"]`), { targetPosition: { x: 28, y: 5 } })
    await page.locator('.ssb-row').first().filter({ hasText: '标的1' }).waitFor()
    assert.equal(await float.locator('.ssb-float-name').textContent(), '标的2', '重排不切换正在看的分时图')
    assert.deepEqual(trends, [b])
    const unseen = 'XSHG:equity:600004'
    const sharedPreference = await page.evaluate(async ([visible, unseen]) => {
      const key = 'ssb-floating'
      const next = JSON.stringify({ ...JSON.parse(localStorage.getItem(key)), ids: [visible, unseen], securityId: unseen })
      localStorage.setItem(key, next)
      window.dispatchEvent(new StorageEvent('storage', { key, newValue: next }))
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))
      return JSON.parse(localStorage.getItem(key))
    }, [b, unseen])
    assert.equal(sharedPreference.securityId, unseen, '快照落后的标签页不能覆盖另一页的选股')
  } finally {
    await page.evaluate(() => localStorage.removeItem('ssb-floating'))
    for (const path of ['snapshot', 'refresh', 'watchlist', 'kline?*']) await page.unroute(`${base}${path}`)
  }
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

test('悬浮图 3 秒档继续消费报价，首分钟内不重拉分时', async () => {
  const tab = await context.newPage()
  const path = '**/api/stock-assistant/'
  const id = 'XSHG:equity:600519'
  const epoch = 'fixture-minute'
  const start = Date.parse('2026-11-25T01:53:05Z')
  const quotes = [], trends = [], errors = [], network = []
  const cdp = await context.newCDPSession(tab)
  await cdp.send('Network.enable')
  cdp.on('Network.requestWillBeSent', ({ request }) => {
    const url = new URL(request.url)
    if (url.pathname.startsWith('/api/stock-assistant/')) network.push({ path: url.pathname, method: request.method })
  })
  const item = { id, exchange: 'XSHG', code: '600519', officialName: '茅台', priceScale: 2, timezone: 'Asia/Shanghai' }
  const snapshot = { serverEpoch: epoch, snapshotSeq: 1, routingRevision: 1, quotes: {}, control: { revision: 1, watchlist: { order: [id], items: { [id]: item } }, preferences: { refreshSeconds: 15, floatRefreshSeconds: 3 }, routes: [], providers: [] } }
  const startSeconds = Math.floor(start / 1000)
  const candle = (offset, time, price) => ({ time, at: startSeconds - offset, open: price, high: price, low: price, close: price })
  tab.on('pageerror', e => errors.push(e.message))
  try {
    await tab.clock.install({ time: start - 1000 })
    await tab.clock.pauseAt(start)
    await tab.route(`${path}snapshot`, handler => handler.fulfill({ json: { ok: true, data: snapshot } }))
    await tab.route(`${path}refresh`, async handler => {
      const at = await tab.evaluate(() => Date.now())
      quotes.push({ at, body: handler.request().postDataJSON() })
      const last = quotes.length === 1 ? '10.30' : '10.40'
      const quote = { securityId: id, routingRevision: 1, quoteAt: new Date(at).toISOString(), timestampKind: 'trade', receivedAt: at, sessionState: 'trading', last, previousClose: '10.00' }
      return handler.fulfill({ json: { ok: true, data: { ...snapshot, quotes: { [id]: { health: 'ok', quote } } } } })
    })
    await tab.route(`${path}kline?*`, async handler => {
      trends.push(await tab.evaluate(() => Date.now()))
      const data = { securityId: id, serverEpoch: epoch, routingRevision: 1, sessionDate: '2026-11-25', preClose: 10, fetchedAt: start, complete: true, candles: [candle(125, '09:51', 10.1), candle(65, '09:52', 10.2)] }
      return handler.fulfill({ json: { ok: true, data } })
    })
    await tab.addInitScript(sid => localStorage.setItem('ssb-floating', JSON.stringify({ open: true, ids: [sid], mode: 'kline', securityId: sid })), id)
    await tab.goto(page.url())
    const price = tab.locator('.ssb-float-price')
    // 首屏先以真分时或报价出图；按时间推进，网络请求用响应屏障，避免虚拟时间和异步 fetch 串拍。
    await tab.clock.runFor(2000)
    await price.filter({ hasText: /10\.(20|30)/ }).waitFor({ timeout: 5000 })
    const curve = tab.locator('.ssb-float-line')
    await curve.waitFor({ timeout: 5000 })
    const initialPath = await curve.getAttribute('d')
    assert.equal(trends.length, 1)
    // 先显式复位到全天, 再让报价追加第三根: 全天必须保持哨兵, 不能从第一根漂走
    await tab.locator('.ssb-float-spark-wrap').dblclick()
    for (let i = 0; i < 3; i++) {
      const response = tab.waitForResponse(`${path}refresh`, { timeout: 5000 })
      await tab.clock.runFor(3 * 1000)
      await response
    }
    await price.filter({ hasText: '10.40' }).waitFor({ timeout: 5000 })
    const quotedPath = await curve.getAttribute('d')
    assert.equal(quotedPath.match(/L/g)?.length, 2, '两根真实分时加一根报价点，同分钟多次报价不增加点数')
    assert.notEqual(quotedPath, initialPath, '报价必须实际改变分时折线')
    const spark = tab.locator('.ssb-float-spark-wrap')
    assert.equal(await spark.getAttribute('data-window-start'), '0', '全天不能随着新点丢掉第一根')
    assert.equal(await spark.getAttribute('data-window-span'), '3', '全天窗口覆盖新增的第三根')
    assert.equal(trends.length, 1, '报价节拍不能触发新分时')
    assert.ok(quotes.every(({ body }) => body.automatic === true && body.expectedRoutingRevision === 1))
    const next = tab.waitForResponse(`${path}kline?*`, { timeout: 5000 })
    await tab.clock.fastForward(trends[0] + 61 * 1000 - await tab.evaluate(() => Date.now()))
    await next
    assert.equal(trends.length, 2)
    assert.ok(trends[1] - trends[0] >= 60 * 1000)
    assert.equal(network.filter(({ path, method }) => path.endsWith('/kline') && method === 'GET').length, 2)
    assert.deepEqual(errors, [])
  } finally {
    await tab.evaluate(() => localStorage.removeItem('ssb-floating')).catch(() => {})
    await tab.close()
  }
})
