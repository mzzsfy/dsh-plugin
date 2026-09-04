// 包装行为测试:mock webServer(实例形态与官方一致:三 Map + fallback 字段 +
// 原型注册方法)与 mock webRuntime/ctx,不起真服务器。
// Given-When-Then 场景见各用例注释,规格源 docs/design/dsh-auto-trust-all.md。
import test from 'node:test'
import assert from 'node:assert/strict'

import { apply, Config } from '../src/index.js'

const DEFAULT_MAX_HOSTS = 100

class MockWebServer {
  exact = new Map()
  prefixes = new Map()
  upgrades = new Map()
  fallback = undefined

  constructor(host = '0.0.0.0') {
    this.host = host
  }

  register(route) {
    const table = route.kind === 'exact' ? this.exact : this.prefixes
    table.set(route.path, route)
    return () => table.delete(route.path)
  }

  registerUpgrade(route) {
    this.upgrades.set(route.path, route)
    return () => this.upgrades.delete(route.path)
  }

  registerFallback(handler) {
    this.fallback = handler
    return () => { this.fallback = undefined }
  }
}

// 构造最小插件上下文:webServer 静态注入,webRuntime 经 ctx.get 可选探测
// (与真实 cordis 语义一致),holder.current 支持测试中延迟就绪或换代;
// ctx.on 收集事件监听器供模拟触发;console 输出经 t.mock 捕获,测试结束自动还原
function createCtx({ trustedHosts = [], host = '0.0.0.0', webRuntimeReady = true } = {}) {
  const webServer = new MockWebServer(host)
  const holder = { current: webRuntimeReady ? { trustedHosts } : undefined }
  const listeners = []
  const ctx = {
    webServer,
    get: (name) => (name === 'webRuntime' ? holder.current : undefined),
    on: (name, listener) => {
      listeners.push([name, listener])
      return () => {}
    },
  }
  return { ctx, webServer, holder, trustedHosts, listeners }
}

const mockConsole = (t) => {
  const output = []
  t.mock.method(console, 'log', (...args) => output.push(['log', args.join(' ')]))
  t.mock.method(console, 'warn', (...args) => output.push(['warn', args.join(' ')]))
  return output
}

test('场景1 回溯包装: Given 激活前已注册路由 When 未注册 Host 请求到达 Then hostname 进信任清单且原 handler 透传', async (t) => {
  const output = mockConsole(t)
  const { ctx, webServer, trustedHosts } = createCtx()
  const calls = []
  webServer.register({ kind: 'exact', path: '/api/x', handler: async (req, res) => { calls.push([req, res]) } })
  webServer.register({ kind: 'prefix', path: '/api', handler: async () => { calls.push('prefix') } })
  webServer.registerUpgrade({ path: '/ws', handler: async () => { calls.push('upgrade') } })

  apply(ctx, { maxHosts: DEFAULT_MAX_HOSTS })

  const route = webServer.exact.get('/api/x')
  const req = { headers: { host: 'probe.jze100.com' } }
  const res = {}
  await route.handler(req, res)
  await webServer.prefixes.get('/api').handler(req, res)
  await webServer.upgrades.get('/ws').handler(req, {}, null)

  assert.deepEqual(trustedHosts, ['probe.jze100.com'])
  assert.equal(calls.length, 3)
  assert.equal(calls[0][0], req)
  assert.equal(calls[0][1], res)
  assert.ok(output.some(([, message]) => message === 'auto-trust-all: registered host probe.jze100.com'))
})

test('场景2 去重: Given 同一 Host 重复请求 Then 数组只增一条', async (t) => {
  mockConsole(t)
  const { ctx, webServer, trustedHosts } = createCtx()
  webServer.register({ kind: 'exact', path: '/api/x', handler: async () => {} })
  apply(ctx, { maxHosts: DEFAULT_MAX_HOSTS })

  const route = webServer.exact.get('/api/x')
  await route.handler({ headers: { host: 'probe.jze100.com' } }, {})
  await route.handler({ headers: { host: 'probe.jze100.com' } }, {})
  await route.handler({ headers: { host: 'probe.jze100.com:8443' } }, {})

  assert.deepEqual(trustedHosts, ['probe.jze100.com'])
})

