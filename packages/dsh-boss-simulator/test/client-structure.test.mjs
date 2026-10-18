import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const source = readFileSync(join(root, 'src/client.js'), 'utf8')

test('Given client board code When checked for unsafe nested controls Then task card opener is a button and stop button is a sibling', () => {
  assert.match(source, /h\('button', \{ className: 'bs-card__open'/)
  assert.match(source, /\['implementing', 'awaiting_acceptance'\]\.includes\(task\.businessState\) \? h\('button'/)
  assert.doesNotMatch(source, /h\('button', \{[\s\S]{0,500}className: `bs-card/)
})

test('Given selected task When responsive detail is shown Then container width controls panel/drawer/full dialog', () => {
  assert.match(source, /const modality = narrow \? 'mobile' : containerWidth < 1280 \? 'drawer' : 'panel'/)
  assert.match(source, /ResizeObserver/)
  assert.match(source, /'aria-modal'/)
  assert.match(source, /event\.key === 'Escape'/)
})

test('Given settings draft When leaving or save conflicts Then confirmation and draft retention are visible', () => {
  assert.match(source, /role: 'alertdialog'/)
  assert.match(source, /继续编辑/)
  assert.match(source, /本地草稿已保留/)
  assert.match(source, /核对后再显式保存/)
})
