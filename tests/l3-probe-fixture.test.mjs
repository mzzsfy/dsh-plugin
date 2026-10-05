import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { dismissOnboardingEval, verifyTypedEval, newSessionEval, ONBOARDING_CLEARED_VALUES } from '../scripts/compat/probe-evals.mjs'

/**
 * l3-probe fixture 页自测(探针的探针):用本地静态 fixture 页(无宿主,秒级)
 * 执行 run.mjs 同款探针谓词,锁三件事——
 *   1. FIND-020-1 防线:弹窗在场发话被吞时,verify 必须暴露 composer 空
 *   2. new-session 谓词必须真点「新建会话」按钮(诱饵首按钮零点击)
 *   3. 文案/结构漂移产生可区分的 infra 哨兵(later-not-found 等),不混入产品判定
 * 浏览器不可用环境(CI 未装 playwright chromium)整文件显式跳过,理由登记。
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
const browserSkip = { skip: browserReady ? false : '浏览器不可用(未安装 playwright chromium),fixture 自测跳过' }

function startFixtureServer(t) {
  const html = readFileSync(fixturePath, 'utf8')
  const server = createServer((req, res) => {
    // 非 / 路径 404:http 步状态门槛测试需要真实的非 2xx 响应面(query 剥离,变体 URL 不受影响)
    const pathOnly = new URL(req.url, 'http://localhost').pathname
    if (pathOnly !== '/') {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
      res.end('not found')
      return
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end(html)
  })
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)))
}

function runProbe(t, url, steps, { allowStepFailure = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'l3-fixture-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const payloadPath = join(dir, 'payload.json')
  writeFileSync(payloadPath, JSON.stringify({ url, out: join(dir, 'result.json'), steps }))
  // 必须异步 spawn:spawnSync 会阻塞本进程事件循环,同进程内的 fixture 服务器
  // 将无法响应 chromium 的请求(45s goto 超时,2026-10-02 实测)
  return new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, [join(repo, 'scripts', 'compat', 'l3-probe.mjs'), `@${payloadPath}`], { windowsHide: true })
    let stdout = ''
    let stderr = ''
    proc.stdout.on('data', d => { stdout += d })
    proc.stderr.on('data', d => { stderr += d })
    const timer = setTimeout(() => reject(new Error(`l3-probe 超时: ${stderr}`)), 120 * 1000)
    proc.on('close', code => {
      clearTimeout(timer)
      // allowStepFailure:红-by-design 场景(状态门槛负例)步骤红即退出码 1,结果仍需可读
      if (code !== 0 && !allowStepFailure) return reject(new Error(`l3-probe 退出码 ${code}: ${stderr}`))
      let parsed
      try {
        parsed = JSON.parse(stdout)
      } catch (error) {
        throw new Error(`l3-probe stdout 非纯 JSON(${error.message}): stdout=${JSON.stringify(stdout.slice(0, 400))} stderr=${JSON.stringify(stderr.slice(0, 200))}`)
      }
      const results = Array.isArray(parsed) ? parsed : parsed.results
      const valueOf = (name) => results.find(r => r.name === name)
      resolve({ results, valueOf })
    })
  })
}

test('fixture_可dismiss弹窗_全链真按钮命中且诱饵零点击', { ...browserSkip }, async t => {
  const server = await startFixtureServer(t)
  t.after(() => server.close())
  const url = `http://127.0.0.1:${server.address().port}/`
  const { results, valueOf } = await runProbe(t, url, [
    { name: 'dismiss', eval: dismissOnboardingEval },
    { name: 'wait-dialog-gone', wait: 200 },
    { name: 'type-message', type: { selector: '[contenteditable="true"]', text: '回复:ok' } },
    { name: 'verify-typed', eval: verifyTypedEval },
    { name: 'new-session', eval: newSessionEval },
    { name: 'fixture-state', eval: 'JSON.stringify(window.__fixture)' },
  ])
  assert.equal(valueOf('baseline-render').ok, true)
  for (const r of results) assert.equal(r.ok, true, `步骤失败: ${r.name} ${r.error ?? ''}`)
  assert.equal(valueOf('dismiss').value, 'dismissed')
  assert.equal(JSON.parse(valueOf('verify-typed').value).composerText, '回复:ok')
  assert.equal(valueOf('new-session').value, 'clicked')
  const state = JSON.parse(valueOf('fixture-state').value)
  assert.deepEqual(state, { decoyClicks: 0, sessionClicks: 1 }, 'new-session 必须命中真按钮,诱饵首按钮不得被点')
})

test('fixture_aria命中路径_按钮须带aria-label且与文本命中同钮', { ...browserSkip }, async t => {
  // probe-evals 缺口①(轮 3 收敛):newSessionEval 的命中式 = aria-label + textContent,
  // 无 aria 按钮只走文本半区——fixture 按钮必须带 aria-label 使半区覆盖可断言;
  // 诱饵按钮不得带同名 aria(否则 aria 命中先于文本命中打错对象)
  const server = await startFixtureServer(t)
  t.after(() => server.close())
  const url = `http://127.0.0.1:${server.address().port}/`
  const { valueOf } = await runProbe(t, url, [
    { name: 'aria-state', eval: `JSON.stringify({
      ariaHit: !!document.querySelector('[aria-label="新建会话"]'),
      ariaText: document.querySelector('[aria-label="新建会话"]')?.textContent.trim(),
      decoyAria: document.querySelector('#decoy')?.getAttribute('aria-label') ?? null
    })` },
  ])
  const state = JSON.parse(valueOf('aria-state').value)
  assert.equal(state.ariaHit, true, '新建会话按钮必须带 aria-label(命中式 aria 半区依赖)')
  assert.equal(state.ariaText, '新建会话')
  assert.equal(state.decoyAria, null, '诱饵按钮不得携带同名 aria-label')
})

test('fixture_http步骤_状态门槛_缺省2xx与显式期望', { ...browserSkip }, async t => {
  // probe-evals 缺口②(轮 3 收敛):http 步不设状态门槛时 404/500 也记 ok——
  // expectedStatus 显式声明后偏离即红,缺省 2xx 即 ok
  const server = await startFixtureServer(t)
  t.after(() => server.close())
  const url = `http://127.0.0.1:${server.address().port}/`
  const { results, valueOf } = await runProbe(t, url, [
    { name: 'implicit-2xx-ok', http: { path: '/' } },
    { name: 'explicit-404-red', http: { path: '/', expectedStatus: 404 } },
    { name: 'missing-path-red', http: { path: '/definitely-missing' } },
    { name: 'missing-path-expected', http: { path: '/definitely-missing', expectedStatus: 404 } },
  ], { allowStepFailure: true })
  assert.equal(valueOf('implicit-2xx-ok').ok, true)
  const red404 = results.find(r => r.name === 'explicit-404-red')
  assert.equal(red404.ok, false, '显式期望 404 实得 200 必须红')
  assert.match(red404.error, /200 不满足门槛 404/)
  assert.equal(results.find(r => r.name === 'missing-path-red').ok, false, '缺省门槛下 404 必须红')
  assert.equal(valueOf('missing-path-expected').ok, true, '显式期望 404 实得 404 绿')
})

test('fixture_弹窗在场发话被吞_verify必须暴露composer空', { ...browserSkip }, async t => {
  const server = await startFixtureServer(t)
  t.after(() => server.close())
  const url = `http://127.0.0.1:${server.address().port}/`
  const { valueOf } = await runProbe(t, url, [
    { name: 'type-into-trap', type: { selector: '[contenteditable="true"]', text: '回复:ok' } },
    { name: 'verify-typed', eval: verifyTypedEval },
  ])
  // FIND-020-1:弹窗输入框 autoFocus 抢焦点,type 不抛错但文本整段落入弹窗——
  // 判定必须依赖 verify 的 composer 实际文本,此处 composer 必须为空
  assert.equal(JSON.parse(valueOf('verify-typed').value).composerText, '')
})

test('fixture_不可dismiss变体_infra哨兵可区分且判定为假', { ...browserSkip }, async t => {
  const server = await startFixtureServer(t)
  t.after(() => server.close())
  const url = `http://127.0.0.1:${server.address().port}/?variant=non-dismissible`
  const { valueOf } = await runProbe(t, url, [
    { name: 'dismiss', eval: dismissOnboardingEval },
  ])
  // 文案漂移(「稍后配置」被改)→ infra 哨兵 later-not-found,与产品失败可区分
  assert.equal(valueOf('dismiss').value, 'later-not-found')
  assert.equal(ONBOARDING_CLEARED_VALUES.includes(valueOf('dismiss').value), false, 'later-not-found 不得通过发话判定')
})

test('fixture_无弹窗_noDialog哨兵且判定为真', { ...browserSkip }, async t => {
  const server = await startFixtureServer(t)
  t.after(() => server.close())
  const url = `http://127.0.0.1:${server.address().port}/?variant=no-dialog`
  const { valueOf } = await runProbe(t, url, [
    { name: 'dismiss', eval: dismissOnboardingEval },
  ])
  assert.equal(valueOf('dismiss').value, 'dialog-absent')
  assert.equal(ONBOARDING_CLEARED_VALUES.includes(valueOf('dismiss').value), true)
})

test('fixture_无弹窗无composer_双缺拆义为scan-inconclusive不进清空值表', { ...browserSkip }, async t => {
  // probe-evals 缺口③(轮 3 收敛):'no-dialog' 旧哨兵混义(合法无弹窗 vs 扫描异常);
  // 双缺(无弹窗且 composer 不在场)必须落在 scan-inconclusive,判定端红
  const server = await startFixtureServer(t)
  t.after(() => server.close())
  const url = `http://127.0.0.1:${server.address().port}/?variant=inert`
  const { valueOf } = await runProbe(t, url, [{ name: 'dismiss', eval: dismissOnboardingEval }])
  assert.equal(valueOf('dismiss').value, 'scan-inconclusive')
  assert.equal(ONBOARDING_CLEARED_VALUES.includes(valueOf('dismiss').value), false, '双缺不得混入合法清空值')
})
