// 公共悬浮提示:tipPlacement 纯函数契约。定位算法迁移自 dsh-usage-dash 的
// Tooltip(1:1 同构),这里锁定指针跟随换侧、元素锚点翻转与边界夹取。
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const PKG_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

function loadModule() {
  const source = readFileSync(join(PKG_ROOT, 'src', 'client.js'), 'utf8')
  const modules = []
  const win = { __ModuleLoader__: { load: (module) => modules.push(module) } }
  const react = {
    useSyncExternalStore: () => [],
    useEffect() {},
    useLayoutEffect() {},
    useCallback: (fn) => fn,
    useRef: () => ({ current: null }),
    useState: () => [null, () => {}],
    createElement: () => null,
  }
  const requireStub = (name) => {
    if (name === 'react') return react
    if (name === 'react-dom/client') return { createRoot: () => ({ render() {}, unmount() {} }) }
    throw new Error('模块表未提供 ' + name)
  }
  const doc = { createElement: () => ({}), getElementById: () => null, querySelector: () => null }
  const factory = new Function('window', 'require', 'document', 'console', 'EventSource', source + '\n;return null')
  factory(win, requireStub, doc, { warn() {}, log() {} }, function EventSourceStub() {})
  assert.equal(modules.length, 1, 'client.js 未捕获')
  return modules[0].factory(requireStub)
}

const mod = loadModule()
const VIEW = { left: 0, top: 0, right: 1000, bottom: 800 }
const TIP = { width: 200, height: 100 }

test('导出契约:Tooltip 组件与 tipPlacement 同时可用', () => {
  assert.equal(typeof mod.Tooltip, 'function')
  assert.equal(typeof mod.tipPlacement, 'function')
})

test('指针锚点:右侧放得下时右下偏移,跟随模式不画箭头', () => {
  const pos = mod.tipPlacement({ kind: 'point', x: 500, y: 400 }, TIP, VIEW)
  assert.deepEqual(pos, { left: 514, top: 414, side: 'bottom', arrowX: null })
})

test('指针锚点:右侧越界翻到指针左侧并夹取进边界', () => {
  const pos = mod.tipPlacement({ kind: 'point', x: 920, y: 400 }, TIP, VIEW)
  assert.equal(pos.left, 706)
  assert.equal(pos.side, 'bottom')
})

test('指针锚点:下方越界翻到指针上方', () => {
  const pos = mod.tipPlacement({ kind: 'point', x: 500, y: 760 }, TIP, VIEW)
  assert.equal(pos.side, 'top')
  assert.equal(pos.top, 646)
})

test('元素锚点:上方优先,箭头对齐锚点中心', () => {
  const pos = mod.tipPlacement({ kind: 'rect', left: 400, top: 300, width: 100, height: 20 }, TIP, VIEW)
  assert.deepEqual(pos, { left: 350, top: 192, side: 'top', arrowX: 100 })
})

test('元素锚点:贴右边界时左移,箭头夹取在圆角内', () => {
  const pos = mod.tipPlacement({ kind: 'rect', left: 950, top: 300, width: 40, height: 20 }, TIP, VIEW)
  assert.equal(pos.left, 792)
  assert.equal(pos.arrowX, 178)
})

test('样式契约:提示自带令牌、中号圆角与 layer-2 底色', () => {
  const source = readFileSync(join(PKG_ROOT, 'src', 'client.js'), 'utf8')
  // .dct-tip 规则体:portal 到 body,令牌必须落在规则自身,不能依赖 toast 作用域
  const rule = source.slice(source.indexOf('.dct-tip {'), source.indexOf('.dct-tip--on'))
  assert.match(rule, /--dct-tip-radius:var\(--dsw-radius-md\)/, '圆角令牌必须自包含')
  assert.match(rule, /--dct-tip-bg:var\(--dsw-alias-bg-layer-2\)/, '提示底色取 layer-2,不复用 toast 的 layer-1')
  assert.match(rule, /border-radius:var\(--dct-tip-radius\)/)
  assert.match(rule, /background:var\(--dct-tip-bg\)/)
  assert.doesNotMatch(rule, /--dct-panel-bg/)
})

test('元素锚点:上方放不下翻到下方;尺寸为零时不定位', () => {
  const below = mod.tipPlacement({ kind: 'rect', left: 400, top: 20, width: 100, height: 20 }, TIP, VIEW)
  assert.equal(below.side, 'bottom')
  assert.equal(below.top, 48)
  assert.equal(mod.tipPlacement({ kind: 'rect', left: 400, top: 20, width: 0, height: 20 }, TIP, VIEW), null)
  assert.equal(mod.tipPlacement({ kind: 'point', x: 10, y: 10 }, { width: 0, height: 0 }, VIEW), null)
})
