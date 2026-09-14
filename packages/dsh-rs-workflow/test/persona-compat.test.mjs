// persona-compat 单测:版本判定 + prefix→text 改写。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseVersion, compareVersions, wantsLegacyText, prefixToText, personaKeysFor } from '../lib/persona-compat.mjs'
import { hostVersion } from '../lib/preset-sync.mjs'
import { fileURLToPath } from 'node:url'

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

test('hostVersion: env 优先且仅接受可解析值', () => {
  const saved = process.env.dshVersion
  try {
    process.env.dshVersion = '0.1.2-rc.1'
    assert.equal(hostVersion('C:/nowhere/bin.js'), '0.1.2-rc.1')
    process.env.dshVersion = 'not-a-version'
    assert.notEqual(hostVersion('C:/nowhere/bin.js'), 'not-a-version')
  } finally {
    if (saved === undefined) delete process.env.dshVersion
    else process.env.dshVersion = saved
  }
})

test('hostVersion: argv 向上定位宿主 package.json', () => {
  const saved = process.env.dshVersion
  delete process.env.dshVersion
  try {
    // 真实宿主入口:.dsh-versions 副本的 bin.js,向上命中 @deepseek-ai/dsh
    const hostBin = fileURLToPath(new URL('../../../.dsh-versions/0.1.5-rc.1/node_modules/@deepseek-ai/dsh/lib/bin.js', import.meta.url))
    assert.equal(hostVersion(hostBin), '0.1.5-rc.1')
    // 只命中无关 package.json(本包)时不误报:找不到 dsh 包名归 unknown
    const ownLib = fileURLToPath(new URL('../lib/preset-sync.mjs', import.meta.url))
    assert.equal(hostVersion(ownLib), 'unknown')
    assert.equal(hostVersion('C:/definitely/not/there/bin.js'), 'unknown')
    assert.equal(hostVersion(undefined), 'unknown')
  } finally {
    if (saved !== undefined) process.env.dshVersion = saved
  }
})
