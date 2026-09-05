// 编排层契约测试:registerIcons 输入校验/幂等/持久化、队列三态与时序、启停生命周期、
// 单元格与头像槽编排、逐项异常隔离。加载 client.js 全文,window/document 以桩注入。
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

import * as logic from '../src/logic.mjs'

const PKG_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const CLIENT_ID = '@mzzsfy/dsh-settings-nav-icons'

const SELECTOR_CELL = 'button.VOzbGW_navCell'
const SELECTOR_AV = '[class$="_av"]'
const SELECTOR_ALL = SELECTOR_CELL + ',' + SELECTOR_AV
const SELECTOR_MARKED = '[data-navic]'
const SELECTOR_LABEL = '.VOzbGW_navLabel'

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

// 官方 svg 桩:gear=true 模拟官方齿轮路径,否则为无路径原生图形;记录注入内容。
// 隐藏语义与真实浏览器一致:SVGElement 无 hidden 访问器,实现走 style.display
function makeOfficialSvg({ gear = true, hidden = false } = {}) {
  const svg = {
    dataset: { navic: '' },
    style: { display: hidden ? 'none' : '' },
    html: '',
    lastHtml: '',
    insertAdjacentHTML(position, html) { svg.lastHtml = html },
    remove() {},
    querySelector(sel) { return gear && sel.includes('M14.0861') ? {} : null },
  }
  return svg
}

// 导航单元格桩:官方 svg 恒为首个,注入图标尾部追加、remove 即出列;
// applyDecision 经 official.insertAdjacentHTML('afterend') 注入,桩同步进 svgs
function makeCell(label, { gear = true, hidden = false, navic = '' } = {}) {
  const cell = { dataset: { navic }, injectedCount: 0, svgs: [] }
  const official = makeOfficialSvg({ gear, hidden })
  official.remove = () => {
    const index = cell.svgs.indexOf(official)
    if (index >= 0) cell.svgs.splice(index, 1)
  }
  official.insertAdjacentHTML = (position, html) => {
    const injected = {
      dataset: { navic: '1' },
      hidden: false,
      html,
      remove() {
        const index = cell.svgs.indexOf(injected)
        if (index >= 0) cell.svgs.splice(index, 1)
      },
      querySelector: () => null,
    }
    cell.svgs.push(injected)
    cell.injectedCount += 1
  }
  cell.official = official
  cell.svgs.push(official)
  cell.matches = (sel) => sel !== SELECTOR_AV
  cell.querySelector = (sel) => (sel === SELECTOR_LABEL ? { textContent: label } : null)
  cell.querySelectorAll = (sel) => {
    if (sel === 'svg') return cell.svgs
    if (sel === '[data-navic="1"]') return cell.svgs.filter((s) => s !== official && s.dataset.navic === '1')
    return []
  }
  return cell
}

// 头像槽桩:原子节点 + 所在行 + 父容器(applyAvatar 经父容器扫描行内注入);
// rowFound=false 模拟 row1 锚点缺失
function makeAvatar({ name = 'plugin', rowFound = true, navic = '' } = {}) {
  const av = {
    tagName: 'IMG',
    dataset: { navic },
    hidden: false,
    injectedCount: 0,
    rowFound,
    name,
    matches() { return true },
    closest(sel) { return av.rowFound && sel.includes('_row1') ? av.row1 : null },
    insertAdjacentHTML(position, html) {
      av.injectedCount += 1
      av.lastInjectedHtml = html
    },
    parentElement: {
      querySelectorAll(sel) {
        // 模拟 DOM 查询:仅返回真正带标记的兄弟节点
        return sel === '[data-navic="1"]' ? av.parentInjections.filter((n) => n.dataset.navic === '1') : []
      },
    },
    parentInjections: [],
    row1: {
      querySelector(sel) { return sel.includes('_nm') && av.name !== '' ? { textContent: av.name } : null },
    },
  }
  return av
}

