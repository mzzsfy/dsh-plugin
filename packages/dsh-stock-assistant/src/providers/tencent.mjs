// 腾讯公开行情接口适配器:quotes+kline(备源)。非官方端点,无SLA,随时可能失效;延迟未知,行情时间戳为来源快照时间。
import { normalizeQuote, parseQuoteTime, StockError, MARKET_META, sharesFromLots, amountFromWan } from '../market-model.mjs'
// 官方默认端点表(key 供 instance.endpoints 覆盖, 反代/镜像场景由 ctx.endpoints 提供同名 key)
const DEFAULT_ENDPOINTS = {
  quotes: 'https://qt.gtimg.cn/q=',
  kline: 'https://web.ifzq.gtimg.cn/appstock/app/fqkline/get',
}
const endpointOf = (ctx, key) => ctx.endpoints?.[key] || DEFAULT_ENDPOINTS[key]
// quotes 与 kline 共用一张前缀表,防双源漂移(design.md 数据结构节)。
const SYMBOL_PREFIX = { XSHG: 'sh', XSHE: 'sz', XHKG: 'hk' }
// 美股 symbol 后缀由搜索联想 JYS 字段映射(2026-10-30 实测: suggest 返回 JYS="NASDAQ"/"NYSE"/"AMEX";
// 腾讯侧 .OQ/.N/裸代码同价有效, .A/.U 形态返回空数据——AMEX 走裸代码兜底)。
const JYS_TO_SUFFIX = { NASDAQ: 'OQ', NYSE: 'N', AMEX: '' }
// 美股行情端点要 us 前缀(实测 usAAPL 有效, 裸 AAPL 返回空);K线另有 JYS 后缀逻辑, 不复用这张表。
const isUSExchange = exchange => exchange === 'XNAS' || exchange === 'XNYS'
const symbolOf = security => isUSExchange(security.exchange) ? `us${security.code}` : SYMBOL_PREFIX[security.exchange] ? `${SYMBOL_PREFIX[security.exchange]}${security.code}` : `${security.code}`
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
// 行情时间戳三种写法: 沪深紧凑数字, 港股斜杠, 美股带连字符
const quoteStamp = raw => {
  const compact = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})$/.exec(raw || '')
  if (compact) return `${compact[1]}-${compact[2]}-${compact[3]} ${compact[4]}:${compact[5]}:${compact[6]}`
  const loose = /^(\d{4})[-/](\d{2})[-/](\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?/.exec(raw || '')
  return loose ? `${loose[1]}-${loose[2]}-${loose[3]} ${loose[4]}:${loose[5]}:${loose[6] || '00'}` : null
}

