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
// Given 某市场已有自选且市场分组被解散 When 再添加同市场证券 Then 不再自动归组
test('MKT01 解散市场分组后同市场新增不再自动归组', async () => {
  const state = await openState(memoryStorage())
  const cn = makeSecurity('XSHG', '600519', '贵州茅台'), other = makeSecurity('XSHG', '600000', '浦发银行'), hk = makeSecurity('XHKG', '00700', '腾讯控股')
  const byId = new Map([cn, other, hk].map(s => [s.id, s]))
  const service = createWatchlistService(state, id => byId.get(id))
  let n = 0
  const exec = (action, payload) => service.execute({ ...operation(++n, state.get().revision), action, payload })
  await exec('add', { securityId: cn.id })
  assert.deepEqual(state.get().watchlist.items[cn.id].tags, ['沪A'])
  // 解散后该市场仍有自选, 说明用户不想按市场看: 新票不进市场组
  await exec('tagRemove', { tag: '沪A' })
  await exec('add', { securityId: other.id })
  assert.deepEqual(state.get().watchlist.items[other.id].tags, [], '解散过的市场不再自动归组')
  // 其余市场不受影响: 港股首次添加仍按市场归组
  await exec('add', { securityId: hk.id })
  assert.deepEqual(state.get().watchlist.items[hk.id].tags, ['港股'])
  await state.close()
})
// Given 市场分组已解散 When 手动给同市场证券加回市场标签 Then 后续新增恢复自动归组
test('MKT02 手动加回市场标签恢复自动归组', async () => {
  const state = await openState(memoryStorage())
  const securities = ['600519', '600000', '600036'].map(code => makeSecurity('XSHG', code, code))
  const service = createWatchlistService(state, id => securities.find(s => s.id === id))
  let n = 0
  const exec = (action, payload) => service.execute({ ...operation(++n, state.get().revision), action, payload })
  await exec('add', { securityId: securities[0].id })
  await exec('tagRemove', { tag: '沪A' })
  await exec('add', { securityId: securities[1].id })
  assert.deepEqual(state.get().watchlist.items[securities[1].id].tags, [])
  await exec('tags', { securityId: securities[1].id, tags: ['沪A'] })
  await exec('add', { securityId: securities[2].id })
  assert.deepEqual(state.get().watchlist.items[securities[2].id].tags, ['沪A'], '市场内重新出现市场标签即恢复默认归组')
  await state.close()
})
// Given 市场分组仍在只被个别票移出 When 再添加同市场证券 Then 仍按市场归组
test('MKT03 个别票移出市场分组不关闭自动归组', async () => {
  const state = await openState(memoryStorage())
  const securities = ['600519', '600000', '600036'].map(code => makeSecurity('XSHG', code, code))
  const service = createWatchlistService(state, id => securities.find(s => s.id === id))
  let n = 0
  const exec = (action, payload) => service.execute({ ...operation(++n, state.get().revision), action, payload })
  for (const security of securities.slice(0, 2)) await exec('add', { securityId: security.id })
  // 只把一只票移出市场组, 分组仍存在: 不能据此关掉整个市场的自动归组
  await exec('tags', { securityId: securities[1].id, tags: [] })
  await exec('add', { securityId: securities[2].id })
  assert.deepEqual(state.get().watchlist.items[securities[2].id].tags, ['沪A'])
  await state.close()
})
// Given 市场分组被解散且该市场已无自选 When 重新添加该市场证券 Then 按默认归组
test('MKT04 市场内已无自选时重新按市场归组', async () => {
  const state = await openState(memoryStorage())
  const first = makeSecurity('XSHG', '600519', '贵州茅台'), again = makeSecurity('XSHG', '600000', '浦发银行')
  const byId = new Map([[first.id, first], [again.id, again]])
  const service = createWatchlistService(state, id => byId.get(id))
  let n = 0
  const exec = (action, payload) => service.execute({ ...operation(++n, state.get().revision), action, payload })
  await exec('add', { securityId: first.id })
  await exec('tagRemove', { tag: '沪A' })
  await exec('remove', { securityId: first.id })
  await exec('add', { securityId: again.id })
  assert.deepEqual(state.get().watchlist.items[again.id].tags, ['沪A'], '该市场没有自选时回到默认归组')
  await state.close()
})
// Given 市场内只剩自定义标签 When 再添加同市场证券 Then 不塞回市场组
test('MKT05 市场内票不带市场标签时按解散处理', async () => {
  const state = await openState(memoryStorage())
  const securities = ['600519', '600000'].map(code => makeSecurity('XSHG', code, code))
  const service = createWatchlistService(state, id => securities.find(s => s.id === id))
  let n = 0
  const exec = (action, payload) => service.execute({ ...operation(++n, state.get().revision), action, payload })
  await exec('add', { securityId: securities[0].id })
  // 判定看「是否带市场标签」而不是「是否还有任何标签」: 只剩自定义标签时仍是解散态
  await exec('tags', { securityId: securities[0].id, tags: ['核心'] })
  await exec('add', { securityId: securities[1].id })
  assert.deepEqual(state.get().watchlist.items[securities[1].id].tags, [])
  await state.close()
})
// Given 另一个市场仍有成员 When 解散某市场后连续添加该市场证券 Then 仍按市场归组
test('MKT06 解散一个市场不影响其他市场归组', async () => {
  const state = await openState(memoryStorage())
  const sh = makeSecurity('XSHG', '600519', '贵州茅台'), sz = ['000001', '000002'].map(code => makeSecurity('XSHE', code, code))
  const byId = new Map([sh, ...sz].map(s => [s.id, s]))
  const service = createWatchlistService(state, id => byId.get(id))
  let n = 0
  const exec = (action, payload) => service.execute({ ...operation(++n, state.get().revision), action, payload })
  await exec('add', { securityId: sh.id })
  await exec('add', { securityId: sz[0].id })
  assert.deepEqual(state.get().watchlist.items[sz[0].id].tags, ['深A'])
  await exec('tagRemove', { tag: '沪A' })
  await exec('add', { securityId: sz[1].id })
  assert.deepEqual(state.get().watchlist.items[sz[0].id].tags, ['深A'], '已有成员不受影响')
  assert.deepEqual(state.get().watchlist.items[sz[1].id].tags, ['深A'], '新成员仍按市场归组')
  await state.close()
})
// Given 删除带市场标签的票后解散该市场 When 8 秒内撤销删除 Then 按删除时标签恢复
test('MKT07 撤销删除按删除时标签原样恢复', async () => {
  const state = await openState(memoryStorage()), securities = ['600519', '600000'].map(code => makeSecurity('XSHG', code, code))
  const service = createWatchlistService(state, id => securities.find(s => s.id === id))
  let n = 0
  const exec = (action, payload) => service.execute({ ...operation(++n, state.get().revision), action, payload })
  for (const security of securities) await exec('add', { securityId: security.id })
  await exec('remove', { securityId: securities[0].id })
  const removeOperationId = operation(n).operationId
  await exec('tagRemove', { tag: '沪A' })
  await exec('restore', { removeOperationId })
  assert.deepEqual(state.get().watchlist.items[securities[0].id].tags, ['沪A'], '撤销是原样恢复, 不按当前市场状态重算')
  assert.deepEqual(state.get().watchlist.items[securities[1].id].tags, [])
  await state.close()
})
// Given 已在自选的证券 When 重复添加 Then 标签与版本不变
test('MKT08 重复添加已在自选的证券不改变标签与版本', async () => {
  const state = await openState(memoryStorage()), security = makeSecurity('XSHG', '600519', '贵州茅台')
  const service = createWatchlistService(state, () => security)
  let n = 0
  const exec = (action, payload) => service.execute({ ...operation(++n, state.get().revision), action, payload })
  await exec('add', { securityId: security.id })
  await exec('tagRemove', { tag: '沪A' })
  const revision = state.get().revision
  await exec('add', { securityId: security.id })
  assert.deepEqual(state.get().watchlist.items[security.id].tags, [], '重复添加不改写解散后的标签')
  assert.equal(state.get().revision, revision, '重复添加不产生新版本')
  await state.close()
})
// Given 候选已过期 When 添加 Then 拒绝且自选与版本不变
test('MKT09 候选过期拒绝添加且不改数据', async () => {
  const state = await openState(memoryStorage())
  const id = 'XSHG:equity:600519'
  const service = createWatchlistService(state, value => value === id ? null : { id: value })
  let n = 0
  const exec = (action, payload) => service.execute({ ...operation(++n, state.get().revision), action, payload })
  const before = state.get().revision
  await assert.rejects(exec('add', { securityId: id }), e => e.code === 'CANDIDATE_EXPIRED')
  assert.deepEqual(state.get().watchlist.order, [])
  assert.equal(state.get().revision, before)
  await state.close()
})
// Given 市场标签被改名 When 再添加同市场证券 Then 不归组
test('MKT10 市场标签改名后新增不归组', async () => {
  const state = await openState(memoryStorage())
  const securities = ['600519', '600000'].map(code => makeSecurity('XSHG', code, code))
  const service = createWatchlistService(state, id => securities.find(s => s.id === id))
  let n = 0
  const exec = (action, payload) => service.execute({ ...operation(++n, state.get().revision), action, payload })
  await exec('add', { securityId: securities[0].id })
  await exec('tagRename', { from: '沪A', to: 'SH' })
  await exec('add', { securityId: securities[1].id })
  assert.deepEqual(state.get().watchlist.items[securities[1].id].tags, [], '该市场已无票持原名市场标签, 新票不归组')
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
