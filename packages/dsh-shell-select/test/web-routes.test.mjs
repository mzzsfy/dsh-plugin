// web 路由行:声明式 inject 门控 + settings 面驱动的 faces(0.1.7 形态)。
// BDD 场景:webServer 缺席不激活路由;GET 读 describe 值;POST 归一校验后 replace;
// ns 缺失读兜底出厂默认;写路径合并既有字段(单改 default 不丢 shells)。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as webRoutes from '../src/web-routes.mjs'
import { SECTION_NS, buildFaces } from '../src/web-routes.mjs'

const NODE_EXE = process.execPath

function describedSection(overrides = {}) {
  return {
    ns: SECTION_NS,
    value: {
      shells: [
        { id: 'pwsh', name: 'PowerShell', kind: 'pwsh', path: NODE_EXE, args: [], login: false, distro: '', env: {} },
        { id: 'git-bash', name: 'Git Bash', kind: 'bash', path: NODE_EXE, args: [], login: false, distro: '', env: {} },
      ],
      default: 'pwsh',
      deny: [],
      timeoutMs: 12e4,
    },
    ...overrides,
  }
}

function stubSettings(descriptors) {
  const calls = { replace: [], describe: 0 }
  return {
    calls,
    describe: () => {
      calls.describe += 1
      return descriptors
    },
    replace: async (ns, section) => {
      calls.replace.push({ ns, section })
    },
  }
}

function stubWebServer() {
  const state = { registered: [], handlers: new Map() }
  return {
    state,
    register(route) {
      state.registered.push({ kind: route.kind, path: route.path })
      state.handlers.set(route.path, route.handler)
      return () => {}
    },
  }
}

function stubCtx({ settings = stubSettings([describedSection()]), webServer = stubWebServer() } = {}) {
  const registered = { warnings: [] }
  const services = { webServer, settings }
  const ctx = {
    logger: { warn: (msg) => registered.warnings.push(msg) },
    webServer,
    get(service) {
      return services[service]
    },
    effect(fn) {
      fn()
      return () => {}
    },
  }
  return {
    ctx, registered, settings, webServer,
    /** 测试中覆盖服务可用性(缺席 = delete services.webServer) */
    services,
  }
}

function fakeReq(method, body) {
  const text = body === undefined ? '' : JSON.stringify(body)
  return {
    method,
    headers: { origin: 'http://127.0.0.1:9191', host: '127.0.0.1:9191' },
    on(event, cb) {
      if (event === 'data') setImmediate(() => cb(Buffer.from(text)))
      if (event === 'end') setImmediate(cb)
    },
    destroy: () => {},
  }
}

function fakeRes() {
  const state = { status: 0, body: '' }
  return {
    state,
    writeHead(status) {
      state.status = status
    },
    end(body) {
      state.body = body
    },
  }
}

async function callConfig(ctx, method, body) {
  const handler = ctx.webServer.state.handlers.get('/api/shell-select/config')
  const res = fakeRes()
  await handler(fakeReq(method, body), res)
  return res.state
}

test('行声明:name/inject 形态(webServer+settings 点分门控)', () => {
  assert.equal(webRoutes.name, 'shell-select/web')
  assert.deepEqual(webRoutes.inject, ['webServer', 'settings'])
})

test('webServer 缺席:路由跳过不抛(带告警,headless 合法形态)', () => {
  const { ctx, registered, services } = stubCtx()
  delete services.webServer
  webRoutes.apply(ctx)
  assert.match(registered.warnings.join('\n'), /webServer/)
})

test('webServer 在场:三条 exact 路由注册', () => {
  const { ctx, webServer } = stubCtx()
  webRoutes.apply(ctx)
  const paths = webServer.state.registered.map((item) => item.path).sort()
  assert.deepEqual(paths, ['/api/shell-select/config', '/api/shell-select/detect', '/api/shell-select/probe'])
  assert.ok(webServer.state.registered.every((item) => item.kind === 'exact'))
})

test('GET /config:返回 describe 值 + resolved 投影(路径已解析)', async () => {
  const { ctx } = stubCtx()
  webRoutes.apply(ctx)
  const state = await callConfig(ctx, 'GET')
  const payload = JSON.parse(state.body)
  assert.equal(payload.default, 'pwsh')
  assert.equal(payload.timeoutMs, 12e4)
  assert.equal(payload.resolved.shells[0].available, true)
  assert.equal(payload.resolved.shells[0].path, NODE_EXE)
})

