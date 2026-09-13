// persona-compat 单测:版本判定 + prefix→text 改写。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseVersion, compareVersions, wantsLegacyText, prefixToText, personaKeysFor } from '../lib/persona-compat.mjs'

test('parseVersion 语义化三元组', () => {
  assert.deepEqual(parseVersion('0.1.5-rc.2'), [0, 1, 5])
  assert.deepEqual(parseVersion('1.2.3'), [1, 2, 3])
  assert.deepEqual(parseVersion('0.1.5-rc.2+build.7'), [0, 1, 5])
  assert.equal(parseVersion('unknown'), null)
  assert.equal(parseVersion(''), null)
  assert.equal(parseVersion(undefined), null)
  assert.equal(parseVersion('0.1'), null)
})

test('compareVersions 三态', () => {
  assert.equal(compareVersions([0, 1, 4], [0, 1, 5]), -1)
  assert.equal(compareVersions([0, 1, 5], [0, 1, 5]), 0)
  assert.equal(compareVersions([0, 2, 0], [0, 1, 9]), 1)
})

test('wantsLegacyText: 仅 0.1.5 之前需要 text', () => {
  assert.equal(wantsLegacyText('0.1.1-rc.2'), true)
  assert.equal(wantsLegacyText('0.1.2-rc.1'), true)
  assert.equal(wantsLegacyText('0.1.4'), true)
  assert.equal(wantsLegacyText('0.1.5-rc.1'), false)
  assert.equal(wantsLegacyText('0.1.5-rc.2'), false)
  assert.equal(wantsLegacyText('0.2.0'), false)
  // 未知版本按最新处理,不动原文
  assert.equal(wantsLegacyText('unknown'), false)
  assert.equal(wantsLegacyText(undefined), false)
})

const NEW_FORM = [
  '- id: persona',
  "  name: '@deepseek-ai/dsh-persona'",
  '  config:',
  '    prefix: |-',
  '      第一行 persona。',
  '      第二行。',
  '',
  '      第三行。',
  '    suffix: Your working directory is {{cwd}}.',
  '',
  '- id: agent-instructions',
].join('\n')

test('prefixToText: 块标量 prefix+suffix 合并为 text', () => {
  const out = prefixToText(NEW_FORM)
  assert.match(out, /text: \|-\n          第一行 persona。\n          第二行。\n          第三行。\n\n          Your working directory is \{\{cwd\}\}\.\n/)
  assert.doesNotMatch(out, /prefix:/)
  assert.doesNotMatch(out, /suffix:/)
  assert.match(out, /- id: agent-instructions/)
})

test('prefixToText: 已是 text 形态原文返回', () => {
  const legacy = NEW_FORM.replace('    prefix: |-\n', '    text: |-\n').replace(/    suffix: .*\n/, '')
  assert.equal(prefixToText(legacy), legacy)
})

test('prefixToText: 无 prefix 不动', () => {
  const noPrefix = '- id: persona\n  config:\n    complete: true\n'
  assert.equal(prefixToText(noPrefix), noPrefix)
})

test('personaKeysFor: 按版本分派', () => {
  assert.notEqual(personaKeysFor('0.1.2-rc.1', NEW_FORM), NEW_FORM)
  assert.equal(personaKeysFor('0.1.5-rc.2', NEW_FORM), NEW_FORM)
  assert.equal(personaKeysFor('unknown', NEW_FORM), NEW_FORM)
})
