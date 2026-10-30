export function securityId(exchange, code, instrument = 'equity') {
  if (!['XSHG', 'XSHE'].includes(exchange) || typeof code !== 'string' || !/^\d{6}$/.test(code) || instrument !== 'equity') throw new Error('不支持的证券身份')
  return `${exchange}:${instrument}:${code}`
}
function cents(value) {
  if (value === null || value === undefined || value === '') return null
  const text = String(value)
  if (!/^\d+(?:\.\d{1,2})?$/.test(text)) return null
  const [whole, fraction = ''] = text.split('.')
  const n = BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0'))
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
  return { ...extra, id: securityId(exchange, code), exchange, code, officialName, instrument: 'equity', currency: 'CNY', timezone: 'Asia/Shanghai', priceScale: 2, listingStatus: 'listed' }
}

export class StockError extends Error {
  constructor(code, message, status = 400, extra = {}) {
    super(message)
    Object.assign(this, { code, status, retryable: false, retryAfterMs: null }, extra)
  }
}
export const fail = (code, message, status = 400, extra = {}) => { throw new StockError(code, message, status, extra) }

