// 宿主桌面通知 BDD:core 纯函数(回环判定 / 派发决策 / 平台命令 / spawn 执行 / 配置键)
// 与 host 接线集成(stub ctx 装载真实 src/index.js,stub spawn 观测派发)。
import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'

import { apply, __hostSpawn, CLIENT_PRESENCE_WINDOW_MS } from '../src/index.js'
import {
  CHANNELS,
  HOST_NOTIFY_TIMEOUT_MS,
  hostNotifyCommand,
  hostNotifyWanted,
  isLocalBrowserPoll,
  isLocalBrowserPresent,
  isLoopbackAddress,
  publicConfig,
  resolvedConfig,
  sendHostNotify,
  validateConfigPatch,
} from '../src/core.mjs'

// ---- isLoopbackAddress:同机判定,回环地址即本机浏览器 ----

test('Given 回环形态地址 When 判定 Then 为真', () => {
  assert.equal(isLoopbackAddress('::1'), true)
  assert.equal(isLoopbackAddress('127.0.0.1'), true)
  assert.equal(isLoopbackAddress('127.8.8.8'), true)
  assert.equal(isLoopbackAddress('::ffff:127.0.0.1'), true)
})

test('Given 非回环或非法地址 When 判定 Then 为假', () => {
  assert.equal(isLoopbackAddress('192.168.1.5'), false)
  assert.equal(isLoopbackAddress('::ffff:192.168.1.5'), false)
  assert.equal(isLoopbackAddress('::2'), false)
  assert.equal(isLoopbackAddress(''), false)
  assert.equal(isLoopbackAddress(undefined), false)
  assert.equal(isLoopbackAddress(null), false)
})

// ---- isLocalBrowserPoll:在场记账形态收紧,防伪造在场压制宿主通知 ----

test('Given 回环加 cursor 加 fetch 形态或无 Sec-Fetch 头 When 判定 Then 为真', () => {
  assert.equal(isLocalBrowserPoll({ remoteAddress: '127.0.0.1', hasCursor: true, secFetchMode: 'cors' }), true)
  assert.equal(isLocalBrowserPoll({ remoteAddress: '::1', hasCursor: true, secFetchMode: undefined }), true)
})

test('Given 非回环或无 cursor 或 no-cors 形态 When 判定 Then 为假', () => {
  assert.equal(isLocalBrowserPoll({ remoteAddress: '192.168.1.5', hasCursor: true, secFetchMode: 'cors' }), false)
  assert.equal(isLocalBrowserPoll({ remoteAddress: '127.0.0.1', hasCursor: false, secFetchMode: 'cors' }), false)
  assert.equal(isLocalBrowserPoll({ remoteAddress: '127.0.0.1', hasCursor: true, secFetchMode: 'no-cors' }), false)
  assert.equal(isLocalBrowserPoll({ remoteAddress: undefined, hasCursor: true, secFetchMode: 'cors' }), false)
})

test('Given Origin 缺席或与 Host 一致 When 判定 Then 为真;跨源或畸形 Origin Then 为假', () => {
  const base = { remoteAddress: '127.0.0.1', hasCursor: true, secFetchMode: 'cors' }
  assert.equal(isLocalBrowserPoll({ ...base, origin: undefined, host: '127.0.0.1:3080' }), true, '同源 GET fetch 不带 Origin')
  assert.equal(isLocalBrowserPoll({ ...base, origin: 'http://127.0.0.1:3080', host: '127.0.0.1:3080' }), true)
  assert.equal(isLocalBrowserPoll({ ...base, origin: 'https://evil.example', host: '127.0.0.1:3080' }), false, '跨源 fetch 必带且与 Host 不符')
  assert.equal(isLocalBrowserPoll({ ...base, origin: 'not a url', host: '127.0.0.1:3080' }), false, '畸形 Origin 不放行')
})

// ---- hostNotifyWanted:浏览器优先,在场让位、离场补位;重复只发生在边界情况 ----

const NOW = 1000 * 1000
const WINDOW_MS = 2 * 1000

test('Given 任一开关开且本机浏览器不在场 When 决策 Then 弹', () => {
  assert.equal(hostNotifyWanted({ hostNotify: true, localBrowserPresent: false }), true)
  assert.equal(hostNotifyWanted({ hostNotifyFallback: true, localBrowserPresent: false }), true)
  assert.equal(hostNotifyWanted({ hostNotify: true, hostNotifyFallback: true, localBrowserPresent: false }), true)
})

