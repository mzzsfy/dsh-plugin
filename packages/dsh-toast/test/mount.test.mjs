// 挂载自愈测试:首次 show 惰性挂容器与样式;重复 show 幂等;外部移除与 HMR
// 旧代残留均在下一次挂载时卸 root 重建;样式内容不一致原位替换、一致跳过零写入;
// 代际退避:更新代际容器在场时旧代 mount 不拆台。
// 加载真实 src/client.js 驱动完整 DOM 交互路径(mock.timers 冻结自动消失计时)。
// 渲染层用记录型 createElement 产 vnode 树,断言类名/role/按钮接线。
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { mock } from 'node:test'

const PKG_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

function makeState() {
  return { byId: new Map(), bodyAppends: 0, appended: [], headChildren: [], bodyChildren: [], warns: [], window: undefined }
}

// head/body 目的地分开记录,样式挂载位置契约可测;
// textContent 经 setter 计数,一致跳过的零写入可断言;
// console.warn 捕获供无归属节点清理留痕断言
function makeDocument(state) {
  const byId = state.byId
  const createElement = (tag) => {
    const node = { tag, id: '', style: {}, writes: 0, remove() { byId.delete(this.id) } }
    Object.defineProperty(node, 'textContent', {
      get() { return node._text || '' },
      set(value) { node._text = value; node.writes += 1 },
    })
    return node
  }
  const doc = {
    getElementById: (id) => byId.get(id) ?? null,
    createElement,
    head: { appendChild: (node) => { state.headChildren.push(node); byId.set(node.id, node) } },
    body: {
      appendChild: (node) => { state.bodyAppends += 1; state.appended.push(node); state.bodyChildren.push(node); byId.set(node.id, node) },
    },
  }
  state.doc = doc
  return doc
}

// 渲染记录型 stub:createElement 产 vnode 树,useSyncExternalStore 取真实快照,
// 使 ToastHost/ToastItem 产物可断言;modRef 延迟解引用加载产物
function makeRenderReactStub(modRef) {
  return {
    useSyncExternalStore: () => (modRef.current !== null ? modRef.current.__test.source.getSnapshot() : []),
    createElement: (type, props, ...children) => ({ type, props: props || null, children }),
  }
}

function loadModule(docState, reactStub = { useSyncExternalStore: () => [], createElement: () => null }) {
  const source = readFileSync(join(PKG_ROOT, 'src', 'client.js'), 'utf8')
  const modules = []
  // window 跨 loadModule 复用:代际计数(window.__dshToastGen)随真实 HMR 同样递增;
  // load 回调重绑本次数组,捕获本次加载的模块
  if (docState.window === undefined) docState.window = { __ModuleLoader__: { load: () => {} } }
  docState.window.__ModuleLoader__.load = (module) => modules.push(module)
  const roots = []
  const warns = docState.warns
  const createRoot = (host) => {
    const root = { host, renderCalls: 0, vnode: null, unmounted: false, render(vnode) { this.renderCalls += 1; this.vnode = vnode }, unmount() { this.unmounted = true } }
    roots.push(root)
    return root
  }
  const requireStub = (name) => (name === 'react-dom/client' ? { createRoot } : reactStub)
  const factory = new Function('window', 'require', 'document', 'console', source + '\n;return null')
  const consoleStub = { warn: (message) => warns.push(message), log: () => {} }
  factory(docState.window, requireStub, makeDocument(docState), consoleStub)
  assert.equal(modules.length, 1, 'client.js 模块未被捕获')
  const mod = modules[0].factory(requireStub)
  return { mod, roots }
}

function loadRenderModule(docState) {
  const modRef = { current: null }
  const result = loadModule(docState, makeRenderReactStub(modRef))
  modRef.current = result.mod
  return result
}

const HOST_ID = 'dsh-toast-host'
const STYLE_ID = 'dsh-toast-style'

test.beforeEach(() => { mock.timers.enable({ apis: ['setTimeout'] }) })
test.afterEach(() => { mock.timers.reset() })

test('首次 show 惰性挂载:容器挂 body、样式挂 head', () => {
  const state = makeState()
  const { mod } = loadModule(state)
  assert.equal(state.byId.get(HOST_ID), undefined, '加载即挂载是错误的(应惰性)')
  mod.show('触发挂载')
  assert.notEqual(state.byId.get(HOST_ID), undefined)
  assert.equal(state.headChildren.some((node) => node.id === STYLE_ID), true, '样式挂宿主文档级')
  assert.equal(state.bodyChildren.some((node) => node.id === HOST_ID), true, '容器直挂 body')
})

