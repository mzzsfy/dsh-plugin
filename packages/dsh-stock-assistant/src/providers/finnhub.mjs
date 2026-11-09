// Finnhub 免费公开接口: 美股实时报价。没有批量端点, 每次一只;官方明确不建议持续轮询, 额度按分钟计。
import { MARKET_META, normalizeQuote, StockError } from '../market-model.mjs'
const DEFAULT_ENDPOINTS = { quotes: 'https://finnhub.io/api/v1/quote' }
const endpointOf = (ctx, key) => ctx.endpoints?.[key] || DEFAULT_ENDPOINTS[key]
// 免费档只开放 /quote: K线与盘口都标 Premium Access Required, 所以本适配器只声明报价能力。
const PROBE_SECURITY = 'AAPL'
// 无效代码由来源返回全 0 字段而非 404, 现价 0 即视为无此证券
const EMPTY_PRICE = 0
const MINUTE_MS = 60 * 1000
async function getJson(ctx, url) {
  let response
  try {
    response = await ctx.fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: ctx.signal, redirect: 'error' })
  } catch (e) {
    if (ctx.signal.aborted) throw new StockError('CANCELLED', '请求已取消', 503)
    if (e instanceof StockError) throw e
    throw new StockError('NETWORK', '无法连接行情来源', 502, { retryable: true })
  }
  if (response.status === 401 || response.status === 403) throw new StockError('AUTH', '来源拒绝了该凭据', 401)
  if (response.status === 429) throw new StockError('RATE_LIMIT', '来源限流', 429, { retryAfterMs: MINUTE_MS })
  if (!response.ok) throw new StockError('NETWORK', '来源服务暂不可用', 502, { retryable: true })
  return response.json().catch(() => { throw new StockError('BAD_PAYLOAD', '来源响应不是JSON', 502) })
}
export const finnhub = {
  descriptor: { adapterId: 'finnhub', capabilities: ['quotes'], markets: ['XNAS', 'XNYS'], instruments: ['equity'], maxQuoteBatch: 1, credential: 'DSH_STOCK_FINNHUB_TOKEN', description: 'Finnhub：需配置凭据，美股实时报价，免费档不含K线，单只一请求', endpointKeys: [{ key: 'quotes', label: '实时报价' }] },
  async probe(request, ctx) {
    const security = { id: `${request.market}:equity:${PROBE_SECURITY}`, exchange: request.market, code: PROBE_SECURITY }
    const result = await this.quotes({ ...request, securities: [security] }, ctx)
    if (!result.items.length) throw new StockError('NO_DATA', '来源未返回可校验数据，暂不能确认能力就绪', 422)
    return { status: 'ready', capability: 'quotes', market: request.market, instrument: 'equity' }
  },
  async quotes(request, ctx) {
    const token = ctx.credential(), items = [], errors = []
    for (const security of request.securities) {
      const body = await getJson(ctx, `${endpointOf(ctx, 'quotes')}?symbol=${encodeURIComponent(security.code)}&token=${encodeURIComponent(token)}`)
      if (!Number.isFinite(body?.c) || body.c === EMPTY_PRICE) {
        errors.push({ securityId: security.id, code: 'NO_DATA', message: '来源未返回此证券报价' })
        continue
      }
      // t 是最后一笔成交的 Unix 秒。延迟交给 collector 按时差派生: 盘后拉取时差本来就大,
      // 适配器硬声明实时等于替来源撒谎。
      items.push(normalizeQuote({
        securityId: security.id, providerInstanceId: request.providerInstanceId, adapterId: 'finnhub', providerSymbol: security.code,
        last: body.c, previousClose: body.pc ?? null, open: body.o ?? null, high: body.h ?? null, low: body.l ?? null,
        volume: null, volumeUnit: 'share', amount: null, amountUnit: MARKET_META[security.exchange]?.currency || 'USD',
        quoteAt: Number.isFinite(body.t) && body.t > 0 ? new Date(body.t * 1000).toISOString() : null,
        timestampKind: 'trade',
        receivedAt: ctx.now(), delayKind: 'unknown', delaySeconds: null, securityState: 'unknown',
      }))
    }
    return { providerInstanceId: request.providerInstanceId, fetchedAt: ctx.now(), items, errors }
  },
}
