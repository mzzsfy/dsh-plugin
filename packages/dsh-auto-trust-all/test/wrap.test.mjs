// 包装行为测试:mock webServer(实例形态与官方一致:三 Map + fallback 字段 +
// 原型注册方法)与 mock connection(信任主目标)/webRuntime(可选镜像)/ctx,
// 不起真服务器。
// Given-When-Then 场景见各用例注释,规格源本包 0.2.1适配方案-BDD.md。
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

// 构造最小插件上下文:webServer 静态注入,connection(信任主目标)与
// webRuntime(可选镜像)经 ctx.get 可选探测(与真实 cordis 语义一致,strict get
// 对未提供服务返回 undefined),两 holder 支持测试中延迟就绪或换代;官方初始
// 条目按真实形态同时落在两数组(装配期克隆);ctx.on 收集事件监听器供模拟触发;
// console 输出经 t.mock 捕获,测试结束自动还原
function createCtx({ trustedHosts = [], host = '0.0.0.0', webRuntimeReady = true, connectionReady = true } = {}) {
  const webServer = new MockWebServer(host)
  const holder = { current: webRuntimeReady ? { trustedHosts } : undefined }
  const fenceHosts = [...trustedHosts]
  const fenceHolder = { current: connectionReady ? { trustedHosts: fenceHosts } : undefined }
  const listeners = []
  const ctx = {
    webServer,
    get: (name) => {
      if (name === 'webRuntime') return holder.current
      if (name === 'connection') return fenceHolder.current
      return undefined
    },
    on: (name, listener) => {
      listeners.push([name, listener])
      return () => {}
    },
  }
  return { ctx, webServer, holder, trustedHosts, fenceHosts, fenceHolder, listeners }
}

const mockConsole = (t) => {
  const output = []
  t.mock.method(console, 'log', (...args) => output.push(['log', args.join(' ')]))
  t.mock.method(console, 'warn', (...args) => output.push(['warn', args.join(' ')]))
  return output
}

// 代际注册表读数:helper 只读 mock webServer 上的注册表载体,不触碰私有实现细节
const generationEntries = (webServer) => [...(webServer.autoTrustAllGenerations?.values() ?? [])]
const generationRegister = (webServer) => generationEntries(webServer).at(-1)?.registerHost

test('场景1 回溯包装: Given 激活前已注册路由 When 未注册 Host 请求到达 Then hostname 进信任清单且原 handler 透传', async (t) => {
  const output = mockConsole(t)
  const { ctx, webServer, trustedHosts } = createCtx()
  const calls = []
  webServer.register({ kind: 'exact', path: '/api/x', handler: async (req, res) => { calls.push([req, res]) } })
  webServer.register({ kind: 'prefix', path: '/api', handler: async () => { calls.push('prefix') } })
  webServer.registerUpgrade({ path: '/ws', handler: async () => { calls.push('upgrade') } })

  apply(ctx, { maxHosts: DEFAULT_MAX_HOSTS })

  const route = webServer.exact.get('/api/x')
  const req = { headers: { host: 'probe.example.com' } }
  const res = {}
  await route.handler(req, res)
  await webServer.prefixes.get('/api').handler(req, res)
  await webServer.upgrades.get('/ws').handler(req, {}, null)

  assert.deepEqual(trustedHosts, ['probe.example.com'])
  assert.equal(calls.length, 3)
  assert.equal(calls[0][0], req)
  assert.equal(calls[0][1], res)
  assert.ok(output.some(([, message]) => message === 'auto-trust-all: registered host probe.example.com'))
})

test('场景2 去重: Given 同一 Host 重复请求 Then 数组只增一条', async (t) => {
  mockConsole(t)
  const { ctx, webServer, trustedHosts } = createCtx()
  webServer.register({ kind: 'exact', path: '/api/x', handler: async () => {} })
  apply(ctx, { maxHosts: DEFAULT_MAX_HOSTS })

  const route = webServer.exact.get('/api/x')
  await route.handler({ headers: { host: 'probe.example.com' } }, {})
  await route.handler({ headers: { host: 'probe.example.com' } }, {})
  await route.handler({ headers: { host: 'probe.example.com:8443' } }, {})

  assert.deepEqual(trustedHosts, ['probe.example.com'])
})

test('场景3 提取形态: Given 带端口或大小写或 IPv6 括号的 Host 头 Then 注册闸门比较形态的 hostname', async (t) => {
  mockConsole(t)
  const { ctx, webServer, trustedHosts } = createCtx()
  webServer.register({ kind: 'exact', path: '/api/x', handler: async () => {} })
  apply(ctx, { maxHosts: DEFAULT_MAX_HOSTS })

  const route = webServer.exact.get('/api/x')
  await route.handler({ headers: { host: 'Probe.Example.com:8443' } }, {})
  await route.handler({ headers: { host: '[2001:db8::1]:3080' } }, {})

  // WHATWG hostname 对 IPv6 保留方括号,与闸门 parseAuthority 的比较形态一致;
  // loopback([::1] 等)不登记,见场景3b
  assert.deepEqual(trustedHosts, ['probe.example.com', '[2001:db8::1]'])
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
  await webServer.exact.get('/api/new').handler({ headers: { host: 'late.example.com' } }, {})
  disposer()

  assert.deepEqual(trustedHosts, ['late.example.com'])
  assert.equal(webServer.exact.has('/api/new'), false)
})

test('场景12 影子 upgrade: Given 激活后经影子方法注册的 upgrade 路由 When 请求到达 Then 同样注册 Host', async (t) => {
  mockConsole(t)
  const { ctx, webServer, trustedHosts } = createCtx()
  apply(ctx, { maxHosts: DEFAULT_MAX_HOSTS })

  webServer.registerUpgrade({ path: '/ws/new', handler: async () => {} })
  await webServer.upgrades.get('/ws/new').handler({ headers: { host: 'ws.example.com' } }, {}, null)

  assert.deepEqual(trustedHosts, ['ws.example.com'])
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
  const req = { headers: { host: 'chained.example.com' } }
  await webServer.exact.get('/api/auth').handler(req, {})

  assert.deepEqual(trustedHosts, ['chained.example.com'])
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
  const req = { headers: { host: 'stacked.example.com' } }
  await webServer.exact.get('/api/auth').handler(req, {})

  assert.deepEqual(trustedHosts, ['stacked.example.com'])
  assert.deepEqual(sessionChecked, [req])
})

test('场景7 fallback: Given 回溯与影子注册两条路径的 fallback 请求 Then 同样注册 Host', async (t) => {
  mockConsole(t)
  const { ctx, webServer, trustedHosts } = createCtx()
  const existing = async () => {}
  webServer.fallback = existing
  apply(ctx, { maxHosts: DEFAULT_MAX_HOSTS })

  await webServer.fallback({ headers: { host: 'via-fallback.example.com' } }, {})
  webServer.registerFallback(async () => {})
  await webServer.fallback({ headers: { host: 'via-shadow.example.com' } }, {})

  assert.deepEqual(trustedHosts, ['via-fallback.example.com', 'via-shadow.example.com'])
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
  await webServer.exact.get('/api/x').handler({ headers: { host: 'reload.example.com' } }, {})
  assert.deepEqual(trustedHosts, ['reload.example.com'])
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
  // 重跑 apply,handler 带标记跳过重包装,旧包装经代际注册表用新容量注册
  dispose1()
  assert.deepEqual(trustedHosts, [])
  assert.equal(generationEntries(webServer).length, 0)
  apply(ctx, { maxHosts: 2 })
  assert.equal(route.handler, wrappedOnce)
  assert.equal(typeof generationRegister(webServer), 'function')

  await route.handler({ headers: { host: 'second.test' } }, {})
  await route.handler({ headers: { host: 'third.test' } }, {})
  // 新代只记自身条目:second/third 共 2 条未超容量,first 已随旧代撤销
  assert.deepEqual(trustedHosts, ['second.test', 'third.test'])

  await route.handler({ headers: { host: 'fourth.test' } }, {})
  // 新代容量 2 生效:fourth 淘汰新代最久未访问的 second
  assert.deepEqual(trustedHosts, ['third.test', 'fourth.test'])
})