test('GET /config:ns 缺失兜底出厂默认并告警(不崩)', async () => {
  const { ctx, registered } = stubCtx({ settings: stubSettings([]) })
  webRoutes.apply(ctx)
  const state = await callConfig(ctx, 'GET')
  const payload = JSON.parse(state.body)
  assert.equal(state.status, 200)
  assert.equal(payload.default, 'pwsh')
  assert.ok(payload.shells.length > 0)
  assert.match(registered.warnings.join('\n'), /shell-select/)
})

test('POST /config:合法清单 replace 到 SECTION_NS,响应带归一 resolved', async () => {
  const { ctx, settings } = stubCtx()
  webRoutes.apply(ctx)
  const state = await callConfig(ctx, 'POST', {
    shells: [{ id: 'git-bash', name: 'Git Bash', kind: 'bash', path: NODE_EXE, args: [], login: false, distro: '', env: {} }],
    default: 'git-bash',
    deny: ['^format\\s'],
  })
  assert.equal(state.status, 200)
  const payload = JSON.parse(state.body)
  assert.equal(payload.ok, true)
  assert.equal(payload.resolved.default, 'git-bash')
  assert.equal(settings.calls.replace.length, 1)
  assert.equal(settings.calls.replace[0].ns, SECTION_NS)
  assert.equal(settings.calls.replace[0].section.deny.length, 1)
})

test('POST /config:写路径合并既有字段(单改 default 保留 timeoutMs)', async () => {
  const { ctx, settings } = stubCtx()
  webRoutes.apply(ctx)
  await callConfig(ctx, 'POST', {
    shells: [{ id: 'pwsh', name: 'PowerShell', kind: 'pwsh', path: NODE_EXE }],
    default: 'pwsh',
    deny: [],
  })
  const written = settings.calls.replace[0].section
  assert.equal(written.timeoutMs, 12e4)
})

test('POST /config:非法负载(空清单/坏 default)400 不写', async () => {
  const { ctx, settings } = stubCtx()
  webRoutes.apply(ctx)
  const bad1 = await callConfig(ctx, 'POST', { shells: [], default: 'pwsh', deny: [] })
  assert.equal(bad1.status, 400)
  const bad2 = await callConfig(ctx, 'POST', {
    shells: [{ id: 'pwsh', name: 'PowerShell', kind: 'pwsh', path: NODE_EXE }],
    default: 'nope',
    deny: [],
  })
  assert.equal(bad2.status, 400)
  assert.equal(settings.calls.replace.length, 0)
})

test('POST /config:非对象负载 400', async () => {
  const { ctx } = stubCtx()
  webRoutes.apply(ctx)
  const state = await callConfig(ctx, 'POST', ['nope'])
  assert.equal(state.status, 400)
})

test('删除条目全链:POST 移除 cmd → 落盘无 cmd → 执行面拒绝已删 id(出厂默认不复活)', async () => {
  // 用户报告:设置页删除 cmd 后"还能用"。写路径契约:shells 整体替换,
  // schema resolve 的出厂默认(含 cmd)只兜底缺节/坏形态,不得回灌合法清单。
  const described = describedSection()
  described.value.shells.push({ id: 'cmd', name: 'CMD', kind: 'cmd', path: NODE_EXE, args: [], login: false, distro: '', env: {} })
  const { ctx, settings } = stubCtx({ settings: stubSettings([described]) })
  webRoutes.apply(ctx)
  const remaining = described.value.shells.filter((entry) => entry.id !== 'cmd')
  const state = await callConfig(ctx, 'POST', {
    shells: remaining.map(({ id, name, kind, path }) => ({ id, name, kind, path })),
    default: 'git-bash',
    deny: [],
  })
  assert.equal(state.status, 200)
  const payload = JSON.parse(state.body)
  assert.deepEqual(payload.resolved.shells.map((entry) => entry.id), ['pwsh', 'git-bash'])
  const written = settings.calls.replace[0].section
  assert.deepEqual(written.shells.map((entry) => entry.id), ['pwsh', 'git-bash'])
  // 落盘形态再喂回执行面(resolve→requireEntry):已删 id 拒绝,不出厂默认回灌
  const { resolveConfig } = await import('../src/config.mjs')
  const resolved = resolveConfig(written)
  assert.deepEqual(resolved.shells.map((entry) => entry.id), ['pwsh', 'git-bash'])
  const { requireEntry } = await import('../src/config.mjs')
  assert.throws(() => requireEntry(resolved.shells, 'cmd', resolved.default), /cmd/)
})

test('buildFaces:probe 真实路径布尔,detect 返回候选数组', () => {
  const settings = stubSettings([describedSection()])
  const faces = buildFaces({ logger: { warn: () => {} } }, settings)
  assert.equal(faces.probe(NODE_EXE), true)
  assert.ok(Array.isArray(faces.detect(['cmd'])))
})
