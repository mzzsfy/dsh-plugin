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
// 一条路由最多挂几个备用源: 再多就不是主备而是轮询列表
export const MAX_FALLBACKS = 3
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
// 分时与 K 线是两种上游: 分时(trends2)只有部分来源支持, 日/周/月走另一套端点。
// 合成一个能力会让"K 线来源选腾讯"静默把分时打死, 所以拆成独立能力各自路由。
export const CAPABILITIES = ['quotes', 'catalog', 'search', 'calendar', 'kline', 'trend']
export const capability = z.enum(CAPABILITIES)
export const marketSchema = z.enum(Object.keys(MARKET_META))
const credentialRef = z.string().regex(/^[A-Z][A-Z0-9_]{0,63}$/)
// 代理 URL 与反代端点都只允许主机路径; 账号密码必须走宿主凭据, 否则会随配置进快照与持久化
const noUserinfo = value => {
  const url = new URL(value)
  return !url.username && !url.password
}
const httpUrl = z.string().url().refine(v => v.startsWith('http://') || v.startsWith('https://'), '仅支持 http(s) URL')
const proxyUrl = httpUrl.refine(noUserinfo, '代理 URL 不能包含账号密码，请写入代理凭据')
const endpointUrl = httpUrl.refine(noUserinfo, '端点 URL 不能包含账号密码，请改用代理凭据')
export const providerSchema = z.strictObject({
  id, adapterId: id, enabled: z.boolean(), credentialRef: credentialRef.nullable(), proxyCredentialRef: credentialRef.nullable().optional(), quotaGroup: id,
  budget: z.strictObject({ requestsPerMinute: rate.nullable(), dailyRequestLimit: rate.nullable(), billingUnit: z.enum(['request', 'symbol']), symbolCreditsPerMinute: rate.nullable(), capabilityLimits: z.partialRecord(capability, rate) }),
  endpoints: z.record(z.string(), endpointUrl).optional(),
  // 上游出口代理(反代/正向代理统一走 URL): http(s)://host:port; 账号密码由 proxyCredentialRef 指向宿主凭据
  proxy: proxyUrl.optional(),
}).refine(p => p.credentialRef !== null || p.budget.requestsPerMinute !== null, '免凭据来源必须声明保守预算')
export const routeSchema = z.strictObject({
  id, capability, market: marketSchema, instrument: z.literal('equity'), primaryInstanceId: id,
  fallbackInstanceIds: z.array(id).max(MAX_FALLBACKS), failoverMode: z.enum(['off', 'network']), maxDelaySeconds: z.number().nonnegative().nullable(), acceptUnknownDelay: z.boolean(),
}).superRefine((route, ctx) => {
  // 环里出现重复成员或主源自己: 三轮失败后"换源"其实没换, 只会白换代次丢掉在飞数据
  const ring = [route.primaryInstanceId, ...route.fallbackInstanceIds]
  if (new Set(ring).size !== ring.length) ctx.addIssue({ code: 'custom', path: ['fallbackInstanceIds'], message: '备用源不能重复，也不能与主源相同' })
})
// GET query 唯一入口: limit 为字符串形态需 coerce
export const klineQuerySchema = z.strictObject({
  securityId: z.string().regex(/^[\w]+:equity:[\w.]{1,15}$/),
  period: z.enum(['trend', '1d', '1w', '1M']),
  limit: z.coerce.number().int().min(20).max(1000).default(250),
  // 强制刷新:客户端详情页刷新走 ?force=1,服务端据此跳过缓存读;缺省按缓存
  force: z.enum(['0', '1']).optional(),
})
// 手动刷新的证券参数: 自选 id 字符串或客户端持有的完整身份(浏览/搜索 peek)。形状在这里定死,
// 应用层不再手写类型判断 —— 旧实现遇到 null 元素直接 TypeError 变成 500, 坏市场枚举也照发上游。
const refreshSecuritySchema = z.union([
  z.string().max(64).refine(value => {
    const parts = value.split(':')
    return parts.length === 3 && parts[1] === 'equity' && MARKET_META[parts[0]] !== undefined && /^[\w.]{1,15}$/.test(parts[2])
  }, '证券标识无效'),
  z.object({ id: z.string().min(1).max(64), exchange: marketSchema, code: z.string().min(1).max(20), officialName: z.string().min(1).max(100).optional() })
    .superRefine((value, ctx) => { if (value.id !== `${value.exchange}:equity:${value.code}`) ctx.addIssue({ code: 'custom', message: '证券身份不一致' }) }),
])
export const refreshSecuritiesSchema = z.array(refreshSecuritySchema).max(100)
// 路由上限: 八市场 × 全部能力, 全开也要装得下
const MAX_ROUTES = Object.keys(MARKET_META).length * CAPABILITIES.length
const configSchema = z.strictObject({ providers: z.array(providerSchema).max(8), routes: z.array(routeSchema).max(MAX_ROUTES) })
// 悬浮盯盘刷新间隔独立于列表: 窗口只要快慢, 与列表的 15/30/60 不共享档位
export const FLOAT_REFRESH_SECONDS = [3, 5, 10, 15, 30]
export const DEFAULT_FLOAT_REFRESH_SECONDS = 10
export const preferencesSchema = z.strictObject({ refreshSeconds: z.union([z.literal(15), z.literal(30), z.literal(60)]), colorMode: z.enum(['red-up', 'green-up']), floatRefreshSeconds: z.union(FLOAT_REFRESH_SECONDS.map(n => z.literal(n))).default(DEFAULT_FLOAT_REFRESH_SECONDS) })
// 上游请求的兜底节拍: 取列表与浮窗两处设置里更快的那个, 再留 10% 余量。
// 留余量是因为定时器唤醒有抖动: 按整周期卡会在下一拍判定时差几毫秒, 反而把拍子推成两倍。
export const TICK_SAFETY_RATIO = 0.9
export const tickPeriodMs = preferences => TICK_SAFETY_RATIO * 1000 * Math.min(preferences.refreshSeconds, preferences.floatRefreshSeconds)
export const securitySchema = z.object({ id: z.string(), exchange: marketSchema, code: z.string(), officialName: z.string().min(1).max(100), instrument: z.literal('equity'), currency: z.string(), timezone: z.string(), priceScale: z.number().int(), listingStatus: z.string() }).superRefine((s, ctx) => {
  const meta = MARKET_META[s.exchange]
  if (!meta || !meta.codePattern.test(s.code) || s.id !== `${s.exchange}:equity:${s.code}`) { ctx.addIssue({ code: 'custom', message: '证券身份不一致' }); return }
  if (s.currency !== meta.currency || s.timezone !== meta.timezone || s.priceScale !== meta.priceScale) ctx.addIssue({ code: 'custom', message: '证券市场元数据与该市场不符' })
})
export function parseConfiguration(value) {
  const result = configSchema.safeParse(value)
  if (!result.success) {
    // 把 zod 的首个问题路径带进 message: 设置页只能显示 message, 只说"字段或格式无效"用户无处下手
    const [first] = result.error.issues, path = first.path.length ? first.path.join('.') : '根'
    fail('INVALID_CONFIGURATION', `数据源配置字段或格式无效：${path} ${first.message}`, 422, { details: result.error.issues.map(issue => ({ path: issue.path.join('.'), message: issue.message, code: issue.code })) })
  }
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
    if (!['quotes', 'kline', 'trend'].includes(r.capability) && (r.failoverMode !== 'off' || r.fallbackInstanceIds.length)) fail('INVALID_ROUTE', '只有报价与K线类能力支持备用源', 422)
    if (r.failoverMode !== 'off' && !r.fallbackInstanceIds.length) fail('INVALID_ROUTE', '自动切换需要备用报价源', 422)
  }
  return config
}
// 分时路由的迁移版本: 存量库只补一次(补缺失路由 + 给单源分时登记备源), 用户随后删掉分时路由不该在下次启动被复活
export const TREND_ROUTE_MIGRATION = 2
export const controlSchema = z.object({ revision: z.number().int().nonnegative(), routingRevision: z.number().int().nonnegative(), routeMigration: z.number().int().nonnegative().default(0), watchlist: z.object({ order: z.array(z.string()).max(100), items: z.record(z.string(), securitySchema.safeExtend({ alias: z.string(), pinned: z.boolean(), marks: marksSchema, tags: z.array(tagName).max(MAX_TAGS).refine(list => new Set(list).size === list.length, '标签不能重复').default([]) })) }), preferences: preferencesSchema, providers: z.array(providerSchema), routes: z.array(routeSchema), operations: z.array(z.object({ id: z.uuid(), hash: z.string(), at: z.number(), result: z.object({ revision: z.number() }).passthrough(), action: z.string(), payload: z.unknown() })).max(256) }).superRefine((control, ctx) => {
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
// 无变化时返回原引用: 上层据此判断"这次读入是否改写了记录", 只有真改了才回写文件。
const stripUserinfo = value => {
  if (typeof value !== 'string') return value
  try {
    const url = new URL(value)
    if (!url.username && !url.password) return value
    url.username = ''; url.password = ''
    return url.toString()
  } catch { return value }
}
const normalizeEndpointMap = endpoints => {
  if (!endpoints || typeof endpoints !== 'object' || Array.isArray(endpoints)) return endpoints
  let changed = false
  const next = Object.fromEntries(Object.entries(endpoints).map(([key, value]) => {
    const stripped = stripUserinfo(value)
    if (stripped !== value) changed = true
    return [key, stripped]
  }))
  return changed ? next : endpoints
}
const normalizeProvider = provider => {
  if (!provider || typeof provider !== 'object') return provider
  let next = provider, changed = false
  if ('credentialEnv' in next) {
    const { credentialEnv, ...rest } = next
    next = { ...rest, credentialRef: 'credentialRef' in rest ? rest.credentialRef : credentialEnv ?? null }
    changed = true
  }
  // 旧记录可能把账号密码写在代理 URL 与反代端点的 userinfo 里: 读入即剥离, 防止快照继续回显;
  // 值无法安全迁移(宿主凭据写入是异步的), 用户需按 README 重新录入代理凭据。
  const proxy = stripUserinfo(next.proxy)
  if (proxy !== next.proxy) { next = { ...next, proxy }; changed = true }
  const endpoints = normalizeEndpointMap(next.endpoints)
  if (endpoints !== next.endpoints) { next = { ...next, endpoints }; changed = true }
  return changed ? next : provider
}
const normalizeCredentialField = root => {
  if (!root || typeof root !== 'object' || !Array.isArray(root.providers)) return root
  if (!root.providers.some(p => p && typeof p === 'object' && ('credentialEnv' in p || typeof p.proxy === 'string' || p.endpoints))) return root
  let changed = false
  const providers = root.providers.map(p => { const next = normalizeProvider(p); if (next !== p) changed = true; return next })
  return changed ? { ...root, providers } : root
}
// 幂等操作台账里的 configuration 载荷是用户当时的完整配置副本: 它和 providers 一样会带代理/端点 URL,
// 只清洗顶层 providers 会让明文继续留在文件里(快照不返回 operations, 但持久化仍是明文)。
const normalizeOperations = root => {
  if (!Array.isArray(root?.operations)) return root
  let changed = false
  const operations = root.operations.map(operation => {
    const payload = operation && typeof operation === 'object' ? operation.payload : null
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return operation
    let next = payload
    if (Array.isArray(payload.providers)) {
      let providersChanged = false
      const providers = payload.providers.map(p => { const candidate = normalizeProvider(p); if (candidate !== p) providersChanged = true; return candidate })
      if (providersChanged) next = { ...next, providers }
    }
    const endpoints = normalizeEndpointMap(next.endpoints)
    if (endpoints !== next.endpoints) next = { ...next, endpoints }
    if (next === payload) return operation
    changed = true
    return { ...operation, payload: next }
  })
  return changed ? { ...root, operations } : root
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
// 打开数据域时 schema 会就地归一旧记录; 归一发生在校验层, 应用层拿到的已是新值, 无法再判断
// "文件里是不是还有旧字段/明文"。这里记一个成功归一计数: openState 在打开前后取差, 差值非零即回写,
// 用户不必先做一次无关写操作才把明文从磁盘清掉。
let normalizationCount = 0
export const storedNormalizationCount = () => normalizationCount
const normalizeStoredControl = root => {
  const next = normalizeOperations(normalizeWatchlistTags(normalizeCredentialField(root)))
  if (next !== root) normalizationCount++
  return next
}
export const storedControlSchema = z.preprocess(normalizeStoredControl, controlSchema)
// 存储只有一条记录: 自选与路由。K 线/目录/日历都是可重建的派生数据, 只放内存 ——
// 把它们塞进同一个文件曾把文件撑到 3.3 MB, 每次改自选都要整体重写, 写坏一次全没。
// 旧文件同名同版本, 打开时只取声明过的 control 表, 缓存表被忽略, 下次写入自然缩到十几 KB。
export const domainSpec = { name: 'stock_assistant', version: 1, layout: 'single', tables: { control: { valueSchema: storedControlSchema } } }
// 推荐配置:四个免凭据源,东财做八市场主力,其余按实测最强能力分派备份——公开源无SLA,能覆盖的市场都串上备源。
export const defaultConfig = () => {
  const budget = (requestsPerMinute, capabilityLimits = {}) => ({ requestsPerMinute, dailyRequestLimit: null, billingUnit: 'request', symbolCreditsPerMinute: null, capabilityLimits })
  const providers = [
    // 分时子额度按浮窗最快档(3 秒一拍)留量: 20 拍/分还要叠加详情页分时, 顶格会把自己限流
    { id: 'em-default', adapterId: 'eastmoney', enabled: true, credentialRef: null, quotaGroup: 'free-quote', budget: budget(60, { kline: 30, trend: 30 }) },
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
    // 分时只有东财供得出, 不给备源: 备源不支持分时比没有备源更糟, 会把请求打给一个恒拒绝的源
    route(market, 'trend', 'em-default'),
  ])
  return { providers, routes }
}
export const initialControl = () => ({ revision: 0, routingRevision: 0, routeMigration: TREND_ROUTE_MIGRATION, watchlist: { order: [], items: {} }, preferences: { refreshSeconds: 15, colorMode: 'red-up', floatRefreshSeconds: DEFAULT_FLOAT_REFRESH_SECONDS }, ...defaultConfig(), operations: [] })
