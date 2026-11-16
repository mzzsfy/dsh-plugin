// 降级后回头试上级: 后台定时跑, 不占用户请求时间, 也不用业务请求去猜上游好坏。
// 每个适配器自己实现探针(probe), 这里只负责按路由顺序点名、把汇报交给路由器。
export const RECOVERY_RETRY_MS = 20 * 1000
export function createRecovery({ getConfig, router, executor }) {
  return async function probeRecovery() {
    // 用户请求在跑时整轮跳过: 探测排在别人的超时后面会把详情页请求推到 10 秒线上
    if (!executor.idle()) return
    for (const route of getConfig().routes) {
      if (route.failoverMode !== 'network') continue
      const epoch = router.selections()[route.id]?.routeEpoch
      if (epoch === undefined) continue
      for (const id of router.recoveryCandidates(route.id)) {
        const instance = getConfig().providers.find(p => p.id === id && p.enabled !== false && p.budget?.requestsPerMinute !== null)
        if (!instance) continue
        let ready = false
        try {
          const result = await executor.run(instance, route.capability, { market: route.market, instrument: route.instrument }, { probe: true })
          // 探针必须由同名能力产出: 适配器拿别的能力冒充时不能当就绪
          ready = result?.status === 'ready' && result.capability === route.capability
        } catch {}
        try { router.recordProbe(route.id, id, ready, epoch) } catch { break }
        if (ready) break
      }
    }
  }
}

// 探测节奏跟着面板走: 有人看才探, 没人看就停; 每次重新活跃先立刻探一次, 不用干等一个周期。
// 上一轮没跑完就跳过这一轮: 探测要逐个实例打上游, 一轮可能比周期还长。
// 用户请求在跑时短重试, 不占首屏的队列
export function createRecoveryLoop({ probe, timers, interval, canRun = () => true }) {
  let timer = null, retry = null, running = false, busy = false, stopped = false, inflight = Promise.resolve()
  const run = () => {
    if (stopped || busy) return
    if (!canRun()) {
      if (retry) return
      retry = timers.setTimeout?.(() => { retry = null; run() }, RECOVERY_RETRY_MS) ?? null
      retry?.unref?.()
      return
    }
    busy = true
    inflight = Promise.resolve().then(probe).catch(() => {}).finally(() => { busy = false })
  }
  const stop = () => {
    stopped = true
    if (timer) timers.clearInterval?.(timer)
    if (retry) timers.clearTimeout?.(retry)
    timer = null; retry = null; running = false
  }
  return {
    sync(active) {
      if (active === running) return
      if (!active) return stop()
      stopped = false
      run()
      timer = timers.setInterval?.(run, interval) ?? null
      timer?.unref?.()
      running = true
    },
    // 在飞的那一轮, 关闭时等它收尾
    idle: () => inflight,
    stop,
  }
}
