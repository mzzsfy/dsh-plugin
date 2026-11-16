// dsh-auto-trust-all Host 半区:把每个实际到达请求的 Host 头注册进 connection
// 服务的信任数组,令官方 Host/Origin 信任闸门(可达性闸门,官方文档明言"绝不
// 建立身份")对泛域名等无法枚举的入口动态放行;原生 cookie 认证与 startup-auth
// 会话闸门不受影响。webRuntime.trustedHosts 在场时同步镜像(旧代同构自守卫
// 插件读它,缺席即静默降级)。注册容量封顶,超出按最久未访问(LRU)淘汰,淘汰
// 与卸载清理作用于两类数组;换代接管即凭跨代共享归属表撤销前代条目,旧动态
// 信任不留存至重启。启动状态与每次注册、淘汰、撤销均直接输出到 console,
// 供用户确认生效与入口审计。

import z from '@deepseek-ai/schemastery'

export const name = 'dsh-auto-trust-all'

// 仅静态声明跨版本基座服务;connection 与本插件在同一波激活中就绪(strict get
// 要求提供方 fiber 已激活),按 AGENTS.md 兼容性规约走事件延迟激活,真缺失时
// 保持静默订阅,不产生 pending
export const inject = ['webServer']

// 等待提示阈值:connection 与本插件同波激活,正常冷启动数秒内就绪,立即打印
// 等待行属启动噪音;等待超过该时长仍未就绪才输出
const READY_NOTICE_DELAY = 15 * 1000

// 注册域名容量:约束本插件注册的条目(最久未访问者先淘汰),下界 1 防零容量
// 死循环,上界防热路径线性扫描被超大配置放大;官方初始条目(局域网 IP 等)
// 由部署派生,不在淘汰范围
export const Config = z.object({
  maxHosts: z.number().step(1).min(1).max(4096).default(100).description('注册域名容量,超出按最久未访问淘汰'),
})

// 信任数组受支持形态:可变数组才能承载运行时登记(各代宿主的共同源码形态,
// 非官方稳定公开契约);冻结数组视同宿主面变化,不写入
const supportedArray = (value) => Array.isArray(value) && !Object.isFrozen(value)

// 跨代共享归属表(按宿主实例分区):域名 -> 拥有该条目的代号令牌。同一 webServer
// 上各代(行级 config 热重载、市场启停、同包双行重叠)共用一张表;不同实例各有
// 各的表——任一代只撤销自己实例的条目,否则一个实例的接管会删掉另一个实例的
// 归属,对方卸载时跳过删除,Host 永久残留。仅模块重新求值且未先卸载旧代的路径
// 例外,见 README「已知行为与边界」
const ownershipByServer = new WeakMap()

const ownershipOf = (webServer) => {
  let table = ownershipByServer.get(webServer)
  if (table === undefined) {
    table = new Map()
    ownershipByServer.set(webServer, table)
  }
  return table
}

// 跨代共享写入台账:信任数组引用 -> 本插件实际推入该数组的域名。删除只作用于
// 台账命中的条目,他方写入的同名条目不越权删除;数组换代后按新引用重新记账
const pushedTo = new WeakMap()

// 代号令牌 -> 本代归属记账:新代接管撤销前代条目时同步清掉前代记忆,防前代
// 随后重新成为最新 ACTIVE 代时把已撤销域名当有效条目回填进换代后的信任数组
const ownedByToken = new WeakMap()

// 代号令牌 -> 本代官方条目前缀缓存:换代接管时清旧代缓存,防旧代把新代动态条目
// 当成官方条目跳过登记,卸载后请求即永久 403
const preByToken = new WeakMap()

// 代号令牌 -> 本代认作官方(宿主自己维护)的域名:这些名字由宿主决定可信性,
// 动态接管只是补位;宿主重建数组恢复同名时不得当成动态残留撤销。按代记账,
// 宿主官方清单随代更新
const officialByToken = new WeakMap()

