import test from 'node:test'
import assert from 'node:assert/strict'
import { createWatchlistService } from '../src/service.mjs'
import { openState } from '../src/state.mjs'
import { makeSecurity } from '../src/market-model.mjs'
import { memoryStorage, operation } from './helpers.mjs'
test('S08 第101只自选明确拒绝且不改已有列表', async () => {
  const state = await openState(memoryStorage()), securities = Array.from({ length: 101 }, (_, i) => makeSecurity('XSHG', String(600000 + i), `证券${i}`))
  const service = createWatchlistService(state, id => securities.find(s => s.id === id))
  for (let i = 0; i < 100; i++) await service.execute({ ...operation(i + 1, i), action: 'add', payload: { securityId: securities[i].id } })
  await assert.rejects(service.execute({ ...operation(101, 100), action: 'add', payload: { securityId: securities[100].id } }), e => e.code === 'LIMIT_REACHED')
  assert.equal(state.get().watchlist.order.length, 100); assert.equal(state.get().revision, 100)
  await state.close()
})
test('S01/S05/S09 添加、移动和撤销使用当前序列不覆盖别页操作', async () => {
  const state = await openState(memoryStorage()), securities = ['600001','600002','600003'].map(code => makeSecurity('XSHG', code, code))
  const service = createWatchlistService(state, id => securities.find(s => s.id === id), () => 1000)
  let n = 0
  const exec = (action, payload) => service.execute({ ...operation(++n, state.get().revision), action, payload })
  for (const s of securities) await exec('add', { securityId: s.id })
  assert.deepEqual(state.get().watchlist.order, securities.map(s => s.id))
  await exec('remove', { securityId: securities[1].id })
  const removeOperationId = operation(n).operationId
  await exec('move', { securityId: securities[2].id, beforeId: securities[0].id })
  await exec('restore', { removeOperationId })
  assert.deepEqual(state.get().watchlist.order, [securities[2].id, securities[0].id, securities[1].id])
})
