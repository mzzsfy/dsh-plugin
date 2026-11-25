import { StockError, fail } from './market-model.mjs'
// 每实例上游请求环形日志容量: 概览"最近请求"展示面
const REQUEST_LOG_LIMIT = 20
const DEFAULT_RETRY_AFTER_MS = 60 * 1000
// 上游给的等待时间不能无限冻结某个证券: 超过一小时按一小时算
const MAX_RETRY_AFTER_MS = 60 * 60 * 1000
function retryDelay(value, now) {
  if (!value) return DEFAULT_RETRY_AFTER_MS
  const seconds = Number(value)
  const delay = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(value) - now()
  return Number.isFinite(delay) ? Math.min(MAX_RETRY_AFTER_MS, Math.max(1000, delay)) : DEFAULT_RETRY_AFTER_MS
}
async function untilAbort(work, signal) {
  let abort
  try {
    return await Promise.race([work, new Promise((_, reject) => {
      abort = () => reject(signal.reason instanceof StockError ? signal.reason : new StockError('CANCELLED', '请求已取消', 503))
      signal.addEventListener('abort', abort, { once: true })
      if (signal.aborted) abort()
    })])
  } finally {
    signal.removeEventListener('abort', abort)
  }
}
export function createExecutor({ registry, budget, env = process.env, resolveCredential = async ref => env[ref], fetch: fetchImpl = globalThis.fetch, proxyFetch = null, now = Date.now, timers = globalThis, usSymbols = new Map(), proxyFactory = null, tickPeriodMs = () => 0, tickCapabilities = ['quotes', 'kline', 'trend'] }) {
  const queues = new Map(), controllers = new Set(), starts = new Map()
  const requestLogs = new Map(), proxies = new Map()
  let stopped = false, running = 0
  // probe 标记只给后台探测用: 界面上的"最近请求"只该反映用户请求
  const record = (instanceId, url, status, startedAt, probe = false, message = null) => {
    const log = requestLogs.get(instanceId) || []
    log.unshift({ at: now(), url: String(url), status, ms: Math.max(0, now() - startedAt), ...(message ? { message } : {}), ...(probe ? { probe: true } : {}) })
    if (log.length > REQUEST_LOG_LIMIT) log.length = REQUEST_LOG_LIMIT
    requestLogs.set(instanceId, log)
  }
  // 实例代理 dispatcher: 按代理 URL 惰性创建缓存(多实例共享同代理不重复建); proxyFactory 由宿主注入(undici ProxyAgent)
  // dispatcher 是 undici 的私有契约, Node 内置 fetch 与 userland undici 版本错位时会直接 502:
  // 配了代理就必须用同一份 undici.fetch 发请求; 任一组件缺失都明确报错, 不能静默直连泄露真实出口
  const dispatcherFor = proxy => {
    if (!proxy) return null
    if (typeof proxyFactory !== 'function' || typeof proxyFetch !== 'function') fail('NETWORK', '代理出口不可用：缺少 undici 运行依赖', 502)
    if (!proxies.has(proxy)) {
      let dispatcher
      try { dispatcher = proxyFactory(proxy) } catch (e) { fail('NETWORK', `代理出口不可用：${e.message}`, 502) }
      if (!dispatcher) fail('NETWORK', '代理出口不可用：dispatcher 创建失败', 502)
      proxies.set(proxy, dispatcher)
    }
    return proxies.get(proxy)
  }
  // 代理账号密码只从宿主凭据/环境变量取, 运行时注入 URL; 配置与快照里永远只有 proxyCredentialRef 引用
  const proxyUrlOf = async instance => {
    if (!instance.proxy) return null
    if (!instance.proxyCredentialRef) return instance.proxy
    const secret = await resolveCredential(instance.proxyCredentialRef)
    if (!secret) fail('AUTH', '未配置代理凭据', 422)
    const url = new URL(instance.proxy), separator = secret.indexOf(':')
    url.username = separator < 0 ? secret : secret.slice(0, separator)
    url.password = separator < 0 ? '' : secret.slice(separator + 1)
    return url.toString()
  }
  // 组内节拍等待:上取整加裕度。setTimeout 对非整数 ms 向下取整且唤醒有抖动,
  // 直接 setTimeout(gap) 会在 now-starts<间隔 时醒来,预算层同源时钟误判 RATE_LIMIT
  // (CI 双架构高发竞态);唤醒后 now-starts>=间隔 恒成立,预算门恒过。
  const THROTTLE_SLACK_MS = 5
  const throttleDelay = gap => Math.ceil(gap) + THROTTLE_SLACK_MS
  const waitFor = (ms, signal) => new Promise((resolve, reject) => {
    const abort = () => { timers.clearTimeout(id); reject(new StockError('CANCELLED', '请求已取消', 503)) }
    const id = timers.setTimeout(() => { signal.removeEventListener('abort', abort); resolve() }, ms)
    signal.addEventListener('abort', abort, { once: true }); if (signal.aborted) abort()
  })
  // 兜底节拍: 每个数据源实例一拍最多发一轮请求, 相邻两拍的启用时刻间隔不小于 tickPeriodMs。
  // 一拍内允许多个请求连续发出(报价分批/分时/详情 K 线本来就是一拍的事), 所以只看拍的开拍时刻;
  // 拍的前半段算同一拍, 后半段才封到下一拍 —— 否则同一拍的第二个请求会被推开整整一个周期。
  // 探针与目录同步是一次性动作, 不受节拍约束(否则首次同步会被拖成每页等一个周期)。
  const tickOpenedAt = new Map()
  const tickDelay = (instance, capability, options) => {
    if (options.probe || !tickCapabilities.includes(capability)) return 0
    const period = tickPeriodMs()
    if (!(period > 0)) return 0
    const opened = tickOpenedAt.get(instance.id), at = now()
    if (opened === undefined || at - opened >= period) { tickOpenedAt.set(instance.id, at); return 0 }
    return at - opened > period / 2 ? opened + period - at : 0
  }
  const slots = []
  async function acquire(signal) {
    if (running < 2) { running++; return }
    await new Promise((resolve, reject) => {
      const slot = { resolve: () => { signal.removeEventListener('abort', abort); resolve() } }
      const abort = () => { const i = slots.indexOf(slot); if (i >= 0) slots.splice(i, 1); reject(new StockError('CANCELLED', '请求已取消', 503)) }
      slots.push(slot); signal.addEventListener('abort', abort, { once: true }); if (signal.aborted) abort()
    })
  }
  function release() { if (slots.length) slots.shift().resolve(); else running-- }
  return {
    run(instance, capability, request, options = {}) {
      const group = options.probe ? `${instance.quotaGroup}#probe` : instance.quotaGroup
      const previous = queues.get(group) || Promise.resolve()
      const job = previous.catch(() => {}).then(async () => {
        if (stopped || options.signal?.aborted) fail('CANCELLED', '请求已取消', 503)
        const controller = new AbortController(); controllers.add(controller)
        const abort = () => controller.abort(options.signal?.reason)
        options.signal?.addEventListener('abort', abort, { once: true })
        let timeout, acquired = false
        const startedAt = now()
        try {
          // 闸门放在实际发请求之前, 与 1 秒防连打一起构成两次等待: 先等节拍, 再等组内间隔。
          // 等完再判一次: 等待期间别的请求可能已经开了新拍, 这里要跟着新拍走
          for (let tick = tickDelay(instance, capability, options); tick; tick = tickDelay(instance, capability, options)) await waitFor(throttleDelay(tick), controller.signal)
          const gap = Math.max(0, (starts.get(instance.quotaGroup) ?? -Infinity) + (instance.budget?.requestsPerMinute === null ? 10 * 1000 : 1000) - now())
          if (gap) await waitFor(throttleDelay(gap), controller.signal)
          await acquire(controller.signal); acquired = true
          starts.set(instance.quotaGroup, now())
          const adapter = registry.get(instance.adapterId), method = options.probe ? 'probe' : capability
          if (typeof adapter[method] !== 'function') fail('UNSUPPORTED_CAPABILITY', '来源不支持该能力', 422)
          let used = false
          // 凭据每次操作解析一次, 不跨操作缓存: 存储层改了密钥, 下一次请求就生效, 不必重启插件。
          // 解析在超时计时之前完成——读本地存储不该占用上游的 8 秒预算。
          const secret = instance.credentialRef === null ? undefined : await untilAbort(resolveCredential(instance.credentialRef), controller.signal)
          if (instance.credentialRef !== null && !secret) fail('AUTH', '未配置凭据', 422)
          const proxyUrl = await untilAbort(proxyUrlOf(instance), controller.signal)
          // 超时计时覆盖整个能力调用;分页适配器每次网络活动重置计时,空闲超过窗口才判超时。
          const armTimeout = () => { timers.clearTimeout(timeout); timeout = timers.setTimeout(() => controller.abort(new StockError('TIMEOUT', '来源请求超时', 504, { retryable: true })), 8 * 1000) }
          armTimeout()
          const ctx = { now, signal: controller.signal, usSymbols, endpoints: instance.endpoints || null, credential: () => secret,
            fetch: async (...args) => {
              if (used) {
                const gap = Math.max(0, starts.get(instance.quotaGroup) + (instance.budget?.requestsPerMinute === null ? 10 * 1000 : 1000) - now())
                if (gap) await waitFor(throttleDelay(gap), controller.signal)
              }
              if (controller.signal.aborted) fail('CANCELLED', '请求已取消', 503)
              armTimeout()
              budget.reserve(instance, capability, request.securities?.length || 1, !!options.periodic, !!options.probe); used = true; starts.set(instance.quotaGroup, now())
              const dispatcher = dispatcherFor(proxyUrl)
              const response = await (dispatcher ? proxyFetch : fetchImpl)(args[0], { ...(args[1] || {}), ...(dispatcher ? { dispatcher } : {}) })
              const retryAfter = capability === 'trend' && (response.status === 429 || response.status === 503) ? response.headers?.get('retry-after') : null
              if (capability === 'trend' && (response.status === 429 || (response.status === 503 && retryAfter))) {
                const retryAfterMs = retryDelay(retryAfter, now)
                response.body?.cancel().catch(() => {})
                fail('RATE_LIMIT', '来源请求额度受限', 429, { retryable: true, retryAfterMs })
              }
              armTimeout()
              return response
            } }
          // 免凭据实例(credentialRef=null)解析结果恒为空, 上述守卫不触发。
          const work = Promise.resolve(adapter[method]({ ...request, providerInstanceId: instance.id, capability }, ctx))
          const result = await untilAbort(work, controller.signal)
          if (!used) budget.reserve(instance, capability, request.securities?.length || 1, !!options.periodic, !!options.probe)
          record(instance.id, `${options.probe ? 'probe' : capability} ${instance.adapterId}`, 'ok', startedAt, !!options.probe)
          return result
        } catch (e) {
          const code = e instanceof StockError ? e.code : 'NETWORK'
          // 原因文案由适配器给出: 界面照着念, 不必猜是网络坏了还是被要求过人机验证
          record(instance.id, `${options.probe ? 'probe' : capability} ${instance.adapterId}`, code, startedAt, !!options.probe, e?.message ?? null)
          if (controller.signal.aborted && controller.signal.reason?.code === 'TIMEOUT') throw controller.signal.reason
          // 分时的冷却由分时窗口承接, 不再冻结额度组: 否则同组备源与报价都会被一次限流挡住
          if (e.code === 'RATE_LIMIT' && !options.probe && capability !== 'trend') budget.block?.(instance, Math.min(e.retryAfterMs || DEFAULT_RETRY_AFTER_MS, DEFAULT_RETRY_AFTER_MS))
          if (e instanceof StockError) throw e
          throw new StockError('NETWORK', '数据源请求失败', 502, { retryable: true })
        } finally {
          timers.clearTimeout(timeout); controllers.delete(controller); options.signal?.removeEventListener('abort', abort); if (acquired) release()
        }
      })
      queues.set(group, job)
      job.catch(() => {}).finally(() => { if (queues.get(group) === job) queues.delete(group) })
      return job
    },
    recentRequests: instanceId => [...(requestLogs.get(instanceId) || [])],
    // 有没有活干: 后台探测靠它避让, 不与用户请求抢并发槽和组链
    idle: () => running === 0 && queues.size === 0,
    dispose() { stopped = true; for (const c of controllers) c.abort(); controllers.clear() },
  }
}
