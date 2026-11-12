import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

// 脱离浏览器执行 client 半区:React 以最小桩替代,验证组件树结构与数据绑定
const loads = []
globalThis.window = { __ModuleLoader__: { load: (def) => loads.push(def) } }
globalThis.document = {
  createElement: () => ({ textContent: '', attrs: {}, setAttribute(k, v) { this.attrs[k] = v }, remove() {} }),
  head: { appendChild() {} },
}

new Function(readFileSync(new URL('../src/client.js', import.meta.url), 'utf8'))()

const CONFIG = {
  paused: false,
  graceMs: 3000,
  cooldownMs: 20000,
  maxConsecutive: 3,
  scanOnBoot: true,
  resumeSilentTurns: true,
  pauseWhenOffline: true,
  classify: true,
  continueText: '继续。上一步结果未知,确认后继续。',
  continueTextInterrupted: '继续。上一步结果未知,确认后继续。',
  continueTextSilent: '继续。上一轮没有可见输出,直接说明结果或继续执行。',
  continueTextMaxTokens: '继续。上一轮被输出上限截断,分段接着输出。',
  closureText: '未检测到结案信号',
}

/** 收集树中的文本与控件类型,便于断言面板内容。 */
function walk(node, out = { texts: [], inputs: [], textareas: [], switches: 0 }) {
  if (node === null || node === undefined || typeof node === 'string') {
    if (typeof node === 'string') out.texts.push(node)
    return out
  }
  if (Array.isArray(node)) {
    for (const child of node) walk(child, out)
    return out
  }
  const { type, props, children } = node
  if (type === 'input') out.inputs.push(props)
  if (type === 'textarea') out.textareas.push(props)
  if (typeof props?.className === 'string' && props.className.includes('kw-switch')) out.switches += 1
  for (const child of children ?? []) walk(child, out)
  return out
}

const loadPanel = () => {
  const def = loads[0]
  const states = [
    [CONFIG, () => {}],
    [null, () => {}],
    ['', () => {}],
    [false, () => {}],
  ]
  let cursor = 0
  const React = {
    createElement: (type, props, ...children) => ({ type, props, children }),
    useState: () => states[cursor++] ?? [null, () => {}],
    useEffect: () => {},
    useCallback: (fn) => fn,
  }
  const mod = def.factory((name) => {
    if (name === 'react') return React
    throw new Error(`未声明依赖 ${name}`)
  })
  return mod.__test.KeepWorkingPanel
}

test('面板渲染出四个分组', () => {
  const Panel = loadPanel()
  const tree = walk(Panel())
  for (const title of ['总开关', '节奏', '恢复项', '补发文案']) {
    assert.ok(tree.texts.includes(title), `缺少分组 ${title}`)
  }
})

test('布尔项为开关形态', () => {
  const Panel = loadPanel()
  const tree = walk(Panel())
  assert.ok(tree.switches >= 5, `开关数量不足: ${tree.switches}`)
})

test('数值项按秒换算展示', () => {
  const Panel = loadPanel()
  const tree = walk(Panel())
  const numbers = tree.inputs.filter((props) => props.type === 'number')
  const values = numbers.map((props) => props.value)
  assert.ok(values.includes(CONFIG.graceMs / 1000), '等待时间应按秒显示')
  assert.ok(values.includes(CONFIG.cooldownMs / 1000), '冷却时间应按秒显示')
  assert.ok(values.includes(CONFIG.maxConsecutive), '最大次数应原样显示')
})

test('文案项全部渲染', () => {
  const Panel = loadPanel()
  const tree = walk(Panel())
  const texts = tree.textareas
  assert.equal(texts.length, 5)
  assert.ok(texts.some((props) => props.value === CONFIG.closureText))
})
