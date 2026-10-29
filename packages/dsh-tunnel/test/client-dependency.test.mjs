import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'

const source = readFileSync(new URL('../src/client.js', import.meta.url), 'utf8')
function materialize(missing) {
  let definition
  const diagnostics = []
  const window = { __ModuleLoader__: { load(value) { definition = value } } }
  vm.runInNewContext(source, { window, console: { error: (...args) => diagnostics.push(args) } })
  const require = name => {
    if (name === missing) throw new Error(`module missing: ${name}`)
    return {}
  }
  return { definition, require, diagnostics }
}

test('Given 缺公共client When 物化隧道模块 Then 向装载层抛出具体依赖错误', () => {
  const f = materialize('@mzzsfy/dsh-common-tools/client')
  assert.throws(() => f.definition.factory(f.require), /module missing: @mzzsfy\/dsh-common-tools\/client/)
})
for (const missing of ['react', 'react-dom/client']) test(`Given 缺${missing} When 物化 Then 禁用并报告宿主依赖原因`, () => {
  const f = materialize(missing)
  const module = f.definition.factory(f.require)
  assert.deepEqual(Array.from(module.inject), [])
  assert.equal(f.diagnostics.length, 1)
  assert.match(String(f.diagnostics[0]), new RegExp(missing))
})
