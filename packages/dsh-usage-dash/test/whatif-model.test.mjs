// 省钱沙盘的目标模型支持从已有定价规则中下拉选择:候选只取能落到具体型号的规则,
// 通配/单段/无来源标记不进候选;输入仍保留自由填写以试未定价模型。
import test from 'node:test'
import assert from 'node:assert/strict'

import { CLIENT_SOURCE } from './client-eval.mjs'

function loadClientTestApi() {
  let factory
  const window = { __ModuleLoader__: { load: (entry) => { factory = entry.factory } } }
  const source = CLIENT_SOURCE.replace(
    "inject: ['slots', 'locale', 'configForms'],",
    "__test: { whatifModelCandidates }, inject: ['slots', 'locale', 'configForms'],",
  )
  new Function('window', 'localStorage', source)(window, { getItem: () => null, setItem() {} })
  // 只取纯函数,不渲染组件:桩件仅需让 factory 的组件定义期调用成立
  const React = {
    memo: (fn) => fn,
    Fragment: 'Fragment',
    createElement: () => null,
    useId: () => 'whatif-test',
    useState: (seed) => [seed, () => {}],
    useRef: () => ({ current: null }),
    useEffect() {},
    useLayoutEffect() {},
    useMemo: (fn) => fn(),
    useCallback: (fn) => fn,
  }
  return factory((name) => (name === 'react' ? React : {})).__test
}

const { whatifModelCandidates } = loadClientTestApi()

test('Given 规则含具体型号与各类通配 When 取沙盘候选 Then 只保留两段具体型号', () => {
  const rules = [
    { model: 'newapi/auto-free' },
    { model: '*/*' },
    { model: 'newapi/*' },
    { model: '*/gpt-6.2-sol' },
    { model: 'deepseek' },
    { model: '\u0000other' },
    { model: 'zjy/gpt-6.2-sol' },
  ]
  assert.deepEqual(whatifModelCandidates(rules), ['newapi/auto-free', 'zjy/gpt-6.2-sol'])
})

test('Given 多个规则命中同一型号 When 取沙盘候选 Then 去重且按名称排序', () => {
  const rules = [
    { model: 'zjy/beta' },
    { model: 'newapi/alpha' },
    { model: 'zjy/beta' },
  ]
  assert.deepEqual(whatifModelCandidates(rules), ['newapi/alpha', 'zjy/beta'])
})

test('Given 规则未就绪或非数组 When 取沙盘候选 Then 返回空列表', () => {
  assert.deepEqual(whatifModelCandidates(null), [])
  assert.deepEqual(whatifModelCandidates(undefined), [])
})

test('Given 目标模型输入 When 读源码结构 Then 绑定 datalist 且选项来自候选', () => {
  const start = CLIENT_SOURCE.indexOf('function WhatIfSection')
  const body = CLIENT_SOURCE.slice(start, CLIENT_SOURCE.indexOf('function GuardSection', start))
  assert.match(body, /list: modelListId/, '输入框必须绑定候选列表')
  assert.match(body, /h\('datalist', \{ id: modelListId \}/, '缺少 datalist 候选容器')
  assert.match(body, /modelCandidates\.map/, '候选未渲染为 option')
})

test('Given 中英文案 When 读目标模型提示 Then 说明可下拉选择', () => {
  const hints = [...CLIENT_SOURCE.matchAll(/'whatif\.targetModelHint': '([^']*)'/g)].map((match) => match[1])
  assert.equal(hints.length, 2, '中英两侧提示文案存在')
  assert.match(hints[0], /下拉|选择/)
  assert.match(hints[1], /pick|list/i)
})
