// 东财公开行情接口适配器:quotes/catalog/search/kline。非官方端点,无SLA;延迟未知,f124为来源秒级时间戳。
import { normalizeQuote, makeSecurity, StockError } from '../market-model.mjs'
import { securityId } from '../market-model.mjs'
const QUOTES_ENDPOINT = 'https://push2.eastmoney.com/api/qt/ulist.np/get'
const LIST_ENDPOINT = 'https://push2.eastmoney.com/api/qt/clist/get'
const SEARCH_ENDPOINT = 'https://searchapi.eastmoney.com/api/suggest/get'
const KLINE_ENDPOINT = 'https://push2his.eastmoney.com/api/qt/stock/kline/get'
const TREND_ENDPOINT = 'https://push2his.eastmoney.com/api/qt/stock/trends2/get'
// 东财市场代码:XSHG=1,XSHE=0;美股 secid 前缀由搜索 MktNum 动态归属(usSymbols),其余市场实测前缀。
const MARKET = { XSHG: '1', XSHE: '0' }
const SECID_PREFIX = { XSHG: '1', XSHE: '0', XHKG: '116', XNAS: '105', XNYS: '106', XJPX: '176', XKRX: '177', XLON: '155' }
const US_DEFAULT_MKT = '105'
// klt 周期映射(实测): 日101/周102/月103; trends2 无 klt。
const KLT = { '1d': 101, '1w': 102, '1M': 103 }
const LIST_FS = { XSHG: 'm:1+t:2,m:1+t:23', XSHE: 'm:0+t:6,m:0+t:80' }
const SYMBOL_PREFIX = { 1: 'XSHG', 0: 'XSHE' }
// 探针代表证券(实测可用的各市场流动性代表),quotes/kline 探针按市场取用。
const PROBE_SECURITY = { XSHG: '600519', XSHE: '000001', XHKG: '00700', XNAS: 'AAPL', XNYS: 'BABA', XJPX: '7203', XKRX: '005930', XLON: 'SHEL' }
// klines CSV 前 7 列固定语义(实测 fields2=f51-f57); f53=close 在 f54=high 前为东财原生序。
const KLINE_FIELDS = 'f51,f52,f53,f54,f55,f56,f57'
const TREND_FIELDS = 'f51,f52,f53,f54,f55,f56,f57,f58'
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
  descriptor: { adapterId: 'eastmoney', capabilities: ['quotes', 'catalog', 'search', 'kline'], markets: ['XSHG', 'XSHE', 'XHKG', 'XNAS', 'XNYS', 'XJPX', 'XKRX', 'XLON'], instruments: ['equity'], maxQuoteBatch: 60, credential: 'none' },
  async probe(request, ctx) {
    if (request.capability === 'catalog' || request.capability === 'search') {
      // 探针词按市场选代表证券,跨市场词会误判能力不可用。
      const result = await this[request.capability]({ ...request, q: request.market === 'XSHG' ? '茅台' : '平安', limit: 5 }, ctx)
      if (!result.items.length) throw new StockError('NO_DATA', '来源未返回可校验数据，暂不能确认能力就绪', 422)
      return { status: 'ready', capability: request.capability, market: request.market, instrument: 'equity' }
    }
    // kline 探针直接拉代表证券 3 根日K(实测列义/端点全链),quotes 探针沿用行情行。
    if (request.capability === 'kline') {
      const code = PROBE_SECURITY[request.market] || '000001'
      const result = await this.kline({ ...request, securityId: `${request.market}:equity:${code}`, code, period: '1d', adjust: 'qfq', limit: 3 }, ctx)
      if (!result.candles.length) throw new StockError('NO_DATA', '来源未返回可校验数据，暂不能确认能力就绪', 422)
      return { status: 'ready', capability: 'kline', market: request.market, instrument: 'equity' }
    }
    const security = request.securities?.[0] || { exchange: request.market, code: PROBE_SECURITY[request.market] || '000001' }
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
  // 美股 secid 前缀: usSymbols 命中按 MktNum, miss 默认沪深外美股主市场 NASDAQ;猜错时调用方走 suggest 重试路径。
  secidOf(request, ctx) {
    const { market, code } = request
    if (market === 'XNAS' || market === 'XNYS') {
      const mktNum = ctx.usSymbols?.get(`US:${code}`)?.mktNum
      return `${mktNum || US_DEFAULT_MKT}.${code}`
    }
    return `${SECID_PREFIX[market]}.${code}`
  },
  async kline(request, ctx) {
    if (request.period === 'trend') return this.trend(request, ctx)
    const secid = this.secidOf(request, ctx)
    const url = `${KLINE_ENDPOINT}?secid=${secid}&fields1=f1,f2,f3&fields2=${KLINE_FIELDS}&klt=${KLT[request.period]}&fqt=1&end=20500101&lmt=${request.limit}`
    const body = await getJson(ctx, url)
    if (!body?.data?.klines) {
      if (request.market !== 'XNAS' && request.market !== 'XNYS') throw new StockError('NO_DATA', '来源未返回此证券K线', 422)
      // 美股默认前缀猜错: 经搜索联想解析真实 MktNum, 重试一次;仍失败 NO_DATA。
      const resolved = await this.resolveUsSecid(request, ctx)
      if (!resolved) throw new StockError('NO_DATA', '来源未返回此证券K线', 422)
      ctx.usSymbols?.set(`US:${request.code}`, resolved)
      const retryUrl = url.replace(`secid=${secid}`, `secid=${resolved.mktNum}.${request.code}`)
      const retryBody = await getJson(ctx, retryUrl)
      if (!retryBody?.data?.klines) throw new StockError('NO_DATA', '来源未返回此证券K线', 422)
      return buildKlineResponse(request, retryBody.data, ctx)
    }
    return buildKlineResponse(request, body.data, ctx)
  },
  async resolveUsSecid(request, ctx) {
    const url = `${SEARCH_ENDPOINT}?input=${encodeURIComponent(request.code)}&type=14&token=D43BF722C8E33BDC906FB84D85E326E8&count=5`
    const body = await getJson(ctx, url)
    const row = body?.QuotationCodeTable?.Data?.find(r => r.Code === request.code && /^10[567]$/.test(r.MktNum || ''))
    return row ? { mktNum: row.MktNum, jys: row.JYS || null, at: ctx.now() } : null
  },
  async trend(request, ctx) {
    const secid = this.secidOf(request, ctx)
    const url = `${TREND_ENDPOINT}?secid=${secid}&fields1=f1,f2,f3,f4,f5,f6,f7,f8&fields2=${TREND_FIELDS}&iscr=0&ndays=1`
    const body = await getJson(ctx, url)
    if (!body?.data?.trends) throw new StockError('NO_DATA', '来源未返回此证券分时', 422)
    const candles = body.data.trends.map(row => {
      const cols = row.split(',')
      if (cols.length < 8) throw new StockError('BAD_PAYLOAD', '分时列数不足', 502)
      const [, time] = cols[0].split(' ')
      const num = v => { const n = parseFloat(v); return Number.isFinite(n) ? n : null }
      return { time, open: num(cols[1]), close: num(cols[2]), high: num(cols[3]), low: num(cols[4]), volume: num(cols[5]), amount: num(cols[6]), avg: num(cols[7]) }
    })
    return { providerInstanceId: request.providerInstanceId, fetchedAt: ctx.now(), complete: true, preClose: num_or_null(body.data.preClose), candles }
  },
}

function num_or_null(v) { const n = parseFloat(v); return Number.isFinite(n) ? n : null }

// klines CSV → 合同响应: 逐行解析/升序/重复拒绝; complete 由 dktotal 与请求量判定(源截断标志)。
function buildKlineResponse(request, data, ctx) {
  const candles = []
  let prevTime = ''
  for (const row of data.klines) {
    const cols = row.split(',')
    if (cols.length < 7) throw new StockError('BAD_PAYLOAD', 'K线列数不足', 502)
    if (cols[0] <= prevTime) throw new StockError('BAD_PAYLOAD', 'K线时间戳重复或乱序', 502)
    prevTime = cols[0]
    const num = v => { const n = parseFloat(v); return Number.isFinite(n) ? n : null }
    candles.push({ time: cols[0], open: num(cols[1]), close: num(cols[2]), high: num(cols[3]), low: num(cols[4]), volume: num(cols[5]), amount: num(cols[6]) })
  }
  const total = Number(data.dktotal)
  return { providerInstanceId: request.providerInstanceId, fetchedAt: ctx.now(), complete: Number.isFinite(total) ? request.limit <= total : true, preClose: num_or_null(data.preKPrice), candles }
}
