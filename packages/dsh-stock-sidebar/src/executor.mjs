import { StockError, fail } from './market-model.mjs'
export function createExecutor({ registry, budget, env = process.env, fetch: fetchImpl = globalThis.fetch, now = Date.now, timers = globalThis }) {
  const queues = new Map(), controllers = new Set(), starts = new Map()
  let stopped = false, running = 0
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
        try {
          const gap = Math.max(0, (starts.get(instance.quotaGroup) ?? -Infinity) + (instance.budget?.requestsPerMinute === null ? 10 * 1000 : 1000) - now())
          if (gap) await new Promise((resolve, reject) => {
            const abortWait = () => { timers.clearTimeout(wait); reject(new StockError('CANCELLED', '请求已取消', 503)) }
            const wait = timers.setTimeout(() => { controller.signal.removeEventListener('abort', abortWait); resolve() }, gap)
            controller.signal.addEventListener('abort', abortWait, { once: true })
          })
          await acquire(controller.signal); acquired = true
          starts.set(instance.quotaGroup, now())
          timeout = timers.setTimeout(() => controller.abort(new StockError('TIMEOUT', '来源请求超时', 504, { retryable: true })), 8 * 1000)
          const adapter = registry.get(instance.adapterId), method = options.probe ? 'probe' : capability
          if (typeof adapter[method] !== 'function') fail('UNSUPPORTED_CAPABILITY', '来源不支持该能力', 422)
          let used = false
          const ctx = { now, signal: controller.signal, credential: () => instance.credentialEnv === null ? undefined : env[instance.credentialEnv] || fail('AUTH', '未在Host环境中配置凭据', 422),
            fetch: async (...args) => {
              if (used) {
                const gap = Math.max(0, starts.get(instance.quotaGroup) + (instance.budget?.requestsPerMinute === null ? 10 * 1000 : 1000) - now())
                if (gap) await new Promise((resolve, reject) => {
                  const cancel = () => { timers.clearTimeout(id); reject(new StockError('CANCELLED', '请求已取消', 503)) }
                  const id = timers.setTimeout(() => { controller.signal.removeEventListener('abort', cancel); resolve() }, gap)
                  controller.signal.addEventListener('abort', cancel, { once: true }); if (controller.signal.aborted) cancel()
                })
              }
              if (controller.signal.aborted) fail('CANCELLED', '请求已取消', 503)
              budget.reserve(instance, capability, request.securities?.length || 1, !!options.periodic, !!options.probe); used = true; starts.set(instance.quotaGroup, now()); return fetchImpl(...args)
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
          return result
        } catch (e) {
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
    dispose() { stopped = true; for (const c of controllers) c.abort(); controllers.clear() },
  }
}
