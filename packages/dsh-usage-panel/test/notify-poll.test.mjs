// 页内通知长轮询 BDD:client 半区以顺序长轮询消费通知投影——
// 任何时刻至多一条在途请求,失败指数退避,HMR/闭包重建重复装载时
// 新代首挂 abort 旧代长轮询再启新代——旧代不滞留、不叠加、不告警。
// 轮询段运行于 factory 闭包内(IO),守卫以源码契约断言锁定形态。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const PKG_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const source = readFileSync(join(PKG_ROOT, 'src', 'client.js'), 'utf8')

test('代际令牌承载 AbortController:新代启动前中止旧代长轮询', () => {
  assert.match(source, /window\[KEY_POLL_TOKEN\] instanceof AbortController/, '缺少旧代 AbortController 判定')
  assert.match(source, /window\[KEY_POLL_TOKEN\]\.abort\(\)/, '缺少旧代长轮询中止')
  assert.match(source, /window\[KEY_POLL_TOKEN\] = notifyController/, '控制器未交接给令牌')
})

test('消费形态为顺序长轮询:setInterval 短轮询不得回归', () => {
  assert.ok(!source.includes('setInterval'), '残留 interval 短轮询形态')
  assert.match(source, /AbortSignal\.timeout\(NOTIFY_REQUEST_TIMEOUT_MS\)/, '长轮询请求缺少超时上限')
  assert.match(source, /\?cursor=' \+ notifyCursor/, '长轮询缺少续传游标')
})

test('失败退避与游标防呆:异常响应不退化成紧密首拉循环', () => {
  assert.match(source, /backoffMs = NOTIFY_RETRY_MIN_MS/, '成功后未重置退避基数')
  assert.match(source, /backoffMs = Math\.min\(backoffMs \* 2, NOTIFY_RETRY_MAX_MS\)/, '缺少指数退避')
  assert.match(source, /typeof payload\.version !== 'number'\) return false/, '版本缺失未按失败退避')
})
