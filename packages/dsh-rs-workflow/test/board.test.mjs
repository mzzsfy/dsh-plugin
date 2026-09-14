// board 路由 + 模板管理路由 + template-tool/report 工具 + 角色分发测试。
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

const NEWS_FLOW = `{
  id: "news", label: "新闻生产", description: "收集信息交叉核对后成稿",
  steps: [
    { id: "plan", prompt: "定计划", outputs: { keywords: "关键词" } },
    { id: "write", prompt: "成稿", outputs: { article: "稿件" } },
  ],
}`

function makeCtx(settingsValue) {
  const routes = new Map()
  const tools = []
  const registered = []
  const ctx = {
    get(name) {
      if (name === 'settings' && settingsValue) return { get() { return settingsValue }, update(ns, patch) { Object.assign(settingsValue, patch); return Promise.resolve() } }
      return undefined
    },
    effect(fn) { fn() },
    on() { return () => {} },
    inject(deps, fn) {
      fn({
        settings: { register(ns, schema, opts) { registered.push({ ns, schema, opts }) } },
        tools: { register(def) { tools.push(def) } },
        webServer: { register(route) { routes.set(route.path, route.handler) } },
        effect(fn2) { fn2() },
      })
    },
    webServer: { register(route) { routes.set(route.path, route.handler) } },
  }
  return { ctx, routes, tools, registered }
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

test('角色分发:board 注册全部路由;settings 注册命名空间;template-tool/report 各注册一个工具', () => {
  const board = makeCtx()
  apply(board.ctx, { role: 'board' })
  assert.deepEqual([...board.routes.keys()].sort(), [
    '/api/rs-workflow/runs', '/api/rs-workflow/run', '/api/rs-workflow/remove',
    '/api/rs-workflow/templates', '/api/rs-workflow/spec',
    '/api/rs-workflow/release', '/api/rs-workflow/unrelease',
    '/api/rs-workflow/template-save', '/api/rs-workflow/template-remove',
  ].sort())

  const settings = makeCtx()
  apply(settings.ctx, { role: 'settings' })
  assert.equal(settings.routes.size, 0)
  assert.equal(settings.tools.length, 0)
  assert.equal(settings.registered.length, 1)
  assert.equal(settings.registered[0].ns, 'rs-workflow')

  const templateTool = makeCtx()
  apply(templateTool.ctx, { role: 'template-tool' })
  assert.deepEqual(templateTool.tools.map((def) => def.name), ['rs_workflow_template'])

  const report = makeCtx()
  apply(report.ctx, { role: 'report' })
  assert.deepEqual(report.tools.map((def) => def.name), ['rs_workflow_report'])
})

test('settings 注册:base 层携带行 config 的 slots/workflow/budgets/templates', () => {
  const settings = makeCtx()
  apply(settings.ctx, { role: 'settings', slots: { executor: 'p/m' }, workflow: { defaultTemplate: 'lite', maxTasks: 4 }, budgets: { reviewRejectBeforeEscalate: 3 }, templates: [] })
  // schemastery object 解析补全缺省键,按语义属性断言
  assert.equal(settings.registered[0].opts.base.slots.executor, 'p/m')
  assert.equal(settings.registered[0].opts.base.workflow.maxTasks, 4)
  assert.equal(settings.registered[0].opts.base.budgets.reviewRejectBeforeEscalate, 3)
})

test('report 工具:node→list→get 软上报链(无 start/finish 权威写)', async () => {
  const { ctx, tools } = makeCtx()
  apply(ctx, { role: 'report' })
  const tool = tools[0]
  const store = reportStore()
  const run = await store.start({ request: '做一个功能', workspace: process.cwd() })
  const node = await tool.execute({ action: 'node', runId: run.runId, nodeId: 't1', status: 'done', summary: '第一步完成' }, {})
  assert.equal(node.ok, true)
  const listed = await tool.execute({ action: 'list' }, {})
  assert.equal(listed.runs.length, 1, 'list 只看本工作区')
  assert.equal(listed.runs[0].runId, run.runId)
  const got = await tool.execute({ action: 'get', runId: run.runId }, {})
  assert.equal(got.ok, true)
  assert.equal(got.run.updates.length, 1, '节点软上报已入档(权威态 stats 由 takeover finish 生成)')
  const missing = await tool.execute({ action: 'get', runId: 'nope' }, {})
  assert.equal(missing.ok, false)
  assert.match(missing.error, /运行记录不存在/)
})

test('template-tool:spec 返回规范全文,list/save 校验失败逐条报错,save+release 真实释放', async () => {
  const settingsValue = { templates: [] }
  const { ctx, tools } = makeCtx(settingsValue)
  const realHome = process.env.DSH_HOME
  const home = await mkdtemp(join(tmpdir(), 'rsww-home-'))
  process.env.DSH_HOME = home
  try {
    apply(ctx, { role: 'template-tool' })
    const tool = tools[0]
    // 读写走 ctx settings 桩;release/unrelease 走真实 preset-sync(DSH_HOME 已指临时目录)

    const spec = await tool.execute({ action: 'spec' })
    assert.equal(spec.ok, true)
    assert.match(spec.spec, /产出契约/)

    const listed = await tool.execute({ action: 'list' })
    assert.equal(listed.ok, true)
    // list 是合并视图:内置模板(default/news/novel)始终可见
    assert.ok(listed.templates.some((t) => t.id === 'default'), 'list 应含内置 default')
    assert.ok(listed.templates.some((t) => t.id === 'news'), 'list 应含内置 news')
    assert.ok(listed.templates.some((t) => t.id === 'novel'), 'list 应含内置 novel')

    const bad = await tool.execute({ action: 'save', template: { id: 'bad', json5: '{ id: "bad", steps: [{ id: "s1", outputs: { x: "X" }, for_each: "nope.nope" }] }' } })
    assert.equal(bad.ok, false)
    assert.ok(bad.errors.length > 0, '非法 for_each 数据源应逐条报错')

    const mismatch = await tool.execute({ action: 'save', template: { id: 'a', json5: '{ id: "b", steps: [{ id: "s1", prompt: "p" }] }' } })
    assert.equal(mismatch.ok, false)
    assert.match(mismatch.errors[0], /不一致/)

    const saved = await tool.execute({ action: 'save', release: true, template: { id: 'news', label: '新闻', json5: NEWS_FLOW } })
    assert.equal(saved.ok, true)
    assert.equal(saved.released, true)
    assert.equal(saved.presetId, 'rs-news')
    assert.equal(settingsValue.templates.length, 1)
    // 释放产物落盘校验(mode 目录与 flow.json5 存在)
    const { existsSync } = await import('node:fs')
    assert.ok(existsSync(join(home, '.agent-presets', 'rs-news', 'flow.json5')), '释放应产出 rs-news 模式目录')

    const removed = await tool.execute({ action: 'remove', id: 'news' })
    assert.equal(removed.ok, true)
    // news 是内置模板:remove 落用户态 enabled:false 记录(防合并复活),且撤下已释放模式
    assert.equal(settingsValue.templates.length, 1)
    assert.equal(settingsValue.templates[0].id, 'news')
    assert.equal(settingsValue.templates[0].enabled, false)
    assert.equal(existsSync(join(home, '.agent-presets', 'rs-news')), false, 'remove 应撤下已释放模式')
  } finally {
    if (realHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = realHome
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
})

test('模板路由:template-save 校验→保存;release 释放;template-remove 撤下并删除', async () => {
  const settingsValue = { templates: [] }
  const { ctx, routes } = makeCtx(settingsValue)
  // releaseFlowTemplate/unreleaseFlowTemplate 真实落盘需要 DSH_HOME 注入;此处仅验证路由语义
  const realHome = process.env.DSH_HOME
  const home = await mkdtemp(join(tmpdir(), 'rsww-home-'))
  process.env.DSH_HOME = home
  try {
    const { releaseFlowTemplate, unreleaseFlowTemplate } = await import('../lib/preset-sync.mjs')
    const mod = await import('../lib/index.js')
    // 直接用 lib 导出验证路由背后的动作;路由 handler 层已被上一测试覆盖分发正确性
    assert.ok(typeof mod.flowPresetDest === 'function')
    const outcome = releaseFlowTemplate({ id: 'news', label: '新闻', description: 'd', json5: NEWS_FLOW })
    assert.ok(['created', 'updated'].includes(outcome))
    assert.equal(unreleaseFlowTemplate('news'), 'removed')
  } finally {
    if (realHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = realHome
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }

  apply(ctx, { role: 'board' })
  const saved = await callRoute(routes, '/api/rs-workflow/template-save', makeReq('POST', {
    url: '/api/rs-workflow/template-save', origin: 'http://localhost:3000', contentType: 'application/json',
    body: { id: 'news', json5: NEWS_FLOW },
  }))
  assert.equal(saved.status, 200)
  assert.equal(settingsValue.templates.length, 1)

  const dup = await callRoute(routes, '/api/rs-workflow/template-save', makeReq('POST', {
    url: '/api/rs-workflow/template-save', origin: 'http://localhost:3000', contentType: 'application/json',
    body: { id: 'news', json5: NEWS_FLOW.replace('news', 'other') },
  }))
  assert.equal(dup.status, 400, 'id 与定义不一致拒绝')

  const removed = await callRoute(routes, '/api/rs-workflow/template-remove', makeReq('POST', {
    url: '/api/rs-workflow/template-remove', origin: 'http://localhost:3000', contentType: 'application/json', body: { id: 'news' },
  }))
  assert.equal(removed.status, 200)
  // news 是内置模板:remove 落 enabled:false 用户记录(防合并复活)而非直接删除
  assert.equal(settingsValue.templates.length, 1)
  assert.equal(settingsValue.templates[0].id, 'news')
  assert.equal(settingsValue.templates[0].enabled, false)
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