test('重复 show 幂等:容器只创建一次,样式一致零写入', () => {
  const state = makeState()
  const { mod } = loadModule(state)
  mod.show('一')
  const styleNode = state.byId.get(STYLE_ID)
  assert.equal(styleNode.writes, 1, '创建时写入一次')
  mod.show('二')
  assert.equal(state.bodyAppends, 1, '容器只 append 一次')
  assert.equal(styleNode.writes, 1, '同代内容一致跳过,零写入')
})

test('样式被外部移除后自愈:容器在场也补挂', () => {
  const state = makeState()
  const { mod } = loadModule(state)
  mod.show('建立')
  state.byId.get(STYLE_ID).remove()
  mod.show('再触发')
  assert.notEqual(state.byId.get(STYLE_ID), undefined, '幂等路径顺带样式自愈')
})

test('外部移除容器后重建:旧 root 卸载,新容器就位', () => {
  const state = makeState()
  const { mod, roots } = loadModule(state)
  mod.show('一')
  const firstRoot = roots[0]
  state.byId.get(HOST_ID).remove()
  mod.show('二')
  assert.equal(firstRoot.unmounted, true, '被移除容器的 root 已卸载')
  assert.equal(state.bodyAppends, 2, '新容器重建')
  assert.notEqual(state.byId.get(HOST_ID), undefined)
})

test('HMR 跨代自愈:新代首挂卸载旧代 root 并重建容器', () => {
  const state = makeState()
  const first = loadModule(state)
  first.mod.show('旧代')
  const staleRoot = first.roots[0]
  const staleHost = state.byId.get(HOST_ID)
  const second = loadModule(state)
  second.mod.show('新代')
  assert.equal(staleRoot.unmounted, true, '旧代 root 已卸载')
  assert.equal(state.byId.get(HOST_ID), state.appended[state.appended.length - 1], '新代容器在场')
  assert.notEqual(state.byId.get(HOST_ID), staleHost, '新容器是新对象')
  assert.equal(second.roots[0].host, state.byId.get(HOST_ID), '新 root 绑定新容器')
})

test('代际退避:更新代际容器在场时,旧代 mount 不拆台且告警留痕', () => {
  const state = makeState()
  const first = loadModule(state)
  first.mod.show('旧代建立')
  const second = loadModule(state)
  second.mod.show('新代接管')
  const hostSecond = state.byId.get(HOST_ID)
  const rootSecond = second.roots[0]
  const appendsBefore = state.bodyAppends

  // 旧代闭包持引用再调 show/mount:发现更新代际在场,退避不动 DOM
  first.mod.show('旧代迟条')
  assert.equal(state.byId.get(HOST_ID), hostSecond, '新代容器未被拆除')
  assert.equal(rootSecond.unmounted, false, '新代 root 未被卸载')
  assert.equal(state.bodyAppends, appendsBefore, '无重建')
  assert.equal(state.warns.filter((message) => message.includes('已退役')).length, 1, '退役告警恰一次')
  first.mod.show('旧代再迟')
  assert.equal(state.warns.filter((message) => message.includes('已退役')).length, 1, '告警限频不风暴')

  // 新代继续 show 正常服务
  second.mod.show('新代续条')
  assert.equal(state.bodyAppends, appendsBefore, '新代容器仍幂等在场')
})

test('双 stale 清理:闭包旧容器与外部同 id 节点同轮被清,无标记节点留痕', () => {
  const state = makeState()
  const { mod, roots } = loadModule(state)
  mod.show('建立')
  const closureHost = state.byId.get(HOST_ID)
  assert.equal(roots.length, 1)

  // 外部无标记同 id 节点顶替在位容器:闭包 host 与陌生节点同时非空
  const alien = state.doc.createElement('div')
  alien.id = HOST_ID
  state.byId.set(HOST_ID, alien)
  mod.show('触发双清')

  assert.equal(roots[0].unmounted, true, '闭包容器 root 卸载')
  assert.notEqual(state.byId.get(HOST_ID), alien, '陌生节点被清走')
  assert.notEqual(state.byId.get(HOST_ID), closureHost, '闭包容器被移除重建')
  assert.equal(state.warns.filter((message) => message.includes('无归属标记')).length, 1, '陌生节点清理留痕一次')
})

test('mount 直调:空 store 显式挂载,连调幂等', () => {
  const state = makeState()
  const { mod } = loadModule(state)
  mod.mount()
  mod.mount()
  assert.equal(state.bodyAppends, 1, '直调幂等')
  assert.notEqual(state.byId.get(HOST_ID), undefined)
  assert.notEqual(state.byId.get(STYLE_ID), undefined)
})

