import { fail } from './market-model.mjs'
import { CAPABILITIES } from './schemas.mjs'
const KNOWN = new Set(CAPABILITIES)
// 合同: 每个声明的能力都要有同名方法, 且 probe 返回 {status, capability, market, instrument};
// capability 必须回填被探的能力名, 否则设置页会判不可用(不能拿行情接口冒充分时)
export function createRegistry(providers = []) {
  const entries = new Map()
  for (const provider of providers) {
    const d = provider.descriptor
    if (!d || entries.has(d.adapterId) || typeof provider.probe !== 'function' || d.capabilities.some(c => !KNOWN.has(c) || typeof provider[c] !== 'function') || (d.capabilities.includes('quotes') && !(d.maxQuoteBatch > 0))) fail('INVALID_ADAPTER', '数据适配器合同不完整', 422)
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
