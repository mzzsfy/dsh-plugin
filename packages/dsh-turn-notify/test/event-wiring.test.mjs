// host 事件接线集成测试:stub ctx 装载真实 src/index.js,伪造 session/event 序列,
// 经投影路由断言子代理回执静默的标记/消费/清理时序与异常分类放行。
import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'

import { apply } from '../src/index.js'

function makeRes() {
  return {
    status: null,
    body: null,
    writeHead(status) { this.status = status },
    end(body) { this.body = JSON.parse(body) },
  }
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

function makeSettings() {
  const doc = new Map()
  return {
    register(ns) {
      if (!doc.has(ns)) doc.set(ns, {})
      return { get: () => doc.get(ns), watch: () => () => {} }
    },
    get: (ns) => doc.get(ns),
    update: async (ns, patch) => { doc.set(ns, { ...(doc.get(ns) ?? {}), ...patch }) },
  }
}

function makeCtx(extraServices) {
  const routes = new Map()
  const handlers = new Map()
  const settingsService = makeSettings()
  const ctx = {
    on(event, fn) { handlers.set(event, fn) },
    get(key) {
      if (key === 'settings') return settingsService
      return extraServices ? extraServices[key] : undefined
    },
    inject(deps, fn) { fn({ settings: settingsService }) },
    effect(thunk) { thunk() },
    webServer: { register(route) { routes.set(route.path, route.handler) } },
  }
  return { ctx, routes, handlers }
}

const flushMicrotasks = () => new Promise((resolve) => setImmediate(resolve))

function makeImDshIm(sends, failTargetId) {
  return {
    send: async (botId, targetId, text) => {
      sends.push({ botId, targetId, text })
      if (targetId === failTargetId) throw Object.assign(new Error('offline'), { code: 'bot-not-connected' })
      return { sent: true }
    },
    listTargets: async () => [],
  }
}

async function configureImTargets(routes, targets) {
  const res = makeRes()
  await routes.get('/api/turn-notify/config')(makeReq('POST', { imTargets: targets }, JSON_HEADERS), res)
  assert.equal(res.status, 200)
}

const MAIN = { id: 'M', header: { delegationDepth: 0 } }
const CHILD = { id: 'S', header: { origin: 'subagent', parentSession: 'M', delegationDepth: 1 } }

function turnEnd(kind) { return { type: 'turn/end', data: { reason: { kind } } } }

// 关闭碎轮过滤:同毫秒回合不被时长过滤,聚焦事件接线本身
async function disableDurationFilter(routes) {
  const res = makeRes()
  await routes.get('/api/turn-notify/config')(makeReq('POST', { minTurnDurationMs: 0 }, JSON_HEADERS), res)
  assert.equal(res.status, 200)
}

async function projectionUnits(routes) {
  const res = makeRes()
  await routes.get('/api/turn-notify/projection')(makeReq('GET'), res)
  assert.equal(res.status, 200)
  return res.body.units
}

test('Given 子代理刚结束 When 父会话唤醒回合以 completed 结束 Then 投影无完成通知', async () => {
  const { ctx, routes, handlers } = makeCtx()
  apply(ctx)
  await disableDurationFilter(routes)
  const onEvent = handlers.get('session/event')
  onEvent(CHILD, turnEnd('completed'))
  onEvent(MAIN, { type: 'turn/start' })
  onEvent(MAIN, turnEnd('completed'))
  const units = await projectionUnits(routes)
  assert.equal(units.filter((unit) => unit.category === 'completed').length, 0)
})

test('Given 唤醒回合已消费 When 窗口内父会话再开新回合完成 Then 通知恢复', async () => {
  const { ctx, routes, handlers } = makeCtx()
  apply(ctx)
  await disableDurationFilter(routes)
  const onEvent = handlers.get('session/event')
  onEvent(CHILD, turnEnd('completed'))
  // 第一个唤醒回合:被静默,记录被消费
  onEvent(MAIN, { type: 'turn/start' })
  onEvent(MAIN, turnEnd('completed'))
  // 第二个回合:窗口内但记录已消费,正常通知
  onEvent(MAIN, { type: 'turn/start' })
  onEvent(MAIN, turnEnd('completed'))
  const units = await projectionUnits(routes)
  assert.equal(units.filter((unit) => unit.category === 'completed').length, 1)
})

test('Given 无子代理事件 When 普通父会话回合完成 Then 正常通知不误伤', async () => {
  const { ctx, routes, handlers } = makeCtx()
  apply(ctx)
  await disableDurationFilter(routes)
  const onEvent = handlers.get('session/event')
  onEvent(MAIN, { type: 'turn/start' })
  onEvent(MAIN, turnEnd('completed'))
  const units = await projectionUnits(routes)
  assert.equal(units.filter((unit) => unit.category === 'completed').length, 1)
})

test('Given 唤醒回合 When 以 error 结束 Then 异常分类仍通知', async () => {
  const { ctx, routes, handlers } = makeCtx()
  apply(ctx)
  await disableDurationFilter(routes)
  const onEvent = handlers.get('session/event')
  onEvent(CHILD, turnEnd('completed'))
  onEvent(MAIN, { type: 'turn/start' })
  onEvent(MAIN, turnEnd('error'))
  const units = await projectionUnits(routes)
  assert.equal(units.filter((unit) => unit.category === 'error').length, 1)
})

test('Given 父会话已暂停收尾 When 子代理随后完成并唤醒父会话 Then 唤醒回合 completed 被静默', async () => {
  const { ctx, routes, handlers } = makeCtx()
  apply(ctx)
  await disableDurationFilter(routes)
  const onEvent = handlers.get('session/event')
  // 暂停前的正常回合:正常通知
  onEvent(MAIN, { type: 'turn/start' })
  onEvent(MAIN, turnEnd('completed'))
  // 父会话已收尾后子代理完成,唤醒父会话:该回执回合被静默
  onEvent(CHILD, turnEnd('completed'))
  onEvent(MAIN, { type: 'turn/start' })
  onEvent(MAIN, turnEnd('completed'))
  const units = await projectionUnits(routes)
  assert.equal(units.filter((unit) => unit.category === 'completed').length, 1)
})

test('Given dshIm 在场且已配多目标 When 回合完成 Then 逐目标投递 unit.text', async () => {
  const sends = []
  const { ctx, routes, handlers } = makeCtx({ dshIm: makeImDshIm(sends) })
  apply(ctx)
  await disableDurationFilter(routes)
  await configureImTargets(routes, [{ botId: 'wx_a', targetId: 'owner' }, { botId: 'wx_b', targetId: 'group' }])
  const onEvent = handlers.get('session/event')
  onEvent(MAIN, { type: 'turn/start' })
  onEvent(MAIN, turnEnd('completed'))
  await flushMicrotasks()
  assert.equal(sends.length, 2)
  assert.deepEqual(sends.map((call) => call.targetId).sort(), ['group', 'owner'])
  assert.ok(sends.every((call) => call.botId === 'wx_a' || call.botId === 'wx_b'))
  assert.ok(sends.every((call) => String(call.text).startsWith('[dsh]')), 'IM 文本应与通知单元一致')
})

test('Given send 拒绝 When 回合完成 Then 无未处理拒绝且投影照常', async () => {
  const rejections = []
  const onUnhandled = (reason) => rejections.push(reason)
  process.on('unhandledRejection', onUnhandled)
  try {
    const sends = []
    const { ctx, routes, handlers } = makeCtx({ dshIm: makeImDshIm(sends, 'bad') })
    apply(ctx)
    await disableDurationFilter(routes)
    await configureImTargets(routes, [{ botId: 'wx_a', targetId: 'bad' }])
    const onEvent = handlers.get('session/event')
    onEvent(MAIN, { type: 'turn/start' })
    onEvent(MAIN, turnEnd('completed'))
    await flushMicrotasks()
    await flushMicrotasks()
    assert.equal(rejections.length, 0)
    const units = await projectionUnits(routes)
    assert.equal(units.length, 1)
  } finally { process.off('unhandledRejection', onUnhandled) }
})

test('Given dshIm 缺席或未配目标 When 回合完成 Then 不投递且流程无感', async () => {
  const { ctx, routes, handlers } = makeCtx()
  apply(ctx)
  await disableDurationFilter(routes)
  const onEvent = handlers.get('session/event')
  onEvent(MAIN, { type: 'turn/start' })
  onEvent(MAIN, turnEnd('completed'))
  const units = await projectionUnits(routes)
  assert.equal(units.length, 1)
  const sends = []
  const second = makeCtx({ dshIm: makeImDshIm(sends) })
  apply(second.ctx)
  await disableDurationFilter(second.routes)
  const onEvent2 = second.handlers.get('session/event')
  onEvent2(MAIN, { type: 'turn/start' })
  onEvent2(MAIN, turnEnd('completed'))
  await flushMicrotasks()
  assert.equal(sends.length, 0)
})

test('Given 默认碎轮过滤未关闭 When 同毫秒回合完成 Then 碎轮被滤而提问通知放行', async () => {
  const { ctx, routes, handlers } = makeCtx()
  apply(ctx)
  const onEvent = handlers.get('session/event')
  // 同毫秒完成的回合:时长不足被滤
  onEvent(MAIN, { type: 'turn/start' })
  onEvent(MAIN, turnEnd('completed'))
  // 提问通知不受碎轮过滤
  onEvent(MAIN, { type: 'tool/call', data: { name: 'ask_user_question' } })
  const units = await projectionUnits(routes)
  assert.equal(units.filter((unit) => unit.category === 'completed').length, 0)
  assert.equal(units.filter((unit) => unit.category === 'ask').length, 1)
})

test('Given 非提问的 tool/call When 事件到达 Then 不产生通知', async () => {
  const { ctx, routes, handlers } = makeCtx()
  apply(ctx)
  const onEvent = handlers.get('session/event')
  onEvent(MAIN, { type: 'tool/call', data: { name: 'read_file' } })
  const units = await projectionUnits(routes)
  assert.equal(units.length, 0)
})

test('Given approval/request 观察者 When 触发 Then 投影审批单元且 next 同步放行', async () => {
  const { ctx, routes, handlers } = makeCtx()
  apply(ctx)
  const tap = handlers.get('approval/request')
  assert.equal(typeof tap, 'function')
  const returned = tap({}, () => 'next-value')
  assert.equal(returned, 'next-value')
  const units = await projectionUnits(routes)
  assert.equal(units.filter((unit) => unit.category === 'approval').length, 1)
})

test('Given 已配置 webhook When 真实回合完成 Then fetch 收到 payload 形态', async () => {
  const calls = []
  const original = globalThis.fetch
  globalThis.fetch = async (url, options) => {
    calls.push({ url, body: JSON.parse(options.body) })
    return { ok: true, status: 200 }
  }
  try {
    const { ctx, routes, handlers } = makeCtx()
    apply(ctx)
    await disableDurationFilter(routes)
    const config = makeRes()
    await routes.get('/api/turn-notify/config')(makeReq('POST', { webhookUrl: 'https://hook.example' }, JSON_HEADERS), config)
    assert.equal(config.status, 200)
    const onEvent = handlers.get('session/event')
    onEvent(MAIN, { type: 'turn/start' })
    onEvent(MAIN, turnEnd('completed'))
    await flushMicrotasks()
    assert.equal(calls.length, 1)
    assert.equal(calls[0].url, 'https://hook.example')
    assert.equal(calls[0].body.category, 'completed')
    assert.ok(String(calls[0].body.event).startsWith('n-'), 'event 应为通知 id')
    assert.ok(String(calls[0].body.text).startsWith('[dsh]'), 'webhook text 应与通知单元一致')
  } finally { globalThis.fetch = original }
})
