// 腾讯公开行情接口适配器:quotes+kline(备源)。非官方端点,无SLA,随时可能失效;延迟未知,行情时间戳为来源快照时间。
import { normalizeQuote, parseQuoteTime, StockError } from '../market-model.mjs'
const ENDPOINT = 'https://qt.gtimg.cn/q='
const KLINE_ENDPOINT = 'https://web.ifzq.gtimg.cn/appstock/app/fqkline/get'
// quotes 与 kline 共用一张前缀表,防双源漂移(design.md 数据结构节)。
const SYMBOL_PREFIX = { XSHG: 'sh', XSHE: 'sz', XHKG: 'hk' }
// 美股 symbol 后缀由搜索联想 JYS 字段映射(2026-10-30 实测: suggest 返回 JYS="NASDAQ"/"NYSE"/"AMEX";
// 腾讯侧 .OQ/.N/裸代码同价有效, .A/.U 形态返回空数据——AMEX 走裸代码兜底)。
const JYS_TO_SUFFIX = { NASDAQ: 'OQ', NYSE: 'N', AMEX: '' }
const symbolOf = security => SYMBOL_PREFIX[security.exchange] ? `${SYMBOL_PREFIX[security.exchange]}${security.code}` : `${security.code}`
// kline request 用 market 字段(exchange 是 security 形态的字段名); 港股 code 统一 5 位对齐腾讯 hk00700 实测形态。
const klineSymbolOf = request => {
  const prefix = SYMBOL_PREFIX[request.market]
  if (!prefix) return request.code
  const code = request.market === 'XHKG' ? request.code.padStart(5, '0') : request.code
  return `${prefix}${code}`
}
// kline 数据键随复权/周期漂移(qfqday/day/qfqweek/qfqmonth),取第一个数组值兜底。
const firstArray = data => Object.values(data).find(Array.isArray)
const num = v => { const n = parseFloat(v); return Number.isFinite(n) ? n : null }

export const tencent = {
  descriptor: { adapterId: 'tencent', capabilities: ['quotes', 'kline'], markets: ['XSHG', 'XSHE', 'XHKG', 'XNAS', 'XNYS'], instruments: ['equity'], maxQuoteBatch: 60, credential: 'none' },
  async probe(request, ctx) {
    // kline 探针直接拉代表证券 3 根日K(quotes 不覆盖港股);quotes 探针沿用代表证券行。
    if (request.capability === 'kline') {
      const code = { XSHG: '600519', XSHE: '000001', XHKG: '00700' }[request.market]
      if (!code) throw new StockError('UNSUPPORTED_CAPABILITY', '腾讯备源不支持该市场K线', 422)
      const result = await this.kline({ ...request, securityId: `${request.market}:equity:${code}`, code, period: '1d', adjust: 'qfq', limit: 3 }, ctx)
      if (!result.candles.length) throw new StockError('NO_DATA', '来源未返回可校验数据，暂不能确认能力就绪', 422)
      return { status: 'ready', capability: 'kline', market: request.market, instrument: 'equity' }
    }
    const PROBE = { XSHG: '600519', XSHE: '000001' }
    const security = request.securities?.[0] || { exchange: request.market, code: PROBE[request.market] || '000001' }
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
  async kline(request, ctx) {
    if (request.period === 'trend') throw new StockError('UNSUPPORTED_CAPABILITY', '腾讯备源不支持分时', 422)
    let symbol = klineSymbolOf(request)
    if (request.market === 'XNAS' || request.market === 'XNYS') {
      const mapped = ctx.usSymbols?.get(`US:${request.code}`)
      const suffix = mapped ? JYS_TO_SUFFIX[mapped.jys] : undefined
      if (suffix === undefined) throw new StockError('UNSUPPORTED_CAPABILITY', '美股腾讯备源需先经搜索建立代码映射', 422)
      symbol = suffix ? `us${request.code}.${suffix}` : `us${request.code}`
    }
    const param = `${symbol},${{ '1d': 'day', '1w': 'week', '1M': 'month' }[request.period]},,,${request.limit},qfq`
    let response
    try {
      response = await ctx.fetch(`${KLINE_ENDPOINT}?param=${param}`, { headers: { Referer: 'https://gu.qq.com/', 'User-Agent': 'Mozilla/5.0' }, signal: ctx.signal, redirect: 'error' })
    } catch (e) {
      if (ctx.signal.aborted) throw new StockError('CANCELLED', '请求已取消', 503)
      if (e instanceof StockError) throw e
      throw new StockError('NETWORK', '无法连接行情来源', 502, { retryable: true })
    }
    if (!response.ok) throw new StockError('NETWORK', '来源服务暂不可用', 502, { retryable: true })
    const body = await response.json().catch(() => { throw new StockError('BAD_PAYLOAD', '来源响应不是JSON', 502) })
    const data = body?.data?.[symbol]
    const rows = data && firstArray(data)
    if (!Array.isArray(rows) || !rows.length) throw new StockError('NO_DATA', '来源未返回此证券K线', 422)
    const candles = []
    let prevTime = ''
    for (const row of rows) {
      if (!Array.isArray(row) || row.length < 6) throw new StockError('BAD_PAYLOAD', 'K线列数不足', 502)
      if (String(row[0]) <= prevTime) throw new StockError('BAD_PAYLOAD', 'K线时间戳重复或乱序', 502)
      prevTime = String(row[0])
      candles.push({ time: String(row[0]), open: num(row[1]), close: num(row[2]), high: num(row[3]), low: num(row[4]), volume: num(row[5]) })
    }
    // preClose 实测定案: data.{symbol}.qt.{symbol}[4] 为昨收(2026-10-30 实测 sz000001 值 11.54 与东财 f18 一致)。
    const qt = Array.isArray(data?.qt?.[symbol]) ? data.qt[symbol] : null
    const preClose = qt ? num(qt[4]) : null
    return { providerInstanceId: request.providerInstanceId, fetchedAt: ctx.now(), complete: true, preClose, candles }
  },
}
