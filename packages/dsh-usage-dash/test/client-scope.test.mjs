// client.js 求值形态守卫:宿主以经典 script 整源求值,顶层词法声明落页面全局词法环境,
// 跨 bundle 同名即整脚本 SyntaxError 拒载;整文件 IIFE 书挡保证顶层零词法声明。
// Given/When/Then 场景内嵌于用例描述;vm.runInContext 与浏览器经典 script 同语义(全局词法环境跨脚本共享)。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import vm from 'node:vm'

const CLIENT_SOURCE = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'client.js'), 'utf8').trimEnd()
const DECLARATION_NAMES = [
  ...new Set(
    [...CLIENT_SOURCE.matchAll(/^(?:const|function|let) ([A-Za-z_$][\w$]*)/gm)].map((match) => match[1])
  ),
]
const BUNDLE_ID = '@mzzsfy/dsh-usage-dash'

test('Given 同 context 已有外部 CHART_PAD 声明(宿主经典 script 全局词法环境), When 整源求值 client.js, Then 双源共存不拒载且外部声明原值不变', () => {
  const ctx = vm.createContext({})
  vm.runInContext('const CHART_PAD = 1', ctx)
  vm.runInContext(CLIENT_SOURCE, ctx)
  assert.equal(vm.runInContext('CHART_PAD', ctx), 1)
})

test('Given client.js 已整源求值, When 同 context 再声明外部 CHART_PAD, Then 双源共存不拒载', () => {
  const ctx = vm.createContext({})
  vm.runInContext(CLIENT_SOURCE, ctx)
  vm.runInContext('const CHART_PAD = 1', ctx)
})

test('Given client.js 整源求值完成, When 逐名探针行首 const/function/let 声明, Then 全局词法环境零泄漏', () => {
  const ctx = vm.createContext({})
  vm.runInContext(CLIENT_SOURCE, ctx)
  const leaked = DECLARATION_NAMES.filter((name) => vm.runInContext(`typeof ${name}`, ctx) !== 'undefined')
  assert.deepEqual(leaked, [])
})

test('Given 宿主 loader 就绪, When 整源求值 client.js, Then 自注册照常发生且 id 不变', () => {
  const registrations = []
  const ctx = vm.createContext({ window: { __ModuleLoader__: { load: (registration) => registrations.push(registration) } } })
  vm.runInContext(CLIENT_SOURCE, ctx)
  assert.equal(registrations.length, 1)
  assert.equal(registrations[0].id, BUNDLE_ID)
  assert.equal(typeof registrations[0].factory, 'function')
})

test('Given 书挡契约, When 校验首末行, Then 首行 IIFE 开、末行 IIFE 闭且声明收集非空', () => {
  const lines = CLIENT_SOURCE.split('\n')
  assert.equal(lines[0], '(() => {')
  assert.equal(lines[lines.length - 1], '})()')
  assert.ok(DECLARATION_NAMES.length > 0)
})
