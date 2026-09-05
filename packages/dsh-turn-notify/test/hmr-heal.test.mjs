// HMR 代际自愈 BDD:client 半区经 HMR/闭包重建重复装载时,新代首挂先释放
// 旧代资源(轮询 interval / 高亮 observer / 高亮 listener)再挂新代——
// 旧代不滞留、不叠加、不跑旧闭包状态。资源段运行于 factory 闭包内(IO),
// 守卫以源码契约断言锁定形态。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const PKG_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const source = readFileSync(join(PKG_ROOT, 'src', 'client.js'), 'utf8')

test('轮询代际令牌承载 interval 句柄:新代启动前清理旧代', () => {
  assert.match(source, /clearInterval\(window\[KEY_POLL_TOKEN\]\)/, '缺少旧代 interval 清理')
  assert.match(source, /window\[KEY_POLL_TOKEN\] = timer/, 'interval 句柄未交接给令牌')
  assert.ok(!source.includes('window[KEY_POLL_TOKEN] = true'), '残留布尔窗棂形态')
})

test('高亮 observer 代际令牌承载 observer:新代先断开旧代', () => {
  assert.match(source, /window\[KEY_HL_OBSERVER\]\.disconnect\(\)/, '缺少旧代 observer 断开')
  assert.match(source, /window\[KEY_HL_OBSERVER\] = observer/, 'observer 未交接给令牌')
  assert.ok(!source.includes('window[KEY_HL_OBSERVER] = true'), '残留布尔窗棂形态')
})

test('高亮 listener 代际令牌承载函数引用:新代先移除旧代', () => {
  assert.match(source, /removeEventListener\('click', window\[KEY_HL_LISTENER\], true\)/, '缺少旧代 listener 移除')
  assert.match(source, /window\[KEY_HL_LISTENER\] = listener/, 'listener 未交接给令牌')
  assert.ok(!source.includes('window[KEY_HL_LISTENER] = true'), '残留布尔窗棂形态')
})
