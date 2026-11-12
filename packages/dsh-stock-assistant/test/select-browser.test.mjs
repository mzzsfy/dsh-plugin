import test, { before, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'

// 自绘下拉的验收: 原生 select 的菜单进不了 DOM, 自动化点不到; 这里用真实浏览器点开菜单并选值,
// 把「打开→选择→写盘」整条链路跑通。夹具是内存 app + 真 React 客户端, 不碰生产宿主。
let fixture, browser, page, errors, fixtureExit

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
  browser = await chromium.launch({ headless: true, channel: 'chrome' })
  page = await browser.newPage({ viewport: { width: 1280, height: 900 }, locale: 'zh-CN' })
  errors = []
  page.on('pageerror', error => errors.push(error.message))
  await page.goto(url)
  await page.waitForSelector('.ssb-root')
})

after(async () => {
  await browser?.close()
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
