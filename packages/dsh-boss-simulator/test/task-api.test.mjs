// 人类操作入口契约:创建/授权/派发由 HTTP 面直达,与管理员工具共用同一 core 状态机。
// 安全边界按全仓库约定:不做 host 认证;写路由跨源防护以 Origin 同源比对为上限。
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { createTaskApi } from '../lib/task-api.mjs'
import { createTask, defineWorkItem, authorizeTask } from '../lib/core/task.mjs'
import { createGlobalControl } from '../lib/core/global-control.mjs'

let clock = 30_000
const now = () => { clock += 1; return clock }

function makeStore() {
  const records = new Map()
  let control = createGlobalControl(now)
  return {
    records,
    async loadAggregate(id) { return records.get(`task/${id}`) },
    async updateAggregate(id, update) {
      const current = records.get(`task/${id}`)
      if (current === undefined) throw new Error(`missing key: task/${id}`)
      const next = update(current)
      records.set(`task/${id}`, next)
      return next
    },
    async saveAggregate(agg) { records.set(`task/${agg.taskId}`, agg); return agg },
    async listAggregates() { return [...records.values()].filter((record) => record.taskId) },
    async loadControl() { return control },
    async updateControl(fn) { control = fn(control); return control },
  }
}

function jsonRes() {
  const res = { status: 0, raw: undefined, writeHead(status) { this.status = status }, end(body) { this.raw = body } }
  Object.defineProperty(res, 'payload', { get() { return JSON.parse(this.raw) } })
  return res
}

function streamReq({ headers = { host: '127.0.0.1:3080' }, body }) {
  return {
    method: 'POST', headers, url: '/api/boss-simulator/task',
    on(event, cb) {
      if (event === 'data' && body !== undefined) cb(Buffer.from(body))
      if (event === 'end') cb()
    },
  }
}

function makeApi(store, overrides = {}) {
  return createTaskApi({
    store,
    drive: { sessionAdapter: null, withExecution: (action) => action(), ...overrides.drive },
    listWorkspaces: overrides.listWorkspaces ?? (() => []),
    now,
  })
}

async function post(api, payload, options = {}) {
  const res = jsonRes()
  await api.handleTask(streamReq({ headers: options.headers, body: JSON.stringify(payload) }), res)
  return res
}

const createPayload = (overrides = {}) => ({
  action: 'create',
  taskId: 'task-alpha',
  title: '核对结算重试',
  goal: '确认重试是否会重复扣款',
  scope: '结算服务',
  workspaceId: 'ws-alpha',
  acceptanceCriteria: ['给出重试链路结论', '附回归用例'],
  ...overrides,
})

test('Given 无任务 When 提交创建 Then 落草稿并自动建工作项且验收标准有稳定标识', async () => {
  const store = makeStore()
  const res = await post(makeApi(store), createPayload())
  assert.equal(res.status, 201)
  assert.equal(res.payload.businessState, 'draft')
  const saved = await store.loadAggregate('task-alpha')
  assert.equal(saved.title, '核对结算重试')
  assert.equal(saved.businessState, 'draft')
  assert.deepEqual(saved.definition.acceptanceCriteria, [
    { criterionId: 'c1', text: '给出重试链路结论' },
    { criterionId: 'c2', text: '附回归用例' },
  ])
  assert.deepEqual(Object.keys(saved.workItems), ['w1'])
  assert.deepEqual(saved.workItems.w1.requiredCriterionIds, ['c1', 'c2'])
  assert.equal(saved.authorization, null)
})

test('Given 同 taskId 已存在 When 再次创建 Then 冲突且不改写已有任务', async () => {
  const store = makeStore()
  const api = makeApi(store)
  await post(api, createPayload())
  const res = await post(api, createPayload({ title: '覆盖尝试' }))
  assert.equal(res.status, 409)
  assert.equal((await store.loadAggregate('task-alpha')).title, '核对结算重试')
})

test('Given 字段缺失 When 创建 Then 400 且不落存储', async () => {
  const store = makeStore()
  const res = await post(makeApi(store), createPayload({ goal: '' }))
  assert.equal(res.status, 400)
  assert.equal(await store.loadAggregate('task-alpha'), undefined)
})

test('Given 草稿任务 When 授权 Then 进入已授权且重复授权不改写', async () => {
  const store = makeStore()
  const api = makeApi(store)
  await post(api, createPayload())
  const first = await post(api, { action: 'authorize', taskId: 'task-alpha', commandId: 'cmd-1' })
  assert.equal(first.status, 200)
  assert.equal(first.payload.businessState, 'ready')
  const authorized = await store.loadAggregate('task-alpha')
  assert.equal(authorized.authorization.definitionRevision, authorized.definitionRevision)
  const revision = authorized.recordRevision
  const second = await post(api, { action: 'authorize', taskId: 'task-alpha', commandId: 'cmd-2' })
  assert.equal(second.status, 200)
  assert.equal((await store.loadAggregate('task-alpha')).recordRevision, revision)
})

