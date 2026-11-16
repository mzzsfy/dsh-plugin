// host 事件接线集成测试:stub ctx 装载真实 src/index.js,伪造 session/event 序列,
// 经投影路由断言子代理回执静默的标记/消费/清理时序与异常分类放行。
import test from 'node:test'
import { busStub, resetBusStub } from './_mocks.common-tools.mjs'

import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'

import { apply } from '../src/index.js'

// 浏览器 client 全部经 api() 以 application/json 发送;写请求默认带 JSON 头,
// 使业务用例不受共享闸门的 content-type 门影响(守卫差异由专门用例显式覆盖)
const JSON_HEADERS = { 'content-type': 'application/json' }
const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE'])

// res 桩带事件能力:投影处理器挂 close 事件感知断连,桩须支持 once
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
  req.headers = { host: '127.0.0.1:3080', ...(WRITE_METHODS.has(method) ? JSON_HEADERS : {}), ...(headers || {}) }
  const data = payload === undefined ? null : Buffer.from(JSON.stringify(payload))
  process.nextTick(() => {
    if (data !== null) req.emit('data', data)
    req.readableEnded = true
    req.emit('end')
  })
  return req
}

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
  resetBusStub()
  const published = busStub.published
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
  return { ctx, routes, handlers, published }
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
function toolCall(name) { return { type: 'tool/call', data: { name } } }

// 后台委托场景:主回合内调用 subagent 工具,子代理随后开跑
function backgroundDelegationStart(onEvent) {
  onEvent(MAIN, toolCall('subagent'))
  onEvent(CHILD, { type: 'turn/start' })
}

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

test('N1 Given 同名会话与无标题会话 When host事件投影 Then 保留各自sessionId', async () => {
  const { ctx, routes, handlers } = makeCtx({ sessionTitle: { get: () => ({ title: '同名' }) } })
  apply(ctx)
  const onEvent = handlers.get('session/event')
  onEvent({ id: 'A', header: {} }, toolCall('ask_user_question'))
  onEvent({ id: 'B', header: {} }, toolCall('ask_user_question'))
  assert.deepEqual((await projectionUnits(routes)).map(unit => [unit.sessionId, unit.session]), [['A', '同名'], ['B', '同名']])
  const bare = makeCtx()
  apply(bare.ctx)
  bare.handlers.get('session/event')({ id: 'no-title', header: {} }, toolCall('ask_user_question'))
  assert.equal((await projectionUnits(bare.routes))[0].sessionId, 'no-title')
})

// P2-45 归档会话不进入 host 通知链路:权威集合按根会话过滤,未就绪按未知放行
test('P2-45 Given 根会话已归档 When 回合结束/审批/提问 Then 全部不产生通知;解除归档恢复', async () => {
  const archived = new Set(['M'])
  const { ctx, routes, handlers } = makeCtx({ workspaceRegistry: { get archivedSessionIds() { return [...archived] } } })
  apply(ctx)
  await disableDurationFilter(routes)
  const onEvent = handlers.get('session/event')
  onEvent(MAIN, { type: 'turn/start' })
  onEvent(MAIN, turnEnd('completed'))
  onEvent(MAIN, { type: 'approval/asked', data: { id: 'ap-1', toolName: 'bash' } })
  onEvent(MAIN, toolCall('ask_user_question'))
  assert.equal((await projectionUnits(routes)).length, 0, '归档会话不产生任何分类通知')
  archived.clear()
  onEvent(MAIN, { type: 'turn/start' })
  onEvent(MAIN, turnEnd('completed'))
  const units = await projectionUnits(routes)
  assert.equal(units.filter((unit) => unit.category === 'completed').length, 1, '解除归档后恢复通知')
})

