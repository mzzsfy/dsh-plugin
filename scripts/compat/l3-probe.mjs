// L3 功能面探针:真实 chromium 加载 dsh 页面,按步骤序列执行页面求值与同源 HTTP 探针。
// 与 browser-probe 同源的启动回退链;token URL 先行访问铸 cookie,后续页面内 fetch 同源自动过 webAuth。
// 用法:node scripts/compat/l3-probe.mjs '<JSON:{url, out, steps}>'(stdout 输出 JSON 结果)
// step 形态:
//   { name, goto: '<url>' }            页面导航
//   { name, reload: true }             重新加载当前页(隔离页面级声明状态)
//   { name, wait: ms }                 固定等待
//   { name, waitText: {text, timeout?} } 等待页面文本出现
//   { name, eval: '<js 表达式>', expect? } 页面上下文求值(可 await);expect 见 l3-assert.mjs
//   { name, assert: {selector, count?, minCount?, exists?, text?, ...} } DOM 断言
//   { name, click: '<css 选择器>' }     真实鼠标点击(触发 React 合成事件)
//   { name, type: {selector, text} }    聚焦并逐键输入(contenteditable/输入框)
//   { name, press: '<键名>' }           键盘按键(如 Enter)
//   { name, http: {path, method?, body?, headers?, expectedStatus?, expect?} } 页面内同源 fetch
//   { name, curl: {path, host, origin?, referer?, expect?} } 伪造 Host 的 curl 探针(Node 侧)
//   { name, log: {file, includes?, regex?, tail?} } 宿主日志断言(读文件)
//   { name, shot: '<绝对或相对路径>' }                  视口截图落盘(关键格留档)
//   { name, hover: '<css 选择器>' }                     真实鼠标悬停(触发 React 合成事件)
import { spawnSync } from 'node:child_process'
import { writeFileSync, readFileSync } from 'node:fs'
import { judgeAssert, judgeEval, judgeHttp, judgeLog } from './l3-assert.mjs'

const RENDER_TIMEOUT_MS = 25 * 1000
const CURL_TIMEOUT_MS = 15 * 1000
const CURL_MAX_TIME_S = 10

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

// DOM 断言采集:把选择器命中数、文本、属性与计算样式一次性序列化回 Node 侧判定
function collectAssert(spec) {
  const nodes = [...document.querySelectorAll(spec.selector)]
  const attrs = {}
  if (spec.attr) attrs[spec.attr.name] = nodes[0]?.getAttribute(spec.attr.name) ?? null
  const computed = {}
  if (spec.computed) computed[spec.computed.prop] = nodes[0] ? getComputedStyle(nodes[0])[spec.computed.prop] : null
  return {
    selector: spec.selector,
    count: nodes.length,
    texts: nodes.map((node) => (node.textContent ?? '').replace(/\s+/g, ' ').trim()),
    attrs,
    computed,
    html: nodes[0]?.innerHTML?.slice(0, 2000) ?? null,
  }
}

// 伪造 Host 探针:浏览器 fetch 不能设 Host(curl.exe 才行),cookie 从浏览器上下文手工带上
function runCurl(step, baseUrl, cookies) {
  const spec = step.curl
  const target = new URL(spec.path, baseUrl)
  const args = ['-sS', '--max-time', String(CURL_MAX_TIME_S), '-w', '\n%{http_code}', '-H', `Host: ${spec.host}`]
  if (spec.origin) args.push('-H', `Origin: ${spec.origin}`)
  if (spec.referer) args.push('-H', `Referer: ${spec.referer}`)
  if (cookies.length > 0) args.push('-H', `Cookie: ${cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join('; ')}`)
  for (const [name, value] of Object.entries(spec.headers ?? {})) args.push('-H', `${name}: ${value}`)
  args.push(target.href)
  const res = spawnSync('curl.exe', args, { encoding: 'utf8', timeout: CURL_TIMEOUT_MS })
  const raw = (res.stdout ?? '').trimEnd()
  const split = raw.lastIndexOf('\n')
  const status = Number(split >= 0 ? raw.slice(split + 1) : raw)
  const bodyText = split >= 0 ? raw.slice(0, split) : ''
  let body = bodyText
  try { body = JSON.parse(bodyText) } catch { body = bodyText.slice(0, 200) }
  if (res.error) throw new Error(`curl 执行失败: ${res.error.message}`)
  return { status, body, stderr: (res.stderr ?? '').trim().slice(0, 200) }
}

function readLogTail(spec) {
  const text = readFileSync(spec.file, 'utf8').trimEnd()
  const lines = text.split('\n')
  return spec.tail ? lines.slice(-spec.tail).join('\n') : text
}