test('Given 任务不存在 When 授权 Then 404 而不是 500/409', async () => {
  const res = await post(makeApi(makeStore()), { action: 'authorize', taskId: 'task-missing' })
  assert.equal(res.status, 404)
  assert.equal(res.payload.code, 'NOT_FOUND')
})

test('Given 未授权任务 When 派发 Then 拒绝并保留无 Run', async () => {
  const store = makeStore()
  const api = makeApi(store)
  await post(api, createPayload())
  const res = await post(api, { action: 'dispatch', taskId: 'task-alpha', workItemId: 'w1', content: '开始吧' })
  assert.equal(res.status, 409)
  assert.match(res.payload.error, /授权/)
  assert.deepEqual((await store.loadAggregate('task-alpha')).runs, {})
})

test('Given 已授权但会话适配缺失 When 派发 Then 501 说明未装配', async () => {
  const store = makeStore()
  const api = makeApi(store)
  await post(api, createPayload())
  await post(api, { action: 'authorize', taskId: 'task-alpha', commandId: 'cmd-1' })
  const res = await post(api, { action: 'dispatch', taskId: 'task-alpha', workItemId: 'w1', content: '开始吧' })
  assert.equal(res.status, 501)
  assert.match(res.payload.error, /会话适配/)
})

test('Given 跨源 Origin When 创建 Then 403 且不落存储', async () => {
  const store = makeStore()
  const res = await post(makeApi(store), createPayload(), { headers: { host: '127.0.0.1:3080', origin: 'http://evil.example' } })
  assert.equal(res.status, 403)
  assert.equal(await store.loadAggregate('task-alpha'), undefined)
})

test('Given 请求体超限 When 创建 Then 413', async () => {
  const store = makeStore()
  const res = await post(makeApi(store), createPayload({ goal: 'x'.repeat(70 * 1024) }))
  assert.equal(res.status, 413)
})

test('Given 宿主工作区注册表可用 When 读取工作区 Then 返回可选目录', async () => {
  const api = makeApi(makeStore(), {
    listWorkspaces: () => [{ workspaceId: 'ws-host', title: 'dsh-plugin', path: 'C:/repo' }],
  })
  const res = jsonRes()
  await api.handleWorkspaces({}, res)
  assert.equal(res.status, 200)
  assert.deepEqual(res.payload.items, [{ workspaceId: 'ws-host', title: 'dsh-plugin', path: 'C:/repo' }])
})

test('Given 注册表不可用 When 读取工作区 Then 回落到已有任务的工作区标识', async () => {
  const store = makeStore()
  const aggregate = createTask({
    taskId: 't-legacy', title: '既有任务', projectWorkspaceId: 'ws-legacy',
    definition: { goal: 'g' }, now,
  }).result
  store.records.set('task/t-legacy', defineWorkItem(aggregate, { workItemId: 'w1', title: '子项' }).result.aggregate)
  const res = jsonRes()
  await makeApi(store).handleWorkspaces({}, res)
  assert.equal(res.status, 200)
  assert.deepEqual(res.payload.items, [{ workspaceId: 'ws-legacy', title: 'ws-legacy', path: null }])
})

test('Given 已授权任务 When 派发 Then 交给 Run 服务并返回会话标识', async () => {
  const store = makeStore()
  const dispatched = []
  const api = makeApi(store, {
    drive: {
      sessionAdapter: {
        async ensureSession({ sessionId }) { return { sessionId } },
        async dispatchPrompt() { return { accepted: true } },
      },
      followRuns: (taskId, sessionId) => dispatched.push([taskId, sessionId]),
    },
  })
  await post(api, createPayload())
  await post(api, { action: 'authorize', taskId: 'task-alpha', commandId: 'cmd-1' })
  const res = await post(api, { action: 'dispatch', taskId: 'task-alpha', workItemId: 'w1', content: '开始吧', runId: 'run-1', requestId: 'req-1' })
  assert.equal(res.status, 200)
  assert.equal(res.payload.runId, 'run-1')
  const saved = await store.loadAggregate('task-alpha')
  assert.equal(saved.runs['run-1'].state, 'submitted')
  assert.deepEqual(dispatched, [['task-alpha', saved.runs['run-1'].sessionId]])
})

test('Given 未知 action When 提交 Then 400 列出允许动作', async () => {
  const store = makeStore()
  const res = await post(makeApi(store), { action: 'delete', taskId: 'task-alpha' })
  assert.equal(res.status, 400)
  assert.match(res.payload.error, /create/)
})
