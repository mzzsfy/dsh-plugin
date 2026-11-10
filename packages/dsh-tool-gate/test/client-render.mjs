// client.js 渲染替身:把 __ModuleLoader__ 注册的卡片在无 DOM 环境物化为
// { tag, props, children } 树。仅覆盖本包用到的 React 子集(createElement /
// useState / useEffect 一次)与点击重渲染,用于锁定「行可展开、悬停有描述」
// 的可见行为,不引入 React 依赖。
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const CLIENT_PATH = join(dirname(fileURLToPath(import.meta.url)), '../src/client.js')

function walk(node, visit) {
  if (node === null || node === undefined) return
  if (Array.isArray(node)) {
    for (const child of node) walk(child, visit)
    return
  }
  if (typeof node === 'string') return
  visit(node)
  for (const child of node.children) walk(child, visit)
}

export async function renderToolGateCard(state) {
  const hooks = { values: [], index: 0, effect: undefined, effectRan: false }
  let registered
  let tree
  const paint = () => {
    hooks.index = 0
    tree = renderNode(registered.renderer())
  }
  const React = {
    createElement(type, props, ...children) {
      return { type, props: props ?? {}, children }
    },
    useState(initial) {
      const index = hooks.index++
      if (!(index in hooks.values)) hooks.values[index] = typeof initial === 'function' ? initial() : initial
      const set = (value) => {
        hooks.values[index] = typeof value === 'function' ? value(hooks.values[index]) : value
        paint()
      }
      return [hooks.values[index], set]
    },
    useEffect(effect) {
      hooks.effect ??= effect
    },
  }
  const requireStub = (name) => {
    if (name === 'react') return React
    throw new Error(`client 渲染替身不提供模块: ${name}`)
  }
  const sandbox = {
    window: { __ModuleLoader__: { load: ({ factory }) => { registered = { module: factory(requireStub) } } } },
    fetch: async () => ({ ok: true, json: async () => state }),
    setTimeout,
  }
  vm.runInNewContext(readFileSync(CLIENT_PATH, 'utf8'), sandbox, { filename: CLIENT_PATH })

  const slots = []
  registered.module.apply({
    slots: {
      inject: (name, factory) => factory(),
      register: (descriptor, renderer) => slots.push({ descriptor, renderer }),
    },
    effect: () => {},
  })
  registered.renderer = slots[0].renderer
  paint()
  hooks.effect()
  hooks.effectRan = true
  // fetch → json → setState 全部落定后再取树
  for (let round = 0; round < 3; round += 1) await new Promise((resolve) => setImmediate(resolve))
  paint()

  const all = () => {
    const nodes = []
    walk(tree, (node) => nodes.push(node))
    return nodes
  }
  const byClass = (className) => all().filter((node) => (
    typeof node.props.className === 'string' && node.props.className.split(/\s+/).includes(className)
  ))
  const text = (node) => {
    let output = ''
    walk(node, (current) => {
      for (const child of current.children) if (typeof child === 'string') output += child
    })
    return output
  }
  const toolName = (head) => {
    const nameNode = head.children.find((child) => child && typeof child === 'object'
      && String(child.props.className).split(/\s+/).includes('tg-tool__name'))
    return nameNode === undefined ? '' : text(nameNode)
  }
  const findHead = (name) => byClass('tg-tool__head').find((node) => toolName(node) === name)
  const click = (node) => node.props.onClick()

  return { tree, all, byClass, text, findHead, click }
}

function renderNode(node) {
  if (node === null || node === undefined || typeof node === 'boolean') return null
  if (Array.isArray(node)) return node.map(renderNode)
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (typeof node.type === 'function') {
    // hooks.index 由组件调用前的 paint 归零;子组件可以继续使用连续的槽位
    return renderNode(node.type({ ...node.props, children: node.children }))
  }
  return { tag: node.type, props: node.props, children: node.children.map(renderNode) }
}
