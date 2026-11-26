// 东财公开行情接口适配器:quotes/catalog/search/kline。非官方端点,无SLA;延迟未知,f124为来源秒级时间戳。
import { normalizeQuote, makeSecurity, securityId, StockError, MARKET_META, sharesFromLots, zonedUnixSeconds } from '../market-model.mjs'
// 官方默认端点表(key 供 instance.endpoints 覆盖, 反代/镜像场景由 ctx.endpoints 提供同名 key)
const DEFAULT_ENDPOINTS = {
  quotes: 'https://push2.eastmoney.com/api/qt/ulist.np/get',
  list: 'https://push2.eastmoney.com/api/qt/clist/get',
  search: 'https://searchapi.eastmoney.com/api/suggest/get',
  kline: 'https://push2his.eastmoney.com/api/qt/stock/kline/get',
  trend: 'https://push2his.eastmoney.com/api/qt/stock/trends2/get',
}
const endpointOf = (ctx, key) => ctx.endpoints?.[key] || DEFAULT_ENDPOINTS[key]
// suggest 接口的公开站点参数(不是本插件凭据), 两处调用必须同源
const SUGGEST_TOKEN = 'D43BF722C8E33BDC906FB84D85E326E8'
// 沪深市场代码(其余市场的 secid 前缀见 SECID_PREFIX)
const MARKET = { XSHG: '1', XSHE: '0' }
// 搜索联想 MktNum→交易所全集(实测: 1/0 沪深, 116 港, 105/106/107 美三大, 176/177/155 日韩英)
const SEARCH_EXCHANGE = { 1: 'XSHG', 0: 'XSHE', 116: 'XHKG', 105: 'XNAS', 106: 'XNYS', 107: 'XNYS', 176: 'XJPX', 177: 'XKRX', 155: 'XLON' }
const SECID_PREFIX = { XSHG: '1', XSHE: '0', XHKG: '116', XNAS: '105', XNYS: '106', XJPX: '176', XKRX: '177', XLON: '155' }
// 美股三大市场号: 105 纳斯达克 / 106 纽约 / 107 美交所。secid 前缀必须精确匹配, 探针期据此逐个试探。
const US_MKTNUMS = ['105', '106', '107']
const isUSExchange = exchange => exchange === 'XNAS' || exchange === 'XNYS'
// 美股 secid 前缀候选序: 搜索缓存 > 交易所静态前缀 > 其余美股市场号。XNYS 实横跨 106 与 107, 静态前缀只取其一。
// 缓存只加速重复查询, 缺失或过期不改变正确性: 进程重启后 usSymbols 为空, 取报价不得依赖此前的搜索行为。
const usSecidPrefixes = (security, ctx) => [...new Set([ctx.usSymbols?.get(`US:${security.code}`)?.mktNum, SECID_PREFIX[security.exchange], ...US_MKTNUMS].filter(mktNum => US_MKTNUMS.includes(mktNum)))]
const secidFor = (security, ctx) => isUSExchange(security.exchange) ? `${usSecidPrefixes(security, ctx)[0]}.${security.code}` : `${SECID_PREFIX[security.exchange]}.${security.code}`
// klt 周期映射(实测): 日101/周102/月103; trends2 无 klt。
const KLT = { '1d': 101, '1w': 102, '1M': 103 }
// 目录 fs 按市场给出; 英股 m:155 含债券与结构性产品, 加 t:1 只取股票; 日韩不支持 t: 细分, 全量即股票
const LIST_FS = { XSHG: 'm:1+t:2,m:1+t:23', XSHE: 'm:0+t:6,m:0+t:80', XHKG: 'm:116+t:3,m:116+t:4', XNAS: 'm:105+t:1', XNYS: 'm:106+t:1,m:107+t:1', XJPX: 'm:176', XKRX: 'm:177', XLON: 'm:155+t:1' }
const SYMBOL_PREFIX = { 1: 'XSHG', 0: 'XSHE', 116: 'XHKG', 105: 'XNAS', 106: 'XNYS', 107: 'XNYS', 176: 'XJPX', 177: 'XKRX', 155: 'XLON' }
// 探针代表证券(实测可用的各市场流动性代表),quotes/kline 探针按市场取用。
const PROBE_SECURITY = { XSHG: '600519', XSHE: '000001', XHKG: '00700', XNAS: 'AAPL', XNYS: 'BABA', XJPX: '7203', XKRX: '005930', XLON: 'SHEL' }
// klines CSV 前 7 列固定语义(实测 fields2=f51-f57); f53=close 在 f54=high 前为东财原生序。
const KLINE_FIELDS = 'f51,f52,f53,f54,f55,f56,f57'
const TREND_FIELDS = 'f51,f52,f53,f54,f55,f56,f57,f58'
// 分时时间戳的来源时区: 东财统一用北京时间, 与证券所属市场无关
const SOURCE_ZONE = 'Asia/Shanghai'
const num = value => value == null || typeof value === 'number' && !Number.isFinite(value) ? null : value === '-' ? null : String(value)
// 换手率/量比是纯数值语义(不参与定点价格格式化), 统一收敛成 number; 缺失仍是 null
const rate = value => { const text = num(value); const n = Number(text); return text === null || !Number.isFinite(n) ? null : n }
// 风控页是 HTML: 不嗅探就会被当成「响应不是JSON」, 用户看不到「去浏览器过滑块」这条唯一出路
const CHALLENGE_HINT = /验证码|人机验证|安全验证|滑块|拖动|geetest|tcaptcha|captcha/i
const challenged = async response => {
  try {
    const text = await response.clone().text()
    return /^\s*</.test(text) || CHALLENGE_HINT.test(text)
  } catch { return false }
}
async function getJson(ctx, url) {
  let response
  try {
    response = await ctx.fetch(url, { headers: { Referer: 'https://quote.eastmoney.com/', 'User-Agent': 'Mozilla/5.0' }, signal: ctx.signal, redirect: 'error' })
  } catch (e) {
    if (ctx.signal.aborted) throw new StockError('CANCELLED', '请求已取消', 503)
    if (e instanceof StockError) throw e
    throw new StockError('NETWORK', '无法连接行情来源', 502, { retryable: true })
  }
  if (await challenged(response)) throw new StockError('CHALLENGE', '东财要求人机验证：用浏览器打开 www.eastmoney.com 完成验证后自动恢复', 502)
  if (!response.ok) throw new StockError('NETWORK', '来源服务暂不可用', 502, { retryable: true })
  return response.json().catch(() => { throw new StockError('BAD_PAYLOAD', '来源响应不是JSON', 502) })
}
export const eastmoney = {
  descriptor: { adapterId: 'eastmoney', capabilities: ['quotes', 'catalog', 'search', 'kline', 'trend'], markets: ['XSHG', 'XSHE', 'XHKG', 'XNAS', 'XNYS', 'XJPX', 'XKRX', 'XLON'], instruments: ['equity'], maxQuoteBatch: 60, credential: 'none', description: '东方财富公开接口：免凭据，八市场目录，行情/K线/分时/搜索，非官方无SLA', endpointKeys: [{ key: 'quotes', label: '行情批量' }, { key: 'list', label: '证券目录' }, { key: 'search', label: '搜索联想' }, { key: 'kline', label: 'K线历史' }, { key: 'trend', label: '分时' }] },
  async probe(request, ctx) {
    if (request.capability === 'catalog' || request.capability === 'search') {
      // 探针词按市场用代表证券代码(茅台/平安只对沪深有效, 其他市场返回 0 项会误判 denied)。
      const result = await this[request.capability]({ ...request, probe: true, q: PROBE_SECURITY[request.market] || '平安', limit: 5 }, ctx)
      if (!result.items.length) throw new StockError('NO_DATA', '来源未返回可校验数据，暂不能确认能力就绪', 422)
      return { status: 'ready', capability: request.capability, market: request.market, instrument: 'equity' }
    }
    // kline 探针直接拉代表证券 3 根日K(实测列义/端点全链), trend 探针拉当日分时, quotes 探针沿用行情行。
    // 各能力必须探各自的上游端点: 拿行情接口冒充分时, 「分时就绪」只会是假阳性
    if (request.capability === 'kline' || request.capability === 'trend') {
      const capability = request.capability
      const code = PROBE_SECURITY[request.market] || '000001'
      const result = await this[capability](capability === 'kline'
        ? { ...request, securityId: `${request.market}:equity:${code}`, code, period: '1d', adjust: 'qfq', limit: 3 }
        : { ...request, securityId: `${request.market}:equity:${code}`, code, period: 'trend', limit: 50 }, ctx)
      if (!result.candles.length) throw new StockError('NO_DATA', '来源未返回可校验数据，暂不能确认能力就绪', 422)
      return { status: 'ready', capability, market: request.market, instrument: 'equity' }
    }
    // 美股前缀的逐个试探已收敛进 quotes,探针只需一次结果,避免探针与真实取价走两套路径
    const security = request.securities?.[0] || { exchange: request.market, code: PROBE_SECURITY[request.market] || '000001' }
    const rows = await this.quotes({ ...request, securities: [security] }, ctx)
    if (!rows.items.length) throw new StockError('NO_DATA', '来源未返回可校验数据，暂不能确认能力就绪', 422)
    return { status: 'ready', capability: 'quotes', market: request.market, instrument: 'equity' }
  },
  async quotes(request, ctx) {
    const fields = 'f2,f3,f4,f5,f6,f8,f10,f12,f13,f14,f15,f16,f17,f18,f124'
    const seen = new Set(), items = []
    // 一次请求取一批 secid;data:null 表示整批 secid 均无效(如整批退市),降级为逐证券缺失。
    const ingest = async symbols => {
      const body = await getJson(ctx, `${endpointOf(ctx, 'quotes')}?secids=${[...symbols.keys()].join(',')}&fields=${fields}&fltt=2&invt=2`)
      const rows = body?.data?.diff
      if (!Array.isArray(rows)) return
      for (const row of rows) {
        const security = symbols.get(`${row.f13}.${row.f12}`)
        if (!security) continue
        if (seen.has(security.id)) throw new StockError('BAD_PAYLOAD', '报价身份冲突', 502)
        seen.add(security.id)
        // fltt=2时价格为已缩放数值, "-"表示停牌等无值;f124为来源Unix秒;成交额币种按市场派生(单一事实源 MARKET_META.currency)。
        // f8 换手率(百分数原值)、f10 量比在沪深港美同义(实测 116.00700 与 105.AAPL 均可读)
        const quoteAt = Number.isFinite(row.f124) ? new Date(row.f124 * 1000).toISOString() : null
        const currency = MARKET_META[security.exchange]?.currency || 'CNY'
        items.push(normalizeQuote({
          securityId: security.id, providerInstanceId: request.providerInstanceId, adapterId: 'eastmoney', providerSymbol: `${row.f13}.${row.f12}`,
          last: num(row.f2), previousClose: num(row.f18), open: num(row.f17), high: num(row.f15), low: num(row.f16),
          volume: sharesFromLots(num(row.f5), security.exchange), volumeUnit: 'share', amount: num(row.f6), amountUnit: currency,
          turnoverRate: rate(row.f8), volumeRatio: rate(row.f10),
          quoteAt, timestampKind: 'trade',
          receivedAt: ctx.now(), delayKind: 'unknown', delaySeconds: null, securityState: 'unknown',
        }))
      }
    }
    await ingest(new Map(request.securities.map(s => [secidFor(s, ctx), s])))
    // 美股前缀兜底: 静态前缀只对应一个市场号,而交易所归属未必精确(实测 NYSE 的票分属 106/107)。
    // 只对首轮落空的美股补齐剩余候选,一次批量发完,不逐证券重试。
    const orphanUS = request.securities.filter(s => !seen.has(s.id) && isUSExchange(s.exchange))
    const altSymbols = new Map()
    for (const security of orphanUS) for (const mktNum of usSecidPrefixes(security, ctx).slice(1)) altSymbols.set(`${mktNum}.${security.code}`, security)
    if (altSymbols.size) await ingest(altSymbols)
    return { providerInstanceId: request.providerInstanceId, fetchedAt: ctx.now(), items, errors: request.securities.filter(s => !seen.has(s.id)).map(s => ({ securityId: s.id, code: 'NO_DATA', message: '来源未返回此证券报价' })) }
  },
  async catalog(request, ctx) {
    const items = [], seen = new Set()
    const PAGE_SIZE = 100, MAX_PAGES = 50
    // 探针只拉一页: executor 单请求 8 秒预算内完成, 全量翻页是同步通道的职责
    const pages = request.probe ? 1 : MAX_PAGES
    let page = 1, complete = true
    while (page <= pages) {
      const url = `${endpointOf(ctx, 'list')}?pn=${page}&pz=${PAGE_SIZE}&po=1&np=1&fltt=2&invt=2&fid=f12&fs=${LIST_FS[request.market]}&fields=f12,f13,f14`
      const body = await getJson(ctx, url)
      const diff = body?.data?.diff
      if (!Array.isArray(diff)) throw new StockError('BAD_PAYLOAD', '目录字段结构异常', 502)
      const total = Number(body.data.total)
      if (!Number.isFinite(total)) throw new StockError('BAD_PAYLOAD', '目录总数缺失', 502)
      for (const row of diff) {
        const exchange = SYMBOL_PREFIX[row.f13]
        if (exchange !== request.market || typeof row.f12 !== 'string' || !MARKET_META[request.market].codePattern.test(row.f12) || typeof row.f14 !== 'string' || !row.f14) continue
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
    // 不限市场时扩大候选量: 单次响应要覆盖调用方负责的多个市场
    const count = request.market ? Math.min(20, request.limit || 10) : Math.min(50, (request.limit || 10) * 3)
    const url = `${endpointOf(ctx, 'search')}?input=${encodeURIComponent(request.q)}&type=14&token=${SUGGEST_TOKEN}&count=${count}`
    const body = await getJson(ctx, url)
    const rows = body?.QuotationCodeTable?.Data
    if (!Array.isArray(rows)) return { providerInstanceId: request.providerInstanceId, fetchedAt: ctx.now(), items: [], errors: [] }
    const items = []
    for (const row of rows) {
      const exchange = SEARCH_EXCHANGE[row.MktNum]
      if (!exchange || (request.market && exchange !== request.market)) continue
      // 美股候选写 usSymbols(代码→MktNum/JYS), kline 美股动态归属与腾讯 suffix 唯一数据来源
      if (isUSExchange(exchange) && ctx.usSymbols && US_MKTNUMS.includes(String(row.MktNum))) ctx.usSymbols.set(`US:${row.Code}`, { mktNum: row.MktNum, jys: row.JYS || null, at: ctx.now() })
      const meta = MARKET_META[exchange]
      if (!meta || !meta.codePattern.test(row.Code)) continue
      items.push(makeSecurity(exchange, row.Code, row.Name, { cnspell: typeof row.PinYin === 'string' ? row.PinYin.toLowerCase() : '', catalogSource: request.providerInstanceId }))
    }
    return { providerInstanceId: request.providerInstanceId, fetchedAt: ctx.now(), items, errors: [] }
  },
  // 与 quotes 同源的 secid;猜错时调用方走 suggest 重试路径(搜索结果是市场号的权威来源)。
  secidOf(request, ctx) {
    return secidFor({ exchange: request.market, code: request.code }, ctx)
  },
  // 美股默认前缀猜错时经搜索联想解析真实 MktNum, 重试一次并缓存映射; K线与分时共用同一条兜底
  async withUsFallback(request, ctx, buildUrl, hasData, label) {
    let body = await getJson(ctx, buildUrl(this.secidOf(request, ctx)))
    if (hasData(body)) return body
    if (!isUSExchange(request.market)) throw new StockError('NO_DATA', `来源未返回此证券${label}`, 422)
    const resolved = await this.resolveUsSecid(request, ctx)
    if (!resolved) throw new StockError('NO_DATA', `来源未返回此证券${label}`, 422)
    ctx.usSymbols?.set(`US:${request.code}`, resolved)
    body = await getJson(ctx, buildUrl(`${resolved.mktNum}.${request.code}`))
    if (!hasData(body)) throw new StockError('NO_DATA', `来源未返回此证券${label}`, 422)
    return body
  },
  async kline(request, ctx) {
    const klt = KLT[request.period]
    if (!klt) throw new StockError('INVALID_PARAM', '东财 K 线只支持日/周/月，分时请走分时能力', 400)
    const body = await this.withUsFallback(request, ctx, secid => `${endpointOf(ctx, 'kline')}?secid=${secid}&fields1=f1,f2,f3&fields2=${KLINE_FIELDS}&klt=${klt}&fqt=1&end=20500101&lmt=${request.limit}`, body => !!body?.data?.klines, 'K线')
    return buildKlineResponse(request, body.data, ctx)
  },
  async resolveUsSecid(request, ctx) {
    const url = `${endpointOf(ctx, 'search')}?input=${encodeURIComponent(request.code)}&type=14&token=${SUGGEST_TOKEN}&count=5`
    const body = await getJson(ctx, url)
    const row = body?.QuotationCodeTable?.Data?.find(r => r.Code === request.code && /^10[567]$/.test(r.MktNum || ''))
    return row ? { mktNum: row.MktNum, jys: row.JYS || null, at: ctx.now() } : null
  },
  async trend(request, ctx) {
    const body = await this.withUsFallback(request, ctx, secid => `${endpointOf(ctx, 'trend')}?secid=${secid}&fields1=f1,f2,f3,f4,f5,f6,f7,f8&fields2=${TREND_FIELDS}&iscr=0&ndays=1`, body => !!body?.data?.trends, '分时')
    // 东财分时的时间戳一律按北京时间给出(八市场实测: 日股 08:00 对应东京 09:00 开盘, 英股 16:00 对应伦敦 08:00),
    // 不是市场本地时间; 之前按市场时区解释, 日韩英的横轴整体偏了几小时。
    const candles = body.data.trends.map(row => {
      const cols = row.split(',')
      if (cols.length < 8) throw new StockError('BAD_PAYLOAD', '分时列数不足', 502)
      const [, time] = cols[0].split(' ')
      const num = v => { const n = parseFloat(v); return Number.isFinite(n) ? n : null }
      // at 是来源时刻的 Unix 秒:只留 HH:MM 会让客户端按索引自造时间轴,横轴整体平移
      // f56 与日K 同为手: 沪深要按 100 股换算, 否则分时图例的量和日K/详情差两个数量级
      return { time, at: zonedUnixSeconds(cols[0], SOURCE_ZONE), open: num(cols[1]), close: num(cols[2]), high: num(cols[3]), low: num(cols[4]), volume: sharesFromLots(num(cols[5]), request.market), amount: num(cols[6]), avg: num(cols[7]) }
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
    candles.push({ time: cols[0], open: num(cols[1]), close: num(cols[2]), high: num(cols[3]), low: num(cols[4]), volume: sharesFromLots(num(cols[5]), request.market), amount: num(cols[6]) })
  }
  const total = Number(data.dktotal)
  return { providerInstanceId: request.providerInstanceId, fetchedAt: ctx.now(), complete: Number.isFinite(total) ? request.limit <= total : true, preClose: num_or_null(data.preKPrice), candles }
}
