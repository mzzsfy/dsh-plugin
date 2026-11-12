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
  // 本地与 amd64 缺省走系统 Chrome, DSH_BROWSER_CHANNEL=chromium 置空渠道。
  // 走 persistent context 显式提供 user-data-dir: 聚合器把 HOME/USERPROFILE 重定向
  // 到一次性 home 后, branded Chrome 判定数据目录形态失败并拒绝 DevTools 调试
  const profile = mkdtempSync(join(tmpdir(), 'select-browser-profile-'))
  context = await chromium.launchPersistentContext(profile, {
    headless: true,
    channel: process.env.DSH_BROWSER_CHANNEL === 'chromium' ? undefined : 'chrome',
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