const NOTICE_DELAY = 15 * 1000

test('场景18 延迟激活: Given 激活时 connection 未就绪 When 服务就绪事件在提示阈值内到达 Then 自动完成激活且不打印等待行', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const output = mockConsole(t)
  const { ctx, webServer, holder, trustedHosts, fenceHosts, fenceHolder, listeners } = createCtx({ connectionReady: false })
  webServer.register({ kind: 'exact', path: '/api/x', handler: async () => {} })
  const handlerBefore = webServer.exact.get('/api/x').handler

  const dispose = apply(ctx, { maxHosts: DEFAULT_MAX_HOSTS })

  // 未就绪路径:不包装、不建注册表,挂 internal/service 监听;等待行延后,不立即输出
  assert.equal(webServer.exact.get('/api/x').handler, handlerBefore)
  assert.equal(webServer.autoTrustAllGenerations, undefined)
  assert.deepEqual(listeners.map(([name]) => name), ['internal/service'])
  assert.ok(!output.some(([, message]) => message.includes('connection 未就绪')))

  // 模拟 connection fiber 激活完成(阈值内):信任数组就绪并发出服务事件
  fenceHolder.current = { trustedHosts: fenceHosts }
  const [, listener] = listeners[0]
  listener('connection')
  assert.notEqual(webServer.exact.get('/api/x').handler, handlerBefore)
  assert.equal(typeof generationRegister(webServer), 'function')
  assert.ok(output.some(([, message]) => message.includes('动态信任已启用')))

  // 阈值走完:激活已发生,等待行不再补打
  t.mock.timers.tick(NOTICE_DELAY)
  assert.ok(!output.some(([, message]) => message.includes('connection 未就绪')))

  await webServer.exact.get('/api/x').handler({ headers: { host: 'late.example.com' } }, {})
  assert.deepEqual(fenceHosts, ['late.example.com'])
  assert.deepEqual(holder.current.trustedHosts, ['late.example.com'])
  dispose()
  // 卸载撤销本代放行:两侧数组的 late 条目均被移除,后续请求经空注册表纯透传不再注册
  assert.deepEqual(fenceHosts, [])
  assert.deepEqual(holder.current.trustedHosts, [])
})

test('场景19 等待超时提示: Given connection 持续未就绪 When 超过提示阈值 Then 打印等待行一次,此前不打印', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const output = mockConsole(t)
  const { ctx, webServer } = createCtx({ connectionReady: false })
  webServer.register({ kind: 'exact', path: '/api/x', handler: async () => {} })

  const dispose = apply(ctx, { maxHosts: DEFAULT_MAX_HOSTS })

  // 阈值内静默等待
  t.mock.timers.tick(NOTICE_DELAY - 1)
  assert.ok(!output.some(([, message]) => message.includes('connection 未就绪')))
  // 阈值到:仍未就绪才输出等待行,且只此一次
  t.mock.timers.tick(1)
  const waiting = output.filter(([, message]) => message.includes('connection 未就绪'))
  assert.equal(waiting.length, 1)
  t.mock.timers.tick(NOTICE_DELAY)
  assert.equal(output.filter(([, message]) => message.includes('connection 未就绪')).length, 1)
  dispose()
})

