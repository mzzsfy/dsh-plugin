// 新浪公开行情接口适配器:quotes(沪深港美)/catalog(沪深)。非官方端点,需Referer,无SLA;延迟未知,时间为来源快照时间。
import { normalizeQuote, parseQuoteTime, makeSecurity, securityId, StockError } from '../market-model.mjs'
const ENDPOINT = 'https://hq.sinajs.cn/list='
const LIST_ENDPOINT = 'https://vip.stock.finance.sina.com.cn/quotes_service/api/json_v2.php/Market_Center.getHQNodeData'
const HEADERS = { Referer: 'https://finance.sina.com.cn/', 'User-Agent': 'Mozilla/5.0' }
// 报价前缀与币种随市场派生(单一事实源);美股代码在来源侧是小写
const BY_MARKET = {
  XSHG: { prefix: 'sh', currency: 'CNY' },
  XSHE: { prefix: 'sz', currency: 'CNY' },
  XHKG: { prefix: 'rt_hk', currency: 'HKD' },
  XNAS: { prefix: 'gb_', currency: 'USD' },
  XNYS: { prefix: 'gb_', currency: 'USD' },
}
const symbolOf = security => {
  const meta = BY_MARKET[security.exchange]
  const code = meta.prefix === 'gb_' ? String(security.code).toLowerCase() : security.code
  return `${meta.prefix}${code}`
}
// 探针代表证券(各市场实测可达的流动性标的)
const PROBE_SECURITY = { XSHG: '600519', XSHE: '000001', XHKG: '00700', XNAS: 'AAPL', XNYS: 'BABA' }
// 新浪价格固定三位以上小数,A股最小变动0.01,裁剪到两位不损失精度;港美同理按分呈现
const trim = value => /^\d+(\.\d+)?$/.test(value) ? Number(value).toFixed(2) : value
const count = value => value == null || Number.isNaN(Number(value)) ? null : String(Math.round(Number(value)))
// 各市场字段位置:沪深34列、港股25列、美股36列,同一行内的列义由前缀决定
const FIELD_MAP = {
  cn: f => ({ open: f[1], previousClose: f[2], last: f[3], high: f[4], low: f[5], volume: f[8], amount: f[9], quoteAt: `${f[30]} ${f[31]}` }),
  hk: f => ({ open: f[2], previousClose: f[3], high: f[4], low: f[5], last: f[6], volume: f[12], amount: f[11], quoteAt: `${String(f[17]).replace(/\//g, '-')} ${f[18]}` }),
  us: f => ({ open: f[5], previousClose: f[26], last: f[1], high: f[6], low: f[7], volume: f[10], quoteAt: f[3] }),
}
const kindOf = providerSymbol => providerSymbol.startsWith('rt_hk') ? 'hk' : providerSymbol.startsWith('gb_') ? 'us' : 'cn'
const MIN_FIELDS = { cn: 32, hk: 20, us: 28 }
export const sina = {
  descriptor: { adapterId: 'sina', capabilities: ['quotes', 'catalog'], markets: ['XSHG', 'XSHE', 'XHKG', 'XNAS', 'XNYS'], instruments: ['equity'], maxQuoteBatch: 60, credential: 'none', description: '新浪公开接口：免凭据，沪深港美行情与沪深目录' },
  async probe(request, ctx) {
    if (request.capability === 'catalog') {
      // 探针只拉一页验证端点连通,不做全量分页。
      const response = await ctx.fetch(`${LIST_ENDPOINT}?page=1&num=5&sort=symbol&asc=1&node=${request.market === 'XSHG' ? 'sh_a' : 'sz_a'}`, { headers: HEADERS, signal: ctx.signal, redirect: 'error' })
      if (!response.ok) throw new StockError('NETWORK', '来源服务暂不可用', 502, { retryable: true })
      const rows = await response.json()
      if (!Array.isArray(rows) || !rows.length) throw new StockError('NO_DATA', '来源未返回可校验数据，暂不能确认能力就绪', 422)
      return { status: 'ready', capability: 'catalog', market: request.market, instrument: 'equity' }
    }
    const security = request.securities?.[0] || { exchange: request.market, code: PROBE_SECURITY[request.market] || '600519' }
    const rows = await this.quotes({ ...request, securities: [security] }, ctx)
    if (!rows.items.length) throw new StockError('NO_DATA', '来源未返回可校验数据，暂不能确认能力就绪', 422)
    return { status: 'ready', capability: 'quotes', market: request.market, instrument: 'equity' }
  },
  async catalog(request, ctx) {
    // 分市场节点sh_a/sz_a直接取本市场全量,分页间保持来源要求的节流间隔。
    const PAGE_SIZE = 80, MAX_PAGES = 100, PAGE_GAP = 600
    const prefix = request.market === 'XSHG' ? 'sh' : 'sz', node = request.market === 'XSHG' ? 'sh_a' : 'sz_a'
    const items = [], seen = new Set()
    let page = 1, complete = true, retriedShort = false
    while (page <= MAX_PAGES) {
      let rows
      try {
        const response = await ctx.fetch(`${LIST_ENDPOINT}?page=${page}&num=${PAGE_SIZE}&sort=symbol&asc=1&node=${node}`, { headers: HEADERS, signal: ctx.signal, redirect: 'error' })
        if (!response.ok) throw new StockError('NETWORK', '来源服务暂不可用', 502, { retryable: true })
        rows = await response.json()
      } catch (e) {
        if (ctx.signal.aborted) throw new StockError('CANCELLED', '请求已取消', 503)
        if (e instanceof StockError) throw e
        throw new StockError('NETWORK', '无法连接行情来源', 502, { retryable: true })
      }
      if (!Array.isArray(rows)) throw new StockError('BAD_PAYLOAD', '目录字段结构异常', 502)
      if (rows.length < PAGE_SIZE && !retriedShort) {
        // 连续请求过密时来源会降级返回短页,退避后重拉本页一次再终止。
        retriedShort = true
        await new Promise((resolve, reject) => { const t = setTimeout(resolve, 3 * 1000); ctx.signal.addEventListener('abort', () => { clearTimeout(t); reject(new StockError('CANCELLED', '请求已取消', 503)) }, { once: true }) })
        continue
      }
      retriedShort = false
      for (const row of rows) {
        if (typeof row.symbol !== 'string' || !row.symbol.startsWith(prefix) || !/^\d{6}$/.test(row.code || '') || typeof row.name !== 'string' || !row.name) continue
        const id = securityId(request.market, row.code)
        if (seen.has(id)) throw new StockError('BAD_PAYLOAD', '目录身份冲突', 502)
        seen.add(id)
        items.push(makeSecurity(request.market, row.code, row.name, { cnspell: '', catalogSource: request.providerInstanceId }))
      }
      if (rows.length < PAGE_SIZE) break
      if (page === MAX_PAGES) complete = false
      page++
      await new Promise((resolve, reject) => { const t = setTimeout(resolve, PAGE_GAP); ctx.signal.addEventListener('abort', () => { clearTimeout(t); reject(new StockError('CANCELLED', '请求已取消', 503)) }, { once: true }) })
    }
    return { providerInstanceId: request.providerInstanceId, fetchedAt: ctx.now(), items, errors: [], complete }
  },
  async quotes(request, ctx) {
    const symbols = new Map(request.securities.map(s => [symbolOf(s), s]))
    let response
    try {
      response = await ctx.fetch(ENDPOINT + [...symbols.keys()].join(','), { headers: HEADERS, signal: ctx.signal, redirect: 'error' })
    } catch (e) {
      if (ctx.signal.aborted) throw new StockError('CANCELLED', '请求已取消', 503)
      if (e instanceof StockError) throw e
      throw new StockError('NETWORK', '无法连接行情来源', 502, { retryable: true })
    }
    if (!response.ok) throw new StockError('NETWORK', '来源服务暂不可用', 502, { retryable: true })
    const text = new TextDecoder('gbk').decode(await response.arrayBuffer())
    const seen = new Set(), items = []
    for (const line of text.split(';')) {
      const match = /var hq_str_(\w+)="([^"]*)"/.exec(line)
      if (!match) continue
      const providerSymbol = match[1], security = symbols.get(providerSymbol)
      if (!security) continue
      if (seen.has(providerSymbol)) throw new StockError('BAD_PAYLOAD', '报价身份冲突', 502)
      seen.add(providerSymbol)
      const f = match[2].split(','), kind = kindOf(providerSymbol)
      // 停牌行来源返回空串,按无值处理而不是伪造零价
      if (f.length < MIN_FIELDS[kind]) throw new StockError('BAD_PAYLOAD', '来源字段数量异常', 502)
      const mapped = FIELD_MAP[kind](f)
      items.push(normalizeQuote({
        securityId: security.id, providerInstanceId: request.providerInstanceId, adapterId: 'sina', providerSymbol,
        last: trim(mapped.last), previousClose: trim(mapped.previousClose), open: trim(mapped.open), high: trim(mapped.high), low: trim(mapped.low),
        volume: count(mapped.volume), volumeUnit: 'share', amount: count(mapped.amount), amountUnit: BY_MARKET[security.exchange].currency,
        quoteAt: parseQuoteTime(mapped.quoteAt), timestampKind: 'trade',
        receivedAt: ctx.now(), delayKind: 'unknown', delaySeconds: null, securityState: 'unknown',
      }))
    }
    return { providerInstanceId: request.providerInstanceId, fetchedAt: ctx.now(), items, errors: request.securities.filter(s => !seen.has(symbolOf(s))).map(s => ({ securityId: s.id, code: 'NO_DATA', message: '来源未返回此证券报价' })) }
  },
}
