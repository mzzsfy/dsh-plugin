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
  // 不依赖上一条用例把设置弹窗留着: 单跑本用例也要能过
  if (!(await page.getByRole('dialog').count())) await openPreferences()
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
  // 推送闸门构造恒定冲突: 挂起 invalidate 后 bump 到 R+1, 页面 revision 恒持 R(推送被闸,
  // 不存在「SSE 推送 vs 页面保存请求」的到达竞速), 保存提交 R 对服务器 R+1 —— 409 由构造决定。
  // finally 必须放行积压推送并等页面补对账, 不给后续用例留下失联页面
  const revision = await page.evaluate(async () => (await (await fetch('/api/stock-assistant/snapshot')).json()).data.control.revision)
  await page.evaluate(async () => { await fetch('/fixture/hold', { method: 'POST', body: '{"on":true}' }) })
  try {
    const bumped = await page.evaluate(async expected => {
      const response = await fetch('/api/stock-assistant/preferences', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ operationId: crypto.randomUUID(), expectedRevision: expected, patch: { refreshSeconds: 60 } }) })
      return response.status
    }, revision)
    assert.equal(bumped, 200)
    const pending = page.waitForResponse(response => response.url().includes('/api/stock-assistant/configuration') && response.request().method() === 'POST')
    await page.getByRole('button', { name: '保存数据源' }).click()
    assert.equal((await pending).status(), 409)
    assert.match(await page.locator('.ssb-banner.ssb-error').innerText(), /数据已被其他页面修改/)
    await assertBannerAboveOverlay()
    assert.equal(errors.length, 0)
  } finally {
    await page.evaluate(async () => { await fetch('/fixture/hold', { method: 'POST', body: '{"on":false}' }) })
    await page.waitForFunction(async expected => (await (await fetch('/api/stock-assistant/snapshot')).json()).data.control.revision >= expected, revision + 1, { timeout: 5000 }).catch(() => {})
  }
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
      const response = tab.waitForResponse(`${path}refresh`, { timeout: 15000 })
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
    // 假时钟作用在整个浏览器上下文: 只关标签页不复原, 后续用例页面的定时器会一起冻住;
    // resume 只恢复定时器, 停在虚拟时间上, 还要把系统时间拨回墙钟
    await tab.clock.setSystemTime(new Date()).catch(() => {})
    await tab.clock.resume().catch(() => {})
    await tab.evaluate(() => localStorage.removeItem('ssb-floating')).catch(() => {})
    await tab.close()
  }
})

