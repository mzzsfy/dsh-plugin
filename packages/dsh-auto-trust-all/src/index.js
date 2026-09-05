// dsh-auto-trust-all Host 半区:把每个实际到达请求的 Host 头注册进
// webRuntime.trustedHosts,令官方 Host/Origin 信任闸门(可达性闸门,官方文档
// 明言"绝不建立身份")对泛域名等无法枚举的入口动态放行;原生 cookie 认证与
// startup-auth 会话闸门不受影响。注册容量封顶,超出按最久未访问(LRU)淘汰,
// 淘汰与卸载清理同步作用于 webRuntime 与 connection 两侧数组;启动状态与每次
// 注册、淘汰均直接输出到 console,供用户确认生效与入口审计。

import z from '@deepseek-ai/schemastery'

export const name = 'dsh-auto-trust-all'

// 仅静态声明跨版本基座服务;webRuntime 版本面较新且与本插件在同一波激活中
// 就绪(strict get 要求提供方 fiber 已激活),按 AGENTS.md 兼容性规约走
// 事件延迟激活,真缺失时保持静默订阅,不产生 pending
export const inject = ['webServer']

// 注册域名容量:约束本插件注册的条目(最久未访问者先淘汰),下界 1 防零容量
// 死循环,上界防热路径线性扫描被超大配置放大;官方初始条目(局域网 IP 等)
// 由部署派生,不在淘汰范围
export const Config = z.object({
  maxHosts: z.number().step(1).min(1).max(4096).default(100).description('注册域名容量,超出按最久未访问淘汰'),
})

