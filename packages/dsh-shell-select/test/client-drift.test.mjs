// KINDS 漂移守卫:client.js 工具形态清单与 host config.mjs 同源(竞品
// bash-terminal-ts 的 drift 守卫同构:加形态忘改文案即测试失败)。
// BDD 场景见 docs/feat-shell-select-optim/plan.md S14。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { KINDS } from '../src/config.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const clientSource = readFileSync(join(here, '..', 'src', 'client.js'), 'utf8')

test('S14 client KINDS 字面与 host KINDS 同源', () => {
  const match = clientSource.match(/const KINDS = \[([^\]]*)\]/)
  assert.ok(match, 'client.js 缺少 KINDS 声明')
  const declared = match[1].split(',').map((item) => item.trim().replace(/^'|'$/g, '')).filter((item) => item.length > 0)
  assert.deepEqual(declared, [...KINDS])
})

test('S14b client KIND_LABELS 覆盖全部形态', () => {
  for (const kind of KINDS) {
    const pattern = new RegExp(kind + ":")
    assert.match(clientSource, pattern, 'KIND_LABELS 缺少形态 ' + kind)
  }
})
