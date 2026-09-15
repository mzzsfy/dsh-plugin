// client 守卫:注册 id / 开关形制 / 类名前缀 / 宿主 slot 注册形态。
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import assert from 'node:assert/strict'

const PKG_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const { name } = JSON.parse(readFileSync(join(PKG_ROOT, 'package.json'), 'utf8'))
const source = readFileSync(join(PKG_ROOT, 'src', 'client.js'), 'utf8')

test('client.js 注册 id 为完整包名', () => {
  const match = source.match(/__ModuleLoader__\.load\(\{\s*id:\s*'([^']+)'/)
  assert.ok(match, 'client.js 缺少 __ModuleLoader__.load 注册')
  assert.equal(match[1], name)
})

test('开关形制:track+thumb 视觉开关,状态选择器以 input[type=checkbox] 锚定', () => {
  // 裸 checkbox 禁止直出:checkbox 字面量仅允许出现在 Switch 工厂内
  const occurrences = [...source.matchAll(/type: 'checkbox'/g)].map((match) => match.index)
  assert.equal(occurrences.length, 1, `checkbox 字面量出现 ${occurrences.length} 次`)
  const factoryStart = source.indexOf('function Switch(')
  assert.ok(occurrences[0] > factoryStart, 'checkbox 字面量必须位于 Switch 工厂内')
  // 三态均以 checkbox 锚定,禁止裸 input 状态选择器
  assert.match(source, /\.rsww-switch input\[type="checkbox"\]:checked \+/)
  assert.match(source, /\.rsww-switch input\[type="checkbox"\]:focus-visible \+/)
  const bare = source.match(/\.rsww-switch input:(?!\[type)[a-z-]+/g)
  assert.equal(bare, null, `裸 input 状态选择器: ${bare}`)
})

test('类名前缀 rsww- 全量约束(全局注入防跨包冲突)', () => {
  const classNames = [...source.matchAll(/className: '([^']+)'/g)].map((match) => match[1]).filter(Boolean)
  for (const cls of classNames) {
    for (const part of cls.split(' ')) {
      assert.match(part, /^rsww-/, `类名 ${part} 未带 rsww- 前缀`)
    }
  }
  const cssClasses = [...source.matchAll(/\.rsww-[a-z-]+/g)].map((match) => match[0])
  assert.ok(cssClasses.length > 0, 'CSS 类名缺失')
  const foreign = source.match(/\.(?!rsww-?)[a-z][a-z-]+\{/g) || []
  assert.deepEqual(foreign.filter((c) => !c.startsWith('.rsww')), [], `CSS 存在非 rsww- 前缀类: ${foreign}`)
})

test('宿主注册形态:slots 点分注入 settings.section(旧宿主 fiber 未激活即干净禁用)', () => {
  assert.match(source, /inject: \['slots'\]/)
  assert.match(source, /ctx\.slots\.inject\('settings\.section'/)
  assert.match(source, /id: 'rs-workflow-board'/)
})

test('数据通道契约:仅经 /api/rs-workflow/* 读写,无直连存储', () => {
  assert.match(source, /'\/api\/rs-workflow\/'/)
  assert.doesNotMatch(source, /node:|fs\.|require\('node/)
})
