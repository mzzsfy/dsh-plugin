// 编排层契约测试:registerIcons 输入校验/幂等/持久化、队列三态、
// 启停生命周期与逐项异常隔离。加载 client.js 全文,window/document 以桩注入。
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const PKG_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const CLIENT_ID = '@mzzsfy/dsh-settings-nav-icons'

const SELECTOR_CELL = 'button.VOzbGW_navCell'
const SELECTOR_AV = '[class$="_av"]'
const SELECTOR_MARKED = '[data-navic]'

function fakeRaf() {
  const pending = new Map()
  let nextId = 1
  return {
    requestAnimationFrame(cb) { const id = nextId++; pending.set(id, cb); return id },
    cancelAnimationFrame(id) { pending.delete(id) },
    flush() { const cbs = [...pending.values()]; pending.clear(); cbs.forEach((cb) => cb()) },
    size() { return pending.size },
  }
}

function fakeDocument({ cells = [], avatars = [] } = {}) {
  const marked = []
  return {
    body: {},
    marked,
    cells,
    avatars,
    querySelectorAll(sel) {
      if (sel === SELECTOR_CELL) return this.cells
      if (sel === SELECTOR_AV) return this.avatars
      if (sel === SELECTOR_MARKED) return this.marked
      return []
    },
  }
}

// 加载 client.js 全文到独立 window/document 环境,返回模块句柄
function loadClient() {
  const src = readFileSync(join(PKG_ROOT, 'src', 'client.js'), 'utf8')
  const raf = fakeRaf()
  const observed = []
  class FakeMutationObserver {
    observe(...args) { observed.push(args) }
    disconnect() { observed.length = 0 }
  }
  const win = {
    __ModuleLoader__: { load(mod) { win.__loaded = mod } },
    requestAnimationFrame: raf.requestAnimationFrame,
    cancelAnimationFrame: raf.cancelAnimationFrame,
  }
  const doc = fakeDocument()
  new Function('window', 'document', 'MutationObserver', 'requestAnimationFrame', 'cancelAnimationFrame', src)(
    win, doc, FakeMutationObserver, raf.requestAnimationFrame, raf.cancelAnimationFrame,
  )
  assert.equal(win.__loaded.id, CLIENT_ID, 'client.js 应自注册')
  return { win, doc, raf, observed }
}

// 应用插件 effect,返回卸载函数
function boot(mod, doc) {
  const disposers = []
  mod.factory(() => {}).apply({ effect(fn) { disposers.push(fn()) } })
  return () => disposers.forEach((dispose) => dispose())
}

test('registerIcons 输入校验:数组与空值拒收', () => {
  const { win, doc, raf } = loadClient()
  const unload = boot(win.__loaded, doc)
  try {
    win.__navicIcons.register(['bell'])
    win.__navicIcons.register(null)
    win.__navicIcons.register('bell')
    assert.deepEqual(Object.keys(win.__navicIconDeclarations ?? {}), [], '非法入参不写入注册表')
    assert.equal(raf.size(), 0, '非法入参不触发重贴')
    assert.equal(doc.marked.length, 0)
  } finally {
    unload()
  }
})

test('registerIcons:__proto__ 键跳过,非法值撤销声明,同值幂等', () => {
  const { win, doc, raf } = loadClient()
  const unload = boot(win.__loaded, doc)
  try {
    win.__navicIcons.register({ bell: 'bell' })
    assert.ok(win.__navicIconDeclarations.bell, '值归一化后入注册表')
    raf.flush()
    const rafCount = raf.size()
    win.__navicIcons.register({ bell: 'bell' })
    assert.equal(raf.size(), rafCount, '同值重复注册不触发重贴')
    // 数字下标键(数组误用)以字符串键生效而非崩
    win.__navicIcons.register({ __proto__: 'bell', wrench: 'wrench' })
    assert.ok(win.__navicIconDeclarations.bell, '原型键不覆盖既有声明')
    assert.ok(win.__navicIconDeclarations.wrench, '合法值写入')
    // 非法值撤销声明,回默认管线
    win.__navicIcons.register({ wrench: 42 })
    assert.equal(win.__navicIconDeclarations.wrench, undefined, '非法值撤销声明')
    assert.ok(raf.size() > rafCount, '撤销后触发重贴')
  } finally {
    unload()
  }
})

test('registerIcons:仅受影响键清记账,无关记账保留', () => {
  const { win, doc, raf } = loadClient()
  const unload = boot(win.__loaded, doc)
  try {
    const hit = { dataset: { navic: '目标分区' } }
    const other = { dataset: { navic: '无关分区' } }
    const svgMark = { dataset: { navic: '1' } }
    doc.marked.push(hit, other, svgMark)
    win.__navicIcons.register({ 目标分区: 'bell' })
    raf.flush()
    assert.equal(hit.dataset.navic, undefined, '受影响记账清除')
    assert.equal(other.dataset.navic, '无关分区', '无关记账保留')
    assert.equal(svgMark.dataset.navic, '1', 'svg 纯标记不误清')
  } finally {
    unload()
  }
})

