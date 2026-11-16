import { fail } from './market-model.mjs'
// 回探节奏: 面板活跃时每隔这么久把所有已降级路由的上级探一遍
export const RECOVERY_PROBE_MS = 5 * 60 * 1000
// 探测退避上限: 一个实例连续探不通时, 间隔按倍数涨到这么久就不再涨
export const PROBE_BACKOFF_MAX_MS = 60 * 60 * 1000
// 触发降级的错误码: 别的错误码说明问题不在网络上, 换源也没用
export const TRANSIENT_CODES = ['NETWORK', 'TIMEOUT']
export function createRouter(getConfig, now = Date.now, changed = () => {}) {
  const states = new Map()
  // 主源与备用源构成一个环: 顺序即优先级, 降级沿环往下走一格, 走到头回到主源
  const ringOf = route => [route.primaryInstanceId, ...route.fallbackInstanceIds]
  function state(route) {
    if (!states.has(route.id)) states.set(route.id, { providerInstanceId: route.primaryInstanceId, routeEpoch: 0, failures: 0, ringIndex: 0, probes: new Map() })
    return states.get(route.id)
  }
  function probeOf(s, instanceId) {
    if (!s.probes.has(instanceId)) s.probes.set(instanceId, { failures: 0, until: 0 })
    return s.probes.get(instanceId)
  }
  // 业务里刚失败的实例先歇一个周期再探: 降级不代表探不通, 不推进指数档位
  function rest(s, instanceId) {
    const probe = probeOf(s, instanceId)
    probe.until = Math.max(probe.until, now() + RECOVERY_PROBE_MS)
  }
  // 探不通才推进档位: 坏源不该被每轮点名
  function failProbe(s, instanceId) {
    const probe = probeOf(s, instanceId)
    probe.failures += 1
    probe.until = now() + Math.min(RECOVERY_PROBE_MS * 2 ** (probe.failures - 1), PROBE_BACKOFF_MAX_MS)
  }
  function clearProbe(s, instanceId) {
    const probe = probeOf(s, instanceId)
    probe.failures = 0; probe.until = 0
  }
  function find(id) { return getConfig().routes.find(r => r.id === id) || fail('NO_ROUTE', '未配置此数据路由', 422) }
  return {
    select(capability, market, instrument = 'equity') {
      const config = getConfig(), route = config.routes.find(r => r.capability === capability && r.market === market && r.instrument === instrument)
      if (!route) fail('NO_ROUTE', '未配置该市场的数据来源', 422)
      const selected = state(route), instance = config.providers.find(p => p.id === selected.providerInstanceId)
      if (!instance) fail('NO_ROUTE', '引用的数据源不存在', 422)
      if (instance.enabled === false) fail('NO_ROUTE', '数据源已停用', 422)
      return { route, instance, routeEpoch: selected.routeEpoch }
    },
    // 环上的下一格: 降级与同轮补救共用, 走到最后一个时回到主源
    nextInRing(id, instanceId) {
      const ring = ringOf(find(id))
      const index = ring.indexOf(instanceId)
      return ring.length < 2 || index === -1 ? null : ring[(index + 1) % ring.length]
    },
    // 可回探的上级: 从主源往下, 跳过还在歇着或退避中的实例
    recoveryCandidates(id) {
      const route = find(id), s = state(route), at = now()
      return s.ringIndex === 0 ? [] : ringOf(route).slice(0, s.ringIndex).filter(instanceId => probeOf(s, instanceId).until <= at)
    },
    // 探测汇报: 就绪就回切并清掉该实例的退避, 否则推进它的退避档位。
    // 探测期间路由可能又变过, 代次不符就当作过期汇报丢掉
    recordProbe(id, instanceId, ready, expectedEpoch) {
      const route = find(id), s = state(route)
      if (!ready) return failProbe(s, instanceId)
      const ring = ringOf(route), index = ring.indexOf(instanceId)
      if (index === -1 || index >= s.ringIndex || s.routeEpoch !== expectedEpoch) return
      // 探测只证明上游能出数, 不证明这个实例派得了活: 没填预算的实例切过去就是 BUDGET_UNKNOWN
      const instance = getConfig().providers.find(p => p.id === instanceId)
      if (!instance || instance.enabled === false || instance.budget?.requestsPerMinute === null) return
      clearProbe(s, instanceId)
      s.ringIndex = index; s.providerInstanceId = instanceId; s.routeEpoch++; s.failures = 0; changed(id)
    },
    recordRound(id, error) {
      const route = find(id), s = state(route), ring = ringOf(route)
      // 业务成功就是最好的证据: 当前实例的探测退避清零
      if (!error) { s.failures = 0; return clearProbe(s, s.providerInstanceId) }
      s.failures = TRANSIENT_CODES.includes(error.code) ? s.failures + 1 : 0
      if (s.failures < 3 || route.failoverMode !== 'network' || ring.length < 2) return
      // 沿环找下一个真正能用的成员: 停用或没填预算的实例派不了活, 落进去整条路由就死了
      const config = getConfig()
      let next = s.ringIndex
      for (let step = 1; step <= ring.length; step++) {
        const index = (s.ringIndex + step) % ring.length, instance = config.providers.find(p => p.id === ring[index])
        if (instance && instance.enabled !== false && instance.budget?.requestsPerMinute !== null) { next = index; break }
      }
      if (next === s.ringIndex) return
      s.failures = 0
      rest(s, ring[s.ringIndex])
      s.ringIndex = next; s.providerInstanceId = ring[next]; s.routeEpoch++; changed(id)
    },
    switchPrimary(id, expectedEpoch) {
      const route = find(id), s = state(route)
      if (s.routeEpoch !== expectedEpoch) fail('ROUTE_CONFLICT', '路由已变化，请重新检查', 409)
      clearProbe(s, route.primaryInstanceId)
      s.providerInstanceId = route.primaryInstanceId; s.routeEpoch++; s.failures = 0; s.ringIndex = 0; changed(id)
    },
    selections: () => Object.fromEntries(getConfig().routes.map(r => {
      const s = state(r)
      return [r.id, { providerInstanceId: s.providerInstanceId, routeEpoch: s.routeEpoch, failures: s.failures, ringIndex: s.ringIndex }]
    })),
    reset() { states.clear() },
  }
}
