// board v2 路由测试:查询投影/详情/中断(信封幂等/单任务停止/强制停止)/同源/405/413/500
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { createBoardApi } from '../lib/board.mjs'
import { createTask, defineWorkItem, authorizeTask, requestResume, confirmResume } from '../lib/core/task.mjs'
import { createGlobalControl } from '../lib/core/global-control.mjs'
import { gatedWrite } from './fixtures/write-gate.mjs'

let clock = 20_000
const now = () => { clock += 1; return clock }

async function makeStore() {
  const records = new Map()
  let control = createGlobalControl(now)
  let seeded = null
  {
    let agg = createTask({
      taskId: 't1', title: '任务一', projectWorkspaceId: 'ws1',
      definition: { goal: 'g', acceptanceCriteria: [{ criterionId: 'c1', text: '标准' }] }, now,
    }).result
    agg = defineWorkItem(agg, { workItemId: 'w1', title: '子项' }).result.aggregate
    seeded = authorizeTask(agg, { sourceMessageRef: { sessionId: 's', messageId: 'm' } }).result.aggregate
  }
  records.set('task/t1', seeded)
  records.set('taskIndex', { ids: ['t1'] })
  const store = {
    async loadAggregate(id) { return records.get(`task/${id}`) },
    async updateAggregate(id, update) { const next = update(records.get(`task/${id}`)); records.set(`task/${id}`, next); return next },
    async saveAggregate(agg) { records.set(`task/${agg.taskId}`, agg); return agg },
    async listAggregates() { return [...records.values()].filter((r) => r.taskId) },
    async loadControl() { return control },
    async updateControl(fn) { control = fn(control); return control },
    async loadAdminBinding() { return null },
  }
  return { store, records }
}

function jsonRes() {
  const r = { status: 0, headers: {}, raw: undefined, writeHead(s, headers = {}) { this.status = s; this.headers = headers }, end(b) { this.raw = b } }
  Object.defineProperty(r, 'payload', { get() { return JSON.parse(this.raw) } })
  return r
}

function streamReq({ method = 'GET', headers, url = '/api/boss-simulator/board', body }) {
  return {
    method, headers, url,
    on(event, cb) {
      if (event === 'data' && body !== undefined) cb(Buffer.from(body))
      if (event === 'end') cb()
    },
  }
}

const post = (payload, headers = { host: 'h', origin: 'http://h' }) => streamReq({ method: 'POST', headers, body: JSON.stringify(payload) })

test('Given 两项在途任务 When 全局停止 Then 每项先落停止代次再取消且只增一次epoch', async () => {
  const { store, records } = await makeStore()
  const first = await store.loadAggregate('t1')
  for (const [taskId, sessionId] of [['t1', 's1'], ['t2', 's2']]) records.set(`task/${taskId}`, { ...first, taskId, runs: { r1: { runId: 'r1', state: 'running', sessionId } } })
  const cancelled = []
  const api = createBoardApi({ store, drive: { sessionAdapter: {
    async inspectSession({ sessionId }) { return { running: !cancelled.includes(sessionId), pendingItemIds: [], stopped: cancelled.includes(sessionId) } },
    async cancelSession({ sessionId }) {
      const task = await store.loadAggregate(sessionId === 's1' ? 't1' : 't2')
      assert.equal(task.control.state, 'stopping')
      assert.equal(task.control.executionEpoch, 1)
      cancelled.push(sessionId)
      return { accepted: true }
    },
  } } })
  const response = jsonRes()
  await api.handleInterrupt(post({ global: true, commandId: 'stop-global' }), response)
  assert.equal(response.status, 200)
  assert.deepEqual(cancelled, ['s1', 's2'])
  assert.equal(response.payload.pendingStop, false)
  assert.equal((await store.loadAggregate('t1')).control.executionEpoch, 1)
})

// ── B6:全局停止可解除,不是一次性闩锁 ────────────────────────────────────────
test('POST interrupt 全局停止后可通过 global+resume 解除', async () => {
  const { store } = await makeStore()
  const api = createBoardApi({ store })
  const stopped = jsonRes()
  await api.handleInterrupt(post({ global: true, commandId: 'stop-b6' }), stopped)
  assert.equal(stopped.status, 200)
  assert.equal((await store.loadControl()).globalStopped, true)
  const resumed = jsonRes()
  await api.handleInterrupt(post({ global: true, resume: true, commandId: 'resume-b6' }), resumed)
  assert.equal(resumed.status, 200)
  assert.equal(resumed.payload.globalResumed, true)
  assert.equal(resumed.payload.globalStopped, false)
  assert.equal(resumed.payload.globalStopGeneration, stopped.payload.globalStopGeneration)
  assert.equal((await store.loadControl()).globalStopped, false)
  const replay = jsonRes()
  await api.handleInterrupt(post({ global: true, resume: true, commandId: 'resume-b6' }), replay)
  assert.equal(replay.payload.replayed, true)
  assert.equal(replay.payload.globalStopGeneration, resumed.payload.globalStopGeneration)
})

