// 源形态锁:数据刷新只走 /api/rsww/changes 长轮询总线,禁回 setInterval 短轮询;
// 例外:会话页签判定 judge 的兜底 interval(缓存短路零网络)合法保留
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

test('client.js 数据刷新走变更长轮询,禁数据轮询 interval', () => {
  const source = readFileSync(join(root, 'src', 'client.js'), 'utf8')
  assert.match(source, /API \+ 'changes'/, '缺 changes 长轮询端点引用')
  assert.match(source, /subscribeChanges/, '缺变更总线订阅入口')
  assert.doesNotMatch(source, /setInterval\((reload|load)\b/, '禁止数据轮询 interval(FlowView/RunCard)')
  assert.doesNotMatch(source, /LIVE_REFRESH_MS/, '运行中短轮询常量已废除,禁止回归')
  const intervalUses = [...source.matchAll(/setInterval\((\w+)/g)].map((m) => m[1])
  assert.deepEqual(intervalUses, ['judge'], '唯一合法 interval 为页签判定 judge 兜底')
})

test('client.js 长轮询须带防风暴限频:未挂起响应按忙时间隙续连,广播合并节流', () => {
  const source = readFileSync(join(root, 'src', 'client.js'), 'utf8')
  assert.match(source, /CHANGES_BUSY_GAP_MS/, '缺忙时间隙常量(变更密集时 changes 紧密重连风暴)')
  assert.match(source, /CHANGES_HUNG_MIN_MS/, '缺挂起判定阈值(区分真挂起与立即返回)')
  assert.match(source, /hung \? 0 : CHANGES_BUSY_GAP_MS/, '续连须按挂起与否区分立即续连与限频')
  assert.match(source, /CHANGES_NOTIFY_MERGE_MS/, '缺广播合并节流(高频写入放大订阅者全量重拉)')
  assert.doesNotMatch(source, /changesSleep\(0,/, '禁止无条件立即续连(变更密集时退化为紧密循环)')
})
