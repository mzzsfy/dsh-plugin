import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const source = readFileSync(new URL('../src/client.js', import.meta.url), 'utf8')

function loadPlugin() {
  let registered
  const window = { __ModuleLoader__: { load: (entry) => { registered = entry } } }
  new Function('window', source)(window)
  return registered.factory(() => { throw new Error('no modules') })
}

function fakeClock() {
  let now = 0
  let nextId = 0
  const intervals = new Map()
  const fireDue = () => {
    for (const [id, timer] of [...intervals]) {
      if (timer.at <= now) {
        timer.at = now + timer.every
        timer.fn()
      }
    }
  }
  return {
    now: () => now,
    setInterval: (fn, ms) => { const id = ++nextId; intervals.set(id, { fn, every: ms, at: now + ms }); return id },
    clearInterval: (id) => { intervals.delete(id) },
    advance(ms) {
      const target = now + ms
      while (true) {
        const due = [...intervals.values()].map((timer) => timer.at).filter((at) => at <= target)
        if (due.length === 0) break
        now = Math.min(...due)
        fireDue()
      }
      now = target
    },
    // 只推进时间、不派发定时器, 模拟标签页冻结/系统睡眠期间定时器被挂起
    jump(ms) {
      now += ms
      for (const timer of intervals.values()) timer.at = now + timer.every
    },
    intervalCount: () => intervals.size,
  }
}

function fakeNode(tag) {
  const node = {
    tag,
    attrs: {},
    children: [],
    listeners: {},
    textContent: '',
    className: '',
    type: '',
    style: {},
    setAttribute(key, value) { node.attrs[key] = String(value) },
    appendChild(child) { node.children.push(child); child.parent = node; return child },
    remove() { const parent = node.parent; if (parent !== undefined) parent.children = parent.children.filter((item) => item !== node) },
    addEventListener(type, fn) { (node.listeners[type] ??= []).push(fn) },
    click() { for (const fn of node.listeners.click ?? []) fn({}) },
    get childElementCount() { return node.children.length },
    get lastElementChild() { return node.children.at(-1) ?? null },
    hasAttribute(name) { return node.attrs[name] !== undefined },
    getAttribute(name) { return node.attrs[name] ?? null },
    closest(selector) {
      const attribute = selector.startsWith('[') && selector.endsWith(']') ? selector.slice(1, -1) : null
      if (attribute === null) return null
      let current = node
      while (current !== undefined) {
        if (current.attrs?.[attribute] !== undefined) return current
        current = current.parent
      }
      return null
    },
    querySelectorAll(selector) {
      const attribute = selector.startsWith('[') && selector.endsWith(']') ? selector.slice(1, -1) : null
      const found = []
      const walk = (current) => {
        for (const child of current.children ?? []) {
          if (attribute !== null && child.attrs?.[attribute] !== undefined) found.push(child)
          walk(child)
        }
      }
      walk(node)
      return found
    },
    querySelector(selector) {
      if (!selector.startsWith('[') || !selector.endsWith(']')) return null
      const attribute = selector.slice(1, -1)
      const walk = (current) => {
        for (const child of current.children ?? []) {
          if (child.attrs?.[attribute] !== undefined) return child
          const found = walk(child)
          if (found !== null) return found
        }
        return null
      }
      return walk(node)
    },
    allText() { return node.textContent + node.children.map((child) => child.allText()).join('') },
  }
  return node
}

const HINT_TEXT = '载入历史…'

function fakePage({ loading = true, hasFlow = true, messages = false, visibilityState = 'visible' } = {}) {
  const head = fakeNode('head')
  const body = fakeNode('body')
  const flow = fakeNode('div')
  const hint = fakeNode('div')
  hint.textContent = HINT_TEXT
  const message = fakeNode('div')
  message.attrs['data-chat-flow-key'] = 'turn-1'
  message.textContent = '为什么一直显示载入历史…'
  const setFlow = (value) => { flow.children = value ? [hint] : (messages ? [message] : []) }
  setFlow(loading)
  const doc = {
    head,
    body,
    visibilityState,
    querySelector(selector) {
      if (selector === '[data-chat-flow]') return hasFlow ? flow : null
      if (selector.startsWith('style[data-plugin=')) {
        const plugin = selector.match(/data-plugin="([^"]+)"/)?.[1]
        return head.children.find((node) => node.tag === 'style' && node.attrs['data-plugin'] === plugin) ?? null
      }
      return null
    },
    createElement(tag) { return fakeNode(tag) },
    getElementById(id) { return [...body.children, ...head.children].find((node) => node.attrs.id === id) ?? null },
  }
  const reloads = { count: 0 }
  const win = {
    document: doc,
    location: { reload() { reloads.count += 1 } },
  }
  return { doc, win, flow, hint, reloads, setLoading: (value) => setFlow(value) }
}