// 代际注册表载体键:挂 webServer 而非模块级,同包双行重叠与模块重新求值共用
// 同一张表。包装器每请求按表解析最新 ACTIVE 代;最新代先卸载时自动回落到仍
// ACTIVE 的次新代,动态信任不会因单槽载体被清空而永久静默失效。
const GENERATIONS_KEY = 'autoTrustAllGenerations'

// cordis FiberState.ACTIVE;缺失 fiber 的测试桩按 ACTIVE 处理(真实 ctx 恒有)
const FIBER_ACTIVE = 2
const isActiveFiber = (fiber) => (fiber?.state ?? FIBER_ACTIVE) === FIBER_ACTIVE

const generationsOf = (webServer) => {
  if (!(webServer[GENERATIONS_KEY] instanceof Map)) webServer[GENERATIONS_KEY] = new Map()
  return webServer[GENERATIONS_KEY]
}

// 最新 ACTIVE 代:Map 插入序即代际先后,后插入者新;跳过热禁用(Fiber 非 ACTIVE)
// 但 disposer 未调用的代际,使仍 ACTIVE 的旧代继续服务
const latestActiveGeneration = (webServer) => {
  let latest = null
  for (const generation of generationsOf(webServer).values()) {
    if (isActiveFiber(generation.fiber)) latest = generation
  }
  return latest
}

