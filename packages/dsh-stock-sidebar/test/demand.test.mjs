import test from 'node:test'
import assert from 'node:assert/strict'
import { createDemand } from '../src/demand.mjs'
test('D02/D03 租约到期停止且旧代次无法复活', () => {
  let now = 0, changes = 0
  const demand = createDemand(() => changes++, () => now)
  demand.update({ pageId: '00000000-0000-4000-8000-000000000001', generation: 1, active: true })
  assert.equal(demand.active(), true)
  demand.update({ pageId: '00000000-0000-4000-8000-000000000001', generation: 3, active: false })
  demand.update({ pageId: '00000000-0000-4000-8000-000000000001', generation: 2, active: true })
  assert.equal(demand.active(), false)
  demand.update({ pageId: '00000000-0000-4000-8000-000000000001', generation: 4, active: true })
  now = 90 * 1000
  assert.equal(demand.active(), false)
  demand.dispose()
})
