// 公共依赖装载契约(client-dependency 规约):总线订阅为硬消费,模块表缺失即 factory
// 抛错交装载层判定,禁止吞成静默禁用(单独安装且未代挂占位时唯一可诊断路径);
// react/react-dom 由宿主种子表提供,缺席属宿主异常,防御性干净禁用必须显式报错。
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import assert from 'node:assert/strict'

const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'client.js'), 'utf8')
const MODULE_TABLE_MISS = "missed the module table"

function boot(windowOverrides = {}) {
  const definitions = []
  const window = { __ModuleLoader__: { load: value => definitions.push(value) }, ...windowOverrides }
  new Function('window', source)(window)
  return definitions[0]
}

function requireOf(missing) {
  return name => {
    if (name === missing) throw new Error(`client-modules: require('${name}') ${MODULE_TABLE_MISS}`)
    if (name === 'react') return { createElement: () => null }
    if (name === 'react-dom/client') return {}
    throw new Error(`unexpected require: ${name}`)
  }
}

test('common-tools client 条目缺失时 factory 抛错,不静默降级', () => {
  const plugin = boot()
  assert.throws(
    () => plugin.factory(requireOf('@mzzsfy/dsh-common-tools/client')),
    error => error.message.includes('@mzzsfy/dsh-common-tools/client') && error.message.includes(MODULE_TABLE_MISS),
  )
})

test('react 缺失时干净禁用且显式报错,不静默', () => {
  const plugin = boot()
  const errors = []
  const original = console.error
  console.error = (...args) => errors.push(args.join(' '))
  try {
    const noop = plugin.factory(requireOf('react'))
    assert.deepEqual(Object.keys(noop).sort(), ['apply', 'inject'])
  } finally {
    console.error = original
  }
  assert.equal(errors.length, 1)
  assert.ok(errors[0].includes('react'), '诊断信息须指明缺失模块')
})

test('react-dom/client 缺失时同样干净禁用且显式报错', () => {
  const plugin = boot()
  const errors = []
  const original = console.error
  console.error = (...args) => errors.push(args.join(' '))
  try {
    const noop = plugin.factory(requireOf('react-dom/client'))
    assert.deepEqual(Object.keys(noop).sort(), ['apply', 'inject'])
  } finally {
    console.error = original
  }
  assert.equal(errors.length, 1)
  assert.ok(errors[0].includes('react-dom/client'), '诊断信息须指明缺失模块')
})
