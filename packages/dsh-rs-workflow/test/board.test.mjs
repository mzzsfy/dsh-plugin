// board 路由 + report 工具 + 角色分发测试。
// 数据目录经 env 注入临时路径,须在 import lib/index.js 之前设置(单例 store 首次调用时解析)。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const tempDir = await mkdtemp(join(tmpdir(), 'rsww-board-'))
process.env.DSH_RS_WORKFLOW_DATA_DIR = tempDir

const { apply, reportStore } = await import('../lib/index.js')

test.after(async () => {
  delete process.env.DSH_RS_WORKFLOW_DATA_DIR
  await rm(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
})

function makeCtx() {
  const routes = new Map()
  const tools = []
  const ctx = {
    get() { return undefined },
    effect(fn) { fn() },
    inject(deps, fn) {
      fn({
        settings: { register() {} },
        tools: { register(def) { tools.push(def) } },
        webServer: { register(route) { routes.set(route.path, route.handler) } },
        effect(fn) { fn() },
      })
    },
    webServer: { register(route) { routes.set(route.path, route.handler) } },
  }
  return { ctx, routes, tools }
}

function makeReq(method, { url, origin, contentType, body } = {}) {
  const req = new EventEmitter()
  req.method = method
  req.headers = { host: 'localhost:3000' }
  if (url !== undefined) req.url = url
  if (origin !== undefined) req.headers.origin = origin
  if (contentType !== undefined) req.headers['content-type'] = contentType
  if (body !== undefined) {
    process.nextTick(() => {
      req.emit('data', Buffer.from(typeof body === 'string' ? body : JSON.stringify(body)))
      req.emit('end')
    })
  }
  return req
}

async function callRoute(routes, path, req) {
  const res = { status: null, payload: null }
  res.writeHead = (status) => { res.status = status }
  res.end = (text) => {
    res.raw = text
    try { res.payload = JSON.parse(text) } catch { res.payload = null }
  }
  await routes.get(path)(req, res)
  return res
}

test('角色分发:board 角色注册看板路由;settings/tool 角色不注册', () => {
  const board = makeCtx()
  apply(board.ctx, { role: 'board' })
  assert.deepEqual([...board.routes.keys()], ['/api/rs-workflow/runs', '/api/rs-workflow/run', '/api/rs-workflow/remove'])

  const settings = makeCtx()
  apply(settings.ctx, { role: 'settings' })
  assert.equal(settings.routes.size, 0)
  assert.equal(settings.tools.length, 0)

  const tool = makeCtx()
  apply(tool.ctx, { role: 'tool' })
  assert.deepEqual(tool.tools.map((def) => def.name), ['rs_workflow_config'], 'tool 角色只注册配置工具')
})

test('report 角色:注册 rs_workflow_report,不连坐 rs_workflow_config', () => {
  const { ctx, tools } = makeCtx()
  apply(ctx, { role: 'report' })
  assert.deepEqual(tools.map((def) => def.name), ['rs_workflow_report'])
})

test('report 工具:start→node→finish→list 全链(exec.agent 缺失回退会话目录)', async () => {
  const { ctx, tools } = makeCtx()
  apply(ctx, { role: 'report' })
  const tool = tools[0]
  const started = await tool.execute({ action: 'start', request: '做一个功能' }, {})
  assert.equal(started.ok, true)
  const runId = started.runId
  const node = await tool.execute({ action: 'node', runId, nodeId: 't1', status: 'done', summary: '第一步完成' }, {})
  assert.equal(node.ok, true)
  const finished = await tool.execute({
    action: 'finish', runId, ok: true, summary: '全部通过',
    result: { templateId: 'step-review', ok: true, tasks: [{ id: 't1' }], reviews: [{ id: 'r-t1' }], changedFiles: ['a.js'], escalations: 0 },
  }, {})
  assert.equal(finished.ok, true)
  assert.equal(finished.run.status, 'done')
  const listed = await tool.execute({ action: 'list' }, {})
  assert.equal(listed.runs.length, 1, 'list 只看本工作区')
  assert.equal(listed.runs[0].runId, runId)
  const got = await tool.execute({ action: 'get', runId }, {})
  assert.equal(got.ok, true)
  assert.equal(got.run.stats.tasks, 1)
  const missing = await tool.execute({ action: 'get', runId: 'nope' }, {})
  assert.equal(missing.ok, false)
  assert.match(missing.error, /运行记录不存在/)
})

test('看板路由:runs/run/remove 全链 + 写守卫(跨源/非 JSON/405)', async () => {
  const { ctx, routes } = makeCtx()
  apply(ctx, { role: 'board' })
  const store = reportStore()
  const run = await store.start({ request: '路由链路需求', workspace: 'C:/ws/x' })

  const listed = await callRoute(routes, '/api/rs-workflow/runs', makeReq('GET', { url: '/api/rs-workflow/runs' }))
  assert.equal(listed.status, 200)
  const row = listed.payload.runs.find((item) => item.runId === run.runId)
  assert.ok(row, '列表包含本次运行')
  assert.equal(row.result, undefined, '列表不带重量级 body')

  const detail = await callRoute(routes, '/api/rs-workflow/run', makeReq('GET', { url: '/api/rs-workflow/run?id=' + run.runId }))
  assert.equal(detail.status, 200)
  assert.equal(detail.payload.runId, run.runId)

  const notFound = await callRoute(routes, '/api/rs-workflow/run', makeReq('GET', { url: '/api/rs-workflow/run?id=ghost' }))
  assert.equal(notFound.status, 400)
  assert.match(notFound.payload.error, /运行记录不存在/)

  const cross = await callRoute(routes, '/api/rs-workflow/remove', makeReq('POST', {
    url: '/api/rs-workflow/remove', origin: 'http://evil.example', contentType: 'application/json', body: { runId: run.runId },
  }))
  assert.equal(cross.status, 403)

  const nonJson = await callRoute(routes, '/api/rs-workflow/remove', makeReq('POST', {
    url: '/api/rs-workflow/remove', origin: 'http://localhost:3000', contentType: 'text/plain', body: 'x',
  }))
  assert.equal(nonJson.status, 400)

  const getOnPost = await callRoute(routes, '/api/rs-workflow/remove', makeReq('GET', { url: '/api/rs-workflow/remove' }))
  assert.equal(getOnPost.status, 405)

  const removed = await callRoute(routes, '/api/rs-workflow/remove', makeReq('POST', {
    url: '/api/rs-workflow/remove', origin: 'http://localhost:3000', contentType: 'application/json', body: { runId: run.runId },
  }))
  assert.equal(removed.status, 200)
  assert.equal(await store.get(run.runId), null)
})
