// 每市场的币种/时区/价格精度/代码形态/探针门控——securitySchema 与 makeSecurity 的派生源(来源标注见 design.md)
// sessions 是该市场连续竞价的时段(市场本地时间), 用来判断报价此刻处在交易中/午休/休市;
// 只描述周内时点, 法定节假日仍以数据本身(最后一根K线的日期)为准。
export const MARKET_META = {
  XSHG: { currency: 'CNY', timezone: 'Asia/Shanghai', priceScale: 2, codePattern: /^\d{6}$/, verifiedByDefault: true, auction: ['09:15', '09:25'], sessions: [['09:30', '11:30'], ['13:00', '15:00']], tag: '沪A' },
  XSHE: { currency: 'CNY', timezone: 'Asia/Shanghai', priceScale: 2, codePattern: /^\d{6}$/, verifiedByDefault: true, auction: ['09:15', '09:25'], sessions: [['09:30', '11:30'], ['13:00', '15:00']], tag: '深A' },
  XHKG: { currency: 'HKD', timezone: 'Asia/Hong_Kong', priceScale: 2, codePattern: /^\d{4,5}$/, verifiedByDefault: true, sessions: [['09:30', '12:00'], ['13:00', '16:00']], tag: '港股' },
  XNAS: { currency: 'USD', timezone: 'America/New_York', priceScale: 2, codePattern: /^[A-Z]{1,5}$/, verifiedByDefault: true, sessions: [['09:30', '16:00']], tag: '纳斯达克' },
  XNYS: { currency: 'USD', timezone: 'America/New_York', priceScale: 2, codePattern: /^[A-Z]{1,5}$/, verifiedByDefault: true, sessions: [['09:30', '16:00']], tag: '纽交所' },
  XJPX: { currency: 'JPY', timezone: 'Asia/Tokyo', priceScale: 0, codePattern: /^\d{4}$/, verifiedByDefault: true, sessions: [['09:00', '11:30'], ['12:30', '15:30']], tag: '日本' },
  XKRX: { currency: 'KRW', timezone: 'Asia/Seoul', priceScale: 0, codePattern: /^\d{6}$/, verifiedByDefault: true, sessions: [['09:00', '15:30']], tag: '韩国' },
  XLON: { currency: 'GBP', timezone: 'Europe/London', priceScale: 2, codePattern: /^[A-Z0-9.]{1,10}$/, verifiedByDefault: true, sessions: [['08:00', '16:30']], tag: '英国' },
}
// 交易时段判定按市场时区复用格式化器:逐笔报价判定时新建 formatter 主导成本
const SESSION_FORMATTERS = new Map()

