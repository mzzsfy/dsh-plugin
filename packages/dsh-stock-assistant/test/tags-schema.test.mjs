import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { controlSchema, storedControlSchema, initialControl, MAX_TAGS } from '../src/schemas.mjs'
import { makeSecurity } from '../src/market-model.mjs'
const security = makeSecurity('XSHG', '600519', '贵州茅台')
const withSecurity = (target, extra) => ({ ...initialControl(), watchlist: { order: [target.id], items: { [target.id]: { ...target, alias: '', pinned: false, marks: [], ...extra } } } })
const withItem = extra => withSecurity(security, extra)

// Given 存量记录只有单值 group When 数据域读入 Then 归一为单元素 tags 数组
test('TAG01 存量 group 迁移为 tags 数组', () => {
  const parsed = storedControlSchema.parse(withItem({ group: '白酒' }))
  assert.deepEqual(parsed.watchlist.items[security.id].tags, ['白酒'])
  assert.equal('group' in parsed.watchlist.items[security.id], false, '旧字段不再留着')
})

// 存量空分组的票是用户没有手工组织过的: 升级后按市场自动分组, 否则「默认按市场分组」只对新加的票生效
test('TAG02 存量空分组按市场回填, 新旧并存以 tags 为准', () => {
  assert.deepEqual(storedControlSchema.parse(withItem({ group: '' })).watchlist.items[security.id].tags, ['沪A'])
  const us = makeSecurity('XNAS', 'AAPL', '苹果')
  assert.deepEqual(storedControlSchema.parse(withSecurity(us, { group: '' })).watchlist.items[us.id].tags, ['纳斯达克'])
  const both = storedControlSchema.parse(withItem({ group: '白酒', tags: ['核心'] }))
  assert.deepEqual(both.watchlist.items[security.id].tags, ['核心'])
  // 旧分组非空说明用户手工组织过, 保留原分组而不是再加一个市场标签
  assert.deepEqual(storedControlSchema.parse(withItem({ group: '白酒' })).watchlist.items[security.id].tags, ['白酒'])
  // 旧写路径会 trim, 但手工/外部写入可能带空白: trim 掉而不是让一条记录锁死整个插件
  assert.deepEqual(storedControlSchema.parse(withItem({ group: ' 白酒 ' })).watchlist.items[security.id].tags, ['白酒'])
  assert.deepEqual(storedControlSchema.parse(withItem({ group: '   ' })).watchlist.items[security.id].tags, ['沪A'])
  // 二次解析不再回填, 迁移幂等
  const once = storedControlSchema.parse(withItem({ group: '   ' }))
  assert.deepEqual(storedControlSchema.parse(once).watchlist.items[security.id].tags, ['沪A'])
  // 旧版校验不挡零宽/双向字符: 迁移先剥掉再判定, 否则一条旧记录会让插件整体不激活
  assert.deepEqual(storedControlSchema.parse(withItem({ group: '白酒\u200b' })).watchlist.items[security.id].tags, ['白酒'])
  assert.deepEqual(storedControlSchema.parse(withItem({ group: '\u200b' })).watchlist.items[security.id].tags, ['沪A'])
  assert.deepEqual(storedControlSchema.parse(withItem({ group: '\u202e' })).watchlist.items[security.id].tags, ['沪A'])
  // tags 已存在但不是数组: 报错而不是用 group 静默覆盖用户数据
  assert.throws(() => storedControlSchema.parse(withItem({ group: '白酒', tags: '核心' })))
})

// Given 每票最多 8 个标签 When 写入第 9 个 / 超长 / 含控制字符 / 重复 Then 全部拒绝
test('TAG03 标签数量、长度、字符与去重校验', () => {
  const tags = list => withItem({ tags: list })
  assert.doesNotThrow(() => controlSchema.parse(tags(Array.from({ length: MAX_TAGS }, (_, i) => `组${i}`))))
  assert.throws(() => controlSchema.parse(tags(Array.from({ length: MAX_TAGS + 1 }, (_, i) => `组${i}`))), /too_big/)
  assert.throws(() => controlSchema.parse(tags(['这是一个超过十二个字符的标签名'])), /标签名/)
  assert.throws(() => controlSchema.parse(tags([''])), /标签名/)
  assert.throws(() => controlSchema.parse(tags(['沪\u0000A'])), /标签名/)
  // 零宽与双向控制符不占宽度, 会让两个不同标签在界面上完全同形
  assert.throws(() => controlSchema.parse(tags(['沪\u200bA'])), /标签名/)
  assert.throws(() => controlSchema.parse(tags(['沪\u202eA'])), /标签名/)
  assert.throws(() => controlSchema.parse(tags([' 沪A'])), /标签名/)
  assert.throws(() => controlSchema.parse(tags(['沪A', '沪A'])), /重复/)
})

// Given 一条标签字段被新模型替代 When 解析 Then 旧字段被剥离而不是继续留在记录里
test('TAG04 新记录不再接受 group 字段', () => {
  const parsed = controlSchema.parse(withItem({ group: '白酒', tags: ['核心'] }))
  assert.equal('group' in parsed.watchlist.items[security.id], false)
  assert.deepEqual(parsed.watchlist.items[security.id].tags, ['核心'])
})

// 客户端只做前置提示, 上限必须与服务端一致: 不一致时前端放行的提交到服务端必被拒
test('TAG05 客户端标签上限与服务端一致', async () => {
  const source = await readFile(new URL('../src/client.js', import.meta.url), 'utf8')
  const match = /const MAX_TAGS = (\d+)/.exec(source)
  assert.ok(match, '客户端必须声明标签上限')
  assert.equal(Number(match[1]), MAX_TAGS)
})
