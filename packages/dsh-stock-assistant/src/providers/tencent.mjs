// 腾讯公开行情接口适配器:仅quotes能力。非官方端点,无SLA,随时可能失效;延迟未知,时间戳为来源快照时间。
import { normalizeQuote, parseQuoteTime, StockError } from '../market-model.mjs'
const ENDPOINT = 'https://qt.gtimg.cn/q='
const symbolOf = security => `${security.exchange === 'XSHG' ? 'sh' : 'sz'}${security.code}`
export const tencent = {
  descriptor: { adapterId: 'tencent', capabilities: ['quotes'], markets: ['XSHG', 'XSHE'], instruments: ['equity'], maxQuoteBatch: 60, credential: 'none' },
  async probe(request, ctx) {
    const security = request.securities?.[0] || { exchange: request.market, code: request.market === 'XSHG' ? '600519' : '000001' }
    const rows = await this.quotes({ ...request, securities: [security] }, ctx)
    if (!rows.items.length) throw new StockError('NO_DATA', '来源未返回可校验数据，暂不能确认能力就绪', 422)
    return { status: 'ready', capability: 'quotes', market: request.market, instrument: 'equity' }
  },
  async quotes(request, ctx) {
    const symbols = new Map(request.securities.map(s => [symbolOf(s), s]))
    let response
    try {
      response = await ctx.fetch(ENDPOINT + [...symbols.keys()].join(','), { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: ctx.signal, redirect: 'error' })
    } catch (e) {
      if (ctx.signal.aborted) throw new StockError('CANCELLED', '请求已取消', 503)
      if (e instanceof StockError) throw e
      throw new StockError('NETWORK', '无法连接行情来源', 502, { retryable: true })
    }
    if (!response.ok) throw new StockError('NETWORK', '来源服务暂不可用', 502, { retryable: true })
    const text = new TextDecoder('gbk').decode(await response.arrayBuffer())
    const seen = new Set(), items = []
    for (const line of text.split(';')) {
      const match = /v_(sh|sz)(\d{6})="([^"]*)"/.exec(line)
      if (!match) continue
      const providerSymbol = `${match[1]}${match[2]}`, security = symbols.get(providerSymbol)
      if (!security) continue
      if (seen.has(providerSymbol)) throw new StockError('BAD_PAYLOAD', '报价身份冲突', 502)
      seen.add(providerSymbol)
      const f = match[3].split('~')
      if (f.length < 38) throw new StockError('BAD_PAYLOAD', '来源字段数量异常', 502)
      const [, y, m, d, hh, mm, ss] = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})$/.exec(f[30]) || []
      items.push(normalizeQuote({
        securityId: security.id, providerInstanceId: request.providerInstanceId, adapterId: 'tencent', providerSymbol,
        last: f[3], previousClose: f[4], open: f[5], high: f[33], low: f[34],
        volume: f[36] == null || Number.isNaN(Number(f[36])) ? null : String(Number(f[36]) * 100), volumeUnit: 'share',
        amount: f[37] == null || Number.isNaN(Number(f[37])) ? null : String(Math.round(Number(f[37]) * 10000)), amountUnit: 'CNY',
        quoteAt: y ? parseQuoteTime(`${y}-${m}-${d} ${hh}:${mm}:${ss}`) : null, timestampKind: 'trade',
        receivedAt: ctx.now(), delayKind: 'unknown', delaySeconds: null, securityState: 'unknown',
      }))
    }
    return { providerInstanceId: request.providerInstanceId, fetchedAt: ctx.now(), items, errors: request.securities.filter(s => !seen.has(symbolOf(s))).map(s => ({ securityId: s.id, code: 'NO_DATA', message: '来源未返回此证券报价' })) }
  },
}
