import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { buildFaces } from '../src/web-routes.mjs'
import { mountRoutes, cleanAllowlist } from '../src/api.mjs'

const src = (name) => readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../src', name), 'utf8')

// ---- faces(settings stub:describe/replace 内存表)----

function settingsStub(initial = {}) {
  const sections = new Map(Object.entries(initial))
  return {
    sections,
    describe: () => [...sections.entries()].map(([ns, value]) => ({ ns, value })),
    replace: async (ns, value) => {
      if (typeof ns !== 'string' || ns === '') throw new Error('ns 非法')
      sections.set(ns, value)
    },
  }
}

function toolsStub(layers) {
  const globalData = new Map(layers.global ?? [])
  const scoped = new Map()
  for (const [key, defs] of Object.entries(layers.scoped ?? {})) scoped.set(key, { tools: { data: new Map(defs) } })
  return { layers: () => [{ key: globalData, label: 'global', names: () => [...globalData.keys()], definitionOf: (name) => globalData.get(name) }, ...[...scoped.values()].map((entry, index) => ({ key: entry.tools.data, label: `agent#${index + 1}`, names: () => [...entry.tools.data.keys()], definitionOf: (name) => entry.tools.data.get(name) }))] }
}

test('readState 投影:enabled/collapse/allowlist 回落 + 工具聚合 + 未知名(SC-11)', () => {
  const settings = settingsStub({ 'tool-gate': { allowlist: ['read', 'ghost'], enabled: false, collapse: false } })
  const tools = toolsStub({
    global: [['working_directory', { deferLoading: true }], ['tool_search', {}]],
    scoped: { a: [['read', {}], ['web_search', { deferLoading: true }]], b: [['read', {}]] },
  })
  const state = buildFaces(settings, tools).readState()
  assert.equal(state.enabled, false)
  assert.equal(state.collapse, false)
  assert.deepEqual(state.allowlist, ['read', 'ghost'])
  assert.deepEqual(state.unknownAllowlisted, ['ghost'])
  const read = state.tools.find((tool) => tool.name === 'read')
  assert.equal(read.layers, 2)
  assert.equal(read.deferredLayers, 0)
  assert.equal(read.inAllowlist, true)
  const webSearch = state.tools.find((tool) => tool.name === 'web_search')
  assert.deepEqual([webSearch.layers, webSearch.deferredLayers, webSearch.inAllowlist], [1, 1, false])
  const working = state.tools.find((tool) => tool.name === 'working_directory')
  assert.deepEqual([working.layers, working.deferredLayers], [1, 1])
  const search = state.tools.find((tool) => tool.name === 'tool_search')
  assert.equal(search.implicit, true)
  assert.equal(state.tools.find((tool) => tool.name === 'read').implicit, false)
})

test('readState 空节回落出厂语义(enabled/collapse true / allowlist 空)', () => {
  const state = buildFaces(settingsStub(), toolsStub({})).readState()
  assert.equal(state.enabled, true)
  assert.equal(state.collapse, true)
  assert.deepEqual(state.allowlist, [])
})

test('updateAllowlist/updateEnabled/updateCollapse 写 settings 落盘(SC-12/SC-13)', async () => {
  const settings = settingsStub()
  const faces = buildFaces(settings, toolsStub({}))
  await faces.updateAllowlist(['read', 'shell'])
  await faces.updateEnabled(false)
  await faces.updateCollapse(false)
  assert.deepEqual(settings.sections.get('tool-gate'), { allowlist: ['read', 'shell'], enabled: false, collapse: false })
  // 部分更新不覆盖其他字段
  await faces.updateEnabled(true)
  assert.deepEqual(settings.sections.get('tool-gate').allowlist, ['read', 'shell'])
  assert.equal(settings.sections.get('tool-gate').collapse, false)
})

test('cleanAllowlist:剔非字符串/空串/重复,保序', () => {
  assert.deepEqual(cleanAllowlist(['read', '', 3, 'read', null, 'shell']), ['read', 'shell'])
  assert.deepEqual(cleanAllowlist(undefined), [])
  assert.deepEqual(cleanAllowlist('read'), [])
})

// ---- HTTP 层:路由表挂载 + 守卫 ----

function ctxStub() {
  const registered = []
  return {
    registered,
    effect: (factory) => registered.push(factory()),
    get: () => ({ register: (item) => registered.push({ mounted: item }) }),
  }
}

// effect 挂载产生两种条目(factory 返回值与 undefined),统一取 webServer.register 收集面
function routesOf(ctx) {
  return ctx.registered.filter((entry) => entry && entry.mounted !== undefined && entry.mounted.path !== undefined)
}

function resStub() {
  const calls = []
  return {
    statusCode: undefined,
    body: undefined,
    writeHead(status) { this.statusCode = status; calls.push(status) },
    end(text) { this.body = text },
  }
}

