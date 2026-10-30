import { initialControl } from '../src/schemas.mjs'
export function memoryStorage() {
  const maps = { control: new Map([['root', initialControl()]]), cache: new Map() }
  let closed = false, writes = 0, broken = false
  return {
    maps, get closed() { return closed }, get writes() { return writes }, set broken(value) { broken = value },
    async open() { return { table: name => ({ get: key => maps[name].get(key), entries: () => maps[name].entries(), async put(key, value) { if (broken) throw Error('disk'); maps[name].set(key, structuredClone(value)); writes++ }, async update(key, fn) { const next = fn(maps[name].get(key)); if (broken) throw Error('disk'); maps[name].set(key, structuredClone(next)); writes++; return next } }), async close() { closed = true } } },
  }
}
export const provider = (id = 'ts-one', adapterId = 'tushare') => ({ id, adapterId, enabled: true, credentialEnv: 'DSH_STOCK_TUSHARE_TOKEN', quotaGroup: 'account-one', budget: { requestsPerMinute: 50, dailyRequestLimit: null, billingUnit: 'request', symbolCreditsPerMinute: null, capabilityLimits: { quotes: 50, catalog: 10, calendar: 10 } } })
export const route = (primaryInstanceId = 'ts-one', market = 'XSHG', capability = 'quotes') => ({ id: `${market.toLowerCase()}-${capability}`, capability, market, instrument: 'equity', primaryInstanceId, fallbackInstanceIds: [], failoverMode: 'off', maxDelaySeconds: null, acceptUnknownDelay: true })
export const operation = (n = 1, expectedRevision = 0) => ({ operationId: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`, expectedRevision, action: 'test', payload: { n } })