test('Given 任一开关开且本机浏览器在场 When 决策 Then 让位不弹(浏览器优先,正常路径零重复)', () => {
  assert.equal(hostNotifyWanted({ hostNotify: true, localBrowserPresent: true }), false)
  assert.equal(hostNotifyWanted({ hostNotifyFallback: true, localBrowserPresent: true }), false)
  assert.equal(hostNotifyWanted({ hostNotify: true, hostNotifyFallback: true, localBrowserPresent: true }), false)
})

test('Given 两开关均关 When 决策 Then 恒不弹', () => {
  assert.equal(hostNotifyWanted({ localBrowserPresent: false }), false)
  assert.equal(hostNotifyWanted({ hostNotify: false, hostNotifyFallback: false, localBrowserPresent: false }), false)
})

// ---- isLocalBrowserPresent:在场 = 有在途长轮询,或宽限窗口内有活动 ----

test('Given 在途长轮询存在 When 判定在场 Then 为真(时间戳过期不影响)', () => {
  assert.equal(isLocalBrowserPresent({ inFlightPolls: 1, lastSeenAt: NOW - WINDOW_MS - 1, now: NOW, windowMs: WINDOW_MS }), true)
  assert.equal(isLocalBrowserPresent({ inFlightPolls: 3, lastSeenAt: 0, now: NOW, windowMs: WINDOW_MS }), true)
})

test('Given 无在途 When 判定在场 Then 最近活动在窗口内为真,超窗或从未为假', () => {
  assert.equal(isLocalBrowserPresent({ inFlightPolls: 0, lastSeenAt: NOW - 1, now: NOW, windowMs: WINDOW_MS }), true)
  assert.equal(isLocalBrowserPresent({ inFlightPolls: 0, lastSeenAt: NOW - WINDOW_MS, now: NOW, windowMs: WINDOW_MS }), true)
  assert.equal(isLocalBrowserPresent({ inFlightPolls: 0, lastSeenAt: NOW - WINDOW_MS - 1, now: NOW, windowMs: WINDOW_MS }), false)
  assert.equal(isLocalBrowserPresent({ inFlightPolls: 0, lastSeenAt: 0, now: NOW, windowMs: WINDOW_MS }), false)
  assert.equal(isLocalBrowserPresent({ inFlightPolls: 0, lastSeenAt: undefined, now: NOW, windowMs: WINDOW_MS }), false)
})

// ---- hostNotifyCommand:平台命令构造与文本转义 ----

test('Given darwin When 构造 Then osascript 单命令携带转义后的标题与正文', () => {
  const command = hostNotifyCommand('darwin', '标题', '正文')
  assert.equal(command.file, 'osascript')
  assert.deepEqual(command.args.slice(0, 1), ['-e'])
  const script = command.args[1]
  assert.ok(script.includes('display notification'), '应含 display notification')
  assert.ok(script.includes('with title'), '应含 with title')
  assert.ok(script.includes('标题'), '应含标题')
  assert.ok(script.includes('正文'), '应含正文')
})

test('Given darwin 且文本含双引号反斜杠换行 When 构造 Then 转义并压平', () => {
  const script = hostNotifyCommand('darwin', 'a"b\\c\nd', 'x').args[1]
  assert.ok(script.includes('a\\"b\\\\c d'), '双引号反斜杠须转义且换行压平: ' + script)
  assert.ok(!script.includes('\n'), '不得残留换行')
})

test('Given linux When 构造 Then notify-send 选项终结符后标题正文直传', () => {
  const command = hostNotifyCommand('linux', 'T', 'B')
  assert.equal(command.file, 'notify-send')
  assert.deepEqual(command.args, ['--', 'T', 'B'])
})

test('Given linux 且正文以减号开头 When 构造 Then 经选项终结符原样直传', () => {
  const command = hostNotifyCommand('linux', 'T', '- 修改了配置')
  assert.deepEqual(command.args, ['--', 'T', '- 修改了配置'])
})

test('Given linux 且文本含换行 When 构造 Then 换行压平为空格', () => {
  const command = hostNotifyCommand('linux', 'a\nb', 'c\nd')
  assert.deepEqual(command.args, ['--', 'a b', 'c d'])
})

