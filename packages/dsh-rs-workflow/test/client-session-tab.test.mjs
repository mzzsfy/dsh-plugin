// FIND-020-5 回归(源形态锁):会话页签判定的当前会话 id 不得读 sessions.list snapshot
// 的 current 字段(该 snapshot 形态为 {ids,byId,...} 无 current,恒 undefined → 页签永不注入);
// 唯一合法来源 = session 作用域哨兵插槽 standardProps 下发的 sessionId。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

test('client.js 页签判定走哨兵 sessionId,禁读 list snapshot current', () => {
  const source = readFileSync(join(root, 'src', 'client.js'), 'utf8')
  assert.doesNotMatch(source, /getSnapshot\?\.\(\)\.current/, '禁止 sessions.list.getSnapshot().current(字段不存在)')
  assert.match(source, /rsww-session-sentinel/, '缺 sessionId 哨兵插槽')
  assert.match(source, /conversation\.input\.overlay/, '哨兵未挂 session 作用域插槽')
})
