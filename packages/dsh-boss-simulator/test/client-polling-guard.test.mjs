// 工作台刷新守卫:空闲期不得有周期 HTTP 快照,失效通知走公共总线,兜底才有退避轮询
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const source = readFileSync(join(root, 'src/client.js'), 'utf8')

test('Given 工作台看板 When 空闲 Then 无固定周期快照循环', () => {
  assert.doesNotMatch(source, /REFRESH_MS/, '固定刷新常量应已移除')
  assert.doesNotMatch(source, /setInterval\(/, '不得保留周期定时器')
  assert.doesNotMatch(source, /setTimeout\([^)]*,\s*3\s*\*\s*1000/)
})

test('Given 公共总线 When 订阅失效通知 Then 首连 onReset 全量对账且变更单飞刷新', () => {
  assert.match(source, /const tools = require\('@mzzsfy\/dsh-common-tools\/client'\)/)
  assert.match(source, /tools\.setupCommonTools\(ctx\)/)
  assert.match(source, /tools\.createSnapshotRefresh\(\(\) => refreshRef\.current\(\)\)/)
  assert.match(source, /bus\.subscribe\(\(\) => snapshot\.refresh\(\), \{[\s\S]{0,200}onReset:/)
  assert.match(source, /onReset: \(\) => \{ ready = true;[\s\S]{0,60}clearTimeout\(timer\);/)
  // 订阅不得依赖 refresh:否则搜索每键入一次都会重连并多打一轮快照
  assert.match(source, /\}, \[visible, bus\]\)/)
})

test('Given 订阅未就绪 When 兜底拉取 Then 仅指数退避且订阅恢复后停止', () => {
  assert.match(source, /const RETRY_MS = \[1, 2, 4, 8, 16, 30\]\.map/)
  assert.match(source, /if \(disposed \|\| ready\) return/)
  assert.match(source, /RETRY_MS\[Math\.min\(attempt, RETRY_MS\.length - 1\)\]/)
  assert.match(source, /unsubscribe\?\.\(\)/)
})