test('Given 全局停止后新增任务 When 重放旧全局命令 Then 新任务保持 active', async () => {
  const { store } = await makeStore()
  const api = createBoardApi({ store })
  const request = () => post({ global: true, commandId: 'stop-old' })
  await api.handleInterrupt(request(), jsonRes())
  const initial = await store.loadAggregate('t1')
  await store.saveAggregate({ ...initial, taskId: 't2', control: { ...initial.control, state: 'active', executionEpoch: 0, stopCommandIds: [] } })
  await api.handleInterrupt(request(), jsonRes())
  assert.equal((await store.loadAggregate('t2')).control.state, 'active')
  assert.equal((await store.loadAggregate('t2')).control.executionEpoch, 0)
})

test('GET board 返回查询投影(envelope+counts+items)', async () => {
  const { store } = await makeStore()
  const api = createBoardApi({ store })
  const r = jsonRes()
  await api.handleBoard(streamReq({ headers: { host: 'h' } }), r)
  assert.equal(r.status, 200)
  assert.equal(r.payload.counts.ready, 1)
  assert.equal(r.payload.items[0].taskId, 't1')
  assert.equal(typeof r.payload.envelope.serverEpoch, 'string')
})

// ── B8:HTTP 查询把 since/until 传进过滤,不再静默丢弃 ────────────────────────
test('GET board?since/until 按活跃期窗口过滤,非法时间 400', async () => {
  const { store, records } = await makeStore()
  const current = records.get('task/t1')
  records.set('task/t2', { ...current, taskId: 't2', title: '旧任务', createdAt: 1, updatedAt: 1 })
  const api = createBoardApi({ store })
  const sinceRes = jsonRes()
  await api.handleBoard(streamReq({ headers: { host: 'h' }, url: '/api/boss-simulator/board?since=1000' }), sinceRes)
  assert.equal(sinceRes.status, 200)
  assert.deepEqual(sinceRes.payload.items.map((item) => item.taskId), ['t1'])
  const untilRes = jsonRes()
  await api.handleBoard(streamReq({ headers: { host: 'h' }, url: '/api/boss-simulator/board?until=1000' }), untilRes)
  assert.deepEqual(untilRes.payload.items.map((item) => item.taskId), ['t2'])
  const badRes = jsonRes()
  await api.handleBoard(streamReq({ headers: { host: 'h' }, url: '/api/boss-simulator/board?since=abc' }), badRes)
  assert.equal(badRes.status, 400)
  assert.match(badRes.payload.error, /时间戳/)
})

test('GET board?taskId= 返回详情投影;缺失返回 404', async () => {
  const { store } = await makeStore()
  const api = createBoardApi({ store })
  const r = jsonRes()
  await api.handleBoard(streamReq({ headers: { host: 'h' }, url: '/api/boss-simulator/board?taskId=t1' }), r)
  assert.equal(r.status, 200)
  assert.equal(r.payload.workItems[0].workItemId, 'w1')
  const miss = jsonRes()
  await api.handleBoard(streamReq({ headers: { host: 'h' }, url: '/api/boss-simulator/board?taskId=nope' }), miss)
  assert.equal(miss.status, 404)
})

test('POST interrupt 全局停止:同 commandId 幂等,代次不重复提升', async () => {
  const { store } = await makeStore()
  const api = createBoardApi({ store })
  const body = { global: true, commandId: 'c1', payloadHash: 'p' }
  const first = jsonRes()
  await api.handleInterrupt(post(body), first)
  assert.equal(first.status, 200)
  assert.equal(first.payload.globalStopGeneration, 1)
  const retry = jsonRes()
  await api.handleInterrupt(post(body), retry)
  assert.equal(retry.payload.globalStopGeneration, 1)
  assert.equal(retry.payload.replayed, true)
})