test('暂停采集后悬浮盯盘停拍, 恢复后继续', async () => {
  const tab = await context.newPage()
  const path = '**/api/stock-assistant/'
  const id = 'XSHG:equity:600519'
  const epoch = 'fixture-pause'
  const quotes = [], errors = []
  const item = { id, exchange: 'XSHG', code: '600519', officialName: '茅台', priceScale: 2, timezone: 'Asia/Shanghai' }
  const snapshot = { serverEpoch: epoch, snapshotSeq: 1, routingRevision: 1, quotes: {}, control: { revision: 1, watchlist: { order: [id], items: { [id]: item } }, preferences: { refreshSeconds: 15, floatRefreshSeconds: 3 }, routes: [], providers: [] } }
  tab.on('pageerror', e => errors.push(e.message))
  try {
    // 真时钟: 暂停开关在「更多」菜单里, 假时钟暂停后 React 提交与菜单开合都要靠推进虚拟时间, 交互链更脆
    await tab.route(`${path}snapshot`, handler => handler.fulfill({ json: { ok: true, data: snapshot } }))
    await tab.route(`${path}refresh`, async handler => {
      const at = Date.now()
      quotes.push(at)
      const quote = { securityId: id, routingRevision: 1, quoteAt: new Date(at).toISOString(), timestampKind: 'trade', receivedAt: at, sessionState: 'trading', last: '10.30', previousClose: '10.00' }
      return handler.fulfill({ json: { ok: true, data: { ...snapshot, quotes: { [id]: { health: 'ok', quote } } } } })
    })
    await tab.addInitScript(sid => localStorage.setItem('ssb-floating', JSON.stringify({ open: true, ids: [sid], mode: 'list' })), id)
    await tab.goto(page.url())
    // 面板默认不激活时夹具只渲染入口按钮: 暂停开关在面板顶栏里, 先把面板打开
    const entry = tab.getByRole('button', { name: '打开股票' })
    if (await entry.count()) await entry.click()
    await tab.locator('.ssb-float-row-price').filter({ hasText: /10.30/ }).waitFor({ timeout: 5000 })
    const first = quotes.length
    assert.ok(first >= 1, '首拍已取数')
    // 暂停后浮窗不应再发自动刷新: 面板暂停的语义是停掉全部自动采集
    // 勾选后菜单仍开着: 再点「更多」只会把它关掉, 所以先确保菜单是展开态
    const togglePause = async () => {
      if (!(await tab.locator('.ssb-menu').count())) await tab.getByRole('button', { name: '更多操作' }).click()
      await tab.locator('.ssb-menu .ssb-switch input').first().click()
      await tab.keyboard.press('Escape')
      await tab.locator('.ssb-menu').waitFor({ state: 'detached', timeout: 2000 }).catch(() => {})
    }
    await togglePause()
    await tab.getByText('自动采集已暂停', { exact: false }).waitFor({ timeout: 5000 })
    // 在途的一拍可能在点暂停前已发出: 等它落地再取基线, 否则会假红
    await tab.waitForTimeout(300)
    const pausedAt = quotes.length
    await tab.waitForTimeout(4 * 1000)
    assert.equal(quotes.length, pausedAt, '暂停后浮窗停拍')
    await togglePause()
    await tab.getByText('自动采集已暂停', { exact: false }).waitFor({ state: 'detached', timeout: 5000 })
    await tab.waitForTimeout(4 * 1000)
    assert.ok(quotes.length > pausedAt, '恢复采集后浮窗继续取数')
    assert.deepEqual(errors, [])
  } finally {
    await tab.evaluate(() => localStorage.removeItem('ssb-floating')).catch(() => {})
    await tab.unroute(`${path}snapshot`).catch(() => {})
    await tab.unroute(`${path}refresh`).catch(() => {})
    await tab.close()
  }
})