test('渲染产物:栈容器类名、变体类、role 与 sticky 按钮接线', () => {
  const state = makeState()
  const { mod, roots } = loadRenderModule(state)
  mod.show('普通', { kind: 'ok' })
  const stickyId = mod.show('常驻', { kind: 'error', sticky: true })

  const root = roots[roots.length - 1]
  assert.equal(typeof root.vnode.type, 'function', 'render 收到 ToastHost 元素')
  const tree = root.vnode.type()
  assert.equal(tree.type, 'div')
  assert.equal(tree.props.className, 'dsh-toast-stack')

  const items = tree.children.flat()
  const okItem = items.find((vnode) => vnode.props.item.text === '普通')
  const okTree = okItem.type(okItem.props)
  assert.equal(okTree.props.className, 'dsh-toast dsh-toast--ok')
  assert.equal(okTree.props.role, 'alert')
  assert.equal(okTree.props.onClick, undefined, '无 onClick 条目整卡不可点')
  assert.equal(okTree.children[1], null, '非 sticky 无按钮')

  const stickyItem = items.find((vnode) => vnode.props.item.text === '常驻')
  const stickyTree = stickyItem.type(stickyItem.props)
  assert.equal(stickyTree.props.className, 'dsh-toast dsh-toast--error')
  const button = stickyTree.children[1]
  assert.equal(button.type, 'button')
  assert.equal(button.props.className, 'dsh-toast__close')
  button.props.onClick({ stopPropagation() {} })
  assert.equal(mod.__test.getItems().some((item) => item.id === stickyId), false, '按钮接线 dismiss 生效')
})

test('渲染产物:onClick 条目整卡可点,点击即消失并触发回调;按钮关闭不连带', () => {
  const state = makeState()
  const { mod, roots } = loadRenderModule(state)
  let activated = false
  mod.show('可点通知', { onClick: () => { activated = true } })
  const root = roots[roots.length - 1]
  const tree = root.vnode.type()
  const vnode = tree.children.flat().find((entry) => entry.props.item.text === '可点通知')
  const card = vnode.type(vnode.props)
  assert.equal(card.props.className, 'dsh-toast dsh-toast--info dsh-toast--click', '可点条目带标记类')
  card.props.onClick()
  assert.equal(activated, true, '点击触发回调')
  assert.equal(mod.__test.getItems().length, 0, '点击后条目消失')
  // sticky + onClick:「知道了」只关闭,不触发直达
  let stickyActivated = false
  mod.show('常驻可点', { sticky: true, onClick: () => { stickyActivated = true } })
  const tree2 = roots[roots.length - 1].vnode.type()
  const vnode2 = tree2.children.flat().find((entry) => entry.props.item.text === '常驻可点')
  const card2 = vnode2.type(vnode2.props)
  const button = card2.children[1]
  button.props.onClick({ stopPropagation() {} })
  assert.equal(stickyActivated, false, '显式关闭不触发直达')
  assert.equal(mod.__test.getItems().length, 0)
})

test('样式内容不一致原位替换:节点不重建,内容与写入计数还原', () => {
  const state = makeState()
  const { mod } = loadModule(state)
  mod.show('建立样式')
  const styleNode = state.byId.get(STYLE_ID)
  const currentCss = styleNode.textContent
  assert.equal(styleNode.writes, 1)
  // 模拟 HMR 期间 CSS 变更或旧代残留:在位样式内容与本代不一致
  // (直写 _text 绕过写入计数,只统计实现侧的写入)
  styleNode._text = '/* 残留的旧代样式 */'
  mod.show('触发替换')
  assert.equal(state.byId.get(STYLE_ID), styleNode, '样式节点原位保留')
  assert.equal(styleNode.writes, 2, '替换恰新增一次写入')
  assert.equal(styleNode.textContent, currentCss, '内容还原为当前 CSS')
})

test('CSS 内容齐备:选择器、变体、动画与减弱动态块', () => {
  const state = makeState()
  const { mod } = loadModule(state)
  mod.show('建立样式')
  const css = state.byId.get(STYLE_ID).textContent
  for (const needle of ['.dsh-toast-stack', '.dsh-toast {', '.dsh-toast--ok', '.dsh-toast--error', '.dsh-toast__close', '@keyframes dsh-toast-in', 'animation:dsh-toast-in', 'prefers-reduced-motion']) {
    assert.ok(css.includes(needle), 'CSS 缺少 ' + needle)
  }
})
