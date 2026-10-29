import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { apply, registerTerminalTool, SUPPORTED_VERSIONS } from '../src/index.js'
import { createWaitSkipRegistry } from '../src/lib/wait-skip.mjs'
import { defineTool } from './host.mjs'

function context(controller = { owners: new Map(), terminal() {}, shells() {}, list() {}, create() {}, write() {}, close() {} }) {
  const registrations = []
  const warnings = []
  const routes = []
  let dispose
  const ctx = {
    get(key) { return key === 'terminalController' ? controller : key === 'tools' ? { register(tool) { registrations.push(tool); return () => registrations.pop() } } : key === 'webServer' ? { register(route) { routes.push(route); return () => { const at = routes.indexOf(route); if (at >= 0) routes.splice(at, 1) } } } : undefined },
    logger: { warn(text) { warnings.push(text) } },
    effect(factory) { dispose = factory() },
  }
  return { ctx, registrations, warnings, routes, dispose: () => dispose?.() }
}

test('Given each tested Controller runtime, When installing, Then one terminal tool registers and disposes', () => {
  const legacy = { owners: new Map(), terminal() {}, shells() {}, list() {}, create() {}, write() {}, close() {} }
  const attachEra = { owners: new Map(), terminal() {}, shells() {}, list() {}, create() {}, attach() {}, close() {} }
  for (const [version, controller] of [
    ['0.2.0-rc.1', legacy],
    ['0.2.0-rc.2', legacy],
    ['0.2.1-alpha.2', legacy],
    ['0.2.1-rc.2', attachEra],
    ['0.2.1-rc.3', attachEra],
    ['0.2.1-rc.4', attachEra],
  ]) {
    const fixture = context(controller)
    registerTerminalTool(fixture.ctx, { version, defineTool })
    assert.equal(fixture.registrations.length, 1, `版本 ${version} 应注册`)
    assert.equal(fixture.registrations[0].name, 'terminal')
    fixture.dispose()
    assert.equal(fixture.registrations.length, 0)
  }
})

test('Given an untested Controller version, When installing, Then there is no registration even with identical private fields', () => {
  const fixture = context()
  registerTerminalTool(fixture.ctx, { version: '0.2.1-alpha.1', defineTool })
  assert.equal(fixture.registrations.length, 0)
  assert.equal(fixture.warnings.length, 1)
})

test('Given missing public or private methods, When installing, Then host disables without throwing', () => {
  for (const controller of [{}, { owners: new Map(), terminal() {} }]) {
    const fixture = context(controller)
    registerTerminalTool(fixture.ctx, { version: '0.2.0-rc.2', defineTool })
    assert.equal(fixture.registrations.length, 0)
    assert.equal(fixture.warnings.length, 1)
  }
})

test('Given the package manifest, When the support table evolves, Then peer range covers the support table and release metadata stay in lockstep', () => {
  const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
  const supported = [...SUPPORTED_VERSIONS].sort()
  // peer 是装载面(允许干净禁用的宿主代际),SUPPORTED 是功能面(实测私有结构):
  // 功能面必须被装载面覆盖,dshReleases 的 compatible 集合与功能面精确对账
  const peerRange = manifest.peerDependencies['@deepseek-ai/dsh-api-terminal-controller']
  for (const version of supported) assert.ok(peerRange.split(' || ').includes(version), `peer 缺功能面版本 ${version}`)
  assert.deepEqual(
    Object.entries(manifest.dsh.compatibility.dshReleases)
      .filter(([, status]) => status === 'compatible').map(([version]) => version).sort(),
    supported,
  )
})

test('Given the actual installed dependencies, When applying, Then runtime metadata resolution and one-tool registration succeed', async () => {
  const fixture = context()
  await apply(fixture.ctx)
  assert.equal(fixture.registrations.length, 1)
  fixture.dispose()
})

// ── wait 手动打断路由(SK1/SK2/SK6) ───────────────────────────────────

const WAIT_ROUTE_CTX = { owners: new Map(), terminal() {}, shells() {}, list() {}, create() {}, write() {}, close() {} }

const stubRes = () => {
  const res = { statusCode: 0, headers: {}, body: '', listeners: {} }
  res.writeHead = (status, headers) => { res.statusCode = status; Object.assign(res.headers, headers) }
  res.end = (text) => { res.body = text ?? ''; res.listeners.finish?.() }
  res.on = (name, listener) => { res.listeners[name] = listener }
  return res
}