test('P2-45 Given 根会话已归档 When 放开子代理过滤产生子代理事件 Then 按根会话过滤', async () => {
  const archived = new Set(['M'])
  const { ctx, routes, handlers } = makeCtx({ workspaceRegistry: { get archivedSessionIds() { return [...archived] } } })
  apply(ctx)
  await disableDurationFilter(routes)
  const config = makeRes()
  await routes.get('/api/turn-notify/config')(makeReq('POST', { rootsOnly: false }, JSON_HEADERS), config)
  assert.equal(config.status, 200)
  const onEvent = handlers.get('session/event')
  onEvent(MAIN, { type: 'turn/start' })
  onEvent(CHILD, { type: 'turn/start' })
  onEvent(CHILD, turnEnd('completed'))
  const grandchild = { id: 'G', header: { origin: 'subagent', parentSession: 'S', delegationDepth: 2 } }
  onEvent(grandchild, { type: 'turn/start' })
  onEvent(grandchild, turnEnd('completed'))
  assert.equal((await projectionUnits(routes)).length, 0, '直接与多级子代理都归结到已归档根会话')
})

test('Given rootsOnly=false When 多级子代理完成 Then unit 携带已归结的根会话 id', async () => {
  const { ctx, routes, handlers } = makeCtx()
  apply(ctx)
  await disableDurationFilter(routes)
  const config = makeRes()
  await routes.get('/api/turn-notify/config')(makeReq('POST', { rootsOnly: false }, JSON_HEADERS), config)
  assert.equal(config.status, 200)
  const onEvent = handlers.get('session/event')
  onEvent(MAIN, { type: 'turn/start' })
  onEvent(CHILD, { type: 'turn/start' })
  onEvent(CHILD, turnEnd('completed'))
  const grandchild = { id: 'G', header: { origin: 'subagent', parentSession: 'S', delegationDepth: 2 } }
  onEvent(grandchild, { type: 'turn/start' })
  onEvent(grandchild, turnEnd('completed'))
  const units = await projectionUnits(routes)
  const childUnit = units.find((unit) => unit.sessionId === 'S')
  const grandchildUnit = units.find((unit) => unit.sessionId === 'G')
  assert.equal(childUnit.rootSessionId, 'M', '直接子代理 unit 必须携带根会话 id')
  assert.equal(grandchildUnit.rootSessionId, 'M', '多级子代理 unit 必须携带根会话 id')
})

test('F1 Given 中间子代理已 disposed When 孙代理完成 Then 根 id 仍为根会话且归档过滤按根', async () => {
  const archived = new Set()
  const { ctx, routes, handlers } = makeCtx({ workspaceRegistry: { get archivedSessionIds() { return [...archived] } } })
  apply(ctx)
  await disableDurationFilter(routes)
  const config = makeRes()
  await routes.get('/api/turn-notify/config')(makeReq('POST', { rootsOnly: false }, JSON_HEADERS), config)
  assert.equal(config.status, 200)
  const onEvent = handlers.get('session/event')
  onEvent(MAIN, { type: 'turn/start' })
  onEvent(CHILD, { type: 'turn/start' })
  handlers.get('session/disposed')(CHILD)
  const grandchild = { id: 'G', header: { origin: 'subagent', parentSession: 'S', delegationDepth: 2 } }
  onEvent(grandchild, { type: 'turn/start' })
  onEvent(grandchild, turnEnd('completed'))
  let units = await projectionUnits(routes)
  const grandchildUnit = units.find((unit) => unit.sessionId === 'G')
  assert.equal(grandchildUnit.rootSessionId, 'M', '中间会话 disposed 后孙代理仍须归结根会话,不得把 S 当根')
  archived.add('M')
  const before = units.length
  onEvent(grandchild, { type: 'turn/start' })
  onEvent(grandchild, turnEnd('completed'))
  units = await projectionUnits(routes)
  assert.equal(units.length, before, '归档过滤必须按根会话 M,不得按中间会话 S 漏放行')
})