test('POST interrupt 单任务:停止受理;再次明确点击产生新停止意图仍受理', async () => {
  const { store, records } = await makeStore()
  const api = createBoardApi({ store })
  const r = jsonRes()
  await api.handleInterrupt(post({ taskId: 't1', commandId: 's1' }), r)
  assert.equal(r.status, 200)
  assert.equal(r.payload.accepted, true)
  assert.equal(r.payload.controlState, 'paused')
  const again = jsonRes()
  await api.handleInterrupt(post({ taskId: 't1', commandId: 's2' }), again)
  assert.equal(again.status, 200)
  assert.equal(again.payload.controlState, 'paused')
  assert.notEqual(records.get('task/t1').control.state, undefined)
})

test('Given 会话不可达且停止未确认 When 面板强制停止 Then 需同源确认串且任务收敛为 paused', async () => {
  const { store, records } = await makeStore()
  const unreachable = { inspectSession: async () => { throw new Error('宿主接口超时') }, cancelSession: async () => { throw new Error('宿主接口超时') } }
  const first = await store.loadAggregate('t1')
  records.set('task/t1', { ...first, control: { ...first.control, state: 'stopping' }, runs: { r1: { runId: 'r1', workItemId: 'w1', state: 'running', sessionId: 's1' } } })
  const api = createBoardApi({ store, drive: { sessionAdapter: unreachable } })
  const missing = jsonRes()
  await api.handleInterrupt(post({ taskId: 't1', commandId: 'f0', confirm: 'force-stop' }), missing)
  assert.equal(missing.status, 400)
  assert.equal(missing.payload.code, 'CONFIRMATION_REQUIRED')
  const forced = jsonRes()
  await api.handleInterrupt(post({ taskId: 't1', commandId: 'f1', confirm: 'force-stop', confirmTaskId: 't1' }), forced)
  assert.equal(forced.status, 200)
  assert.equal(forced.payload.forceStopped, true)
  const settled = records.get('task/t1')
  assert.equal(settled.control.state, 'paused')
  assert.equal(settled.runs.r1.state, 'interrupted')
  assert.equal(settled.runs.r1.stopObserved, 'unreachable')
})

// ── W1:force-stop 同 commandId 幂等,异 payload 冲突 ─────────────────────────
test('W1: 强制停止同 commandId 重放不二次 pause,异 payload 409', async () => {
  const { store, records } = await makeStore()
  const api = createBoardApi({ store })
  const payload = { taskId: 't1', commandId: 'f-w1', confirm: 'force-stop', confirmTaskId: 't1' }
  const first = jsonRes()
  await api.handleInterrupt(post(payload), first)
  assert.equal(first.status, 200)
  const epoch = records.get('task/t1').control.executionEpoch
  const replay = jsonRes()
  await api.handleInterrupt(post(payload), replay)
  assert.equal(replay.status, 200)
  assert.equal(replay.payload.replayed, true)
  assert.equal(replay.payload.forceStopped, true)
  assert.equal(records.get('task/t1').control.executionEpoch, epoch, '重放不得再次 pause/提升 epoch')
  // 键序重排但语义相同:稳定指纹必须仍命中同一命令
  const reordered = jsonRes()
  await api.handleInterrupt(post({ confirmTaskId: 't1', confirm: 'force-stop', commandId: 'f-w1', taskId: 't1' }), reordered)
  assert.equal(reordered.status, 200)
  assert.equal(reordered.payload.replayed, true, '键序不应改变 payload 身份')
  assert.equal(records.get('task/t1').control.executionEpoch, epoch)
  // stop → resume → 同 commandId 重试:回执命中但按当前控制态回答
  const current = await store.loadAggregate('t1')
  const requested = requestResume(current, {
    resumeIntentId: 'ri-w1', sourceMessageRef: { sessionId: 'admin', messageId: 'm' },
    expectedExecutionEpoch: current.control.executionEpoch, globalStopGeneration: 0,
  })
  assert.ok(requested.ok, requested.message)
  await store.updateAggregate('t1', () => requested.result.aggregate)
  const confirmed = confirmResume(requested.result.aggregate, { resumeIntentId: 'ri-w1', globalStopGeneration: 0 })
  assert.ok(confirmed.ok, confirmed.message)
  await store.updateAggregate('t1', () => confirmed.result.aggregate)
  assert.equal((await store.loadAggregate('t1')).control.state, 'active')
  const afterResume = jsonRes()
  await api.handleInterrupt(post(payload), afterResume)
  assert.equal(afterResume.status, 200)
  assert.equal(afterResume.payload.replayed, true)
  assert.equal(afterResume.payload.controlState, 'active')
  assert.equal(afterResume.payload.forceStopped, false, '任务已恢复 active 时不得宣称已停')
  const conflict = jsonRes()
  await api.handleInterrupt(post({ ...payload, reason: 'different' }), conflict)
  assert.equal(conflict.status, 409)
  assert.equal(conflict.payload.code, 'IDEMPOTENCY_CONFLICT')
  assert.equal(records.get('task/t1').control.executionEpoch, epoch + 1)
})