test('窗口缩小后悬浮盯盘收回视口, 放大回保存位置', async () => {
  const base = '**/api/stock-assistant/'
  const id = 'XSHG:equity:600001'
  // 十只标的让选择器足以长到改变卡片高度, 覆盖尺寸变化路径
  const order = Array.from({ length: 10 }, (_, index) => `XSHG:equity:${600001 + index}`)
  const items = Object.fromEntries(order.map((sid, index) => [sid, { id: sid, exchange: 'XSHG', code: sid.split(':').at(-1), officialName: `标的${index + 1}` }]))
  // 落点在 1280×900 下合法(右/下各留 8px), 且离右边够近: 缩到 700×520 后原坐标必然越界。
  // y 取 450 而不是更靠下, 让「放大回来」的断言不受卡片高度变化影响
  const saved = { x: 980, y: 450 }
  await page.route(`${base}snapshot`, async handler => {
    const response = await handler.fetch()
    const body = await response.json()
    body.data.serverEpoch = 'fixture-resize'
    body.data.routingRevision = 1
    body.data.control.watchlist = { order, items }
    body.data.quotes = { [id]: { health: 'ok', quote: { securityId: id, last: '10.00', previousClose: '9.90', receivedAt: Date.now(), sessionState: 'trading' } } }
    await handler.fulfill({ response, json: body })
  })
  await page.route(`${base}refresh`, handler => handler.fulfill({ json: { ok: true, data: { quotes: {} } } }))
  // 用户可见契约: 四边至少留 8px; 贴边的一侧必须正好是 8px, 不是"大于 8"
  const MARGIN = 8
  const placeOf = async float => {
    const box = await float.boundingBox(), viewport = page.viewportSize()
    const gaps = { left: box.x, top: box.y, right: viewport.width - box.x - box.width, bottom: viewport.height - box.y - box.height }
    return { box, viewport, gaps, inside: Object.values(gaps).every(gap => gap >= MARGIN - 0.5) }
  }
  // 视口变化要等 React 提交落地: 后台标签页不跑 rAF, 用条件轮询而不是帧同步或固定 sleep
  const until = async (float, check, label, timeout = 4000) => {
    const deadline = Date.now() + timeout
    let last
    for (;;) {
      last = await placeOf(float)
      if (check(last)) return last
      if (Date.now() > deadline) assert.fail(`等待超时: ${label} (${JSON.stringify(last)})`)
      await page.waitForTimeout(50)
    }
  }
  try {
    await page.bringToFront()
    await page.setViewportSize({ width: 1280, height: 900 })
    await page.evaluate(([sid, at]) => localStorage.setItem('ssb-floating', JSON.stringify({ open: true, mode: 'list', ids: [sid], x: at.x, y: at.y })), [id, saved])
    await page.reload()
    const float = page.getByRole('complementary', { name: '悬浮盯盘' })
    await float.waitFor()
    // 快照到达前浮窗只有空态: 先等已勾选的行渲染出来, 否则序列器还没把自选交给浮窗
    await float.locator('.ssb-float-row').first().waitFor()
    const placed = await until(float, place => Math.round(place.box.x) === saved.x && Math.round(place.box.y) === saved.y, '大视口按保存坐标放置')
    assert.deepEqual([Math.round(placed.box.x), Math.round(placed.box.y)], [saved.x, saved.y], '大视口按保存坐标放置')
    await page.setViewportSize({ width: 700, height: 520 })
    const shrunk = await until(float, place => place.inside, '缩小后收回视口')
    assert.ok(shrunk.inside, `缩小后整张卡仍在视口内: ${JSON.stringify(shrunk)}`)
    assert.ok(Math.abs(shrunk.gaps.right - MARGIN) <= 1, `右侧边距正好 8px: ${shrunk.gaps.right}`)
    await float.getByRole('button', { name: '选择观测目标' }).click()
    await float.getByText('跟随自选页手动排序', { exact: true }).waitFor()
    const grown = await until(float, place => place.inside, '卡片长高后仍收在视口内')
    assert.ok(grown.inside, `卡片长高后仍收在视口内: ${JSON.stringify(grown)}`)
    await float.getByRole('button', { name: '完成选择' }).click()
    await page.setViewportSize({ width: 1280, height: 900 })
    const restored = await until(float, place => Math.round(place.box.x) === saved.x && Math.round(place.box.y) === saved.y, '放大后回到保存位置')
    assert.deepEqual([Math.round(restored.box.x), Math.round(restored.box.y)], [saved.x, saved.y], '放大后回到保存位置, 尺寸变化不改写偏好')
    assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('ssb-floating')).x), saved.x, '保存的坐标不被渲染侧夹取覆盖')
    assert.deepEqual(errors, [], 'resize/RO 期间不得有页面异常')
  } finally {
    await page.evaluate(() => localStorage.removeItem('ssb-floating')).catch(() => {})
    await page.unroute(`${base}snapshot`)
    await page.unroute(`${base}refresh`)
    await page.setViewportSize({ width: 1280, height: 900 })
  }
})

// 提交计数: 面板与浮窗是两个 React root, 借 devtools hook 数每个 root 的提交次数。
// 趋势落点只该让浮窗重渲染; 面板跟着重渲染说明还在借 patch({}) 伪造刷新。
async function countCommits(tab) {
  await tab.addInitScript(() => {
    window.__commits = {}
    const hook = window.__REACT_DEVTOOLS_GLOBAL_HOOK__ = window.__REACT_DEVTOOLS_GLOBAL_HOOK__ || { renderers: new Map(), supportsFiber: true, inject() { return 1 }, onCommitFiberRoot() {}, onCommitFiberUnmount() {} }
    hook.onCommitFiberRoot = (id, root) => {
      const container = root.containerInfo
      const key = container?.id || container?.className || 'unknown'
      window.__commits[key] = (window.__commits[key] || 0) + 1
    }
  })
}

