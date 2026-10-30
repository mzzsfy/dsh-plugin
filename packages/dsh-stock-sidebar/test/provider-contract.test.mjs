import test from 'node:test'
import assert from 'node:assert/strict'
import { createRegistry } from '../src/provider-registry.mjs'
const adapter = (adapterId, capabilities) => ({ descriptor: { adapterId, capabilities, markets: ['XSHG', 'XSHE'], instruments: ['equity'], maxQuoteBatch: capabilities.includes('quotes') ? 20 : undefined, timestampSemantics: 'unknown' }, probe: async () => ({}), ...Object.fromEntries(capabilities.map(c => [c, async () => ({ items: [], errors: [] })])) })
export { adapter }
test('P03/P10 目录源不必实现quotes，能力不符的路由在保存前拒绝', () => {
  const registry = createRegistry([adapter('catalog-only', ['catalog']), adapter('quote-only', ['quotes'])])
  assert.doesNotThrow(() => registry.validate({ adapterId: 'catalog-only' }, { capability: 'catalog', market: 'XSHG', instrument: 'equity' }))
  assert.throws(() => registry.validate({ adapterId: 'catalog-only' }, { capability: 'quotes', market: 'XSHG', instrument: 'equity' }), e => e.code === 'UNSUPPORTED_CAPABILITY')
  assert.throws(() => createRegistry([{ descriptor: { ...adapter('broken', []).descriptor, capabilities: ['quotes'] }, probe() {} }]))
})