test('Given win32 When 构造 Then powershell 无配置非交互单命令脚本', () => {
  const command = hostNotifyCommand('win32', 'T', 'B')
  assert.equal(command.file, 'powershell.exe')
  assert.deepEqual(command.args.slice(0, 3), ['-NoProfile', '-NonInteractive', '-Command'])
  const script = command.args[3]
  assert.ok(script.includes('ToastNotificationManager'), '应使用 WinRT toast')
  assert.ok(script.includes('ToastText02'), '应使用双行模板')
  assert.ok(script.includes('CreateTextNode'), '文本应经 CreateTextNode 注入')
})

test('Given win32 且文本含单引号 When 构造 Then 单引号加倍且换行压平', () => {
  const script = hostNotifyCommand('win32', "it's\nok", 'B').args[3]
  assert.ok(script.includes("it''s ok"), '单引号须加倍且换行压平: ' + script)
  assert.ok(!script.includes('\n'), '不得残留换行')
})

test('Given 未知平台 When 构造 Then 返回 null', () => {
  assert.equal(hostNotifyCommand('freebsd', 'T', 'B'), null)
})

// ---- sendHostNotify:真实结果返回,依赖注入 ----

test('Given spawn 成功 When 发送 Then 返回 ok 且传参含超时与隐藏窗口', async () => {
  const calls = []
  const result = await sendHostNotify({
    title: 'T', body: 'B', platform: 'linux',
    execFileImpl: (file, args, options, callback) => {
      calls.push({ file, args, options })
      callback(null)
    },
  })
  assert.deepEqual(result, { ok: true, detail: '已触发宿主通知' })
  assert.equal(calls.length, 1)
  assert.equal(calls[0].file, 'notify-send')
  assert.equal(calls[0].options.timeout, HOST_NOTIFY_TIMEOUT_MS)
  assert.equal(calls[0].options.windowsHide, true)
})

test('Given spawn 失败 When 发送 Then 返回失败与原因', async () => {
  const result = await sendHostNotify({
    title: 'T', body: 'B', platform: 'linux',
    execFileImpl: (file, args, options, callback) => callback(new Error('boom')),
  })
  assert.equal(result.ok, false)
  assert.equal(result.detail, 'boom')
})

test('Given 不支持平台 When 发送 Then 不触碰 spawn 返回不支持', async () => {
  let touched = false
  const result = await sendHostNotify({
    title: 'T', body: 'B', platform: 'freebsd',
    execFileImpl: () => { touched = true },
  })
  assert.equal(touched, false)
  assert.equal(result.ok, false)
  assert.ok(result.detail.includes('freebsd'))
})

// ---- 配置键:校验与解析 ----

test('Given 补丁含两键布尔 When 校验 Then 通过并归一;非布尔 Then 拒绝', () => {
  const good = validateConfigPatch({ hostNotify: true, hostNotifyFallback: false })
  assert.equal(good.ok, true)
  assert.deepEqual(good.patch, { hostNotify: true, hostNotifyFallback: false })
  assert.equal(validateConfigPatch({ hostNotify: 'yes' }).ok, false)
  assert.equal(validateConfigPatch({ hostNotifyFallback: 1 }).ok, false)
})

test('Given 缺省配置 When 解析 Then 两键回 false;CHANNELS 含 host', () => {
  const resolved = resolvedConfig({})
  assert.equal(resolved.hostNotify, false)
  assert.equal(resolved.hostNotifyFallback, false)
  const config = publicConfig({ hostNotify: true })
  assert.equal(config.hostNotify, true)
  assert.equal(config.hostNotifyFallback, false)
  assert.ok(CHANNELS.indexOf('host') >= 0, 'host 应为可路由通道')
})

// ---- host 接线集成:stub spawn 观测派发,presence 经投影路由的来源地址注入 ----

// res 桩带事件能力:投影处理器挂 close 事件感知断连,桩须支持 once/emit;
// end 不自动触发 close,断连时机由测试显式 emit 模拟
function makeRes() {
  const res = new EventEmitter()
  res.status = null
  res.body = null
  res.writeHead = (status) => { res.status = status }
  res.end = (body) => { res.body = JSON.parse(body) }
  return res
}

