// 人类操作入口契约:创建/授权/派发由 HTTP 面直达,与管理员工具共用同一 core 状态机。
// 安全边界按全仓库约定:不做 host 认证;写路由跨源防护以 Origin 同源比对为上限。
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { createTaskApi } from '../lib/task-api.mjs'
import { createTask, defineWorkItem, authorizeTask } from '../lib/core/task.mjs'
import { interruptTask } from '../lib/core/orchestrator.mjs'
import { createGlobalControl } from '../lib/core/global-control.mjs'
import { gatedWrite } from './fixtures/write-gate.mjs'

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
    async deleteAggregate(taskId) { return records.delete(`task/${taskId}`) },
    async listAggregates() { return [...records.values()].filter((record) => record.taskId) },
    async loadControl() { return control },
    async updateControl(fn) { control = fn(control); return control },
  }
}

function jsonRes() {
  const res = { status: 0, headers: {}, raw: undefined, writeHead(status, headers = {}) { this.status = status; this.headers = headers }, end(body) { this.raw = body } }
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

// gated=true 时走生产接线(withRouteGate):跨源/JSON content-type 闸门只在该层验证
async function post(api, payload, options = {}) {
  const res = jsonRes()
  const headers = { host: '127.0.0.1:3080', ...options.headers }
  if (options.gated) headers['content-type'] ??= 'application/json'
  const handler = options.gated ? gatedWrite(api.handleTask) : api.handleTask
  await handler(streamReq({ headers, body: JSON.stringify(payload) }), res)
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
  // 闸门在生产接线层(withRouteGate),此处用同一包装验证跨源拒绝
  const api = makeApi(store)
  const res = await post(api, createPayload(), { headers: { host: '127.0.0.1:3080', origin: 'http://evil.example' }, gated: true })
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
  const res = await post(makeApi(store), { action: 'nuke', taskId: 'task-alpha' })
  assert.equal(res.status, 400)
  assert.match(res.payload.error, /create/)
})

test('Given 任务无在飞 Run When 删除 Then 须显式确认后才移除记录', async () => {
  const store = makeStore()
  const api = makeApi(store)
  await post(api, createPayload())
  const unconfirmed = await post(api, { action: 'delete', taskId: 'task-alpha' })
  assert.equal(unconfirmed.status, 400)
  assert.equal(unconfirmed.payload.code, 'CONFIRMATION_REQUIRED')
  assert.ok(await store.loadAggregate('task-alpha'))
  const removed = await post(api, { action: 'delete', taskId: 'task-alpha', confirm: 'delete' })
  assert.equal(removed.status, 200)
  assert.equal(removed.payload.deleted, true)
  assert.equal(await store.loadAggregate('task-alpha'), undefined)
})

test('Given 任务存在未核清 Run When 删除 Then 拒绝;失联 Run 收敛后允许删除', async () => {
  const store = makeStore()
  const api = makeApi(store)
  await post(api, createPayload())
  const aggregate = await store.loadAggregate('task-alpha')
  store.records.set('task/task-alpha', { ...aggregate, runs: { 'run-1': { runId: 'run-1', workItemId: 'w1', phase: 'implement', actorRole: 'executor', state: 'running', sessionId: 's-1' } } })
  const blocked = await post(api, { action: 'delete', taskId: 'task-alpha', confirm: 'delete' })
  assert.equal(blocked.status, 409)
  assert.equal(blocked.payload.code, 'EXECUTION_STILL_ACTIVE')
  const stale = { ...aggregate, runs: { 'run-1': { runId: 'run-1', workItemId: 'w1', phase: 'implement', actorRole: 'executor', state: 'running', sessionId: 's-1', recordedAt: now() - 24 * 60 * 60 * 1000 } } }
  store.records.set('task/task-alpha', stale)
  const removed = await post(api, { action: 'delete', taskId: 'task-alpha', confirm: 'delete' })
  assert.equal(removed.status, 200)
  assert.equal(await store.loadAggregate('task-alpha'), undefined)
})

test('Given 在飞 Run 的会话被宿主删除 When 停止核对后删除 Then 收敛并允许删除', async () => {
  const store = makeStore()
  const api = makeApi(store)
  await post(api, createPayload())
  const aggregate = await store.loadAggregate('task-alpha')
  store.records.set('task/task-alpha', { ...aggregate, runs: { 'run-1': { runId: 'run-1', workItemId: 'w1', phase: 'implement', actorRole: 'executor', state: 'running', sessionId: 's-gone', requestId: 'req-1', recordedAt: now() } } })
  const gone = { inspectSession: async () => { throw Object.assign(new Error('session not found'), { code: 'SESSION_NOT_FOUND' }) }, cancelSession: async () => { throw new Error('不应调用') } }
  const interrupted = await interruptTask(store, await store.loadAggregate('task-alpha'), { sessionAdapter: gone })
  assert.equal(interrupted.stopConfirmed, true)
  assert.equal((await store.loadAggregate('task-alpha')).runs['run-1'].state, 'interrupted')
  const removed = await post(api, { action: 'delete', taskId: 'task-alpha', confirm: 'delete' })
  assert.equal(removed.status, 200)
  assert.equal(await store.loadAggregate('task-alpha'), undefined)
})

test('Given 任务不存在 When 删除 Then 404', async () => {
  const res = await post(makeApi(makeStore()), { action: 'delete', taskId: 'task-missing', confirm: 'delete' })
  assert.equal(res.status, 404)
  assert.equal(res.payload.code, 'NOT_FOUND')
})

