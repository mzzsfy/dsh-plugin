// 浏览器渲染探针:真实 chromium 加载 dsh 页面,断言统一底线的浏览器半区。
// 检查项:页面含工作台文案(工作区/Workspace 任一,防 locale 假阴性)+ 无 Failed to load plugins;
// console error 全量上报供诊断(不作门槛,隔离环境存在与插件无关的环境噪音)。
// 用法:node scripts/compat/browser-probe.mjs '<JSON:{url, pngPath}>'(stdout 输出 JSON 判定)
import { writeFileSync } from 'node:fs'

const WORKSPACE_TEXT = /工作区|Workspace/
const FAIL_BANNER = 'Failed to load plugins'
const RENDER_TIMEOUT_MS = 25 * 1000
const SETTLE_MS = 2 * 1000

async function launchBrowser(playwright) {
  const attempts = [{}, { channel: 'chrome' }, { channel: 'msedge' }]
  const errors = []
  for (const options of attempts) {
    try {
      return await playwright.chromium.launch({ headless: true, ...options })
    } catch (error) {
      errors.push(String(error.message).split('\n')[0])
    }
  }
  throw new Error(`chromium 启动失败(已尝试 内置/chrome/msedge):\n${errors.join('\n')}`)
}

async function main() {
  const { url, pngPath } = JSON.parse(process.argv[2])
  const playwright = await import('playwright')
  const browser = await launchBrowser(playwright)
  try {
    const context = await browser.newContext({ locale: 'zh-CN', viewport: { width: 1280, height: 800 } })
    const page = await context.newPage()
    const consoleErrors = []
    page.on('console', (msg) => { if (msg.type() === 'error') consoleErrors.push(msg.text()) })
    page.on('pageerror', (error) => consoleErrors.push(`pageerror: ${error.message}`))

    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45 * 1000 })
    let rendered = true
    try {
      await page.waitForFunction(
        (needle) => document.body && document.body.innerText.includes(needle),
        '工作区',
        { timeout: RENDER_TIMEOUT_MS },
      )
    } catch {
      rendered = false
    }
    await page.waitForTimeout(SETTLE_MS)
    const text = await page.evaluate(() => document.body.innerText)
    const hasWorkspace = WORKSPACE_TEXT.test(text)
    const hasFailBanner = text.includes(FAIL_BANNER)
    await page.screenshot({ path: pngPath }).catch(() => {})
    const result = { ok: hasWorkspace && !hasFailBanner, rendered, hasWorkspace, hasFailBanner, consoleErrors }
    writeFileSync(pngPath.replace(/\.png$/, '.json'), JSON.stringify(result, null, 2), 'utf8')
    console.log(JSON.stringify(result))
    process.exitCode = result.ok ? 0 : 1
  } finally {
    await browser.close()
  }
}

main().catch((error) => {
  console.error(`[compat-probe] ${error.message}`)
  process.exitCode = 1
})
