// deny/allow 顶层字段:schema 往返与 updateConfig 落盘回读。
// BDD 场景见 docs/progress/feat-shell-select-deny.md 场景 7。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { Config, defaultConfig } from '../src/config.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const executorSource = readFileSync(join(here, '..', 'src', 'executor.mjs'), 'utf8')

test('schema 默认:deny/allow 空数组,旧配置反序列化补默认', () => {
  const config = defaultConfig()
  assert.deepEqual(config.deny, [])
  assert.deepEqual(config.allow, [])
})

test('schema 往返:含 deny/allow 的配置解析后保留', () => {
  const config = Config({ deny: ['format '], allow: ['git .*'] })
  assert.deepEqual(config.deny, ['format '])
  assert.deepEqual(config.allow, ['git .*'])
})

test('updateConfig 携带 deny/allow(wholesale replace 防静默重置,同 login 教训)', () => {
  assert.match(executorSource, /deny: Array\.isArray\(patch\.deny\) \? patch\.deny : current\.deny/)
  assert.match(executorSource, /allow: Array\.isArray\(patch\.allow\) \? patch\.allow : current\.allow/)
})