test('F1 Given 父头缺失且无根缓存 When 子代理完成 Then rootSessionId 为 null 而非中间 id', async () => {
  const { ctx, routes, handlers } = makeCtx()
  apply(ctx)
  await disableDurationFilter(routes)
  const config = makeRes()
  await routes.get('/api/turn-notify/config')(makeReq('POST', { rootsOnly: false }, JSON_HEADERS), config)
  assert.equal(config.status, 200)
  const orphanChild = { id: 'G', header: { origin: 'subagent', parentSession: 'UNSEEN', delegationDepth: 2 } }
  const onEvent = handlers.get('session/event')
  onEvent(orphanChild, { type: 'turn/start' })
  onEvent(orphanChild, turnEnd('completed'))
  const unit = (await projectionUnits(routes)).find((item) => item.sessionId === 'G')
  assert.equal(unit.rootSessionId, null, '父头未知时不得回退到中间 id UNSEEN')
})

test('P2-45 Given 归档服务未就绪 When 回合完成 Then 按未知放行,不把未知当空集误拦', async () => {
  const { ctx, routes, handlers } = makeCtx({ workspaceRegistry: { get archivedSessionIds() { throw new Error('workspace registry is not started yet') } } })
  apply(ctx)
  await disableDurationFilter(routes)
  const onEvent = handlers.get('session/event')
  onEvent(MAIN, { type: 'turn/start' })
  onEvent(MAIN, turnEnd('completed'))
  const units = await projectionUnits(routes)
  assert.equal(units.filter((unit) => unit.category === 'completed').length, 1)
})

// 会话销毁释放观察账本:同 id 重建时不沿用旧标题封账
test('Given 会话 disposed 后同 id 重建 When 提取标题 Then 旧标题不残留', async () => {
  const { ctx, routes, handlers } = makeCtx()
  apply(ctx)
  const onEvent = handlers.get('session/event')
  onEvent({ id: 'S', header: {} }, { type: 'user/message', data: { content: [{ type: 'text', text: '旧标题' }] } })
  onEvent({ id: 'S', header: {} }, toolCall('ask_user_question'))
  let units = await projectionUnits(routes)
  assert.equal(units[0].session, '旧标题')
  handlers.get('session/disposed')({ id: 'S', header: {} })
  onEvent({ id: 'S', header: {} }, { type: 'user/message', data: { content: [{ type: 'text', text: '新标题' }] } })
  onEvent({ id: 'S', header: {} }, toolCall('ask_user_question'))
  units = await projectionUnits(routes)
  assert.equal(units.at(-1).session, '新标题', 'disposed 后标题封账状态必须释放')
})

test('Given 会话 disposed 后同 id 新回合 When 统计尾部 Then 旧 tokens 不残留', async () => {
  const { ctx, routes, handlers } = makeCtx()
  apply(ctx)
  await disableDurationFilter(routes)
  const onEvent = handlers.get('session/event')
  onEvent(MAIN, { type: 'turn/start' })
  onEvent(MAIN, { type: 'assistant/message', data: { usage: { inputTokens: 100, outputTokens: 0 }, message: { content: [] } } })
  handlers.get('session/disposed')({ id: 'M', header: {} })
  onEvent(MAIN, { type: 'assistant/message', data: { usage: { inputTokens: 50, outputTokens: 0 }, message: { content: [] } } })
  onEvent(MAIN, turnEnd('completed'))
  const unit = (await projectionUnits(routes)).find((item) => item.category === 'completed')
  assert.equal(unit.tokens, 50, 'disposed 后 assistant 尾部账本必须释放')
})

test('T1 Given 子代理被销毁 When 父会话同回合以 completed 结束 Then 收尾结算且仍通知', async () => {
  const { ctx, routes, handlers } = makeCtx()
  apply(ctx)
  await disableDurationFilter(routes)
  const onEvent = handlers.get('session/event')
  onEvent(MAIN, { type: 'turn/start' })
  onEvent(MAIN, toolCall('subagent'))
  onEvent(CHILD, { type: 'turn/start' })
  handlers.get('session/disposed')(CHILD)
  onEvent(MAIN, turnEnd('completed'))
  const units = await projectionUnits(routes)
  assert.equal(units.filter((unit) => unit.category === 'completed').length, 1, '销毁的子代理必须删除自身 childActive 并结算父回合委托,父 completed 不得被压 1 小时')
})

