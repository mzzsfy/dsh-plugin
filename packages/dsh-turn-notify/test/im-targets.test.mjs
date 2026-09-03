// IM 投递目标列表操作:多 bot 绑定、取消注册、勾选幂等。
// core.mjs 为权威实现;client.js LOGIC 段镜像,parity.test.mjs 保证不漂移。
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  imTargetKeyOf,
  toggleImTargetList,
  removeImTargetFromList,
  unregisterImBotList,
  imBoundBotIds,
  normalizeImTargets,
} from '../src/core.mjs'

const A = { botId: 'wx_aaa', targetId: 'tgt_1' }
const B = { botId: 'wx_aaa', targetId: 'tgt_2' }
const C = { botId: 'wx_bbb', targetId: 'tgt_1' }

test('imTargetKeyOf:botId+targetId 拼接,跨 bot 同 targetId 键不同', () => {
  assert.equal(imTargetKeyOf(A), 'wx_aaa/tgt_1')
  assert.notEqual(imTargetKeyOf(A), imTargetKeyOf(C))
})

test('toggleImTargetList:勾选追加,重复勾选幂等(单份,位置在尾)', () => {
  assert.deepEqual(toggleImTargetList([], 'wx_aaa', 'tgt_1', true), [A])
  const once = toggleImTargetList([], 'wx_aaa', 'tgt_1', true)
  assert.deepEqual(toggleImTargetList(once, 'wx_aaa', 'tgt_1', true), [A])
  const two = toggleImTargetList(once, 'wx_bbb', 'tgt_1', true)
  assert.deepEqual(two, [A, C])
})

test('toggleImTargetList:取消勾选只移除目标项,其余保序', () => {
  const list = [A, B, C]
  assert.deepEqual(toggleImTargetList(list, 'wx_aaa', 'tgt_2', false), [A, C])
  assert.deepEqual(toggleImTargetList(list, 'wx_nnn', 'tgt_9', false), list)
})

test('toggleImTargetList:入参列表不被修改(纯函数)', () => {
  const list = [A]
  toggleImTargetList(list, 'wx_bbb', 'tgt_1', true)
  toggleImTargetList(list, 'wx_aaa', 'tgt_1', false)
  assert.deepEqual(list, [A])
})

test('removeImTargetFromList:按键移除单项,其余保序', () => {
  const list = [A, B, C]
  assert.deepEqual(removeImTargetFromList(list, 'wx_aaa', 'tgt_2'), [A, C])
  assert.deepEqual(removeImTargetFromList(list, 'wx_nnn', 'tgt_9'), list)
})

test('unregisterImBotList:移除该 bot 全部目标,其他 bot 保留', () => {
  const list = [A, B, C]
  assert.deepEqual(unregisterImBotList(list, 'wx_aaa'), [C])
  assert.deepEqual(unregisterImBotList(list, 'wx_bbb'), [A, B])
  assert.deepEqual(unregisterImBotList(list, 'wx_nnn'), list)
})

test('unregisterImBotList:唯一 bot 清空后列表为空(取消注册即全清)', () => {
  assert.deepEqual(unregisterImBotList([A, B], 'wx_aaa'), [])
})

test('imBoundBotIds:首次绑定顺序去重', () => {
  assert.deepEqual(imBoundBotIds([A, B, C]), ['wx_aaa', 'wx_bbb'])
  assert.deepEqual(imBoundBotIds([C, A, B]), ['wx_bbb', 'wx_aaa'])
  assert.deepEqual(imBoundBotIds([]), [])
})

test('imBoundBotIds:与取消注册组合,chip 随最后一项消失', () => {
  const list = [A, B, C]
  assert.deepEqual(imBoundBotIds(unregisterImBotList(list, 'wx_aaa')), ['wx_bbb'])
  assert.deepEqual(imBoundBotIds(unregisterImBotList(list, 'wx_bbb')), ['wx_aaa'])
})

test('normalizeImTargets:跨 bot 同 targetId 均保留(合法,dsh-im 唯一性仅限单 bot)', () => {
  assert.deepEqual(normalizeImTargets([A, C]), [A, C])
})
