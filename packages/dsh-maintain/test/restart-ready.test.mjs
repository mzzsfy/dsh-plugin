// 重启等待拍决策行为测试:client.js 的 restartTick / restartPostLost / apiError LOGIC 段
// 经共享提取器(test/logic-extract.mjs)工厂化后覆盖全场景。
// 核心回归:宿主重启确认(pid / bootAt 变化 / 失联恢复)后页面服务未就绪(SPA fallback
// 未注册,`/` 返回裸 404)时必须等待重探,不得立即整页刷新;
// 主文档须连续就绪达到门槛才放行刷新(reload action),单次就绪只累积计数;
// 重启 POST 收到明确 HTTP 回绝(409/500)时不得进入等待轮询凭活宿主误判已重启。

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { extractLogic, clientSource } from './logic-extract.mjs'

// 就绪门槛常量直接取自 client 源:注入值与实现同源,client 调整门槛时用例自动跟随
const REQUIRED_MATCH = clientSource().match(/^const RESTART_READY_REQUIRED = ([0-9 *]+)$/m)
assert.ok(REQUIRED_MATCH, 'client.js 缺少常量 RESTART_READY_REQUIRED')
const RESTART_READY_REQUIRED = new Function('return (' + REQUIRED_MATCH[1] + ')')()

const clientShouldReload = extractLogic('shouldReloadAfterRestart')
const clientPageReady = extractLogic('pageReady')
const clientRestartTick = extractLogic('restartTick', {
  shouldReloadAfterRestart: clientShouldReload,
  pageReady: clientPageReady,
  RESTART_READY_REQUIRED,
})
const clientRestartPostLost = extractLogic('restartPostLost')
const clientApiError = extractLogic('apiError')

const ALIVE_MS = 10 * 1000

const statusOk = (snapshot) => () => Promise.resolve(snapshot)
const statusFail = () => () => Promise.reject(new Error('connection refused'))
const pageHtmlOk = () => Promise.resolve(new Response('<html></html>', { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } }))
const pageMiss = () => Promise.resolve(new Response('', { status: 404 }))
const pageUnauthorized = () => Promise.resolve(new Response('', { status: 401 }))
const pageNoType = () => Promise.resolve(new Response('<html></html>', { status: 200 }))
const pageNetFail = () => Promise.reject(new Error('connection refused'))

// prev 快照构造:{lost,pid,bootAt} 宿主侧 + readyStreak 客户侧连续就绪计数,默认与 pid 7 / bootAt 100 / 计数 0 对齐
function tick({ now = 0, deadlineAt = ALIVE_MS, lost = false, pid = 7, bootAt = 100, readyStreak = 0, status, page }) {
  return clientRestartTick({
    now,
    deadlineAt,
    prev: { lost, pid, bootAt },
    readyStreak,
    statusFetch: status,
    pageFetch: page,
  })
}

test('restartTick: 等待中 pid 与 bootAt 均未变,宿主未重启,继续等待', async () => {
  // Given 未失联基线(pid 7/bootAt 100);When status 成功返回同值;Then wait 且 lost 保持 false
  const result = await tick({ status: statusOk({ pid: 7, bootAt: 100 }), page: pageHtmlOk })
  assert.deepEqual(result, { action: 'wait', lost: false, readyStreak: 0 })
})

test('restartTick: status 拉取失败记为失联并等待,就绪计数归零', async () => {
  // Given 已连续就绪一次;When status 请求连接失败;Then wait 且 lost 置 true 计数清零
  const result = await tick({ readyStreak: 1, status: statusFail(), page: pageHtmlOk })
  assert.deepEqual(result, { action: 'wait', lost: true, readyStreak: 0 })
})

test('restartTick: bootAt 变化即判定重启(容器 pid 恒 1 场景)', async () => {
  // Given pid 基线 1/bootAt 100 且已就绪一次;When status 返回 pid 1(复用)而 bootAt 200 且页面就绪;Then reload
  const result = await tick({ pid: 1, bootAt: 100, readyStreak: 1, status: statusOk({ pid: 1, bootAt: 200 }), page: pageHtmlOk })
  assert.deepEqual(result, { action: 'reload', lost: false, readyStreak: 2 })
})

