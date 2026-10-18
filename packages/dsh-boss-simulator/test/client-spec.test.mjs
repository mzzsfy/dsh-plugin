import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const source = readFileSync(join(root, 'src/client.js'), 'utf8')

test('Given page specification When checking client source Then required semantic states and container/accessibility hooks are present', () => {
  for (const text of ['aria-label', 'aria-live', '已加载', 'token 未知', '模型待核对', '尚未开始', 'observedAt', 'focus-visible', 'container-type', 'max-width:767px']) {
    assert.ok(source.includes(text), `client lacks ${text}`)
  }
})

test('Given test fixture support When production code is scanned Then no seed route or fixture import exists', () => {
  for (const file of ['lib/control.mjs', 'lib/board.mjs']) {
    const production = readFileSync(join(root, file), 'utf8')
    assert.doesNotMatch(production, /seed_fixture|testSeed|seed-board/)
  }
})