// ── W1b:payloadHash 由服务端稳定计算,客户端字段不参与 ──────────────────────
test('W1b: 客户端 payloadHash 被忽略,空串不能绕过冲突,对象 hash 同内容仍 replay', async () => {
  const { store } = await makeStore()
  const api = createBoardApi({ store })
  const objectHash = { taskId: 't1', commandId: 'f-hash-object', confirm: 'force-stop', confirmTaskId: 't1', payloadHash: { nested: true } }
  const first = jsonRes()
  await api.handleInterrupt(post(objectHash), first)
  assert.equal(first.status, 200)
  const replay = jsonRes()
  await api.handleInterrupt(post(objectHash), replay)
  assert.equal(replay.status, 200)
  assert.equal(replay.payload.replayed, true, '同内容对象 hash 不应导致冲突')
  const emptyHash = { taskId: 't1', commandId: 'f-hash-empty', confirm: 'force-stop', confirmTaskId: 't1', payloadHash: '' }
  const accepted = jsonRes()
  await api.handleInterrupt(post(emptyHash), accepted)
  assert.equal(accepted.status, 200)
  const conflict = jsonRes()
  await api.handleInterrupt(post({ ...emptyHash, reason: 'different' }), conflict)
  assert.equal(conflict.status, 409)
  assert.equal(conflict.payload.code, 'IDEMPOTENCY_CONFLICT', '空串 hash 不得绕过不同内容冲突')
})

test('跨源写请求被同源比对拒绝;缺 commandId 400;413/500 语义保留', async () => {
  const { store } = await makeStore()
  const api = createBoardApi({ store })
  const cross = jsonRes()
  // 闸门在生产接线层(control.mjs 注册时 withRouteGate),此处按同一接线验证
  await gatedWrite(api.handleInterrupt)(streamReq({ method: 'POST', headers: { host: 'h', origin: 'http://evil' }, body: JSON.stringify({ global: true, commandId: 'x' }) }), cross)
  assert.equal(cross.status, 403)
  const noId = jsonRes()
  await api.handleInterrupt(post({ global: true }), noId)
  assert.equal(noId.status, 400)
  const big = jsonRes()
  await api.handleInterrupt(streamReq({ method: 'POST', headers: { host: 'h', 'content-length': String(65 * 1024) }, body: 'x' }), big)
  assert.equal(big.status, 413)
  const broken = createBoardApi({ store: { listAggregates: async () => { throw new Error('boom') }, loadControl: async () => { throw new Error('boom') }, loadAdminBinding: async () => { throw new Error('boom') } } })
  const r500 = jsonRes()
  await broken.handleBoard(streamReq({ headers: { host: 'h' } }), r500)
  assert.equal(r500.status, 500)
  assert.equal(r500.payload.error, 'boom')
  assert.ok(!r500.raw.includes('at '))
})

test('单任务停止对在途任务先进 stopping(pendingStop)', async () => {
  const { store, records } = await makeStore()
  // 注入在途 Run
  const agg = { ...records.get('task/t1'), runs: { r1: { runId: 'r1', workItemId: 'w1', phase: 'implement', state: 'running' } } }
  records.set('task/t1', agg)
  const api = createBoardApi({ store })
  const r = jsonRes()
  await api.handleInterrupt(post({ taskId: 't1', commandId: 's9' }), r)
  assert.equal(r.status, 200)
  assert.equal(r.payload.pendingStop, true)
  assert.equal(records.get('task/t1').control.state, 'stopping')
})