function makeReq(method, payload, headers) {
  const req = new EventEmitter()
  req.method = method
  req.url = '/api/turn-notify/config'
  req.headers = { host: '127.0.0.1:3080', ...(headers || {}) }
  const data = payload === undefined ? null : Buffer.from(JSON.stringify(payload))
  process.nextTick(() => {
    if (data !== null) req.emit('data', data)
    req.readableEnded = true
    req.emit('end')
  })
  return req
}

const JSON_HEADERS = { 'content-type': 'application/json' }

function makeCtx() {
  const routes = new Map()
  const handlers = new Map()
  const doc = new Map()
  const settingsService = {
    register(ns) {
      if (!doc.has(ns)) doc.set(ns, {})
      return { get: () => doc.get(ns), watch: () => () => {} }
    },
    get: (ns) => doc.get(ns),
    update: async (ns, patch) => { doc.set(ns, { ...(doc.get(ns) ?? {}), ...patch }) },
  }
  const ctx = {
    on(event, fn) { handlers.set(event, fn) },
    get(key) { return key === 'settings' ? settingsService : undefined },
    inject(deps, fn) { fn({ settings: settingsService }) },
    effect(thunk) { thunk() },
    webServer: { register(route) { routes.set(route.path, route.handler) } },
  }
  return { ctx, routes, handlers }
}

const flushMicrotasks = () => new Promise((resolve) => setImmediate(resolve))

const MAIN = { id: 'M', header: { delegationDepth: 0 } }
const turnEnd = (kind) => ({ type: 'turn/end', data: { reason: { kind } } })

async function postConfig(routes, patch) {
  const res = makeRes()
  await routes.get('/api/turn-notify/config')(makeReq('POST', patch, JSON_HEADERS), res)
  assert.equal(res.status, 200)
  return res
}

async function pollProjection(routes, remoteAddress) {
  const req = makeReq('GET')
  req.url = '/api/turn-notify/projection'
  if (remoteAddress !== undefined) req.socket = { remoteAddress }
  const res = makeRes()
  await routes.get('/api/turn-notify/projection')(req, res)
  assert.equal(res.status, 200)
  return res
}

// 本机浏览器长轮询记账形态:回环 + 带续传 cursor + fetch 形态头;
// cursor 取超前值立即返回,不挂起
const FUTURE_CURSOR = 2 ** 40
async function browserPoll(routes, remoteAddress) {
  const req = makeReq('GET', undefined, { 'sec-fetch-mode': 'cors' })
  req.url = '/api/turn-notify/projection?cursor=' + FUTURE_CURSOR
  req.socket = { remoteAddress }
  const res = makeRes()
  await routes.get('/api/turn-notify/projection')(req, res)
  assert.equal(res.status, 200)
  return res
}

// 伪形态轮询:回环来源但缺 cursor / no-cors / 跨源 Origin,记账须拒绝
async function rawShapePoll(routes, remoteAddress, secFetchMode, withCursor, origin) {
  const headers = secFetchMode === undefined ? {} : { 'sec-fetch-mode': secFetchMode }
  if (origin !== undefined) headers.origin = origin
  const req = makeReq('GET', undefined, headers)
  req.url = '/api/turn-notify/projection' + (withCursor ? '?cursor=' + FUTURE_CURSOR : '')
  req.socket = { remoteAddress }
  const res = makeRes()
  await routes.get('/api/turn-notify/projection')(req, res)
  assert.equal(res.status, 200)
  return res
}

// spawn 观测缝:替换实现收集调用,测试结束还原
async function withStubSpawn(run) {
  const spawns = []
  const original = __hostSpawn.impl
  __hostSpawn.impl = (file, args, options, callback) => {
    spawns.push({ file, args })
    callback(null)
  }
  try {
    return await run(spawns)
  } finally {
    __hostSpawn.impl = original
  }
}

async function emitCompletedTurn(handlers) {
  handlers.get('session/event')(MAIN, { type: 'turn/start' })
  handlers.get('session/event')(MAIN, turnEnd('completed'))
  await flushMicrotasks()
}

// 挂起中的长轮询:cursor 等于当前版本(配置 POST 后为 1),服务端挂起等待,
// 模拟真实客户端的在途请求;返回 pending 承诺与 res 桩(供断连模拟与唤醒等待)
function hangingPoll(routes, remoteAddress) {
  const req = makeReq('GET', undefined, { 'sec-fetch-mode': 'cors' })
  req.url = '/api/turn-notify/projection?cursor=1'
  req.socket = { remoteAddress }
  const res = makeRes()
  const pending = routes.get('/api/turn-notify/projection')(req, res)
  return { pending, res }
}

