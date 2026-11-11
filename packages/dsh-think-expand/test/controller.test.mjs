import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const source = readFileSync(new URL('../src/client.js', import.meta.url), 'utf8')

function fixture(mode = false, deferredClick = false) {
  const timers = new Map(), observers = [], frames = new Map()
  const storage = new Map([['dsh-think-expand:expandAll', mode ? 'on' : 'off']])
  let seq = 0, definition, panel
  const notify = () => observers.filter(o => o.live).forEach(o => o.callback([]))
  const rows = []
  // 过程组按钮桩:turn 号 + 展开态,点击即展开(宿主官方入口)
  const processes = []
  const addProcess = (turn, open = true) => {
    const proc = { turn, open, clicks: 0, isConnected: true, swallow: false,
      getAttribute: key => key === 'data-turn-process' ? turn : key === 'aria-expanded' ? String(proc.open) : null,
      click() { if (proc.swallow) { proc.clicks += 1; notify(); return } proc.open = true; proc.clicks += 1; notify() },
      closest: () => null }
    processes.push(proc); return proc
  }
  const scroll = { isConnected: true, scrollHeight: 1000, scrollTop: 0, clientHeight: 100,
    querySelectorAll(selector) {
      if (selector === '[data-variant="think"]') return rows.filter(r => r.variant === 'think')
      if (selector === '[data-chat-node-key]') return rows.map(r => r.flow)
      if (selector === '[data-disclosure-row]') return rows.map(r => r.head)
      if (selector === '[data-turn-process]') return processes
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
  const add = (variant, text, expanded = false, turn = '1') => {
    const row = { variant, text, state: 'running', open: expanded, clicks: 0, isConnected: true, turn }
    row.head = { hasAttribute: key => key === 'data-disclosure-row', getAttribute: key => key === 'aria-expanded' ? String(row.open) : key === 'data-expandable' ? 'true' : null,
      closest: selector => selector === '[data-disclosure-row]' || selector === '[aria-expanded="true"]' && row.open ? row.head : null,
      click() {
        // 真实点击先经捕获阶段监听(插件在捕获阶段识别用户意图并清闩锁)
        listeners.get('click')?.({ target: row.head })
        const commit = () => { row.open = !row.open; row.clicks++; notify() }
        if (deferredClick) timers.set(++seq, commit)
        else commit()
      } }
    row.closest = selector => selector === '[data-chat-node-key]' || selector === '[data-chat-turn]' ? row.flow : row.hiddenProcess && selector === '[hidden]' ? row.flow : null
    row.getAttribute = key => key === 'data-variant' ? variant : key === 'data-state' ? row.state : null
    row.querySelector = selector => {
      if (selector === '[data-disclosure-row]') return row.head
      if (selector.includes('_content_')) return { textContent: row.open ? '思考' : '思考 ' + text }
      if (selector.includes(variant === 'think' ? 'thinkBody' : 'bodyWrap')) return row.open ? { textContent: row.text } : null
      if (selector === '[data-variant="think"]') return null
      return null
    }
    row.flow = { getAttribute: key => key === 'data-chat-turn' ? row.turn : null, querySelector: selector => selector === '[data-variant="think"]' ? variant === 'think' ? row : null : row.querySelector(selector), closest: selector => selector === '[data-step-process]' ? row.group : selector === '[hidden]' && row.hiddenProcess ? row.flow : null }
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
  addProcess('1', true)
  const manualClick = row => row.head.click()
  // 用户点击过程组标题:捕获阶段先派发真实点击形态(意图在宿主提交后定格)
  const clickProc = proc => listeners.get('click')?.({ target: { closest: selector => selector === '[data-turn-process]' || selector === '[aria-expanded="true"]' ? proc : null } })
  const manualFold = proc => { clickProc(proc); proc.open = false; notify() }
  const manualUnfold = proc => { clickProc(proc); proc.open = true; notify() }
  return { add, addProcess, clickProc, manualFold, manualUnfold, flush, toggle, manualClick, notify, mount, evaluate, rows, processes, observers, timers, frames, scroll, storage, window }
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

for (const deferredClick of [false, true]) for (const variant of ['think', 'others']) {
  test(`Given ${variant}完成后${deferredClick ? '异步' : '同步'}恢复 When 新同类行出现 Then 收起仍由插件负责的旧行`, () => {
    const f = fixture(variant === 'others', deferredClick)
    const old = f.add(variant, '上一回合正文')
    f.mount(); f.flush()
    old.state = 'ok'; old.hiddenProcess = true; old.open = false
    f.notify(); f.flush()
    assert.equal(old.open, true)
    const next = f.add(variant, '新回合正文')
    f.flush()
    assert.equal(old.open, false, '恢复后不能把插件所有权误判为手动展开')
    assert.equal(next.open, true)
  })
}

for (const variant of ['think', 'others']) {
  test(`Given 首扫展开的${variant}行正文未挂载 When 新同类行出现 Then 旧行收起`, () => {
    const f = fixture(variant === 'others', true)
    const old = f.add(variant, '旧正文')
    f.mount(); f.flush()
    old.state = 'ok'
    const next = f.add(variant, '新正文')
    f.notify(); f.flush()
    assert.equal(old.open, false, '正文未挂载期间展开的旧行也要被新行接管')
    assert.equal(next.open, true)
  })
}

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

test('Given 最新回合过程组折叠 When 首扫 Then 展开过程组一次', () => {
  const f = fixture()
  const proc = f.addProcess('2', false)
  f.add('think', '新回合思考', false, '2')
  f.mount(); f.flush()
  assert.equal(proc.clicks, 1)
  assert.equal(proc.open, true)
  f.notify(); f.flush()
  assert.equal(proc.clicks, 1, '展开后不重复点击')
})

test('Given 用户手动收起最新回合过程组 When 后续扫描 Then 不再自动展开', () => {
  const f = fixture()
  const proc = f.addProcess('2', true)
  f.add('think', '新回合思考', false, '2')
  f.mount(); f.flush()
  f.manualFold(proc)
  f.notify(); f.flush()
  assert.equal(proc.clicks, 0)
  assert.equal(proc.open, false)
})

test('Given 用户收起最新回合过程组 When 再次展开 Then 插件恢复自动展开末思考行', () => {
  const f = fixture()
  const proc = f.addProcess('1', true)
  const think = f.add('think', '末段思考')
  f.mount(); f.flush()
  assert.equal(think.open, true)
  const clicksAfterExpand = think.clicks
  f.manualFold(proc)
  f.flush()
  // 宿主隐藏过程组内容时子折叠一并归为收起
  think.open = false
  think.hiddenProcess = true
  f.notify(); f.flush()
  assert.equal(think.open, false, '过程组收起期间不重开行')
  assert.equal(proc.clicks, 0, '用户收起后不自动展开过程组')
  assert.equal(think.clicks, clicksAfterExpand, '收起期间不点击行')
  f.manualUnfold(proc)
  f.flush()
  assert.equal(think.open, true, '重新展开过程组后恢复自动展开')
})

test('Given 全部消息模式用户收起过程组后再次展开 Then 工具机恢复展开末工具行', () => {
  const f = fixture(true)
  const proc = f.addProcess('1', true)
  const tool = f.add('others', '末段工具正文')
  f.mount(); f.flush()
  assert.equal(tool.open, true)
  const clicksAfterExpand = tool.clicks
  f.manualFold(proc)
  f.flush()
  tool.open = false
  tool.hiddenProcess = true
  f.notify(); f.flush()
  assert.equal(tool.clicks, clicksAfterExpand, '收起期间不点击工具行')
  f.manualUnfold(proc)
  f.flush()
  assert.equal(tool.open, true, '重新展开过程组后恢复自动展开工具行')
})

test('Given 插件已展开最新回合过程组 When 宿主再次收起 Then 插件重新展开', () => {
  const f = fixture()
  const proc = f.addProcess('1', false)
  f.add('think', '新回合思考')
  f.mount(); f.flush()
  assert.equal(proc.clicks, 1, '首扫展开过程组')
  // 宿主回合完成时折叠过程组:展开记录已随 open 态清空,应可再次展开
  proc.open = false
  f.notify(); f.flush()
  assert.equal(proc.clicks, 2, '宿主折叠后再次自动展开')
})

test('Given 上一回合过程组已收起 When 新回合流式行出现 Then 仍自动展开新行', () => {
  const f = fixture()
  const proc = f.addProcess('1', true)
  const old = f.add('think', '旧回合思考')
  f.mount(); f.flush()
  f.manualFold(proc)
  f.flush()
  // 宿主隐藏过程组内容:旧行折叠头归为收起并带 hidden 祖先
  old.state = 'ok'
  old.open = false
  old.hiddenProcess = true
  f.notify(); f.flush()
  assert.equal(old.open, false)
  // 新回合进行中:该回合没有过程组按钮,流式思考行已可见
  const next = f.add('think', '新回合思考', false, '2')
  f.flush()
  assert.equal(next.open, true, '旧回合收起不应阻塞新回合自动展开')
  assert.equal(next.clicks, 1)
})

test('Given 全部消息模式上一回合过程组已收起 When 新回合只出现工具行 Then 工具机仍展开新行', () => {
  const f = fixture(true)
  const proc = f.addProcess('1', true)
  const old = f.add('others', '旧回合工具正文')
  f.mount(); f.flush()
  assert.equal(old.open, true)
  f.manualFold(proc)
  f.flush()
  old.state = 'ok'
  old.open = false
  old.hiddenProcess = true
  f.notify(); f.flush()
  // 新回合进行中:没有过程组按钮,只出现工具行
  const next = f.add('others', '新回合工具正文', false, '2')
  f.flush()
  assert.equal(next.open, true, '旧回合收起不应阻塞新回合工具行')
  assert.equal(proc.open, false, '旧回合过程组保持收起')
  assert.equal(old.open, false, '旧回合工具行不被重开')
})

test('Given 全部消息模式用户收起回合过程组 When 新回合思考行出现 Then 旧工具行不重开', () => {
  const f = fixture(true)
  const proc = f.addProcess('1', true)
  const tool = f.add('others', '工具正文')
  f.mount(); f.flush()
  assert.equal(tool.open, true)
  f.manualFold(proc)
  f.flush()
  tool.open = false
  tool.hiddenProcess = true
  f.notify(); f.flush()
  const next = f.add('think', '新回合思考', false, '2')
  f.flush()
  assert.equal(next.open, true)
  assert.equal(tool.open, false, '用户收起的回合工具行不重开')
  assert.equal(proc.open, false)
})

test('Given 过程组点击被宿主吞掉 When settle Then 不登记收起意图', () => {
  const f = fixture()
  const proc = f.addProcess('1', true)
  proc.swallow = true
  f.add('think', '思考')
  f.mount(); f.flush()
  const clicksAfterMount = proc.clicks
  // 点击被吞:捕获阶段记账后宿主未提交,settle 应回滚,不留下 manual
  f.clickProc(proc)
  proc.click()
  f.flush()
  assert.equal(proc.open, true)
  // 宿主之后自动折叠过程组:未被标记 manual,应重新展开
  proc.swallow = false
  proc.open = false
  f.notify(); f.flush()
  assert.equal(proc.open, true, '吞掉的点击不应阻止自动展开')
  assert.ok(proc.clicks > clicksAfterMount + 1)
})

test('Given 全部消息模式旧回合思考行随过程组收起 When 新回合只出现工具行 Then 旧思考行不重开', () => {
  const f = fixture(true)
  const proc = f.addProcess('1', true)
  const oldThink = f.add('think', '旧回合思考')
  const oldTool = f.add('others', '旧回合工具正文')
  f.mount(); f.flush()
  assert.equal(oldThink.open, true)
  f.manualFold(proc)
  f.flush()
  oldThink.state = 'ok'
  oldThink.open = false
  oldThink.hiddenProcess = true
  oldTool.open = false
  oldTool.hiddenProcess = true
  f.notify(); f.flush()
  const next = f.add('others', '新回合工具正文', false, '2')
  f.flush()
  assert.equal(next.open, true, '新回合工具行自动展开')
  assert.equal(oldThink.open, false, '旧回合思考行不重开')
  assert.equal(oldTool.open, false, '旧回合工具行不重开')
})

test('Given 旧回合思考行收起未读 When 最新回合过程组手动收起后新回合出现 Then 旧行不重开', () => {
  const f = fixture()
  const old = f.add('think', '旧回合思考')
  const latest = f.add('think', '最新回合思考', false, '2')
  old.state = 'ok'
  old.open = false
  f.mount(); f.flush()
  const proc2 = f.addProcess('2', true)
  f.manualFold(proc2)
  f.flush()
  latest.state = 'ok'
  latest.open = false
  latest.hiddenProcess = true
  f.notify(); f.flush()
  const next = f.add('think', '新回合思考', false, '3')
  f.flush()
  assert.equal(next.open, true)
  assert.equal(old.open, false, '旧回合行不被回退展开')
  assert.equal(latest.open, false, '手动回合保持收起')
})

test('Given 旧回合工具行收起未读 When 最新回合过程组手动收起后新回合出现 Then 旧工具行不重开', () => {
  const f = fixture(true)
  const oldTool = f.add('others', '旧回合工具正文')
  const latestTool = f.add('others', '最新回合工具正文', false, '2')
  oldTool.state = 'ok'
  oldTool.open = false
  f.mount(); f.flush()
  const proc2 = f.addProcess('2', true)
  f.manualFold(proc2)
  f.flush()
  latestTool.state = 'ok'
  latestTool.open = false
  latestTool.hiddenProcess = true
  f.notify(); f.flush()
  const next = f.add('think', '新回合思考', false, '3')
  f.flush()
  assert.equal(next.open, true)
  assert.equal(oldTool.open, false, '旧工具行不被回退展开')
  assert.equal(latestTool.open, false, '手动回合工具行保持收起')
})

test('Given 最新回合过程组收起且只剩更旧可见行 When 扫描 Then 不展开旧行', () => {
  const f = fixture()
  const old = f.add('think', '旧回合思考')
  f.mount(); f.flush()
  old.open = false
  const proc2 = f.addProcess('2', false)
  f.manualFold(proc2)
  f.flush()
  assert.equal(old.open, false, '更旧的可展开行不越过收起意图')
})

test('Given 进行中回合的过程组按钮收起 When 同期思考行可见 Then 仍展开该行', () => {
  const f = fixture()
  const proc = f.addProcess('1', false)
  proc.swallow = true
  const think = f.add('think', '流式思考')
  f.mount(); f.flush()
  assert.equal(think.open, true, '可见的同期行不受收起按钮影响')
})

test('Given 旧回合插件行被隐藏 When 新回合已出现 Then 不恢复旧回合末行', () => {
  const f = fixture()
  const old = f.add('think', '旧回合思考')
  f.mount(); f.flush()
  assert.equal(old.open, true)
  old.state = 'ok'; old.hiddenProcess = true; old.open = false
  f.addProcess('2', true)
  const next = f.add('think', '新回合思考', false, '2')
  f.notify(); f.flush()
  assert.equal(old.reveals ?? 0, 0, '旧回合 current 不恢复')
  assert.equal(old.open, false)
  assert.equal(next.open, true)
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