export const tencent = {
  descriptor: { adapterId: 'tencent', capabilities: ['quotes', 'kline'], markets: ['XSHG', 'XSHE', 'XHKG', 'XNAS', 'XNYS'], instruments: ['equity'], maxQuoteBatch: 60, credential: 'none', description: '腾讯公开接口：免凭据，行情与K线备源，非官方无SLA', endpointKeys: [{ key: 'quotes', label: '行情批量' }, { key: 'kline', label: 'K线历史' }] },
  async probe(request, ctx) {
    // kline 探针直接拉代表证券 3 根日K(quotes 不覆盖港股);quotes 探针沿用代表证券行。
    if (request.capability === 'kline') {
      const code = { XSHG: '600519', XSHE: '000001', XHKG: '00700' }[request.market]
      if (!code) throw new StockError('UNSUPPORTED_CAPABILITY', '腾讯来源不提供该市场K线', 422)
      const result = await this.kline({ ...request, securityId: `${request.market}:equity:${code}`, code, period: '1d', adjust: 'qfq', limit: 3 }, ctx)
      if (!result.candles.length) throw new StockError('NO_DATA', '来源未返回可校验数据，暂不能确认能力就绪', 422)
      return { status: 'ready', capability: 'kline', market: request.market, instrument: 'equity' }
    }
    const PROBE = { XSHG: '600519', XSHE: '000001', XHKG: '00700', XNAS: 'AAPL', XNYS: 'BABA' }
    const security = request.securities?.[0] || { exchange: request.market, code: PROBE[request.market] || '000001' }
    const rows = await this.quotes({ ...request, securities: [security] }, ctx)
    if (!rows.items.length) throw new StockError('NO_DATA', '来源未返回可校验数据，暂不能确认能力就绪', 422)
    return { status: 'ready', capability: 'quotes', market: request.market, instrument: 'equity' }
  },
  async quotes(request, ctx) {
    const symbols = new Map(request.securities.map(s => [symbolOf(s), s]))
    let response
    try {
      response = await ctx.fetch(endpointOf(ctx, 'quotes') + [...symbols.keys()].join(','), { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: ctx.signal, redirect: 'error' })
    } catch (e) {
      if (ctx.signal.aborted) throw new StockError('CANCELLED', '请求已取消', 503)
      if (e instanceof StockError) throw e
      throw new StockError('NETWORK', '无法连接行情来源', 502, { retryable: true })
    }
    if (!response.ok) throw new StockError('NETWORK', '来源服务暂不可用', 502, { retryable: true })
    const text = new TextDecoder('gbk').decode(await response.arrayBuffer())
    const seen = new Set(), items = []
    for (const line of text.split(';')) {
      const match = /v_((?:sh|sz|hk)\d{5,6}|us[A-Za-z.]+)="([^"]*)"/.exec(line)
      if (!match) continue
      const providerSymbol = match[1], security = symbols.get(providerSymbol)
      if (!security) continue
      if (seen.has(providerSymbol)) throw new StockError('BAD_PAYLOAD', '报价身份冲突', 502)
      seen.add(providerSymbol)
      const f = match[2].split('~')
      if (f.length < 38) throw new StockError('BAD_PAYLOAD', '来源字段数量异常', 502)
      const volume = num(f[36]), amount = num(f[37])
      items.push(normalizeQuote({
        securityId: security.id, providerInstanceId: request.providerInstanceId, adapterId: 'tencent', providerSymbol,
        last: f[3], previousClose: f[4], open: f[5], high: f[33], low: f[34],
        volume: volume === null ? null : String(sharesFromLots(volume, security.exchange)), volumeUnit: 'share',
        amount: amount === null ? null : String(amountFromWan(amount, security.exchange)), amountUnit: MARKET_META[security.exchange]?.currency || 'CNY',
        quoteAt: parseQuoteTime(quoteStamp(f[30])), timestampKind: 'trade',
        receivedAt: ctx.now(), delayKind: 'unknown', delaySeconds: null, securityState: 'unknown',
      }))
    }
    return { providerInstanceId: request.providerInstanceId, fetchedAt: ctx.now(), items, errors: request.securities.filter(s => !seen.has(symbolOf(s))).map(s => ({ securityId: s.id, code: 'NO_DATA', message: '来源未返回此证券报价' })) }
  },
  async kline(request, ctx) {
    if (request.period === 'trend') throw new StockError('UNSUPPORTED_CAPABILITY', '腾讯来源不提供分时数据', 422)
    let symbol = klineSymbolOf(request)
    if (request.market === 'XNAS' || request.market === 'XNYS') {
      const mapped = ctx.usSymbols?.get(`US:${request.code}`)
      const suffix = mapped ? JYS_TO_SUFFIX[mapped.jys] : undefined
      if (suffix === undefined) throw new StockError('UNSUPPORTED_CAPABILITY', '腾讯来源的美股K线需先经搜索建立代码映射', 422)
      symbol = suffix ? `us${request.code}.${suffix}` : `us${request.code}`
    }
    const param = `${symbol},${{ '1d': 'day', '1w': 'week', '1M': 'month' }[request.period]},,,${request.limit},qfq`
    let response
    try {
      response = await ctx.fetch(`${endpointOf(ctx, 'kline')}?param=${param}`, { headers: { Referer: 'https://gu.qq.com/', 'User-Agent': 'Mozilla/5.0' }, signal: ctx.signal, redirect: 'error' })
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
      candles.push({ time: String(row[0]), open: num(row[1]), close: num(row[2]), high: num(row[3]), low: num(row[4]), volume: sharesFromLots(num(row[5]), request.market) })
    }
    // preClose 实测定案: data.{symbol}.qt.{symbol}[4] 为昨收(2026-10-30 实测 sz000001 值 11.54 与东财 f18 一致)。
    const qt = Array.isArray(data?.qt?.[symbol]) ? data.qt[symbol] : null
    const preClose = qt ? num(qt[4]) : null
    return { providerInstanceId: request.providerInstanceId, fetchedAt: ctx.now(), complete: true, preClose, candles }
  },
}
