import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const { name } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const source = readFileSync(join(root, 'src/client.js'), 'utf8')

test('client module registers its package name and marks every injected style', () => {
  const match = source.match(/__ModuleLoader__\.load\(\{\s*id:\s*'([^']+)'/)
  assert.equal(match?.[1], name)
  const renders = source.split("('style', {").length - 1
  assert.ok(renders > 0)
  assert.equal(source.split(`'data-plugin'`).length - 1, renders)
})

test('client does not offer business-state editing, resume, or seed controls', () => {
  assert.doesNotMatch(source, /修改状态|resume|seed_fixture|testSeed/)
})

test('client registers panel slots and declares a legal nav icon glyph', () => {
  assert.match(source, /slots\.inject\('main'/)
  assert.match(source, /slots\.inject\('sidebar\.panellist'/)
  assert.match(source, /inject: \['slots', 'sessions', 'uiWorkspace', 'uiSession', 'uiConversation', 'conversation'\]/)
  assert.match(source, /uiWorkspace\.openSession\(sessionId\)/)
  assert.match(source, /const NAV_ICON = \{ '公司管理': 'plan', 'dsh-boss-simulator': 'plan' \}/)
})
