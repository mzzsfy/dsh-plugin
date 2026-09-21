// tool.mjs DenyError → 模型可见 blocked 标记(场景 8):源级守卫
// (registerShellTool 工厂形态,node:test 下不便直拉 dsh-tools 全链)。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { DenyError } from '../src/denylist.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const source = readFileSync(join(here, '..', 'src', 'tool.mjs'), 'utf8')

test('execute 路径 catch DenyError 返回 blocked 标记文本', () => {
  // 前台与后台两分支各自触达 executor 入口,均须拦截转译
  const catches = (source.match(/catch \(error\) \{[\s\S]*?isDenyError/g) ?? []).length
  assert.ok(catches >= 2, `execute 前台/后台两分支应各自 catch DenyError(发现 ${catches} 处)`)
  assert.match(source, /SHELL_COMMAND_BLOCKED/)
  assert.match(source, /blocked by shell-select/)
})

test('DenyError 形态契约:code/name 可供跨层判定', () => {
  const error = new DenyError('p', 'cmd')
  assert.equal(error.code, 'SHELL_COMMAND_BLOCKED')
  assert.equal(error.name, 'DenyError')
})
