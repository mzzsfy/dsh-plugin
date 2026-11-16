import test from 'node:test'
import assert from 'node:assert/strict'
import { setupCommonTools, __test } from '../src/host.js'

function context(name = '@mzzsfy/a', connection = undefined, options = {}) {
  const cleanups = [], upgrades = new Map()
  return {
    fiber: { entry: { options: { name } } },
    webServer: {
      registerUpgrade(route) {
        if (options.failUpgrade) throw new Error('planned registerUpgrade failure')
        assert.equal(upgrades.has(route.path), false)
        upgrades.set(route.path, route)
        return () => upgrades.delete(route.path)
      },
    },
    upgrades,
    get(service) { return service === 'connection' ? connection : undefined },
    effect(fn) {
      if (options.failEffect) throw new Error('planned effect failure')
      cleanups.push(fn())
    },
    dispose() { while (cleanups.length) cleanups.pop()() },
  }
}
function isolate(t) {
  delete globalThis.__dshCommonTools
  const contexts = []
  t.after(() => { for (const ctx of contexts) ctx.dispose(); delete globalThis.__dshCommonTools })
  return (name, connection, options) => { const ctx = context(name, connection, options); contexts.push(ctx); return ctx }
}

test('Given 同插件多实例 When 一个卸载 Then 另一实例仍可发布且最后卸载清路由', t => {
  const ctx = isolate(t), a = ctx(), b = ctx()
  const first = setupCommonTools(a), second = setupCommonTools(b)
  first.publish('x')
  a.dispose()
  assert.throws(() => first.publish('x'), /卸载/)
  assert.doesNotThrow(() => second.publish('x'))
  assert.equal(a.upgrades.size, 1)
  b.dispose()
  assert.equal(a.upgrades.size, 0)
})

test('Given 非JSON或超界消息 When publish Then 同步拒绝且仍可发送合法数据', t => {
  const ctx = isolate(t), tools = setupCommonTools(ctx())
  const cycle = {}; cycle.self = cycle
  assert.throws(() => tools.publish(cycle), /circular/i)
  assert.throws(() => tools.publish('x'.repeat(1024 * 1024)), /上限/)
  for (const payload of [() => {}, Symbol('x'), { toJSON: () => undefined }]) assert.throws(() => tools.publish(payload), /payload/)
  // 不变量:判定只看根 payload 键是否被序列化,嵌套文本里的同名片段不构成误拒
  assert.doesNotThrow(() => tools.publish({ text: '"payload":' }))
  assert.doesNotThrow(() => tools.publish({ text: '甲' }))
})

test('Given 低版本在服 When 高版本接管 Then 旧门面仍可用且低版本后到不接管', t => {
  const ctx = isolate(t), oldCtx = ctx(), nextCtx = ctx('@mzzsfy/b')
  const old = __test.install(oldCtx, '1.0.0')
  const next = __test.install(nextCtx, '2.0.0')
  assert.equal(oldCtx.upgrades.size, 0)
  assert.equal(nextCtx.upgrades.size, 1)
  assert.doesNotThrow(() => old.publish('x'))
  assert.doesNotThrow(() => next.publish('x'))
  __test.install(ctx('@mzzsfy/c'), '1.1.0')
  assert.equal(nextCtx.upgrades.size, 1)
})

test('Given 同版本多消费方 When setup Then 不重复注册且监听随卸载失效', t => {
  const ctx = isolate(t), a = ctx(), b = ctx('@mzzsfy/b'), seen = []
  const tools = setupCommonTools(a)
  setupCommonTools(b)
  assert.equal(b.upgrades.size, 0)
  const off = tools.onPresence(n => seen.push(n))
  assert.deepEqual(seen, [0])
  off(); off()
  assert.equal(typeof tools.subscribe(() => {}), 'function')
  a.dispose()
  assert.throws(() => tools.subscribe(() => {}), /卸载/)
})

test('Given presence首次回调同步卸载 When 另一实例仍在 Then 不残留已卸载监听', t => {
  const ctx = isolate(t), a = ctx(), b = ctx('@mzzsfy/b')
  const tools = setupCommonTools(a)
  setupCommonTools(b)
  const stop = tools.onPresence(() => a.dispose())
  assert.equal(globalThis.__dshCommonTools.state.presence.has('@mzzsfy/a'), false)
  stop(); stop()
})

test('Given 缺少宿主WS能力 When setup Then 干净停用且不注册资源', () => {
  const tools = setupCommonTools({ fiber: { entry: { options: { name: '@mzzsfy/a' } } } })
  assert.equal(tools.publish(), undefined)
  assert.equal(typeof tools.subscribe(() => {}), 'function')
})

test('Given 缺失身份或非法listener When setup或订阅 Then 明确拒绝', t => {
  const ctx = isolate(t), tools = setupCommonTools(ctx())
  assert.throws(() => setupCommonTools({}), /entry.options.name/)
  assert.throws(() => tools.subscribe(null), /listener/)
  assert.throws(() => tools.onPresence(null), /listener/)
})

function fakeSocket() {
  const socket = { written: '', destroyed: false, write(text) { socket.written += text }, destroy() { socket.destroyed = true } }
  return socket
}

test('Given 宿主拒绝升级 When 连总线 Then 直接断开不建连', t => {
  const ctx = isolate(t)
  const host = ctx('@mzzsfy/a', { requestRejection: () => 401 })
  setupCommonTools(host)
  const route = [...host.upgrades.values()].find((item) => item.path === '/api/bus/ws')
  const socket = fakeSocket()
  route.handler({ headers: {} }, socket, {})
  assert.equal(socket.destroyed, true)
  assert.match(socket.written, /^HTTP\/1\.1 401/)
})