async function dispatch(ctx, path, method, body, headers) {
  const item = routesOf(ctx).find((entry) => entry.mounted.path === path)
  assert.ok(item, `路由未注册: ${path}`)
  const req = { method, headers: headers ?? {} }
  if (body !== undefined) {
    req.on = (event, cb) => { if (event === 'data') cb(Buffer.from(JSON.stringify(body))); if (event === 'end') cb() }
  } else {
    req.on = (event, cb) => { if (event === 'end') cb() }
  }
  const res = resStub()
  await item.mounted.handler(req, res)
  return { status: res.statusCode, json: res.body === undefined ? undefined : JSON.parse(res.body) }
}

test('路由挂载:四 exact 路由 + GET state 读通', async () => {
  const ctx = ctxStub()
  mountRoutes(ctx, buildFaces(settingsStub({ 'tool-gate': { allowlist: ['read'] } }), toolsStub({})))
  assert.equal(routesOf(ctx).length, 4)
  const { status, json } = await dispatch(ctx, '/api/tool-gate/state', 'GET')
  assert.equal(status, 200)
  assert.deepEqual(json.allowlist, ['read'])
  assert.equal(json.collapse, true)
})

test('SC-14 守卫:写跨源 403 / 方法不符 405 / 坏体 400 / enabled/collapse 非布尔 400', async () => {
  const ctx = ctxStub()
  mountRoutes(ctx, buildFaces(settingsStub(), toolsStub({})))
  const cross = await dispatch(ctx, '/api/tool-gate/allowlist', 'POST', { allowlist: [] }, { origin: 'http://evil.example', host: '127.0.0.1:9291' })
  assert.equal(cross.status, 403)
  const get405 = await dispatch(ctx, '/api/tool-gate/allowlist', 'GET')
  assert.equal(get405.status, 405)
  const badBody = await dispatch(ctx, '/api/tool-gate/allowlist', 'POST', [1, 2], { origin: 'http://127.0.0.1:9291', host: '127.0.0.1:9291' })
  assert.equal(badBody.status, 400)
  const notBool = await dispatch(ctx, '/api/tool-gate/enabled', 'POST', { enabled: 'yes' }, { origin: 'http://127.0.0.1:9291', host: '127.0.0.1:9291' })
  assert.equal(notBool.status, 400)
  const collapseNotBool = await dispatch(ctx, '/api/tool-gate/collapse', 'POST', { collapse: 1 }, { origin: 'http://127.0.0.1:9291', host: '127.0.0.1:9291' })
  assert.equal(collapseNotBool.status, 400)
  const collapseGet405 = await dispatch(ctx, '/api/tool-gate/collapse', 'GET')
  assert.equal(collapseGet405.status, 405)
})

test('写链路端到端:POST allowlist 落盘并回新 state', async () => {
  const settings = settingsStub()
  const ctx = ctxStub()
  mountRoutes(ctx, buildFaces(settings, toolsStub({ scoped: { a: [['web_search', {}]] } })))
  const { status, json } = await dispatch(ctx, '/api/tool-gate/allowlist', 'POST', { allowlist: ['web_search'] }, { origin: 'http://127.0.0.1:9291', host: '127.0.0.1:9291' })
  assert.equal(status, 200)
  assert.equal(json.tools.find((tool) => tool.name === 'web_search').inAllowlist, true)
  assert.deepEqual(settings.sections.get('tool-gate').allowlist, ['web_search'])
})

test('POST collapse 落盘并回新 state', async () => {
  const settings = settingsStub()
  const ctx = ctxStub()
  mountRoutes(ctx, buildFaces(settings, toolsStub({})))
  const { status, json } = await dispatch(ctx, '/api/tool-gate/collapse', 'POST', { collapse: false }, { origin: 'http://127.0.0.1:9291', host: '127.0.0.1:9291' })
  assert.equal(status, 200)
  assert.equal(json.collapse, false)
  assert.equal(settings.sections.get('tool-gate').collapse, false)
})

// ---- 源码契约:样式注入 data-plugin / switch 结构 / 无裸 checkbox ----

test('client.js 契约:data-plugin 标记计数 = style 创建计数', () => {
  const client = src('client.js')
  const created = (client.match(/createElement\('style'/g) ?? []).length
  const marked = (client.match(/setAttribute\('data-plugin', '@mzzsfy\/dsh-tool-gate'\)/g) ?? []).length
  assert.equal(created, marked)
  assert.ok(client.includes("type: 'checkbox'"))
})

test('client.js 契约:switch 结构(track+thumb 锚定 input)/ 前缀类名', () => {
  const client = src('client.js')
  assert.ok(client.includes("className: 'tg-switch'"))
  assert.ok(client.includes("'tg-switch__track'"))
  assert.ok(client.includes("'tg-switch__thumb'"))
})

test('client.js 语法:node --check', async () => {
  const { execFile } = await import('node:child_process')
  const { promisify } = await import('node:util')
  await promisify(execFile)(process.execPath, ['--check', join(dirname(fileURLToPath(import.meta.url)), '../src/client.js')])
})