function sessionFormatter(timeZone) {
  let formatter = SESSION_FORMATTERS.get(timeZone)
  if (formatter === undefined) {
    formatter = new Intl.DateTimeFormat('en-US', { timeZone, hourCycle: 'h23', weekday: 'short', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
    SESSION_FORMATTERS.set(timeZone, formatter)
  }
  return formatter
}
const toMinutes = stamp => { const [hh, mm] = stamp.split(':').map(Number); return hh * 60 + mm }
const WEEKEND = new Set(['Sat', 'Sun'])
function zonedParts(timeZone, nowMs) {
  const parts = sessionFormatter(timeZone).formatToParts(new Date(nowMs))
  const pick = type => parts.find(part => part.type === type)?.value
  return { weekday: pick('weekday'), date: `${pick('year')}-${pick('month')}-${pick('day')}`, minutes: (Number(pick('hour')) % 24) * 60 + Number(pick('minute')) }
}
// 市场本地日期: 日历记录、休市判断都按证券所属市场的自然日, 不能统一用北京时间
export const marketDate = (exchange, nowMs) => MARKET_META[exchange] ? zonedParts(MARKET_META[exchange].timezone, nowMs).date : new Date(nowMs).toISOString().slice(0, 10)
// 报价时刻是否已过该市场当日收盘: 只有收盘后的成交才算当日收盘价
export const isAfterMarketClose = (exchange, ms) => {
  const meta = MARKET_META[exchange]
  return !!meta?.sessions?.length && zonedParts(meta.timezone, ms).minutes >= toMinutes(meta.sessions.at(-1)[1])
}
// 最近一个已收盘交易日的市场本地日期: 闭市报价只有属于这一天(或今天已收盘)才算最新收盘
function lastCloseDateOf(meta, local, calendarDays) {
  const close = toMinutes(meta.sessions.at(-1)[1])
  const declared = calendarDays?.get(local.date)
  const tradingDay = declared !== false && !(declared === undefined && WEEKEND.has(local.weekday))
  if (tradingDay && local.minutes >= close) return local.date
  for (let offset = 1; offset <= 60; offset++) {
    const date = addDays(local.date, -offset)
    const open = calendarDays?.get(date)
    if (open === false) continue
    if (open === undefined && isWeekend(date)) continue
    return date
  }
  return local.date
}
// 某一时区的时钟文本: 分时横轴用来源时区(东财/腾讯统一按北京时间), 与在线返回的 time 同一基准
export const clockInZone = (timeZone, unixSeconds) => {
  const minutes = zonedParts(timeZone, unixSeconds * 1000).minutes
  return `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`
}
// 来源给的本地时刻(如 2026-11-16 09:30)换算成 Unix 秒: 分时的 at 必须是来源时刻, 让客户端按真实时间对齐横轴
const STAMP_FORMATTERS = new Map()
const stampFormatter = timeZone => {
  let formatter = STAMP_FORMATTERS.get(timeZone)
  if (formatter === undefined) {
    formatter = new Intl.DateTimeFormat('en-US', { timeZone, hour12: false, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' })
    STAMP_FORMATTERS.set(timeZone, formatter)
  }
  return formatter
}
export function zonedUnixSeconds(stamp, timeZone) {
  const match = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})/.exec(stamp)
  if (!match || !timeZone) return null
  const [, y, mo, d, hh, mm] = match.map(Number)
  // 先当成 UTC 造一个候选时刻, 再用该时区的偏移把它拗回去(含夏令时)
  const localAsUtc = Date.UTC(y, mo - 1, d, hh, mm)
  const parts = stampFormatter(timeZone).formatToParts(new Date(localAsUtc))
  const rendered = Object.fromEntries(parts.map(part => [part.type, part.value]))
  const asUtc = Date.UTC(Number(rendered.year), Number(rendered.month) - 1, Number(rendered.day), Number(rendered.hour) % 24, Number(rendered.minute), Number(rendered.second))
  return Math.floor((localAsUtc - (asUtc - localAsUtc)) / 1000)
}
function addDays(date, days) { const [y, m, d] = date.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10) }
const isWeekend = date => { const day = new Date(`${date}T00:00:00Z`).getUTCDay(); return day === 0 || day === 6 }
// 市场本地时刻 → epoch: 先按 UTC 构造, 再用该时区的实际偏移回推(两次足够覆盖 DST 偏移)
function epochOf(timeZone, date, minutes) {
  const [y, m, d] = date.split('-').map(Number)
  const target = Date.UTC(y, m - 1, d, Math.floor(minutes / 60), minutes % 60)
  let stamp = target
  for (let i = 0; i < 3; i++) {
    const local = zonedParts(timeZone, stamp)
    const [ly, lm, ld] = local.date.split('-').map(Number)
    const delta = target - Date.UTC(ly, lm - 1, ld, Math.floor(local.minutes / 60), local.minutes % 60)
    if (delta === 0) break
    stamp += delta
  }
  return stamp
}
const firstStartOf = meta => toMinutes((meta.auction || meta.sessions[0])[0])
// 下一个交易日的首个可采集时刻; 有日历按 isOpen 跳过节假日, 无日历只能跳过周末
function nextOpenAt(meta, fromDate, calendarDays) {
  for (let offset = 1; offset <= 60; offset++) {
    const date = addDays(fromDate, offset)
    const open = calendarDays?.get(date)
    if (open === false) continue
    if (open === undefined && isWeekend(date)) continue
    return epochOf(meta.timezone, date, firstStartOf(meta))
  }
  return epochOf(meta.timezone, addDays(fromDate, 1), firstStartOf(meta))
}
// 报价此刻落在市场交易日的哪个阶段, 并给出下一次可采集时刻; 节假日只由日历记录判定
export function marketStateOf(exchange, nowMs, calendarDays = null) {
  const meta = MARKET_META[exchange]
  if (!meta?.sessions?.length) return { state: 'unknown' }
  const local = zonedParts(meta.timezone, nowMs)
  const lastCloseDate = lastCloseDateOf(meta, local, calendarDays)
  const dayOpen = calendarDays?.get(local.date)
  if (dayOpen === false) return { state: 'closed', nextAt: nextOpenAt(meta, local.date, calendarDays), lastCloseDate }
  if (dayOpen === undefined && WEEKEND.has(local.weekday)) return { state: 'closed', nextAt: nextOpenAt(meta, local.date, calendarDays), lastCloseDate }
  const minutes = local.minutes
  if (meta.auction) {
    const [auctionFrom, auctionTo] = meta.auction.map(toMinutes)
    if (minutes < auctionFrom) return { state: 'preopen', nextAt: epochOf(meta.timezone, local.date, auctionFrom), lastCloseDate }
    if (minutes < auctionTo) return { state: 'auction', lastCloseDate }
  }
  const bounds = meta.sessions.map(([from, to]) => [toMinutes(from), toMinutes(to)])
  if (minutes < bounds[0][0]) return { state: 'preopen', nextAt: epochOf(meta.timezone, local.date, bounds[0][0]), lastCloseDate }
  if (bounds.some(([from, to]) => minutes >= from && minutes < to)) return { state: 'trading', lastCloseDate }
  // 午休只存在于两段之间: 只比前一段的收尾会把收盘后也算成午休
  const breakIndex = bounds.findIndex(([, to], index) => index < bounds.length - 1 && minutes >= to && minutes < bounds[index + 1][0])
  if (breakIndex >= 0) return { state: 'break', nextAt: epochOf(meta.timezone, local.date, bounds[breakIndex + 1][0]), lastCloseDate }
  return { state: 'closed', nextAt: nextOpenAt(meta, local.date, calendarDays), lastCloseDate }
}
// 兼容旧调用面: 只要阶段
export function sessionStateOf(exchange, nowMs) {
  return marketStateOf(exchange, nowMs).state
}

export function securityId(exchange, code, instrument = 'equity') {
  const meta = MARKET_META[exchange]
  if (!meta || instrument !== 'equity' || typeof code !== 'string' || !meta.codePattern.test(code)) throw new Error('不支持的证券身份')
  return `${exchange}:${instrument}:${code}`
}

export function parseSecurityId(securityIdValue) {
  const parts = String(securityIdValue || '').split(':')
  const [exchange, instrument, code] = parts
  if (parts.length !== 3 || instrument !== 'equity' || !MARKET_META[exchange]) throw new Error('不支持的证券身份')
  return { exchange, instrument, code: securityId(exchange, code, instrument).split(':')[2], meta: MARKET_META[exchange] }
}
// 定点基准是分;来源允许多于两位小数(美股常见三位),超出部分四舍五入到分
function cents(value) {
  if (value === null || value === undefined || value === '') return null
  const text = String(value)
  const match = /^(\d+)(?:\.(\d{1,6}))?$/.exec(text)
  if (!match) return null
  const [, whole, fraction = ''] = match
  let n = BigInt(whole) * 100n + BigInt(fraction.slice(0, 2).padEnd(2, '0'))
  if (fraction.length > 2 && Number(fraction[2]) >= 5) n += 1n
  return n > 0n ? n : null
}
function decimal(n) {
  const sign = n < 0n ? '-' : ''
  const abs = n < 0n ? -n : n
  return `${sign}${abs / 100n}.${String(abs % 100n).padStart(2, '0')}`
}
export function normalizeQuote(input) {
  const last = cents(input.last), previous = cents(input.previousClose)
  const change = last !== null && previous !== null ? last - previous : null
  const numerator = change === null ? null : change * 10000n
  const abs = numerator === null ? null : numerator < 0n ? -numerator : numerator
  const pct = abs === null ? null : (abs + previous / 2n) / previous * (numerator < 0n ? -1n : 1n)
  const price = key => { const n = cents(input[key]); return n === null ? null : decimal(n) }
  return { ...input, last: price('last'), previousClose: price('previousClose'), open: price('open'), high: price('high'), low: price('low'), change: change === null ? null : decimal(change), changePct: pct === null ? null : decimal(pct) }
}
export function parseQuoteTime(value) {
  if (typeof value !== 'string') return null
  const match = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})(\.\d{1,3})?(Z|[+-]\d{2}:\d{2})?$/.exec(value)
  if (!match) return null
  const [, y, m, d, hh, mm, ss] = match
  const day = new Date(Date.UTC(+y, +m - 1, +d))
  if (day.getUTCFullYear() !== +y || day.getUTCMonth() + 1 !== +m || day.getUTCDate() !== +d || +hh > 23 || +mm > 59 || +ss > 59) return null
  const time = Date.parse(value.replace(' ', 'T') + (match[8] ? '' : '+08:00'))
  return Number.isFinite(time) ? new Date(time).toISOString() : null
}

