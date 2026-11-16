import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import assert from 'node:assert/strict'

const PKG_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const source = readFileSync(join(PKG_ROOT, 'src', 'client.js'), 'utf8')

// Given 390x844 视口下表单内容高于弹窗;When 弹窗布局;Then 表单体单独滚动,主操作固定可见。
test('窄屏弹窗:内容滚动但底部主操作保持可见', () => {
  assert.match(source, /\.cb-modal\{[^}]*overflow:hidden/)
  assert.match(source, /\.cb-modal-body\{[^}]*overflow:auto/)
  assert.match(source, /\.cb-modal \.cb-toolbar\{position:sticky/)
})
