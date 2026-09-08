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
const NAVLIST_SCROLL_CSS = '.VOzbGW_navList{flex:1 1 0;min-height:0;overflow-y:auto;scrollbar-width:thin}'

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

// 浮层桩内递归找节点:按钮嵌在 row 子层
function overlayFind(root, pred) {
  for (const node of root.children) {
    if (pred(node)) return node
    const hit = overlayFind(node, pred)
    if (hit) return hit
  }
  return null
}

// 官方 svg 桩:gear=true 模拟官方齿轮路径,否则为无路径原生图形;内容改写制下
// applyDecision 直接写 innerHTML(桩以 innerHTML 属性承接)与 dataset.navic
function makeOfficialSvg({ gear = true } = {}) {
  const svg = {
    tagName: 'svg',
    dataset: { navic: '' },
    style: { display: '' },
    innerHTML: '',
    remove() {},
    querySelector(sel) { return gear && sel.includes('M14.0861') ? {} : null },
  }
  return svg
}

// 导航单元格桩:官方 svg 恒为首个;内容改写制下不再产生注入节点,
// remove 语义仅服务于 0.1.x 升级残留清理路径
function makeCell(label, { gear = true, navic = '' } = {}) {
  const cell = { dataset: {}, injectedCount: 0, svgs: [] }
  const official = makeOfficialSvg({ gear })
  if (navic) official.dataset.navic = navic
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
  cell.closest = (sel) => (sel === SELECTOR_CELL ? cell : null)
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
    // 生命周期事件序:锁定"样式注入先于观察器挂载"的顺序契约
    events: [],
    head: {
      children: [],
      appendChild(el) { doc.head.children.push(el); doc.events.push('style') },
    },
    createdStyles: [],
    listeners: {},
    createElement(tag) {
      const el = {
        tag,
        textContent: '',
        children: [],
        className: '',
        value: '',
        placeholder: '',
        innerHTML: '',
        appendChild(child) { el.children.push(child) },
        focus() { el.focused = true },
        addEventListener(type, fn) { el.handlers[type] = fn },
        handlers: {},
        classList: {
          add(cls) { el.classes.add(cls) },
          remove(cls) { el.classes.delete(cls) },
        },
        classes: new Set(),
        remove() {
          const list = doc.bodyChildren
          const at = list.indexOf(el)
          if (at >= 0) list.splice(at, 1)
          doc.createdStyles.splice(doc.createdStyles.indexOf(el), 1)
          doc.head.children.splice(doc.head.children.indexOf(el), 1)
        },
      }
      if (tag === 'style') doc.createdStyles.push(el)
      return el
    },
    bodyChildren: [],
    addEventListener(type, fn) {
      ;(doc.listeners[type] ??= []).push(fn)
    },
    removeEventListener(type, fn) {
      const list = doc.listeners[type] ?? []
      const at = list.indexOf(fn)
      if (at >= 0) list.splice(at, 1)
    },
    dispatch(type, event) {
      for (const fn of [...(doc.listeners[type] ?? [])]) fn(event)
    },
    querySelectorAll(sel) {
      if (sel === SELECTOR_ALL) return [...doc.cells, ...doc.avatars]
      if (sel === SELECTOR_CELL) return doc.cells
      if (sel === SELECTOR_AV) return doc.avatars
      if (sel === SELECTOR_MARKED) return doc.marked
      return []
    },
  }
  doc.body.appendChild = (el) => { doc.bodyChildren.push(el) }
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
    observe(...args) { observed.push(args); if (doc.events) doc.events.push('observe') }
    disconnect() { observed.length = 0 }
    takeRecords() { return [] }
  }
  const win = {
    __ModuleLoader__: { load(mod) { win.__loaded = mod } },
    requestAnimationFrame: raf.requestAnimationFrame,
    cancelAnimationFrame: raf.cancelAnimationFrame,
    localStorage: {
      map: new Map(),
      getItem(k) { return win.localStorage.map.has(k) ? win.localStorage.map.get(k) : null },
      setItem(k, v) { win.localStorage.map.set(k, String(v)) },
    },
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

test('启动样式:覆盖浮层样式与滚动样式注入 head,卸载移除,重装恢复,先于观察器挂载', () => {
  const { win, doc, observed } = loadClient()
  assert.equal(doc.createdStyles.length, 0, '启动前无注入')
  const unload = boot(win.__loaded, doc)
  try {
    assert.equal(doc.createdStyles.length, 2, '恰两次注入(浮层+滚动)')
    assert.ok(doc.createdStyles.some((el) => el.textContent.includes('sni-ov')), '浮层样式随启动注入')
    assert.ok(doc.createdStyles.some((el) => el.textContent === NAVLIST_SCROLL_CSS), '滚动规则与实现同源')
    assert.equal(doc.head.children.length, 2, '样式挂载在 head')
    assert.deepEqual(doc.events, ['style', 'style', 'observe'], '样式注入先于观察器挂载')
    unload()
    assert.equal(doc.createdStyles.length, 0, '卸载后移除')
    assert.equal(doc.head.children.length, 0, 'head 无残留')
    const unload2 = boot(win.__loaded, doc)
    try {
      assert.equal(doc.createdStyles.length, 2, '重装恢复注入')
    } finally {
      unload2()
    }
    assert.equal(doc.createdStyles.length, 0, '二次卸载移除')
  } finally {
    unload()
  }
})

test('启动样式代际:HMR 不卸载重评估由新实例代拆,旧形槽跨版本容忍', () => {
  // HMR 路径:旧实例未 stop 直接二次 boot(新实例读槽代拆上一代样式)
  const { win, doc } = loadClient()
  const unload1 = boot(win.__loaded, doc)
  const oldStyles = [...doc.createdStyles]
  const unload2 = boot(win.__loaded, doc)
  try {
    assert.equal(doc.createdStyles.length, 2, '代拆后恰两份样式')
    assert.equal(doc.head.children.length, 2, 'head 无旧代残留')
    for (const old of oldStyles) {
      assert.ok(!doc.createdStyles.includes(old), '旧代样式被替换')
    }
    unload2()
    assert.equal(doc.createdStyles.length, 0, '新实例卸载后干净')
  } finally {
    unload1()
    unload2()
  }

  // 升级路径:上一代是旧版本槽(无 scrollStyle/overlayStyle 字段),代拆不得抛错
  const { win: win2, doc: doc2 } = loadClient()
  win2[Symbol.for('@mzzsfy/dsh-settings-nav-icons')] = { observer: null, rafId: 0 }
  const unload3 = boot(win2.__loaded, doc2)
  try {
    assert.equal(doc2.createdStyles.length, 2, '旧形槽不阻塞注入')
  } finally {
    unload3()
  }
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

test('registerIcons:受影响 nav svg 就地重写内容,无关记账保留,纯标记不误清', () => {
  const { win, doc, raf } = loadClient()
  const unload = boot(win.__loaded, doc)
  try {
    const hit = { tagName: 'svg', dataset: { navic: '目标分区' }, innerHTML: '' }
    const other = { tagName: 'svg', dataset: { navic: '无关分区' }, innerHTML: '' }
    const avMark = { dataset: { navic: '无关插件' } }
    const svgMark = { dataset: { navic: '1' } }
    doc.marked.push(hit, other, avMark, svgMark)
    win.__navicIcons.register({ 目标分区: 'bell' })
    raf.flush()
    assert.equal(hit.innerHTML, logic.svgInner(logic.GLYPHS.bell), '受影响 nav svg 内容就地重写')
    assert.equal(hit.dataset.navic, '目标分区', 'nav svg 记账保留(清账会令 isGear 失配)')
    assert.equal(other.innerHTML, '', '无关 nav svg 不重写')
    assert.equal(other.dataset.navic, '无关分区', '无关记账保留')
    assert.equal(avMark.dataset.navic, '无关插件', '头像槽记账不误清')
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
    assert.ok(cell.official.innerHTML.length > 0, '排空先于首扫:队列声明直接参与首帧改写')
    assert.equal(cell.official.dataset.navic, '目标分区', '首帧已完成改写')
    assert.ok(warns.length >= 3, '畸形条目逐条告警但不中断')
    raf.flush()
    assert.equal(cell.svgs.length, 1, '二扫幂等,不产生新节点')
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
    assert.notEqual(evilCell.official.innerHTML, '<svg onload="x"></svg>', '恶意声明未过闸')
    assert.equal(
      evilCell.official.innerHTML,
      logic.svgInner(logic.FALLBACK[logic.poolIndexOf('evil')]),
      '恶意声明未过闸,贴图走默认管线',
    )
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

test('replacePass:官方齿轮 svg 内容改写 + 记账,不建节点,再扫幂等', () => {
  const cell = makeCell('插件市场')
  const { win, doc, raf } = loadClient()
  doc.cells.push(cell)
  const unload = boot(win.__loaded, doc)
  try {
    raf.flush()
    assert.ok(cell.official.innerHTML.length > 0, '官方 svg 内容被改写')
    assert.equal(cell.svgs.length, 1, '不新建 svg 节点')
    assert.equal(cell.official.dataset.navic, '插件市场', '记账在官方 svg 上')
    win.__navicIcons.register({ 触发二扫: 'bell' })
    raf.flush()
    assert.equal(cell.svgs.length, 1, '幂等:再扫无新节点')
    assert.equal(cell.official.dataset.navic, '插件市场')
  } finally {
    unload()
  }
})

test('replacePass:语言切换 label 变化按新 label 重写', () => {
  const cell = makeCell('插件市场')
  const { win, doc, raf } = loadClient()
  doc.cells.push(cell)
  const unload = boot(win.__loaded, doc)
  try {
    raf.flush()
    assert.equal(cell.official.dataset.navic, '插件市场')
    cell.querySelector = (sel) => (sel === SELECTOR_LABEL ? { textContent: 'General' } : null)
    win.__navicIcons.register({ 触发二扫: 'bell' })
    raf.flush()
    assert.equal(cell.official.dataset.navic, 'General', '按新 label 重写')
    assert.equal(cell.injectedCount, 0, '内容改写制无注入')
    assert.equal(cell.svgs.length, 1, '结构仍为官方单 svg')
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
    assert.equal(good.official.dataset.navic, '插件市场', '异常项之后的正常项完成改写')
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
    assert.equal(cell.official.dataset.navic, '插件市场')
    // 语言切换:label 文本原地改写(characterData 通道)
    cell.querySelector = (sel) => (sel === SELECTOR_LABEL ? { textContent: 'General' } : null)
    const labelParent = { closest(sel) { return sel.includes('navCell') ? cell : null } }
    observers[observers.length - 1].cb([{ type: 'characterData', target: { parentElement: labelParent } }])
    raf.flush()
    assert.equal(cell.official.dataset.navic, 'General', '穿真实唤醒通道完成重写')
  } finally {
    unload()
  }
})

// 用户覆盖:恢复走安全门、写入幂等/非法拒绝、等价组全键触达、localStorage 持久往返
test('用户覆盖:启动从 localStorage 恢复,非法键值跳过', () => {
  const { win, doc } = loadClient()
  doc.cells.push(makeCell('插件市场'))
  win.localStorage.map.set('__navicUserIcons', JSON.stringify({
    '插件市场': 'bell',
    '坏 glyph': 'no-such-glyph',
    '活动 html': '<svg><script>alert(1)</script></svg>',
    '1': 'bell',
    __proto__: 'bell',
    '超长键': 'x'.repeat(4097),
  }))
  const unload = boot(win.__loaded, doc)
  try {
    const market = doc.cells[0]
    assert.equal(market.official.dataset.navic, '插件市场')
    assert.ok(market.official.innerHTML.includes('M8 2.2'), '合法覆盖生效(bell 内容)')
    assert.ok(!doc.marked.some((el) => el.dataset.navic === '坏 glyph'), '未知 glyph 不入表')
    assert.ok(!doc.marked.some((el) => el.dataset.navic === '活动 html'), '安全门拒绝直通')
  } finally {
    unload()
  }
})

test('用户覆盖:右键浮层保存/非法行内提示/清除,持久化往返,卸载后重装恢复', () => {
  const { win, doc, raf } = loadClient()
  doc.cells.push(makeCell('插件市场'))
  const unload = boot(win.__loaded, doc)
  try {
    const cell = doc.cells[0]
    doc.marked.push(cell.official)
    // 右键打开浮层:preventDefault + 单例 + 输入聚焦
    const evt = { target: cell, preventDefault() { evt.prevented = true } }
    doc.dispatch('contextmenu', evt)
    assert.ok(evt.prevented, '右键默认菜单被阻止')
    const overlay = doc.bodyChildren[doc.bodyChildren.length - 1]
    assert.ok(overlay.className.includes('sni-ov'), '浮层挂 body')
    const input = overlayFind(overlay, (n) => n.tag === 'input')
    const save = overlayFind(overlay, (n) => n.tag === 'button' && n.textContent === '保存')
    const clear = overlayFind(overlay, (n) => n.tag === 'button' && n.textContent === '清除')
    assert.ok(input && save && clear, '浮层含输入与双按钮')
    assert.equal(input.focused, true, '打开即聚焦')
    // 非法值:行内提示,不落库
    input.value = 'no-such-glyph'
    save.handlers.click()
    const bad = overlayFind(overlay, (n) => (n.classes ?? new Set()).size > 0)
    assert.ok(bad && [...bad.classes].some((c) => c.includes('__bad--on')), '非法值行内提示')
    assert.equal(win.localStorage.map.get('__navicUserIcons'), undefined, '非法值不持久化')
    // 合法保存:落库 + 单元格就地重写 + 浮层关闭
    input.value = 'bell'
    save.handlers.click()
    assert.ok(!doc.bodyChildren.includes(overlay), '保存成功关闭浮层')
    assert.ok(cell.official.innerHTML.includes('M8 2.2'), '覆盖内容生效')
    const saved = JSON.parse(win.localStorage.map.get('__navicUserIcons'))
    assert.ok(saved['插件市场'], '覆盖持久化')
    // 再开浮层:回填当前覆盖值;清除:回默认管线 + 删键
    doc.dispatch('contextmenu', { target: cell, preventDefault() {} })
    const overlay2 = doc.bodyChildren[doc.bodyChildren.length - 1]
    const input2 = overlayFind(overlay2, (n) => n.tag === 'input')
    const clear2 = overlayFind(overlay2, (n) => n.tag === 'button' && n.textContent === '清除')
    assert.equal(input2.value, 'bell', '回填当前覆盖原文(glyph 名)')
    clear2.handlers.click()
    assert.equal(win.localStorage.map.get('__navicUserIcons'), '{}', '清除后持久化为空表')
    assert.ok(!cell.official.innerHTML.includes('M8 2.2'), '清除后回默认管线(店面图标)')
    assert.ok(doc.bodyChildren.indexOf(overlay2) < 0, '清除关闭浮层')
    // 浮层外点击与 Escape 关闭
    doc.dispatch('contextmenu', { target: cell, preventDefault() {} })
    const overlay3 = doc.bodyChildren[doc.bodyChildren.length - 1]
    doc.dispatch('pointerdown', { target: cell })
    assert.ok(!doc.bodyChildren.includes(overlay3), '外部点击关闭')
    doc.dispatch('contextmenu', { target: cell, preventDefault() {} })
    const overlay4 = doc.bodyChildren[doc.bodyChildren.length - 1]
    doc.dispatch('keydown', { key: 'Escape' })
    assert.ok(!doc.bodyChildren.includes(overlay4), 'Escape 关闭')
    // 卸载重装:localStorage 覆盖恢复生效
    win.localStorage.map.set('__navicUserIcons', JSON.stringify({ '插件市场': 'bell' }))
  } finally {
    unload()
  }
  const unload2 = boot(win.__loaded, doc)
  try {
    assert.ok(doc.cells[0].official.innerHTML.includes('M8 2.2'), '重装恢复用户覆盖')
  } finally {
    unload2()
  }
})

test('用户覆盖:别名等价键写入/清除,双语分区两侧触达', () => {
  const { win, doc } = loadClient()
  // 双语两格均按齿轮改写链记账:'通用设置' 与 'General' 各持内置映射
  doc.cells.push(makeCell('通用设置'))
  doc.cells.push(makeCell('General'))
  const unload = boot(win.__loaded, doc)
  try {
    const zhCell = doc.cells[0]
    const enCell = doc.cells[1]
    doc.marked.push(zhCell.official, enCell.official)
    doc.dispatch('contextmenu', { target: zhCell, preventDefault() {} })
    const overlay = doc.bodyChildren[doc.bodyChildren.length - 1]
    const input = overlayFind(overlay, (n) => n.tag === 'input')
    const save = overlayFind(overlay, (n) => n.tag === 'button' && n.textContent === '保存')
    input.value = 'bell'
    save.handlers.click()
    assert.equal(JSON.parse(win.localStorage.map.get('__navicUserIcons'))['通用设置'], 'bell', '按打开侧语言键落库')
    assert.ok(zhCell.official.innerHTML.includes('M8 2.2'), '中文侧覆盖生效')
    assert.ok(enCell.official.innerHTML.includes('M8 2.2'), '英文侧等价触达重写')
    // 清除:等价组全键删除,两侧回各语言内置映射
    doc.dispatch('contextmenu', { target: enCell, preventDefault() {} })
    const overlay2 = doc.bodyChildren[doc.bodyChildren.length - 1]
    assert.ok(overlayFind(overlay2, (n) => n.tag === 'input').value === 'bell', '英文侧打开回填中文键覆盖')
    const clear2 = overlayFind(overlay2, (n) => n.tag === 'button' && n.textContent === '清除')
    clear2.handlers.click()
    assert.equal(JSON.parse(win.localStorage.map.get('__navicUserIcons'))['通用设置'], undefined, '清除走等价组全键')
    assert.ok(!zhCell.official.innerHTML.includes('M8 2.2'), '中文侧回内置映射')
    assert.ok(!enCell.official.innerHTML.includes('M8 2.2'), '英文侧回内置映射')
  } finally {
    unload()
  }
})

test('用户覆盖:非 nav 单元格右键不弹浮层', () => {
  const { win, doc } = loadClient()
  const unload = boot(win.__loaded, doc)
  try {
    doc.dispatch('contextmenu', { target: doc.avatars[0], preventDefault() {} })
    assert.equal(doc.bodyChildren.length, 0, '头像槽右键无浮层')
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
