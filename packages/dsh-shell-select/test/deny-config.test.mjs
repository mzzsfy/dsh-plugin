// deny 顶层字段:schema 往返与 updateConfig 落盘回读。
// BDD 场景见 docs/progress/feat-shell-select-deny.md 场景 7。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { Config, defaultConfig } from '../src/config.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const executorSource = readFileSync(join(here, '..', 'src', 'executor.mjs'), 'utf8')

test('schema 默认:deny 空数组,旧配置反序列化补默认', () => {
  const config = defaultConfig()
  assert.deepEqual(config.deny, [])
})

test('schema 往返:deny 保留;allow 无消费者(deny 绝对,无豁免语义)', () => {
  const config = Config({ deny: ['format '], allow: ['git .*'] })
  assert.deepEqual(config.deny, ['format '])
  // schemastery 透传未知键,僵尸键靠"无读取方"守卫:matchDeny/toSection 均只触 deny
  const denylistSource = readFileSync(join(here, '..', 'src', 'denylist.mjs'), 'utf8')
  const clientSource = readFileSync(join(here, '..', 'src', 'client.js'), 'utf8')
  assert.doesNotMatch(denylistSource, /allow/)
  assert.doesNotMatch(clientSource, /allowText|section\.allow/)
  assert.doesNotMatch(executorSource, /current\.allow|patch\.allow/)
})

test('updateConfig 携带 deny(wholesale replace 防静默重置,同 login 教训)', () => {
  assert.match(executorSource, /deny: Array\.isArray\(patch\.deny\) \? patch\.deny : current\.deny/)
  assert.doesNotMatch(executorSource, /patch\.allow/)
})
