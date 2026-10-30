import test from 'node:test'
import assert from 'node:assert/strict'
import { createBudget } from '../src/budget.mjs'
const a = { id: 'a', quotaGroup: 'same', budget: { requestsPerMinute: 2, dailyRequestLimit: null, billingUnit: 'request', symbolCreditsPerMinute: null, capabilityLimits: { quotes: 2 } } }
test('未知账号额度只允许主动探针并限制启动频率', () => {
  let now = 0; const budget = createBudget(() => now), unknown = { ...a, budget: { ...a.budget, requestsPerMinute: null } }
  assert.throws(() => budget.reserve(unknown, 'quotes'), e => e.code === 'BUDGET_UNKNOWN')
  budget.reserve(unknown, 'quotes', 1, false, true)
  now = 1000
  assert.throws(() => budget.reserve(unknown, 'catalog', 1, false, true), e => e.code === 'RATE_LIMIT' && e.retryAfterMs >= 9000)
  now = 10000; assert.doesNotThrow(() => budget.reserve(unknown, 'quotes', 1, false, true))
})
test('P11 同账号实例共享额度，不能通过另一个实例翻倍请求', () => {
  let now = 0
  const budget = createBudget(() => now)
  budget.reserve(a, 'quotes', 1)
  now = 1000; budget.reserve({ ...a, id: 'b' }, 'quotes', 1)
  now = 2000
  assert.throws(() => budget.reserve(a, 'quotes', 1), e => e.code === 'RATE_LIMIT' && e.retryAfterMs >= 58000)
  now = 60000; assert.doesNotThrow(() => budget.reserve(a, 'quotes', 1))
})
