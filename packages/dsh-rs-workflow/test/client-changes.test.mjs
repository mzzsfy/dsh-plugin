// 源形态锁:数据刷新只走推送总线订阅(dsh-common-tools 的 bus 订阅),禁回长轮询与
// setInterval 短轮询;
// 例外:会话页签判定 judge 的兜底 interval(缓存短路零网络)合法保留
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

test('client.js 数据刷新走推送总线订阅,禁长轮询与数据轮询 interval', () => {
  const source = readFileSync(join(root, 'src', 'client.js'), 'utf8')
  assert.match(source, /bus\.subscribe\(notify, \{ onReset: notify \}\)/, '缺推送总线订阅')
  assert.match(source, /subscribeChanges/, '缺变更订阅入口')
  assert.ok(!source.includes("'changes'"), '长轮询端点引用已废除,禁止回归')
  assert.ok(!source.includes('?cursor='), '长轮询续传游标已废除,禁止回归')
  assert.doesNotMatch(source, /setInterval\((reload|load)\b/, '禁止数据轮询 interval(FlowView/RunCard)')
  assert.doesNotMatch(source, /LIVE_REFRESH_MS/, '运行中短轮询常量已废除,禁止回归')
  const intervalUses = [...source.matchAll(/setInterval\((\w+)/g)].map((m) => m[1])
  assert.deepEqual(intervalUses, ['judge'], '唯一合法 interval 为页签判定 judge 兜底')
})

test('client.js 广播合并节流保留:高频发布放大订阅者全量重拉须合并', () => {
  const source = readFileSync(join(root, 'src', 'client.js'), 'utf8')
  assert.match(source, /CHANGES_NOTIFY_MERGE_MS/, '缺广播合并节流(高频写入放大订阅者全量重拉)')
  assert.match(source, /onReset: notify/, '缺连接建立全量对账广播')
  assert.match(source, /bus\.subscribe\(notify,/, '缺变更事件广播')
})

test('client.js 页签判定重查走变更总线,禁随会话列表 emit 无限频重查', () => {
  const source = readFileSync(join(root, 'src', 'client.js'), 'utf8')
  assert.doesNotMatch(source, /list\.subscribe\(\(\) => \{ cache/, '会话列表 emit 高频且无限频,重置 cache 即请求风暴源')
  assert.match(source, /subscribeChanges\(rejudge\)/, '页签判定重查须走变更总线(合并节流兜底)')
  assert.match(source, /cache\.fetched && cache\.isRs/, '页签已在列时须短路重查(无信息增益)')
})
