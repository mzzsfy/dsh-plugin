// client-id 守卫:样式注入点必须伴随 data-plugin=@mzzsfy/dsh-shell-select 标记
// (仓库契约,守卫形态照 dsh-cron-board/test/client-id.test.mjs:createElement('style')
// 与 setAttribute('data-plugin') 计数相等)。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const source = readFileSync(join(here, '..', 'src', 'client.js'), 'utf8')

test('head 注入样式全部带 data-plugin 标记', () => {
  const createElementStyle = (source.match(/createElement\('style'/g) ?? []).length
    + (source.match(/createElement\("style"/g) ?? []).length
  const marked = (source.match(/'data-plugin'/g) ?? []).length + (source.match(/"data-plugin"/g) ?? []).length
  assert.ok(createElementStyle > 0, 'client.js 应至少有一个样式注入点')
  assert.equal(marked, createElementStyle, '每个 createElement(\'style\') 必须伴随一个 data-plugin 标记')
})

test('标记值为完整 npm 包名', () => {
  assert.match(source, /setAttribute\('data-plugin', '@mzzsfy\/dsh-shell-select'\)/)
})

test('settings.section 注册与 id', () => {
  assert.match(source, /settings\.section/)
  assert.match(source, /id: 'shell-select'/)
})
