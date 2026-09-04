// dsh-auto-trust-all Host 半区:把每个实际到达请求的 Host 头注册进
// webRuntime.trustedHosts,令官方 Host/Origin 信任闸门(可达性闸门,官方文档
// 明言"绝不建立身份")对泛域名等无法枚举的入口动态放行;原生 cookie 认证与
// startup-auth 会话闸门不受影响。注册容量 FIFO 淘汰,启动状态与每次注册、
// 淘汰均直接输出到 console,供用户确认生效与入口审计。

import z from '@deepseek-ai/schemastery'

export const name = 'dsh-auto-trust-all'

// 仅静态声明跨版本基座服务;webRuntime 版本面较新且与本插件在同一波激活中
// 就绪(strict get 要求提供方 fiber 已激活),按 AGENTS.md 兼容性规约走
// 事件延迟激活,真缺失时保持静默订阅,不产生 pending
export const inject = ['webServer']

// 注册域名容量:约束本插件注册的条目(FIFO 淘汰最早者),下界 1 防零容量死循环;
// 官方初始条目(局域网 IP 等)由部署派生,不在淘汰范围
export const Config = z.object({
  maxHosts: z.number().step(1).min(1).default(100).description('注册域名容量,超出按注册先后淘汰'),
})

// 闸门同构提取:new URL('http://' + authority).hostname,小写、去端口、IPv6 保留方括号
function hostnameOf(headers) {
  const header = headers ? headers.host : undefined
  if (typeof header !== 'string' || header === '') return undefined
  try {
    return new URL('http://' + header).hostname
  } catch {
    return undefined
  }
}

/** @param {import('@deepseek-ai/cordis').Context} ctx */
export function apply(ctx, config) {
  const maxHosts = config.maxHosts
  const webServer = ctx.webServer
  const ready = () => Array.isArray(ctx.get('webRuntime')?.trustedHosts)
  let activated = false
  let unregisterFailed = false

  const activate = () => {
    if (activated) return
    const initialHosts = ctx.get('webRuntime')?.trustedHosts
    if (!Array.isArray(initialHosts)) return
    activated = true

    const seen = new Set()
    // FIFO 队列与去重集合同进出(淘汰即双删),规模随容量封顶;
    // 两者与信任数组绑定,webRuntime 重建提供新数组时一并清空,旧域名重新登记
    const queue = []
    let seenFor = null

    const registerHost = (req) => {
      const hosts = ctx.get('webRuntime')?.trustedHosts
      if (!Array.isArray(hosts)) return
      if (hosts !== seenFor) {
        seenFor = hosts
        seen.clear()
        queue.length = 0
      }
      const hostname = hostnameOf(req && req.headers)
      if (hostname === undefined || seen.has(hostname)) return
      // 数组查重:激活前已存在的条目(官方初始条目)只记入去重集合,不入淘汰队列
      if (hosts.includes(hostname)) {
        seen.add(hostname)
        return
      }
      while (queue.length >= maxHosts) {
        const oldest = queue.shift()
        seen.delete(oldest)
        const index = hosts.indexOf(oldest)
        if (index < 0) continue
        hosts.splice(index, 1)
        console.log('auto-trust-all: evicted host ' + oldest)
        break
      }
      seen.add(hostname)
      queue.push(hostname)
      hosts.push(hostname)
      console.log('auto-trust-all: registered host ' + hostname)
    }

    // 注册函数挂载为 webServer 上的共享载体:插件重载/行级 config 变更时新
    // activate 覆盖它,旧代包装动态改道到最新一代
    webServer.autoTrustAllRegister = registerHost

    // 标记防重复包装:本插件重载后旧包装仍在路由表内,已标记的 handler 不再叠加,
    // 经共享载体继续服务
    const WRAPPED = 'autoTrustAllWrapped'
    const wrap = (handler) => {
      if (typeof handler !== 'function' || handler[WRAPPED]) return handler
      const wrapped = async (...args) => {
        try {
          const register = webServer.autoTrustAllRegister
          register(args[0])
        } catch (error) {
          // 注册是纯观察,失败不阻断请求;限频告警防风暴
          if (!unregisterFailed) {
            unregisterFailed = true
            console.warn('auto-trust-all: 注册调用失败,后续不再提示: ' + (error instanceof Error ? error.message : String(error)))
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
    const shadowMethod = (method, delegate) => {
      const previous = webServer[method]
      if (typeof previous !== 'function' || previous[SHADOWED]) return
      const shadow = (argument) => delegate(argument, previous)
      shadow[SHADOWED] = true
      webServer[method] = shadow
    }
    shadowMethod('register', (route, previous) => {
      wrapRoute(route)
      return previous.call(webServer, route)
    })
    shadowMethod('registerUpgrade', (route, previous) => {
      wrapRoute(route)
      return previous.call(webServer, route)
    })
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

  // 卸载即断开注册:载体置空函数,旧代包装退化为纯透传,信任放行随插件移除停止
  return () => {
    activated = true
    webServer.autoTrustAllRegister = () => {}
  }
}