test('T1 Given 一个子代理被销毁另一个仍运行 When 父会话回合结束 Then 仍等待未收尾子代理', async () => {
  const { ctx, routes, handlers } = makeCtx()
  apply(ctx)
  await disableDurationFilter(routes)
  const onEvent = handlers.get('session/event')
  const CHILD2 = { id: 'S2', header: { origin: 'subagent', parentSession: 'M', delegationDepth: 1 } }
  onEvent(MAIN, { type: 'turn/start' })
  onEvent(MAIN, toolCall('subagent'))
  onEvent(CHILD, { type: 'turn/start' })
  onEvent(MAIN, toolCall('subagent'))
  onEvent(CHILD2, { type: 'turn/start' })
  handlers.get('session/disposed')(CHILD)
  onEvent(MAIN, turnEnd('completed'))
  const units = await projectionUnits(routes)
  assert.equal(units.filter((unit) => unit.category === 'completed').length, 0, '仅清理被销毁子代理自身条目,仍在运行的子代理继续压制完成通知')
})

test('子代理刚结束 When 父会话唤醒回合以 completed 结束 Then 投影无完成通知', async () => {
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

test('Given 后台子代理运行中 When 主会话回合以 completed 结束 Then 无完成通知', async () => {
  const { ctx, routes, handlers } = makeCtx()
  apply(ctx)
  await disableDurationFilter(routes)
  const onEvent = handlers.get('session/event')
  onEvent(MAIN, { type: 'turn/start' })
  backgroundDelegationStart(onEvent)
  onEvent(MAIN, turnEnd('completed'))
  const units = await projectionUnits(routes)
  assert.equal(units.filter((unit) => unit.category === 'completed').length, 0)
})

test('Given subagent 已调用但子代理 turn/start 未到 When 主会话回合完成 Then 无完成通知', async () => {
  const { ctx, routes, handlers } = makeCtx()
  apply(ctx)
  await disableDurationFilter(routes)
  const onEvent = handlers.get('session/event')
  onEvent(MAIN, { type: 'turn/start' })
  onEvent(MAIN, toolCall('subagent'))
  onEvent(MAIN, turnEnd('completed'))
  const units = await projectionUnits(routes)
  assert.equal(units.filter((unit) => unit.category === 'completed').length, 0)
})

test('Given 前台子代理已在本回合内收尾 When 主会话回合完成 Then 正常通知', async () => {
  const { ctx, routes, handlers } = makeCtx()
  apply(ctx)
  await disableDurationFilter(routes)
  const onEvent = handlers.get('session/event')
  onEvent(MAIN, { type: 'turn/start' })
  onEvent(MAIN, toolCall('subagent'))
  onEvent(CHILD, { type: 'turn/start' })
  onEvent(CHILD, turnEnd('completed'))
  onEvent(MAIN, turnEnd('completed'))
  const units = await projectionUnits(routes)
  assert.equal(units.filter((unit) => unit.category === 'completed').length, 1)
})

test('Given 混合委托前台已收尾后台仍挂起 When 主会话回合完成 Then 无完成通知', async () => {
  const { ctx, routes, handlers } = makeCtx()
  apply(ctx)
  await disableDurationFilter(routes)
  const onEvent = handlers.get('session/event')
  onEvent(MAIN, { type: 'turn/start' })
  // 前台委托:子代理在本回合内收尾
  onEvent(MAIN, toolCall('subagent'))
  onEvent(CHILD, { type: 'turn/start' })
  onEvent(CHILD, turnEnd('completed'))
  // 随后再发起后台委托,子代理 turn/start 晚于主回合结束(启动竞态)
  onEvent(MAIN, toolCall('subagent'))
  onEvent(MAIN, turnEnd('completed'))
  const units = await projectionUnits(routes)
  assert.equal(units.filter((unit) => unit.category === 'completed').length, 0)
})

test('Given 两个前台子代理均在本回合内收尾 When 主会话回合完成 Then 正常通知', async () => {
  const { ctx, routes, handlers } = makeCtx()
  apply(ctx)
  await disableDurationFilter(routes)
  const onEvent = handlers.get('session/event')
  const CHILD2 = { id: 'S2', header: { origin: 'subagent', parentSession: 'M', delegationDepth: 1 } }
  onEvent(MAIN, { type: 'turn/start' })
  onEvent(MAIN, toolCall('subagent'))
  onEvent(CHILD, { type: 'turn/start' })
  onEvent(CHILD, turnEnd('completed'))
  onEvent(MAIN, toolCall('subagent'))
  onEvent(CHILD2, { type: 'turn/start' })
  onEvent(CHILD2, turnEnd('completed'))
  onEvent(MAIN, turnEnd('completed'))
  const units = await projectionUnits(routes)
  assert.equal(units.filter((unit) => unit.category === 'completed').length, 1)
})

test('Given 后台子代理运行中 When 主会话回合以 error 结束 Then 异常分类仍通知', async () => {
  const { ctx, routes, handlers } = makeCtx()
  apply(ctx)
  await disableDurationFilter(routes)
  const onEvent = handlers.get('session/event')
  onEvent(MAIN, { type: 'turn/start' })
  backgroundDelegationStart(onEvent)
  onEvent(MAIN, turnEnd('error'))
  const units = await projectionUnits(routes)
  assert.equal(units.filter((unit) => unit.category === 'error').length, 1)
})

test('Given 后台子代理运行中 When 开关关闭且主会话回合完成 Then 通知恢复', async () => {
  const { ctx, routes, handlers } = makeCtx()
  apply(ctx)
  await disableDurationFilter(routes)
  const config = makeRes()
  await routes.get('/api/turn-notify/config')(makeReq('POST', { suppressSubagentWake: false }, JSON_HEADERS), config)
  assert.equal(config.status, 200)
  const onEvent = handlers.get('session/event')
  onEvent(MAIN, { type: 'turn/start' })
  backgroundDelegationStart(onEvent)
  onEvent(MAIN, turnEnd('completed'))
  const units = await projectionUnits(routes)
  assert.equal(units.filter((unit) => unit.category === 'completed').length, 1)
})

test('Given 子代理完成后主会话开启全新回合 When 该回合完成 Then 正常通知不误伤', async () => {
  const { ctx, routes, handlers } = makeCtx()
  apply(ctx)
  await disableDurationFilter(routes)
  const onEvent = handlers.get('session/event')
  // 后台委托回合:静默
  onEvent(MAIN, { type: 'turn/start' })
  backgroundDelegationStart(onEvent)
  onEvent(MAIN, turnEnd('completed'))
  // 子代理收尾触发既有 childDoneAt 记录,随后被新回合消费为唤醒静默;
  // 再下一个回合与子代理无关,须恢复通知
  onEvent(CHILD, turnEnd('completed'))
  onEvent(MAIN, { type: 'turn/start' })
  onEvent(MAIN, turnEnd('completed'))
  onEvent(MAIN, { type: 'turn/start' })
  onEvent(MAIN, turnEnd('completed'))
  const units = await projectionUnits(routes)
  assert.equal(units.filter((unit) => unit.category === 'completed').length, 1)
})

test('Given 等待回合已静默 When 子代理收尾后唤醒回合完成 Then 两条均不通知', async () => {
  const { ctx, routes, handlers } = makeCtx()
  apply(ctx)
  await disableDurationFilter(routes)
  const onEvent = handlers.get('session/event')
  onEvent(MAIN, { type: 'turn/start' })
  backgroundDelegationStart(onEvent)
  onEvent(MAIN, turnEnd('completed'))
  onEvent(CHILD, turnEnd('completed'))
  onEvent(MAIN, { type: 'turn/start' })
  onEvent(MAIN, turnEnd('completed'))
  const units = await projectionUnits(routes)
  assert.equal(units.filter((unit) => unit.category === 'completed').length, 0)
})

test('Given 上一回合后台子代理跨回合存活 When 新回合无委托并以 completed 结束 Then 无完成通知', async () => {
  const { ctx, routes, handlers } = makeCtx()
  apply(ctx)
  await disableDurationFilter(routes)
  const onEvent = handlers.get('session/event')
  // 回合1:后台委托后挂起,子代理未收尾
  onEvent(MAIN, { type: 'turn/start' })
  backgroundDelegationStart(onEvent)
  onEvent(MAIN, turnEnd('completed'))
  // 回合2:无任何委托,陈旧子代理仍存活
  onEvent(MAIN, { type: 'turn/start' })
  onEvent(MAIN, turnEnd('completed'))
  const units = await projectionUnits(routes)
  assert.equal(units.filter((unit) => unit.category === 'completed').length, 0)
})

test('Given 上一回合后台子代理在新回合内收尾 When 新回合委托的子代理未启动并以 completed 结束 Then 无完成通知', async () => {
  const { ctx, routes, handlers } = makeCtx()
  apply(ctx)
  await disableDurationFilter(routes)
  const onEvent = handlers.get('session/event')
  // 回合1:后台委托后挂起
  onEvent(MAIN, { type: 'turn/start' })
  backgroundDelegationStart(onEvent)
  onEvent(MAIN, turnEnd('completed'))
  // 回合2:再次委托(子代理 turn/start 迟到),陈旧子代理在本回合内收尾
  onEvent(MAIN, { type: 'turn/start' })
  onEvent(MAIN, toolCall('subagent'))
  onEvent(CHILD, turnEnd('completed'))
  onEvent(MAIN, turnEnd('completed'))
  const units = await projectionUnits(routes)
  assert.equal(units.filter((unit) => unit.category === 'completed').length, 0)
})

test('Given 子代理注册晚于父回合结束 When 其在新回合委托期间收尾 Then 该收尾不豁免本回合委托', async () => {
  const { ctx, routes, handlers } = makeCtx()
  apply(ctx)
  await disableDurationFilter(routes)
  const onEvent = handlers.get('session/event')
  // 回合1:委托后父回合先结束,子代理 turn/start 迟到(注册时父回合已无开启记录)
  onEvent(MAIN, { type: 'turn/start' })
  onEvent(MAIN, toolCall('subagent'))
  onEvent(MAIN, turnEnd('completed'))
  onEvent(CHILD, { type: 'turn/start' })
  // 回合2:再次委托(子代理未启动),迟到的子代理在本回合内收尾
  onEvent(MAIN, { type: 'turn/start' })
  onEvent(MAIN, toolCall('subagent'))
  onEvent(CHILD, turnEnd('completed'))
  onEvent(MAIN, turnEnd('completed'))
  const units = await projectionUnits(routes)
  assert.equal(units.filter((unit) => unit.category === 'completed').length, 0)
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

test('Given 已配目标且 imEnabled=false When 回合完成 Then 不投递且目标保留', async () => {
  const sends = []
  const { ctx, routes, handlers } = makeCtx({ dshIm: makeImDshIm(sends) })
  apply(ctx)
  await disableDurationFilter(routes)
  await configureImTargets(routes, [{ botId: 'wx_a', targetId: 'owner' }, { botId: 'wx_b', targetId: 'group' }])
  const offRes = makeRes()
  await routes.get('/api/turn-notify/config')(makeReq('POST', { imEnabled: false }, JSON_HEADERS), offRes)
  assert.equal(offRes.status, 200)
  assert.equal(offRes.body.imEnabled, false)
  assert.equal(offRes.body.imTargets.length, 2, '开关关闭不应清空目标')
  const onEvent = handlers.get('session/event')
  onEvent(MAIN, { type: 'turn/start' })
  onEvent(MAIN, turnEnd('completed'))
  await flushMicrotasks()
  assert.equal(sends.length, 0, 'imEnabled=false 时不投递')
  // 投影照常:开关只压制 IM 通道
  const units = await projectionUnits(routes)
  assert.equal(units.filter((unit) => unit.category === 'completed').length, 1)
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

test('Given approval/asked 会话事件 When 到达 Then 投影恰好一条审批单元且 approval/request 无观察者', async () => {
  const { ctx, routes, handlers } = makeCtx()
  apply(ctx)
  // 回归锁定:审批通知单源为 session/event,waterfall 观察者不得回潮(双路重复送达)
  assert.equal(handlers.get('approval/request'), undefined)
  const onEvent = handlers.get('session/event')
  onEvent(MAIN, { type: 'approval/asked', data: { id: 'a-1', toolName: 'bash' } })
  const units = await projectionUnits(routes)
  assert.equal(units.filter((unit) => unit.category === 'approval').length, 1)
})

// ---- 会话显示标题:与侧边栏行标题同源(session-title 投影),文本匹配高亮才成立 ----

const userMessage = (text) => ({ type: 'user/message', data: { content: [{ type: 'text', text }] } })

test('Given sessionTitle 服务在位 When 通知投递 Then 单元标题为会话标题而非首条消息', async () => {
  const { ctx, routes, handlers } = makeCtx({
    sessionTitle: { get: () => ({ title: '会话真标题' }) },
  })
  apply(ctx)
  await disableDurationFilter(routes)
  const onEvent = handlers.get('session/event')
  onEvent(MAIN, userMessage('首条消息文本'))
  onEvent(MAIN, toolCall('ask_user_question'))
  const units = await projectionUnits(routes)
  const ask = units.find((unit) => unit.category === 'ask')
  assert.equal(ask.session, '会话真标题')
})

test('Given sessionTitle 服务缺失 When 通知投递 Then 回落首条消息文本', async () => {
  const { ctx, routes, handlers } = makeCtx()
  apply(ctx)
  await disableDurationFilter(routes)
  const onEvent = handlers.get('session/event')
  onEvent(MAIN, userMessage('首条消息文本'))
  onEvent(MAIN, toolCall('ask_user_question'))
  const units = await projectionUnits(routes)
  const ask = units.find((unit) => unit.category === 'ask')
  assert.equal(ask.session, '首条消息文本')
})

test('Given 会话无事件日志可读 When 通知投递 Then 不抛并回落可用标题', async () => {
  const { ctx, routes, handlers } = makeCtx({
    sessionTitle: { get: () => { throw new Error('no event log') } },
  })
  apply(ctx)
  const onEvent = handlers.get('session/event')
  onEvent(MAIN, { type: 'approval/asked', data: { id: 'a-1', toolName: 'bash' } })
  const units = await projectionUnits(routes)
  const approval = units.find((unit) => unit.category === 'approval')
  assert.equal(approval.session, null)
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

function projectionRequest(query) {
  const res = makeRes()
  const req = makeReq('GET')
  req.url = '/api/turn-notify/projection' + query
  return { req, res }
}

test('Given 快照请求到达 When 投影为空 Then 立即返回空投影与当前版本(无挂起形态)', async () => {
  const { ctx, routes } = makeCtx()
  apply(ctx)
  const { req, res } = projectionRequest('')
  await routes.get('/api/turn-notify/projection')(req, res)
  assert.equal(res.status, 200)
  assert.deepEqual(res.body.units, [])
  assert.equal(res.body.version, 0)
})

test('Given 事件 push When 快照与总线观测 Then 立即返回新投影且 publish 契约成立', async () => {
  const { ctx, routes, handlers, published } = makeCtx()
  apply(ctx)
  await disableDurationFilter(routes)
  const onEvent = handlers.get('session/event')
  onEvent(MAIN, { type: 'turn/start' })
  onEvent(MAIN, turnEnd('completed'))
  // 数据面:快照端点即时返回全量,无挂起
  const { req, res } = projectionRequest('')
  await routes.get('/api/turn-notify/projection')(req, res)
  assert.equal(res.status, 200)
  assert.equal(res.body.units.filter((unit) => unit.category === 'completed').length, 1)
  assert.ok(res.body.version > 0)
  // 通知面:事件 push 即发布总线变更(config POST 亦发,至少一条且无负载)
  assert.ok(published.length >= 1)
  for (const payload of published) assert.equal(payload, null)
})

test('Given cursor 落后当前版本 When 请求到达 Then 立即返回无需挂起', async () => {
  const { ctx, routes, handlers } = makeCtx()
  apply(ctx)
  await disableDurationFilter(routes)
  const onEvent = handlers.get('session/event')
  onEvent(MAIN, { type: 'turn/start' })
  onEvent(MAIN, turnEnd('completed'))
  const { req, res } = projectionRequest('?cursor=0')
  await routes.get('/api/turn-notify/projection')(req, res)
  assert.equal(res.status, 200)
  assert.equal(res.body.units.length, 1)
  assert.ok(res.body.version > 0)
})

const assistant = (tokens, text = '') => ({ type: 'assistant/message', data: {
  usage: { inputTokens: tokens, outputTokens: 0 }, message: { content: text ? [{ type: 'text', text }] : [] },
} })

for (const reason of ['completed', 'unknown']) {
  test(`F29 Given 被过滤或无通知的100tokens回合 When 无start结束下一200tokens回合 Then 不携带旧账或前缀(${reason})`, async () => {
    const { ctx, routes, handlers } = makeCtx()
    apply(ctx)
    const onEvent = handlers.get('session/event')
    onEvent(MAIN, { type: 'turn/start' })
    onEvent(MAIN, assistant(100, '旧回答'))
    onEvent(MAIN, turnEnd(reason))
    await disableDurationFilter(routes)
    onEvent(MAIN, assistant(200))
    onEvent(MAIN, turnEnd('completed'))
    const completed = (await projectionUnits(routes)).find(unit => unit.category === 'completed')
    assert.equal(completed.tokens, 200)
    assert.doesNotMatch(completed.summary, /旧回答/)
  })
}

test('F29 Given 回合内100tokens后即时ask When 再产生200tokens并结束 Then ask只读且最终合计300', async () => {
  const { ctx, routes, handlers } = makeCtx()
  apply(ctx)
  await disableDurationFilter(routes)
  const onEvent = handlers.get('session/event')
  onEvent(MAIN, { type: 'turn/start' })
  onEvent(MAIN, assistant(100, '本回合'))
  onEvent(MAIN, toolCall('ask_user_question'))
  onEvent(MAIN, assistant(200))
  onEvent(MAIN, turnEnd('completed'))
  const units = await projectionUnits(routes)
  assert.equal(units.find(unit => unit.category === 'ask').tokens, 100)
  assert.equal(units.find(unit => unit.category === 'completed').tokens, 300)
})

test('F29 Given 残余assistant账 When 新回合start后结束 Then start重置且无旧前缀', async () => {
  const { ctx, routes, handlers } = makeCtx()
  apply(ctx)
  await disableDurationFilter(routes)
  const onEvent = handlers.get('session/event')
  onEvent(MAIN, assistant(100, '旧前缀'))
  onEvent(MAIN, { type: 'turn/start' })
  onEvent(MAIN, assistant(200, '新前缀'))
  onEvent(MAIN, turnEnd('completed'))
  const unit = (await projectionUnits(routes))[0]
  assert.equal(unit.tokens, 200)
  assert.doesNotMatch(unit.summary, /旧前缀/)
})

test('Given 配置 POST 成功 When 观测总线 Then bump 发布变更契约成立', async () => {
  const { ctx, routes, published } = makeCtx()
  apply(ctx)
  const config = makeRes()
  await routes.get('/api/turn-notify/config')(makeReq('POST', { suppressSubagentWake: false }, JSON_HEADERS), config)
  assert.equal(config.status, 200)
  assert.deepEqual(published, [null], '配置变更应发布总线变更')
  assert.equal(config.body.suppressSubagentWake, false)
})
