import { StockError, fail } from './market-model.mjs'
// 每实例上游请求环形日志容量: 概览"最近请求"展示面
const REQUEST_LOG_LIMIT = 20
export function createExecutor({ registry, budget, env = process.env, fetch: fetchImpl = globalThis.fetch, now = Date.now, timers = globalThis, usSymbols = new Map(), proxyFactory = null }) {
  const queues = new Map(), controllers = new Set(), starts = new Map()
  const requestLogs = new Map(), proxies = new Map()
  let stopped = false, running = 0
  const record = (instanceId, url, status, startedAt) => {
    const log = requestLogs.get(instanceId) || []
    log.unshift({ at: now(), url: String(url), status, ms: Math.max(0, now() - startedAt) })
    if (log.length > REQUEST_LOG_LIMIT) log.length = REQUEST_LOG_LIMIT
    requestLogs.set(instanceId, log)
  }
  // 实例代理 dispatcher: 按代理 URL 惰性创建缓存(多实例共享同代理不重复建); proxyFactory 由宿主注入(undici ProxyAgent)
  const dispatcherFor = proxy => {
    if (!proxy) return null
    if (!proxies.has(proxy)) {
      try { proxies.set(proxy, proxyFactory ? proxyFactory(proxy) : null) } catch { proxies.set(proxy, null) }
    }
    return proxies.get(proxy)
  }
  // 组内节拍等待:上取整加裕度。setTimeout 对非整数 ms 向下取整且唤醒有抖动,
  // 直接 setTimeout(gap) 会在 now-starts<间隔 时醒来,预算层同源时钟误判 RATE_LIMIT
  // (CI 双架构高发竞态);唤醒后 now-starts>=间隔 恒成立,预算门恒过。
  const THROTTLE_SLACK_MS = 5
  const throttleDelay = gap => Math.ceil(gap) + THROTTLE_SLACK_MS
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
      const previous = queues.get(instance.quotaGroup) || Promise.resolve()
      const job = previous.catch(() => {}).then(async () => {
        if (stopped || options.signal?.aborted) fail('CANCELLED', '请求已取消', 503)
        const controller = new AbortController(); controllers.add(controller)
        const abort = () => controller.abort(options.signal?.reason)
        options.signal?.addEventListener('abort', abort, { once: true })
        let timeout, acquired = false
        const startedAt = now()
        try {
          const gap = Math.max(0, (starts.get(instance.quotaGroup) ?? -Infinity) + (instance.budget?.requestsPerMinute === null ? 10 * 1000 : 1000) - now())
          if (gap) await new Promise((resolve, reject) => {
            const abortWait = () => { timers.clearTimeout(wait); reject(new StockError('CANCELLED', '请求已取消', 503)) }
            const wait = timers.setTimeout(() => { controller.signal.removeEventListener('abort', abortWait); resolve() }, throttleDelay(gap))
            controller.signal.addEventListener('abort', abortWait, { once: true })
          })
          await acquire(controller.signal); acquired = true
          starts.set(instance.quotaGroup, now())
          const adapter = registry.get(instance.adapterId), method = options.probe ? 'probe' : capability
          if (typeof adapter[method] !== 'function') fail('UNSUPPORTED_CAPABILITY', '来源不支持该能力', 422)
          let used = false, timeout
          // 超时计时覆盖整个能力调用;分页适配器每次网络活动重置计时,空闲超过窗口才判超时。
          const armTimeout = () => { timers.clearTimeout(timeout); timeout = timers.setTimeout(() => controller.abort(new StockError('TIMEOUT', '来源请求超时', 504, { retryable: true })), 8 * 1000) }
          armTimeout()
          const ctx = { now, signal: controller.signal, usSymbols, endpoints: instance.endpoints || null, credential: () => instance.credentialEnv === null ? undefined : env[instance.credentialEnv] || fail('AUTH', '未在Host环境中配置凭据', 422),
            fetch: async (...args) => {
              if (used) {
                const gap = Math.max(0, starts.get(instance.quotaGroup) + (instance.budget?.requestsPerMinute === null ? 10 * 1000 : 1000) - now())
                if (gap) await new Promise((resolve, reject) => {
                  const cancel = () => { timers.clearTimeout(id); reject(new StockError('CANCELLED', '请求已取消', 503)) }
                  const id = timers.setTimeout(() => { controller.signal.removeEventListener('abort', cancel); resolve() }, throttleDelay(gap))
                  controller.signal.addEventListener('abort', cancel, { once: true }); if (controller.signal.aborted) cancel()
                })
              }
              if (controller.signal.aborted) fail('CANCELLED', '请求已取消', 503)
              armTimeout()
              budget.reserve(instance, capability, request.securities?.length || 1, !!options.periodic, !!options.probe); used = true; starts.set(instance.quotaGroup, now())
              const dispatcher = dispatcherFor(instance.proxy)
              const response = await fetchImpl(args[0], { ...(args[1] || {}), ...(dispatcher ? { dispatcher } : {}) })
              armTimeout()
              return response
            } }
          // 免凭据实例(credentialEnv=null)跳过Host环境检查;其余沿用原守卫。
          if (instance.credentialEnv !== null && !env[instance.credentialEnv]) fail('AUTH', '未在Host环境中配置凭据', 422)
          const work = Promise.resolve(adapter[method]({ ...request, providerInstanceId: instance.id, capability }, ctx))
          const result = await new Promise((resolve, reject) => {
            const aborted = () => reject(controller.signal.reason instanceof StockError ? controller.signal.reason : new StockError('CANCELLED', '请求已取消', 503))
            controller.signal.addEventListener('abort', aborted, { once: true })
            work.then(resolve, reject).finally(() => controller.signal.removeEventListener('abort', aborted))
            if (controller.signal.aborted) aborted()
          })
          if (!used) budget.reserve(instance, capability, request.securities?.length || 1, !!options.periodic, !!options.probe)
          record(instance.id, `${options.probe ? 'probe' : capability} ${instance.adapterId}`, 'ok', startedAt)
          return result
        } catch (e) {
          const code = e instanceof StockError ? e.code : 'NETWORK'
          record(instance.id, `${options.probe ? 'probe' : capability} ${instance.adapterId}`, code, startedAt)
          if (controller.signal.aborted && controller.signal.reason?.code === 'TIMEOUT') throw controller.signal.reason
          if (e.code === 'RATE_LIMIT') budget.block?.(instance, e.retryAfterMs || 60 * 1000)
          if (e instanceof StockError) throw e
          throw new StockError('NETWORK', '数据源请求失败', 502, { retryable: true })
        } finally {
          timers.clearTimeout(timeout); controllers.delete(controller); options.signal?.removeEventListener('abort', abort); if (acquired) release()
        }
      })
      queues.set(instance.quotaGroup, job)
      job.catch(() => {}).finally(() => { if (queues.get(instance.quotaGroup) === job) queues.delete(instance.quotaGroup) })
      return job
    },
    recentRequests: instanceId => [...(requestLogs.get(instanceId) || [])],
    dispose() { stopped = true; for (const c of controllers) c.abort(); controllers.clear() },
  }
}