const OPTIONS = { checkMs: 2000, stallMs: 8000, reconnect: true, maxReconnectAttempts: 3, reconnectIntervalMs: 4000 }

function fakeConnection() {
  const calls = []
  return {
    calls,
    reconnect() { calls.push(true) },
  }
}

function install({ options = {}, page = fakePage(), connection = fakeConnection() } = {}) {
  const plugin = loadPlugin()
  const clock = fakeClock()
  const result = plugin.__test.installStuckSession({ win: page.win, options: { ...OPTIONS, ...options }, clock, connection })
  return { plugin, clock, result, page, connection }
}

const noticeOf = (page) => page.doc.getElementById('dsh-bug-perf-stuck')

// Given 会话停在加载态, When 未到停滞阈值, Then 不请求重连
test('停滞_未到阈值_不重连', () => {
  const { clock, connection } = install()
  clock.advance(2000 * 3)
  assert.equal(connection.calls.length, 0)
})

// Given 会话停滞超过阈值, When 轮询, Then 请求宿主重建连接一次
test('停滞_超过阈值_请求重连', () => {
  const { clock, connection } = install()
  clock.advance(2000 * 5)
  assert.equal(connection.calls.length, 1)
})

// Given 刚请求过重连, When 仍在重连间隔内, Then 不重复请求
test('停滞_重连间隔内_不重复', () => {
  const { clock, connection } = install()
  clock.advance(2000 * 5)
  assert.equal(connection.calls.length, 1)
  clock.advance(2000)
  assert.equal(connection.calls.length, 1)
  clock.advance(2000 * 4)
  assert.equal(connection.calls.length, 2)
})

// Given 多次重连仍未恢复, When 用尽重连次数, Then 停止重连并显示提示
test('停滞_用尽次数_显示提示', () => {
  const { clock, page, connection } = install()
  clock.advance(2000 * 40)
  assert.equal(connection.calls.length, 3)
  assert.ok(noticeOf(page) !== null)
})

// Given 提示已出现, When 会话稳定恢复, Then 提示移除且重连计数清零
test('停滞_恢复_重置并隐藏', () => {
  const { clock, page, connection } = install()
  clock.advance(2000 * 40)
  assert.ok(noticeOf(page) !== null)
  page.setLoading(false)
  clock.advance(2000)
  assert.equal(noticeOf(page), null)
  clock.advance(2000 * 4)
  page.setLoading(true)
  clock.advance(2000 * 5)
  assert.equal(connection.calls.length, 4)
})

// Given 一键恢复只维持一个周期(重连清流的一帧), When 随即再次停滞, Then 不清零重连计数
test('停滞_短暂恢复_不清零计数', () => {
  const { clock, page, connection } = install()
  clock.advance(2000 * 40)
  assert.equal(connection.calls.length, 3)
  page.setLoading(false)
  clock.advance(2000)
  page.setLoading(true)
  clock.advance(2000 * 20)
  assert.equal(connection.calls.length, 3)
  assert.ok(noticeOf(page) !== null)
})

// Given 加载态里仍在推进(节点持续增加), When 每轮都有变化, Then 停滞计时不断重置,不重连
test('停滞_加载有进展_不重连', () => {
  const page = fakePage()
  const { clock, connection } = install({ page })
  for (let i = 0; i < 30; i++) {
    const progress = fakeNode('span')
    progress.textContent = `已载入 ${i}`
    page.flow.appendChild(progress)
    clock.advance(2000)
  }
  assert.equal(connection.calls.length, 0)
  assert.equal(noticeOf(page), null)
})

// Given 加载推进了若干轮后再次停住, When 无进展超过阈值, Then 仍判定停滞并重连
test('停滞_进展停止_仍触发', () => {
  const page = fakePage()
  const { clock, connection } = install({ page })
  for (let i = 0; i < 3; i++) {
    const progress = fakeNode('span')
    progress.textContent = `已载入 ${i}`
    page.flow.appendChild(progress)
    clock.advance(2000)
  }
  clock.advance(2000 * 4)
  assert.equal(connection.calls.length, 1)
})

