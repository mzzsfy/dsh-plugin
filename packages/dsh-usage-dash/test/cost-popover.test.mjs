import { test } from 'node:test'
import assert from 'node:assert/strict'

import { CLIENT_BODY } from './client-eval.mjs'

// 面板在组件区(整源求值区之外),这里抽出源码单独挂载,验证真实 effect 行为:
// 定位跟随触发元素当前矩形、Esc/外点关闭、监听清理、打开即聚焦
const SOURCE = CLIENT_BODY.match(/function CostPopover\(\{[\s\S]*?\n    \}\n/)[0]
const TIP_MARGIN_PX = Number(CLIENT_BODY.match(/const TIP_MARGIN_PX = (\d+)/)[1])

const RECT = { left: 100, top: 200, width: 60, height: 20 }
const PLACEMENT = { left: 10, top: 20 }

function mount({ rect = RECT, placement = PLACEMENT, resizeObserver = true, observerBox = {} } = {}) {
  const listeners = { keydown: [], pointerdown: [] }
  const document = {
    body: {},
    addEventListener: (type, fn, capture) => { (listeners[type] ??= []).push({ fn, capture }) },
    removeEventListener: (type, fn) => { listeners[type] = (listeners[type] ?? []).filter((item) => item.fn !== fn) },
  }
  const window = { innerWidth: 1000, innerHeight: 800, addEventListener() {}, removeEventListener() {} }
  const refs = []
  const useRef = (value) => {
    // 与 useState 同槽位持久化:重渲染必须拿到同一个 ref,否则 effect 闭包会看到空 ref
    const slot = cursor++
    if (slot >= refs.length) refs[slot] = { current: value }
    return refs[slot]
  }
  let states = []
  let cursor = 0
  const useState = (seed) => {
    const slot = cursor++
    if (slot >= states.length) states[slot] = typeof seed === 'function' ? seed() : seed
    return [states[slot], (next) => { states[slot] = typeof next === 'function' ? next(states[slot]) : next }]
  }
  const layoutEffects = []
  const effects = []
  const cleanups = []
  const focusCalls = []
  const h = (type, props, ...children) => {
    const element = {
      type,
      props: props ?? {},
      children: children.flat(Infinity).filter((child) => child != null && child !== false),
      offsetWidth: 420,
      offsetHeight: 300,
      focus() { focusCalls.push(element); element.focused = true },
      contains: (target) => target === element,
    }
    if (props?.ref) props.ref.current = element
    return element
  }
  const createPortal = (node, container) => ({ type: 'portal', props: { container }, children: [node] })
  const placements = []
  const tipPlacement = (anchor, size, bounds, options) => {
    placements.push({ anchor, size, bounds, options })
    return placement
  }
  const triggerElement = { focused: false, focus() { triggerElement.focused = true } }
  const triggerRef = { current: { getBoundingClientRect: () => rect, contains: (target) => target === triggerElement, focus: triggerElement.focus } }
  const Observer = resizeObserver
    ? class { constructor(run) { observerBox.run = run } observe() { observerBox.observed = true } disconnect() { observerBox.disconnected = true } }
    : undefined
  const component = new Function(
    'useRef', 'useState', 'useLayoutEffect', 'useEffect', 'h', 'createPortal', 'tipPlacement', 'TIP_SIDE_TOP', 'TIP_MARGIN_PX',
    'document', 'window', 'ResizeObserver',
    `return (${SOURCE})`,
  )(
    useRef, useState,
    (fn) => layoutEffects.push(fn),
    (fn) => effects.push(fn),
    h, createPortal, tipPlacement, 'top', TIP_MARGIN_PX, document, window, Observer,
  )
  const closed = []
  const props = { triggerRef, label: '费用估算明细', onClose: () => closed.push('closed'), children: 'body' }
  const render = () => { cursor = 0; return component(props) }
  // 真实 React 语义:layoutEffect 在 DOM 落位后跑,设置状态会再渲染一次;
  // effect 只提交首轮,避免第二次渲染重复注册监听
  let tree = render()
  const firstEffects = effects.splice(0)
  layoutEffects.splice(0).forEach((fn) => fn())
  tree = render()
  layoutEffects.length = 0
  for (const fn of firstEffects) {
    const cleanup = fn()
    if (typeof cleanup === 'function') cleanups.push(cleanup)
  }
  const panel = tree.children[0]
  return {
    tree,
    panel,
    triggerRef,
    triggerElement,
    placements,
    closed,
    listeners,
    observerBox,
    focusCalls,
    keydown(event) { for (const item of listeners.keydown) item.fn(event) },
    pointerdown(target) { for (const item of listeners.pointerdown) item.fn({ target }) },
    unmount() { cleanups.forEach((cleanup) => cleanup()) },
  }
}

test('Given 打开面板 When 渲染 Then portal 到 body 且 dialog 打开即聚焦,定位取触发元素当前矩形', () => {
  const view = mount()
  assert.equal(view.tree.type, 'portal')
  assert.equal(view.panel.props.role, 'dialog')
  assert.equal(view.panel.props.tabIndex, -1)
  assert.equal(view.panel.props['aria-label'], '费用估算明细')
  assert.equal(view.focusCalls.length >= 1, true, '打开后焦点进入面板')
  // 锚点不是冻结快照:每次都问触发元素当前矩形,滚动/换会话后跟随
  assert.equal(view.placements[0].anchor, RECT)
  assert.equal(view.panel.props.style.left, '10px')
  assert.equal(view.panel.props.style.top, '20px')
})

test('Given 面板打开 When 按 Escape Then 关闭并阻止事件继续冒泡到宿主弹窗', () => {
  const view = mount()
  let stopped = 0
  view.keydown({ key: 'Escape', stopPropagation: () => { stopped += 1 } })
  assert.deepEqual(view.closed, ['closed'])
  assert.equal(stopped, 1)
  assert.equal(view.triggerElement.focused, true, '关闭后焦点回到触发按钮')
})

test('Given 面板打开 When 按其他键 Then 不关闭', () => {
  const view = mount()
  view.keydown({ key: 'a', stopPropagation() {} })
  assert.deepEqual(view.closed, [])
})

test('Given 面板打开 When 在面板内或触发按钮上按下指针 Then 不关闭,面板外按下则关闭', () => {
  const view = mount()
  view.pointerdown(view.panel)
  view.pointerdown(view.triggerElement)
  assert.deepEqual(view.closed, [])
  view.pointerdown({})
  assert.deepEqual(view.closed, ['closed'])
})

test('Given 面板卸载 Then 键盘与指针监听被移除', () => {
  const view = mount()
  assert.equal(view.listeners.keydown.length, 1)
  assert.equal(view.listeners.pointerdown.length, 1)
  assert.equal(view.listeners.pointerdown[0].capture, true)
  view.unmount()
  assert.equal(view.listeners.keydown.length, 0)
  assert.equal(view.listeners.pointerdown.length, 0)
})

test('Given 环境无 ResizeObserver When 打开面板 Then 定位与关闭仍工作', () => {
  const view = mount({ resizeObserver: false })
  assert.equal(view.placements.length >= 1, true)
  view.keydown({ key: 'Escape', stopPropagation() {} })
  assert.deepEqual(view.closed, ['closed'])
})

test('Given 触发元素矩形不同 When 分别打开 Then 定位各自取当前矩形而非固定值', () => {
  const first = mount()
  const second = mount({ rect: { left: 400, top: 500, width: 60, height: 20 } })
  assert.equal(first.placements[0].anchor.left, 100)
  assert.equal(second.placements[0].anchor.left, 400)
  assert.equal(second.placements[0].bounds.right, 1000)
  assert.equal(second.placements[0].options.prefer, 'top')
})

test('Given 触发元素无法量测 When 打开面板 Then 退到视口底部居中而不是隐身在左上角', () => {
  const view = mount({ rect: null })
  const style = view.panel.props.style
  assert.notEqual(style.visibility, 'hidden')
  assert.equal(Number.parseFloat(style.left) > 0, true)
  assert.equal(Number.parseFloat(style.top) > 0, true)
})
