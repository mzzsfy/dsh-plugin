import { fail } from './market-model.mjs'
export function createRegistry(providers = []) {
  const entries = new Map()
  for (const provider of providers) {
    const d = provider.descriptor
    if (!d || entries.has(d.adapterId) || typeof provider.probe !== 'function' || d.capabilities.some(c => !['quotes', 'catalog', 'search', 'calendar'].includes(c) || typeof provider[c] !== 'function') || (d.capabilities.includes('quotes') && !(d.maxQuoteBatch > 0))) fail('INVALID_ADAPTER', '数据适配器合同不完整', 422)
    entries.set(d.adapterId, provider)
  }
  const get = id => entries.get(id) || fail('UNKNOWN_ADAPTER', '未安装此数据适配器', 422)
  return {
    get,
    descriptors: () => [...entries.values()].map(p => p.descriptor),
    validate(instance, route) {
      const d = get(instance.adapterId).descriptor
      if (!d.capabilities.includes(route.capability) || !d.markets.includes(route.market) || !d.instruments.includes(route.instrument)) fail('UNSUPPORTED_CAPABILITY', '数据源不支持目标能力或市场', 422)
    },
  }
}