test('场景3 提取形态: Given 带端口或大小写或 IPv6 括号的 Host 头 Then 注册闸门比较形态的 hostname', async (t) => {
  mockConsole(t)
  const { ctx, webServer, trustedHosts } = createCtx()
  webServer.register({ kind: 'exact', path: '/api/x', handler: async () => {} })
  apply(ctx, { maxHosts: DEFAULT_MAX_HOSTS })

  const route = webServer.exact.get('/api/x')
  await route.handler({ headers: { host: 'Probe.Jze100.com:8443' } }, {})
  await route.handler({ headers: { host: '[::1]:3080' } }, {})

  // WHATWG hostname 对 IPv6 保留方括号,与闸门 parseAuthority 的比较形态一致
  assert.deepEqual(trustedHosts, ['probe.jze100.com', '[::1]'])
})

test('场景4 FIFO 容量: Given 达到 maxHosts When 新 Host 到达 Then 淘汰最早注册者且总量恒定', async (t) => {
  mockConsole(t)
  const { ctx, webServer, trustedHosts } = createCtx()
  webServer.register({ kind: 'exact', path: '/api/x', handler: async () => {} })
  apply(ctx, { maxHosts: 2 })

  const route = webServer.exact.get('/api/x')
  await route.handler({ headers: { host: 'first.test' } }, {})
  await route.handler({ headers: { host: 'second.test' } }, {})
  await route.handler({ headers: { host: 'third.test' } }, {})

  assert.deepEqual(trustedHosts, ['second.test', 'third.test'])
})

test('场景13 官方条目保护: Given 官方初始条目在场 When FIFO 淘汰 Then 只淘汰本插件注册的条目', async (t) => {
  mockConsole(t)
  const { ctx, webServer, trustedHosts } = createCtx({ trustedHosts: ['192.168.1.5'] })
  webServer.register({ kind: 'exact', path: '/api/x', handler: async () => {} })
  apply(ctx, { maxHosts: 1 })

  const route = webServer.exact.get('/api/x')
  await route.handler({ headers: { host: 'first.test' } }, {})
  await route.handler({ headers: { host: 'second.test' } }, {})

  assert.deepEqual(trustedHosts, ['192.168.1.5', 'second.test'])
})

test('场景5 影子注册: Given 激活后新注册的路由 When 请求到达 Then 同样注册 Host 且注册语义不变', async (t) => {
  mockConsole(t)
  const { ctx, webServer, trustedHosts } = createCtx()
  apply(ctx, { maxHosts: DEFAULT_MAX_HOSTS })

  const disposer = webServer.register({ kind: 'exact', path: '/api/new', handler: async () => {} })
  await webServer.exact.get('/api/new').handler({ headers: { host: 'late.jze100.com' } }, {})
  disposer()

  assert.deepEqual(trustedHosts, ['late.jze100.com'])
  assert.equal(webServer.exact.has('/api/new'), false)
})

test('场景12 影子 upgrade: Given 激活后经影子方法注册的 upgrade 路由 When 请求到达 Then 同样注册 Host', async (t) => {
  mockConsole(t)
  const { ctx, webServer, trustedHosts } = createCtx()
  apply(ctx, { maxHosts: DEFAULT_MAX_HOSTS })

  webServer.registerUpgrade({ path: '/ws/new', handler: async () => {} })
  await webServer.upgrades.get('/ws/new').handler({ headers: { host: 'ws.jze100.com' } }, {}, null)

  assert.deepEqual(trustedHosts, ['ws.jze100.com'])
})

test('场景6a 影子链: Given 会话层先遮蔽注册方法 When 本插件激活后新路由注册 Then 会话包装与 Host 注册同时生效', async (t) => {
  mockConsole(t)
  const { ctx, webServer, trustedHosts } = createCtx()
  // 模拟 startup-auth 先激活:实例属性遮蔽 register,包装 handler 模拟会话检查
  const sessionChecked = []
  const prototypeRegister = webServer.register
  webServer.register = (route) => {
    const original = route.handler
    route.handler = async (req, res) => {
      sessionChecked.push(req)
      return original(req, res)
    }
    return prototypeRegister.call(webServer, route)
  }

  apply(ctx, { maxHosts: DEFAULT_MAX_HOSTS })
  webServer.register({ kind: 'exact', path: '/api/auth', handler: async () => {} })
  const req = { headers: { host: 'chained.jze100.com' } }
  await webServer.exact.get('/api/auth').handler(req, {})

  assert.deepEqual(trustedHosts, ['chained.jze100.com'])
  assert.deepEqual(sessionChecked, [req])
})