test('restartTick: 宿主已重启但页面 404,等待页面就绪且计数归零', async () => {
  // Given 已就绪一次;When status 返回新 bootAt(已重启)而主文档 404(fallback 未注册);Then wait,不得整页刷新
  const result = await tick({ readyStreak: 1, status: statusOk({ pid: 8, bootAt: 200 }), page: pageMiss })
  assert.deepEqual(result, { action: 'wait', lost: false, readyStreak: 0 })
})

test('restartTick: 首次就绪只累积计数,不刷新', async () => {
  // Given 宿主已重启且计数为零;When 主文档就绪;Then wait 且计数为一(连续两次才放行)
  const result = await tick({ status: statusOk({ pid: 8, bootAt: 200 }), page: pageHtmlOk })
  assert.deepEqual(result, { action: 'wait', lost: false, readyStreak: 1 })
})

test('restartTick: 连续第二次就绪达到门槛,放行刷新', async () => {
  const result = await tick({ readyStreak: 1, status: statusOk({ pid: 8, bootAt: 200 }), page: pageHtmlOk })
  assert.deepEqual(result, { action: 'reload', lost: false, readyStreak: 2 })
})

test('restartTick: 失联后恢复且页面就绪(已就绪一次),放行刷新', async () => {
  // Given 曾失联且已就绪一次;When status 恢复 200 且主文档 200;Then reload
  const result = await tick({ lost: true, readyStreak: 1, status: statusOk({ pid: 7, bootAt: 100 }), page: pageHtmlOk })
  assert.deepEqual(result, { action: 'reload', lost: true, readyStreak: 2 })
})

test('restartTick: 失联恢复但页面未就绪,保持失联标记且计数归零', async () => {
  const result = await tick({ lost: true, readyStreak: 1, status: statusOk({ pid: 7, bootAt: 100 }), page: pageMiss })
  assert.deepEqual(result, { action: 'wait', lost: true, readyStreak: 0 })
})

test('restartTick: 超时拍直接转人工收尾,不再探测', async () => {
  // Given now 已到 deadline;When 拍触发;Then timeout
  const result = await tick({ now: ALIVE_MS, deadlineAt: ALIVE_MS, readyStreak: 3, status: statusOk({ pid: 8, bootAt: 200 }), page: pageHtmlOk })
  assert.deepEqual(result, { action: 'timeout', lost: false, readyStreak: 3 })
})

test('restartTick: 页面探测网络失败按未就绪处理且计数归零', async () => {
  const result = await tick({ readyStreak: 1, status: statusOk({ pid: 8, bootAt: 200 }), page: pageNetFail })
  assert.deepEqual(result, { action: 'wait', lost: false, readyStreak: 0 })
})

test('restartTick: 页面 200 但缺失 content-type 按未就绪处理', async () => {
  const result = await tick({ readyStreak: 1, status: statusOk({ pid: 8, bootAt: 200 }), page: pageNoType })
  assert.deepEqual(result, { action: 'wait', lost: false, readyStreak: 0 })
})

test('restartTick: 页面 401 按未就绪处理', async () => {
  const result = await tick({ readyStreak: 1, status: statusOk({ pid: 8, bootAt: 200 }), page: pageUnauthorized })
  assert.deepEqual(result, { action: 'wait', lost: false, readyStreak: 0 })
})

test('restartTick: status 响应缺 pid 与 bootAt 时不判定重启', async () => {
  // Given pid/bootAt 基线 7/100;When status 响应无任一实例标识;Then wait 且 lost 保持 false
  const result = await tick({ readyStreak: 1, status: statusOk({}), page: pageHtmlOk })
  assert.deepEqual(result, { action: 'wait', lost: false, readyStreak: 0 })
})

