import { z } from 'zod'
import { fail } from './market-model.mjs'
import { MARKET_META } from './market-model.mjs'
const id = z.string().regex(/^[a-z][a-z0-9-]{0,47}$/)
// 用户标在图上并参与盈亏计算的价格点位。kind 决定它在盈亏里扮演什么角色:
// cost 是持仓成本, target 是打算卖出的价
export const markSchema = z.strictObject({ id: z.string().min(1).max(40), price: z.number().positive(), kind: z.enum(['cost', 'target']) })
export const marksSchema = z.array(markSchema).max(12).default([]).superRefine((list, ctx) => {
  if (new Set(list.map(mark => mark.id)).size !== list.length) ctx.addIssue({ code: 'custom', message: '价格标记 id 重复' })
  if (new Set(list.map(mark => `${mark.kind}:${mark.price}`)).size !== list.length) ctx.addIssue({ code: 'custom', message: '同类型的价格不能重复' })
})
const rate = z.number().int().positive().max(100000)
// 每票可同时归属的分组上限: 标签是视图视角, 超过这个数量就该换一种组织方式
export const MAX_TAGS = 8
// 标签名即分组身份: 允许 1-12 字, 不允许首尾空白与控制字符(它们会让同名标签在界面上看起来一样)。
// C0/C1/DEL 之外还挡零宽与双向控制符: 它们不占宽度却能让两个不同的标签在 chips 与 tab 上完全同形
const TAG_CHARS_SOURCE = '\\u0000-\\u001f\\u007f-\\u009f\\u200b-\\u200f\\u202a-\\u202e'
const TAG_CHARS = new RegExp(`[${TAG_CHARS_SOURCE}]`), TAG_CHARS_ALL = new RegExp(`[${TAG_CHARS_SOURCE}]`, 'g')
// 旧版校验只挡 C0, 存量 group 里可能存在零宽/双向字符: 迁移必须先剥掉再判定, 否则一条旧记录会让插件整体不激活
export const stripTagChars = value => value.replace(TAG_CHARS_ALL, '')
export const tagName = z.string().refine(s => {
  const trimmed = s.trim()
  return trimmed !== '' && trimmed === s && [...trimmed].length <= 12 && !TAG_CHARS.test(trimmed)
}, '标签名需为 1-12 字, 不含首尾空白与控制字符')
export const capability = z.enum(['quotes', 'catalog', 'search', 'calendar', 'kline'])
export const marketSchema = z.enum(Object.keys(MARKET_META))
export const providerSchema = z.strictObject({
  id, adapterId: id, enabled: z.boolean(), credentialRef: z.string().regex(/^[A-Z][A-Z0-9_]{0,63}$/).nullable(), quotaGroup: id,
  budget: z.strictObject({ requestsPerMinute: rate.nullable(), dailyRequestLimit: rate.nullable(), billingUnit: z.enum(['request', 'symbol']), symbolCreditsPerMinute: rate.nullable(), capabilityLimits: z.partialRecord(capability, rate) }),
  endpoints: z.record(z.string().url()).optional(),
  // 上游出口代理(反代/正向代理统一走 URL): http(s)://[user:pass@]host:port, 凭据在 userinfo
  proxy: z.string().url().refine(v => v.startsWith('http://') || v.startsWith('https://'), '代理仅支持 http(s) URL').optional(),
}).refine(p => p.credentialRef !== null || p.budget.requestsPerMinute !== null, '免凭据来源必须声明保守预算')
export const routeSchema = z.strictObject({
  id, capability, market: marketSchema, instrument: z.literal('equity'), primaryInstanceId: id,
  fallbackInstanceIds: z.array(id).max(1), failoverMode: z.enum(['off', 'network']), maxDelaySeconds: z.number().nonnegative().nullable(), acceptUnknownDelay: z.boolean(),
})
// GET query 唯一入口: limit 为字符串形态需 coerce
export const klineQuerySchema = z.strictObject({
  securityId: z.string().regex(/^[\w]+:equity:[\w.]{1,15}$/),
  period: z.enum(['trend', '1d', '1w', '1M']),
  limit: z.coerce.number().int().min(20).max(1000).default(250),
  // 强制刷新:客户端详情页刷新走 ?force=1,服务端据此跳过缓存读;缺省按缓存
  force: z.enum(['0', '1']).optional(),
})
// 路由上限: 八市场×(quotes/catalog/search/calendar/kline) 全开 40 条封顶
const configSchema = z.strictObject({ providers: z.array(providerSchema).max(8), routes: z.array(routeSchema).max(40) })
// 悬浮盯盘刷新间隔独立于列表: 窗口只要快慢, 与列表的 15/30/60 不共享档位
export const FLOAT_REFRESH_SECONDS = [3, 5, 10, 15, 30]
export const DEFAULT_FLOAT_REFRESH_SECONDS = 10
export const preferencesSchema = z.strictObject({ refreshSeconds: z.union([z.literal(15), z.literal(30), z.literal(60)]), colorMode: z.enum(['red-up', 'green-up']), floatRefreshSeconds: z.union(FLOAT_REFRESH_SECONDS.map(n => z.literal(n))).default(DEFAULT_FLOAT_REFRESH_SECONDS) })
export const securitySchema = z.object({ id: z.string(), exchange: marketSchema, code: z.string(), officialName: z.string().min(1).max(100), instrument: z.literal('equity'), currency: z.string(), timezone: z.string(), priceScale: z.number().int(), listingStatus: z.string() }).superRefine((s, ctx) => {
  const meta = MARKET_META[s.exchange]
  if (!meta || !meta.codePattern.test(s.code) || s.id !== `${s.exchange}:equity:${s.code}`) { ctx.addIssue({ code: 'custom', message: '证券身份不一致' }); return }
  if (s.currency !== meta.currency || s.timezone !== meta.timezone || s.priceScale !== meta.priceScale) ctx.addIssue({ code: 'custom', message: '证券市场元数据与该市场不符' })
})
export function parseConfiguration(value) {
  const result = configSchema.safeParse(value)
  if (!result.success) fail('INVALID_CONFIGURATION', '数据源配置字段或格式无效', 422)
  const config = result.data, seen = new Set(), providerIds = new Set()
  for (const p of config.providers) {
    if (providerIds.has(p.id)) fail('DUPLICATE_PROVIDER', '数据源实例名称重复', 422)
    providerIds.add(p.id)
    if (p.budget.billingUnit === 'symbol' && p.budget.symbolCreditsPerMinute === null) fail('INVALID_BUDGET', '按证券计费必须提供证券额度', 422)
    const same = config.providers.filter(other => other.adapterId === p.adapterId && other.credentialRef === p.credentialRef)
    if (same.some(other => other.quotaGroup !== p.quotaGroup)) fail('INVALID_BUDGET', '同账号引用必须共享额度组', 422)
  }
  const routeIds = new Set()
  for (const r of config.routes) {
    const key = `${r.capability}:${r.market}:${r.instrument}`
    if (seen.has(key) || routeIds.has(r.id)) fail('DUPLICATE_ROUTE', '数据能力路由重复', 422)
    seen.add(key); routeIds.add(r.id)
    const targets = [r.primaryInstanceId, ...r.fallbackInstanceIds]
    if (new Set(targets).size !== targets.length || targets.some(target => !config.providers.some(p => p.id === target && p.enabled))) fail('INVALID_ROUTE', '路由引用了不存在或禁用的数据源', 422)
    if (!['quotes', 'kline'].includes(r.capability) && (r.failoverMode !== 'off' || r.fallbackInstanceIds.length)) fail('INVALID_ROUTE', '只有报价与K线支持备用源', 422)
    if (r.failoverMode !== 'off' && !r.fallbackInstanceIds.length) fail('INVALID_ROUTE', '自动切换需要备用报价源', 422)
  }
  return config
}
export const controlSchema = z.object({ revision: z.number().int().nonnegative(), routingRevision: z.number().int().nonnegative(), watchlist: z.object({ order: z.array(z.string()).max(100), items: z.record(z.string(), securitySchema.safeExtend({ alias: z.string(), pinned: z.boolean(), marks: marksSchema, tags: z.array(tagName).max(MAX_TAGS).refine(list => new Set(list).size === list.length, '标签不能重复').default([]) })) }), preferences: preferencesSchema, providers: z.array(providerSchema), routes: z.array(routeSchema), operations: z.array(z.object({ id: z.uuid(), hash: z.string(), at: z.number(), result: z.object({ revision: z.number() }).passthrough(), action: z.string(), payload: z.unknown() })).max(256) }).superRefine((control, ctx) => {
  const w = control.watchlist
  if (new Set(w.order).size !== w.order.length || w.order.length !== Object.keys(w.items).length || w.order.some(id => w.items[id]?.id !== id)) ctx.addIssue({ code: 'custom', message: '自选序列与证券不一致' })
  let unpinned = false
  for (const id of w.order) { if (!w.items[id]?.pinned) unpinned = true; else if (unpinned) ctx.addIssue({ code: 'custom', message: '置顶序列混乱' }) }
  try { parseConfiguration({ providers: control.providers, routes: control.routes }) } catch { ctx.addIssue({ code: 'custom', message: '来源配置不一致' }) }
})
// 存量记录归一: 数据源实例的凭据字段曾叫 credentialEnv(本来也只存引用名), 更名 credentialRef 后
// 旧记录要能在数据域打开时通过校验并就地改成新字段 —— 这次校验发生在 storageDomain.open,
// 早于插件应用层的任何迁移代码, 迁移写在这一层之外等于永远跑不到。
// 新旧字段并存时以新字段为准; 非对象条目原样交给 schema 去拒绝, 不在这里抛
const normalizeProvider = provider => {
  if (!provider || typeof provider !== 'object' || !('credentialEnv' in provider)) return provider
  const { credentialEnv, ...rest } = provider
  return { ...rest, credentialRef: 'credentialRef' in rest ? rest.credentialRef : credentialEnv ?? null }
}
const normalizeCredentialField = root => {
  if (!root || typeof root !== 'object' || !Array.isArray(root.providers)) return root
  if (!root.providers.some(p => p && typeof p === 'object' && 'credentialEnv' in p)) return root
  return { ...root, providers: root.providers.map(normalizeProvider) }
}
// 分组从单值 group 改为多标签 tags。与凭据改名同理, 归一必须在数据域 schema 上做,
// 否则存量记录通不过 storageDomain.open 的校验, 插件整体起不来。非字符串 group 也搬进 tags,
// 交给 tagName 校验报错, 不静默丢弃。
// 空分组说明用户没手工组织过: 按市场回填默认标签, 否则升级后所有存量票都落进未分组。
// 旧写路径会 trim, 但手工或外部写入可能带空白; 不 trim 会让一条旧记录直接锁死整个插件。
// tags 已存在时无论形态都原样保留: 让 schema 报错, 而不是用 group 静默覆盖用户标签。
const normalizeWatchlistTags = root => {
  const items = root?.watchlist?.items
  if (!items || typeof items !== 'object' || Array.isArray(items)) return root
  if (!Object.values(items).some(item => item && typeof item === 'object' && 'group' in item)) return root
  const next = Object.fromEntries(Object.entries(items).map(([id, item]) => {
    if (!item || typeof item !== 'object' || !('group' in item)) return [id, item]
    const { group, ...rest } = item
    if ('tags' in rest) return [id, rest]
    const marketTag = MARKET_META[rest.exchange]?.tag
    if (typeof group !== 'string') return [id, { ...rest, tags: [group] }]
    const text = stripTagChars(group).trim()
    return [id, { ...rest, tags: text ? [text] : marketTag ? [marketTag] : [] }]
  }))
  return { ...root, watchlist: { ...root.watchlist, items: next } }
}
const normalizeStoredControl = root => normalizeWatchlistTags(normalizeCredentialField(root))
export const storedControlSchema = z.preprocess(normalizeStoredControl, controlSchema)
// 存储只有一条记录: 自选与路由。K 线/目录/日历都是可重建的派生数据, 只放内存 ——
// 把它们塞进同一个文件曾把文件撑到 3.3 MB, 每次改自选都要整体重写, 写坏一次全没。
// 旧文件同名同版本, 打开时只取声明过的 control 表, 缓存表被忽略, 下次写入自然缩到十几 KB。
export const domainSpec = { name: 'stock_assistant', version: 1, layout: 'single', tables: { control: { valueSchema: storedControlSchema } } }
// 推荐配置:四个免凭据源,东财做八市场主力,其余按实测最强能力分派备份——公开源无SLA,能覆盖的市场都串上备源。
export const defaultConfig = () => {
  const budget = (requestsPerMinute, capabilityLimits = {}) => ({ requestsPerMinute, dailyRequestLimit: null, billingUnit: 'request', symbolCreditsPerMinute: null, capabilityLimits })
  const providers = [
    { id: 'em-default', adapterId: 'eastmoney', enabled: true, credentialRef: null, quotaGroup: 'free-quote', budget: budget(60, { kline: 30 }) },
    { id: 'sn-backup', adapterId: 'sina', enabled: true, credentialRef: null, quotaGroup: 'free-list', budget: budget(120, { catalog: 60 }) },
    { id: 'tx-backup', adapterId: 'tencent', enabled: true, credentialRef: null, quotaGroup: 'free-backup', budget: budget(60, { kline: 20 }) },
    { id: 'xq-backup', adapterId: 'xueqiu', enabled: true, credentialRef: null, quotaGroup: 'free-xq', budget: budget(60) },
  ]
  // 备用源只在探针可验证的组合上声明: 腾讯美股K线需先由搜索建立代码映射, 探针期必然不可用
  const klineBackup = new Set(['XSHG', 'XSHE', 'XHKG'])
  // 目录覆盖八市场: 东财 clist 的 fs 对日韩英同样有节点(日股 3752 / 韩股 2866 / 英股股票 4608), 全量翻页在 50 页上限内
  const catalogCovered = new Set(['XSHG', 'XSHE', 'XHKG', 'XNAS', 'XNYS', 'XJPX', 'XKRX', 'XLON'])
  // 报价备源按市场派: 沪深港走新浪(免cookie、单位已是股), 美股走雪球(时间戳是UTC毫秒, 与东财同口径)
  const quoteBackupOf = market => (market === 'XNAS' || market === 'XNYS' ? 'xq-backup' : ['XSHG', 'XSHE', 'XHKG'].includes(market) ? 'sn-backup' : null)
  const route = (market, capability, primary, fallback = null) => ({ id: `${market.toLowerCase()}-${capability}`, capability, market, instrument: 'equity', primaryInstanceId: primary, fallbackInstanceIds: fallback ? [fallback] : [], failoverMode: fallback ? 'network' : 'off', maxDelaySeconds: null, acceptUnknownDelay: true })
  const routes = ['XSHG', 'XSHE', 'XHKG', 'XNAS', 'XNYS', 'XJPX', 'XKRX', 'XLON'].flatMap(market => [
    // 目录统一走东财: 一个源覆盖八个市场, 不必为沪深单开新浪分支;目录不支持备用源
    ...(catalogCovered.has(market) ? [route(market, 'catalog', 'em-default')] : []),
    route(market, 'search', 'em-default'),
    route(market, 'quotes', 'em-default', quoteBackupOf(market)),
    route(market, 'kline', 'em-default', klineBackup.has(market) ? 'tx-backup' : null),
  ])
  return { providers, routes }
}
export const initialControl = () => ({ revision: 0, routingRevision: 0, watchlist: { order: [], items: {} }, preferences: { refreshSeconds: 15, colorMode: 'red-up', floatRefreshSeconds: DEFAULT_FLOAT_REFRESH_SECONDS }, ...defaultConfig(), operations: [] })