test('Given 总开关开且本机长轮询在途 When 回合完成 Then 宿主让位;离场超窗后接管', async () => {
  await withStubSpawn(async (spawns) => {
    const { ctx, routes, handlers } = makeCtx()
    apply(ctx)
    const saved = await postConfig(routes, { hostNotify: true, minTurnDurationMs: 0 })
    assert.equal(saved.body.hostNotify, true)
    const { pending, res } = hangingPoll(routes, '127.0.0.1')
    await flushMicrotasks()
    // 在途请求即在场信号:浏览器优先,宿主让位,正常路径零重复
    await emitCompletedTurn(handlers)
    assert.equal(spawns.length, 0, '本机长轮询在途,宿主让位')
    // 在途请求被回合事件唤醒完成,宽限窗口内仍算在场
    await pending
    await emitCompletedTurn(handlers)
    assert.equal(spawns.length, 0, '长轮询刚完成,宽限窗口内仍由浏览器呈现')
    // 推进时钟越过宽限窗口:本机视为离场,宿主接管(宁可重复不可漏)
    const realNow = Date.now
    Date.now = () => realNow() + CLIENT_PRESENCE_WINDOW_MS + 1
    try {
      await emitCompletedTurn(handlers)
    } finally { Date.now = realNow }
    assert.equal(spawns.length, 1, '离场超窗,宿主接管')
    const projection = await pollProjection(routes, undefined)
    assert.equal(projection.body.units.length, 3, '浏览器呈现通道不受让位影响')
  })
})

test('Given 总开关开且本机长轮询断连 When 回合完成 Then 认可窗口内让位,超窗接管', async () => {
  await withStubSpawn(async (spawns) => {
    const { ctx, routes, handlers } = makeCtx()
    apply(ctx)
    await postConfig(routes, { hostNotify: true, minTurnDurationMs: 0 })
    const { pending, res } = hangingPoll(routes, '127.0.0.1')
    await flushMicrotasks()
    // 浏览器关闭中止请求:close 事件即时出账,最近活动定格于断连时刻
    res.emit('close')
    await emitCompletedTurn(handlers)
    assert.equal(spawns.length, 0, '断连后认可窗口内仍算在场(边界情况宁可不弹)')
    // 推进时钟越过认可窗口:宿主接管
    const realNow = Date.now
    Date.now = () => realNow() + CLIENT_PRESENCE_WINDOW_MS + 1
    try {
      await emitCompletedTurn(handlers)
    } finally { Date.now = realNow }
    assert.equal(spawns.length, 1, '断连超窗,宿主接管')
    // 唤醒挂起的等待事务,防测试尾部悬挂 25 秒定时器
    await postConfig(routes, { hostNotify: true, minTurnDurationMs: 0 })
    await pending
  })
})

test('Given 记账轮询正常完成后再触发 close When 时钟推进越过认可窗 Then 出账幂等不双计', async () => {
  await withStubSpawn(async (spawns) => {
    const { ctx, routes, handlers } = makeCtx()
    apply(ctx)
    await postConfig(routes, { hostNotify: true, minTurnDurationMs: 0 })
    // 全程虚拟时钟:消解真实间隔,配平断言只依赖显式推进
    const realNow = Date.now
    let fake = 1000 * 1000
    Date.now = () => fake
    try {
      const first = await browserPoll(routes, '127.0.0.1')
      // 生产正常完成路径:finally 已出账,响应完成后的 close 再触发须被幂等消化;
      // 若双出账致计数走负,时钟推进后本应让位的在途轮询将误弹
      first.emit('close')
      const second = hangingPoll(routes, '127.0.0.1')
      await flushMicrotasks()
      fake += CLIENT_PRESENCE_WINDOW_MS + 1
      await emitCompletedTurn(handlers)
      assert.equal(spawns.length, 0, '计数未被双出账破坏,在途轮询仍正常让位')
      await second.pending
      fake += CLIENT_PRESENCE_WINDOW_MS + 1
      await emitCompletedTurn(handlers)
      assert.equal(spawns.length, 1, '出账配平正确,超窗接管不受影响')
    } finally { Date.now = realNow }
  })
})

