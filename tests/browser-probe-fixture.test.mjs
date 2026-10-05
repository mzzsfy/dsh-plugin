import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdtempSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { judgeProbeText } from '../scripts/compat/compat-judges.mjs'

/**
 * browser-probe fixture 实测(渲染门槛的探针的探针):本地 fixture 页三变体,
 * spawn 真 browser-probe 断言——默认绿 / 横幅红 / 空白红。锁 M4(WORKSPACE_TEXT 恒真)
 * 与 M5(FAIL_BANNER 漂移):任一常量变坏,三变体判定必然翻转,此处先红。
 * 判定本体走 compat-judges.judgeProbeText 同源(串在 compat-criteria.mjs 单点)。
 * 浏览器不可用环境(CI 未装 playwright chromium)显式跳过。
 */

const repo = join(import.meta.dirname, '..')
const fixturePath = join(repo, 'scripts', 'compat', 'test-fixture', 'index.html')

let browserReady = false
try {
  const playwright = await import('playwright')
  browserReady = existsSync(playwright.chromium.executablePath())
} catch {
  browserReady = false
}
const browserSkip = { skip: browserReady ? false : '浏览器不可用(未安装 playwright chromium),渲染门槛自测跳过' }

function startFixtureServer(t) {
  const html = readFileSync(fixturePath, 'utf8')
  const server = createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end(html)
  })
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)))
}

function runBrowserProbe(t, url) {
  const dir = mkdtempSync(join(tmpdir(), 'bp-fixture-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  // 必须异步 spawn:spawnSync 阻塞本进程事件循环,同进程 fixture 服务器无法响应
  return new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, [join(repo, 'scripts', 'compat', 'browser-probe.mjs'), JSON.stringify({ url, pngPath: join(dir, 'shot.png') })], { windowsHide: true })
    let stdout = ''
    let stderr = ''
    proc.stdout.on('data', d => { stdout += d })
    proc.stderr.on('data', d => { stderr += d })
    const timer = setTimeout(() => reject(new Error(`browser-probe 超时: ${stderr}`)), 120 * 1000)
    proc.on('close', () => {
      clearTimeout(timer)
      const line = stdout.trim().split('\n').at(-1) ?? ''
      try {
        resolve(JSON.parse(line))
      } catch (error) {
        reject(new Error(`browser-probe stdout 非纯 JSON: ${JSON.stringify(stdout.slice(0, 300))} stderr=${JSON.stringify(stderr.slice(0, 200))}`))
      }
    })
  })
}

test('browser-probe_默认工作台文案_ok', { ...browserSkip }, async t => {
  const server = await startFixtureServer(t)
  t.after(() => server.close())
  const result = await runBrowserProbe(t, `http://127.0.0.1:${server.address().port}/`)
  assert.equal(result.ok, true)
  assert.equal(result.hasWorkspace, true)
  assert.equal(result.hasFailBanner, false)
})

test('browser-probe_横幅在场_ok取反', { ...browserSkip }, async t => {
  const server = await startFixtureServer(t)
  t.after(() => server.close())
  const result = await runBrowserProbe(t, `http://127.0.0.1:${server.address().port}/?variant=fail-banner`)
  assert.equal(result.hasFailBanner, true)
  assert.equal(result.ok, false, '横幅串漂移(M5)时此处先红:检测死则 ok 翻真')
})

test('browser-probe_空白页_ok取反', { ...browserSkip }, async t => {
  const server = await startFixtureServer(t)
  t.after(() => server.close())
  const result = await runBrowserProbe(t, `http://127.0.0.1:${server.address().port}/?variant=blank`)
  assert.equal(result.hasWorkspace, false)
  assert.equal(result.ok, false, '文案恒真变异(M4)时此处先红:白屏则 ok 翻真')
})

test('judgeProbeText_与常量同源_非浏览器冒烟', t => {
  // 无浏览器环境的秒级自检:判定本体与常量单点同源,串改坏时 compat-judges 常量测试先红
  assert.equal(typeof judgeProbeText('工作区'), 'boolean')
})
