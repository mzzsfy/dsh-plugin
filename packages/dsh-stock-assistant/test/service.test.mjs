import test from 'node:test'
import assert from 'node:assert/strict'
import { createWatchlistService } from '../src/service.mjs'
import { openState } from '../src/state.mjs'
import { makeSecurity } from '../src/market-model.mjs'
import { MAX_TAGS } from '../src/schemas.mjs'
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
// Given 全新自选 When 添加不同市场证券 Then 自动带上该市场的分组标签
test('TAG01 添加自选按市场自动分组', async () => {
  const state = await openState(memoryStorage())
  const cn = makeSecurity('XSHG', '600519', '贵州茅台'), us = makeSecurity('XNAS', 'AAPL', '苹果'), hk = makeSecurity('XHKG', '00700', '腾讯控股')
  const byId = new Map([cn, us, hk].map(s => [s.id, s]))
  const service = createWatchlistService(state, id => byId.get(id))
  let n = 0
  const exec = (action, payload) => service.execute({ ...operation(++n, state.get().revision), action, payload })
  for (const s of [cn, us, hk]) await exec('add', { securityId: s.id })
  const items = state.get().watchlist.items
  assert.deepEqual(items[cn.id].tags, ['沪A'])
  assert.deepEqual(items[us.id].tags, ['纳斯达克'])
  assert.deepEqual(items[hk.id].tags, ['港股'])
  await state.close()
})
// Given 一只票已有市场标签 When 整组替换标签 Then 多标签并存, 重复与首尾空白归一
test('TAG02 多标签整组替换与归一', async () => {
  const state = await openState(memoryStorage()), s = makeSecurity('XSHG', '600001', '甲')
  const service = createWatchlistService(state, () => s)
  let n = 0
  const exec = (action, payload) => service.execute({ ...operation(++n, state.get().revision), action, payload })
  await exec('add', { securityId: s.id })
  await exec('tags', { securityId: s.id, tags: ['沪A', '核心', '持股'] })
  assert.deepEqual(state.get().watchlist.items[s.id].tags, ['沪A', '核心', '持股'])
  await exec('tags', { securityId: s.id, tags: [' 核心 ', '核心', ''] })
  assert.deepEqual(state.get().watchlist.items[s.id].tags, ['核心'], 'trim 去重去空')
  await exec('tags', { securityId: s.id, tags: [] })
  assert.deepEqual(state.get().watchlist.items[s.id].tags, [], '空数组=移出全部分组')
  await state.close()
})
// Given 已有上限个标签 When 再加第 9 个 / 超长 / 控制字符 Then 拒绝且数据不变
test('TAG03 标签数量与命名边界', async () => {
  const state = await openState(memoryStorage()), s = makeSecurity('XSHG', '600001', '甲')
  const service = createWatchlistService(state, () => s)
  let n = 0
  const exec = (action, payload) => service.execute({ ...operation(++n, state.get().revision), action, payload })
  await exec('add', { securityId: s.id })
  const full = Array.from({ length: MAX_TAGS }, (_, i) => `组${i}`)
  await exec('tags', { securityId: s.id, tags: full })
  await assert.rejects(exec('tags', { securityId: s.id, tags: [...full, '再一个'] }), e => e.code === 'INVALID_OPERATION')
  await assert.rejects(exec('tags', { securityId: s.id, tags: ['这是一个超过十二个字符的标签名'] }), e => e.code === 'INVALID_OPERATION')
  await assert.rejects(exec('tags', { securityId: s.id, tags: ['沪\u0000A'] }), e => e.code === 'INVALID_OPERATION')
  assert.deepEqual(state.get().watchlist.items[s.id].tags, full, '拒绝后原数据不变')
  // 上限判断在 trim/去重之后: 9 条里有重复时实际只有 8 个唯一标签, 应当成功
  const unique = Array.from({ length: MAX_TAGS }, (_, i) => `唯一${i}`)
  await exec('tags', { securityId: s.id, tags: [...unique, unique[0]] })
  assert.deepEqual(state.get().watchlist.items[s.id].tags, unique, '先去重再判上限')
  // 证券不在自选: 整组替换明确 404, 不静默成功
  await assert.rejects(exec('tags', { securityId: 'XSHG:equity:999999', tags: [] }), e => e.code === 'NOT_FOUND')
  await state.close()
})
// Given 两只票共享与独有标签 When 把独有标签改成已有标签 Then 合并去重, 其余票不受影响
test('TAG04 重命名合并去重', async () => {
  const state = await openState(memoryStorage()), securities = ['600001', '600002'].map(code => makeSecurity('XSHG', code, code))
  const service = createWatchlistService(state, id => securities.find(s => s.id === id))
  let n = 0
  const exec = (action, payload) => service.execute({ ...operation(++n, state.get().revision), action, payload })
  for (const s of securities) await exec('add', { securityId: s.id })
  await exec('tags', { securityId: securities[0].id, tags: ['沪A', '核心'] })
  await exec('tagRename', { from: '核心', to: '沪A' })
  assert.deepEqual(state.get().watchlist.items[securities[0].id].tags, ['沪A'], '合并后不重复')
  assert.deepEqual(state.get().watchlist.items[securities[1].id].tags, ['沪A'])
  await assert.rejects(exec('tagRename', { from: '不存在', to: 'x' }), e => e.code === 'NOT_FOUND')
  await assert.rejects(exec('tagRename', { from: '沪A', to: '这是一个超过十二个字符的标签名' }), e => e.code === 'INVALID_OPERATION')
  await state.close()
})
// Given 某标签分布在多只票上 When 解散 Then 每只都移除该标签, 不存在的标签明确 404
test('TAG05 解散标签从所有票移除', async () => {
  const state = await openState(memoryStorage()), securities = ['600001', '600002'].map(code => makeSecurity('XSHG', code, code))
  const service = createWatchlistService(state, id => securities.find(s => s.id === id))
  let n = 0
  const exec = (action, payload) => service.execute({ ...operation(++n, state.get().revision), action, payload })
  for (const s of securities) await exec('add', { securityId: s.id })
  await exec('tags', { securityId: securities[0].id, tags: ['沪A', '核心'] })
  await exec('tagRemove', { tag: '核心' })
  assert.deepEqual(state.get().watchlist.items[securities[0].id].tags, ['沪A'])
  assert.deepEqual(state.get().watchlist.items[securities[1].id].tags, ['沪A'])
  await assert.rejects(exec('tagRemove', { tag: '不存在' }), e => e.code === 'NOT_FOUND')
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