test('Given 双 tab 并发挂起其一断连 When 时钟推进越过认可窗 Then 在途方仍让位,全部出账后接管', async () => {
  await withStubSpawn(async (spawns) => {
    const { ctx, routes, handlers } = makeCtx()
    apply(ctx)
    await postConfig(routes, { hostNotify: true, minTurnDurationMs: 0 })
    const realNow = Date.now
    let fake = 1000 * 1000
    Date.now = () => fake
    try {
      const tabA = hangingPoll(routes, '127.0.0.1')
      const tabB = hangingPoll(routes, '::1')
      await flushMicrotasks()
      // tabA 断连即时出账,tabB 独力承载在途信号
      tabA.res.emit('close')
      await flushMicrotasks()
      fake += CLIENT_PRESENCE_WINDOW_MS + 1
      await emitCompletedTurn(handlers)
      assert.equal(spawns.length, 0, 'tabA 断连出账,tabB 在途,整体在场')
      // 回合事件唤醒两个挂起轮询,出账后计数归零
      await Promise.all([tabA.pending, tabB.pending])
      fake += CLIENT_PRESENCE_WINDOW_MS + 1
      await emitCompletedTurn(handlers)
      assert.equal(spawns.length, 1, '全部出账,计数归零,超窗接管')
    } finally { Date.now = realNow }
  })
})

test('Given 总开关开且仅远程浏览器在线 When 回合完成 Then 宿主弹', async () => {
  await withStubSpawn(async (spawns) => {
    const { ctx, routes, handlers } = makeCtx()
    apply(ctx)
    await postConfig(routes, { hostNotify: true, minTurnDurationMs: 0 })
    await browserPoll(routes, '192.168.1.5')
    await emitCompletedTurn(handlers)
    assert.equal(spawns.length, 1, '远程浏览器不与宿主同机,照常弹')
    assert.ok(spawns[0].args.flat().join(' ').includes('任务完成'), '通知文本应随 spawn 传出')
  })
})

test('Given 总开关开且无浏览器在场 When 回合完成 Then 宿主弹', async () => {
  await withStubSpawn(async (spawns) => {
    const { ctx, routes, handlers } = makeCtx()
    apply(ctx)
    await postConfig(routes, { hostNotify: true, minTurnDurationMs: 0 })
    await emitCompletedTurn(handlers)
    assert.equal(spawns.length, 1)
  })
})

test('Given kindRoutes 名单不含 host When 总开关开 Then 不弹', async () => {
  await withStubSpawn(async (spawns) => {
    const { ctx, routes, handlers } = makeCtx()
    apply(ctx)
    await postConfig(routes, { hostNotify: true, minTurnDurationMs: 0, kindRoutes: { completed: ['webhook'] } })
    await emitCompletedTurn(handlers)
    assert.equal(spawns.length, 0, '路由名单外的宿主通道不送达')
  })
})

test('Given 回退开关开 When 本机长轮询在途 Then 不弹;仅远程在线 Then 弹', async () => {
  await withStubSpawn(async (spawns) => {
    const local = makeCtx()
    apply(local.ctx)
    await postConfig(local.routes, { hostNotifyFallback: true, minTurnDurationMs: 0 })
    const localPoll = hangingPoll(local.routes, '::1')
    await flushMicrotasks()
    await emitCompletedTurn(local.handlers)
    assert.equal(spawns.length, 0, '本机浏览器在途,回退不触发')
    await postConfig(local.routes, { hostNotifyFallback: true, minTurnDurationMs: 0 })
    await localPoll.pending
    // 独立实例:本机从未有浏览器,仅远程浏览器轮询过
    const remote = makeCtx()
    apply(remote.ctx)
    await postConfig(remote.routes, { hostNotifyFallback: true, minTurnDurationMs: 0 })
    await browserPoll(remote.routes, '10.0.0.8')
    await emitCompletedTurn(remote.handlers)
    assert.equal(spawns.length, 1, '本机无浏览器,回退触发')
  })
})