const stubReq = (body, headers = {}) => {
  const listeners = {}
  const req = {
    method: 'POST',
    headers: { host: 'localhost:3080', 'content-type': 'application/json', ...headers },
    paused: false,
    destroyed: false,
    on(name, listener) { listeners[name] = listener },
    pause() { req.paused = true },
    destroy() { req.destroyed = true },
    emit() { listeners.data?.(Buffer.from(JSON.stringify(body))); listeners.end?.() },
  }
  return req
}

const installedRoute = () => {
  const fixture = context(WAIT_ROUTE_CTX)
  const waitSkipRegistry = createWaitSkipRegistry()
  registerTerminalTool(fixture.ctx, { version: '0.2.1-rc.3', defineTool, waitSkipRegistry })
  const route = fixture.routes.at(-1)
  assert.notEqual(route, undefined, 'skip 路由应随工具注册')
  return { fixture, route, waitSkipRegistry }
}

test('Given skip route installation, When registering and disposing, Then the route joins and leaves the webServer', () => {
  const { fixture, route } = installedRoute()
  assert.equal(fixture.routes.length, 1)
  assert.match(route.path, /wait\/skip$/)
  assert.equal(typeof route.handler, 'function')
  fixture.dispose()
  assert.equal(fixture.routes.length, 0)
})

test('Given an in-flight wait, When POSTing skip, Then the pending controller aborts and the route reports the count', async () => {
  const { fixture, route, waitSkipRegistry } = installedRoute()
  const pending = new AbortController()
  waitSkipRegistry.register('session-a:term-a', pending)
  const res = stubRes()
  const req = stubReq({ sessionId: 'session-a', terminalId: 'term-a' })
  const handled = route.handler(req, res)
  req.emit()
  await handled
  assert.deepEqual(JSON.parse(res.body), { ok: true, skipped: 1 })
  assert.equal(pending.signal.aborted, true, '同键 pending wait 须被中断')
  fixture.dispose()
})

test('Given no in-flight wait, When POSTing skip, Then the route stays idempotent with zero', async () => {
  const { fixture, route } = installedRoute()
  const res = stubRes()
  const req = stubReq({ sessionId: 's', terminalId: 't' })
  const handled = route.handler(req, res)
  req.emit()
  await handled
  assert.deepEqual(JSON.parse(res.body), { ok: true, skipped: 0 })
})

test('Given cross-origin or wrong-method or malformed skip requests, When handled, Then they are rejected', async () => {
  const { fixture, route } = installedRoute()
  const cross = stubRes()
  const crossReq = stubReq({ sessionId: 's', terminalId: 't' }, { origin: 'http://evil.example', host: 'localhost:3080' })
  const crossHandled = route.handler(crossReq, cross)
  crossReq.emit()
  await crossHandled
  assert.equal(cross.statusCode, 403)
  const wrongMethod = stubRes()
  await route.handler({ ...stubReq({ sessionId: 's', terminalId: 't' }), method: 'GET' }, wrongMethod)
  assert.equal(wrongMethod.statusCode, 405)
  const badBody = stubRes()
  const badReq = stubReq({ sessionId: '', terminalId: 't' })
  const badHandled = route.handler(badReq, badBody)
  badReq.emit()
  await badHandled
  assert.equal(badBody.statusCode, 400)
})

test('Given an oversized body, When POSTing skip, Then the route answers 413 and destroys the socket only after the response finishes', async () => {
  const { fixture, route } = installedRoute()
  const res = stubRes()
  const listeners = {}
  const req = {
    method: 'POST',
    headers: { host: 'localhost:3080' },
    destroyed: false,
    on(name, listener) {
      if (name === 'data') {
        // 模拟超限流入:第一块即超上限,随后流入暂停
        listener(Buffer.alloc(65 * 1024))
      }
      listeners[name] = listener
    },
    pause() { req.paused = true },
    destroy() { req.destroyed = true },
  }
  const handled = route.handler(req, res)
  await handled
  // 修复语义:413 响应经 sendJson 完整送出(finish)之后才允许销毁 socket,响应不再丢失
  assert.equal(res.statusCode, 413)
  assert.match(res.body, /超过上限/)
  assert.equal(req.paused, true, '超限须暂停流入')
  assert.equal(req.destroyed, true, 'finish 后收尾销毁')
})