test('场景20 卸载撤销: Given 已激活 When 卸载 Then 本代注册表项删除且注册条目从两侧数组移除,后续请求纯透传', async (t) => {
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

test('场景21 激活幂等: Given 事件路径激活后服务再次发事件 When 重复触发 Then 不重复激活(横幅与注册表不换代)', (t) => {
  const output = mockConsole(t)
  const { ctx, webServer, fenceHolder, fenceHosts, listeners } = createCtx({ connectionReady: false })
  apply(ctx, { maxHosts: DEFAULT_MAX_HOSTS })

  fenceHolder.current = { trustedHosts: fenceHosts }
  const [, listener] = listeners[0]
  listener('connection')
  const generation = generationEntries(webServer)[0]

  listener('connection')

  assert.equal(generationEntries(webServer)[0], generation)
  assert.equal(output.filter(([, message]) => message.includes('动态信任已启用')).length, 1)
})

test('场景22 fence 双写: Given connection 服务在场 When 注册发生 Then fence 同步写入且去重不重复', async (t) => {
  mockConsole(t)
  const { ctx, webServer, trustedHosts, fenceHosts } = createCtx()
  webServer.register({ kind: 'exact', path: '/api/x', handler: async () => {} })
  apply(ctx, { maxHosts: DEFAULT_MAX_HOSTS })

  const route = webServer.exact.get('/api/x')
  await route.handler({ headers: { host: 'probe.example.com' } }, {})
  await route.handler({ headers: { host: 'probe.example.com' } }, {})
  await route.handler({ headers: {} }, {})

  assert.deepEqual(trustedHosts, ['probe.example.com'])
  assert.deepEqual(fenceHosts, ['probe.example.com'])
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

test('场景24 connection 缺失不激活: Given 仅 webRuntime 在场而 connection 缺席 When 请求到达 Then 不包装不写任何目标,等待期静默', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const output = mockConsole(t)
  const { ctx, webServer, holder, trustedHosts, listeners } = createCtx({ connectionReady: false })
  webServer.register({ kind: 'exact', path: '/api/x', handler: async () => {} })
  const handlerBefore = webServer.exact.get('/api/x').handler

  const dispose = apply(ctx, { maxHosts: DEFAULT_MAX_HOSTS })

  // connection 是宿主 /api 闸门信任数组的唯一承载:它缺席时动态登记对闸门不可见,
  // 不得宣称启用;webRuntime 镜像也不写(避免装配期克隆把动态条目误认成预存条目)
  assert.equal(webServer.exact.get('/api/x').handler, handlerBefore)
  assert.equal(webServer.autoTrustAllGenerations, undefined)
  assert.deepEqual(listeners.map(([name]) => name), ['internal/service'])
  await webServer.exact.get('/api/x').handler({ headers: { host: 'early.test' } }, {})
  assert.deepEqual(trustedHosts, [])
  t.mock.timers.tick(NOTICE_DELAY)
  assert.equal(output.filter(([, message]) => message.includes('connection 未就绪')).length, 1)
  assert.ok(!output.some(([, message]) => message.includes('动态信任已启用')))
  dispose()
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

test('场景27 注册失败限频: Given 代注册项抛错 When 请求到达 Then 原 handler 照常执行且告警恰一次,恢复后复位再告警', async (t) => {
  const output = mockConsole(t)
  const { ctx, webServer, trustedHosts } = createCtx()
  const calls = []
  webServer.register({ kind: 'exact', path: '/api/x', handler: async (req) => { calls.push(req) } })
  apply(ctx, { maxHosts: DEFAULT_MAX_HOSTS })

  const route = webServer.exact.get('/api/x')
  const generation = generationEntries(webServer)[0]
  generation.registerHost = () => { throw new Error('boom') }
  await route.handler({ headers: { host: 'a.test' } }, {})
  await route.handler({ headers: { host: 'a.test' } }, {})
  assert.equal(calls.length, 2)
  assert.deepEqual(trustedHosts, [])
  const warnBoom = output.filter(([, message]) => message.includes('注册调用失败'))
  assert.equal(warnBoom.length, 1)
  assert.ok(warnBoom[0][1].includes('boom'))

  // 一次成功即复位:再次失败恢复告警
  const seen = []
  generation.registerHost = (req) => { seen.push(req) }
  await route.handler({ headers: { host: 'a.test' } }, {})
  assert.equal(seen.length, 1)
  generation.registerHost = () => { throw new Error('boom2') }
  await route.handler({ headers: { host: 'a.test' } }, {})
  assert.equal(output.filter(([, message]) => message.includes('注册调用失败')).length, 2)
})

test('场景28 卸载身份防覆盖: Given 新代 apply 先于旧代 dispose When 旧代卸载 Then 新代注册项不受影响,新代卸载才断开', async (t) => {
  mockConsole(t)
  const { ctx, webServer, trustedHosts } = createCtx()
  webServer.register({ kind: 'exact', path: '/api/x', handler: async () => {} })
  const dispose1 = apply(ctx, { maxHosts: DEFAULT_MAX_HOSTS })
  const dispose2 = apply(ctx, { maxHosts: DEFAULT_MAX_HOSTS })

  const route = webServer.exact.get('/api/x')
  dispose1()
  // 旧代 dispose 只删自己项,不能置空新代注册项:注册照常
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
  assert.equal(webServer.autoTrustAllGenerations, undefined)
  assert.equal(typeof webServer.register, 'function')
  dispose()
})

test('场景30 其他服务名不激活: Given internal/service 携带其他服务名 When 事件到达 Then 不激活,connection 事件才激活', async (t) => {
  mockConsole(t)
  const { ctx, webServer, fenceHolder, fenceHosts, listeners } = createCtx({ connectionReady: false })
  webServer.register({ kind: 'exact', path: '/api/x', handler: async () => {} })
  const handlerBefore = webServer.exact.get('/api/x').handler
  apply(ctx, { maxHosts: DEFAULT_MAX_HOSTS })

  const [, listener] = listeners[0]
  // webRuntime/其他服务就绪不构成激活条件:信任主目标只有 connection
  listener('webRuntime')
  listener('settings')
  assert.equal(webServer.autoTrustAllGenerations, undefined)
  assert.equal(webServer.exact.get('/api/x').handler, handlerBefore)

  fenceHolder.current = { trustedHosts: fenceHosts }
  listener('connection')
  assert.notEqual(webServer.exact.get('/api/x').handler, handlerBefore)
  assert.equal(typeof generationRegister(webServer), 'function')
})

test('场景31 未就绪即卸载: Given 未激活时卸载 When 等待阈值走完且 connection 就绪事件迟到 Then 等待行不补打且不再激活', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const output = mockConsole(t)
  const { ctx, webServer, fenceHolder, fenceHosts, listeners } = createCtx({ connectionReady: false })
  webServer.register({ kind: 'exact', path: '/api/x', handler: async () => {} })
  const handlerBefore = webServer.exact.get('/api/x').handler

  const dispose = apply(ctx, { maxHosts: DEFAULT_MAX_HOSTS })
  dispose()

  // 卸载清除等待定时器:阈值走完不补打等待行
  t.mock.timers.tick(NOTICE_DELAY)
  assert.ok(!output.some(([, message]) => message.includes('connection 未就绪')))

  fenceHolder.current = { trustedHosts: fenceHosts }
  const [, listener] = listeners[0]
  listener('connection')
  assert.equal(webServer.exact.get('/api/x').handler, handlerBefore)
  assert.equal(generationEntries(webServer).length, 0)
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

test('场景34 重叠代接管撤销: Given 新代 apply 先于旧代 dispose When 新代接管 Then 旧代条目立即从两类数组撤销(不遗留至重启),他方条目不被触碰且新代容量只计在位条目', async (t) => {
  const output = mockConsole(t)
  const { ctx, webServer, trustedHosts, fenceHosts } = createCtx()
  webServer.register({ kind: 'exact', path: '/api/x', handler: async () => {} })
  const dispose1 = apply(ctx, { maxHosts: 2 })

  const route = webServer.exact.get('/api/x')
  await route.handler({ headers: { host: 'x.test' } }, {})
  await route.handler({ headers: { host: 'y.test' } }, {})
  assert.deepEqual(trustedHosts, ['x.test', 'y.test'])

  // 他方(不经本插件)写入两类数组的同一条目:不取得归属,换代撤销不得误删
  trustedHosts.push('foreign.test')
  fenceHosts.push('foreign.test')

  // 新代接管(旧代尚未卸载):共享归属表识别前代条目并立即撤销,不得留作"官方条目"
  const dispose2 = apply(ctx, { maxHosts: 2 })
  assert.deepEqual(trustedHosts, ['foreign.test'])
  assert.deepEqual(fenceHosts, ['foreign.test'])
  assert.ok(output.some(([, message]) => message === 'auto-trust-all: revoked host x.test'))
  assert.ok(output.some(([, message]) => message === 'auto-trust-all: revoked host y.test'))
  assert.ok(!output.some(([, message]) => message.includes('revoked host foreign.test')))

  // 旧代随后卸载前,新代已重访把 x.test 重新登记进本代归属
  await route.handler({ headers: { host: 'x.test' } }, {})
  assert.deepEqual(trustedHosts, ['foreign.test', 'x.test'])
  assert.deepEqual(fenceHosts, ['foreign.test', 'x.test'])

  // 旧代卸载(归属已转移):不误删新代条目
  dispose1()
  assert.deepEqual(trustedHosts, ['foreign.test', 'x.test'])
  assert.deepEqual(fenceHosts, ['foreign.test', 'x.test'])

  // 新代容量只统计在位条目:foreign 不占容量,第三个本代域名淘汰最久未访问的 x.test
  await route.handler({ headers: { host: 'y.test' } }, {})
  await route.handler({ headers: { host: 'z.test' } }, {})
  assert.deepEqual(trustedHosts, ['foreign.test', 'y.test', 'z.test'])

  dispose2()
  assert.deepEqual(trustedHosts, ['foreign.test'])
  assert.deepEqual(fenceHosts, ['foreign.test'])
})

test('场景43 旧代卸载后新代立即撤销其条目: Given 旧代热禁用(disposer 未调用)后新代 apply 接管 When 旧代真正卸载 Then 旧代条目已撤销且新代重访重新登记,不遗留至重启', async (t) => {
  const output = mockConsole(t)
  const { ctx, webServer, trustedHosts, fenceHosts } = createCtx()
  ctx.fiber = { state: 2 }
  webServer.register({ kind: 'exact', path: '/api/x', handler: async () => {} })
  const dispose1 = apply(ctx, { maxHosts: DEFAULT_MAX_HOSTS })

  const route = webServer.exact.get('/api/x')
  await route.handler({ headers: { host: 'hot.test' } }, {})
  assert.deepEqual(trustedHosts, ['hot.test'])

  // 市场热禁用:disposer 未被调用(场景35),条目留在信任数组;随后新代 apply 接管
  ctx.fiber.state = 4
  const fiber2 = { state: 2 }
  const ctx2 = { ...ctx, fiber: fiber2, get: ctx.get }
  const dispose2 = apply(ctx2, { maxHosts: DEFAULT_MAX_HOSTS })
  assert.deepEqual(trustedHosts, [], '新代接管即撤销旧代热禁用残留')
  assert.deepEqual(fenceHosts, [])
  assert.ok(output.some(([, message]) => message === 'auto-trust-all: revoked host hot.test'))

  // 旧代真正卸载(disposer 迟到):归属已转移,不误删且无残留可撤
  dispose1()
  assert.deepEqual(trustedHosts, [])
  assert.deepEqual(fenceHosts, [])

  // 新代重访重新登记,卸载清理只撤自身条目
  await route.handler({ headers: { host: 'hot.test' } }, {})
  assert.deepEqual(trustedHosts, ['hot.test'])
  assert.deepEqual(fenceHosts, ['hot.test'])
  dispose2()
  assert.deepEqual(trustedHosts, [])
  assert.deepEqual(fenceHosts, [])
})

test('场景35 fiber 活性守卫: Given 已激活 When fiber 转非 ACTIVE(市场热禁用,disposer 不被调用) Then 后续请求注册自断,条目留存', async (t) => {
  mockConsole(t)
  // 真实宿主事故(2026-09-23 L3):market toggle 禁用只把 patch 行置 disabled,
  // cordis 不触发本插件 disposer,旧代包装闭包继续注册 Host,禁用语义失效至重启。
  // 修复:包装闭包每请求读 ctx.fiber.state,非 ACTIVE 即跳过注册(条目留存,重启即净)
  const { ctx, webServer, trustedHosts } = createCtx()
  ctx.fiber = { state: 2 }
  webServer.register({ kind: 'exact', path: '/api/x', handler: async () => {} })
  const dispose = apply(ctx, { maxHosts: DEFAULT_MAX_HOSTS })

  const route = webServer.exact.get('/api/x')
  await route.handler({ headers: { host: 'hot.test' } }, {})
  assert.deepEqual(trustedHosts, ['hot.test'])

  // 热禁用:disposer 未调用,fiber 状态转 DISPOSED(4)
  ctx.fiber.state = 4
  await route.handler({ headers: { host: 'after-disable.test' } }, {})
  assert.deepEqual(trustedHosts, ['hot.test'], '非 ACTIVE 后不得新注册')

  // 恢复启用(状态回 ACTIVE)后注册链路照常
  ctx.fiber.state = 2
  await route.handler({ headers: { host: 're-enabled.test' } }, {})
  assert.deepEqual(trustedHosts, ['hot.test', 're-enabled.test'])

  // disposer 路径不受守卫影响:仍撤销 owned 条目
  dispose()
  assert.deepEqual(trustedHosts, [])
})

test('场景36 代际注册表守卫: Given 热禁用后经 bundle patch 热加载换代(新 apply,旧闭包仍在岗) When 旧代包装处理请求 Then 换代后注册改道新代 registerHost,恢复不滞后到重启', async (t) => {
  mockConsole(t)
  // 真实宿主回归(2026-09-23 0.1.7-rc.1 L3):恢复启用的宿主形态 = 新代 apply 重跑,
  // 旧代闭包 fiber 恒 disposed;同代 fiber 守卫把它判死,注册静默失效至重启(P1)。
  // 修复:守卫每请求现取注册表最新 ACTIVE 代,换代即改道新代 registerHost
  const { ctx, webServer, trustedHosts } = createCtx()
  ctx.fiber = { state: 2 }
  webServer.register({ kind: 'exact', path: '/api/x', handler: async () => {} })
  apply(ctx, { maxHosts: DEFAULT_MAX_HOSTS })

  const route = webServer.exact.get('/api/x')
  await route.handler({ headers: { host: 'gen1.test' } }, {})
  assert.deepEqual(trustedHosts, ['gen1.test'])

  // 热禁用:最终仅有本代且 fiber DISPOSED → 无 ACTIVE 代可解析,注册自断
  ctx.fiber.state = 4
  await route.handler({ headers: { host: 'gen1-off.test' } }, {})
  assert.deepEqual(trustedHosts, ['gen1.test'])

  // 恢复启用(宿主形态):新代 apply 重跑——旧闭包仍在路由表(WRAPPED 短路回溯),
  // 新代入注册表;旧闭包每请求解析到新代 ACTIVE 项 → 改道新代 registerHost。
  // 接管同时撤销前代归属:gen1.test 不再稳健留存,旧闭包注册的条目一律撤销
  const fiber2 = { state: 2 }
  const ctx2 = { ...ctx, fiber: fiber2, get: ctx.get }
  apply(ctx2, { maxHosts: DEFAULT_MAX_HOSTS })
  await route.handler({ headers: { host: 'gen2.test' } }, {})
  assert.deepEqual(
    trustedHosts,
    ['gen2.test'],
    '换代后旧包装必须改道新代 registerHost 恢复注册,前代条目随接管撤销',
  )

  // 换代后再禁用(新代 fiber 转 DISPOSED):无 ACTIVE 代可解析,注册再度自断
  fiber2.state = 4
  await route.handler({ headers: { host: 'gen2-off.test' } }, {})
  assert.deepEqual(trustedHosts, ['gen2.test'])
})

test('场景37 卸载后残余闭包: Given 卸载(注册表项删除) When 旧闭包处理请求 Then 无代可解析且不再登记', async (t) => {
  mockConsole(t)
  const { ctx, webServer, trustedHosts } = createCtx()
  ctx.fiber = { state: 2 }
  webServer.register({ kind: 'exact', path: '/api/x', handler: async () => {} })
  const dispose = apply(ctx, { maxHosts: DEFAULT_MAX_HOSTS })

  const route = webServer.exact.get('/api/x')
  await route.handler({ headers: { host: 'alive.test' } }, {})
  assert.deepEqual(trustedHosts, ['alive.test'])

  dispose()
  await route.handler({ headers: { host: 'after-dispose.test' } }, {})
  assert.deepEqual(trustedHosts, [], '卸载即撤销本代放行,残余闭包不得新注册')
  assert.equal(generationEntries(webServer).length, 0, '卸载须删除本代注册表项')
})

test('场景38 单 fence 全流程: Given 仅 connection 在场(0.2.1 形态) When 注册/淘汰/卸载 Then 主数组与审计日志成立且无 webRuntime 依赖', async (t) => {
  const output = mockConsole(t)
  const { ctx, webServer, fenceHosts } = createCtx({ webRuntimeReady: false })
  webServer.register({ kind: 'exact', path: '/api/x', handler: async () => {} })
  const dispose = apply(ctx, { maxHosts: 1 })

  const route = webServer.exact.get('/api/x')
  await route.handler({ headers: { host: 'a.example.com' } }, {})
  assert.deepEqual(fenceHosts, ['a.example.com'])
  assert.ok(output.some(([, message]) => message === 'auto-trust-all: registered host a.example.com'))
  assert.ok(output.some(([, message]) => message.includes('镜像 webRuntime 缺席')))
  assert.ok(!output.some(([, message]) => message.includes('未就绪')))

  await route.handler({ headers: { host: 'b.example.com' } }, {})
  assert.deepEqual(fenceHosts, ['b.example.com'])
  assert.ok(output.some(([, message]) => message === 'auto-trust-all: evicted host a.example.com'))

  dispose()
  assert.deepEqual(fenceHosts, [])
})

test('场景39 冻结数组守卫: Given connection.trustedHosts 冻结 When 激活 Then 告警停用,不包装不抛错', (t) => {
  const output = mockConsole(t)
  const { ctx, webServer, fenceHolder } = createCtx()
  webServer.register({ kind: 'exact', path: '/api/x', handler: async () => {} })
  const handlerBefore = webServer.exact.get('/api/x').handler
  Object.freeze(fenceHolder.current.trustedHosts)

  const dispose = apply(ctx, { maxHosts: DEFAULT_MAX_HOSTS })

  assert.ok(output.some(([, message]) => message.includes('形态不符')))
  assert.equal(webServer.exact.get('/api/x').handler, handlerBefore)
  assert.equal(webServer.autoTrustAllGenerations, undefined)
  dispose()
})

test('场景40 主数组换代回填: Given connection 提供新数组 When 请求触发换代探测 Then LRU 记账不清空,动态条目回填新数组且归属延续', async (t) => {
  mockConsole(t)
  const { ctx, webServer, fenceHosts, fenceHolder, holder } = createCtx()
  webServer.register({ kind: 'exact', path: '/api/x', handler: async () => {} })
  const dispose = apply(ctx, { maxHosts: 1 })

  const route = webServer.exact.get('/api/x')
  await route.handler({ headers: { host: 'first.test' } }, {})
  assert.deepEqual(fenceHosts, ['first.test'])

  // 模拟 connection 行重载:新数组只含官方初始条目
  const rebuilt = ['10.0.0.2']
  fenceHolder.current = { trustedHosts: rebuilt }
  await route.handler({ headers: { host: 'first.test' } }, {})
  // 换代探测即回填仍有效的动态条目(记账未清空),命中归属不再重复输出
  assert.deepEqual(rebuilt, ['10.0.0.2', 'first.test'])

  await route.handler({ headers: { host: 'second.test' } }, {})
  assert.deepEqual(rebuilt, ['10.0.0.2', 'second.test'])
  assert.deepEqual(holder.current.trustedHosts, ['second.test'])

  dispose()
  assert.deepEqual(rebuilt, ['10.0.0.2'])
  assert.deepEqual(holder.current.trustedHosts, [])
})

test('场景41 镜像数组换代: Given webRuntime 提供新数组 When 已注册域名再次到达 Then 镜像回填且归属延续,卸载清理覆盖新镜像', async (t) => {
  mockConsole(t)
  const { ctx, webServer, fenceHosts, holder } = createCtx()
  webServer.register({ kind: 'exact', path: '/api/x', handler: async () => {} })
  const dispose = apply(ctx, { maxHosts: 2 })

  const route = webServer.exact.get('/api/x')
  await route.handler({ headers: { host: 'first.test' } }, {})
  assert.deepEqual(holder.current.trustedHosts, ['first.test'])

  const rebuiltMirror = []
  holder.current = { trustedHosts: rebuiltMirror }
  await route.handler({ headers: { host: 'first.test' } }, {})
  assert.deepEqual(rebuiltMirror, ['first.test'])

  dispose()
  assert.deepEqual(rebuiltMirror, [])
  assert.deepEqual(fenceHosts, [])
})

test('场景42 换代后未注册即卸载: Given 主数组换代但换代探测未触发 When 卸载 Then 新数组不被触碰(身份守卫,非归属不撤)', async (t) => {
  mockConsole(t)
  const { ctx, webServer, fenceHolder } = createCtx()
  webServer.register({ kind: 'exact', path: '/api/x', handler: async () => {} })
  const dispose = apply(ctx, { maxHosts: DEFAULT_MAX_HOSTS })

  const route = webServer.exact.get('/api/x')
  await route.handler({ headers: { host: 'first.test' } }, {})

  // 模拟 connection 重建且此后无请求流经(换代探测未触发,seenFor 仍指旧数组)
  const rebuilt = ['10.0.0.7']
  fenceHolder.current = { trustedHosts: rebuilt }

  dispose()
  assert.deepEqual(rebuilt, ['10.0.0.7'], '新数组未发生换代探测,卸载不得触碰')
})

test('场景44 新代先卸载: Given 新旧代重叠且新代先 dispose When 请求到达已包装路由 Then 注册交回仍 ACTIVE 的旧代(含被新代撤销条目的重访与换代回填)', async (t) => {
  mockConsole(t)
  const { ctx, webServer, trustedHosts, fenceHolder } = createCtx()
  webServer.register({ kind: 'exact', path: '/api/x', handler: async () => {} })
  const dispose1 = apply(ctx, { maxHosts: 2 })
  const route = webServer.exact.get('/api/x')

  await route.handler({ headers: { host: 'first.test' } }, {})
  assert.deepEqual(trustedHosts, ['first.test'])

  // 新代接管即撤销旧代条目(旧代仍 ACTIVE,注册表保留旧代项)
  const dispose2 = apply(ctx, { maxHosts: 2 })
  assert.deepEqual(trustedHosts, [])
  assert.equal(generationEntries(webServer).length, 2, '重叠期两代均在注册表')

  // 新代先卸载:只删自己项,包装器每请求解析最新 ACTIVE 代 → 回落到旧代;
  // 主数组同时换代,旧代不得把已撤销的 first.test 从陈旧记账回填进新数组
  dispose2()
  assert.equal(generationEntries(webServer).length, 1, 'disposer 只删自己项')
  const rebuilt = ['10.0.0.2']
  fenceHolder.current = { trustedHosts: rebuilt }
  await route.handler({ headers: { host: 'second.test' } }, {})
  assert.deepEqual(rebuilt, ['10.0.0.2', 'second.test'], '旧代仍在位时注册继续且不回填已撤销条目')
  assert.deepEqual(trustedHosts, ['second.test'])

  // 被新代接管撤销过的域名重访:旧代归属记账已随撤销清理,走完整注册路径
  await route.handler({ headers: { host: 'first.test' } }, {})
  assert.deepEqual(rebuilt, ['10.0.0.2', 'second.test', 'first.test'])
  assert.deepEqual(trustedHosts, ['second.test', 'first.test'])

  // 旧代卸载后注册链才真正停止,本代条目随卸载撤销
  dispose1()
  assert.equal(generationEntries(webServer).length, 0)
  await route.handler({ headers: { host: 'late.test' } }, {})
  assert.deepEqual(rebuilt, ['10.0.0.2'])
  assert.deepEqual(trustedHosts, [])
})

test('场景45 fallback {resource} 形态: Given webServer.fallback 为资源对象(0.2.2 形态) When 激活与影子注册 Then 非函数对象原样保留,不包装不抛错', (t) => {
  mockConsole(t)
  const { ctx, webServer } = createCtx()
  const resource = { resource: async () => ({ status: 200 }) }
  webServer.fallback = resource

  const dispose = apply(ctx, { maxHosts: DEFAULT_MAX_HOSTS })

  assert.equal(webServer.fallback, resource, '资源对象非 handler,不得被包装替换')
  const late = { resource: async () => ({ status: 204 }) }
  webServer.registerFallback(late)
  assert.equal(webServer.fallback, late, '影子 registerFallback 对资源对象保持原样')
  dispose()
})

test('场景46 数组重建已含动态条目: Given connection 重建数组直接带上旧动态条目 When 探测换代 Then 按归属兜底且卸载不残留', async (t) => {
  mockConsole(t)
  const { ctx, webServer, trustedHosts, fenceHolder } = createCtx({ trustedHosts: ['192.168.1.5'] })
  webServer.register({ kind: 'exact', path: '/api/x', handler: async () => {} })
  const dispose = apply(ctx, { maxHosts: 2 })
  const route = webServer.exact.get('/api/x')

  await route.handler({ headers: { host: 'first.test' } }, {})
  assert.deepEqual(trustedHosts, ['192.168.1.5', 'first.test'])

  // 宿主重建数组时把既有动态条目一并复制过来:台账只记实际 push 的条目,
  // 已携带的 first.test 靠归属与代内记账兜底清理(补记台账会连官方恢复的同名条目一起删)
  const rebuilt = ['192.168.1.5', 'first.test']
  fenceHolder.current = { trustedHosts: rebuilt }
  await route.handler({ headers: { host: 'second.test' } }, {})
  assert.deepEqual(rebuilt, ['192.168.1.5', 'first.test', 'second.test'])

  dispose()
  assert.deepEqual(rebuilt, ['192.168.1.5'], '卸载撤掉重建数组中的全部本代动态条目,保留官方条目')
})

test('场景47 前代 pre 缓存陈旧: Given 新代动态条目在旧代 pre 前沿 When 新代热禁用后旧代接管 Then 旧代认领条目且卸载不永久 403', async (t) => {
  mockConsole(t)
  const { ctx, webServer, trustedHosts, fenceHolder } = createCtx({ trustedHosts: ['old.test'] })
  const fiber1 = { state: 2 }
  ctx.fiber = fiber1
  webServer.register({ kind: 'exact', path: '/api/x', handler: async () => {} })
  const dispose1 = apply(ctx, { maxHosts: 2 })
  const route = webServer.exact.get('/api/x')

  // 旧代先命中官方条目,建立 pre 缓存
  await route.handler({ headers: { host: 'old.test' } }, {})

  const fiber2 = { state: 2 }
  ctx.fiber = fiber2
  const dispose2 = apply(ctx, { maxHosts: 2 })
  await route.handler({ headers: { host: 'newgen.test' } }, {})
  assert.deepEqual(trustedHosts, ['old.test', 'newgen.test'])

  // 新代热禁用(disposer 未调用):旧代重新成为最新 ACTIVE 代,不能把新代条目当官方条目
  fiber2.state = 4
  await route.handler({ headers: { host: 'newgen.test' } }, {})
  assert.deepEqual(trustedHosts, ['old.test', 'newgen.test'], '旧代认领后条目仍在')

  // 新代随后真正卸载:旧代必须仍能登记,不得因陈旧 pre 直接跳过而永久 403
  dispose2()
  await route.handler({ headers: { host: 'newgen.test' } }, {})
  assert.deepEqual(trustedHosts, ['old.test', 'newgen.test'])

  dispose1()
  assert.deepEqual(trustedHosts, ['old.test'])
  assert.deepEqual(fenceHolder.current.trustedHosts, ['old.test'])
})

test('场景48 认领后不记台账: Given 数组重建已含新代动态条目 When 旧代认领后两代卸载 Then 条目按归属兜底清理', async (t) => {
  mockConsole(t)
  const { ctx, webServer, trustedHosts, fenceHolder } = createCtx()
  const fiber1 = { state: 2 }
  ctx.fiber = fiber1
  webServer.register({ kind: 'exact', path: '/api/x', handler: async () => {} })
  const dispose1 = apply(ctx, { maxHosts: 2 })
  const route = webServer.exact.get('/api/x')

  const fiber2 = { state: 2 }
  ctx.fiber = fiber2
  const dispose2 = apply(ctx, { maxHosts: 2 })
  await route.handler({ headers: { host: 'newgen.test' } }, {})

  // 宿主重建数组,新代条目已在其中;此后新代热禁用,旧代请求触发 claim
  const rebuilt = ['newgen.test']
  fenceHolder.current = { trustedHosts: rebuilt }
  fiber2.state = 4
  await route.handler({ headers: { host: 'newgen.test' } }, {})
  assert.deepEqual(rebuilt, ['newgen.test'])

  dispose2()
  dispose1()
  assert.deepEqual(rebuilt, [], '认领只转移归属不记台账,两代卸载按归属兜底不残留')
  assert.deepEqual(trustedHosts, [])
})

test('场景49 重建后无请求直接卸载: Given 宿主重建数组带上本代动态条目 When 未产生新请求即卸载 Then 条目仍被清理', async (t) => {
  mockConsole(t)
  const { ctx, webServer, trustedHosts, fenceHolder } = createCtx()
  webServer.register({ kind: 'exact', path: '/api/x', handler: async () => {} })
  const dispose = apply(ctx, { maxHosts: 2 })
  const route = webServer.exact.get('/api/x')

  await route.handler({ headers: { host: 'dyn.test' } }, {})
  assert.deepEqual(trustedHosts, ['dyn.test'])

  const rebuilt = ['official.test', 'dyn.test']
  fenceHolder.current = { trustedHosts: rebuilt }
  dispose()
  assert.deepEqual(rebuilt, ['official.test'], '本代登记过的动态条目按归属清理,官方条目保留')
  assert.deepEqual(trustedHosts, [])
})

test('场景50 换代撤销重建数组内的前代条目: Given 宿主重建两类数组直接带上旧代动态条目且无请求触发换代探测 When 新代 apply 接管 Then 旧动态条目立即从两类数组撤销并输出 revoked,旧代卸载不误删,新代重访重新登记', async (t) => {
  const output = mockConsole(t)
  const { ctx, webServer, trustedHosts, holder, fenceHosts, fenceHolder } = createCtx()
  webServer.register({ kind: 'exact', path: '/api/x', handler: async () => {} })
  const dispose1 = apply(ctx, { maxHosts: 2 })
  const route = webServer.exact.get('/api/x')

  await route.handler({ headers: { host: 'dyn.test' } }, {})
  assert.deepEqual(trustedHosts, ['dyn.test'])
  assert.deepEqual(fenceHosts, ['dyn.test'])

  // 宿主重启形态:两类数组都重建并复制既有动态条目,此后无请求(前代不触发换代探测,
  // 台账对新数组为空),兜底只能凭跨代归属表与旧代 owned 记账
  const rebuiltMirror = ['official.test', 'dyn.test']
  holder.current = { trustedHosts: rebuiltMirror }
  const rebuiltFence = ['official.test', 'dyn.test']
  fenceHolder.current = { trustedHosts: rebuiltFence }

  // 新代接管(旧代未卸载):先撤销再清归属,旧动态条目不得留存至重启
  const dispose2 = apply(ctx, { maxHosts: 2 })
  assert.deepEqual(rebuiltMirror, ['official.test'], '镜像侧重建数组必须撤销前代动态条目')
  assert.deepEqual(rebuiltFence, ['official.test'], 'fence 侧重建数组必须撤销前代动态条目')
  assert.ok(output.some(([, message]) => message === 'auto-trust-all: revoked host dyn.test'))

  // 新代重访重新登记(归属已转移),旧代随后真正卸载不得误删
  await route.handler({ headers: { host: 'dyn.test' } }, {})
  assert.deepEqual(rebuiltMirror, ['official.test', 'dyn.test'])
  assert.deepEqual(rebuiltFence, ['official.test', 'dyn.test'])
  dispose1()
  assert.deepEqual(rebuiltMirror, ['official.test', 'dyn.test'], '旧代卸载不得触碰已被新代接管的条目')
  assert.deepEqual(rebuiltFence, ['official.test', 'dyn.test'])

  // 新代卸载只撤自身条目:撤销时归属已清,重建数组的台账也已补记
  dispose2()
  assert.deepEqual(rebuiltMirror, ['official.test'])
  assert.deepEqual(rebuiltFence, ['official.test'])
})

test('场景51 外部移除后重访回填: Given 动态条目被外部从同一信任数组移除(引用不变,台账仍含) When 该 Host 再次请求 Then 重新推入 fence 并同步镜像,卸载仍能清理', async (t) => {
  const output = mockConsole(t)
  const { ctx, webServer, trustedHosts, fenceHosts } = createCtx()
  webServer.register({ kind: 'exact', path: '/api/x', handler: async () => {} })
  const dispose = apply(ctx, { maxHosts: 2 })
  const route = webServer.exact.get('/api/x')
  const registered = () =>
    output.filter(([, message]) => message === 'auto-trust-all: registered host dyn.test').length

  await route.handler({ headers: { host: 'dyn.test' } }, {})
  assert.deepEqual(trustedHosts, ['dyn.test'])
  assert.deepEqual(fenceHosts, ['dyn.test'])
  assert.equal(registered(), 1)

  // 外部(宿主收缩或第三方)把条目从两类数组移除:重访必须重新登记,不得因去重记忆跳过
  trustedHosts.splice(trustedHosts.indexOf('dyn.test'), 1)
  fenceHosts.splice(fenceHosts.indexOf('dyn.test'), 1)
  await route.handler({ headers: { host: 'dyn.test' } }, {})
  assert.deepEqual(trustedHosts, ['dyn.test'], '镜像侧被外部移除后重访必须回填,否则 403 至 LRU/重启')
  assert.deepEqual(fenceHosts, ['dyn.test'], 'fence 侧被外部移除后重访必须回填')
  assert.equal(registered(), 2, '回填属重新登记,审计行重现')

  // 单侧被外部移除(镜像侧):fence 已含也必须把镜像补回
  trustedHosts.splice(trustedHosts.indexOf('dyn.test'), 1)
  await route.handler({ headers: { host: 'dyn.test' } }, {})
  assert.deepEqual(trustedHosts, ['dyn.test'])
  assert.deepEqual(fenceHosts, ['dyn.test'])
  assert.equal(registered(), 2, 'fence 已含条目时不重复登记,仅补镜像')

  // 回填后卸载:台账覆盖回填条目,两侧均清理干净
  dispose()
  assert.deepEqual(trustedHosts, [])
  assert.deepEqual(fenceHosts, [])
})

test('场景52 组合回归 换代撤销与外部移除回填: Given 宿主重建数组携带前代两条动态条目 When 新代接管撤销、旧代卸载、重访与外部移除交替发生 Then 两类数组口径始终一致且卸载归零', async (t) => {
  const output = mockConsole(t)
  const { ctx, webServer, trustedHosts, holder, fenceHosts, fenceHolder } = createCtx()
  webServer.register({ kind: 'exact', path: '/api/x', handler: async () => {} })
  const dispose1 = apply(ctx, { maxHosts: 2 })
  const route = webServer.exact.get('/api/x')

  await route.handler({ headers: { host: 'a.test' } }, {})
  await route.handler({ headers: { host: 'b.test' } }, {})
  assert.deepEqual(trustedHosts, ['a.test', 'b.test'])
  assert.deepEqual(fenceHosts, ['a.test', 'b.test'])

  // 宿主重建两类数组并复制两条动态条目:无请求触发探测,新代接管即撤销(K1)
  const rebuiltMirror = ['official.test', 'a.test', 'b.test']
  holder.current = { trustedHosts: rebuiltMirror }
  const rebuiltFence = ['official.test', 'a.test', 'b.test']
  fenceHolder.current = { trustedHosts: rebuiltFence }
  const dispose2 = apply(ctx, { maxHosts: 2 })
  assert.deepEqual(rebuiltMirror, ['official.test'])
  assert.deepEqual(rebuiltFence, ['official.test'])
  assert.ok(output.some(([, message]) => message === 'auto-trust-all: revoked host a.test'))
  assert.ok(output.some(([, message]) => message === 'auto-trust-all: revoked host b.test'))

  // 旧代卸载:撤销时归属与旧代记账已清,不得回填或误删
  dispose1()
  assert.deepEqual(rebuiltMirror, ['official.test'])
  assert.deepEqual(rebuiltFence, ['official.test'])

  // 新代重访回填,再被外部移除后重访仍回填(K2),两数组顺序与两侧口径一致
  await route.handler({ headers: { host: 'b.test' } }, {})
  rebuiltMirror.splice(rebuiltMirror.indexOf('b.test'), 1)
  rebuiltFence.splice(rebuiltFence.indexOf('b.test'), 1)
  await route.handler({ headers: { host: 'b.test' } }, {})
  assert.deepEqual(rebuiltMirror, ['official.test', 'b.test'])
  assert.deepEqual(rebuiltFence, ['official.test', 'b.test'])

  await route.handler({ headers: { host: 'a.test' } }, {})
  assert.deepEqual(rebuiltMirror, ['official.test', 'b.test', 'a.test'])
  assert.deepEqual(rebuiltFence, ['official.test', 'b.test', 'a.test'])

  // 卸载归零:官方条目保留,动态条目全部撤销
  dispose2()
  assert.deepEqual(rebuiltMirror, ['official.test'])
  assert.deepEqual(rebuiltFence, ['official.test'])
})

test('场景53 官方条目被宿主恢复同名不误删: Given 官方条目被宿主移出后由请求动态补位 When 宿主重建数组恢复该官方条目 Then 卸载与换代都不撤它', async (t) => {
  const output = mockConsole(t)

  // 卸载路径:官方 lan.test 被移出 → 动态补位 → 宿主重建数组恢复官方条目 → 卸载
  {
    const { ctx, webServer, trustedHosts, holder, fenceHosts, fenceHolder } = createCtx({ trustedHosts: ['lan.test'] })
    webServer.register({ kind: 'exact', path: '/api/x', handler: async () => {} })
    const dispose = apply(ctx, { maxHosts: 4 })
    const route = webServer.exact.get('/api/x')

    // 官方条目先行命中,建立官方身份
    await route.handler({ headers: { host: 'lan.test' } }, {})
    fenceHosts.splice(fenceHosts.indexOf('lan.test'), 1)
    trustedHosts.splice(trustedHosts.indexOf('lan.test'), 1)
    // 宿主移出后该 Host 重访:本插件动态补位(此时归属已属本代)
    await route.handler({ headers: { host: 'lan.test' } }, {})
    assert.deepEqual(fenceHosts, ['lan.test'])
    assert.deepEqual(trustedHosts, ['lan.test'])

    // 宿主重建两类数组并恢复官方条目(数组引用换代)
    const rebuiltFence = ['lan.test']
    fenceHolder.current = { trustedHosts: rebuiltFence }
    const rebuiltMirror = ['lan.test']
    holder.current = { trustedHosts: rebuiltMirror }
    dispose()
    assert.deepEqual(rebuiltFence, ['lan.test'], '卸载不得撤销宿主恢复的官方条目')
    assert.deepEqual(rebuiltMirror, ['lan.test'])
  }

  // 接管路径:同一形态由新代接管撤销,官方条目不是动态残留
  {
    const { ctx, webServer, trustedHosts, holder, fenceHosts, fenceHolder } = createCtx({ trustedHosts: ['lan.test'] })
    webServer.register({ kind: 'exact', path: '/api/x', handler: async () => {} })
    const dispose1 = apply(ctx, { maxHosts: 4 })
    const route = webServer.exact.get('/api/x')

    await route.handler({ headers: { host: 'lan.test' } }, {})
    fenceHosts.splice(fenceHosts.indexOf('lan.test'), 1)
    trustedHosts.splice(trustedHosts.indexOf('lan.test'), 1)
    await route.handler({ headers: { host: 'lan.test' } }, {})
    const rebuiltFence = ['lan.test']
    fenceHolder.current = { trustedHosts: rebuiltFence }
    const rebuiltMirror = ['lan.test']
    holder.current = { trustedHosts: rebuiltMirror }

    const dispose2 = apply(ctx, { maxHosts: 4 })
    assert.deepEqual(rebuiltFence, ['lan.test'], '接管撤销不得删宿主恢复的官方条目')
    assert.deepEqual(rebuiltMirror, ['lan.test'])
    assert.ok(!output.some(([, message]) => message === 'auto-trust-all: revoked host lan.test'))

    dispose1()
    dispose2()
    assert.deepEqual(rebuiltFence, ['lan.test'])
    assert.deepEqual(rebuiltMirror, ['lan.test'])
  }
})

test('场景54 外部移除后他方写回同名: Given 本代条目被外部从同一数组移除后他方写回同名 When 归属已随换代清理 Then 卸载不得凭陈旧台账撤销他方条目,官方与他方异名条目不受牵连', async (t) => {
  mockConsole(t)
  const { ctx, webServer, trustedHosts, holder, fenceHosts, fenceHolder } = createCtx({ trustedHosts: ['official.test'] })
  webServer.register({ kind: 'exact', path: '/api/x', handler: async () => {} })
  const dispose1 = apply(ctx, { maxHosts: 4 })
  const route = webServer.exact.get('/api/x')

  await route.handler({ headers: { host: 'dyn.test' } }, {})
  assert.deepEqual(fenceHosts, ['official.test', 'dyn.test'])
  assert.deepEqual(trustedHosts, ['official.test', 'dyn.test'])

  // 外部(宿主收缩或其他写入方)从同一数组移除本代条目:引用不变,台账仍含该域名
  fenceHosts.splice(fenceHosts.indexOf('dyn.test'), 1)
  trustedHosts.splice(trustedHosts.indexOf('dyn.test'), 1)

  // 新代接管:前代条目已不在数组,撤销无事可做,归属被清理
  const dispose2 = apply(ctx, { maxHosts: 4 })
  assert.deepEqual(fenceHosts, ['official.test'])
  assert.deepEqual(trustedHosts, ['official.test'])

  // 他方在归属清理之后写回同名条目,并写入自己的异名条目
  fenceHosts.push('dyn.test')
  trustedHosts.push('dyn.test')
  fenceHosts.push('other.test')
  trustedHosts.push('other.test')

  // 两代卸载:只能撤销仍属本代的条目,陈旧台账不得命中他方写回
  dispose1()
  dispose2()
  assert.deepEqual(fenceHosts, ['official.test', 'dyn.test', 'other.test'], '归属已清的他方写回不得被陈旧台账撤销')
  assert.deepEqual(trustedHosts, ['official.test', 'dyn.test', 'other.test'])
  assert.deepEqual(holder.current.trustedHosts, trustedHosts)
})

test('场景55 重建后任意请求不得把官方名记入台账: Given 官方条目被宿主移出后由本插件动态补位、宿主重建数组恢复官方条目 When 其后任意请求触发换代探测 Then 卸载只撤本插件实际推入的条目,官方条目保留', async (t) => {
  mockConsole(t)
  const { ctx, webServer, trustedHosts, holder, fenceHosts, fenceHolder } = createCtx({ trustedHosts: ['lan.test'] })
  webServer.register({ kind: 'exact', path: '/api/x', handler: async () => {} })
  const dispose = apply(ctx, { maxHosts: 4 })
  const route = webServer.exact.get('/api/x')

  // 官方条目被宿主从两类数组移出,同一 Host 重访触发动态补位(本插件实际 push)
  await route.handler({ headers: { host: 'lan.test' } }, {})
  fenceHosts.splice(fenceHosts.indexOf('lan.test'), 1)
  trustedHosts.splice(trustedHosts.indexOf('lan.test'), 1)
  await route.handler({ headers: { host: 'lan.test' } }, {})
  assert.deepEqual(fenceHosts, ['lan.test'])

  // 宿主重建两类数组并恢复官方条目
  const rebuiltFence = ['lan.test']
  fenceHolder.current = { trustedHosts: rebuiltFence }
  const rebuiltMirror = ['lan.test']
  holder.current = { trustedHosts: rebuiltMirror }

  // 任意请求触发换代探测:数组已含官方名,台账只记本调用实际 push 的条目
  await route.handler({ headers: { host: 'probe.test' } }, {})
  assert.deepEqual(rebuiltFence, ['lan.test', 'probe.test'])
  assert.deepEqual(rebuiltMirror, ['lan.test', 'probe.test'])

  dispose()
  assert.deepEqual(rebuiltFence, ['lan.test'], '官方条目不得因换代探测补记台账而在卸载时被撤销')
  assert.deepEqual(rebuiltMirror, ['lan.test'])
})

test('场景56 镜像既存官方条目不记台账: Given 官方条目只被宿主从 fence 移出、镜像仍在场 When 该 Host 重访动态补位 Then 卸载只撤 fence 侧实际推入的条目,官方镜像保留', async (t) => {
  mockConsole(t)
  const { ctx, webServer, trustedHosts, fenceHosts } = createCtx({ trustedHosts: ['lan.test'] })
  webServer.register({ kind: 'exact', path: '/api/x', handler: async () => {} })
  const dispose = apply(ctx, { maxHosts: 4 })
  const route = webServer.exact.get('/api/x')

  // 官方条目只从 fence 移出,镜像仍是宿主维护的官方条目
  fenceHosts.splice(fenceHosts.indexOf('lan.test'), 1)
  await route.handler({ headers: { host: 'lan.test' } }, {})
  assert.deepEqual(fenceHosts, ['lan.test'])
  assert.deepEqual(trustedHosts, ['lan.test'])

  dispose()
  assert.deepEqual(fenceHosts, [], 'fence 侧本插件推入的动态条目照常撤销')
  assert.deepEqual(trustedHosts, ['lan.test'], '镜像侧既存官方条目不因同步被记台账而删除')
})

test('场景57 双实例归属隔离: Given 两个宿主实例各有动态条目 When 一个实例的换代接管后两实例分别卸载 Then 任一代只撤自己实例的条目,本实例卸载仍能清空自己的动态条目', async (t) => {
  const output = mockConsole(t)
  const first = createCtx()
  const second = createCtx()
  first.webServer.register({ kind: 'exact', path: '/api/x', handler: async () => {} })
  second.webServer.register({ kind: 'exact', path: '/api/x', handler: async () => {} })
  const disposeFirst = apply(first.ctx, { maxHosts: 4 })
  const disposeSecond = apply(second.ctx, { maxHosts: 4 })
  const firstRoute = first.webServer.exact.get('/api/x')
  const secondRoute = second.webServer.exact.get('/api/x')

  await firstRoute.handler({ headers: { host: 'a.test' } }, {})
  await secondRoute.handler({ headers: { host: 'b.test' } }, {})
  assert.deepEqual(first.fenceHosts, ['a.test'])
  assert.deepEqual(first.trustedHosts, ['a.test'])
  assert.deepEqual(second.fenceHosts, ['b.test'])
  assert.deepEqual(second.trustedHosts, ['b.test'])

  // 第二实例换代接管:只撤销本实例条目,第一实例的归属与数组都不得被触碰
  const disposeSecond2 = apply(second.ctx, { maxHosts: 4 })
  assert.deepEqual(first.fenceHosts, ['a.test'], '另一实例的接管不得撤本实例条目')
  assert.deepEqual(first.trustedHosts, ['a.test'])
  assert.deepEqual(second.fenceHosts, [], '本实例接管照常撤销前代条目')
  assert.ok(output.some(([, message]) => message === 'auto-trust-all: revoked host b.test'))

  // 第二实例新代重新登记,两实例各自持有条目
  await secondRoute.handler({ headers: { host: 'b2.test' } }, {})
  assert.deepEqual(second.fenceHosts, ['b2.test'])

  // 第一实例卸载:归属必须还在本实例手里,动态条目清空(跨实例误删归属时这里会残留)
  disposeFirst()
  assert.deepEqual(first.fenceHosts, [], '本实例卸载必须清掉自己的动态条目,不得因另一实例接管而残留')
  assert.deepEqual(first.trustedHosts, [])

  // 第二实例口径不受第一实例卸载影响
  assert.deepEqual(second.fenceHosts, ['b2.test'])
  disposeSecond()
  disposeSecond2()
  assert.deepEqual(second.fenceHosts, [])
  assert.deepEqual(second.trustedHosts, [])
})
