// 雪球公开行情接口适配器:quotes(沪深港美)。
// 与新浪/东财的差别:同一请求可混装多市场,且额外给出换手率/振幅/市值/总股本。
// 接口需要 xq_a_token cookie,匿名访问首页即可拿到,本适配器惰性获取并按 TTL 缓存。
import { normalizeQuote, numberOrNull, parseQuoteTime, StockError } from '../market-model.mjs'
const ENDPOINT = 'https://stock.xueqiu.com/v5/stock/batch/quote.json'
const HOME = 'https://xueqiu.com/'
const HEADERS = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36' }
// cookie 有效期远长于一次会话, 缓存到进程内并按 TTL 刷新, 避免每个请求都先访问首页
const TOKEN_TTL = 30 * 60 * 1000
let token = { value: null, until: 0 }
// 沪深用大写市场前缀, 港股与美股直接用代码本身(实测 HK00700 返回空, 00700 才有数据)
const symbolOf = security => (security.exchange === 'XSHG' ? 'SH' : security.exchange === 'XSHE' ? 'SZ' : '') + security.code
const PROBE_SECURITY = { XSHG: '600519', XSHE: '000001', XHKG: '00700', XNAS: 'AAPL', XNYS: 'BABA' }
// 缺失(undefined/null/'')一律当缺失: Number(null) 是 0, 只比有限性会把「来源没给」显示成 0 价/0 量
const quote = value => { const n = numberOrNull(value); return n === null ? null : n.toFixed(2) }

export const xueqiu = {
  descriptor: { adapterId: 'xueqiu', capabilities: ['quotes'], markets: ['XSHG', 'XSHE', 'XHKG', 'XNAS', 'XNYS'], instruments: ['equity'], maxQuoteBatch: 60, credential: 'none', description: '雪球公开接口：免凭据（匿名 token），沪深港美行情，可混装多市场，额外提供换手率与市值' },
  async probe(request, ctx) {
    const security = request.securities?.[0] || { exchange: request.market, code: PROBE_SECURITY[request.market] }
    if (!security.code) throw new StockError('UNSUPPORTED_CAPABILITY', '雪球来源不提供该市场行情', 422)
    const rows = await this.quotes({ ...request, securities: [security] }, ctx)
    if (!rows.items.length) throw new StockError('NO_DATA', '来源未返回可校验数据，暂不能确认能力就绪', 422)
    return { status: 'ready', capability: 'quotes', market: request.market, instrument: 'equity' }
  },
  async quotes(request, ctx) {
    const symbols = new Map(request.securities.map(s => [symbolOf(s), s]))
    let response
    try {
      response = await ctx.fetch(`${ENDPOINT}?symbol=${[...symbols.keys()].join(',')}`, { headers: { ...HEADERS, Cookie: await cookieOf(ctx), Referer: HOME }, signal: ctx.signal, redirect: 'error' })
      // token 过期时来源返回 400/刷新一次重试, 让缓存失真自愈
      if (response.status === 400) {
        token = { value: null, until: 0 }
        response = await ctx.fetch(`${ENDPOINT}?symbol=${[...symbols.keys()].join(',')}`, { headers: { ...HEADERS, Cookie: await cookieOf(ctx) }, signal: ctx.signal, redirect: 'error' })
      }
    } catch (e) {
      if (ctx.signal.aborted) throw new StockError('CANCELLED', '请求已取消', 503)
      if (e instanceof StockError) throw e
      throw new StockError('NETWORK', '无法连接行情来源', 502, { retryable: true })
    }
    if (!response.ok) throw new StockError('NETWORK', '来源服务暂不可用', 502, { retryable: true })
    const body = await response.json().catch(() => { throw new StockError('BAD_PAYLOAD', '来源响应不是JSON', 502) })
    const items = body?.data?.items
    if (!Array.isArray(items)) throw new StockError('BAD_PAYLOAD', '来源字段结构异常', 502)
    const seen = new Set(), result = []
    for (const entry of items) {
      const row = entry?.quote
      if (!row) continue
      const security = symbols.get(String(row.symbol || ''))
      if (!security) continue
      if (seen.has(security.id)) throw new StockError('BAD_PAYLOAD', '报价身份冲突', 502)
      seen.add(security.id)
      // 雪球 volume 统一是股, amount 统一是元; 时间戳是毫秒 Unix
      const volume = numberOrNull(row.volume), amount = numberOrNull(row.amount), marketCapital = numberOrNull(row.market_capital), stamp = numberOrNull(row.timestamp)
      result.push(normalizeQuote({
        securityId: security.id, providerInstanceId: request.providerInstanceId, adapterId: 'xueqiu', providerSymbol: row.symbol,
        last: quote(row.current), previousClose: quote(row.last_close), open: quote(row.open), high: quote(row.high), low: quote(row.low),
        volume: volume === null ? null : String(Math.round(volume)), volumeUnit: 'share',
        amount: amount === null ? null : String(Math.round(amount)), amountUnit: String(row.currency || ''),
        quoteAt: stamp === null ? null : new Date(stamp).toISOString(), timestampKind: 'trade',
        receivedAt: ctx.now(), delayKind: 'unknown', delaySeconds: null, securityState: 'unknown',
        turnoverRate: numberOrNull(row.turnover_rate),
        marketCapital: marketCapital === null ? null : Math.round(marketCapital),
      }))
    }
    return { providerInstanceId: request.providerInstanceId, fetchedAt: ctx.now(), items: result, errors: request.securities.filter(s => !seen.has(s.id)).map(s => ({ securityId: s.id, code: 'NO_DATA', message: '来源未返回此证券报价' })) }
  },
}

async function cookieOf(ctx) {
  if (token.value && token.until > ctx.now()) return token.value
  let response
  try { response = await ctx.fetch(HOME, { headers: HEADERS, signal: ctx.signal, redirect: 'follow' }) } catch (e) {
    if (ctx.signal.aborted) throw new StockError('CANCELLED', '请求已取消', 503)
    if (e instanceof StockError) throw e
    throw new StockError('NETWORK', '无法连接行情来源', 502, { retryable: true })
  }
  const raw = typeof response.headers.getSetCookie === 'function' ? response.headers.getSetCookie() : []
  const value = raw.map(c => c.split(';')[0]).filter(c => c.includes('=')).join('; ')
  if (!value) throw new StockError('BAD_PAYLOAD', '来源未返回访问令牌', 502)
  token = { value, until: ctx.now() + TOKEN_TTL }
  return value
}
