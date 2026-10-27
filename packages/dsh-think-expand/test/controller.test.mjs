import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const source = readFileSync(new URL('../src/client.js', import.meta.url), 'utf8')

function fixture(mode = false) {
  const timers = new Map(), observers = [], frames = new Map()
  const storage = new Map([['dsh-think-expand:expandAll', mode ? 'on' : 'off']])
  let seq = 0, definition, panel
  const notify = () => observers.filter(o => o.live).forEach(o => o.callback([]))
  const rows = []
  const scroll = { isConnected: true, scrollHeight: 1000, scrollTop: 0, clientHeight: 100,
    querySelectorAll(selector) {
      if (selector === '[data-variant="think"]') return rows.filter(r => r.variant === 'think')
      if (selector === '[data-chat-node-key]') return rows.map(r => r.flow)
      if (selector === '[data-disclosure-row]') return rows.map(r => r.head)
      return []
    },
  }
  const listeners = new Map()
  scroll.addEventListener = (name, fn) => listeners.set(name, fn)
  scroll.removeEventListener = (name, fn) => { if (listeners.get(name) === fn) listeners.delete(name) }
  scroll.contains = el => rows.some(row => row === el || row.flow === el || row.head === el)
  const document = {
    body: {}, head: { appendChild() {} },
    querySelector: selector => selector === '[data-conversation-scroll]' ? scroll : null,
    createElement: () => ({ setAttribute() {}, remove() {} }),
  }
  const window = { localStorage: { getItem: k => storage.get(k), setItem: (k, v) => storage.set(k, v) },
    __ModuleLoader__: { load(module) { definition = module.factory(() => React) } },
  }
  const React = {
    useState: initial => [typeof initial === 'function' ? initial() : true, () => {}],
    useCallback: f => f,
    createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
  }
  class Observer {
    constructor(callback) { this.callback = callback; this.live = false; observers.push(this) }
    observe() { this.live = true }
    disconnect() { this.live = false }
  }
  const evaluate = () => new Function('window', 'document', 'MutationObserver', 'setTimeout', 'clearTimeout', 'requestAnimationFrame', 'cancelAnimationFrame', source)(
    window, document, Observer,
    f => { const id = ++seq; timers.set(id, f); return id }, id => timers.delete(id),
    f => { const id = ++seq; frames.set(id, f); return id }, id => frames.delete(id),
  )
  const mount = () => {
    const cleanups = []
    definition.apply({ effect: f => { const cleanup = f(); if (cleanup) cleanups.push(cleanup) }, slots: {
      inject: (_, f) => f(), register: (_, f) => { panel = f().type },
    } })
    return () => cleanups.reverse().forEach(f => f())
  }
  const flush = () => {
    for (let n = 0; timers.size && n < 30; n++) {
      const batch = [...timers.values()]; timers.clear(); batch.forEach(f => f())
    }
    assert.equal(timers.size, 0, '控制器扫描应收敛')
  }
  const add = (variant, text, expanded = false) => {
    const row = { variant, text, state: 'running', open: expanded, clicks: 0, isConnected: true }
    row.head = { hasAttribute: key => key === 'data-disclosure-row', getAttribute: key => key === 'aria-expanded' ? String(row.open) : key === 'data-expandable' ? 'true' : null,
      closest: selector => selector === '[data-disclosure-row]' || selector === '[aria-expanded="true"]' && row.open ? row.head : null,
      click() { row.open = !row.open; row.clicks++; notify() } }
    row.closest = selector => selector === '[data-chat-node-key]' ? row.flow : row.hiddenProcess && selector === '[hidden]' ? row.flow : null
    row.getAttribute = key => key === 'data-variant' ? variant : key === 'data-state' ? row.state : null
    row.querySelector = selector => {
      if (selector === '[data-disclosure-row]') return row.head
      if (selector.includes('_content_')) return { textContent: row.open ? '思考' : '思考 ' + text }
      if (selector.includes(variant === 'think' ? 'thinkBody' : 'bodyWrap')) return row.open ? { textContent: row.text } : null
      if (selector === '[data-variant="think"]') return null
      return null
    }
    row.flow = { getAttribute: key => key === 'data-chat-turn' ? '1' : null, querySelector: selector => selector === '[data-variant="think"]' ? variant === 'think' ? row : null : row.querySelector(selector), closest: selector => selector === '[data-step-process]' ? row.group : null }
    row.group = { querySelector: () => row.groupHead }
    row.parentElement = row.flow
    row.hasAttribute = () => false
    row.flow.parentElement = null
    row.flow.hasAttribute = key => key === 'hidden' && row.hiddenProcess
    row.flow.dispatchEvent = event => { assert.equal(event.type, 'beforematch'); row.hiddenProcess = false; row.reveals = (row.reveals ?? 0) + 1; notify() }
    rows.push(row); notify(); return row
  }
  const walk = node => !node || typeof node !== 'object' ? [] : [node, ...node.children.flat(Infinity).flatMap(walk)]
  const toggle = value => {
    const input = walk(panel()).find(n => n.type === 'input')
    assert.ok(input)
    input.props.onChange({ target: { checked: value } })
    flush()
  }
  evaluate()
  const manualClick = row => { listeners.get('click')?.({ target: row.head }); row.head.click() }
  return { add, flush, toggle, manualClick, notify, mount, evaluate, rows, observers, timers, frames, scroll, storage, window }
}