export function makeSecurity(exchange, code, officialName, extra = {}) {
  const meta = MARKET_META[exchange]
  if (!meta) throw new Error('不支持的证券身份')
  return { ...extra, id: securityId(exchange, code), exchange, code, officialName, instrument: 'equity', currency: meta.currency, timezone: meta.timezone, priceScale: meta.priceScale, listingStatus: 'listed' }
}

// 成交量单位换算: 沪深来源按手报价(1 手 = 100 股), 港美来源直接给股。对外统一按股呈现。
export const LOTS_EXCHANGES = new Set(['XSHG', 'XSHE'])
export const sharesFromLots = (volume, exchange) => (volume === null || volume === undefined ? null : LOTS_EXCHANGES.has(exchange) ? volume * 100 : volume)
// 成交额单位换算: 沪深来源按万元给, 港美来源直接给元。
export const LOTS_AMOUNT_EXCHANGES = new Set(['XSHG', 'XSHE'])
export const amountFromWan = (amount, exchange) => (amount === null || amount === undefined ? null : LOTS_AMOUNT_EXCHANGES.has(exchange) ? Math.round(amount * 10000) : amount)

export class StockError extends Error {
  constructor(code, message, status = 400, extra = {}) {
    super(message)
    Object.assign(this, { code, status, retryable: false, retryAfterMs: null }, extra)
  }
}
export const fail = (code, message, status = 400, extra = {}) => { throw new StockError(code, message, status, extra) }

