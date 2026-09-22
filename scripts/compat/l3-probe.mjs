// L3 功能面探针:真实 chromium 加载 dsh 页面,按步骤序列执行页面求值与同源 HTTP 探针。
// 与 browser-probe 同源的启动回退链;token URL 先行访问铸 cookie,后续页面内 fetch 同源自动过 webAuth。
// 用法:node scripts/compat/l3-probe.mjs '<JSON:{url, out, steps}>'(stdout 输出 JSON 结果)
// step 形态:
//   { name, goto: '<url>' }            页面导航
//   { name, wait: ms }                  固定等待
//   { name, eval: '<js 表达式>' }       页面上下文求值(可 await)
//   { name, click: '<css 选择器>' }     真实鼠标点击(触发 React 合成事件)
//   { name, http: {path, method?, body?, headers?} }  页面内同源 fetch
import { writeFileSync } from 'node:fs'

const RENDER_TIMEOUT_MS = 25 * 1000

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
  const { url, out, steps } = JSON.parse(process.argv[2])
  const playwright = await import('playwright')
  const browser = await launchBrowser(playwright)
  const results = []
  const consoleErrors = []
  try {
    const context = await browser.newContext({ locale: 'zh-CN', viewport: { width: 1280, height: 800 } })
    const page = await context.newPage()
    page.on('console', (msg) => { if (msg.type() === 'error') consoleErrors.push(msg.text()) })
    page.on('pageerror', (error) => consoleErrors.push(`pageerror: ${error.message}`))

    // 首 navigate:token URL 铸 cookie;等待工作台渲染基线
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45 * 1000 })
    try {
      await page.waitForFunction(
        () => document.body && document.body.innerText.includes('工作区'),
        undefined,
        { timeout: RENDER_TIMEOUT_MS },
      )
      results.push({ name: 'baseline-render', ok: true })
    } catch {
      results.push({ name: 'baseline-render', ok: false, error: '工作区文案未出现' })
    }

    for (const step of steps) {
      const entry = { name: step.name }
      try {
        if (step.goto !== undefined) {
          await page.goto(step.goto, { waitUntil: 'domcontentloaded', timeout: 45 * 1000 })
          entry.ok = true
        } else if (step.click !== undefined) {
          await page.click(step.click, { timeout: 10 * 1000 })
          entry.ok = true
        } else if (step.wait !== undefined) {
          await page.waitForTimeout(step.wait)
          entry.ok = true
        } else if (step.eval !== undefined) {
          entry.value = await page.evaluate(step.eval)
          entry.ok = true
        } else if (step.http !== undefined) {
          const { path, method = 'GET', body, headers = {} } = step.http
          entry.value = await page.evaluate(async ({ path, method, body, headers }) => {
            const res = await fetch(path, {
              method,
              headers: body !== undefined ? { 'content-type': 'application/json', ...headers } : headers,
              body: body !== undefined ? (typeof body === 'string' ? body : JSON.stringify(body)) : undefined,
            })
            const text = await res.text()
            let parsed = null
            try { parsed = JSON.parse(text) } catch { parsed = text.slice(0, 200) }
            return { status: res.status, body: parsed }
          }, { path, method, body, headers })
          entry.ok = true
        } else {
          entry.ok = false
          entry.error = '空步骤(无 goto/wait/eval/http)'
        }
      } catch (error) {
        entry.ok = false
        entry.error = String(error.message || error).split('\n')[0]
      }
      results.push(entry)
    }
  } finally {
    await browser.close()
  }
  const result = { results, consoleErrors }
  if (out) writeFileSync(out, JSON.stringify(result, null, 2), 'utf8')
  console.log(JSON.stringify(result))
  process.exitCode = results.every((r) => r.ok) ? 0 : 1
}

main().catch((error) => {
  console.error(`[l3-probe] ${error.message}`)
  process.exitCode = 1
})
