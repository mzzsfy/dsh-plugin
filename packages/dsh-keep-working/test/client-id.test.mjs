import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const PACKAGE = '@mzzsfy/dsh-keep-working'
const source = readFileSync(new URL('../src/client.js', import.meta.url), 'utf8')

test('样式注入点全部自带 data-plugin 标记', () => {
  const created = source.match(/createElement\('style'\)/g) ?? []
  const marked = source.match(new RegExp(`setAttribute\\('data-plugin', '${PACKAGE}'\\)`, 'g')) ?? []
  assert.ok(created.length > 0, '应存在样式注入点')
  assert.equal(created.length, marked.length)
})

test('客户端注册 id 与包名一致', () => {
  assert.match(source, new RegExp(`id: '${PACKAGE}'`))
})

test('样式类名带包前缀', () => {
  const classes = source.match(/\.([a-z]+)-[a-z_]+/g) ?? []
  const foreign = classes.filter((token) => token.startsWith('.kw-') === false)
  assert.deepEqual(foreign, [])
})

test('布尔开关为 switch 形态', () => {
  assert.match(source, /kw-switch__track/)
  assert.match(source, /type: 'checkbox'/)
})
