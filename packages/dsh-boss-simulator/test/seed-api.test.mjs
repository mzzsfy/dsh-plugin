import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createBoardApi } from '../lib/board.mjs'
import { makeSeedBoard } from './fixtures/seed-board.mjs'

test('Given multi-state filled records When API filters workspace Then counters describe all matching tasks', async () => {
  const fixture = makeSeedBoard()
  const api = createBoardApi({ store: { listAggregates: async () => fixture.tasks, loadControl: async () => fixture.globalControl, loadAdminBinding: async () => null }, now: () => 123 })
  const request = (url) => ({ method: 'GET', url, headers: {}, on() {} })
  const response = () => ({ writeHead(status) { this.status = status }, end(body) { this.body = body }, get json() { return JSON.parse(this.body) } })
  const res = response()
  await api.handleBoard(request('/api/boss-simulator/board?workspaceId=workspace-1'), res)
  assert.equal(res.json.counts.draft, 1)
  assert.ok(res.json.items.every((task) => task.projectWorkspaceId === 'workspace-1'))
})

test('Given filtered tasks When requesting board Then counts describe the full filtered result and workspace choices remain complete', async () => {
  const fixture = makeSeedBoard()
  const api = createBoardApi({ store: { listAggregates: async () => fixture.tasks, loadControl: async () => fixture.globalControl, loadAdminBinding: async () => null }, now: () => 123 })
  const res = { writeHead(status) { this.status = status }, end(body) { this.body = body } }
  await api.handleBoard({ method: 'GET', url: '/api/boss-simulator/board?search=fixture-running&limit=1', headers: {} }, res)
  const board = JSON.parse(res.body)
  assert.deepEqual(board.counts, { draft: 0, ready: 0, implementing: 1, awaiting_acceptance: 0, completed: 0, blocked: 0, cancelled: 0 })
  assert.deepEqual(board.workspaceIds, ['workspace-1', 'workspace-2', 'workspace-3'])
})

test('Given a one-task page When requesting model participation Then server returns full deduplicated task totals', async () => {
  const fixture = makeSeedBoard()
  const api = createBoardApi({ store: { listAggregates: async () => fixture.tasks, loadControl: async () => fixture.globalControl, loadAdminBinding: async () => null } })
  const res = { writeHead(status) { this.status = status }, end(body) { this.body = body } }
  await api.handleBoard({ method: 'GET', url: '/api/boss-simulator/board?limit=1', headers: {} }, res)
  const board = JSON.parse(res.body)
  assert.equal(board.items.length, 1)
  assert.equal(board.modelTasks.length, 1)
  assert.equal(board.modelTasks[0].model, 'orion')
  assert.equal(board.modelTasks[0].provider, null)
  assert.equal(board.modelTasks[0].taskCount, 10)
  assert.equal(board.modelTasks[0].tasks.length, 10)
})

test('Given repeated calls and multiple models When grouped Then each model counts a task only once', async () => {
  const fixture = makeSeedBoard()
  const aggregate = fixture.tasks.find((task) => task.taskId === 'fixture-running')
  aggregate.usageLedger.secondCall = { runId: 'run-implementation', model: 'orion', tokens: 1 }
  aggregate.usageLedger.otherModel = { runId: 'run-repair', model: 'nebula', tokens: 1 }
  const api = createBoardApi({ store: { listAggregates: async () => fixture.tasks, loadControl: async () => fixture.globalControl, loadAdminBinding: async () => null } })
  const res = { writeHead(status) { this.status = status }, end(body) { this.body = body } }
  await api.handleBoard({ method: 'GET', url: '/api/boss-simulator/board?limit=1', headers: {} }, res)
  const models = JSON.parse(res.body).modelTasks
  assert.deepEqual(models.map((group) => [group.model, group.taskCount]), [['nebula', 1], ['orion', 10]])
})

test('Given task fixture with active/interrupted runs When detail API projects it Then run interval and usage facts are retained', async () => {
  const fixture = makeSeedBoard()
  const api = createBoardApi({ store: { listAggregates: async () => fixture.tasks, loadControl: async () => fixture.globalControl, loadAdminBinding: async () => null }, now: () => 123 })
  const req = { method: 'GET', url: '/api/boss-simulator/board?taskId=fixture-running', headers: {}, on() {} }
  const res = { writeHead(status) { this.status = status }, end(body) { this.body = body } }
  await api.handleBoard(req, res)
  const detail = JSON.parse(res.body)
  assert.deepEqual(detail.runs.map((run) => [run.runId, run.phase, run.state, run.startedAt !== null]), [
    ['run-implementation', 'implement', 'settled', true], ['run-repair', 'fix', 'running', true],
  ])
  assert.equal(detail.usage.coverage, 'partial')
  assert.equal(detail.usage.tokenTotal, 4820)
})

test('Given usage ledger entries When projected Then run model attribution follows the ledger, not run fields', async () => {
  const fixture = makeSeedBoard()
  const api = createBoardApi({ store: { listAggregates: async () => fixture.tasks, loadControl: async () => fixture.globalControl, loadAdminBinding: async () => null }, now: () => 123 })
  const req = { method: 'GET', url: '/api/boss-simulator/board?taskId=fixture-implementing-2', headers: {}, on() {} }
  const res = { writeHead(status) { this.status = status }, end(body) { this.body = body } }
  await api.handleBoard(req, res)
  const detail = JSON.parse(res.body)
  const settled = detail.runs.find((run) => run.runId === 'run-implementation')
  const running = detail.runs.find((run) => run.runId === 'run-repair')
  const summaryRes = { writeHead(status) { this.status = status }, end(body) { this.body = body } }
  await api.handleBoard({ method: 'GET', url: '/api/boss-simulator/board', headers: {}, on() {} }, summaryRes)
  const summary = JSON.parse(summaryRes.body)
  const summaryModelRun = summary.items.find((task) => task.taskId === 'fixture-implementing-2').runs.find((run) => run.runId === 'run-implementation')
  assert.equal(summaryModelRun.actualModel, 'orion', '看板摘要也按 ledger 归因,模型任务视图可消费')
  assert.equal(settled.actualModel, 'orion', '详情投影 ledger 归因')
  assert.equal(running.actualModel, null, '无 ledger 条目不猜测')
  assert.equal(detail.runs.every((run) => run.provider === undefined && run.requestedModel === undefined), true, '无投机契约字段')
})

test('Given conflicting models in one run ledger When projected Then attribution stays unknown', async () => {
  const fixture = makeSeedBoard()
  const aggregate = fixture.tasks.find((task) => task.taskId === 'fixture-implementing-2')
  aggregate.usageLedger['invocation-conflict'] = { runId: 'run-implementation', model: 'nebula', tokens: 1 }
  const api = createBoardApi({ store: { listAggregates: async () => fixture.tasks, loadControl: async () => fixture.globalControl, loadAdminBinding: async () => null }, now: () => 123 })
  const req = { method: 'GET', url: '/api/boss-simulator/board?taskId=fixture-implementing-2', headers: {}, on() {} }
  const res = { writeHead(status) { this.status = status }, end(body) { this.body = body } }
  await api.handleBoard(req, res)
  assert.equal(JSON.parse(res.body).runs.find((run) => run.runId === 'run-implementation').actualModel, null)
})
