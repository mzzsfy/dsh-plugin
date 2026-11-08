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
test('MARKS01 价格标记整组替换与校验', async () => {
  const state = await openState(memoryStorage()), s = makeSecurity('XSHG', '600001', '甲')
  const service = createWatchlistService(state, id => s)
  let n = 0
  const exec = (action, payload) => service.execute({ ...operation(++n, state.get().revision), action, payload })
  await exec('add', { securityId: s.id })
  const mark = (price, kind = 'cost', id = 'm1') => ({ id, price, kind })
  await exec('marks', { securityId: s.id, marks: [mark(1450.5)] })
  assert.deepEqual(state.get().watchlist.items[s.id].marks, [mark(1450.5)])
  // 多个标记共存: 成本与卖价各自独立, 都在同一个数组里
  await exec('marks', { securityId: s.id, marks: [mark(1450.5), mark(1600, 'target', 'm2')] })
  assert.equal(state.get().watchlist.items[s.id].marks.length, 2)
  await exec('marks', { securityId: s.id, marks: [] })
  assert.deepEqual(state.get().watchlist.items[s.id].marks, [])
  // 价格必须为正; 同类型不允许重复价; id 必须唯一
  await assert.rejects(exec('marks', { securityId: s.id, marks: [mark(-1)] }), e => e.code === 'INVALID_OPERATION')
  await assert.rejects(exec('marks', { securityId: s.id, marks: [mark(0)] }), e => e.code === 'INVALID_OPERATION')
  await assert.rejects(exec('marks', { securityId: s.id, marks: [mark(100, 'cost', 'a'), mark(100, 'cost', 'b')] }), e => e.code === 'INVALID_OPERATION')
  await assert.rejects(exec('marks', { securityId: s.id, marks: [mark(100, 'cost', 'a'), mark(200, 'target', 'a')] }), e => e.code === 'INVALID_OPERATION')
  // 同价格不同类型是合法的
  await exec('marks', { securityId: s.id, marks: [mark(100, 'cost', 'a'), mark(100, 'target', 'b')] })
  assert.equal(state.get().watchlist.items[s.id].marks.length, 2)
})
test('GROUP01 组分配重命名解散与校验', async () => {
  const state = await openState(memoryStorage()), securities = ['600001', '600002'].map(code => makeSecurity('XSHG', code, code))
  const service = createWatchlistService(state, id => securities.find(s => s.id === id))
  let n = 0
  const exec = (action, payload) => service.execute({ ...operation(++n, state.get().revision), action, payload })
  for (const s of securities) await exec('add', { securityId: s.id })
  await exec('group', { securityIds: [securities[0].id, securities[1].id], group: '白酒' })
  assert.equal(state.get().watchlist.items[securities[0].id].group, '白酒')
  await exec('groupRename', { from: '白酒', to: '消费' })
  assert.equal(state.get().watchlist.items[securities[1].id].group, '消费')
  await exec('groupRemove', { group: '消费' })
  assert.equal(state.get().watchlist.items[securities[1].id].group, '')
  await assert.rejects(exec('group', { securityIds: [securities[0].id], group: '这是一个超过十二个字符的分组名' }), e => e.code === 'INVALID_OPERATION')
  await exec('group', { securityIds: [securities[0].id], group: '' })
  assert.equal(state.get().watchlist.items[securities[0].id].group, '', 'B6: 空串=移出分组')
  await exec('group', { securityIds: [securities[1].id], group: '  ' })
  assert.equal(state.get().watchlist.items[securities[1].id].group, '', 'B6: 纯空白归一为移出')
  await assert.rejects(exec('groupRename', { from: '不存在', to: 'x' }), e => e.code === 'NOT_FOUND')
  await assert.rejects(exec('groupRemove', { group: '不存在' }), e => e.code === 'NOT_FOUND')
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

test('R01 reorder 按提交顺序重排并校验收集合与置顶约束', async () => {
  const state = await openState(memoryStorage())
  const securities = ['600519', '600520', '600521'].map((code, i) => makeSecurity('XSHG', code, `证券${i}`))
  const byId = new Map(securities.map(s => [s.id, s]))
  const service = createWatchlistService(state, id => byId.get(id))
  for (let i = 0; i < securities.length; i++) await service.execute({ ...operation(i + 1, i), action: 'add', payload: { securityId: securities[i].id } })
  const revision = () => state.get().revision
  const [a, b, c] = securities.map(s => s.id)
  await service.execute({ ...operation(10, revision()), action: 'reorder', payload: { order: [c, a, b] } })
  assert.deepEqual(state.get().watchlist.order, [c, a, b], '按提交顺序重排')
  await assert.rejects(service.execute({ ...operation(11, revision()), action: 'reorder', payload: { order: [c, a] } }), e => e.code === 'INVALID_ORDER', '少一项即拒')
  await assert.rejects(service.execute({ ...operation(12, revision()), action: 'reorder', payload: { order: [c, a, a] } }), e => e.code === 'INVALID_ORDER', '重复即拒')
  await assert.rejects(service.execute({ ...operation(13, revision()), action: 'reorder', payload: { order: [c, a, 'XSHG:equity:999999'] } }), e => e.code === 'INVALID_ORDER', '陌生身份即拒')
  // 置顶项必须留在最前段
  await service.execute({ ...operation(14, revision()), action: 'pin', payload: { securityId: a, pinned: true } })
  await assert.rejects(service.execute({ ...operation(15, revision()), action: 'reorder', payload: { order: [c, b, a] } }), e => e.code === 'INVALID_ORDER', '置顶项不得沉底')
  await service.execute({ ...operation(16, revision()), action: 'reorder', payload: { order: [a, c, b] } })
  assert.deepEqual(state.get().watchlist.order, [a, c, b], '置顶段内重排允许')
  await state.close()
})
