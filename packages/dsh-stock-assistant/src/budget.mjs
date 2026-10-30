import { fail } from './market-model.mjs'
const MINUTE = 60 * 1000
export function createBudget(now = Date.now) {
  const groups = new Map()
  return {
    reserve(instance, capability, count = 1, periodic = false, probe = false) {
      const key = instance.quotaGroup, budget = instance.budget
      const day = new Date(now() + 8 * 60 * MINUTE).toISOString().slice(0, 10)
      if (!groups.has(key)) groups.set(key, { day, dayCount: 0, rows: [], last: -Infinity, blocked: 0 })
      const s = groups.get(key)
      if (day !== s.day) { s.day = day; s.dayCount = 0 }
      s.rows = s.rows.filter(r => now() - r.at < MINUTE)
      const limited = wait => fail('RATE_LIMIT', '数据源额度受限，请稍后重试', 429, { retryAfterMs: Math.max(1000, wait), retryable: true })
      if (budget.requestsPerMinute === null) {
        if (!probe) fail('BUDGET_UNKNOWN', '账号额度未确认，请先在设置中填写实际预算', 422)
        if (now() - s.last < 10 * 1000) limited(10 * 1000 - (now() - s.last))
        if (s.blocked > now()) limited(s.blocked - now())
        s.last = now(); s.rows.push({ at: now(), capability, count }); s.dayCount++; return
      }
      if (s.blocked > now()) limited(s.blocked - now())
      if (now() - s.last < 1000) limited(1000 - (now() - s.last))
      const fraction = periodic ? 0.9 : 1
      const cap = Math.max(1, Math.floor(budget.requestsPerMinute * fraction))
      const subcap = Math.max(1, Math.floor((budget.capabilityLimits[capability] || budget.requestsPerMinute) * fraction))
      const sub = s.rows.filter(r => r.capability === capability)
      if (s.rows.length >= cap) limited(s.rows[0].at + MINUTE - now())
      if (sub.length >= subcap) limited(sub[0].at + MINUTE - now())
      if (budget.dailyRequestLimit && s.dayCount >= budget.dailyRequestLimit) limited(24 * 60 * MINUTE - (now() + 8 * 60 * MINUTE) % (24 * 60 * MINUTE))
      if (budget.billingUnit === 'symbol' && s.rows.reduce((sum, r) => sum + r.count, 0) + count > budget.symbolCreditsPerMinute) limited((s.rows[0]?.at ?? now()) + MINUTE - now())
      s.rows.push({ at: now(), capability, count }); s.last = now(); s.dayCount++
    },
    block(instance, ms) { const s = groups.get(instance.quotaGroup); if (s) s.blocked = Math.max(s.blocked, now() + ms) },
  }
}