// Given 页面不可见(后台标签页), When 加载态持续很久, Then 不判定停滞、不重连
test('停滞_页面不可见_不判定', () => {
  const page = fakePage({ visibilityState: 'hidden' })
  const { clock, connection } = install({ page })
  clock.advance(2000 * 60)
  assert.equal(connection.calls.length, 0)
  assert.equal(noticeOf(page), null)
})

// Given 后台期间页面曾处于加载态, When 切回前台, Then 重新计时,不拿后台时间差立即重连
test('停滞_后台切回_重新计时', () => {
  const page = fakePage()
  const { clock, connection } = install({ page })
  clock.advance(2000 * 2)
  page.doc.visibilityState = 'hidden'
  clock.advance(2000 * 30)
  page.doc.visibilityState = 'visible'
  clock.advance(2000)
  assert.equal(connection.calls.length, 0)
  clock.advance(2000 * 4)
  assert.equal(connection.calls.length, 1)
})

// Given 标签页被冻结导致定时器一整个期间不派发, When 恢复后的首个 tick, Then 作废旧计时而不是立刻重连
test('停滞_定时器挂起_重新计时', () => {
  const page = fakePage()
  const { clock, connection } = install({ page })
  clock.advance(2000 * 2)
  clock.jump(600000)
  clock.advance(2000)
  assert.equal(connection.calls.length, 0)
  clock.advance(2000 * 5)
  assert.equal(connection.calls.length, 1)
})

// Given 新默认阈值(60s/2次/120s), When 持续停滞, Then 首连不早于 60 秒、次连不早于 180 秒、提示在其后
test('停滞_生产默认值_时序', () => {
  const page = fakePage()
  const plugin = loadPlugin()
  const clock = fakeClock()
  const connection = fakeConnection()
  const options = { checkMs: 3000, stallMs: 60000, reconnect: true, maxReconnectAttempts: 2, reconnectIntervalMs: 120000 }
  plugin.__test.installStuckSession({ win: page.win, options, clock, connection })
  clock.advance(3000 * 19)
  assert.equal(connection.calls.length, 0)
  clock.advance(3000 * 2)
  assert.equal(connection.calls.length, 1)
  clock.advance(3000 * 40)
  assert.equal(connection.calls.length, 2)
  clock.advance(3000 * 21)
  assert.equal(connection.calls.length, 2)
  assert.ok(noticeOf(page) !== null)
})

// Given 没有 connection 服务, When 会话停滞, Then 不重连,直接显示提示
test('停滞_无连接服务_直接提示', () => {
  const page = fakePage()
  const plugin = loadPlugin()
  const clock = fakeClock()
  plugin.__test.installStuckSession({ win: page.win, options: OPTIONS, clock, connection: undefined })
  clock.advance(2000 * 6)
  assert.ok(noticeOf(page) !== null)
})

// Given 宿主拒绝重连调用, When 会话停滞, Then 不抛出,退化为提示
test('停滞_重连抛错_退化为提示', () => {
  const page = fakePage()
  const plugin = loadPlugin()
  const clock = fakeClock()
  const connection = { reconnect() { throw new Error('boom') } }
  plugin.__test.installStuckSession({ win: page.win, options: OPTIONS, clock, connection })
  clock.advance(2000 * 6)
  assert.ok(noticeOf(page) !== null)
})

// Given 配置关闭主动重连, When 会话停滞, Then 不调用 reconnect,只显示提示
test('停滞_关闭重连_只提示', () => {
  const { clock, page, connection } = install({ options: { reconnect: false } })
  clock.advance(2000 * 40)
  assert.equal(connection.calls.length, 0)
  assert.ok(noticeOf(page) !== null)
})

// Given 普通会话已有消息节点, When 正文里出现加载文案的字样, Then 不判定停滞
test('停滞_正文含文案_不触发', () => {
  const page = fakePage({ loading: false, messages: true })
  const { clock, connection } = install({ page })
  clock.advance(2000 * 60)
  assert.equal(connection.calls.length, 0)
  assert.equal(noticeOf(page), null)
})