test('Given 闸门抛错 When 连总线 Then 按拒绝处理', t => {
  const ctx = isolate(t)
  const host = ctx('@mzzsfy/a', { requestRejection: () => { throw new Error('boom') } })
  setupCommonTools(host)
  const route = [...host.upgrades.values()].find((item) => item.path === '/api/bus/ws')
  const socket = fakeSocket()
  route.handler({ headers: {} }, socket, {})
  assert.equal(socket.destroyed, true)
  assert.match(socket.written, /^HTTP\/1\.1 403/)
})

test('Given 宿主放行 When 连总线 Then 交给 websocket 升级而不断开', t => {
  const ctx = isolate(t)
  const host = ctx('@mzzsfy/a', { requestRejection: () => undefined })
  setupCommonTools(host)
  const route = [...host.upgrades.values()].find((item) => item.path === '/api/bus/ws')
  const socket = fakeSocket()
  // 非真实 socket:ws 在升级握手处抛错,只要没被闸门提前 destroy 即算放行
  try { route.handler({ headers: {} }, socket, {}) } catch { /* 交给 ws 后必然失败 */ }
  assert.equal(socket.destroyed, false)
  assert.equal(socket.written, '')
})

test('Given Origin 与 Host 仅大小写不同 When 判定发布资格 Then 同源放行', () => {
  const cases = [
    ['http://EXAMPLE.com', 'example.com'],
    ['http://example.com', 'EXAMPLE.COM'],
    ['http://Example.COM:8080', 'example.com:8080'],
    ['http://[::1]:8080', '[::1]:8080'],
  ]
  for (const [origin, host] of cases) assert.equal(__test.canPublishFrom(origin, host), true, `${origin} ↔ ${host}`)
})

test('Given 跨源、非法 Origin 或 Host 缺失 When 判定发布资格 Then fail-closed', () => {
  assert.equal(__test.canPublishFrom('http://evil.test', 'example.com'), false)
  assert.equal(__test.canPublishFrom('http://example.com:8080', 'example.com:9090'), false)
  assert.equal(__test.canPublishFrom('not a url', 'example.com'), false)
  assert.equal(__test.canPublishFrom('http://example.com', undefined), false)
  assert.equal(__test.canPublishFrom(undefined, 'example.com'), true)
})

test('Given 生命周期 effect 抛错 When setup Then 清理本调用并拆除新建传输', t => {
  const ctx = isolate(t), host = ctx('@mzzsfy/a', undefined, { failEffect: true })
  assert.throws(() => setupCommonTools(host), /planned effect failure/)
  const reg = globalThis.__dshCommonTools
  assert.equal(reg.callers.size, 0, '失败调用者 token 已回滚')
  assert.equal(reg.active, null, '无共享调用者时新建传输已拆除')
  assert.equal(host.upgrades.size, 0, '路由已注销,不留空路由')
})

test('Given 高版本接管创建传输失败 When 同版本再装 Then 回滚死传输且可重建', t => {
  const ctx = isolate(t)
  const oldCtx = ctx()
  const failedCtx = ctx('@mzzsfy/b', undefined, { failUpgrade: true })
  const retryCtx = ctx('@mzzsfy/c')
  const old = __test.install(oldCtx, '1.0.0')
  old.publish('before')
  const warnings = []
  const original = console.warn
  console.warn = (...args) => warnings.push(args.join(' '))
  let failed
  try {
    failed = __test.install(failedCtx, '2.0.0')
  } finally {
    console.warn = original
  }
  // 创建失败按干净禁用返回 noop 门面,不把消费方 apply 打成失败
  assert.doesNotThrow(() => failed.publish('noop'))
  assert.equal(typeof failed.subscribe(() => {}), 'function')
  assert.equal(typeof failed.onPresence(() => {}), 'function')
  assert.ok(warnings.some(line => line.includes('接管失败')), '应留降级告警')
  const reg = globalThis.__dshCommonTools
  assert.equal(reg.active, null, '不得停在已 teardown 的旧传输')
  assert.equal([...reg.callers.values()].includes('@mzzsfy/b'), false, '失败调用者的 token 已回滚')
  assert.equal(failedCtx.upgrades.size, 0)
  assert.equal(oldCtx.upgrades.size, 0, '旧传输已拆除')
  assert.throws(() => old.publish('dead'), /总线传输不可用/, '既有门面不得静默成功')
  const rebuilt = __test.install(retryCtx, '2.0.0')
  assert.equal(retryCtx.upgrades.size, 1, '失败后可重建传输')
  assert.doesNotThrow(() => old.publish('after-rebuild'), '旧门面动态转发到重建后的传输')
  assert.doesNotThrow(() => rebuilt.publish('new'))
  oldCtx.dispose()
  assert.equal(retryCtx.upgrades.size, 1, '仅剩新调用者时传输继续存活')
  retryCtx.dispose()
  assert.equal(retryCtx.upgrades.size, 0)
})

test('Given 传输已 teardown When 重复清理 Then 幂等不抛错', t => {
  const ctx = isolate(t), host = ctx()
  setupCommonTools(host)
  const transport = globalThis.__dshCommonTools.active
  transport.teardown()
  assert.doesNotThrow(() => transport.teardown())
  assert.doesNotThrow(() => host.dispose())
})

test('Given 合法消息 When publish Then 热路径不做整帧 JSON 再解析', t => {
  const ctx = isolate(t), tools = setupCommonTools(ctx())
  const original = JSON.parse
  let parses = 0
  JSON.parse = function (...args) { parses += 1; return original.apply(this, args) }
  try {
    tools.publish({ text: '甲'.repeat(1024) })
  } finally {
    JSON.parse = original
  }
  assert.equal(parses, 0, 'payload 校验应复用 stringify 结果,不得 JSON.parse 整帧')
})