test('浮窗更新不牵动面板重渲染', async () => {
  const tab = await context.newPage()
  const base = '**/api/stock-assistant/'
  const id = 'XSHG:equity:600519'
  const epoch = 'fixture-commit'
  const errors = []
  tab.on('pageerror', e => errors.push(e.message))
  await countCommits(tab)
  const item = { id, exchange: 'XSHG', code: '600519', officialName: '茅台', priceScale: 2, timezone: 'Asia/Shanghai' }
  // 面板档位放到观测窗口外: 观测期内的提交只可能来自浮窗自己
  const snapshot = { serverEpoch: epoch, snapshotSeq: 1, routingRevision: 1, quotes: {}, control: { revision: 1, watchlist: { order: [id], items: { [id]: item } }, preferences: { refreshSeconds: 3600, floatRefreshSeconds: 3 }, routes: [], providers: [] } }
  let polls = 0
  try {
    await tab.route(`${base}snapshot`, handler => handler.fulfill({ json: { ok: true, data: snapshot } }))
    await tab.route(`${base}kline?*`, handler => {
      const at = Math.floor(Date.now() / 1000)
      const candles = Array.from({ length: 30 }, (_, i) => ({ at: at - (30 - i) * 60, time: `10:${String(i).padStart(2, '0')}`, open: 10, high: 10.1, low: 9.9, close: 10 }))
      return handler.fulfill({ json: { ok: true, data: { securityId: id, serverEpoch: epoch, routingRevision: 1, sessionDate: new Date().toISOString().slice(0, 10), preClose: 10, fetchedAt: Date.now(), complete: true, candles } } })
    })
    await tab.route(`${base}refresh`, async handler => {
      // 每次报价都换价: 浮窗每拍必有状态变化, 提交数才是可判定的
      polls += 1
      const at = Date.now(), last = polls % 2 ? '10.30' : '10.40'
      const quote = { securityId: id, routingRevision: 1, quoteAt: new Date(at).toISOString(), timestampKind: 'trade', receivedAt: at, sessionState: 'trading', last, previousClose: '10.00' }
      return handler.fulfill({ json: { ok: true, data: { ...snapshot, quotes: { [id]: { health: 'ok', quote } } } } })
    })
    await tab.addInitScript(sid => localStorage.setItem('ssb-floating', JSON.stringify({ open: true, ids: [sid], mode: 'kline', securityId: sid })), id)
    await tab.goto(page.url())
    const entry = tab.getByRole('button', { name: '打开股票' })
    if (await entry.count()) await entry.click()
    const float = tab.getByRole('complementary', { name: '悬浮盯盘' })
    await float.waitFor()
    // SVG 折线没有布局盒子, 只等它挂上 DOM
    await float.locator('.ssb-float-line').first().waitFor({ state: 'attached', timeout: 10000 })
    await tab.waitForTimeout(500)
    const baseline = await tab.evaluate(() => ({ ...window.__commits }))
    assert.ok((baseline['app'] || 0) > 0, '面板 root 容器键必须真的在计数, 否则断言会空转')
    // 两拍报价窗口: 浮窗每次落值都要提交, 面板一次都不该提交
    await tab.waitForTimeout(5 * 1000)
    const after = await tab.evaluate(() => ({ ...window.__commits }))
    assert.ok(polls >= 2, '观测窗口内必须真的取过报价')
    assert.equal((after['app'] || 0) - (baseline['app'] || 0), 0, '浮窗更新不得触发面板 root 提交')
    assert.ok((after['ssb-float-root'] || 0) > (baseline['ssb-float-root'] || 0), '浮窗必须持续更新')
    assert.equal(await float.locator('.ssb-float-line').count(), 1, '折线仍在')
    assert.deepEqual(errors, [])
  } finally {
    await tab.evaluate(() => localStorage.removeItem('ssb-floating')).catch(() => {})
    for (const path of [`${base}snapshot`, `${base}kline?*`, `${base}refresh`]) await tab.unroute(path).catch(() => {})
    await tab.close()
  }
})

