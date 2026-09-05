// 重启等待拍决策行为测试:client.js 的 restartTick LOGIC 段提取工厂化后覆盖全场景。
// 核心回归:宿主重启确认(pid 变化 / 失联恢复)后页面服务未就绪(SPA fallback 未注册,
// `/` 返回裸 404)时必须等待重探,不得立即整页刷新。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const PKG_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const CLIENT_SOURCE = readFileSync(join(PKG_ROOT, 'src', 'client.js'), 'utf8')

// 提取 LOGIC-BEGIN <name> ... LOGIC-END <name> 函数体并工厂化,deps 为其自由变量
function extractLogic(name, deps = {}) {
  const pattern = new RegExp('// LOGIC-BEGIN ' + name + '\\n([\\s\\S]*?)\\n\\s*// LOGIC-END ' + name)
  const match = CLIENT_SOURCE.match(pattern)
  assert.ok(match, 'client.js 缺少 LOGIC 段: ' + name)
  const keys = Object.keys(deps)
  return new Function(...keys, 'return (' + match[1].trim() + ')')(...keys.map((key) => deps[key]))
}

const clientShouldReload = extractLogic('shouldReloadAfterRestart')
const clientPageReady = extractLogic('pageReady')
const clientRestartTick = extractLogic('restartTick', {
  shouldReloadAfterRestart: clientShouldReload,
  pageReady: clientPageReady,
})

const ALIVE_MS = 10 * 1000

const statusOk = (pid) => () => Promise.resolve({ pid })
const statusFail = () => () => Promise.reject(new Error('connection refused'))
const pageHtmlOk = () => Promise.resolve(new Response('<html></html>', { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } }))
const pageMiss = () => Promise.resolve(new Response('', { status: 404 }))
const pageUnauthorized = () => Promise.resolve(new Response('', { status: 401 }))
const pageNoType = () => Promise.resolve(new Response('<html></html>', { status: 200 }))
const pageNetFail = () => Promise.reject(new Error('connection refused'))

function tick({ now = 0, deadlineAt = ALIVE_MS, lost = false, pidBefore = 7, status, page }) {
  return clientRestartTick({
    now,
    deadlineAt,
    lost,
    pidBefore,
    statusFetch: status,
    pageFetch: page,
  })
}

test('restartTick: 等待中 pid 未变,宿主未重启,继续等待', async () => {
  // Given 未失联且 pid 基线 7;When status 成功返回 pid 7;Then wait 且 lost 保持 false
  const result = await tick({ status: statusOk(7), page: pageHtmlOk })
  assert.deepEqual(result, { action: 'wait', lost: false })
})

test('restartTick: status 拉取失败记为失联并等待', async () => {
  // Given 等待中;When status 请求连接失败;Then wait 且 lost 置 true
  const result = await tick({ status: statusFail(), page: pageHtmlOk })
  assert.deepEqual(result, { action: 'wait', lost: true })
})

test('restartTick: 宿主已重启但页面 404,等待页面就绪', async () => {
  // Given pid 基线 7;When status 返回 pid 8(已重启)而主文档 404(fallback 未注册);Then wait,不得整页刷新
  const result = await tick({ status: statusOk(8), page: pageMiss })
  assert.deepEqual(result, { action: 'wait', lost: false })
})

test('restartTick: 宿主已重启且页面就绪,整页刷新', async () => {
  // Given pid 基线 7;When status 返回 pid 8 且主文档 200 text/html;Then reload
  const result = await tick({ status: statusOk(8), page: pageHtmlOk })
  assert.deepEqual(result, { action: 'reload', lost: false })
})

test('restartTick: 失联后恢复且页面就绪,整页刷新', async () => {
  // Given 曾失联;When status 恢复 200 且主文档 200;Then reload
  const result = await tick({ lost: true, pidBefore: 7, status: statusOk(7), page: pageHtmlOk })
  assert.deepEqual(result, { action: 'reload', lost: true })
})

test('restartTick: 失联恢复但页面未就绪,保持失联标记继续等待', async () => {
  // Given 曾失联;When status 恢复但主文档 404;Then wait 且 lost 保持 true
  const result = await tick({ lost: true, pidBefore: 7, status: statusOk(7), page: pageMiss })
  assert.deepEqual(result, { action: 'wait', lost: true })
})

test('restartTick: 超时拍直接转人工收尾,不再探测', async () => {
  // Given now 已到 deadline;When 拍触发;Then timeout
  const result = await tick({ now: ALIVE_MS, deadlineAt: ALIVE_MS, status: statusOk(8), page: pageHtmlOk })
  assert.deepEqual(result, { action: 'timeout', lost: false })
})

test('restartTick: 页面探测网络失败按未就绪处理', async () => {
  // Given 宿主已重启;When 主文档 fetch 连接失败;Then wait
  const result = await tick({ status: statusOk(8), page: pageNetFail })
  assert.deepEqual(result, { action: 'wait', lost: false })
})

test('restartTick: 页面 200 但缺失 content-type 按未就绪处理', async () => {
  // Given 宿主已重启;When 主文档 200 无 content-type;Then wait
  const result = await tick({ status: statusOk(8), page: pageNoType })
  assert.deepEqual(result, { action: 'wait', lost: false })
})

test('restartTick: 页面 401 按未就绪处理', async () => {
  // Given 宿主已重启;When 主文档 401(索引鉴权拒绝);Then wait
  const result = await tick({ status: statusOk(8), page: pageUnauthorized })
  assert.deepEqual(result, { action: 'wait', lost: false })
})

test('restartTick: status 响应缺 pid 时不判定重启', async () => {
  // Given pid 基线 7;When status 响应无 pid 字段;Then wait 且 lost 保持 false
  const result = await tick({ status: () => Promise.resolve({}), page: pageHtmlOk })
  assert.deepEqual(result, { action: 'wait', lost: false })
})

test('restartTick: 无重启证据时不发起页面探测', async () => {
  // Given pid 基线为空且未失联(无宿主重启证据);When status 成功;Then wait 且页面探测未被调用
  let pageCalls = 0
  const result = await tick({
    pidBefore: null,
    status: statusOk(7),
    page: () => { pageCalls += 1; return pageHtmlOk() },
  })
  assert.deepEqual(result, { action: 'wait', lost: false })
  assert.equal(pageCalls, 0)
})

test('restartTick: 页面 204 无正文按未就绪处理', async () => {
  // Given 宿主已重启;When 主文档 204(ok 为真但无 content-type 无正文);Then wait
  const result = await tick({ status: statusOk(8), page: () => Promise.resolve(new Response(null, { status: 204 })) })
  assert.deepEqual(result, { action: 'wait', lost: false })
})

test('restartTick: content-type 大写仍按就绪处理', async () => {
  // Given 宿主已重启;When 主文档 200 且 content-type 为大写 TEXT/HTML;Then reload
  const result = await tick({
    status: statusOk(8),
    page: () => Promise.resolve(new Response('<html></html>', { status: 200, headers: { 'content-type': 'TEXT/HTML; charset=utf-8' } })),
  })
  assert.deepEqual(result, { action: 'reload', lost: false })
})