// Given 加载态里残留的只是分组行, When 持续超过阈值, Then 仍判定停滞(分组行不算有效消息)
test('停滞_仅分组行_仍触发', () => {
  const page = fakePage()
  const group = fakeNode('div')
  group.attrs['data-chat-flow-key'] = 'group-1'
  group.attrs['data-chat-group-key'] = 'group-1'
  group.textContent = '第 1 轮'
  page.flow.appendChild(group)
  const { clock, connection } = install({ page })
  clock.advance(2000 * 5)
  assert.equal(connection.calls.length, 1)
})

// Given 加载态里残留的是隐藏行或空行, When 持续超过阈值, Then 仍判定停滞
test('停滞_隐藏或空行_仍触发', () => {
  const page = fakePage()
  const hidden = fakeNode('div')
  hidden.attrs['data-chat-flow-key'] = 'turn-hidden'
  hidden.attrs.hidden = 'hidden'
  hidden.textContent = '旧消息'
  const empty = fakeNode('div')
  empty.attrs['data-chat-flow-key'] = 'turn-empty'
  page.flow.appendChild(hidden)
  page.flow.appendChild(empty)
  const { clock, connection } = install({ page })
  clock.advance(2000 * 5)
  assert.equal(connection.calls.length, 1)
})

// Given 残留行在隐藏容器里, When 持续超过阈值, Then 仍判定停滞(隐藏子树不算有效消息)
test('停滞_隐藏祖先内的行_仍触发', () => {
  const page = fakePage()
  const wrapper = fakeNode('div')
  wrapper.attrs.hidden = 'hidden'
  const row = fakeNode('div')
  row.attrs['data-chat-flow-key'] = 'turn-collapsed'
  row.textContent = '折叠起来的旧消息'
  wrapper.appendChild(row)
  page.flow.appendChild(wrapper)
  const { clock, connection } = install({ page })
  clock.advance(2000 * 5)
  assert.equal(connection.calls.length, 1)
})

// Given 非会话视图(没有 chat 容器), When 长时间无加载文案, Then 不插入提示、不重连
test('停滞_无会话视图_不触发', () => {
  const page = fakePage({ hasFlow: false })
  const { clock, connection } = install({ page })
  clock.advance(2000 * 60)
  assert.equal(noticeOf(page), null)
  assert.equal(connection.calls.length, 0)
})

// Given 补丁已安装, When 再次安装(HMR 重放), Then 拒绝重复安装,不叠加定时器
test('停滞_重复安装_幂等', () => {
  const page = fakePage()
  const { plugin, clock } = install({ page })
  const second = plugin.__test.installStuckSession({ win: page.win, options: OPTIONS, clock, connection: fakeConnection() })
  assert.equal(second.installed, false)
  assert.equal(second.reason, 'already installed')
  clock.advance(2000 * 5)
  const notices = page.doc.body.children.filter((node) => node.attrs.id === 'dsh-bug-perf-stuck')
  assert.equal(notices.length, 0)
  const styles = page.doc.head.children.filter((node) => node.tag === 'style')
  assert.equal(styles.length, 1)
})

// Given 提示重复轮询, When 页面渲染多次, Then 提示节点只有一个(幂等)
test('停滞_重复轮询_提示幂等', () => {
  const page = fakePage()
  const { clock } = install({ page, options: { reconnect: false } })
  clock.advance(2000 * 12)
  clock.advance(2000 * 3)
  const notices = page.doc.body.children.filter((node) => node.attrs.id === 'dsh-bug-perf-stuck')
  assert.equal(notices.length, 1)
})

// Given 样式注入, When 安装补丁, Then style 节点带 data-plugin 标记
test('停滞_样式注入_带插件标记', () => {
  const { page } = install()
  const styles = page.doc.head.children.filter((node) => node.tag === 'style')
  assert.equal(styles.length, 1)
  assert.equal(styles[0].attrs['data-plugin'], '@mzzsfy/dsh-bug-perf')
})

// Given 宿主重建删掉了本插件样式, When 再次安装, Then 样式重新注入且不叠加定时器
test('停滞_样式被删后重装_重新注入', () => {
  const page = fakePage()
  const { plugin, clock } = install({ page })
  page.doc.head.children = []
  const second = plugin.__test.installStuckSession({ win: page.win, options: OPTIONS, clock, connection: fakeConnection() })
  assert.equal(second.installed, false)
  assert.equal(second.reason, 'already installed')
  const styles = page.doc.head.children.filter((node) => node.tag === 'style')
  assert.equal(styles.length, 1)
  assert.equal(styles[0].attrs['data-plugin'], '@mzzsfy/dsh-bug-perf')
})
