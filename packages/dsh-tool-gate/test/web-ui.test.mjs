import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import vm from 'node:vm'
import { apply, buildFaces } from '../src/web-routes.mjs'
import { DEFAULT_ALLOWLIST } from '../src/config.mjs'
import { mountRoutes, cleanAllowlist } from '../src/api.mjs'
import { analyzeSwitch } from './switch-structure.mjs'

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

test('readState 投影:enabled/collapse/allowlist 回落 + 工具聚合 + 详情 + 未知名(SC-11)', () => {
  const settings = settingsStub({ 'tool-gate': { allowlist: ['read', 'ghost'], enabled: false, collapse: false } })
  const tools = toolsStub({
    global: [['working_directory', { deferLoading: true }], ['tool_search', {}]],
    scoped: {
      a: [
        ['read', {
          description: '读取文件内容。',
          parameters: {
            type: 'object',
            properties: {
              file_path: { type: 'string', description: '目标文件路径' },
              offset: { type: 'number' },
            },
            required: ['file_path'],
          },
        }],
        ['web_search', { deferLoading: true, description: '搜索网页。' }],
      ],
      b: [['read', {}]],
    },
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
  assert.equal(read.description, '读取文件内容。')
  assert.deepEqual(read.layerLabels, ['agent#1', 'agent#2'])
  assert.deepEqual(read.params, [
    { name: 'file_path', type: 'string', required: true, description: '目标文件路径' },
    { name: 'offset', type: 'number', required: false, description: '' },
  ])
  const webSearch = state.tools.find((tool) => tool.name === 'web_search')
  assert.deepEqual([webSearch.layers, webSearch.deferredLayers, webSearch.inAllowlist], [1, 1, false])
  assert.equal(webSearch.description, '搜索网页。')
  const working = state.tools.find((tool) => tool.name === 'working_directory')
  assert.deepEqual([working.layers, working.deferredLayers], [1, 1])
  assert.equal(working.description, '')
  assert.deepEqual(working.params, [])
  const search = state.tools.find((tool) => tool.name === 'tool_search')
  assert.equal(search.implicit, true)
  assert.equal(state.tools.find((tool) => tool.name === 'read').implicit, false)
})

test('readState 空节回落出厂默认(enabled/collapse true / 出厂白名单)', () => {
  const state = buildFaces(settingsStub(), toolsStub({})).readState()
  assert.equal(state.enabled, true)
  assert.equal(state.collapse, true)
  assert.deepEqual(state.allowlist, [...DEFAULT_ALLOWLIST])
})

test('readSection 解箱 volatile ref 并补齐缺省字段', () => {
  const settings = settingsStub({
    'tool-gate': {
      allowlist: { get: () => ['read'] },
      enabled: { get: () => false },
    },
  })
  const state = buildFaces(settings, toolsStub({})).readState()
  assert.deepEqual(state.allowlist, ['read'])
  assert.equal(state.enabled, false)
  assert.equal(state.collapse, true)
})

test('updateAllowlist/updateEnabled/updateCollapse 写 settings 落盘(SC-12/SC-13)', async () => {
  const settings = settingsStub()
  const faces = buildFaces(settings, toolsStub({}))
  await faces.updateAllowlist(['read', 'shell'])
  // 空节首次写入也带齐三字段,不把出厂默认丢成单字段
  assert.deepEqual(settings.sections.get('tool-gate'), {
    allowlist: ['read', 'shell'],
    enabled: true,
    collapse: true,
  })
  await faces.updateEnabled(false)
  await faces.updateCollapse(false)
  assert.deepEqual(settings.sections.get('tool-gate'), { allowlist: ['read', 'shell'], enabled: false, collapse: false })
  // 部分更新不覆盖其他字段
  await faces.updateEnabled(true)
  assert.deepEqual(settings.sections.get('tool-gate').allowlist, ['read', 'shell'])
  assert.equal(settings.sections.get('tool-gate').collapse, false)
})

test('S14 cleanAllowlist:剔非字符串/空串/重复,trim 后保序去重', () => {
  assert.deepEqual(cleanAllowlist(['read', '', 3, ' read ', null, 'shell']), ['read', 'shell'])
  assert.deepEqual(cleanAllowlist([' web_search ', 'web_search']), ['web_search'])
  assert.deepEqual(cleanAllowlist(undefined), [])
  assert.deepEqual(cleanAllowlist('read'), [])
})

// ---- HTTP 层:路由表挂载 + 守卫 ----

function ctxStub(options = {}) {
  const registered = []
  const webServer = options.webServer ?? { register: (item) => registered.push({ mounted: item }) }
  return {
    registered,
    effect: (factory) => registered.push(factory()),
    get: (name) => (name === 'webServer' ? webServer : name === 'connection' ? options.connection : undefined),
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
  const req = { method, headers: body !== undefined ? { 'content-type': 'application/json', ...(headers ?? {}) } : (headers ?? {}) }
  if (body !== undefined) {
    req.on = (event, cb) => { if (event === 'data') cb(Buffer.from(JSON.stringify(body))); if (event === 'end') cb() }
  } else {
    req.on = (event, cb) => { if (event === 'end') cb() }
  }
  const res = resStub()
  await item.mounted.handler(req, res)
  // 闸门拒绝回纯文本,业务面回 JSON:两种都按原文返回,便于断言状态码与文案
  let json
  try {
    json = res.body === undefined ? undefined : JSON.parse(res.body)
  } catch {
    json = undefined
  }
  return { status: res.statusCode, json, text: res.body }
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
  const notJson = await dispatch(ctx, '/api/tool-gate/allowlist', 'POST', { allowlist: [] }, { origin: 'http://127.0.0.1:9291', host: '127.0.0.1:9291', 'content-type': 'text/plain' })
  assert.equal(notJson.status, 400)
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

// Given 白名单已是 ['read'];When 写请求缺字段/非数组/含非字符串或空串;
// Then 400 且落盘白名单不变(旧实现静默清空 = 全量 deferLoading)。
test('POST allowlist 边界:缺字段/非数组/脏项 400 且不改白名单,空数组是显式清空', async () => {
  const settings = settingsStub({ 'tool-gate': { allowlist: ['read'], enabled: true, collapse: true } })
  const ctx = ctxStub()
  mountRoutes(ctx, buildFaces(settings, toolsStub({ scoped: { a: [['web_search', {}]] } })))
  const sameOrigin = { origin: 'http://127.0.0.1:9291', host: '127.0.0.1:9291' }
  for (const body of [
    {},
    { allowlist: 'read' },
    { allowlist: null },
    { allowlist: { 0: 'read' } },
    { allowlist: ['read', ''] },
    { allowlist: ['read', ' '] },
    { allowlist: ['read', 3] },
    { allowlist: ['read', null] },
  ]) {
    const rejected = await dispatch(ctx, '/api/tool-gate/allowlist', 'POST', body, sameOrigin)
    assert.equal(rejected.status, 400, `应拒绝: ${JSON.stringify(body)}`)
    assert.match(rejected.json.error, /allowlist/)
    assert.deepEqual(settings.sections.get('tool-gate').allowlist, ['read'], '被拒请求不得改动白名单')
  }
  // 重复名按清洗语义去重,不算形态错误;首尾空白按工具名 trim 后落盘(S14)
  const deduped = await dispatch(ctx, '/api/tool-gate/allowlist', 'POST', { allowlist: ['read', 'read', 'web_search'] }, sameOrigin)
  assert.equal(deduped.status, 200)
  assert.deepEqual(settings.sections.get('tool-gate').allowlist, ['read', 'web_search'])
  const trimmed = await dispatch(ctx, '/api/tool-gate/allowlist', 'POST', { allowlist: [' read ', ' web_search '] }, sameOrigin)
  assert.equal(trimmed.status, 200)
  assert.deepEqual(settings.sections.get('tool-gate').allowlist, ['read', 'web_search'])
  const emptied = await dispatch(ctx, '/api/tool-gate/allowlist', 'POST', { allowlist: [] }, sameOrigin)
  assert.equal(emptied.status, 200, '空数组是显式清空,不是形态错误')
  assert.deepEqual(settings.sections.get('tool-gate').allowlist, [])
})

// Given 请求体超过 1MB 上限;When 写请求;Then 413 与明确文案经真实 socket 可送达,
// 白名单不变。旧实现超限即 destroy socket 再按「请求体须为 JSON」回 400:桩测试
// 里响应总是「送达」,只有真实 socket 能暴露 ECONNRESET(上一轮的错误断言由此而来)。
test('S4 超限请求体:413 经真实 socket 可送达且不改白名单', async () => {
  const { createServer, request } = await import('node:http')
  const settings = settingsStub({ 'tool-gate': { allowlist: ['read'] } })
  const ctx = ctxStub()
  mountRoutes(ctx, buildFaces(settings, toolsStub({})))
  const handlers = new Map(routesOf(ctx).map((entry) => [entry.mounted.path, entry.mounted.handler]))
  const server = createServer((req, res) => {
    const handler = handlers.get(new URL(req.url, 'http://127.0.0.1').pathname)
    if (handler === undefined) {
      res.writeHead(404)
      res.end()
      return
    }
    Promise.resolve(handler(req, res)).catch(() => {
      if (!res.headersSent) res.writeHead(500)
      res.end()
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  try {
    const oversized = JSON.stringify({ allowlist: ['read', 'x'.repeat(2 * 1024 * 1024)] })
    const response = await new Promise((resolve, reject) => {
      const req = request({
        host: '127.0.0.1',
        port,
        path: '/api/tool-gate/allowlist',
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          origin: `http://127.0.0.1:${port}`,
          host: `127.0.0.1:${port}`,
        },
      }, (res) => {
        const chunks = []
        res.on('data', (chunk) => chunks.push(chunk))
        res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }))
      })
      req.on('error', reject)
      req.end(oversized)
    })
    assert.equal(response.status, 413)
    assert.deepEqual(JSON.parse(response.body), { error: '请求体超过上限' })
    assert.deepEqual(settings.sections.get('tool-gate').allowlist, ['read'], '超限请求不得改动白名单')
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
})

// Given 宿主闸门拒绝(requestRejection 非空);When 调用四条路由;
// Then 每条都按宿主状态码回纯文本、业务面零执行(漏挂闸门的路由会暴露)。
test('宿主闸门路由级集成:四条路由统一拒绝,业务面零执行', async () => {
  const settings = settingsStub({ 'tool-gate': { allowlist: ['read'] } })
  const faces = buildFaces(settings, toolsStub({}))
  const calls = []
  const spy = Object.fromEntries(Object.entries(faces).map(([key, value]) => [key, (...args) => {
    calls.push(key)
    return value(...args)
  }]))
  const ctx = ctxStub({ connection: { requestRejection: () => 401 } })
  mountRoutes(ctx, spy)
  const unauthenticated = await dispatch(ctx, '/api/tool-gate/state', 'GET')
  assert.equal(unauthenticated.status, 401)
  assert.equal(unauthenticated.text, 'unauthorized')
  for (const [path, body] of [
    ['/api/tool-gate/allowlist', { allowlist: [] }],
    ['/api/tool-gate/enabled', { enabled: false }],
    ['/api/tool-gate/collapse', { collapse: false }],
  ]) {
    const rejected = await dispatch(ctx, path, 'POST', body, { origin: 'http://127.0.0.1:9291', host: '127.0.0.1:9291' })
    assert.equal(rejected.status, 401, `${path} 必须过宿主闸门`)
    assert.equal(rejected.text, 'unauthorized')
  }
  assert.deepEqual(calls, [], '闸门拒绝时业务面不执行')
  assert.deepEqual(settings.sections.get('tool-gate').allowlist, ['read'], '落盘不变')

  // 不可信 Host 的 403 同样按宿主状态码透传
  const forbidden = ctxStub({ connection: { requestRejection: () => 403 } })
  mountRoutes(forbidden, faces)
  const denied = await dispatch(forbidden, '/api/tool-gate/state', 'GET')
  assert.equal(denied.status, 403)
  assert.equal(denied.text, 'forbidden')
})

// Given headless 部署(webServer 缺席);When 挂载路由;Then 告警并跳过,不抛
test('webServer 服务不在场:告警跳过路由,不抛', () => {
  const warnings = []
  const ctx = { get: () => undefined, logger: { warn: (message) => warnings.push(message) } }
  assert.doesNotThrow(() => mountRoutes(ctx, buildFaces(settingsStub(), toolsStub({}))))
  assert.ok(warnings.some((message) => message.includes('webServer 服务不在场')))
})

// ---- client 行生命周期:设置页分区与样式挂在行 fiber 上(关掉行即消失,重开重建) ----

/** 在沙箱里跑 client.js 的 __ModuleLoader__ 注册,拿回模块、style 节点池与
 * 可控 hooks(fetch/effects/setters)供卸载竞态用例驱动。 */
function loadClientModule({ fetchImpl } = {}) {
  const nodes = []
  const effects = []
  const setters = []
  let module
  const react = {
    createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
    useState: (initial) => {
      const setter = (value) => { setters.push(value) }
      return [initial, setter]
    },
    useEffect: (fn) => { effects.push(fn) },
  }
  const sandbox = {
    window: {
      __ModuleLoader__: {
        load: ({ factory }) => {
          module = factory((name) => {
            if (name === 'react') return react
            throw new Error(`client 沙箱不提供模块: ${name}`)
          })
        },
      },
    },
    document: {
      createElement: (tag) => {
        const node = {
          tag,
          attrs: {},
          textContent: '',
          setAttribute(key, value) { this.attrs[key] = value },
          remove: () => {
            const index = nodes.indexOf(node)
            if (index >= 0) nodes.splice(index, 1)
          },
        }
        return node
      },
      head: { appendChild: (node) => nodes.push(node) },
    },
    setTimeout,
    fetch: fetchImpl ?? (async () => ({ ok: true, json: async () => ({ allowlist: [] }) })),
  }
  vm.runInNewContext(src('client.js'), sandbox, { filename: 'client.js' })
  return { module, nodes, effects, setters }
}

// Given 客户端行已挂载(设置页分区 + 样式);When 行被关掉(宿主按 fiber 注销)
// 再重开;Then 分区与样式随之消失、重建——行不残留,重开回来。
test('client 行生命周期:关掉后分区与样式消失,重开回来', () => {
  const { module, nodes } = loadClientModule()
  const sections = []
  const disposers = []
  let injecting = false
  const ctx = {
    slots: {
      inject: (name, factory) => {
        assert.equal(name, 'settings.section')
        injecting = true
        try {
          factory()
        } finally {
          injecting = false
        }
      },
      register: (descriptor) => {
        assert.equal(injecting, true, '分区登记必须在 slots.inject 内:宿主按行 fiber 级联回收')
        sections.push(descriptor)
      },
    },
    effect: (factory) => disposers.push(factory()),
  }

  module.apply(ctx)
  assert.deepEqual(sections.map((section) => section.id), ['tool-gate'])
  assert.equal(nodes.length, 1, '样式注入一次')
  assert.equal(nodes[0].attrs['data-plugin'], '@mzzsfy/dsh-tool-gate')
  assert.ok(nodes[0].textContent.includes('.tg-panel'))

  // 关掉行:宿主注销行 fiber → 本行 effect 注销器把样式撤掉
  for (const dispose of disposers.splice(0)) dispose?.()
  assert.equal(nodes.length, 0, '关掉后样式行消失')

  // 重开行:同一 bundle 重新 apply,分区与样式重建
  module.apply(ctx)
  assert.deepEqual(sections.map((section) => section.id), ['tool-gate', 'tool-gate'])
  assert.equal(nodes.length, 1, '重开后样式重建')
  assert.equal(nodes[0].attrs['data-plugin'], '@mzzsfy/dsh-tool-gate')
})

/** 挂载行并取出设置分区组件渲染函数(宿主 settings.section 的 render)。 */
function mountSectionRender(loaded) {
  const sections = []
  const ctx = {
    slots: {
      inject: (name, factory) => factory(),
      register: (descriptor, render) => sections.push({ ...descriptor, render }),
    },
    effect: (factory) => factory(),
  }
  loaded.module.apply(ctx)
  return sections[0].render
}

// S12:卸载后迟到的初读响应不得回写——旧代码在 finally 里判 disposed 是空守卫,
// 拦不住 setState;这里用可控 fetch 把「响应晚于卸载」的真实时序跑出来。
test('S12 卸载后迟到的初读响应不回写;未卸载时同一响应正常回写(正控)', async () => {
  const tick = () => new Promise((resolve) => setTimeout(resolve, 20))

  // 负向:卸载后才落定
  let resolveLate
  const unmounted = loadClientModule({ fetchImpl: () => new Promise((resolve) => { resolveLate = resolve }) })
  const lateRender = mountSectionRender(unmounted)
  const lateElement = lateRender()
  lateElement.type()
  assert.equal(unmounted.effects.length, 1, '初读 effect 已注册')
  const disposeLate = unmounted.effects[0]()
  disposeLate()
  resolveLate({ ok: true, json: async () => ({ allowlist: ['read'] }) })
  await tick()
  assert.deepEqual(unmounted.setters, [], '卸载后不得回写状态')

  // 正向:未卸载时同一响应会回写(证明上面的空数组不是断言真空)
  let resolveAlive
  const mounted = loadClientModule({ fetchImpl: () => new Promise((resolve) => { resolveAlive = resolve }) })
  const aliveRender = mountSectionRender(mounted)
  const aliveElement = aliveRender()
  aliveElement.type()
  const disposeAlive = mounted.effects[0]()
  resolveAlive({ ok: true, json: async () => ({ allowlist: ['read'] }) })
  await tick()
  assert.equal(mounted.setters.length, 1, '存活组件必须拿到初读结果')
  disposeAlive()
})

// ---- 源码契约:样式注入 data-plugin / switch 结构 / 无裸 checkbox ----

test('client.js 契约:data-plugin 标记计数 = style 创建计数', () => {
  const client = src('client.js')
  const created = (client.match(/createElement\('style'/g) ?? []).length
  const marked = (client.match(/setAttribute\('data-plugin', '@mzzsfy\/dsh-tool-gate'\)/g) ?? []).length
  assert.equal(created, marked)
  assert.ok(client.includes("type: 'checkbox'"))
})

test('client.js 契约:switch 结构解析(input[type="checkbox"] + track > thumb)/ 前缀类名', () => {
  // Given 客户端注入的开关 CSS/DOM
  // When 解析源码结构(非 includes 类名)
  // Then 根为 label,checkbox 是直接子节点且与 track 相邻,track 内含 thumb,状态选择器锚定 checkbox
  const facts = analyzeSwitch(src('client.js'), 'tg')
  assert.equal(facts.roots.length, 1, 'tg-switch 根元素缺失或不是 label')
  const root = facts.roots[0]
  assert.equal(root.root.tag, 'label')
  assert.equal(root.input?.type, 'checkbox', '缺少 input[type="checkbox"] 控件语义')
  assert.ok(root.track, '缺少 track 后裔')
  assert.ok(root.thumbIndex >= 0, 'track 内缺少 thumb 后裔')
  assert.ok(root.adjacent, 'input 与 track 必须相邻兄弟')
  assert.ok(facts.css.trackRule && facts.css.thumbRule, 'track/thumb CSS 选择器缺失')
  assert.ok(facts.css.checkedTrack && facts.css.checkedThumb, '选中态未锚定 checkbox 与 track/thumb')
  assert.deepEqual(facts.css.bareStateSelectors, [], '状态选择器不得裸 input 锚定')
})

test('client.js 语法:node --check', async () => {
  const { execFile } = await import('node:child_process')
  const { promisify } = await import('node:util')
  await promisify(execFile)(process.execPath, ['--check', join(dirname(fileURLToPath(import.meta.url)), '../src/client.js')])
})

// Given tools 服务存在但层结构不符(宿主形态漂移);When web 行 apply;
// Then 不挂载状态路由、告警说明,收敛本体不受影响(SC-25 的 web 面)。
test('web 行:tools 层结构不符时不挂载状态路由并告警', () => {
  const routes = []
  const warnings = []
  apply({
    get: (name) => (name === 'tools' ? { layers: {} } : undefined),
    webServer: { register: (route) => { routes.push(route) } },
    logger: { warn: (message) => { warnings.push(message) } },
  })
  assert.equal(routes.length, 0)
  assert.ok(warnings.some((message) => message.includes('层结构与已知形态不符')))
})
