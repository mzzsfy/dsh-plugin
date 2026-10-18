// board v2 路由测试:查询投影/详情/中断(信封幂等/单任务停止)/同源/413/500
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { createBoardApi } from '../lib/board.mjs'
import { createTask, defineWorkItem, authorizeTask, stopTask } from '../lib/core/task.mjs'
import { createGlobalControl, stopAll } from '../lib/core/global-control.mjs'

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
  const r = { status: 0, raw: undefined, writeHead(s) { this.status = s }, end(b) { this.raw = b } }
  Object.defineProperty(r, 'payload', { get() { return JSON.parse(this.raw) } })
  return r
}

function streamReq({ method, headers, url = '/api/boss-simulator/board', body }) {
  return {
    method, headers, url,
    on(event, cb) {
      if (event === 'data' && body !== undefined) cb(Buffer.from(body))
      if (event === 'end') cb()
    },
  }
}

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
  await api.handleInterrupt(streamReq({ headers: { host: 'h' }, body: JSON.stringify({ global: true, commandId: 'stop-global' }) }), response)
  assert.equal(response.status, 200)
  assert.deepEqual(cancelled, ['s1', 's2'])
  assert.equal(response.payload.pendingStop, false)
  assert.equal((await store.loadAggregate('t1')).control.executionEpoch, 1)
})

test('Given 全局停止后新增任务 When 重放旧全局命令 Then 新任务保持 active', async () => {
  const { store } = await makeStore()
  const api = createBoardApi({ store })
  const request = () => streamReq({ headers: { host: 'h' }, body: JSON.stringify({ global: true, commandId: 'stop-old' }) })
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
  const body = JSON.stringify({ global: true, commandId: 'c1', payloadHash: 'p' })
  const first = jsonRes()
  await api.handleInterrupt(streamReq({ headers: { host: 'h', origin: 'http://h' }, body }), first)
  assert.equal(first.status, 200)
  assert.equal(first.payload.globalStopGeneration, 1)
  const retry = jsonRes()
  await api.handleInterrupt(streamReq({ headers: { host: 'h', origin: 'http://h' }, body }), retry)
  assert.equal(retry.payload.globalStopGeneration, 1)
  assert.equal(retry.payload.replayed, true)
})

test('POST interrupt 单任务:停止受理;再次明确点击产生新停止意图仍受理', async () => {
  const { store, records } = await makeStore()
  const api = createBoardApi({ store })
  const r = jsonRes()
  await api.handleInterrupt(streamReq({
    headers: { host: 'h', origin: 'http://h' },
    body: JSON.stringify({ taskId: 't1', commandId: 's1' }),
  }), r)
  assert.equal(r.status, 200)
  assert.equal(r.payload.accepted, true)
  assert.equal(r.payload.controlState, 'paused')
  const again = jsonRes()
  await api.handleInterrupt(streamReq({
    headers: { host: 'h', origin: 'http://h' },
    body: JSON.stringify({ taskId: 't1', commandId: 's2' }),
  }), again)
  assert.equal(again.status, 200)
  assert.equal(again.payload.controlState, 'paused')
  assert.notEqual(records.get('task/t1').control.state, undefined)
})

test('跨源写请求被同源比对拒绝;缺 commandId 400;413/500 语义保留', async () => {
  const { store } = await makeStore()
  const api = createBoardApi({ store })
  const cross = jsonRes()
  await api.handleInterrupt(streamReq({ headers: { host: 'h', origin: 'http://evil' }, body: JSON.stringify({ global: true, commandId: 'x' }) }), cross)
  assert.equal(cross.status, 403)
  const noId = jsonRes()
  await api.handleInterrupt(streamReq({ headers: { host: 'h', origin: 'http://h' }, body: JSON.stringify({ global: true }) }), noId)
  assert.equal(noId.status, 400)
  const big = jsonRes()
  await api.handleInterrupt(streamReq({ headers: { host: 'h', 'content-length': String(65 * 1024) }, body: 'x' }), big)
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
  await api.handleInterrupt(streamReq({
    headers: { host: 'h', origin: 'http://h' },
    body: JSON.stringify({ taskId: 't1', commandId: 's9' }),
  }), r)
  assert.equal(r.status, 200)
  assert.equal(r.payload.pendingStop, true)
  assert.equal(records.get('task/t1').control.state, 'stopping')
})
