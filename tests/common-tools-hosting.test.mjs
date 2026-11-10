import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { check, parsePatchRows, rangeMismatch } from '../scripts/check-common-tools.mjs'

/**
 * 托管形态守真:每个消费插件自带装载行、依赖范围同 minor、external 声明齐全、
 * 库内版本字面量与 package.json 同锁。纯函数先证伪,再用迷你目录树证明整检会红。
 */

function tree(t, { range = '^0.4.0', row = "- insert:\n    - id: x-dsh-common-tools\n      name: '@mzzsfy/dsh-common-tools'\n", external = ['@mzzsfy/dsh-common-tools/client'], client = "const tools = require('@mzzsfy/dsh-common-tools/client')\n" } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'ct-hosting-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const write = (rel, text) => { mkdirSync(join(root, rel, '..'), { recursive: true }); writeFileSync(join(root, rel), text) }
  write('dsh-common-tools/package.json', JSON.stringify({ name: '@mzzsfy/dsh-common-tools', version: '0.4.0' }))
  write('dsh-common-tools/src/client.js', "const VERSION = '0.4.0'\n")
  write('dsh-common-tools/src/host.js', "const PKG_VERSION = '0.4.0'\n")
  write('dsh-x/package.json', JSON.stringify({ name: '@mzzsfy/dsh-x', dependencies: { '@mzzsfy/dsh-common-tools': range }, dsh: { client: { external } } }))
  write('dsh-x/cordis.patch.yml', row)
  write('dsh-x/src/client.js', client)
  return root
}

test('Given 合规消费方 When 整检 Then 零问题', t => {
  const { problems, consumers, version } = check({ packagesDir: tree(t) })
  assert.deepEqual(problems, [])
  assert.deepEqual(consumers, ['dsh-x'])
  assert.equal(version, '0.4.0')
})

test('Given 缺装载行 When 整检 Then 报出行缺失', t => {
  const { problems } = check({ packagesDir: tree(t, { row: "- insert:\n    - id: x\n      name: '@mzzsfy/dsh-x'\n" }) })
  assert.equal(problems.length, 1)
  assert.match(problems[0], /装载行应恰有一条/)
})

test('Given 依赖范围跨 minor When 整检 Then 报出范围错位', t => {
  const { problems } = check({ packagesDir: tree(t, { range: '^0.3.9' }) })
  assert.match(problems.join('\n'), /同一 minor/)
})

test('Given 残留内联生成区 When 整检 Then 报出内联残留', t => {
  const { problems } = check({ packagesDir: tree(t, { client: "// <common-tools-inline>\nconst tools = require('@mzzsfy/dsh-common-tools/client')\n" }) })
  assert.match(problems.join('\n'), /内联生成区/)
})

test('Given 未声明 external When 整检 Then 报出 external 缺失', t => {
  const { problems } = check({ packagesDir: tree(t, { external: [] }) })
  assert.match(problems.join('\n'), /external/)
})

test('Given 库版本字面量与清单不一致 When 整检 Then 报出锁步破裂', t => {
  const root = tree(t)
  writeFileSync(join(root, 'dsh-common-tools/src/client.js'), "const VERSION = '0.3.9'\n")
  const { problems } = check({ packagesDir: root })
  assert.match(problems.join('\n'), /VERSION=0\.3\.9/)
})

test('Given 多个 insert 块 When 解析 Then 全部行可见', () => {
  const rows = parsePatchRows("- insert:\n    - id: a\n      name: '@mzzsfy/a'\n- insert:\n    - id: x-dsh-common-tools\n      name: '@mzzsfy/dsh-common-tools'\n")
  assert.deepEqual(rows.map(row => row.id), ['a', 'x-dsh-common-tools'])
})

test('Given 范围形态 When 校验 Then 只接受同 minor 且下限不高于库版本', () => {
  assert.equal(rangeMismatch('^0.4.0', '0.4.0'), null)
  assert.equal(rangeMismatch('^0.4.1', '0.4.3'), null)
  assert.match(rangeMismatch('^0.4.5', '0.4.3'), /下限高于/)
  assert.match(rangeMismatch('^0.5.0', '0.4.3'), /同一 minor/)
  assert.match(rangeMismatch('~0.4.0', '0.4.0'), /形态/)
  assert.match(rangeMismatch('0.4.0', '0.4.0'), /形态/)
})

test('Given 真实仓库 When 整检 Then 零问题且有十个消费方', () => {
  const { problems, consumers } = check()
  assert.deepEqual(problems, [])
  assert.equal(consumers.length, 10)
})

test('Given 声明要 patch 但文件不存在 When 整检 Then 报出装载行不会生效', t => {
  const root = tree(t)
  writeFileSync(join(root, 'dsh-x/package.json'), JSON.stringify({
    name: '@mzzsfy/dsh-x',
    dependencies: { '@mzzsfy/dsh-common-tools': '^0.4.0' },
    dsh: { client: { external: ['@mzzsfy/dsh-common-tools/client'] }, bundle: { patch: 'missing.yml' } },
  }))
  assert.match(check({ packagesDir: root }).problems.join('\n'), /dsh\.bundle\.patch 指向不存在/)
})

test('Given 单行 insert 形态 When 整检 Then 报出宿主不支持', t => {
  const { problems } = check({ packagesDir: tree(t, { row: "- insert: true\n  id: x-dsh-common-tools\n  name: '@mzzsfy/dsh-common-tools'\n" }) })
  assert.match(problems.join('\n'), /单行 insert/)
})

test('Given external 写成字符串 When 整检 Then 报出形态错误', t => {
  const { problems } = check({ packagesDir: tree(t, { external: '@mzzsfy/dsh-common-tools/client' }) })
  assert.match(problems.join('\n'), /必须是字符串数组/)
})

test('Given 依赖声明被删但装载行仍在 When 整检 Then 仍按消费方校验并报范围缺失', t => {
  const root = tree(t)
  writeFileSync(join(root, 'dsh-x/package.json'), JSON.stringify({
    name: '@mzzsfy/dsh-x',
    dsh: { client: { external: ['@mzzsfy/dsh-common-tools/client'] } },
  }))
  const { problems, consumers } = check({ packagesDir: root })
  assert.deepEqual(consumers, ['dsh-x'])
  assert.match(problems.join('\n'), /范围 undefined 不是/)
})

test('Given require 只出现在注释里 When 整检 Then 报出未按公共 spec 消费', t => {
  const { problems } = check({ packagesDir: tree(t, { client: "// require('@mzzsfy/dsh-common-tools/client')\nconst tools = {}\n" }) })
  assert.match(problems.join('\n'), /未按 @mzzsfy\/dsh-common-tools\/client 消费/)
})

test('Given 非消费方撞用同一装载行 id When 整检 Then 报出 id 冲突', t => {
  const root = tree(t)
  mkdirSync(join(root, 'dsh-y/src'), { recursive: true })
  writeFileSync(join(root, 'dsh-y/package.json'), JSON.stringify({ name: '@mzzsfy/dsh-y' }))
  writeFileSync(join(root, 'dsh-y/cordis.patch.yml'), "- insert:\n    - id: x-dsh-common-tools\n      name: '@mzzsfy/dsh-y'\n")
  assert.match(check({ packagesDir: root }).problems.join('\n'), /id 冲突/)
})