test('Given 裸 GET 形态(无 cursor 或 no-cors 或跨源)When 回合完成 Then 回退不触发(伪造在场不入账)', async () => {
  await withStubSpawn(async (spawns) => {
    const { ctx, routes, handlers } = makeCtx()
    apply(ctx)
    await postConfig(routes, { hostNotifyFallback: true, minTurnDurationMs: 0 })
    // 回环来源但缺 cursor:手工探测形态
    await rawShapePoll(routes, '127.0.0.1', 'cors', false)
    // 回环来源带 cursor 但 no-cors:同机网页 img 探活形态
    await rawShapePoll(routes, '127.0.0.1', 'no-cors', true)
    // 回环来源带 cursor 且 cors 但跨源 Origin:同机恶意网页标准 fetch 形态
    await rawShapePoll(routes, '127.0.0.1', 'cors', true, 'https://evil.example')
    await emitCompletedTurn(handlers)
    assert.equal(spawns.length, 1, '伪造在场不入账,本机无真实浏览器时回退照常触发')
  })
})

test('Given spawn 失败 When 回合完成 Then 无未处理拒绝且投影照常', async () => {
  const rejections = []
  const onUnhandled = (reason) => rejections.push(reason)
  process.on('unhandledRejection', onUnhandled)
  const original = __hostSpawn.impl
  __hostSpawn.impl = (file, args, options, callback) => callback(new Error('no desktop'))
  try {
    const { ctx, routes, handlers } = makeCtx()
    apply(ctx)
    await postConfig(routes, { hostNotify: true, minTurnDurationMs: 0 })
    handlers.get('session/event')(MAIN, { type: 'turn/start' })
    handlers.get('session/event')(MAIN, turnEnd('completed'))
    await flushMicrotasks()
    await flushMicrotasks()
    assert.equal(rejections.length, 0)
    const projection = await pollProjection(routes, undefined)
    assert.equal(projection.body.units.length, 1)
  } finally {
    process.off('unhandledRejection', onUnhandled)
    __hostSpawn.impl = original
  }
})

test('Given 两开关均关 When 回合完成 Then 不弹', async () => {
  await withStubSpawn(async (spawns) => {
    const { ctx, routes, handlers } = makeCtx()
    apply(ctx)
    await postConfig(routes, { minTurnDurationMs: 0 })
    await emitCompletedTurn(handlers)
    assert.equal(spawns.length, 0)
  })
})

test('Given test-host 路由 When 合法点火 Then 返回真实结果;非法方法与跨源被拒', async () => {
  await withStubSpawn(async (spawns) => {
    const { ctx, routes } = makeCtx()
    apply(ctx)
    const ok = makeRes()
    await routes.get('/api/turn-notify/test-host')(makeReq('POST'), ok)
    assert.equal(ok.status, 200)
    assert.deepEqual(ok.body, { ok: true, detail: '已触发宿主通知' })
    assert.equal(spawns.length, 1)
    assert.ok(spawns[0].args.flat().join(' ').includes('[dsh]'), '测试事件文本应随 spawn 传出')
    const method = makeRes()
    await routes.get('/api/turn-notify/test-host')(makeReq('PUT'), method)
    assert.equal(method.status, 405)
    const cross = makeRes()
    await routes.get('/api/turn-notify/test-host')(makeReq('POST', undefined, { origin: 'https://evil.example' }), cross)
    assert.equal(cross.status, 403)
    assert.equal(spawns.length, 1, '被拒请求不触发 spawn')
  })
})

test('Given 测试点火在途 When 再次点火 Then 429 且不重复 spawn', async () => {
  const releases = []
  const original = __hostSpawn.impl
  __hostSpawn.impl = (file, args, options, callback) => { releases.push(callback) }
  try {
    const { ctx, routes } = makeCtx()
    apply(ctx)
    const first = routes.get('/api/turn-notify/test-host')(makeReq('POST'), makeRes())
    const secondRes = makeRes()
    await routes.get('/api/turn-notify/test-host')(makeReq('POST'), secondRes)
    assert.equal(secondRes.status, 429, '在途期间拒绝并发点火')
    assert.equal(releases.length, 1, '在途期间不重复 spawn')
    releases[0](null)
    await first
    // 释放后互斥复位:再次点火可正常 spawn;spawn 回执由本测试持有,先到账再释放
    const third = makeRes()
    const thirdCall = routes.get('/api/turn-notify/test-host')(makeReq('POST'), third)
    await flushMicrotasks()
    assert.equal(releases.length, 2, '互斥复位后恢复 spawn')
    releases[1](null)
    await thirdCall
    assert.equal(third.status, 200)
  } finally { __hostSpawn.impl = original }
})
