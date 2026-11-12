import test, { before, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromium } from 'playwright'

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

function preferenceResponse() {
  return page.waitForResponse(response => response.url().includes('/api/stock-assistant/preferences') && response.request().method() === 'POST')
}

test('鼠标点开下拉并选择: 菜单进 DOM, 选择后写盘且菜单关闭', async () => {
  await openPreferences()
  const trigger = page.getByRole('combobox', { name: '悬浮盯盘刷新' })
  await trigger.click()
  const listbox = page.getByRole('listbox', { name: '悬浮盯盘刷新' })
  await listbox.waitFor({ state: 'visible' })
  const pending = preferenceResponse()
  await listbox.getByRole('option', { name: '30秒' }).click()
  const response = await pending
  assert.equal(response.status(), 200)
  const body = await response.json()
  assert.equal(body.ok, true)
  assert.equal(body.data.unchanged, false)
  assert.equal(await trigger.getAttribute('aria-expanded'), 'false')
  assert.match(await trigger.innerText(), /30秒/)
  await assert.rejects(listbox.waitFor({ state: 'visible', timeout: 1000 }), '选择后菜单关闭')
  assert.equal(errors.length, 0)
})

test('键盘打开与选择, Escape 只关菜单不关设置弹窗', async () => {
  const trigger = page.getByRole('combobox', { name: '刷新间隔' })
  await trigger.focus()
  await page.keyboard.press('Enter')
  const listbox = page.getByRole('listbox', { name: '刷新间隔' })
  await listbox.waitFor({ state: 'visible' })
  const pending = preferenceResponse()
  await page.keyboard.press('ArrowDown')
  await page.keyboard.press('Enter')
  const response = await pending
  assert.equal(response.status(), 200)
  assert.match(await trigger.innerText(), /30秒/)
  // 再打开一次, Escape 只收菜单
  await trigger.click()
  await listbox.waitFor({ state: 'visible' })
  await page.keyboard.press('Escape')
  await assert.rejects(listbox.waitFor({ state: 'visible', timeout: 1000 }), 'Escape 关闭菜单')
  await page.getByRole('dialog', { name: '设置' }).waitFor({ state: 'visible' })
  await trigger.click()
  await page.getByRole('option', { name: '15秒' }).click()
  await page.getByRole('button', { name: '关闭' }).click()
  assert.equal(errors.length, 0)
})

test('点击菜单外关闭下拉, 设置弹窗保持打开', async () => {
  await openPreferences()
  const trigger = page.getByRole('combobox', { name: '涨跌颜色' })
  const listbox = page.getByRole('listbox', { name: '涨跌颜色' })
  await trigger.click()
  await listbox.waitFor({ state: 'visible' })
  await trigger.click()
  await assert.rejects(listbox.waitFor({ state: 'visible', timeout: 1000 }), '再次点触发器关闭菜单')
  await trigger.click()
  await listbox.waitFor({ state: 'visible' })
  await page.locator('.ssb-settings h3').first().click()
  await assert.rejects(listbox.waitFor({ state: 'visible', timeout: 1000 }), '点菜单外关闭菜单')
  await page.getByRole('dialog', { name: '设置' }).waitFor({ state: 'visible' })
})
