import { initialControl } from '../src/schemas.mjs'
export function memoryStorage() {
  // meta 预置成已初始化: 存量记录(control 有 root)的正常情形
  const maps = { control: new Map([['root', initialControl()]]), meta: new Map([['state', { schemaVersion: 1 }]]), cache: new Map() }
  let closed = false, writes = 0, broken = false
  return {
    maps, get closed() { return closed }, get writes() { return writes }, set broken(value) { broken = value },
    async open() { return { table: name => { const table = maps[name] ??= new Map(); return ({ get: key => table.get(key), entries: () => table.entries(), async put(key, value) { if (broken) throw Error('disk'); table.set(key, structuredClone(value)); writes++ }, async delete(key) { if (broken) throw Error('disk'); const had = table.delete(key); if (had) writes++; return had }, async update(key, fn) { const next = fn(table.get(key)); if (broken) throw Error('disk'); table.set(key, structuredClone(next)); writes++; return next } }) }, async close() { closed = true } } },
  }
}
export const provider = (id = 'ts-one', adapterId = 'tushare') => ({ id, adapterId, enabled: true, credentialRef: 'DSH_STOCK_TUSHARE_TOKEN', quotaGroup: 'account-one', budget: { requestsPerMinute: 50, dailyRequestLimit: null, billingUnit: 'request', symbolCreditsPerMinute: null, capabilityLimits: { quotes: 50, catalog: 10, calendar: 10 } } })
export const route = (primaryInstanceId = 'ts-one', market = 'XSHG', capability = 'quotes') => ({ id: `${market.toLowerCase()}-${capability}`, capability, market, instrument: 'equity', primaryInstanceId, fallbackInstanceIds: [], failoverMode: 'off', maxDelaySeconds: null, acceptUnknownDelay: true })
export const operation = (n = 1, expectedRevision = 0) => ({ operationId: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`, expectedRevision, action: 'test', payload: { n } })
