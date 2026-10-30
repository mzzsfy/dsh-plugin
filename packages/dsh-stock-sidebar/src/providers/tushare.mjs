import { makeSecurity, normalizeQuote, parseQuoteTime, StockError } from '../market-model.mjs'
const EXCHANGE = { XSHG: 'SSE', XSHE: 'SZSE' }
const SUFFIX = { XSHG: 'SH', XSHE: 'SZ' }
const FIELD = {
  quotes: 'ts_code,name,pre_close,open,high,low,close,vol,amount,trade_time',
  catalog: 'ts_code,symbol,name,cnspell,market,exchange,curr_type,list_status,list_date',
  calendar: 'exchange,cal_date,is_open,pretrade_date',
}
const API = { quotes: 'rt_k', catalog: 'stock_basic', calendar: 'trade_cal' }
function bad() { throw new StockError('BAD_PAYLOAD', '行情来源响应格式异常', 502) }
async function query(capability, params, ctx) {
  let response
  try {
    response = await ctx.fetch('https://api.tushare.pro', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ api_name: API[capability], token: ctx.credential(), params, fields: FIELD[capability] }), signal: ctx.signal, redirect: 'error' })
  } catch (e) {
    if (ctx.signal.aborted) throw new StockError('CANCELLED', '请求已取消', 503)
    if (e instanceof StockError) throw e
    throw new StockError('NETWORK', '无法连接行情来源', 502, { retryable: true })
  }
  if (response.status === 429) {
    const retry = response.headers.get('retry-after'), seconds = Number(retry)
    const ms = retry && Number.isFinite(seconds) ? seconds * 1000 : retry ? Date.parse(retry) - ctx.now() : 60 * 1000
    throw new StockError('RATE_LIMIT', '来源请求额度受限', 429, { retryable: true, retryAfterMs: Math.max(1000, ms || 60 * 1000) })
  }
  if (!response.ok) throw new StockError('NETWORK', '来源服务暂不可用', 502, { retryable: true })
  const body = await response.json().catch(bad)
  if (body?.code !== 0) {
    const code = body?.code === 40101 || /token.*(无效|过期|invalid)|认证/i.test(String(body?.msg)) ? 'AUTH' : body?.code === 2002 ? 'PERMISSION' : /频|limit/i.test(String(body?.msg)) ? 'RATE_LIMIT' : 'BAD_PAYLOAD'
    throw new StockError(code, code === 'AUTH' ? '来源认证失败，请检查Host环境凭据' : code === 'PERMISSION' ? '当前账号未开通该数据能力' : code === 'RATE_LIMIT' ? '来源请求额度受限' : '来源拒绝了请求', code === 'RATE_LIMIT' ? 429 : 502, { retryAfterMs: code === 'RATE_LIMIT' ? 60 * 1000 : null })
  }
  const data = body.data
  if (!Array.isArray(data?.fields) || !Array.isArray(data?.items) || new Set(data.fields).size !== data.fields.length || data.fields.some(k => typeof k !== 'string')) bad()
  return data.items.map(row => {
    if (!Array.isArray(row) || row.length !== data.fields.length) bad()
    return Object.fromEntries(data.fields.map((key, i) => [key, row[i]]))
  })
}
function symbol(security) { return `${security.code}.${SUFFIX[security.exchange]}` }
export const tushare = {
  descriptor: { adapterId: 'tushare', capabilities: ['quotes', 'catalog', 'calendar'], markets: ['XSHG', 'XSHE'], instruments: ['equity'], maxQuoteBatch: 20, credential: 'env' },
  async catalog(request, ctx) {
    let rows = await query('catalog', { exchange: EXCHANGE[request.market], list_status: 'L' }, ctx)
    let complete = rows.length < 6000
    if (!complete) {
      rows = []; complete = true
      for (const market of request.market === 'XSHG' ? ['主板', '科创板'] : ['主板', '创业板']) {
        const part = await query('catalog', { exchange: EXCHANGE[request.market], list_status: 'L', market }, ctx)
        rows.push(...part); complete &&= part.length < 6000
      }
    }
    const items = [], seen = new Set()
    for (const row of rows) {
      if (row.exchange !== EXCHANGE[request.market] || row.curr_type !== 'CNY' || row.list_status !== 'L' || !['主板', '创业板', '科创板'].includes(row.market)) continue
      if (typeof row.symbol !== 'string' || !/^\d{6}$/.test(row.symbol) || typeof row.name !== 'string' || !row.name || row.ts_code !== `${row.symbol}.${SUFFIX[request.market]}`) bad()
      if (seen.has(row.ts_code)) bad()
      seen.add(row.ts_code)
      items.push(makeSecurity(request.market, row.symbol, row.name, { cnspell: typeof row.cnspell === 'string' ? row.cnspell.toLowerCase() : '', catalogSource: request.providerInstanceId }))
    }
    return { providerInstanceId: request.providerInstanceId, fetchedAt: ctx.now(), items, errors: [], complete }
  },
  async calendar(request, ctx) {
    const rows = await query('calendar', { exchange: EXCHANGE[request.market], start_date: request.startDate.replaceAll('-', ''), end_date: request.endDate.replaceAll('-', '') }, ctx)
    const date = value => typeof value === 'string' && /^\d{8}$/.test(value) ? `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}` : null
    const items = rows.map(row => {
      if (row.exchange !== EXCHANGE[request.market] || !date(row.cal_date) || ![0, 1, '0', '1'].includes(row.is_open)) bad()
      return { exchange: request.market, date: date(row.cal_date), isOpen: String(row.is_open) === '1', previousOpenDate: date(row.pretrade_date), source: request.providerInstanceId }
    })
    return { providerInstanceId: request.providerInstanceId, fetchedAt: ctx.now(), items, errors: [] }
  },
  async probe(request, ctx) {
    const { capability, market } = request
    const security = makeSecurity(market, market === 'XSHG' ? '600519' : '000001', '权限检查证券')
    const today = new Date(ctx.now() + 8 * 60 * 60 * 1000).toISOString().slice(0, 10)
    const result = await this[capability]({ ...request, securities: [security], startDate: today, endDate: today }, ctx)
    if (!result.items.length) throw new StockError('NO_DATA', '来源未返回可校验数据，暂不能确认能力就绪', 422)
    return { status: 'ready', capability, market, instrument: 'equity' }
  },
  async quotes(request, ctx) {
    const rows = await query('quotes', { ts_code: request.securities.map(symbol).join(',') }, ctx)
    const securities = new Map(request.securities.map(s => [symbol(s), s])), seen = new Set(), items = []
    for (const row of rows) {
      if (!securities.has(row.ts_code)) continue
      if (seen.has(row.ts_code) || !Object.hasOwn(row, 'close') || !Object.hasOwn(row, 'pre_close')) bad()
      seen.add(row.ts_code)
      const security = securities.get(row.ts_code)
      items.push(normalizeQuote({ securityId: security.id, last: row.close, previousClose: row.pre_close, open: row.open, high: row.high, low: row.low,
        volume: row.vol == null ? null : String(row.vol), volumeUnit: 'share', amount: row.amount == null ? null : String(row.amount), amountUnit: 'CNY',
        providerInstanceId: request.providerInstanceId, adapterId: 'tushare', providerSymbol: row.ts_code, quoteAt: parseQuoteTime(row.trade_time), timestampKind: 'trade', receivedAt: ctx.now(), delayKind: 'unknown', delaySeconds: null, securityState: 'unknown' }))
    }
    return { providerInstanceId: request.providerInstanceId, fetchedAt: ctx.now(), items, errors: request.securities.filter(s => !seen.has(symbol(s))).map(s => ({ securityId: s.id, code: 'NO_DATA', message: '来源未返回此证券报价' })) }
  },
}