test('队列三态:启动前排队消化,启动后直通,卸载后重归排队', () => {
  const { win, doc, raf } = loadClient()
  win.__navicIconQueue = [{ queued: 'bell' }]
  const unload = boot(win.__loaded, doc)
  try {
    assert.ok(win.__navicIconDeclarations.queued, '启动前排队条目被消化(值为归一化 svg)')
    assert.equal(typeof win.__navicIconQueue.push, 'function', '队列替换为直通桩')
    win.__navicIcons.register({ direct: 'wrench' })
    assert.ok(win.__navicIconDeclarations.direct, '启动后 push 直通')
    unload()
    assert.deepEqual(win.__navicIconQueue, [], '卸载后队列恢复数组形态')
    raf.flush()
    win.__navicIconQueue.push({ after: 'bell' })
    assert.equal(win.__navicIconDeclarations.after, undefined, '卸载后 push 仅排队不生效')
    assert.equal(raf.size(), 0, '卸载后不驱动 DOM')
    // 重装不刷页:排队声明被新实例消化
    const unload2 = boot(win.__loaded, doc)
    try {
      assert.ok(win.__navicIconDeclarations.after, '重装后排队声明生效')
    } finally {
      unload2()
    }
  } finally {
    unload()
  }
})

test('卸载:__navicIcons 删除,rAF 取消,异常不外抛', () => {
  const { win, doc, raf } = loadClient()
  const unload = boot(win.__loaded, doc)
  win.__navicIcons.register({ bell: 'bell' })
  assert.equal(raf.size(), 1, '重贴已排定')
  unload()
  assert.equal(win.__navicIcons, undefined, '注册入口删除')
  assert.equal(raf.size(), 0, '已排定 rAF 取消')
  assert.ok(win.__navicIconDeclarations.bell, '声明持久层保留(重装恢复)')
})

test('声明持久层:重装实例恢复声明,同值注册幂等', () => {
  const { win, doc, raf } = loadClient()
  const unload = boot(win.__loaded, doc)
  win.__navicIcons.register({ persisted: 'bell' })
  unload()
  const rafBefore = raf.size()
  const unload2 = boot(win.__loaded, doc)
  try {
    assert.ok(win.__navicIconDeclarations.persisted, '新实例恢复声明')
    win.__navicIcons.register({ persisted: 'bell' })
    assert.equal(raf.size(), rafBefore, '恢复后同值注册幂等短路')
  } finally {
    unload2()
  }
})

test('replacePass 逐项异常隔离:单项失败不中断其余', () => {
  const { win, doc, raf } = loadClient()
  const unload = boot(win.__loaded, doc)
  try {
    const bad = { dataset: {}, querySelector() { throw new Error('宿主 DOM 异常') } }
    const good = {
      dataset: {},
      querySelector(sel) {
        if (sel.includes('navLabel')) return { textContent: '插件市场' }
        if (sel === 'svg') return { dataset: {}, paths: ['M14.0861 x'], insertAdjacentHTML() {}, remove() {}, querySelector() { return null } }
        return null
      },
    }
    doc.cells.push(bad, good)
    win.__navicIcons.register({ 触发: 'bell' })
    raf.flush()
    assert.equal(good.dataset.navic, '插件市场', '异常项之后的正常项完成替换')
  } finally {
    unload()
  }
})

// 声明侧契约:四个生产者包的注册样板(先探测入口、数组态入队),改契约须同步五处
test('生产者样板契约:四包注册走 __navicIcons/__navicIconQueue', () => {
  const producers = [
    ['dsh-session-manager', 'dsh-session-manager'],
    ['dsh-usage-panel', 'dsh-usage-panel'],
    ['dsh-turn-notify', 'dsh-turn-notify'],
    ['dsh-maintain', 'dsh-maintain'],
  ]
  for (const [pkg] of producers) {
    const src = readFileSync(join(PKG_ROOT, '..', pkg, 'src', 'client.js'), 'utf8')
    assert.ok(/__navicIcons\s*!==\s*undefined[^]*?__navicIcons\.register\(/.test(src), pkg + ' 缺少入口探测与注册')
    assert.ok(/Array\.isArray\(window\.__navicIconQueue\)/.test(src), pkg + ' 缺少数组态入队分支')
    assert.ok(/__navicIconQueue\s*=\s*\[/.test(src), pkg + ' 缺少队列初始化分支')
  }
})