function fakeDocument() {
  const doc = {
    body: {},
    marked: [],
    cells: [],
    avatars: [],
    querySelectorAll(sel) {
      if (sel === SELECTOR_ALL) return [...doc.cells, ...doc.avatars]
      if (sel === SELECTOR_CELL) return doc.cells
      if (sel === SELECTOR_AV) return doc.avatars
      if (sel === SELECTOR_MARKED) return doc.marked
      return []
    },
  }
  return doc
}

// 加载 client.js 全文到独立 window/document 环境,返回模块句柄(console 警告被记录)
function loadClient() {
  const src = readFileSync(join(PKG_ROOT, 'src', 'client.js'), 'utf8')
  const raf = fakeRaf()
  const warns = []
  const observed = []
  const observers = []
  class FakeMutationObserver {
    constructor(cb) {
      this.cb = cb
      observers.push(this)
    }
    observe(...args) { observed.push(args) }
    disconnect() { observed.length = 0 }
    takeRecords() { return [] }
  }
  const win = {
    __ModuleLoader__: { load(mod) { win.__loaded = mod } },
    requestAnimationFrame: raf.requestAnimationFrame,
    cancelAnimationFrame: raf.cancelAnimationFrame,
  }
  const doc = fakeDocument()
  new Function('window', 'document', 'MutationObserver', 'requestAnimationFrame', 'cancelAnimationFrame', 'console', src)(
    win, doc, FakeMutationObserver, raf.requestAnimationFrame, raf.cancelAnimationFrame,
    { warn: (...parts) => warns.push(parts.join(' ')), error() {}, log() {} },
  )
  assert.equal(win.__loaded.id, CLIENT_ID, 'client.js 应自注册')
  return { win, doc, raf, observed, observers, warns }
}

// 应用插件 effect,返回卸载函数
function boot(mod, doc) {
  const disposers = []
  mod.factory(() => {}).apply({ effect(fn) { disposers.push(fn()) } })
  return () => disposers.forEach((dispose) => dispose())
}

test('boot 观察:body 目标与三开关齐全,卸载后断开', () => {
  const { win, doc, observed } = loadClient()
  const unload = boot(win.__loaded, doc)
  try {
    assert.equal(observed.length, 1, '恰一次 observe')
    assert.equal(observed[0][0], doc.body, '观察目标是 body')
    assert.deepEqual(observed[0][1], { childList: true, subtree: true, characterData: true }, '三开关齐全')
  } finally {
    unload()
  }
  assert.equal(observed.length, 0, '卸载后 disconnect')
})

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

test('registerIcons:归一化精确等值,__proto__ 键跳过,非法值撤销,同值幂等', () => {
  const { win, doc, raf } = loadClient()
  const unload = boot(win.__loaded, doc)
  try {
    win.__navicIcons.register({ bell: 'bell' })
    assert.equal(win.__navicIconDeclarations.bell, logic.GLYPHS.bell, 'glyph 名归一化为 svg,与 logic 同源')
    raf.flush()
    const rafCount = raf.size()
    win.__navicIcons.register({ bell: 'bell' })
    assert.equal(raf.size(), rafCount, '同值重复注册不触发重贴')
    win.__navicIcons.register({ __proto__: 'bell', wrench: 'wrench' })
    assert.equal(win.__navicIconDeclarations.bell, logic.GLYPHS.bell, '原型键不覆盖既有声明')
    assert.equal(win.__navicIconDeclarations.wrench, logic.GLYPHS.wrench, '合法值写入')
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
    assert.equal(win.__navicIconDeclarations.queued, logic.GLYPHS.bell, '启动前排队条目被消化(值为归一化 svg)')
    assert.equal(typeof win.__navicIconQueue.push, 'function', '队列替换为直通桩')
    win.__navicIcons.register({ direct: 'wrench' })
    assert.equal(win.__navicIconDeclarations.direct, logic.GLYPHS.wrench, '启动后 push 直通')
    unload()
    assert.deepEqual(win.__navicIconQueue, [], '卸载后队列恢复数组形态')
    raf.flush()
    win.__navicIconQueue.push({ after: 'bell' })
    assert.equal(win.__navicIconDeclarations.after, undefined, '卸载后 push 仅排队不生效')
    assert.equal(raf.size(), 0, '卸载后不驱动 DOM')
    const unload2 = boot(win.__loaded, doc)
    try {
      assert.equal(win.__navicIconDeclarations.after, logic.GLYPHS.bell, '重装后排队声明生效')
    } finally {
      unload2()
    }
  } finally {
    unload()
  }
})

