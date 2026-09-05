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

// 构造最小插件上下文:webServer 静态注入,webRuntime/connection 经 ctx.get 可选探测
// (与真实 cordis 语义一致,strict get 对未提供服务返回 undefined),
// holder.current 支持测试中延迟就绪或换代;ctx.on 收集事件监听器供模拟触发;
// console 输出经 t.mock 捕获,测试结束自动还原
function createCtx({ trustedHosts = [], host = '0.0.0.0', webRuntimeReady = true, connectionReady = true } = {}) {
  const webServer = new MockWebServer(host)
  const holder = { current: webRuntimeReady ? { trustedHosts } : undefined }
  const fenceHosts = []
  const listeners = []
  const ctx = {
    webServer,
    get: (name) => {
      if (name === 'webRuntime') return holder.current
      if (name === 'connection') return connectionReady ? { trustedHosts: fenceHosts } : undefined
      return undefined
    },
    on: (name, listener) => {
      listeners.push([name, listener])
      return () => {}
    },
  }
  return { ctx, webServer, holder, trustedHosts, fenceHosts, listeners }
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
  await route.handler({ headers: { host: '[2001:db8::1]:3080' } }, {})

  // WHATWG hostname 对 IPv6 保留方括号,与闸门 parseAuthority 的比较形态一致;
  // loopback([::1] 等)不登记,见场景3b
  assert.deepEqual(trustedHosts, ['probe.jze100.com', '[2001:db8::1]'])
})

test('场景3b loopback 跳过: Given loopback 形态的 Host 头 When 请求到达 Then 不登记,*.localhost 照常登记(官方闸门仅恒放行精确 loopback)', async (t) => {
  const output = mockConsole(t)
  const { ctx, webServer, trustedHosts } = createCtx()
  webServer.register({ kind: 'exact', path: '/api/x', handler: async () => {} })
  apply(ctx, { maxHosts: DEFAULT_MAX_HOSTS })

  const route = webServer.exact.get('/api/x')
  await route.handler({ headers: { host: 'localhost:3080' } }, {})
  await route.handler({ headers: { host: '127.0.0.1' } }, {})
  await route.handler({ headers: { host: '[::1]:3080' } }, {})
  assert.deepEqual(trustedHosts, [])
  assert.equal(output.filter(([, message]) => message.includes('registered host')).length, 0)

  // 官方 isLoopbackHostname 无 *.localhost 分支,该形态需登记才可达
  await route.handler({ headers: { host: 'sub.localhost' } }, {})
  assert.deepEqual(trustedHosts, ['sub.localhost'])
})

