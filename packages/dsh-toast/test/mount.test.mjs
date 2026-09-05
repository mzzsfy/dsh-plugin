// 挂载自愈测试:首次 show 惰性挂容器与样式;重复 show 幂等;外部移除与 HMR
// 旧代残留均在下一次挂载时卸 root 重建;样式内容不一致原位替换。
// 加载真实 src/client.js 驱动完整 DOM 交互路径(mock.timers 冻结自动消失计时)。
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { mock } from 'node:test'

const PKG_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

const reactStub = {
  useSyncExternalStore: () => [],
  createElement: () => null,
}

function makeState() {
  return { byId: new Map(), bodyAppends: 0, appended: [] }
}

function makeDocument(state) {
  const byId = state.byId
  return {
    getElementById: (id) => byId.get(id) ?? null,
    createElement: (tag) => ({ tag, id: '', textContent: '', style: {}, remove() { byId.delete(this.id) } }),
    head: { appendChild: (node) => byId.set(node.id, node) },
    body: {
      appendChild: (node) => { state.bodyAppends += 1; state.appended.push(node); byId.set(node.id, node) },
    },
  }
}

function loadModule(docState) {
  const source = readFileSync(join(PKG_ROOT, 'src', 'client.js'), 'utf8')
  const modules = []
  const windowStub = { __ModuleLoader__: { load: (module) => modules.push(module) } }
  const roots = []
  const createRoot = (host) => {
    const root = { host, renderCalls: 0, unmounted: false, render() { this.renderCalls += 1 }, unmount() { this.unmounted = true } }
    roots.push(root)
    return root
  }
  const requireStub = (name) => (name === 'react-dom/client' ? { createRoot } : reactStub)
  const factory = new Function('window', 'require', 'document', source + '\n;return null')
  factory(windowStub, requireStub, makeDocument(docState))
  assert.equal(modules.length, 1, 'client.js 模块未被捕获')
  const mod = modules[0].factory(requireStub)
  return { mod, roots }
}

const HOST_ID = 'dsh-toast-host'
const STYLE_ID = 'dsh-toast-style'

test.beforeEach(() => { mock.timers.enable({ apis: ['setTimeout'] }) })
test.afterEach(() => { mock.timers.reset() })

test('首次 show 惰性挂载:容器与样式就位', () => {
  const state = makeState()
  const { mod } = loadModule(state)
  assert.equal(state.byId.get(HOST_ID), undefined, '加载即挂载是错误的(应惰性)')
  mod.show('触发挂载')
  assert.notEqual(state.byId.get(HOST_ID), undefined)
  assert.notEqual(state.byId.get(STYLE_ID), undefined)
})

test('重复 show 幂等:容器只创建一次', () => {
  const state = makeState()
  const { mod } = loadModule(state)
  mod.show('一')
  mod.show('二')
  assert.equal(state.bodyAppends, 1, '容器只 append 一次')
  assert.equal(state.byId.get(HOST_ID), state.appended[0])
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

test('样式内容不一致原位替换:HMR 新代 CSS 变化即生效', () => {
  const state = makeState()
  const { mod } = loadModule(state)
  mod.show('建立样式')
  const styleNode = state.byId.get(STYLE_ID)
  const currentCss = styleNode.textContent
  // 模拟旧代残留:DOM 中样式内容与本代 CSS 不一致(HMR 改了 CSS 数组)
  styleNode.textContent = '/* 残留的旧代样式 */'
  const second = loadModule(state)
  second.mod.show('触发重建路径')
  assert.equal(state.byId.get(STYLE_ID), styleNode, '样式节点原位保留')
  assert.equal(styleNode.textContent, currentCss, '内容恢复为当前 CSS')
})
