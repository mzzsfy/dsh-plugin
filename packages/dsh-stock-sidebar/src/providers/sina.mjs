// 新浪公开行情接口适配器:quotes/catalog。非官方端点,需Referer,无SLA;延迟未知,时间为来源快照时间。
import { normalizeQuote, parseQuoteTime, makeSecurity, securityId, StockError } from '../market-model.mjs'
const ENDPOINT = 'https://hq.sinajs.cn/list='
const LIST_ENDPOINT = 'https://vip.stock.finance.sina.com.cn/quotes_service/api/json_v2.php/Market_Center.getHQNodeData'
const LIST_HEADERS = { Referer: 'https://finance.sina.com.cn/', 'User-Agent': 'Mozilla/5.0' }
const symbolOf = security => `${security.exchange === 'XSHG' ? 'sh' : 'sz'}${security.code}`
// 新浪价格固定三位小数,A股最小变动0.01,第三位恒为0,裁剪到两位不损失精度。
const trim = value => /^\d+(\.\d+)?$/.test(value) ? Number(value).toFixed(2) : value
export const sina = {
  descriptor: { adapterId: 'sina', capabilities: ['quotes', 'catalog'], markets: ['XSHG', 'XSHE'], instruments: ['equity'], maxQuoteBatch: 60, credential: 'none' },
  async probe(request, ctx) {
    if (request.capability === 'catalog') {
      // 探针只拉一页验证端点连通,不做全量分页。
      const response = await ctx.fetch(`${LIST_ENDPOINT}?page=1&num=5&sort=symbol&asc=1&node=${request.market === 'XSHG' ? 'sh_a' : 'sz_a'}`, { headers: LIST_HEADERS, signal: ctx.signal, redirect: 'error' })
      if (!response.ok) throw new StockError('NETWORK', '来源服务暂不可用', 502, { retryable: true })
      const rows = await response.json()
      if (!Array.isArray(rows) || !rows.length) throw new StockError('NO_DATA', '来源未返回可校验数据，暂不能确认能力就绪', 422)
      return { status: 'ready', capability: 'catalog', market: request.market, instrument: 'equity' }
    }
    const security = request.securities?.[0] || { exchange: request.market, code: request.market === 'XSHG' ? '600519' : '000001' }
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
        const response = await ctx.fetch(`${LIST_ENDPOINT}?page=${page}&num=${PAGE_SIZE}&sort=symbol&asc=1&node=${node}`, { headers: LIST_HEADERS, signal: ctx.signal, redirect: 'error' })
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
      response = await ctx.fetch(ENDPOINT + [...symbols.keys()].join(','), { headers: { Referer: 'https://finance.sina.com.cn/', 'User-Agent': 'Mozilla/5.0' }, signal: ctx.signal, redirect: 'error' })
    } catch (e) {
      if (ctx.signal.aborted) throw new StockError('CANCELLED', '请求已取消', 503)
      if (e instanceof StockError) throw e
      throw new StockError('NETWORK', '无法连接行情来源', 502, { retryable: true })
    }
    if (!response.ok) throw new StockError('NETWORK', '来源服务暂不可用', 502, { retryable: true })
    const text = new TextDecoder('gbk').decode(await response.arrayBuffer())
    const seen = new Set(), items = []
    for (const line of text.split(';')) {
      const match = /var hq_str_(sh|sz)(\d{6})="([^"]*)"/.exec(line)
      if (!match) continue
      const providerSymbol = `${match[1]}${match[2]}`, security = symbols.get(providerSymbol)
      if (!security) continue
      if (seen.has(providerSymbol)) throw new StockError('BAD_PAYLOAD', '报价身份冲突', 502)
      seen.add(providerSymbol)
      const f = match[3].split(',')
      if (f.length < 32) throw new StockError('BAD_PAYLOAD', '来源字段数量异常', 502)
      // 新浪volume为股,amount为元;时间为"yyyy-MM-dd,HH:mm:ss"两个字段。
      items.push(normalizeQuote({
        securityId: security.id, providerInstanceId: request.providerInstanceId, adapterId: 'sina', providerSymbol,
        last: trim(f[3]), previousClose: trim(f[2]), open: trim(f[1]), high: trim(f[4]), low: trim(f[5]),
        volume: f[8] == null || Number.isNaN(Number(f[8])) ? null : String(Math.round(Number(f[8]))), volumeUnit: 'share',
        amount: f[9] == null || Number.isNaN(Number(f[9])) ? null : String(Math.round(Number(f[9]))), amountUnit: 'CNY',
        quoteAt: parseQuoteTime(`${f[30]} ${f[31]}`), timestampKind: 'trade',
        receivedAt: ctx.now(), delayKind: 'unknown', delaySeconds: null, securityState: 'unknown',
      }))
    }
    return { providerInstanceId: request.providerInstanceId, fetchedAt: ctx.now(), items, errors: request.securities.filter(s => !seen.has(symbolOf(s))).map(s => ({ securityId: s.id, code: 'NO_DATA', message: '来源未返回此证券报价' })) }
  },
}