test('场景6b 影子链: Given 本插件先激活 When 会话层后遮蔽注册方法 Then 两者包装叠加且 Host 注册在内层', async (t) => {
  mockConsole(t)
  const { ctx, webServer, trustedHosts } = createCtx()
  apply(ctx, { maxHosts: DEFAULT_MAX_HOSTS })

  // 模拟 startup-auth 后激活:遮蔽时捕获当前值(本插件的影子)并叠加会话包装
  const sessionChecked = []
  const previousRegister = webServer.register
  webServer.register = (route) => {
    const original = route.handler
    route.handler = async (req, res) => {
      sessionChecked.push(req)
      return original(req, res)
    }
    return previousRegister.call(webServer, route)
  }

  webServer.register({ kind: 'exact', path: '/api/auth', handler: async () => {} })
  const req = { headers: { host: 'stacked.jze100.com' } }
  await webServer.exact.get('/api/auth').handler(req, {})

  assert.deepEqual(trustedHosts, ['stacked.jze100.com'])
  assert.deepEqual(sessionChecked, [req])
})

test('场景7 fallback: Given 回溯与影子注册两条路径的 fallback 请求 Then 同样注册 Host', async (t) => {
  mockConsole(t)
  const { ctx, webServer, trustedHosts } = createCtx()
  const existing = async () => {}
  webServer.fallback = existing
  apply(ctx, { maxHosts: DEFAULT_MAX_HOSTS })

  await webServer.fallback({ headers: { host: 'via-fallback.jze100.com' } }, {})
  webServer.registerFallback(async () => {})
  await webServer.fallback({ headers: { host: 'via-shadow.jze100.com' } }, {})

  assert.deepEqual(trustedHosts, ['via-fallback.jze100.com', 'via-shadow.jze100.com'])
})

test('场景8 脏输入: Given 无 Host 头或非法 Host 头 When 请求到达 Then 不注册不抛错且原 handler 照常执行', async (t) => {
  mockConsole(t)
  const { ctx, webServer, trustedHosts } = createCtx()
  const calls = []
  webServer.register({ kind: 'exact', path: '/api/x', handler: async (req) => { calls.push(req) } })
  apply(ctx, { maxHosts: DEFAULT_MAX_HOSTS })

  const route = webServer.exact.get('/api/x')
  await route.handler({ headers: {} }, {})
  // 空格与超范围端口都是 WHATWG 解析拒绝的形态,闸门 parseAuthority 同样返回 undefined
  await route.handler({ headers: { host: 'bad host' } }, {})
  await route.handler({ headers: { host: 'host:99999' } }, {})
  await route.handler({}, {})

  assert.deepEqual(trustedHosts, [])
  assert.equal(calls.length, 4)
})

test('场景9 幂等重载: Given 本插件重复激活(HMR 重载模拟) When 再次激活 Then 路由 handler 与影子方法都不叠加', async (t) => {
  mockConsole(t)
  const { ctx, webServer, trustedHosts } = createCtx()
  webServer.register({ kind: 'exact', path: '/api/x', handler: async () => {} })
  apply(ctx, { maxHosts: DEFAULT_MAX_HOSTS })
  const wrappedOnce = webServer.exact.get('/api/x').handler
  const shadowOnce = webServer.register
  const fallbackShadowOnce = webServer.registerFallback

  apply(ctx, { maxHosts: DEFAULT_MAX_HOSTS })

  assert.equal(webServer.exact.get('/api/x').handler, wrappedOnce)
  assert.equal(webServer.register, shadowOnce)
  assert.equal(webServer.registerFallback, fallbackShadowOnce)
  await webServer.exact.get('/api/x').handler({ headers: { host: 'reload.jze100.com' } }, {})
  assert.deepEqual(trustedHosts, ['reload.jze100.com'])
})