test('队列时序:畸形条目不中断排空,同键后者覆盖,排空先于首扫', () => {
  const cell = makeCell('目标分区')
  const { win, doc, raf, warns } = loadClient()
  win.__navicIconQueue = [null, '畸形', ['数组'], { 目标分区: 'spark' }, { 目标分区: 'bell' }]
  doc.cells.push(cell)
  const unload = boot(win.__loaded, doc)
  try {
    assert.equal(win.__navicIconDeclarations.目标分区, logic.GLYPHS.bell, '同键后者覆盖')
    assert.equal(cell.official.style.display, 'none', '排空先于首扫:队列声明直接参与首帧贴图')
    assert.equal(cell.dataset.navic, '目标分区', '首帧已完成替换')
    assert.ok(warns.length >= 3, '畸形条目逐条告警但不中断')
    raf.flush()
    assert.equal(cell.svgs.length, 2, '二扫幂等,无重复注入')
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
  assert.equal(win.__navicIconDeclarations.bell, logic.GLYPHS.bell, '声明持久层保留(重装恢复)')
})

test('声明持久层:重装恢复走安全门,同值注册幂等,恶意值不参与贴图', () => {
  const evilCell = makeCell('evil')
  const { win, doc, raf } = loadClient()
  const unload = boot(win.__loaded, doc)
  win.__navicIcons.register({ persisted: 'bell' })
  unload()
  // 模拟外部篡改持久层:带事件属性的自定义 svg 恢复时必须被闸门拦下
  win.__navicIconDeclarations = { persisted: logic.GLYPHS.bell, evil: '<svg onload="x"></svg>' }
  const rafBefore = raf.size()
  doc.cells.push(evilCell)
  const unload2 = boot(win.__loaded, doc)
  try {
    assert.equal(win.__navicIconDeclarations.persisted, logic.GLYPHS.bell, '新实例恢复声明')
    win.__navicIcons.register({ persisted: 'bell' })
    assert.equal(raf.size(), rafBefore, '恢复后同值注册幂等短路')
    raf.flush()
    assert.notEqual(evilCell.official.lastHtml, '<svg onload="x"></svg>', '恶意声明未过闸,贴图走默认管线')
  } finally {
    unload2()
  }
})

test('恢复守卫:持久层被写成数组/字符串/null 时跳过恢复且不抛,注册功能不受损', () => {
  for (const bad of [['bell'], 'bell', null]) {
    const { win, doc } = loadClient()
    win.__navicIconDeclarations = bad
    const unload = boot(win.__loaded, doc)
    try {
      win.__navicIcons.register({ k: 'bell' })
      assert.equal(win.__navicIconDeclarations.k, logic.GLYPHS.bell, '坏形态 ' + JSON.stringify(bad) + ' 不影响注册')
    } finally {
      unload()
    }
  }
})

test('replacePass:单元格替换为隐藏官方+注入跟随的幂等形态', () => {
  const cell = makeCell('插件市场')
  const { win, doc, raf } = loadClient()
  doc.cells.push(cell)
  const unload = boot(win.__loaded, doc)
  try {
    raf.flush()
    assert.equal(cell.official.style.display, 'none', '官方 svg 隐藏不移除')
    assert.equal(cell.svgs.length, 2, '官方 + 注入图标')
    assert.equal(cell.dataset.navic, '插件市场', '记账')
    win.__navicIcons.register({ 触发二扫: 'bell' })
    raf.flush()
    assert.equal(cell.svgs.length, 2, '幂等:清旧注新后仍为一对')
    assert.equal(cell.official.style.display, 'none')
  } finally {
    unload()
  }
})

test('replacePass:语言切换 label 变化按新 label 重贴', () => {
  const cell = makeCell('插件市场')
  const { win, doc, raf } = loadClient()
  doc.cells.push(cell)
  const unload = boot(win.__loaded, doc)
  try {
    raf.flush()
    assert.equal(cell.dataset.navic, '插件市场')
    cell.querySelector = (sel) => (sel === SELECTOR_LABEL ? { textContent: 'General' } : null)
    win.__navicIcons.register({ 触发二扫: 'bell' })
    raf.flush()
    assert.equal(cell.dataset.navic, 'General', '按新 label 重贴')
    assert.equal(cell.injectedCount, 2, '贴图两次(旧注入已清)')
    assert.equal(cell.svgs.length, 2, '结构仍为官方+单注入')
  } finally {
    unload()
  }
})

test('头像槽编排:img 隐藏+注入+记账,锚点缺失与空名跳过,坏头像不中断', () => {
  const good = makeAvatar({ name: 'plugin-a' })
  const noRow = makeAvatar({ name: 'plugin-b', rowFound: false })
  const noNm = makeAvatar({ name: '' })
  const bad = makeAvatar({ name: 'plugin-c' })
  bad.closest = () => { throw new Error('宿主 DOM 异常') }
  const { win, doc, raf, warns } = loadClient()
  doc.avatars.push(good, noRow, noNm, bad)
  const unload = boot(win.__loaded, doc)
  try {
    raf.flush()
    assert.equal(good.hidden, true, '原子节点隐藏')
    assert.equal(good.injectedCount, 1, '注入图标')
    assert.equal(good.dataset.navic, 'plugin-a', '记账为插件名')
    assert.equal(noRow.hidden, false, 'row1 缺失跳过')
    assert.equal(noNm.hidden, false, '空名跳过')
    assert.ok(warns.length >= 1, '坏头像告警留痕')
  } finally {
    unload()
  }
})

test('头像槽换名:重贴清行内旧注入(父容器范围),外来兄弟不误删', () => {
  const av = makeAvatar({ name: 'plugin-b' })
  av.dataset.navic = 'plugin-a'
  const removed = []
  const oldInjection = { dataset: { navic: '1' }, remove() { removed.push('old') } }
  const foreign = { dataset: {}, remove() { removed.push('foreign') } }
  av.parentInjections.push(oldInjection, foreign)
  av.name = 'plugin-b'
  const { win, doc, raf } = loadClient()
  doc.avatars.push(av)
  const unload = boot(win.__loaded, doc)
  try {
    raf.flush()
    assert.deepEqual(removed, ['old'], '仅清带标记的旧注入')
    assert.equal(av.dataset.navic, 'plugin-b', '记账更新')
    assert.equal(av.injectedCount, 1, '新图标注入')
    assert.equal(av.hidden, true, '原子节点隐藏')
  } finally {
    unload()
  }
})

test('rAF 合批:同一帧内多次 register 只排一帧,flush 后重新排定', () => {
  const { win, doc, raf } = loadClient()
  const unload = boot(win.__loaded, doc)
  try {
    win.__navicIcons.register({ a: 'bell' })
    win.__navicIcons.register({ b: 'wrench' })
    assert.equal(raf.size(), 1, '同帧合批')
    raf.flush()
    win.__navicIcons.register({ c: 'zap' })
    assert.equal(raf.size(), 1, 'flush 后重新排定')
  } finally {
    unload()
  }
})

test('replacePass 逐项异常隔离:单项失败不中断其余', () => {
  const { win, doc, raf, warns } = loadClient()
  const unload = boot(win.__loaded, doc)
  try {
    const bad = { dataset: {}, matches: () => false, querySelector() { throw new Error('宿主 DOM 异常') } }
    const good = makeCell('插件市场')
    doc.cells.push(bad, good)
    win.__navicIcons.register({ 触发: 'bell' })
    raf.flush()
    assert.equal(good.dataset.navic, '插件市场', '异常项之后的正常项完成替换')
    assert.ok(warns.some((line) => line.includes('单元格')), '异常告警留痕')
  } finally {
    unload()
  }
})

test('onMutations 过滤:元素级变更唤醒,文本节点与域外文本不唤醒', () => {
  const { win, doc, raf, observers } = loadClient()
  const unload = boot(win.__loaded, doc)
  try {
    const observer = observers[observers.length - 1]
    const inCellText = { parentElement: { closest(sel) { return sel.includes('navCell') ? {} : null } } }
    const outText = { parentElement: { closest() { return null } } }
    const rowText = { parentElement: { closest(sel) { return sel.includes('_row1') ? {} : null } } }
    observer.cb([{ type: 'childList', addedNodes: [{ nodeType: 3 }], removedNodes: [] }])
    assert.equal(raf.size(), 0, '纯文本节点级 childList 不唤醒')
    observer.cb([{ type: 'childList', addedNodes: [{ nodeType: 1 }], removedNodes: [] }])
    assert.equal(raf.size(), 1, '元素级 childList 唤醒')
    raf.flush()
    observer.cb([{ type: 'characterData', target: outText }])
    assert.equal(raf.size(), 0, '域外文本变更不唤醒')
    observer.cb([{ type: 'characterData', target: inCellText }])
    assert.equal(raf.size(), 1, 'label 域内文本变更(语言切换)唤醒')
    raf.flush()
    observer.cb([{ type: 'characterData', target: rowText }])
    assert.equal(raf.size(), 1, '市场卡片名域内文本变更唤醒')
    raf.flush()
  } finally {
    unload()
  }
})

test('语言切换端到端:characterData 域内变更经回调触发重贴', () => {
  const cell = makeCell('插件市场')
  const { win, doc, raf, observers } = loadClient()
  doc.cells.push(cell)
  const unload = boot(win.__loaded, doc)
  try {
    raf.flush()
    assert.equal(cell.dataset.navic, '插件市场')
    // 语言切换:label 文本原地改写(characterData 通道)
    cell.querySelector = (sel) => (sel === SELECTOR_LABEL ? { textContent: 'General' } : null)
    const labelParent = { closest(sel) { return sel.includes('navCell') ? cell : null } }
    observers[observers.length - 1].cb([{ type: 'characterData', target: { parentElement: labelParent } }])
    raf.flush()
    assert.equal(cell.dataset.navic, 'General', '穿真实唤醒通道完成重贴')
  } finally {
    unload()
  }
})

// 声明侧契约:四个生产者包的注册样板(先探测入口、数组态入队),改契约须同步五处。
// 包脱离 monorepo 布局(发布态)时跳过:无兄弟包源码可读。
test('生产者样板契约:四包注册走 __navicIcons/__navicIconQueue', () => {
  const producers = ['dsh-session-manager', 'dsh-usage-panel', 'dsh-turn-notify', 'dsh-maintain']
  let checked = 0
  for (const pkg of producers) {
    const clientPath = join(PKG_ROOT, '..', pkg, 'src', 'client.js')
    if (!existsSync(clientPath)) continue
    const src = readFileSync(clientPath, 'utf8')
    assert.ok(/__navicIcons\s*!==\s*undefined[^]*?__navicIcons\.register\(/.test(src), pkg + ' 缺少入口探测与注册')
    assert.ok(/Array\.isArray\(window\.__navicIconQueue\)/.test(src), pkg + ' 缺少数组态入队分支')
    assert.ok(/__navicIconQueue\s*=\s*\[/.test(src), pkg + ' 缺少队列初始化分支')
    checked += 1
  }
  assert.ok(checked > 0, 'monorepo 布局下至少校验一个生产者')
})