test('Given 思考后出现工具 When 开启工具机 Then 思考与工具各自保持展开', () => {
  const f = fixture(true)
  const think = f.add('think', '独立思考正文')
  f.mount(); f.flush()
  const tool = f.add('others', '工具输出')
  f.flush()
  assert.equal(think.open, true, '工具不能接管思考行')
  assert.equal(tool.open, true)
})

test('Given 思考已读 When 双向实时切换工具开关 Then 思考不被重开', () => {
  const f = fixture()
  const think = f.add('think', '独立思考正文')
  f.mount(); f.flush()
  think.head.click(); f.flush()
  assert.equal(think.open, false)
  f.toggle(true)
  assert.equal(think.open, false, '开启工具不清空思考已读')
  f.toggle(false)
  assert.equal(think.open, false)
})

test('Given 插件展开思考 When 用户收起且正文继续追加 Then 本行不重开', () => {
  const f = fixture()
  const think = f.add('think', '第一段思考')
  f.mount(); f.flush()
  think.head.click(); f.flush()
  think.text += ' 后续追加'
  f.notify(); f.flush()
  assert.equal(think.open, false)
})

test('Given 各有插件展开行 When 新思考出现 Then 只接管旧思考并保留工具', () => {
  const f = fixture(true)
  const think = f.add('think', '旧思考')
  const tool = f.add('others', '工具正文')
  f.mount(); f.flush()
  think.state = 'ok'
  const next = f.add('think', '新思考')
  f.flush()
  assert.deepEqual([think.open, tool.open, next.open], [false, true, true])
})

test('Given 插件工具展开 When 同容器反复切换 Then 关闭收起工具且开启恢复工具', () => {
  const f = fixture(true)
  const think = f.add('think', '思考正文')
  const tool = f.add('others', '工具正文')
  f.mount(); f.flush()
  const thinkClicks = think.clicks
  for (let n = 0; n < 3; n++) {
    f.toggle(false)
    assert.deepEqual([think.open, tool.open], [true, false])
    f.toggle(true)
    assert.deepEqual([think.open, tool.open], [true, true])
  }
  assert.equal(think.clicks, thinkClicks, '切换不点击思考行')
})

test('Given 工具手动收起再重开 When 关闭工具机 Then 手动工具保持展开', () => {
  const f = fixture(true)
  const tool = f.add('others', '工具正文')
  f.mount(); f.flush()
  tool.head.click(); f.flush()
  tool.head.click(); f.flush()
  f.toggle(false)
  assert.equal(tool.open, true)
})

test('Given 已读思考且工具尚未出现 When 新工具触发首次初始化 Then 思考不被补开', () => {
  const f = fixture(true)
  const think = f.add('think', '思考正文')
  f.mount(); f.flush()
  think.state = 'ok'
  think.head.click(); f.flush()
  const tool = f.add('others', '新工具')
  f.flush()
  assert.deepEqual([think.open, tool.open], [false, true])
})

test('Given 最新思考由插件展开 When 宿主完成时隐藏过程并重置折叠 Then 恢复正文可见', () => {
  const f = fixture()
  const think = f.add('think', '末段思考')
  f.mount(); f.flush()
  think.state = 'ok'; think.hiddenProcess = true; think.open = false
  f.notify(); f.flush()
  assert.equal(think.hiddenProcess, false)
  assert.equal(think.open, true)
})

test('Given 用户主动收起末思考 When 随后宿主隐藏过程 Then 不重新展开', () => {
  const f = fixture()
  const think = f.add('think', '已读末段思考')
  f.mount(); f.flush()
  f.manualClick(think)
  think.state = 'ok'; think.hiddenProcess = true
  f.notify(); f.flush()
  assert.equal(think.hiddenProcess, true)
  assert.equal(think.open, false)
})

test('Given 用户刚收起工具 When 不等防抖立即关闭再开启 Then 已读工具不重开', () => {
  const f = fixture(true)
  const tool = f.add('others', '工具正文')
  f.mount(); f.flush()
  tool.head.click()
  f.toggle(false)
  f.toggle(true)
  assert.equal(tool.open, false)
})

test('Given 关闭期间手动打开工具 When 开启并出现新工具 Then 手动工具不被收回', () => {
  const f = fixture()
  const manual = f.add('others', '手动工具')
  f.mount(); f.flush()
  manual.head.click(); f.flush()
  f.toggle(true)
  f.add('others', '新工具'); f.flush()
  assert.equal(manual.open, true)
})

test('Given 首扫已排队 When 禁用并投递旧观察器与计时回调 Then 无点击且重启仅一套控制器', () => {
  const f = fixture()
  const think = f.add('think', '思考正文')
  const dispose = f.mount()
  const callbacks = [...f.timers.values(), ...f.observers.map(o => o.callback)]
  dispose()
  callbacks.forEach(fn => fn())
  f.flush()
  assert.equal(think.clicks, 0)
  assert.equal(f.observers.filter(o => o.live).length, 0)
  f.mount(); f.flush()
  assert.equal(think.clicks, 1)
  assert.equal(f.observers.filter(o => o.live).length, 2)
})

test('Given 展开已排滚动帧 When 卸载并投递旧帧 Then 不写滚动不复活帧', () => {
  const f = fixture()
  f.scroll.scrollTop = 900
  f.add('think', '思考正文')
  const dispose = f.mount()
  f.flush()
  const callbacks = [...f.frames.values()]
  assert.ok(callbacks.length > 0)
  dispose()
  f.scroll.scrollHeight += 100
  const top = f.scroll.scrollTop
  callbacks.forEach(fn => fn())
  assert.equal(f.scroll.scrollTop, top)
  assert.equal(f.frames.size, 0)
})