test('场景4 LRU 容量: Given 达到 maxHosts When 新 Host 到达 Then 淘汰最久未访问者且总量恒定', async (t) => {
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

test('场景13 官方条目保护: Given 官方初始条目在场 When 容量淘汰 Then 只淘汰本插件注册的条目', async (t) => {
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

test('场景14 数组重建: Given webRuntime 提供新数组 When 已注册域名再次到达 Then 重新登记进新数组且记账随代重置', async (t) => {
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

  // 新一代容量 1 已满:second.test 到达淘汰 first.test,证明归属记账已随代重置
  await route.handler({ headers: { host: 'second.test' } }, {})
  assert.deepEqual(rebuilt, ['10.0.0.2', 'second.test'])
})

test('场景15 容量边界: Given maxHosts 越界 Then schema 校验拒绝,下界 1 上界 4096,缺省解出默认 100', () => {
  assert.ok(Config['~standard'].validate({ maxHosts: 0 }).issues)
  assert.ok(Config['~standard'].validate({ maxHosts: -1 }).issues)
  assert.ok(Config['~standard'].validate({ maxHosts: 1.5 }).issues)
  assert.ok(Config['~standard'].validate({ maxHosts: 4097 }).issues)
  assert.ok(!Config['~standard'].validate({ maxHosts: 4096 }).issues)
  assert.equal(Config['~standard'].validate({}).value.maxHosts, 100)
})

test('场景16 淘汰重访: Given 条目被 LRU 淘汰 When 该域名再次到达 Then 重新注册(不被去重记忆拉黑)', async (t) => {
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

  // 模拟行级 config 变更:旧代卸载撤销其注册条目(first.test 被移除),随后
  // 重跑 apply,handler 带标记跳过重包装,但共享载体被新代覆盖,旧包装经载体用新容量注册
  dispose1()
  assert.deepEqual(trustedHosts, [])
  assert.equal(typeof webServer.autoTrustAllRegister, 'function')
  apply(ctx, { maxHosts: 2 })
  assert.equal(route.handler, wrappedOnce)

  await route.handler({ headers: { host: 'second.test' } }, {})
  await route.handler({ headers: { host: 'third.test' } }, {})
  // 新代只记自身条目:second/third 共 2 条未超容量,first 已随旧代撤销
  assert.deepEqual(trustedHosts, ['second.test', 'third.test'])

  await route.handler({ headers: { host: 'fourth.test' } }, {})
  // 新代容量 2 生效:fourth 淘汰新代最久未访问的 second
  assert.deepEqual(trustedHosts, ['third.test', 'fourth.test'])
})

test('场景18 延迟激活: Given 激活时 webRuntime 未就绪 When 挂事件监听且服务就绪事件到达 Then 自动完成激活', async (t) => {
  const output = mockConsole(t)
  const { ctx, webServer, holder, trustedHosts, fenceHosts, listeners } = createCtx({ webRuntimeReady: false })
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
  // 卸载撤销本代放行:两侧数组的 late 条目均被移除,后续请求经空载体纯透传不再注册
  assert.deepEqual(holder.current.trustedHosts, [])
  assert.deepEqual(fenceHosts, [])
})

test('场景20 卸载撤销: Given 已激活 When 卸载 Then 载体断开且本代注册条目从两侧数组移除,后续请求纯透传', async (t) => {
  mockConsole(t)
  const { ctx, webServer, trustedHosts, fenceHosts } = createCtx()
  webServer.register({ kind: 'exact', path: '/api/x', handler: async () => {} })
  const dispose = apply(ctx, { maxHosts: DEFAULT_MAX_HOSTS })

  const route = webServer.exact.get('/api/x')
  await route.handler({ headers: { host: 'before.test' } }, {})
  assert.deepEqual(trustedHosts, ['before.test'])
  assert.deepEqual(fenceHosts, ['before.test'])

  dispose()
  assert.deepEqual(trustedHosts, [])
  assert.deepEqual(fenceHosts, [])
  await route.handler({ headers: { host: 'after.test' } }, {})
  assert.deepEqual(trustedHosts, [])
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

test('场景22 fence 双写: Given connection 服务在场 When 注册发生 Then fence 同步写入且去重不重复', async (t) => {
  mockConsole(t)
  const { ctx, webServer, trustedHosts, fenceHosts } = createCtx()
  webServer.register({ kind: 'exact', path: '/api/x', handler: async () => {} })
  apply(ctx, { maxHosts: DEFAULT_MAX_HOSTS })

  const route = webServer.exact.get('/api/x')
  await route.handler({ headers: { host: 'probe.jze100.com' } }, {})
  await route.handler({ headers: { host: 'probe.jze100.com' } }, {})
  await route.handler({ headers: {} }, {})

  assert.deepEqual(trustedHosts, ['probe.jze100.com'])
  assert.deepEqual(fenceHosts, ['probe.jze100.com'])
})

test('场景23 fence 淘汰同步: Given 容量淘汰发生 When webRuntime 侧移除条目 Then fence 侧同步移除', async (t) => {
  mockConsole(t)
  const { ctx, webServer, trustedHosts, fenceHosts } = createCtx()
  webServer.register({ kind: 'exact', path: '/api/x', handler: async () => {} })
  apply(ctx, { maxHosts: 1 })

  const route = webServer.exact.get('/api/x')
  await route.handler({ headers: { host: 'first.test' } }, {})
  await route.handler({ headers: { host: 'second.test' } }, {})

  assert.deepEqual(trustedHosts, ['second.test'])
  assert.deepEqual(fenceHosts, ['second.test'])
})

test('场景24 fence 缺失降级: Given connection 服务缺失 When 注册发生 Then 仅 webRuntime 侧生效且不抛错', async (t) => {
  mockConsole(t)
  const { ctx, webServer, trustedHosts } = createCtx({ connectionReady: false })
  webServer.register({ kind: 'exact', path: '/api/x', handler: async () => {} })
  apply(ctx, { maxHosts: DEFAULT_MAX_HOSTS })

  const route = webServer.exact.get('/api/x')
  await route.handler({ headers: { host: 'probe.jze100.com' } }, {})

  assert.deepEqual(trustedHosts, ['probe.jze100.com'])
})

test('场景25 LRU 续期: Given 容量已满 When 最早注册者被再次访问 Then 新条目淘汰的是最久未访问者', async (t) => {
  mockConsole(t)
  const { ctx, webServer, trustedHosts } = createCtx()
  webServer.register({ kind: 'exact', path: '/api/x', handler: async () => {} })
  apply(ctx, { maxHosts: 2 })

  const route = webServer.exact.get('/api/x')
  await route.handler({ headers: { host: 'first.test' } }, {})
  await route.handler({ headers: { host: 'second.test' } }, {})
  // first 被再次访问完成续期:最久未访问者变为 second
  await route.handler({ headers: { host: 'first.test' } }, {})
  await route.handler({ headers: { host: 'third.test' } }, {})

  assert.deepEqual(trustedHosts, ['first.test', 'third.test'])
})

test('场景26 官方条目命中: Given 请求 Host 等于官方既有条目 When 注册发生 Then 不入记账不被淘汰不重复输出', async (t) => {
  const output = mockConsole(t)
  const { ctx, webServer, trustedHosts } = createCtx({ trustedHosts: ['lan.test'] })
  webServer.register({ kind: 'exact', path: '/api/x', handler: async () => {} })
  apply(ctx, { maxHosts: 1 })

  const route = webServer.exact.get('/api/x')
  await route.handler({ headers: { host: 'lan.test' } }, {})
  assert.deepEqual(trustedHosts, ['lan.test'])
  assert.equal(output.filter(([, message]) => message.includes('registered host')).length, 0)

  await route.handler({ headers: { host: 'a.test' } }, {})
  assert.deepEqual(trustedHosts, ['lan.test', 'a.test'])
  await route.handler({ headers: { host: 'b.test' } }, {})
  assert.deepEqual(trustedHosts, ['lan.test', 'b.test'])

  await route.handler({ headers: { host: 'lan.test' } }, {})
  assert.deepEqual(trustedHosts, ['lan.test', 'b.test'])
})

test('场景27 注册失败限频: Given 载体抛错 When 请求到达 Then 原 handler 照常执行且告警恰一次,恢复后复位再告警', async (t) => {
  const output = mockConsole(t)
  const { ctx, webServer, trustedHosts } = createCtx()
  const calls = []
  webServer.register({ kind: 'exact', path: '/api/x', handler: async (req) => { calls.push(req) } })
  apply(ctx, { maxHosts: DEFAULT_MAX_HOSTS })

  const route = webServer.exact.get('/api/x')
  webServer.autoTrustAllRegister = () => { throw new Error('boom') }
  await route.handler({ headers: { host: 'a.test' } }, {})
  await route.handler({ headers: { host: 'a.test' } }, {})
  assert.equal(calls.length, 2)
  assert.deepEqual(trustedHosts, [])
  const warnBoom = output.filter(([, message]) => message.includes('注册调用失败'))
  assert.equal(warnBoom.length, 1)
  assert.ok(warnBoom[0][1].includes('boom'))

  // 一次成功即复位:再次失败恢复告警
  const seen = []
  webServer.autoTrustAllRegister = (req) => { seen.push(req) }
  await route.handler({ headers: { host: 'a.test' } }, {})
  assert.equal(seen.length, 1)
  webServer.autoTrustAllRegister = () => { throw new Error('boom2') }
  await route.handler({ headers: { host: 'a.test' } }, {})
  assert.equal(output.filter(([, message]) => message.includes('注册调用失败')).length, 2)
})

test('场景28 卸载身份防覆盖: Given 新代 apply 先于旧代 dispose When 旧代卸载 Then 新代载体不受影响,新代卸载才断开', async (t) => {
  mockConsole(t)
  const { ctx, webServer, trustedHosts } = createCtx()
  webServer.register({ kind: 'exact', path: '/api/x', handler: async () => {} })
  const dispose1 = apply(ctx, { maxHosts: DEFAULT_MAX_HOSTS })
  const dispose2 = apply(ctx, { maxHosts: DEFAULT_MAX_HOSTS })

  const route = webServer.exact.get('/api/x')
  dispose1()
  // 旧代 dispose 不能置空新代载体:注册照常
  await route.handler({ headers: { host: 'gen2.test' } }, {})
  assert.deepEqual(trustedHosts, ['gen2.test'])

  dispose2()
  await route.handler({ headers: { host: 'late.test' } }, {})
  assert.deepEqual(trustedHosts, [])
})

test('场景29 路由表形态守卫: Given 路由表非 Map 形态 When 激活 Then 告警后干净停用,不抛错不包装', (t) => {
  const output = mockConsole(t)
  const { ctx, webServer } = createCtx()
  webServer.register({ kind: 'exact', path: '/api/x', handler: async () => {} })
  const handlerBefore = webServer.exact.get('/api/x').handler
  webServer.exact = undefined

  const dispose = apply(ctx, { maxHosts: DEFAULT_MAX_HOSTS })

  assert.ok(output.some(([, message]) => message.includes('路由表形态不符')))
  assert.equal(webServer.autoTrustAllRegister, undefined)
  assert.equal(typeof webServer.register, 'function')
  dispose()
})

test('场景30 其他服务名不激活: Given internal/service 携带其他服务名 When 事件到达 Then 不激活,webRuntime 事件才激活', async (t) => {
  mockConsole(t)
  const { ctx, webServer, holder, listeners } = createCtx({ webRuntimeReady: false })
  webServer.register({ kind: 'exact', path: '/api/x', handler: async () => {} })
  const handlerBefore = webServer.exact.get('/api/x').handler
  apply(ctx, { maxHosts: DEFAULT_MAX_HOSTS })

  const [, listener] = listeners[0]
  // webRuntime 先就绪:此时能拦住激活的只剩服务名过滤,断言不依赖就绪守卫
  holder.current = { trustedHosts: [] }
  listener('settings')
  assert.equal(webServer.autoTrustAllRegister, undefined)
  assert.equal(webServer.exact.get('/api/x').handler, handlerBefore)

  listener('webRuntime')
  assert.notEqual(webServer.exact.get('/api/x').handler, handlerBefore)
  assert.equal(typeof webServer.autoTrustAllRegister, 'function')
})

test('场景31 未就绪即卸载: Given 未激活时卸载 When webRuntime 就绪事件迟到 Then 不再激活', async (t) => {
  const output = mockConsole(t)
  const { ctx, webServer, holder, listeners } = createCtx({ webRuntimeReady: false })
  webServer.register({ kind: 'exact', path: '/api/x', handler: async () => {} })
  const handlerBefore = webServer.exact.get('/api/x').handler

  const dispose = apply(ctx, { maxHosts: DEFAULT_MAX_HOSTS })
  dispose()

  holder.current = { trustedHosts: [] }
  const [, listener] = listeners[0]
  listener('webRuntime')
  assert.equal(webServer.exact.get('/api/x').handler, handlerBefore)
  assert.equal(webServer.autoTrustAllRegister, undefined)
  assert.equal(output.filter(([, message]) => message.includes('动态信任已启用')).length, 0)
})

test('场景32 外部移除防御: Given 归属条目被第三方从信任数组移除 When 容量淘汰触发 Then 不抛错且注册照常', async (t) => {
  mockConsole(t)
  const { ctx, webServer, trustedHosts } = createCtx()
  webServer.register({ kind: 'exact', path: '/api/x', handler: async () => {} })
  apply(ctx, { maxHosts: 1 })

  const route = webServer.exact.get('/api/x')
  await route.handler({ headers: { host: 'first.test' } }, {})
  trustedHosts.splice(trustedHosts.indexOf('first.test'), 1)
  await route.handler({ headers: { host: 'second.test' } }, {})

  assert.deepEqual(trustedHosts, ['second.test'])
})

test('场景33 淘汰日志: Given 容量淘汰发生 Then 输出 evicted 审计行(前缀与域名全等)', async (t) => {
  const output = mockConsole(t)
  const { ctx, webServer, trustedHosts } = createCtx()
  webServer.register({ kind: 'exact', path: '/api/x', handler: async () => {} })
  apply(ctx, { maxHosts: 1 })

  const route = webServer.exact.get('/api/x')
  await route.handler({ headers: { host: 'first.test' } }, {})
  await route.handler({ headers: { host: 'second.test' } }, {})

  assert.deepEqual(trustedHosts, ['second.test'])
  assert.ok(output.some(([, message]) => message === 'auto-trust-all: evicted host first.test'))
})

test('场景34 重叠代撤销守卫: Given 新代 apply 先于旧代 dispose 且窗口流量命中 When 旧代卸载 Then 条目不误删,新代记账连续', async (t) => {
  mockConsole(t)
  const { ctx, webServer, trustedHosts, fenceHosts } = createCtx()
  webServer.register({ kind: 'exact', path: '/api/x', handler: async () => {} })
  const dispose1 = apply(ctx, { maxHosts: DEFAULT_MAX_HOSTS })

  const route = webServer.exact.get('/api/x')
  await route.handler({ headers: { host: 'x.test' } }, {})
  assert.deepEqual(trustedHosts, ['x.test'])

  // 新一代接管载体后,窗口流量把 x.test 记入新代(视同官方条目)
  const dispose2 = apply(ctx, { maxHosts: DEFAULT_MAX_HOSTS })
  await route.handler({ headers: { host: 'x.test' } }, {})
  assert.deepEqual(trustedHosts, ['x.test'])
  assert.deepEqual(fenceHosts, ['x.test'])

  // 旧代 dispose 载体身份不符:跳过撤销,条目留存由新代吸收
  dispose1()
  assert.deepEqual(trustedHosts, ['x.test'])
  assert.deepEqual(fenceHosts, ['x.test'])
  await route.handler({ headers: { host: 'x.test' } }, {})
  assert.deepEqual(trustedHosts, ['x.test'])

  // 新代卸载只撤销自身 owned 条目:x.test 已被新代视同官方遗留,留存至重启
  dispose2()
  assert.deepEqual(trustedHosts, ['x.test'])
  assert.deepEqual(fenceHosts, ['x.test'])
})
