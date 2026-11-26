// 已知债务的量化基线: 控制记录读取成本、目录本地搜索成本。
// 台账按 schema 上限 256 条; 目录按沪深单市场 15000 只。
// 若放入台账的配置副本, 打开时会按现行 schema 丢弃并回写, 基线会多测一次归一化, 与生产不符。
import { randomUUID } from 'node:crypto'
import { openState } from '../../../packages/dsh-stock-assistant/src/state.mjs'
import { createCatalog } from '../../../packages/dsh-stock-assistant/src/catalog.mjs'
import { initialControl } from '../../../packages/dsh-stock-assistant/src/schemas.mjs'
import { makeSecurity } from '../../../packages/dsh-stock-assistant/src/market-model.mjs'

const NOW = Date.UTC(2026, 10, 26, 2, 0)
const OPERATIONS = 256
const CATALOG_SIZE = 15000

// 一次配置保存的完整副本: 8 条路由 + 4 个实例, 与默认配置同量级
const configPayload = () => ({
  providers: Array.from({ length: 4 }, (_, index) => ({
    id: `p${index}`, adapterId: 'eastmoney', enabled: true, credentialRef: null, quotaGroup: `g${index}`,
    budget: { requestsPerMinute: 60, dailyRequestLimit: null, billingUnit: 'request', symbolCreditsPerMinute: null, capabilityLimits: {} },
  })),
  routes: Array.from({ length: 8 }, (_, index) => ({
    id: `r${index}`, capability: 'quotes', market: 'XSHG', instrument: 'equity', primaryInstanceId: 'p0',
    fallbackInstanceIds: [], failoverMode: 'off', maxDelaySeconds: null, acceptUnknownDelay: true,
  })),
})

// 只实现 state.mjs 用到的那几个方法; 不落盘, 避免基准依赖文件系统
const memoryDomain = control => {
  let root = control
  return {
    // 直接推进版本: 用于测"写入之后第一次读"的冷路径, 不走完整写入管线
    bump() { root = { ...root, revision: root.revision + 1 } },
    async open() {
      return {
        table: () => ({ get: () => root, async put(_key, value) { root = value }, async update(_key, transform) { root = transform(root); return root } }),
        async close() {},
      }
    },
  }
}

const controlWithLedger = () => {
  const control = initialControl()
  control.operations = Array.from({ length: OPERATIONS }, (_, index) => ({
    id: randomUUID(), hash: `hash-${index}`, at: NOW, result: { revision: index }, action: 'configuration',
  }))
  return control
}

const catalogOf = size => {
  const items = Array.from({ length: size }, (_, index) => makeSecurity('XSHG', `6${String(100000 + index).slice(0, 5)}`, `样本证券${index}`, { cnspell: `ybzq${index}` }))
  const control = initialControl()
  const cache = new Map([['catalog:em:XSHG', { kind: 'catalog', source: 'em', fetchedAt: NOW, payload: { routingRevision: control.routingRevision, market: 'XSHG', complete: true, items } }]])
  // 目录索引按缓存版本失效: 缓存实现必须给版本号, 裸 Map 会让索引永远不失效
  cache.version = 1
  const state = { cache }
  return createCatalog({ state, getControl: () => control, router: { select: () => ({ instance: { id: 'em' }, route: {} }) }, executor: { run: async () => ({ items: [], complete: true }) }, now: () => NOW })
}

export const cases = [
  {
    name: 'stock/state-get-256ops',
    description: `控制记录稳态读: 台账 ${OPERATIONS} 条(无载荷, 命中记忆化)`,
    scale: `${OPERATIONS} 条台账`,
    setup: async () => { const domain = memoryDomain(controlWithLedger()); return { state: await openState(domain, () => {}, () => NOW), bump: domain.bump } },
    run: ({ state }) => state.get().operations.length,
  },
  {
    name: 'stock/state-get-cold',
    description: `写入后首次读取: 每次读前推进一代(一次深拷贝 + 冻结), 台账 ${OPERATIONS} 条`,
    scale: `${OPERATIONS} 条台账`,
    setup: async () => { const domain = memoryDomain(controlWithLedger()); return { state: await openState(domain, () => {}, () => NOW), bump: domain.bump } },
    run: ({ state, bump }) => { bump(); return state.get().operations.length },
  },
  {
    name: 'stock/catalog-search-15000',
    description: `目录本地搜索: ${CATALOG_SIZE} 只证券, 代码前缀命中`,
    scale: `${CATALOG_SIZE} 只`,
    setup: () => catalogOf(CATALOG_SIZE),
    run: catalog => catalog.search('6100').length,
  },
]