/** @param {import('@deepseek-ai/cordis').Context} ctx */
export function apply(ctx, config) {
  const maxHosts = config.maxHosts
  const webServer = ctx.webServer
  const ready = () => Array.isArray(ctx.get('webRuntime')?.trustedHosts)
  let activated = false
  let registerWarned = false

  // 归属记账(应用作用域,dispose 据此清理):owned 仅记本插件注册的条目,
  // Map 迭代序即访问序,delete+set 完成 O(1) 续期;pre 记激活前既有的官方
  // 条目,只做去重,不入淘汰;两表与信任数组绑定,webRuntime 重建提供新数组
  // 时一并清空,旧域名重新登记
  let owned = new Map()
  const pre = new Set()
  let seenFor = null
  let fenceFor = null
  const fenceAdded = new Set()

  // 闸门同构提取:new URL('http://' + authority).hostname,小写、去端口、IPv6 保留方括号;
  // 单槽 memo 缓存原串解析结果,重复 Host 的热路径免重复解析
  let lastRaw = null
  let lastHostname
  function hostnameOf(headers) {
    const header = headers ? headers.host : undefined
    if (typeof header !== 'string' || header === '') return undefined
    if (header === lastRaw) return lastHostname
    lastRaw = header
    try {
      lastHostname = new URL('http://' + header).hostname
    } catch {
      lastHostname = undefined
    }
    return lastHostname
  }

  const syncFence = (hostname) => {
    if (hostname === undefined) return
    const fenceHosts = ctx.get('connection')?.trustedHosts
    if (!Array.isArray(fenceHosts)) return
    if (fenceFor !== fenceHosts) {
      fenceFor = fenceHosts
      fenceAdded.clear()
    }
    if (fenceAdded.has(hostname) || fenceHosts.includes(hostname)) return
    fenceHosts.push(hostname)
    fenceAdded.add(hostname)
  }

  // 从信任数组移除单条:淘汰与卸载清理共用;条目不在场时幂等
  const removeFromHosts = (hostname) => {
    const hosts = ctx.get('webRuntime')?.trustedHosts
    if (!Array.isArray(hosts)) return false
    const index = hosts.indexOf(hostname)
    if (index < 0) return false
    hosts.splice(index, 1)
    return true
  }

  // 从 fence 移除单条:仅撤销本插件实际推入的条目,他方写入的同名条目
  // (fence 与 webRuntime 发散时)不越权删除
  const removeFromFence = (hostname) => {
    const fenceHosts = ctx.get('connection')?.trustedHosts
    if (!Array.isArray(fenceHosts)) return
    if (fenceFor !== fenceHosts || !fenceAdded.has(hostname)) return
    const index = fenceHosts.indexOf(hostname)
    if (index >= 0) fenceHosts.splice(index, 1)
    fenceAdded.delete(hostname)
  }

  // loopback 判定与官方 isLoopbackHostname 同构(精确 localhost、[::1]、127/8 四段):
  // 官方闸门对其恒放行,登记零增益;浏览器语义的 *.localhost 官方并不放行,照常登记
  const isLoopback = (hostname) =>
    hostname === 'localhost' || hostname === '[::1]' || /^127(?:\.\d{1,3}){3}$/.test(hostname)

  const touch = (hostname) => {
    owned.delete(hostname)
    owned.set(hostname, true)
  }

  const registerHost = (req) => {
    const hosts = ctx.get('webRuntime')?.trustedHosts
    if (!Array.isArray(hosts)) return
    if (hosts !== seenFor) {
      seenFor = hosts
      owned.clear()
      pre.clear()
    }
    const hostname = hostnameOf(req && req.headers)
    if (hostname === undefined) return
    // 归属命中分支先于 loopback 判定:已登记条目必非 loopback,热路径免重复判定
    if (owned.has(hostname)) {
      touch(hostname)
      syncFence(hostname)
      return
    }
    if (isLoopback(hostname)) return
    // 激活前已存在的条目(官方初始条目)只记入去重集合,不占归属容量
    if (pre.has(hostname) || hosts.includes(hostname)) {
      pre.add(hostname)
      syncFence(hostname)
      return
    }
    while (owned.size >= maxHosts) {
      const oldest = owned.keys().next().value
      owned.delete(oldest)
      removeFromFence(oldest)
      if (removeFromHosts(oldest)) console.log('auto-trust-all: evicted host ' + oldest)
    }
    owned.set(hostname, true)
    hosts.push(hostname)
    syncFence(hostname)
    console.log('auto-trust-all: registered host ' + hostname)
  }

  const activate = () => {
    if (activated) return
    const initialHosts = ctx.get('webRuntime')?.trustedHosts
    if (!Array.isArray(initialHosts)) return
    // 宿主面形态探测:路由表缺 Map 形态或注册方法缺失时干净禁用,不抛错不半装
    if (
      ![webServer.exact, webServer.prefixes, webServer.upgrades].every((table) => table instanceof Map) ||
      typeof webServer.register !== 'function'
    ) {
      console.warn('auto-trust-all: webServer 路由表形态不符预期,插件停用(宿主面可能已变化)')
      return
    }
    activated = true

    // 注册函数挂载为 webServer 上的共享载体:插件重载/行级 config 变更时新
    // activate 覆盖它,旧代包装动态改道到最新一代
    webServer.autoTrustAllRegister = registerHost

    // 标记防重复包装:本插件重载后旧包装仍在路由表内,已标记的 handler 不再叠加,
    // 经共享载体继续服务
    const WRAPPED = 'autoTrustAllWrapped'
    // 同步包装:注册是纯同步观察,无需 async 引入的额外 promise 与微任务
    const wrap = (handler) => {
      if (typeof handler !== 'function' || handler[WRAPPED]) return handler
      const wrapped = (...args) => {
        try {
          webServer.autoTrustAllRegister(args[0])
          registerWarned = false
        } catch (error) {
          // 注册是纯观察,失败不阻断请求;限频告警防风暴,注册恢复后自动复位再告警
          if (!registerWarned) {
            registerWarned = true
            console.warn('auto-trust-all: 注册调用失败,恢复前不再提示: ' + (error instanceof Error ? error.message : String(error)))
          }
        }
        return handler(...args)
      }
      wrapped[WRAPPED] = true
      return wrapped
    }
    const wrapRoute = (route) => {
      route.handler = wrap(route.handler)
    }

    // 回溯:激活前已注册的路由原地替换 handler,请求分发实时读该属性即生效
    for (const route of webServer.exact.values()) wrapRoute(route)
    for (const route of webServer.prefixes.values()) wrapRoute(route)
    for (const route of webServer.upgrades.values()) wrapRoute(route)
    if (webServer.fallback !== undefined) webServer.fallback = wrap(webServer.fallback)

    // 遮蔽注册方法拦截后续注册;委托捕获时的当前值而非原型方法,与 startup-auth
    // 的同类遮蔽在任意激活顺序下都保持链式,不绕过它的会话包装;影子自身带标记,
    // 重复激活不叠加遮蔽层
    const SHADOWED = 'autoTrustAllShadowed'
    const wrapThenDelegate = (route, previous) => {
      wrapRoute(route)
      return previous.call(webServer, route)
    }
    const shadowMethod = (method, delegate) => {
      const previous = webServer[method]
      if (typeof previous !== 'function') {
        console.warn('auto-trust-all: webServer.' + method + ' 非函数,跳过遮蔽,宿主面可能已变化')
        return
      }
      if (previous[SHADOWED]) return
      const shadow = (argument) => delegate(argument, previous)
      shadow[SHADOWED] = true
      webServer[method] = shadow
    }
    shadowMethod('register', wrapThenDelegate)
    shadowMethod('registerUpgrade', wrapThenDelegate)
    shadowMethod('registerFallback', (handler, previous) => previous.call(webServer, wrap(handler)))

    // 启动横幅:绑定、容量与既有信任条目一屏可见
    console.log('auto-trust-all: 动态信任已启用 (bind ' + webServer.host + ', 容量 ' + maxHosts + '), 既有信任 ' + initialHosts.length + ' 项: ' + (initialHosts.join(', ') || '无'))
  }

  if (ready()) {
    activate()
  } else {
    // 冷启动时序:webRuntime 提供方与本插件在同一波激活中,其 fiber 完成激活
    // (转 state 2)时会对自有服务发 internal/service,彼时 strict get 可解析
    console.log('auto-trust-all: webRuntime 未就绪,待其激活后自动启用')
    ctx.on('internal/service', (name) => {
      if (name === 'webRuntime') activate()
    })
  }

  // 卸载即断开注册并撤销本代放行:载体身份一致才执行(新代已接管时跳过,
  // 防旧代误删新一代记账中的条目,窗口内遗留条目由新代视同官方吸收),
  // 归属表内条目从两侧数组移除,信任放行随插件移除停止;未激活时表为空,幂等
  return () => {
    activated = true
    if (webServer.autoTrustAllRegister === registerHost) {
      webServer.autoTrustAllRegister = () => {}
      for (const hostname of owned.keys()) {
        removeFromHosts(hostname)
        removeFromFence(hostname)
      }
    }
    owned.clear()
  }
}