async function main() {
  // 步骤来源:argv[2] 内联 JSON,'@path/to/file.json' 文件引用(绕 shell 引号嵌套),
  // 或 '-' 从 stdin 读(run.mjs 以此传大 payload,防 Windows 命令行长度/转义问题)
  const arg = process.argv[2]
  const payload = arg === '-'
    ? readFileSync(0, 'utf8')
    : arg.startsWith('@') ? readFileSync(arg.slice(1), 'utf8') : arg
  const { url, out, steps } = JSON.parse(payload)
  const playwright = await import('playwright')
  const browser = await launchBrowser(playwright)
  const results = []
  const consoleErrors = []
  // 文本与来源同时留档:console 归因按 URL 剔除宿主噪声(如未登录页 /login 404),不能只看文本
  const consoleDetails = []
  try {
    const context = await browser.newContext({ locale: 'zh-CN', viewport: { width: 1280, height: 800 } })
    const page = await context.newPage()
    page.on('console', (msg) => {
      if (msg.type() !== 'error') return
      const location = msg.location()
      consoleErrors.push(msg.text())
      consoleDetails.push({ text: msg.text(), url: location?.url ?? '' })
    })
    page.on('pageerror', (error) => {
      consoleErrors.push(`pageerror: ${error.message}`)
      consoleDetails.push({ text: `pageerror: ${error.message}`, url: '' })
    })

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
        } else if (step.reload !== undefined) {
          await page.reload({ waitUntil: 'domcontentloaded', timeout: 45 * 1000 })
          entry.ok = true
        } else if (step.click !== undefined) {
          await page.click(step.click, { timeout: 10 * 1000 })
          entry.ok = true
        } else if (step.type !== undefined) {
          // 富文本 composer(contenteditable)驱动:先聚焦再逐键输入,真实键盘事件;
          // hit-test 被占位层遮挡时 click 超时,focus 不做命中检测兜底
          try {
            await page.click(step.type.selector, { timeout: 10 * 1000 })
          } catch {
            await page.locator(step.type.selector).first().focus()
          }
          if (step.type.clear === true) {
            await page.locator(step.type.selector).first().fill('')
          }
          await page.type(step.type.selector, step.type.text, { delay: 20 })
          entry.ok = true
        } else if (step.press !== undefined) {
          await page.keyboard.press(step.press)
          entry.ok = true
        } else if (step.wait !== undefined) {
          await page.waitForTimeout(step.wait)
          entry.ok = true
        } else if (step.waitText !== undefined) {
          await page.waitForFunction(
            (text) => (document.body?.innerText ?? '').includes(text),
            step.waitText.text,
            { timeout: step.waitText.timeout ?? 10 * 1000 },
          )
          entry.ok = true
        } else if (step.hover !== undefined) {
          await page.hover(step.hover, { timeout: 10 * 1000 })
          entry.ok = true
        } else if (step.shot !== undefined) {
          await page.screenshot({ path: step.shot })
          entry.ok = true
          entry.value = step.shot
        } else if (step.eval !== undefined) {
          entry.value = await page.evaluate(step.eval)
          const verdict = judgeEval(step.expect, entry.value)
          entry.ok = verdict.ok
          if (!verdict.ok) {
            entry.expected = verdict.expected
            entry.actual = verdict.actual
            entry.error = verdict.error
          }
        } else if (step.assert !== undefined) {
          const actual = await page.evaluate(collectAssert, step.assert)
          const verdict = judgeAssert(step.assert, actual)
          entry.value = actual
          entry.ok = verdict.ok
          if (!verdict.ok) {
            entry.selector = actual.selector
            entry.expected = verdict.expected
            entry.actual = verdict.actual
            entry.error = verdict.error
          }
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
          // expectedStatus 显式声明(单值或区间数组);缺省 2xx 即 ok。
          // step.http.expect 优先:字段断言与状态门槛在同一次判定内完成。
          const verdict = step.http.expect !== undefined
            ? judgeHttp(step.http.expect, entry.value)
            : judgeHttp(step.http.expectedStatus === undefined ? null : { status: step.http.expectedStatus }, entry.value)
          entry.ok = verdict.ok
          if (!verdict.ok) {
            entry.expected = verdict.expected
            entry.actual = verdict.actual
            entry.error = verdict.error
          }
        } else if (step.curl !== undefined) {
          const cookies = await context.cookies()
          const response = runCurl(step, url, cookies)
          entry.value = response
          const verdict = judgeHttp(step.curl.expect, response)
          entry.ok = verdict.ok
          if (!verdict.ok) {
            entry.expected = verdict.expected
            entry.actual = verdict.actual
            entry.error = verdict.error
          }
        } else if (step.log !== undefined) {
          const text = readLogTail(step.log)
          const verdict = judgeLog(step.log, text)
          entry.value = text.length > 4000 ? text.slice(-4000) : text
          entry.ok = verdict.ok
          if (!verdict.ok) {
            entry.expected = verdict.expected
            entry.actual = verdict.actual
            entry.error = verdict.error
          }
        } else {
          entry.ok = false
          entry.error = '空步骤(无 goto/reload/wait/waitText/eval/assert/curl/log/http)'
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
  const result = { results, consoleErrors, consoleDetails }
  if (out) writeFileSync(out, JSON.stringify(result, null, 2), 'utf8')
  console.log(JSON.stringify(result))
  process.exitCode = results.every((r) => r.ok) ? 0 : 1
}

main().catch((error) => {
  console.error(`[l3-probe] ${error.message}`)
  process.exitCode = 1
})
