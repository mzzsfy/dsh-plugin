import { z } from 'zod'
import { fail } from './market-model.mjs'
const id = z.string().regex(/^[a-z][a-z0-9-]{0,47}$/)
const rate = z.number().int().positive().max(100000)
export const capability = z.enum(['quotes', 'catalog', 'search', 'calendar'])
export const providerSchema = z.strictObject({
  id, adapterId: id, enabled: z.boolean(), credentialEnv: z.string().regex(/^[A-Z][A-Z0-9_]{0,63}$/).nullable(), quotaGroup: id,
  budget: z.strictObject({ requestsPerMinute: rate.nullable(), dailyRequestLimit: rate.nullable(), billingUnit: z.enum(['request', 'symbol']), symbolCreditsPerMinute: rate.nullable(), capabilityLimits: z.partialRecord(capability, rate) }),
}).refine(p => p.credentialEnv !== null || p.budget.requestsPerMinute !== null, '免凭据来源必须声明保守预算')
export const routeSchema = z.strictObject({
  id, capability, market: z.enum(['XSHG', 'XSHE']), instrument: z.literal('equity'), primaryInstanceId: id,
  fallbackInstanceIds: z.array(id).max(1), failoverMode: z.enum(['off', 'network']), maxDelaySeconds: z.number().nonnegative().nullable(), acceptUnknownDelay: z.boolean(),
})
const configSchema = z.strictObject({ providers: z.array(providerSchema).max(8), routes: z.array(routeSchema).max(8) })
export const preferencesSchema = z.strictObject({ refreshSeconds: z.union([z.literal(15), z.literal(30), z.literal(60)]), colorMode: z.enum(['red-up', 'green-up']) })
export const securitySchema = z.object({ id: z.string().regex(/^(XSHG|XSHE):equity:\d{6}$/), exchange: z.enum(['XSHG', 'XSHE']), code: z.string().regex(/^\d{6}$/), officialName: z.string().min(1).max(100), instrument: z.literal('equity'), currency: z.literal('CNY'), timezone: z.literal('Asia/Shanghai'), priceScale: z.literal(2), listingStatus: z.string() }).refine(s => s.id === `${s.exchange}:equity:${s.code}`, '证券身份不一致')
export function parseConfiguration(value) {
  const result = configSchema.safeParse(value)
  if (!result.success) fail('INVALID_CONFIGURATION', '数据源配置字段或格式无效', 422)
  const config = result.data, seen = new Set(), providerIds = new Set()
  for (const p of config.providers) {
    if (providerIds.has(p.id)) fail('DUPLICATE_PROVIDER', '数据源实例名称重复', 422)
    providerIds.add(p.id)
    if (p.budget.billingUnit === 'symbol' && p.budget.symbolCreditsPerMinute === null) fail('INVALID_BUDGET', '按证券计费必须提供证券额度', 422)
    const same = config.providers.filter(other => other.adapterId === p.adapterId && other.credentialEnv === p.credentialEnv)
    if (same.some(other => other.quotaGroup !== p.quotaGroup)) fail('INVALID_BUDGET', '同账号引用必须共享额度组', 422)
  }
  const routeIds = new Set()
  for (const r of config.routes) {
    const key = `${r.capability}:${r.market}:${r.instrument}`
    if (seen.has(key) || routeIds.has(r.id)) fail('DUPLICATE_ROUTE', '数据能力路由重复', 422)
    seen.add(key); routeIds.add(r.id)
    const targets = [r.primaryInstanceId, ...r.fallbackInstanceIds]
    if (new Set(targets).size !== targets.length || targets.some(target => !config.providers.some(p => p.id === target && p.enabled))) fail('INVALID_ROUTE', '路由引用了不存在或禁用的数据源', 422)
    if (r.capability !== 'quotes' && (r.failoverMode !== 'off' || r.fallbackInstanceIds.length)) fail('INVALID_ROUTE', '只有报价支持备用源', 422)
    if (r.failoverMode !== 'off' && !r.fallbackInstanceIds.length) fail('INVALID_ROUTE', '自动切换需要备用报价源', 422)
  }
  return config
}
export const controlSchema = z.object({ revision: z.number().int().nonnegative(), routingRevision: z.number().int().nonnegative(), watchlist: z.object({ order: z.array(z.string()).max(100), items: z.record(z.string(), securitySchema.safeExtend({ alias: z.string(), pinned: z.boolean() })) }), preferences: preferencesSchema, providers: z.array(providerSchema), routes: z.array(routeSchema), operations: z.array(z.object({ id: z.uuid(), hash: z.string(), at: z.number(), result: z.object({ revision: z.number() }).passthrough(), action: z.string(), payload: z.unknown() })).max(256) }).superRefine((control, ctx) => {
  const w = control.watchlist
  if (new Set(w.order).size !== w.order.length || w.order.length !== Object.keys(w.items).length || w.order.some(id => w.items[id]?.id !== id)) ctx.addIssue({ code: 'custom', message: '自选序列与证券不一致' })
  let unpinned = false
  for (const id of w.order) { if (!w.items[id]?.pinned) unpinned = true; else if (unpinned) ctx.addIssue({ code: 'custom', message: '置顶序列混乱' }) }
  try { parseConfiguration({ providers: control.providers, routes: control.routes }) } catch { ctx.addIssue({ code: 'custom', message: '来源配置不一致' }) }
})
export const domainSpec = { name: 'stock_sidebar', version: 1, layout: 'single', tables: { control: { valueSchema: controlSchema }, cache: { valueSchema: z.object({ kind: z.string(), source: z.string(), fetchedAt: z.number(), payload: z.unknown() }) } } }
// 默认数据源:免凭据公开源+保守预算,首用即可检查保存;设置页一键恢复复用同一构造。
export const defaultConfig = () => {
  const instance = { id: 'em-default', adapterId: 'eastmoney', enabled: true, credentialEnv: null, quotaGroup: 'free-quote', budget: { requestsPerMinute: 60, dailyRequestLimit: null, billingUnit: 'request', symbolCreditsPerMinute: null, capabilityLimits: {} } }
  const routes = ['XSHG', 'XSHE'].flatMap(market => ['catalog', 'search', 'quotes'].map(capability => ({ id: `${market.toLowerCase()}-${capability}`, capability, market, instrument: 'equity', primaryInstanceId: instance.id, fallbackInstanceIds: [], failoverMode: 'off', maxDelaySeconds: null, acceptUnknownDelay: true })))
  return { providers: [instance], routes }
}
export const initialControl = () => ({ revision: 0, routingRevision: 0, watchlist: { order: [], items: {} }, preferences: { refreshSeconds: 15, colorMode: 'red-up' }, ...defaultConfig(), operations: [] })
