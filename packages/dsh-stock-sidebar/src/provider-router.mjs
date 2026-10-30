import { fail } from './market-model.mjs'
export function createRouter(getConfig, now = Date.now, changed = () => {}) {
  const states = new Map()
  function state(route) {
    if (!states.has(route.id)) states.set(route.id, { providerInstanceId: route.primaryInstanceId, routeEpoch: 0, failures: 0, switchedAt: null })
    return states.get(route.id)
  }
  function find(id) { return getConfig().routes.find(r => r.id === id) || fail('NO_ROUTE', '未配置此数据路由', 422) }
  return {
    select(capability, market, instrument = 'equity') {
      const config = getConfig(), route = config.routes.find(r => r.capability === capability && r.market === market && r.instrument === instrument)
      if (!route) fail('NO_ROUTE', '未配置该市场的数据来源', 422)
      const selected = state(route), instance = config.providers.find(p => p.id === selected.providerInstanceId)
      if (!instance || instance.enabled === false) fail('NO_ROUTE', '数据源已停用', 422)
      return { route, instance, routeEpoch: selected.routeEpoch }
    },
    recordRound(id, error) {
      const route = find(id), s = state(route)
      s.failures = error && ['NETWORK', 'TIMEOUT'].includes(error.code) ? s.failures + 1 : 0
      if (s.failures >= 3 && route.failoverMode === 'network' && s.providerInstanceId === route.primaryInstanceId && route.fallbackInstanceIds.length) {
        s.providerInstanceId = route.fallbackInstanceIds[0]; s.routeEpoch++; s.switchedAt = now(); s.failures = 0; changed(id)
      }
    },
    switchPrimary(id, expectedEpoch) {
      const route = find(id), s = state(route)
      if (s.routeEpoch !== expectedEpoch) fail('ROUTE_CONFLICT', '路由已变化，请重新检查', 409)
      if (s.switchedAt !== null && now() - s.switchedAt < 10 * 60 * 1000) fail('ROUTE_DWELL', '备用源驻留期尚未结束', 409)
      s.providerInstanceId = route.primaryInstanceId; s.routeEpoch++; s.failures = 0; s.switchedAt = null; changed(id)
    },
    selections: () => Object.fromEntries(getConfig().routes.map(r => [r.id, { ...state(r) }])),
    reset() { states.clear() },
  }
}
