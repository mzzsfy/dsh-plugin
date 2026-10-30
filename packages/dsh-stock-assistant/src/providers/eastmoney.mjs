// 东财公开行情接口适配器:quotes/catalog/search。非官方端点,无SLA;延迟未知,f124为来源秒级时间戳。
import { normalizeQuote, makeSecurity, StockError } from '../market-model.mjs'
import { securityId } from '../market-model.mjs'
const QUOTES_ENDPOINT = 'https://push2.eastmoney.com/api/qt/ulist.np/get'
const LIST_ENDPOINT = 'https://push2.eastmoney.com/api/qt/clist/get'
const SEARCH_ENDPOINT = 'https://searchapi.eastmoney.com/api/suggest/get'
// 东财市场代码:XSHG=1,XSHE=0;列表接口按板块过滤:主板t:2/创业板t:13(深)/科创板t:23(沪)。
const MARKET = { XSHG: '1', XSHE: '0' }
const LIST_FS = { XSHG: 'm:1+t:2,m:1+t:23', XSHE: 'm:0+t:6,m:0+t:80' }
const SYMBOL_PREFIX = { 1: 'XSHG', 0: 'XSHE' }
const symbolOf = security => `${MARKET[security.exchange]}.${security.code}`
const num = value => value == null || typeof value === 'number' && !Number.isFinite(value) ? null : value === '-' ? null : String(value)
async function getJson(ctx, url) {
  let response
  try {
    response = await ctx.fetch(url, { headers: { Referer: 'https://quote.eastmoney.com/', 'User-Agent': 'Mozilla/5.0' }, signal: ctx.signal, redirect: 'error' })
  } catch (e) {
    if (ctx.signal.aborted) throw new StockError('CANCELLED', '请求已取消', 503)
    if (e instanceof StockError) throw e
    throw new StockError('NETWORK', '无法连接行情来源', 502, { retryable: true })
  }
  if (!response.ok) throw new StockError('NETWORK', '来源服务暂不可用', 502, { retryable: true })
  return response.json().catch(() => { throw new StockError('BAD_PAYLOAD', '来源响应不是JSON', 502) })
}
export const eastmoney = {
  descriptor: { adapterId: 'eastmoney', capabilities: ['quotes', 'catalog', 'search'], markets: ['XSHG', 'XSHE'], instruments: ['equity'], maxQuoteBatch: 60, credential: 'none' },
  async probe(request, ctx) {
    if (request.capability === 'catalog' || request.capability === 'search') {
      // 探针词按市场选代表证券,跨市场词会误判能力不可用。
      const result = await this[request.capability]({ ...request, q: request.market === 'XSHG' ? '茅台' : '平安', limit: 5 }, ctx)
      if (!result.items.length) throw new StockError('NO_DATA', '来源未返回可校验数据，暂不能确认能力就绪', 422)
      return { status: 'ready', capability: request.capability, market: request.market, instrument: 'equity' }
    }
    const security = request.securities?.[0] || { exchange: request.market, code: request.market === 'XSHG' ? '600519' : '000001' }
    const rows = await this.quotes({ ...request, securities: [security] }, ctx)
    if (!rows.items.length) throw new StockError('NO_DATA', '来源未返回可校验数据，暂不能确认能力就绪', 422)
    return { status: 'ready', capability: 'quotes', market: request.market, instrument: 'equity' }
  },
  async quotes(request, ctx) {
    const symbols = new Map(request.securities.map(s => [symbolOf(s), s]))
    const body = await getJson(ctx, `${QUOTES_ENDPOINT}?secids=${[...symbols.keys()].join(',')}&fields=f2,f3,f4,f5,f6,f12,f13,f14,f15,f16,f17,f18,f124&fltt=2&invt=2`)
    const rows = body?.data?.diff
    // data:null表示全部secids无效(如整批退市),降级为逐证券缺失,不让单批坏行瘫痪路由。
    if (!Array.isArray(rows)) return { providerInstanceId: request.providerInstanceId, fetchedAt: ctx.now(), items: [], errors: request.securities.map(s => ({ securityId: s.id, code: 'NO_DATA', message: '来源未返回此证券报价' })) }
    const seen = new Set(), items = []
    for (const row of rows) {
      const security = symbols.get(`${row.f13}.${row.f12}`)
      if (!security) continue
      if (seen.has(security.id)) throw new StockError('BAD_PAYLOAD', '报价身份冲突', 502)
      seen.add(security.id)
      // fltt=2时价格为已缩放数值, "-"表示停牌等无值;f124为来源Unix秒。
      const quoteAt = Number.isFinite(row.f124) ? new Date(row.f124 * 1000).toISOString() : null
      items.push(normalizeQuote({
        securityId: security.id, providerInstanceId: request.providerInstanceId, adapterId: 'eastmoney', providerSymbol: `${row.f13}.${row.f12}`,
        last: num(row.f2), previousClose: num(row.f18), open: num(row.f17), high: num(row.f15), low: num(row.f16),
        volume: num(row.f5), volumeUnit: 'share', amount: num(row.f6), amountUnit: 'CNY',
        quoteAt, timestampKind: 'trade',
        receivedAt: ctx.now(), delayKind: 'unknown', delaySeconds: null, securityState: 'unknown',
      }))
    }
    return { providerInstanceId: request.providerInstanceId, fetchedAt: ctx.now(), items, errors: request.securities.filter(s => !seen.has(s.id)).map(s => ({ securityId: s.id, code: 'NO_DATA', message: '来源未返回此证券报价' })) }
  },
  async catalog(request, ctx) {
    const items = [], seen = new Set()
    const PAGE_SIZE = 100, MAX_PAGES = 50
    let page = 1, complete = true
    while (page <= MAX_PAGES) {
      const url = `${LIST_ENDPOINT}?pn=${page}&pz=${PAGE_SIZE}&po=1&np=1&fltt=2&invt=2&fid=f12&fs=${LIST_FS[request.market]}&fields=f12,f13,f14`
      const body = await getJson(ctx, url)
      const diff = body?.data?.diff
      if (!Array.isArray(diff)) throw new StockError('BAD_PAYLOAD', '目录字段结构异常', 502)
      const total = Number(body.data.total)
      if (!Number.isFinite(total)) throw new StockError('BAD_PAYLOAD', '目录总数缺失', 502)
      for (const row of diff) {
        const exchange = SYMBOL_PREFIX[row.f13]
        if (exchange !== request.market || typeof row.f12 !== 'string' || !/^\d{6}$/.test(row.f12) || typeof row.f14 !== 'string' || !row.f14) continue
        const id = securityId(exchange, row.f12)
        if (seen.has(id)) throw new StockError('BAD_PAYLOAD', '目录身份冲突', 502)
        seen.add(id)
        items.push(makeSecurity(exchange, row.f12, row.f14, { cnspell: '', catalogSource: request.providerInstanceId }))
      }
      if (total > MAX_PAGES * PAGE_SIZE) complete = false
      if (page * PAGE_SIZE >= total || diff.length === 0) break
      page++
    }
    return { providerInstanceId: request.providerInstanceId, fetchedAt: ctx.now(), items, errors: [], complete }
  },
  async search(request, ctx) {
    const url = `${SEARCH_ENDPOINT}?input=${encodeURIComponent(request.q)}&type=14&token=D43BF722C8E33BDC906FB84D85E326E8&count=${Math.min(20, request.limit || 10)}`
    const body = await getJson(ctx, url)
    const rows = body?.QuotationCodeTable?.Data
    if (!Array.isArray(rows)) return { providerInstanceId: request.providerInstanceId, fetchedAt: ctx.now(), items: [], errors: [] }
    const items = []
    for (const row of rows) {
      if (row.Classify !== 'AStock' || !['1', '0'].includes(row.MktNum)) continue
      const exchange = SYMBOL_PREFIX[Number(row.MktNum)]
      if (exchange !== request.market || !/^\d{6}$/.test(row.Code)) continue
      items.push(makeSecurity(exchange, row.Code, row.Name, { cnspell: typeof row.PinYin === 'string' ? row.PinYin.toLowerCase() : '', catalogSource: request.providerInstanceId }))
    }
    return { providerInstanceId: request.providerInstanceId, fetchedAt: ctx.now(), items, errors: [] }
  },
}