test('restartTick: 旧宿主缺 bootAt 时退化 pid 比对,不误判', async () => {
  // Given prev 无 bootAt(旧宿主快照);When next bootAt 出现但 pid 相同;Then wait(bootAt 缺失单侧不构成证据)
  const result = await clientRestartTick({
    now: 0,
    deadlineAt: ALIVE_MS,
    prev: { lost: false, pid: 7, bootAt: null },
    readyStreak: 1,
    statusFetch: statusOk({ pid: 7, bootAt: 200 }),
    pageFetch: pageHtmlOk,
  })
  assert.deepEqual(result, { action: 'wait', lost: false, readyStreak: 0 })
})

test('restartTick: 无重启证据时不发起页面探测', async () => {
  // Given 基线为空且未失联;When status 成功;Then wait 且页面探测未被调用
  let pageCalls = 0
  const result = await clientRestartTick({
    now: 0,
    deadlineAt: ALIVE_MS,
    prev: { lost: false, pid: null, bootAt: null },
    readyStreak: 0,
    statusFetch: statusOk({ pid: 7, bootAt: 100 }),
    pageFetch: () => { pageCalls += 1; return pageHtmlOk() },
  })
  assert.deepEqual(result, { action: 'wait', lost: false, readyStreak: 0 })
  assert.equal(pageCalls, 0)
})

test('restartTick: 页面 204 无正文按未就绪处理', async () => {
  const result = await tick({ readyStreak: 1, status: statusOk({ pid: 8, bootAt: 200 }), page: () => Promise.resolve(new Response(null, { status: 204 })) })
  assert.deepEqual(result, { action: 'wait', lost: false, readyStreak: 0 })
})

test('restartTick: content-type 大写仍按就绪处理', async () => {
  const result = await tick({
    readyStreak: 1,
    status: statusOk({ pid: 8, bootAt: 200 }),
    page: () => Promise.resolve(new Response('<html></html>', { status: 200, headers: { 'content-type': 'TEXT/HTML; charset=utf-8' } })),
  })
  assert.deepEqual(result, { action: 'reload', lost: false, readyStreak: 2 })
})

test('restartPostLost: 网关 5xx(宿主退出窗口)视为失联,宿主应答回绝不算', () => {
  // 502/503/504 出现在宿主退出窗口:网关可达而宿主不在,必须继续等待
  for (const status of [502, 503, 504]) {
    const gatewayError = new Error('HTTP ' + status)
    gatewayError.status = status
    assert.equal(clientRestartPostLost(gatewayError), true, 'status=' + status)
  }
  // 409 升级互斥/500 appExit 缺失为宿主自身应答:活宿主明确回绝,不得等待
  const conflictError = new Error('升级进行中,禁止重启;等待升级完成后重试')
  conflictError.status = 409
  assert.equal(clientRestartPostLost(conflictError), false)
  const capabilityError = new Error('启动器未提供 appExit,无法重启')
  capabilityError.status = 500
  assert.equal(clientRestartPostLost(capabilityError), false)
  const okLikeError = new Error('HTTP 400')
  okLikeError.status = 400
  assert.equal(clientRestartPostLost(okLikeError), false)
})

test('restartPostLost: 无应答失败(网络/中止)属于失联', () => {
  assert.equal(clientRestartPostLost(new TypeError('Failed to fetch')), true)
  assert.equal(clientRestartPostLost(new DOMException('The operation was aborted due to timeout', 'TimeoutError')), true)
  assert.equal(clientRestartPostLost(null), true)
  assert.equal(clientRestartPostLost('boom'), true)
})

test('apiError: 携带 status 与 payload.error,解析失败回退 HTTP 码', () => {
  const withBody = clientApiError({ status: 409 }, { error: '升级进行中,禁止重启;等待升级完成后重试' })
  assert.equal(withBody.status, 409)
  assert.equal(withBody.message, '升级进行中,禁止重启;等待升级完成后重试')
  const withoutBody = clientApiError({ status: 500 }, {})
  assert.equal(withoutBody.status, 500)
  assert.equal(withoutBody.message, 'HTTP 500')
})