test('场景11 启动横幅: Given 插件激活 Then console 输出绑定、容量与既有信任条目', (t) => {
  const output = mockConsole(t)
  const { ctx } = createCtx({ trustedHosts: ['192.168.1.5', 'lan.example.com'] })

  apply(ctx, { maxHosts: 50 })

  const banner = output.map(([, message]) => message).find((message) => message.includes('动态信任已启用'))
  assert.ok(banner !== undefined)
  assert.ok(output.some(([, message]) => message.includes('bind 0.0.0.0')))
  assert.ok(output.some(([, message]) => message.includes('容量 50')))
  assert.ok(output.some(([, message]) => message.includes('192.168.1.5, lan.example.com')))
})

test('场景11b 启动横幅空清单: Given 无既有条目 Then 输出"无"占位', (t) => {
  const output = mockConsole(t)
  const { ctx } = createCtx({ trustedHosts: [] })

  apply(ctx, { maxHosts: DEFAULT_MAX_HOSTS })

  assert.ok(output.some(([, message]) => message.includes('既有信任 0 项: 无')))
})

test('场景14 数组重建: Given webRuntime 提供新数组 When 已注册域名再次到达 Then 重新登记进新数组且队列随代重置', async (t) => {
  mockConsole(t)
  const { ctx, webServer, holder, trustedHosts } = createCtx()
  webServer.register({ kind: 'exact', path: '/api/x', handler: async () => {} })
  apply(ctx, { maxHosts: 1 })

  const route = webServer.exact.get('/api/x')
  await route.handler({ headers: { host: 'first.test' } }, {})
  assert.deepEqual(trustedHosts, ['first.test'])

  // 模拟 web-app 行重载:webRuntime 重建,新数组只含官方初始条目
  const rebuilt = ['10.0.0.2']
  holder.current = { trustedHosts: rebuilt }
  await route.handler({ headers: { host: 'first.test' } }, {})
  assert.deepEqual(rebuilt, ['10.0.0.2', 'first.test'])

  // 新一代容量 1 已满:second.test 到达淘汰 first.test,证明队列已随代重置
  await route.handler({ headers: { host: 'second.test' } }, {})
  assert.deepEqual(rebuilt, ['10.0.0.2', 'second.test'])
})

test('场景15 容量下界: Given maxHosts 小于 1 Then schema 校验拒绝,缺省解出默认 100', () => {
  assert.ok(Config['~standard'].validate({ maxHosts: 0 }).issues)
  assert.ok(Config['~standard'].validate({ maxHosts: -1 }).issues)
  assert.ok(Config['~standard'].validate({ maxHosts: 1.5 }).issues)
  assert.equal(Config['~standard'].validate({}).value.maxHosts, 100)
})

test('场景16 淘汰重访: Given 条目被 FIFO 淘汰 When 该域名再次到达 Then 重新注册(不被去重记忆拉黑)', async (t) => {
  mockConsole(t)
  const { ctx, webServer, trustedHosts } = createCtx()
  webServer.register({ kind: 'exact', path: '/api/x', handler: async () => {} })
  apply(ctx, { maxHosts: 1 })

  const route = webServer.exact.get('/api/x')
  await route.handler({ headers: { host: 'first.test' } }, {})
  await route.handler({ headers: { host: 'second.test' } }, {})
  assert.deepEqual(trustedHosts, ['second.test'])

  await route.handler({ headers: { host: 'first.test' } }, {})
  assert.deepEqual(trustedHosts, ['first.test'])
})