/** @param {import('@deepseek-ai/cordis').Context} ctx */
export function apply(ctx, config) {
  const maxHosts = config.maxHosts
  const webServer = ctx.webServer
  const ready = () => ctx.get('connection')?.trustedHosts !== undefined
  let activated = false
  let registerWarned = false
  let noticeTimer = null

  // 本代身份:归属表按它区分代际,接管时撤销他代条目,卸载时只撤仍属本代的条目
  const token = {}

  // 归属记账(应用作用域):owned 仅记本代注册的条目,Map 迭代序即访问序,
  // delete+set 完成 O(1) 续期;pre 记激活前既有的官方条目,只做去重,不入淘汰;
  // 推入某数组的域名记入该数组的跨代台账(预存条目不取得归属,他方写入不越权
  // 删除),数组换代即按新引用重建台账,仍有效的动态条目回填新数组;全局 LRU
  // 不随单侧换代清空
  const owned = new Map()
  const pre = new Set()
  // 本代认作官方的域名(激活时既有的非动态条目 + 运行期以官方身份命中的条目)
  const official = new Set()
  let seenFor = null
  let mirrorFor = null
  ownedByToken.set(token, owned)
  preByToken.set(token, pre)
  officialByToken.set(token, official)
  // 本实例的跨代归属表:按 webServer 分区,多实例宿主的接管/卸载互不可见
  const ownership = ownershipOf(webServer)

  // 取数组对应的写入台账(首次接触即建):台账随数组引用存活,换代自动重记
  const entryBook = (hosts) => {
    let book = pushedTo.get(hosts)
    if (book === undefined) {
      book = new Set()
      pushedTo.set(hosts, book)
    }
    return book
  }

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

  // webRuntime 镜像同步:数组换代即按新引用重建台账并回填;数组事实以 includes
  // 为准——台账命中但数组已不含该条目(外部移除)时同样回填。台账只记本调用
  // 实际推入镜像的域名:镜像既存的官方/他方条目只做展示,卸载按归属兜底判定
  const syncMirror = (hostname) => {
    if (hostname === undefined) return
    const mirrorHosts = ctx.get('webRuntime')?.trustedHosts
    if (!supportedArray(mirrorHosts)) return
    if (mirrorFor !== mirrorHosts) {
      mirrorFor = mirrorHosts
      const book = entryBook(mirrorHosts)
      for (const known of owned.keys()) {
        if (ownership.get(known) !== token) continue
        if (mirrorHosts.includes(known)) continue
        mirrorHosts.push(known)
        book.add(known)
      }
    }
    if (mirrorHosts.includes(hostname)) return
    mirrorHosts.push(hostname)
    if (ownership.get(hostname) === token) entryBook(mirrorHosts).add(hostname)
  }

  // 从数组移除单条。allowedOwner 为持有该条目的代号令牌:卸载清理传本代,接管
  // 撤销传被撤销代。归属与记账是删除的第一凭据——台账只记本插件实际 push 进该
  // 数组的条目,仍可能因外部改写而陈旧,故台账命中也要校验归属;归属不符只清
  // 台账不动数组,他方写入的同名条目不越权删除。台账未命中说明当前数组不是本
  // 插件写入过的那个(宿主重建):官方类条目由宿主自己维护,恢复同名不视为动态
  // 残留,同样不删。兜底依赖归属与记账尚未清理,调用方必须先撤销再删归属
  const removeOwned = (hosts, hostname, allowedOwner) => {
    if (!supportedArray(hosts)) return false
    const booked = pushedTo.get(hosts)?.delete(hostname) === true
    if (ownership.get(hostname) !== allowedOwner) return false
    if (ownedByToken.get(allowedOwner)?.has(hostname) !== true) return false
    if (!booked && officialByToken.get(allowedOwner)?.has(hostname) === true) return false
    const index = hosts.indexOf(hostname)
    if (index < 0) return false
    hosts.splice(index, 1)
    return true
  }

  const removeFromFence = (hostname, allowedOwner = token) =>
    removeOwned(ctx.get('connection')?.trustedHosts, hostname, allowedOwner)

  const removeFromMirror = (hostname, allowedOwner = token) =>
    removeOwned(ctx.get('webRuntime')?.trustedHosts, hostname, allowedOwner)

  // loopback 判定与官方 isLoopbackHostname 同构(精确 localhost、[::1]、127/8 四段;
  // 官方另有每段 ≤255 校验,本包从简:非法形态跳过登记属保守方向,不影响放行语义):
  // 官方闸门对其恒放行,登记零增益;浏览器语义的 *.localhost 官方并不放行,照常登记
  const isLoopback = (hostname) =>
    hostname === 'localhost' || hostname === '[::1]' || /^127(?:\.\d{1,3}){3}$/.test(hostname)

  const touch = (hostname) => {
    owned.delete(hostname)
    owned.set(hostname, true)
  }

  // 认领数组里由前代登记的动态条目:前代热禁用后本代重新成为最新 ACTIVE 代时,
  // 条目仍在数组中但归属已不属于本代;必须转移归属,不能按官方条目静默跳过。
  // 条目已在数组里(非本调用推入),不记台账——卸载按归属与记账兜底清理
  const claimExisting = (hostname) => {
    const previous = ownership.get(hostname)
    if (previous !== undefined && previous !== token) ownedByToken.get(previous)?.delete(hostname)
    pre.delete(hostname)
    owned.set(hostname, true)
    ownership.set(hostname, token)
    syncMirror(hostname)
  }

  const registerHost = (req) => {
    const hosts = ctx.get('connection')?.trustedHosts
    if (!supportedArray(hosts)) return
    if (hosts !== seenFor) {
      seenFor = hosts
      const book = entryBook(hosts)
      for (const known of owned.keys()) {
        if (ownership.get(known) !== token) continue
        if (hosts.includes(known)) continue
        // 台账只记本调用实际推入的域名:宿主重建数组时可能直接携带旧动态条目,
        // 它们靠归属与记账兜底清理;给"已在数组"的条目补记台账会把宿主恢复的
        // 官方同名条目当成本插件推入的条目,卸载时被撤销
        hosts.push(known)
        book.add(known)
      }
      pre.clear()
    }
    const hostname = hostnameOf(req && req.headers)
    if (hostname === undefined) return
    // 归属命中分支先于 loopback 判定:已登记条目必非 loopback,热路径免重复判定。
    // 归属表已不属本代(新代接管时撤销)则旧记账作废,继续走完整登记路径——保证
    // 新代先卸载、旧代重新成为最新 ACTIVE 代时,被撤销条目的重访能真正回填
    if (owned.has(hostname)) {
      if (ownership.get(hostname) === token) {
        touch(hostname)
        // 条目被外部从同一数组移除后重访:重新登记并补记台账;只看台账会把该
        // Host 一直挡在信任闸门外,直到 LRU 淘汰或重启
        if (!hosts.includes(hostname)) {
          hosts.push(hostname)
          entryBook(hosts).add(hostname)
          console.log('auto-trust-all: registered host ' + hostname)
        }
        syncMirror(hostname)
        return
      }
      owned.delete(hostname)
    }
    if (isLoopback(hostname)) return
    // 官方条目前缀缓存只在条目仍存在且无其他代归属时有效;缓存陈旧(数组已换代)
    // 时删掉继续走登记,避免把已消失的官方条目当成永久放行依据
    if (pre.has(hostname)) {
      if (!hosts.includes(hostname)) pre.delete(hostname)
      else if (ownership.has(hostname) && ownership.get(hostname) !== token) {
        claimExisting(hostname)
        return
      } else {
        syncMirror(hostname)
        return
      }
    }
    // 激活前已存在的条目(官方初始条目)只记入去重集合,不占归属容量;
    // 若数组条目的归属属于前代,按动态条目认领,不能当成官方条目
    if (hosts.includes(hostname)) {
      if (ownership.has(hostname) && ownership.get(hostname) !== token) {
        claimExisting(hostname)
        return
      }
      pre.add(hostname)
      // 以官方身份命中过的名字记入官方清单:日后宿主先移出再恢复同名时不得误删
      official.add(hostname)
      syncMirror(hostname)
      return
    }
    while (owned.size >= maxHosts) {
      const oldest = owned.keys().next().value
      // 先撤销再清归属与记账:removeOwned 的台账未命中兜底要读这两处凭据
      removeFromMirror(oldest)
      const evicted = removeFromFence(oldest)
      owned.delete(oldest)
      if (ownership.get(oldest) === token) ownership.delete(oldest)
      if (evicted) console.log('auto-trust-all: evicted host ' + oldest)
    }
    owned.set(hostname, true)
    ownership.set(hostname, token)
    hosts.push(hostname)
    entryBook(hosts).add(hostname)
    syncMirror(hostname)
    console.log('auto-trust-all: registered host ' + hostname)
  }

  const activate = () => {
    if (activated) return
    const initialHosts = ctx.get('connection')?.trustedHosts
    if (initialHosts === undefined) return
    // 就绪即撤销等待提示,形态守卫停用分支同样不再提示
    clearTimeout(noticeTimer)
    if (!supportedArray(initialHosts)) {
      console.warn('auto-trust-all: connection.trustedHosts 形态不符预期,插件停用(宿主面可能已变化)')
      return
    }
    // 宿主面形态探测:路由表缺 Map 形态或注册方法缺失时干净禁用,不抛错不半装
    if (
      ![webServer.exact, webServer.prefixes, webServer.upgrades].every((table) => table instanceof Map) ||
      typeof webServer.register !== 'function'
    ) {
      console.warn('auto-trust-all: webServer 路由表形态不符预期,插件停用(宿主面可能已变化)')
      return
    }
    activated = true

    // 激活即记官方清单:两类数组里不属于任何代的现存条目由宿主自己维护,后续
    // 即便被宿主短暂移出而由本插件动态补位,宿主重建数组恢复同名时也不得当成
    // 动态残留撤销。仍在归属表或本插件写入台账里的条目不算官方——换代时数组
    // 可能携带着前代动态条目,它们要随接管撤销
    const initialMirror = ctx.get('webRuntime')?.trustedHosts
    const seedSources = supportedArray(initialMirror) ? [initialHosts, initialMirror] : [initialHosts]
    for (const hosts of seedSources) {
      const seededBook = pushedTo.get(hosts)
      for (const hostname of hosts) {
        if (ownership.has(hostname) || seededBook?.has(hostname)) continue
        official.add(hostname)
      }
    }

    // 本代注册表项:registerHost 供任意代包装器按最新 ACTIVE 代解析
    generationsOf(webServer).set(token, { fiber: ctx.fiber, registerHost })
    // 换代即清前代官方条目前缀缓存:旧代重新成为最新 ACTIVE 代时不得把新代动态
    // 条目或已消失的官方条目当成永久放行依据
    for (const generationToken of generationsOf(webServer).keys()) {
      if (generationToken !== token) preByToken.get(generationToken)?.clear()
    }

    // 接管即撤销前代条目:跨代共享归属表里凡不属本代令牌的域名从两类数组移除,
    // 前代随后卸载时归属已不符故不误删;本代从零记账——旧动态信任不留存至重启,
    // 容量只统计在位条目。他方写入的同名条目不在归属表,不在此列。前代注册表项
    // 保留(其 fiber 仍 ACTIVE 时继续兜底);撤销后再清前代归属与记账记忆,防其回填
    // 旧条目——顺序不可颠倒:宿主重建数组时没有新请求重记台账,撤销只能凭归属与
    // 前代 owned 记账兜底
    for (const [hostname, owner] of ownership) {
      if (owner === token) continue
      const inMirror = removeFromMirror(hostname, owner)
      const inFence = removeFromFence(hostname, owner)
      if (inMirror || inFence) console.log('auto-trust-all: revoked host ' + hostname)
      ownership.delete(hostname)
      ownedByToken.get(owner)?.delete(hostname)
    }

    // 标记防重复包装:本插件重载后旧包装仍在路由表内,已标记的 handler 不再叠加,
    // 经代际注册表继续服务
    const WRAPPED = 'autoTrustAllWrapped'
    // 同步包装:注册是纯同步观察,无需 async 引入的额外 promise 与微任务。
    // 代际活性守卫(2026-09-23 rc.1 L3 实测升级):每请求从注册表现取最新 ACTIVE
    // 代——同代 fiber 非 ACTIVE(市场热禁用,disposer 不被调用)即跳过;换代后
    // 改道新代 registerHost,旧包装以新代身份继续服务;最新代先卸载时自动回落到
    // 仍 ACTIVE 的次新代,注册链不中断
    const wrap = (handler) => {
      if (typeof handler !== 'function' || handler[WRAPPED]) return handler
      const wrapped = (...args) => {
        try {
          latestActiveGeneration(webServer)?.registerHost(args[0])
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

    // 启动横幅:绑定、容量、既有信任条目与镜像形态一屏可见
    const mirror = supportedArray(ctx.get('webRuntime')?.trustedHosts)
    console.log('auto-trust-all: 动态信任已启用 (bind ' + webServer.host + ', 容量 ' + maxHosts + '), 既有信任 ' + initialHosts.length + ' 项: ' + (initialHosts.join(', ') || '无') + ', 镜像 webRuntime ' + (mirror ? '在场' : '缺席'))
  }

  if (ready()) {
    activate()
  } else {
    // 冷启动时序:connection 提供方与本插件在同一波激活中,其 fiber 完成激活
    // (转 state 2)时会对自有服务发 internal/service,彼时 strict get 可解析;
    // 等待行延后到 READY_NOTICE_DELAY 仍未就绪时输出,激活或卸载即撤销
    noticeTimer = setTimeout(() => {
      console.log('auto-trust-all: connection 未就绪,待其激活后自动启用')
    }, READY_NOTICE_DELAY)
    ctx.on('internal/service', (name) => {
      if (name === 'connection') activate()
    })
  }

  // 卸载即断开本代注册并撤销本代放行:只删注册表中的自己一项,不触碰他代;
  // 包装器每请求解析最新 ACTIVE 代,仍有 ACTIVE 代时注册自动交回最新代(新代先
  // 卸载的场景由旧代继续服务)。条目按跨代共享归属表判定——仍属本代的从两类
  // 数组移除,已被新代接管的域名不误删。未激活时无表项且 owned 为空,幂等
  return () => {
    activated = true
    clearTimeout(noticeTimer)
    generationsOf(webServer).delete(token)
    for (const hostname of owned.keys()) {
      if (ownership.get(hostname) !== token) continue
      removeFromMirror(hostname)
      removeFromFence(hostname)
      ownership.delete(hostname)
    }
    owned.clear()
    ownedByToken.delete(token)
    pre.clear()
    preByToken.delete(token)
    official.clear()
    officialByToken.delete(token)
  }
}
