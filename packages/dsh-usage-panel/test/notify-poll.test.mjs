// 页内通知轮询 HMR 幂等自愈 BDD:client 半区经 HMR/闭包重建重复装载时,
// 新代首挂清旧代 interval 再启新代——旧代不滞留、不叠加、不告警。
// 轮询段运行于 factory 闭包内(IO),守卫以源码契约断言锁定形态。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const PKG_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const source = readFileSync(join(PKG_ROOT, 'src', 'client.js'), 'utf8')

test('代际令牌承载 interval 句柄:新代启动前清理旧代', () => {
  assert.match(source, /clearInterval\(window\[KEY_POLL_TOKEN\]\)/, '缺少旧代 interval 清理')
  assert.match(source, /window\[KEY_POLL_TOKEN\] = setInterval\(/, 'setInterval 句柄未交接给令牌')
})

test('旧布尔窗棂清偿:不再有跳过启动告警分支', () => {
  assert.ok(!source.includes('通知轮询已存在'), '残留跳过启动告警分支')
})