test('场景17 换代移交: Given 行级 config 变更触发重跑 apply When 请求到达已包装路由 Then 注册走新一代容量', async (t) => {
  mockConsole(t)
  const { ctx, webServer, trustedHosts } = createCtx()
  webServer.register({ kind: 'exact', path: '/api/x', handler: async () => {} })
  const dispose1 = apply(ctx, { maxHosts: 1 })

  const route = webServer.exact.get('/api/x')
  const wrappedOnce = route.handler
  await route.handler({ headers: { host: 'first.test' } }, {})

  // 模拟行级 config 变更:先卸载(carrier 置空)再重跑 apply,handler 带标记跳过
  // 重包装,但共享载体被新代覆盖,旧包装经载体用新容量注册
  dispose1()
  assert.equal(webServer.autoTrustAllRegister('x'), undefined)
  apply(ctx, { maxHosts: 2 })
  assert.equal(route.handler, wrappedOnce)

  await route.handler({ headers: { host: 'second.test' } }, {})
  await route.handler({ headers: { host: 'third.test' } }, {})
  // 新代只记自身条目:second/third 共 2 条未超容量,first 属上代遗留视同官方条目
  assert.deepEqual(trustedHosts, ['first.test', 'second.test', 'third.test'])

  await route.handler({ headers: { host: 'fourth.test' } }, {})
  // 新代容量 2 生效:fourth 淘汰新代最早的 second,遗留条目不参与记账
  assert.deepEqual(trustedHosts, ['first.test', 'third.test', 'fourth.test'])
})

test('场景18 延迟激活: Given 激活时 webRuntime 未就绪 When 挂事件监听且服务就绪事件到达 Then 自动完成激活', async (t) => {
  const output = mockConsole(t)
  const { ctx, webServer, holder, trustedHosts, listeners } = createCtx({ webRuntimeReady: false })
  webServer.register({ kind: 'exact', path: '/api/x', handler: async () => {} })
  const handlerBefore = webServer.exact.get('/api/x').handler

  const dispose = apply(ctx, { maxHosts: DEFAULT_MAX_HOSTS })

  // 未就绪路径:不包装、不挂载体,挂 internal/service 监听并输出等待行
  assert.equal(webServer.exact.get('/api/x').handler, handlerBefore)
  assert.equal(webServer.autoTrustAllRegister, undefined)
  assert.deepEqual(listeners.map(([name]) => name), ['internal/service'])
  assert.ok(output.some(([, message]) => message.includes('webRuntime 未就绪')))

  // 模拟 web-app fiber 激活完成:runtime 就绪并发出服务事件
  holder.current = { trustedHosts: [] }
  const [, listener] = listeners[0]
  listener('webRuntime')
  assert.notEqual(webServer.exact.get('/api/x').handler, handlerBefore)
  assert.equal(typeof webServer.autoTrustAllRegister, 'function')
  assert.ok(output.some(([, message]) => message.includes('动态信任已启用')))

  await webServer.exact.get('/api/x').handler({ headers: { host: 'late.jze100.com' } }, {})
  assert.deepEqual(holder.current.trustedHosts, ['late.jze100.com'])
  dispose()
  assert.equal(webServer.autoTrustAllRegister('x'), undefined)
})

test('场景20 卸载断开: Given 已激活 When 卸载 Then 载体置空,后续请求纯透传不再注册', async (t) => {
  mockConsole(t)
  const { ctx, webServer, trustedHosts } = createCtx()
  webServer.register({ kind: 'exact', path: '/api/x', handler: async () => {} })
  const dispose = apply(ctx, { maxHosts: DEFAULT_MAX_HOSTS })

  const route = webServer.exact.get('/api/x')
  await route.handler({ headers: { host: 'before.test' } }, {})
  assert.deepEqual(trustedHosts, ['before.test'])

  dispose()
  await route.handler({ headers: { host: 'after.test' } }, {})
  assert.deepEqual(trustedHosts, ['before.test'])
})

test('场景21 激活幂等: Given 事件路径激活后服务再次发事件 When 重复触发 Then 不重复激活(横幅与载体不换代)', (t) => {
  const output = mockConsole(t)
  const { ctx, webServer, holder, listeners } = createCtx({ webRuntimeReady: false })
  apply(ctx, { maxHosts: DEFAULT_MAX_HOSTS })

  holder.current = { trustedHosts: ['10.0.0.9'] }
  const [, listener] = listeners[0]
  listener('webRuntime')
  const carrier = webServer.autoTrustAllRegister

  listener('webRuntime')

  assert.equal(webServer.autoTrustAllRegister, carrier)
  assert.equal(output.filter(([, message]) => message.includes('动态信任已启用')).length, 1)
})