test('标记保存失败时保留草稿并在原处报错', async () => {
  const base = '**/api/stock-assistant/'
  const id = 'XSHG:equity:600519'
  const item = { id, exchange: 'XSHG', code: '600519', officialName: '茅台', priceScale: 2, timezone: 'Asia/Shanghai', marks: [] }
  const snapshot = { serverEpoch: 'fixture-marks', snapshotSeq: 1, routingRevision: 1, quotes: {}, control: { revision: 1, watchlist: { order: [id], items: { [id]: item } }, preferences: { refreshSeconds: 15 }, routes: [], providers: [] } }
  const errors = []
  page.on('pageerror', e => errors.push(e.message))
  try {
    await page.route(`${base}snapshot`, handler => handler.fulfill({ json: { ok: true, data: snapshot } }))
    await page.route(`${base}watchlist`, handler => handler.fulfill({ status: 500, json: { ok: false, error: { code: 'STORAGE_WRITE_FAILED', message: '写入失败' } } }))
    await page.reload()
    await page.locator('.ssb-row').first().click()
    const form = page.locator('.ssb-overlay .ssb-inline-form').first()
    await form.locator('.ssb-input-num').fill('1428')
    await form.getByRole('button', { name: '添加标记' }).click()
    // 就地提示: 顶部横幅在抽屉之下, 用户看不到
    const markError = page.locator('.ssb-overlay .ssb-form-error').first()
    await markError.waitFor({ timeout: 5000 })
    assert.equal(await form.locator('.ssb-input-num').inputValue(), '1428', '失败必须保留草稿')
    assert.match(await markError.innerText(), /写入失败|标记保存失败/)
    // 成功路径必须回到干净状态: 草稿清空, 错误消失
    // 成功路径: 夹具的真实存储版本与桩快照不同代, 会撞 409, 这里直接给成功响应
    await page.unroute(`${base}watchlist`)
    await page.route(`${base}watchlist`, handler => handler.fulfill({ json: { ok: true, data: { revision: 2, unchanged: false } } }))
    await form.getByRole('button', { name: '添加标记' }).click()
    await page.waitForFunction(() => document.querySelector('.ssb-overlay .ssb-inline-form .ssb-input-num')?.value === '', null, { timeout: 5000 })
    assert.equal(await page.locator('.ssb-overlay .ssb-form-error').count(), 0, '成功后错误提示必须消失')
    // 抽屉里的图表要宿主内置组件, 夹具没有: 只断言与标记无关的异常为零
    assert.deepEqual(errors.filter(message => !/Unexpected token|图表/.test(message)), [])
  } finally {
    await page.unroute(`${base}snapshot`).catch(() => {})
    await page.unroute(`${base}watchlist`).catch(() => {})
    await page.reload()
  }
})

test('搜索候选预览是按钮: 键盘聚焦后 Enter 进详情', async () => {
  const base = '**/api/stock-assistant/'
  const id = 'XSHG:equity:600519'
  const item = { id, exchange: 'XSHG', code: '600519', officialName: '茅台', currency: 'CNY', priceScale: 2, timezone: 'Asia/Shanghai' }
  // 搜索结果按快照里的路由版本判新旧: 版本对不上客户端会整批丢弃
  let routingRevision = 0
  try {
    await page.route(`${base}snapshot`, async handler => {
      const response = await handler.fetch(), body = await response.json()
      routingRevision = body.data.routingRevision
      await handler.fulfill({ response, json: body })
    })
    await page.route(`${base}search*`, handler => handler.fulfill({ json: { ok: true, data: { items: [item], catalogs: [], routingRevision } } }))
    await page.route(`${base}refresh`, handler => handler.fulfill({ json: { ok: true, data: { quotes: {} } } }))
    await page.getByRole('button', { name: '搜索' }).first().click()
    const input = page.locator('.ssb-search-input, input[type="search"]').first()
    await input.fill('茅台')
    const peek = page.locator('.ssb-peek').first()
    await peek.waitFor({ timeout: 5000 })
    // 元素类型必须是按钮: span + role=button 能进 tab 序但 Enter/Space 什么都不会发生
    assert.equal(await peek.evaluate(node => node.tagName), 'BUTTON', '预览必须是真按钮')
    await peek.focus()
    await page.keyboard.press('Enter')
    await page.locator('.ssb-overlay').waitFor({ timeout: 5000 })
    assert.match(await page.locator('.ssb-overlay').innerText(), /茅台/)
  } finally {
    for (const path of [`${base}search*`, `${base}refresh`, `${base}snapshot`]) await page.unroute(path).catch(() => {})
    await page.keyboard.press('Escape').catch(() => {})
  }
})