test('Given 方法不在白名单 When 访问路由 Then 405 并给出 Allow', async () => {
  const { store } = await makeStore()
  const api = createBoardApi({ store })
  const boardWrite = jsonRes()
  await api.handleBoard(post({}), boardWrite)
  assert.equal(boardWrite.status, 405)
  assert.equal(boardWrite.payload.code, 'METHOD_NOT_ALLOWED')
  assert.equal(boardWrite.headers.allow, 'GET')
  const interruptRead = jsonRes()
  await api.handleInterrupt(streamReq({ headers: { host: 'h' }, url: '/api/boss-simulator/interrupt' }), interruptRead)
  assert.equal(interruptRead.status, 405)
  assert.equal(interruptRead.headers.allow, 'POST')
  const adminRead = jsonRes()
  await api.handleAdmin(streamReq({ headers: { host: 'h' } }), adminRead)
  assert.equal(adminRead.status, 405)
  const settingsPut = jsonRes()
  await api.handleSettings(streamReq({ method: 'PUT', headers: { host: 'h' }, url: '/api/boss-simulator/settings' }), settingsPut)
  assert.equal(settingsPut.status, 405)
  assert.equal(settingsPut.headers.allow, 'GET, POST')
})

// ── R4 闸门:JSON content-type 精确 essence + 同源大小写不敏感 ─────────────────
test('Given application/jsonp When 过闸门写请求 Then 400(子串不算 JSON)', async () => {
  const { store } = await makeStore()
  const api = createBoardApi({ store })
  const res = jsonRes()
  await gatedWrite(api.handleInterrupt)(streamReq({ method: 'POST', headers: { host: 'h', origin: 'http://h', 'content-type': 'application/jsonp' }, body: JSON.stringify({ global: true, commandId: 'x' }) }), res)
  assert.equal(res.status, 400)
  assert.match(res.payload.error, /application\/json/)
})

test('Given Host 头大小写变形 When 过闸门写请求 Then 同源放行(比较大小写不敏感)', async () => {
  const { store } = await makeStore()
  const api = createBoardApi({ store })
  const res = jsonRes()
  await gatedWrite(api.handleInterrupt)(streamReq({ method: 'POST', headers: { host: 'LOCALHOST:3080', origin: 'http://localhost:3080', 'content-type': 'application/json' }, body: JSON.stringify({ global: true, commandId: 'case-1' }) }), res)
  assert.notEqual(res.status, 403, '同一主机的不同大小写不是跨源')
})

// ── R12/B5 chunked 与 content-length 超限:413 必须能送达,不销毁连接 ────────
test('Given 无 content-length 的 chunked 超限请求 When 写路由 Then 排空后回 413 且不销毁连接', async () => {
  const { store } = await makeStore()
  const api = createBoardApi({ store })
  let destroyed = false
  let resumed = false
  const res = jsonRes()
  const big = Buffer.alloc(65 * 1024, 0x78)
  const req = {
    method: 'POST',
    url: '/api/boss-simulator/interrupt',
    headers: { host: 'h', origin: 'http://h', 'content-type': 'application/json' },
    on(event, cb) {
      if (event === 'data') cb(big)
      if (event === 'end') cb()
    },
    resume() { resumed = true },
    destroy() { destroyed = true },
  }
  await api.handleInterrupt(req, res)
  assert.equal(res.status, 413, 'chunked 超限也要回 413,而不是断连')
  assert.equal(resumed, true, '超限须排空请求体,连接才能继续可用')
  assert.equal(destroyed, false, '销毁 socket 会让客户端收到 ECONNRESET 并丢掉 413')
})

test('Given 带 content-length 的超限请求 When 写路由 Then 413 可达且不复位连接', async () => {
  const { store } = await makeStore()
  const api = createBoardApi({ store })
  let destroyed = false
  let resumed = false
  const res = jsonRes()
  const req = {
    method: 'POST',
    url: '/api/boss-simulator/interrupt',
    headers: { host: 'h', origin: 'http://h', 'content-type': 'application/json', 'content-length': String(65 * 1024) },
    // 宣告长度即拒绝:客户端可能仍在写,不能读也不能复位,只能排空
    on() {},
    resume() { resumed = true },
    destroy() { destroyed = true },
  }
  await api.handleInterrupt(req, res)
  assert.equal(res.status, 413)
  assert.equal(resumed, true)
  assert.equal(destroyed, false)
})

test('Given 请求体是 JSON null When 写路由 Then 统一 400 而不是悬挂', async () => {
  const { store } = await makeStore()
  const api = createBoardApi({ store })
  const res = jsonRes()
  await api.handleInterrupt(streamReq({ method: 'POST', headers: { host: 'h' }, body: 'null' }), res)
  assert.equal(res.status, 400)
  assert.match(res.payload.error, /JSON 对象/)
  const arrayRes = jsonRes()
  await api.handleInterrupt(streamReq({ method: 'POST', headers: { host: 'h' }, body: '[]' }), arrayRes)
  assert.equal(arrayRes.status, 400)
})