test('Given 方法不在白名单 When 访问任务与工作区路由 Then 405 并给出 Allow', async () => {
  const api = makeApi(makeStore())
  const readTask = jsonRes()
  await api.handleTask({ method: 'GET', headers: { host: 'h' }, url: '/api/boss-simulator/task' }, readTask)
  assert.equal(readTask.status, 405)
  assert.equal(readTask.headers.allow, 'POST')
  const writeWorkspaces = jsonRes()
  await api.handleWorkspaces({ method: 'POST', headers: { host: 'h' }, url: '/api/boss-simulator/workspaces' }, writeWorkspaces)
  assert.equal(writeWorkspaces.status, 405)
  assert.equal(writeWorkspaces.headers.allow, 'GET')
})

// ── B4:未指定子项时由服务端给推进目标(不盲取第一个子项) ──────────────────────
// ── R2-W3:显式 workItemId 的缺省 phase 与 nextDispatch 同源(已有产物→fix) ──────
test('Given 显式子项已有实施产物 When 未带 phase 派发 Then 按派生状态转 fix', async () => {
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
  await store.updateAggregate('task-alpha', (current) => defineWorkItem(current, { workItemId: 'w2', title: '交付项', requiredCriterionIds: ['c1', 'c2'] }).result.aggregate)
  const runRecord = (current, runId, workItemId, phase, actorRole, sessionId, artifactRevision) => ({
    runId, workItemId, phase, actorRole, attemptOrdinal: 1,
    definitionRevision: current.definitionRevision, executionEpoch: current.control.executionEpoch, globalStopGeneration: 0,
    executionSlot: `${current.taskId}/${workItemId}/${phase}`, sessionId, requestId: `req-${runId}`,
    artifactRevision, requiredCriterionIds: current.workItems[workItemId].requiredCriterionIds,
    state: 'settled', executionTreeSettled: true, recordedAt: now(), lastEventAt: now(),
    startedAt: now(), endedAt: now(), tokenTotal: null, usageCoverage: 'unknown', knownTokenTotal: 0,
  })
  const reportRecord = (current, reportId, runId, verdict) => ({
    reportId, taskId: current.taskId, workItemId: 'w2', runId, summary: '结果',
    definitionRevision: current.definitionRevision, artifactRevision: 1, verdict,
    coveredCriterionIds: ['c1', 'c2'], issues: verdict === 'issues' ? ['缺陷'] : [], evidence: ['e'],
    historical: false, createdAt: now(),
  })
  // w2 已交付并被验收驳回(artifactRevision=1),w1 从未实施:nextDispatch 指向 w1 implement
  await store.updateAggregate('task-alpha', (current) => ({
    ...current,
    businessState: 'implementing',
    runs: {
      'impl-w2': runRecord(current, 'impl-w2', 'w2', 'implement', 'executor', 's-impl', 1),
      'rev-w2': runRecord(current, 'rev-w2', 'w2', 'accept', 'reviewer', 's-review', 1),
    },
    reports: {
      'rep-ready': reportRecord(current, 'rep-ready', 'impl-w2', 'ready_for_review'),
      'rep-issues': reportRecord(current, 'rep-issues', 'rev-w2', 'issues'),
    },
  }))
  const res = await post(api, { action: 'dispatch', taskId: 'task-alpha', workItemId: 'w2', content: '修复驳回项' })
  assert.equal(res.status, 200)
  const saved = await store.loadAggregate('task-alpha')
  const run = saved.runs[res.payload.runId]
  assert.equal(run.workItemId, 'w2')
  assert.equal(run.phase, 'fix', '显式 workItemId 缺省阶段须按已有产物代次给 fix')
  assert.deepEqual(dispatched, [['task-alpha', run.sessionId]])
})

test('Given 子项已交付待验收 When 未指定 workItemId 派发 Then 服务端选择验收而不是重复实施', async () => {
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
  const base = await store.loadAggregate('task-alpha')
  const reviewReport = (current) => ({
    reportId: 'rep1', taskId: 'task-alpha', workItemId: 'w1', runId: 'impl', summary: '交付',
    definitionRevision: current.definitionRevision, artifactRevision: 1, verdict: 'ready_for_review',
    coveredCriterionIds: ['c1', 'c2'], issues: [], evidence: ['e'], historical: false, createdAt: now(),
  })
  await store.updateAggregate('task-alpha', (current) => ({
    ...current,
    businessState: 'awaiting_acceptance',
    runs: {
      impl: {
        runId: 'impl', workItemId: 'w1', phase: 'implement', actorRole: 'executor', attemptOrdinal: 1,
        definitionRevision: base.definitionRevision, executionEpoch: base.control.executionEpoch, globalStopGeneration: 0,
        executionSlot: 'task-alpha/w1/implement', sessionId: 's-impl', requestId: 'req-impl', artifactRevision: 1,
        state: 'settled', executionTreeSettled: true, startedAt: now(), endedAt: now(),
        tokenTotal: null, usageCoverage: 'unknown', knownTokenTotal: 0,
      },
    },
    reports: { rep1: reviewReport(current) },
  }))
  const res = await post(api, { action: 'dispatch', taskId: 'task-alpha', content: '验收交付物' })
  assert.equal(res.status, 200)
  const saved = await store.loadAggregate('task-alpha')
  const run = saved.runs[res.payload.runId]
  assert.equal(run.workItemId, 'w1')
  assert.equal(run.phase, 'accept', '已交付待验收的子项应派验收而不是重复实施')
  assert.equal(run.actorRole, 'reviewer')
  assert.equal(run.artifactRevision, 1)
  assert.deepEqual(dispatched, [['task-alpha', run.sessionId]])
})