test('页面缩放后悬浮盯盘按视觉尺寸收回视口', async () => {
  const base = '**/api/stock-assistant/'
  const id = 'XSHG:equity:600001'
  const item = { id, exchange: 'XSHG', code: '600001', officialName: '标的1' }
  const saved = { x: 980, y: 450 }
  const MARGIN = 8
  // 独占标签页: 上一个用例会在共享页面上留路由与缩放状态
  const tab = await context.newPage()
  const errors = []
  tab.on('pageerror', e => errors.push(e.message))
  await tab.route(`${base}snapshot`, handler => handler.fulfill({ json: { ok: true, data: { serverEpoch: 'fixture-zoom', snapshotSeq: 1, routingRevision: 1, quotes: {}, control: { revision: 1, watchlist: { order: [id], items: { [id]: item } }, preferences: { refreshSeconds: 15 }, routes: [], providers: [] } } } }))
  await tab.route(`${base}refresh`, handler => handler.fulfill({ json: { ok: true, data: { quotes: {} } } }))
  const placeOf = async float => {
    const box = await float.boundingBox()
    const viewport = await tab.evaluate(() => ({ width: document.documentElement.clientWidth, height: document.documentElement.clientHeight }))
    return { box, viewport, right: viewport.width - box.x - box.width, bottom: viewport.height - box.y - box.height }
  }
  const until = async (float, check, label, timeout = 5000) => {
    const deadline = Date.now() + timeout
    for (;;) {
      const place = await placeOf(float)
      if (check(place)) return place
      if (Date.now() > deadline) assert.fail(`等待超时: ${label} (${JSON.stringify(place)})`)
      await tab.waitForTimeout(50)
    }
  }
  try {
    await tab.bringToFront()
    await tab.setViewportSize({ width: 1280, height: 900 })
    // 新标签页初始是 opaque origin, 先落到夹具页才能写 localStorage
    await tab.goto(page.url())
    await tab.evaluate(([sid, at]) => localStorage.setItem('ssb-floating', JSON.stringify({ open: true, mode: 'list', ids: [sid], x: at.x, y: at.y })), [id, saved])
    await tab.reload()
    const float = tab.getByRole('complementary', { name: '悬浮盯盘' })
    await float.waitFor()
    await float.locator('.ssb-float-row').first().waitFor()
    // 缩放不改布局视口, 只放大视觉尺寸: 保存坐标按布局 px 计, 缩放后必然越界
    await tab.evaluate(() => { document.documentElement.style.zoom = '1.25' })
    const zoomed = await until(float, place => place.right >= MARGIN * 1.25 - 1 && place.bottom >= MARGIN * 1.25 - 1 && place.box.x >= MARGIN * 1.25 - 1, '缩放后收回视口')
    assert.ok(zoomed.box.y >= 0, '卡片不得移出顶部')
    assert.ok(zoomed.right <= MARGIN * 1.25 + 2, '贴边即可, 不能过度收缩')
    assert.equal(await tab.evaluate(() => JSON.parse(localStorage.getItem('ssb-floating')).x), saved.x, '夹取不改写保存坐标')
    // 缩放页里拖动: 指针给的是视觉位移, 偏好存布局坐标, 两者换算错了会跳位并把错坐标写盘
    // 缩放页里拖动: 指针给的是视觉位移, 偏好存布局坐标, 两者换算错了会跳位并把错坐标写盘。
    // 卡片此刻贴在右边距上, 只能往左拖
    const before = await tab.evaluate(() => JSON.parse(localStorage.getItem('ssb-floating')).x)
    // 抓手必须落在标题条上: 卡片 padding 区不参与拖动
    const head = await float.locator('.ssb-float-head').boundingBox()
    const grabX = head.x + head.width * 0.5, grabY = head.y + head.height / 2
    await tab.mouse.move(grabX, grabY)
    await tab.mouse.down()
    await tab.mouse.move(grabX - 40, grabY, { steps: 4 })
    await tab.mouse.up()
    await tab.waitForTimeout(100)
    const after = await tab.evaluate(() => JSON.parse(localStorage.getItem('ssb-floating')).x)
    const moved = await float.boundingBox()
    // 拖动必须跟手: 旧实现把视觉位移当布局量, 在缩放页里被夹回原地, 一步都不动
    assert.ok(Math.abs(moved.x - zoomed.box.x + 40) <= 2, `拖动跟手, 实际 ${moved.x - zoomed.box.x}`)
    // 落盘的是布局坐标: 视觉左缘 / 缩放比
    assert.ok(Math.abs(after - moved.x / 1.25) <= 2, `落盘坐标必须是布局量, 实际 ${after}`)
    assert.deepEqual(errors, [])
  } finally {
    await tab.evaluate(() => { document.documentElement.style.zoom = ''; localStorage.removeItem('ssb-floating') }).catch(() => {})
    await tab.close()
  }
})
