// 插话撤回(steer recall)接线与纯函数测试:加载真实 src/client.js,
// 捕获 slots.register 断言 dock 条目结构,切片实例化纯函数锁定撤回动作与失败文案。
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const PKG_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const CLIENT_SRC = readFileSync(join(PKG_ROOT, 'src', 'client.js'), 'utf8')

// 加载 client.js 并执行 apply(mock 最小服务面),返回插槽注册捕获。
// slots.inject 收到注册回调即同步执行;binding 桩仅对会话 s1 生效
function loadClient({ binding, remoteSession } = {}) {
  const modules = []
  const registered = []
  const injectedNames = []
  const windowStub = { __ModuleLoader__: { load: (module) => modules.push(module) }, addEventListener: () => {} }
  const reactStub = {
    useState: (value) => [value, () => {}],
    useEffect: () => {},
    useRef: (value) => ({ current: value }),
    createElement: () => null,
  }
  const requireStub = (name) => {
    if (name === '@mzzsfy/dsh-common-tools/client') return { toast: { show: () => 0 } }
    return reactStub
  }
  const factory = new Function('window', 'require', 'document', CLIENT_SRC + '\n;return null')
  factory(
    windowStub,
    requireStub,
    { createElement: () => ({ style: {}, remove() {} }), head: { appendChild: () => {} }, body: { appendChild: () => {} } },
  )
  assert.equal(modules.length, 1, 'client.js 模块未被捕获')
  const mod = modules[0].factory(requireStub)

  const sessions = {
    binding: (sessionId) => (sessionId === 's1' ? binding : undefined),
    fork: () => Promise.resolve('child-1'),
    open: () => {},
  }
  const remote = { session: remoteSession }
  const ctx = {
    get: (name) => (name === 'sessions' ? sessions : {}),
    effect: () => {},
    slots: {
      inject: (name, register) => { injectedNames.push(name); register() },
      register: (options, component) => registered.push({ options, component }),
    },
    get remote() { return remote },
  }
  mod.apply(ctx)
  return { registered, injectedNames }
}

// 插话撤回 dock 条目捕获:与官方 queue dock(order 20)、goal dock(order 10)同槽位
function findSteerEntry(options) {
  const { registered, injectedNames } = loadClient(options)
  assert.ok(injectedNames.includes('conversation.input.dock'), 'apply 未注入 conversation.input.dock 插槽')
  const entries = registered.filter((item) => item.options.name === 'conversation.input.dock')
  const entry = entries.find((item) => item.options.id === 'context-manager-steer')
  assert.ok(entry, '未注册 id=context-manager-steer 的插话撤回 dock 条目')
  return { entry, entries }
}

test('Given client.js 装载, When apply, Then 注册插话撤回与历史浮层 dock 条目', () => {
  const { entry, entries } = findSteerEntry()
  assert.equal(typeof entry.component, 'function', 'dock 条目缺组件')
  assert.equal(entry.options.order, 25, '插话撤回条目 order 应紧邻官方队列面板(20)之后')
  assert.ok(entries.some((item) => item.options.id === 'context-manager-history'), '历史浮层条目被挤掉')
})

test('Given 会话绑定存在, When dock inject, Then updateQueue 路由到 binding.session.updateQueue', async () => {
  const calls = []
  const binding = {
    session: {
      updateQueue: async (itemId, action) => {
        calls.push({ itemId, action })
        return { ok: true }
      },
      projections: { faceOf: () => ({ getSnapshot: () => ({}) }) },
    },
  }
  const { entry } = findSteerEntry({ binding })
  const props = entry.options.inject('s1')
  assert.equal(typeof props.updateQueue, 'function', 'inject 未返回 updateQueue')
  const result = await props.updateQueue('m1', { kind: 'remove' })
  assert.deepEqual(calls, [{ itemId: 'm1', action: { kind: 'remove' } }], 'updateQueue 未按 remove 动作透传')
  assert.deepEqual(result, { ok: true })
})

test('Given 会话绑定存在, When dock inject, Then 返回 inbox 投影 face 供组件订阅', () => {
  const face = { getSnapshot: () => ({ 'next-step': [INBOX_MESSAGE] }) }
  const binding = {
    session: {
      updateQueue: async () => ({ ok: true }),
      projections: { faceOf: (name) => name === 'inbox' ? face : null },
    },
  }
  const { entry } = findSteerEntry({ binding })
  const props = entry.options.inject('s1')
  assert.equal(props.inboxFace, face, 'inject 未返回 inbox 投影 face')
})

test('Given 会话面无投影(旧宿主), When dock inject, Then inboxFace 为 undefined(组件不渲染)', () => {
  const binding = { session: { updateQueue: async () => ({ ok: true }) } }
  const { entry } = findSteerEntry({ binding })
  const props = entry.options.inject('s1')
  assert.equal(props.inboxFace, undefined, '无投影时应返回 undefined 触发组件干净缺席')
})

test('Given 会话绑定缺失, When dock inject, Then 返回空 props(干净禁用)', () => {
  const { entry } = findSteerEntry()
  assert.deepEqual(entry.options.inject('s1'), {}, '绑定缺失应返回空 props')
  assert.deepEqual(entry.options.inject('missing'), {}, '未知会话应返回空 props')
})

test('Given 会话面无 updateQueue(旧宿主), When dock inject, Then 返回空 props(干净禁用)', () => {
  const { entry } = findSteerEntry({ binding: { session: {} } })
  assert.deepEqual(entry.options.inject('s1'), {}, '会话面无 updateQueue 应返回空 props')
})

// 纯函数切片:steerRowsOfInbox / withdrawFailureText / withdrawSteer(无外部依赖,动作经注入)
const PURE_START = CLIENT_SRC.indexOf('function steerRowsOfInbox(')
const PURE_END = CLIENT_SRC.indexOf('function SteerRecallDock(')
assert.ok(PURE_START >= 0 && PURE_END > PURE_START, 'client.js 插话撤回纯函数切片定位失败')
const pure = new Function(
  CLIENT_SRC.slice(PURE_START, PURE_END)
  + '; return { steerRowsOfInbox: steerRowsOfInbox, withdrawFailureText: withdrawFailureText, withdrawSteer: withdrawSteer }',
)()

const INBOX_MESSAGE = {
  id: 'm1',
  source: { kind: 'user' },
  content: [{ type: 'text', text: '帮我看下' }],
}
const STEERING_ROW = { id: 'm1', source: { kind: 'user' }, preview: '帮我看下', text: '帮我看下' }

test('steerRowsOfInbox:仅保留 user 来源的 next-step 行,映射为撤回行', () => {
  const messages = [
    { id: 'x1', source: { kind: 'system' }, content: [{ type: 'text', text: '注入' }] },
    INBOX_MESSAGE,
    null,
    { id: 'x2', source: { kind: 'user' }, content: [{ type: 'text', text: '第二条' }] },
  ]
  const rows = pure.steerRowsOfInbox(messages)
  assert.deepEqual(rows.map((row) => row.id), ['m1', 'x2'])
  assert.equal(rows[0].text, '帮我看下')
  assert.ok(rows[0].preview.includes('帮我看下'))
  assert.deepEqual(pure.steerRowsOfInbox([]), [])
  assert.deepEqual(pure.steerRowsOfInbox(undefined), [])
})

test('steerRowsOfInbox:含非文本块的插话不可撤回(text 为 null)', () => {
  const rows = pure.steerRowsOfInbox([
    { id: 'm2', source: { kind: 'user' }, content: [{ type: 'text', text: '看图' }, { type: 'image', attachment: {} }] },
    { id: 'm3', source: { kind: 'user' }, content: [] },
    { id: 'm4', source: { kind: 'user' } },
    { id: 'm5' },
  ])
  assert.equal(rows[0].text, null)
  assert.equal(rows[1].text, null)
  assert.equal(rows[2].text, null)
  assert.deepEqual(rows.map((row) => row.id), ['m2', 'm3', 'm4'])
})

test('withdrawSteer 主路径:remove 成功后回填草稿并提示,返回 true', async () => {
  const calls = []
  const actions = {
    updateQueue: async (itemId, action) => { calls.push({ itemId, action }); return { ok: true } },
    setDraft: (text) => calls.push({ setDraft: text }),
    notify: (text, opts) => calls.push({ notify: text, opts }),
  }
  const done = await pure.withdrawSteer(STEERING_ROW, actions)
  assert.equal(done, true)
  assert.deepEqual(calls, [
    { itemId: 'm1', action: { kind: 'remove' } },
    { setDraft: '帮我看下' },
    { notify: '已撤回到输入框', opts: undefined },
  ])
})

test('withdrawSteer 已被应用:queue-item-not-found 不回填草稿,专用文案报错', async () => {
  const calls = []
  const actions = {
    updateQueue: async () => ({ ok: false, error: { code: 'session/queue-item-not-found', message: 'queued item is no longer pending' } }),
    setDraft: (text) => calls.push({ setDraft: text }),
    notify: (text, opts) => calls.push({ notify: text, opts }),
  }
  const done = await pure.withdrawSteer(STEERING_ROW, actions)
  assert.equal(done, false)
  assert.deepEqual(calls, [{ notify: '插话已被应用,无法撤回', opts: { kind: 'error' } }])
})

test('withdrawSteer 其他失败:透传错误消息且不回填草稿', async () => {
  const calls = []
  const actions = {
    updateQueue: async () => ({ ok: false, error: { code: 'session/steer-unavailable', message: 'busy' } }),
    setDraft: (text) => calls.push({ setDraft: text }),
    notify: (text, opts) => calls.push({ notify: text, opts }),
  }
  const done = await pure.withdrawSteer(STEERING_ROW, actions)
  assert.equal(done, false)
  assert.deepEqual(calls, [{ notify: '撤回失败: busy', opts: { kind: 'error' } }])
})

test('withdrawSteer 传输层拒绝:按错误处理且不回填草稿', async () => {
  const calls = []
  const actions = {
    updateQueue: async () => { throw new Error('network down') },
    setDraft: (text) => calls.push({ setDraft: text }),
    notify: (text, opts) => calls.push({ notify: text, opts }),
  }
  const done = await pure.withdrawSteer(STEERING_ROW, actions)
  assert.equal(done, false)
  assert.deepEqual(calls, [{ notify: '撤回失败: network down', opts: { kind: 'error' } }])
})

test('withdrawSteer 摘除成功但回填抛错:兜底展示原文,不报成功', async () => {
  const calls = []
  const actions = {
    updateQueue: async () => ({ ok: true }),
    setDraft: () => { throw new Error('shell released') },
    notify: (text, opts) => calls.push({ notify: text, opts }),
  }
  const done = await pure.withdrawSteer(STEERING_ROW, actions)
  assert.equal(done, false)
  assert.deepEqual(calls, [{ notify: '草稿回填失败,原文: 帮我看下', opts: { kind: 'error' } }])
})

// ── 组件级门控:干净禁用规约的落地断言(整源加载 + 记录型 createElement 直接调组件) ──

// createElement 桩记录调用树:h(type, props, ...children) -> {type, props, children}
// useStateValues:按调用序覆盖各 useState 初始值(超出部分用组件默认),供渲染态断言
function loadComponent() {
  const modules = []
  const registered = []
  const windowStub = { __ModuleLoader__: { load: (module) => modules.push(module) }, addEventListener: () => {} }
  const reactStub = {
    useState: (value) => [value, () => {}],
    useEffect: () => {},
    useRef: (value) => ({ current: value }),
    createElement: (type, props, ...children) => ({ type, props, children }),
  }
  const requireStub = (name) => {
    if (name === '@mzzsfy/dsh-common-tools/client') return { toast: { show: () => 0 } }
    return reactStub
  }
  const factory = new Function('window', 'require', 'document', CLIENT_SRC + '\n;return null')
  factory(
    windowStub,
    requireStub,
    {
      createElement: () => ({ style: {}, remove() {} }),
      createElementNS: () => ({ appendChild() {}, setAttribute() {} }),
      head: { appendChild: () => {} },
      body: { appendChild: () => {} },
      querySelectorAll: () => [],
    },
  )
  const mod = modules[0].factory(requireStub)
  const sessions = { binding: () => undefined, fork: () => Promise.resolve('c'), open: () => {} }
  const ctx = {
    get: (name) => (name === 'sessions' ? sessions : {}),
    effect: () => {},
    slots: {
      inject: (name, register) => register(),
      register: (options, component) => registered.push({ options, component }),
    },
    get remote() { return { session: { page: () => Promise.resolve({ records: [] }) } } },
  }
  mod.apply(ctx)
  const entry = registered.find((item) => item.options.id === 'context-manager-steer')
  assert.ok(entry, '组件级测试未捕获插话撤回条目')
  return { component: entry.component }
}

const DOCK_COMPONENT = loadComponent()
const NO_ACTIONS = { setDraft: () => {} }
const OK_UPDATE = async () => ({ ok: true })

// useSession 桩:两次 selector 读取共用同一快照(与官方 SessionSnapshotSelector 单快照同构)
function dockWith(snapshot) {
  const useSession = (selector) => selector(snapshot)
  const dock = loadComponent()
  return (props) => dock.component({ useSession, inputActions: NO_ACTIONS, updateQueue: OK_UPDATE, inboxFace: { getSnapshot: () => ({}) }, ...props })
}

test('SteerRecallDock 干净禁用:依赖任一缺失即返回 null', () => {
  const dock = dockWith({ subagent: null })
  assert.equal(dock({ inputActions: undefined }), null, 'inputActions 缺失应不渲染')
  assert.equal(dock({ updateQueue: undefined }), null, 'updateQueue 缺失应不渲染')
  assert.equal(dock({ inboxFace: undefined }), null, 'inboxFace 缺失应不渲染(旧宿主无投影)')
})

test('SteerRecallDock 干净禁用:subagent 非 continuable 即返回 null', () => {
  const locked = dockWith({ subagent: { address: { mode: 'prompt' } } })
  assert.equal(locked({}), null, 'queueMutable 为假应不渲染')
})

test('SteerRecallDock 渲染:依赖齐备时零占位宿主(注入面由 MutationObserver 承担)', () => {
  const host = dockWith({ subagent: null })({})
  assert.equal(host.type, 'div')
  assert.equal(host.props.className, 'cx-steer-host', '应渲染零占位宿主')
})

// 撤回图标 svg:DOM 形态(注入按钮走 DOM 路径,与 forkSvg 同构)
test('steerRecallSvg:DOM 元素形态,16px viewBox 双路径 stroke 描边', () => {
  const SVG_START = CLIENT_SRC.indexOf('function steerRecallSvg(')
  const SVG_END = CLIENT_SRC.indexOf('function forkSvg(')
  assert.ok(SVG_START > 0 && SVG_END > SVG_START, 'steerRecallSvg 切片定位失败')
  const created = []
  const el = () => {
    const node = { attrs: {}, children: [], appendChild(child) { this.children.push(child) }, setAttribute(k, v) { this.attrs[k] = v } }
    created.push(node)
    return node
  }
  const svg = new Function('document', CLIENT_SRC.slice(SVG_START, SVG_END) + '; return steerRecallSvg()')({ createElementNS: el })
  assert.equal(created.length, 3, '应创建 1 个 svg + 2 个 path')
  assert.equal(svg, created[0])
  assert.equal(svg.attrs.width, '16')
  assert.equal(svg.attrs.height, '16')
  assert.equal(svg.attrs.viewBox, '0 0 16 16')
  assert.equal(svg.children.length, 2, 'undo 弯箭头应由两条 stroke 路径构成')
})

// 注入契约(源码级守卫,与 client-fork.test.mjs 的 fork 契约同构):
// 显隐由 inbox 投影行集驱动——行在注入、行不在摘除,投影订阅保证应用后即时消失。
// pending 与 durable 双路径:pending 气泡(data-pending-steering,含双标记 echo
// 形态)按文档序与投影序对齐,durable 气泡按 node-key messageId 匹配。
// 锚定 SteerRecallDock 函数体切片:防止常量定义行/注释文本满足 grep 造成守卫空转
test('SteerRecallDock 注入契约:双路径气泡锚点、投影驱动显隐、官方类克隆与清理齐备', () => {
  const DOCK_START = CLIENT_SRC.indexOf('function SteerRecallDock(')
  const DOCK_END = CLIENT_SRC.indexOf('// 对话 fork:')
  assert.ok(DOCK_START > 0 && DOCK_END > DOCK_START, 'SteerRecallDock 切片定位失败')
  const dock = CLIENT_SRC.slice(DOCK_START, DOCK_END)
  assert.ok(dock.includes("querySelectorAll('[' + FLOW_KIND_ATTR + '=\"steering\"]')"), '应扫描 durable steering 气泡(node-key 匹配路径)')
  assert.ok(dock.includes("querySelectorAll('[' + STEER_PENDING_ATTR + ']')"), '应扫描 Host pending steering 气泡(顺序对齐路径)')
  assert.ok(!dock.includes('SUBMISSION_ECHO_ATTR'), 'pending 对齐不得排除本地提交 echo——宿主 0.2.1-rc.2 发送会话内插话即双标记 echo 形态,排除即主场景错杀(行存在性检查已覆盖 Host 未确认防误配)')
  assert.ok(dock.includes("button.setAttribute(STEER_BTN_FLAG, '')"), '注入按钮应带自家标记(防重复注入与误删官方节点)')
  assert.ok(dock.includes("bubble.querySelector('[' + STEER_BTN_FLAG + ']')"), '应按气泡范围查询防重标记(同一查询点承担行不在时的摘除)')
  assert.ok(dock.includes('STEER_NODE_KEY_RE'), 'durable 气泡应经 node-key 正则提取 messageId 匹配投影行')
  assert.ok(dock.includes('const row = rows[index] || null'), 'pending 气泡应按文档序与投影序配对(顺序对齐,不依赖渲染文本)')
  assert.ok(dock.includes('face.subscribe'), '应订阅 inbox 投影,应用后驱动重扫摘除按钮')
  assert.ok(dock.includes('button.className = official.className'), '应克隆官方按钮类名(尺寸/hover/悬停显隐原生)')
  assert.ok(dock.includes("button.closest('[' + FLOW_KIND_ATTR + '=\"steering\"], [' + STEER_PENDING_ATTR + ']'"), '点击应实时重读气泡(pending 与 durable 同构)')
  assert.ok(dock.includes('forEach((button) => button.remove())'), '卸载/停用应移除全部已注入按钮')
  assert.ok(dock.includes('插话已被应用,无法撤回'), '点击竞态窗口内被应用应降级提示')
  assert.ok(dock.includes('含附件的插话不支持撤回'), '含附件行点击应明确提示')
  assert.ok(dock.includes('if (!current || !current.queueMutable || !current.inboxFace'), '点击应与 scan 同款依赖守卫(face falsy/锁定态不执行)')
})

// ── 组件级 scan 行为:投影行集驱动注入/摘除(MutationObserver 与投影 face 可控行使) ──

// DOM 桩:durable 单 steering 气泡 + 可选 pending 气泡序列 + 操作排;querySelector
// 动态反映当前注入态(防重与摘除断言依赖);face 订阅记录回调,手动触发模拟投影
// 更新;effect 手动执行
function mountScanHarness({ faceRows, updateQueue, setDraft, pendingBubble = false, pendingBubbles = null } = {}) {
  const modules = []
  const registered = []
  const effects = []
  const subscribers = []
  const injected = []
  const toastCalls = []
  let unsubscribed = false
  let enabledSlot = true
  let refCall = 0
  const refs = []
  const makeButton = () => ({
    attrs: {}, listeners: {}, className: '', title: '', type: undefined, disabled: false, removed: false, closestTarget: null,
    setAttribute(k, v) { this.attrs[k] = v },
    addEventListener(name, fn) { this.listeners[name] = fn },
    appendChild() {},
    remove() { this.removed = true },
    closest() { return this.closestTarget || bubble },
  })
  const official = makeButton()
  const makeActionsRow = (host) => {
    const row = {
      appendChild(child) {
        child.closestTarget = host
        injected.push(child)
        ;(host.buttons ||= []).push(child)
      },
      querySelector(sel) { return sel.startsWith('button:not(') ? official : null },
    }
    return row
  }
  const pendingSeeds = pendingBubbles !== null
    ? pendingBubbles
    : (pendingBubble ? [{ text: '帮我看下' }] : [])
  // echo 形态:宿主 0.2.1-rc.2 发送会话内,投影行被本地 submission 替换渲染,
  // steering 气泡 = data-pending-steering + data-submission-echo 双标记;
  // 切会话回来(本地 state 清空)渲染纯 pending 单标记
  const makeBubble = ({ pending, echo, text }) => {
    const b = {
      attrs: {
        'data-chat-node-key': pending ? null : '5:input-messagem1',
        'data-chat-flow-kind': pending ? null : 'steering',
        'data-pending-steering': pending ? '' : null,
        'data-submission-echo': echo ? '' : null,
      },
      textContent: text || '',
      buttons: null,
      hasAttribute(k) { return this.attrs[k] !== null && this.attrs[k] !== undefined },
      getAttribute(k) { return this.attrs[k] !== undefined ? this.attrs[k] : null },
      querySelector(sel) {
        if (sel === '[class$="_actions"]') { this.actionsRow ||= makeActionsRow(b); return this.actionsRow }
        if (sel === '[' + 'data-cx-steer-recall' + ']') return (this.buttons || []).find((x) => !x.removed) || null
        return null
      },
    }
    return b
  }
  const bubble = makeBubble({ pending: false })
  const pendingDom = pendingSeeds.map((seed) => makeBubble({ pending: true, echo: seed.echo, text: seed.text }))
  // 真实宿主单条插话只渲染一种气泡(pending 或 durable),桩随 pendingSeeds 切换
  const allBubbles = pendingSeeds.length > 0 ? [...pendingDom] : [bubble]
  const reactStub = {
    // enabled 槽位化:setter 写回,停用测试经返回的 setEnabled 拨关后重扫;
    // useRef 槽位持久(同一调用序返回同一 ref 对象,跨渲染保持 current)
    useState: (value) => [enabledSlot, (v) => { enabledSlot = typeof v === 'function' ? v(enabledSlot) : v }],
    useEffect: (fn, deps) => effects.push({ fn, deps }),
    useRef: (value) => {
      const i = refCall
      refCall += 1
      if (!(i in refs)) refs[i] = { current: value }
      return refs[i]
    },
    createElement: (type, props, ...children) => ({ type, props, children }),
  }
  const documentStub = {
    head: { appendChild: () => {} },
    body: { appendChild: () => {} },
    documentElement: {},
    createElement: () => makeButton(),
    createElementNS: () => ({ setAttribute() {}, appendChild() {} }),
    querySelectorAll(sel) {
      if (sel.includes('data-chat-flow-kind="steering"')) return pendingSeeds.length > 0 ? [] : [bubble]
      if (sel.includes('data-pending-steering')) return pendingDom
      if (sel.includes('data-cx-steer-recall')) {
        const alive = allBubbles.flatMap((b) => (b.buttons || []).filter((x) => !x.removed))
        return alive
      }
      return []
    },
  }
  class MutationObserverStub {
    constructor() {}
    observe() {}
    disconnect() {}
  }
  const windowStub = { __ModuleLoader__: { load: (module) => modules.push(module) }, addEventListener: () => {} }
  const requireStub = (name) => {
    if (name === '@mzzsfy/dsh-common-tools/client') return { toast: { show: (text, opts) => toastCalls.push({ text, opts }) } }
    return reactStub
  }
  const factory = new Function('window', 'require', 'document', 'MutationObserver', 'fetch', CLIENT_SRC + '\n;return null')
  factory(
    windowStub,
    requireStub,
    documentStub,
    MutationObserverStub,
    async () => ({ ok: false, status: 404, json: async () => ({}) }),
  )
  const mod = modules[0].factory(requireStub)
  const sessions = { binding: () => undefined, fork: () => Promise.resolve('c'), open: () => {} }
  const ctx = {
    get: (name) => (name === 'sessions' ? sessions : {}),
    effect: () => {},
    slots: {
      inject: (name, register) => register(),
      register: (options, component) => registered.push({ options, component }),
    },
    get remote() { return { session: {} } },
  }
  mod.apply(ctx)
  const entry = registered.find((item) => item.options.id === 'context-manager-steer')
  assert.ok(entry, 'scan 行为测试未捕获插话撤回条目')
  const face = {
    getSnapshot: () => ({ 'next-step': typeof faceRows === 'function' ? faceRows() : faceRows }),
    subscribe(cb) { subscribers.push(cb); return () => { unsubscribed = true } },
  }
  const useSession = (selector) => selector({ subagent: null })
  const lastProps = {
    useSession,
    inputActions: { setDraft: setDraft || (() => {}) },
    updateQueue: updateQueue || (async () => ({ ok: true })),
    inboxFace: face,
  }
  entry.component(lastProps)
  let cleanup
  effects.forEach(({ fn }) => { cleanup = fn() })
  if (process.env.CX_DEBUG) console.error('[cx-debug]', JSON.stringify({ effectCount: effects.length, injected: injected.length, subscribers: subscribers.length, snapshotRows: face.getSnapshot()['next-step'], toastCalls: toastCalls.length }))
  return {
    face,
    injected,
    subscribers,
    toastCalls,
    deps: effects[1] ? effects[1].deps : null,
    cleanup,
    isUnsubscribed: () => unsubscribed,
    setEnabled: (v) => { enabledSlot = v },
    // 模拟 React 重渲染:同一 props 再调一次组件(hooks 桩按调用序推进,游标归零)
    rerender: () => { refCall = 0; entry.component(lastProps) },
  }
}

const settle = () => new Promise((resolve) => setImmediate(resolve))

test('scan pending 行:Host optimistic bubble 无 node-key 时仍注入撤回', () => {
  const h = mountScanHarness({ faceRows: [INBOX_MESSAGE], pendingBubble: true })
  assert.equal(h.injected.length, 1, 'Host pending-steering bubble 无 data-chat-flow-kind/node-key 仍须匹配其 next-step 行')
})

test('scan pending 顺序:Markdown 渲染文本与原文不一致仍按序注入(文本不参与匹配)', () => {
  // 宿主把 next-step user 行保序渲染为 pending 气泡;Markdown 渲染后 textContent
  // 不等于行原文,匹配只能靠顺序——纯文本相等匹配会让带格式插话永远无图标
  const h = mountScanHarness({ faceRows: [INBOX_MESSAGE], pendingBubbles: [{ text: '帮我看**下**,谢谢' }] })
  assert.equal(h.injected.length, 1, '渲染文本 ≠ 行原文时仍须按顺序对齐注入')
})

test('scan pending 顺序:多行多气泡按序一一配对', () => {
  const rows = [
    { id: 'm1', source: { kind: 'user' }, content: [{ type: 'text', text: '第一条' }] },
    { id: 'm2', source: { kind: 'user' }, content: [{ type: 'text', text: '**第二条**' }] },
  ]
  const h = mountScanHarness({ faceRows: rows, pendingBubbles: [{ text: '第一条' }, { text: '第二条' }] })
  assert.equal(h.injected.length, 2, '两个 pending 气泡按序配对两行')
})

// 第三次失效(2026-10-20)回归:宿主 0.2.1-rc.2 发送会话内,投影行被本地 submission
// 替换渲染,steering 气泡 = data-pending-steering + data-submission-echo 双标记;
// 排除 echo 的旧过滤把主场景气泡整体错杀,图标只在切会话回来(纯 pending 形态)出现。
// 顺序对齐保证「行存在才注入」,echo 排除的原始动机(Host 未确认防误配)已由其覆盖。
test('scan pending 双标记:发送会话内 echo 形态气泡仍按序注入(第三次失效回归)', () => {
  const h = mountScanHarness({ faceRows: [INBOX_MESSAGE], pendingBubbles: [{ text: '帮我看下', echo: true }] })
  assert.equal(h.injected.length, 1, 'Host 已确认(投影有行)的双标记 echo 气泡必须注入,不得按 echo 标记排除')
})

test('scan pending 混合:echo 与纯 pending 混合序列按序配对', () => {
  const rows = [
    { id: 'm1', source: { kind: 'user' }, content: [{ type: 'text', text: '第一条' }] },
    { id: 'm2', source: { kind: 'user' }, content: [{ type: 'text', text: '第二条' }] },
  ]
  const h = mountScanHarness({ faceRows: rows, pendingBubbles: [{ text: '第一条', echo: true }, { text: '第二条' }] })
  assert.equal(h.injected.length, 2, '双标记与单标记气泡在同序队列中一并配对')
})

test('scan pending 双标记:无行排尾 echo(Host 未确认)不注入', () => {
  const rows = [{ id: 'm1', source: { kind: 'user' }, content: [{ type: 'text', text: '第一条' }] }]
  const h = mountScanHarness({ faceRows: rows, pendingBubbles: [{ text: '第一条', echo: true }, { text: '刚发出', echo: true }] })
  assert.equal(h.injected.length, 1, '行存在性检查天然覆盖 Host 未确认场景,尾部无行 echo 不得注入')
})

test('scan pending 双标记点击:echo 形态气泡点击走 remove 主路径并回填', async () => {
  const calls = []
  const h = mountScanHarness({
    faceRows: [INBOX_MESSAGE],
    pendingBubbles: [{ text: '帮我看下', echo: true }],
    updateQueue: async (itemId, action) => { calls.push({ itemId, action }); return { ok: true } },
    setDraft: (text) => calls.push({ setDraft: text }),
  })
  h.injected[0].listeners.click()
  await settle()
  assert.deepEqual(calls, [
    { itemId: 'm1', action: { kind: 'remove' } },
    { setDraft: '帮我看下' },
  ], 'echo 形态气泡点击不得被 echo 排除拦截为「已被应用」')
})

test('scan pending 顺序:行数少于气泡数(尾部行已应用)→ 多余气泡不注入', () => {
  let rows = [
    { id: 'm1', source: { kind: 'user' }, content: [{ type: 'text', text: '第一条' }] },
    { id: 'm2', source: { kind: 'user' }, content: [{ type: 'text', text: '第二条' }] },
  ]
  const h = mountScanHarness({ faceRows: () => rows, pendingBubbles: [{ text: '第一条' }, { text: '第二条' }] })
  assert.equal(h.injected.length, 2)
  rows = [rows[1]]
  h.subscribers.forEach((cb) => cb())
  assert.equal(h.injected.filter((b) => b.removed).length, 1, '行应用后对应序位气泡按钮应摘除(头气泡失配)')
  assert.equal(h.injected.filter((b) => !b.removed).length, 1, '存续行对应气泡按钮保留')
})

test('scan pending 点击:按顺序对齐行走 remove 主路径并回填', async () => {
  const calls = []
  const h = mountScanHarness({
    faceRows: [INBOX_MESSAGE],
    pendingBubble: true,
    updateQueue: async (itemId, action) => { calls.push({ itemId, action }); return { ok: true } },
    setDraft: (text) => calls.push({ setDraft: text }),
  })
  h.injected[0].listeners.click()
  await settle()
  assert.deepEqual(calls, [
    { itemId: 'm1', action: { kind: 'remove' } },
    { setDraft: '帮我看下' },
  ], 'pending 气泡点击应按顺序对齐行发起 remove 并回填')
  assert.equal(h.toastCalls.at(-1).text, '已撤回到输入框')
})

test('scan 投影驱动:行在注入,行不在不注入;scan effect 依赖 inboxFace', () => {
  const on = mountScanHarness({ faceRows: [INBOX_MESSAGE] })
  assert.equal(on.injected.length, 1, '未应用行应注入撤回按钮')
  assert.ok(on.deps && on.deps.includes(on.face), 'scan 装配 effect 应依赖 inboxFace(会话切换重订)')
  const off = mountScanHarness({ faceRows: [] })
  assert.equal(off.injected.length, 0, '已应用行(投影无行)不应注入按钮')
})

test('scan 投影驱动:注入后被应用(行移除)→ 订阅回调摘除按钮,不重复注入', () => {
  let rows = [INBOX_MESSAGE]
  const h = mountScanHarness({ faceRows: () => rows })
  assert.equal(h.injected.length, 1)
  rows = []
  h.subscribers.forEach((cb) => cb())
  assert.equal(h.injected[0].removed, true, '应用后按钮应被投影重扫摘除')
  assert.equal(h.injected.length, 1, '摘除后不得重复注入')
})

test('scan 投影驱动:行仍在的重扫防重', () => {
  const h = mountScanHarness({ faceRows: [INBOX_MESSAGE] })
  h.subscribers.forEach((cb) => cb())
  assert.equal(h.injected.length, 1, '投影更新但行仍在时不应重复注入')
})

test('scan 点击:撤回主路径 remove + 回填 + 成功提示', async () => {
  const calls = []
  const h = mountScanHarness({
    faceRows: [INBOX_MESSAGE],
    updateQueue: async (itemId, action) => { calls.push({ itemId, action }); return { ok: true } },
    setDraft: (text) => calls.push({ setDraft: text }),
  })
  h.injected[0].listeners.click()
  await settle()
  assert.deepEqual(calls, [
    { itemId: 'm1', action: { kind: 'remove' } },
    { setDraft: '帮我看下' },
  ], '撤回应按 remove 动作路由并回填草稿')
  assert.equal(h.toastCalls.at(-1).text, '已撤回到输入框')
})

test('scan 点击:点击瞬间行已被应用 → 降级提示,不回填', async () => {
  let rows = [INBOX_MESSAGE]
  const h = mountScanHarness({ faceRows: () => rows })
  rows = []
  h.injected[0].listeners.click()
  await settle()
  assert.deepEqual(h.toastCalls, [{ text: '插话已被应用,无法撤回', opts: { kind: 'error' } }])
})

test('scan cleanup:退订投影并移除全部已注入按钮', () => {
  const h = mountScanHarness({ faceRows: [INBOX_MESSAGE] })
  h.cleanup()
  assert.equal(h.isUnsubscribed(), true, 'cleanup 应退订投影')
  assert.equal(h.injected[0].removed, true, 'cleanup 应移除已注入按钮')
})

test('scan 点击:含附件行(非纯文本块)→ 明确提示不可撤回,不触碰队列', async () => {
  const calls = []
  const h = mountScanHarness({
    faceRows: [{ id: 'm1', source: { kind: 'user' }, content: [{ type: 'text', text: '看图' }, { type: 'image', attachment: {} }] }],
    updateQueue: async (itemId, action) => { calls.push({ itemId, action }); return { ok: true } },
    setDraft: (text) => calls.push({ setDraft: text }),
  })
  h.injected[0].listeners.click()
  await settle()
  assert.deepEqual(calls, [], '含附件行不得发起 remove')
  assert.deepEqual(h.toastCalls, [{ text: '含附件的插话不支持撤回', opts: { kind: 'error' } }])
})

test('scan 停用:开关关闭后重扫移除已注入按钮且不再注入', () => {
  const h = mountScanHarness({ faceRows: [INBOX_MESSAGE] })
  assert.equal(h.injected.length, 1, '前置:启用态已注入')
  // 真实 React:setEnabled → 重渲染同步 enabledRef → effect 重跑。桩环境按此序驱动
  h.setEnabled(false)
  h.rerender()
  h.subscribers.forEach((cb) => cb())
  assert.equal(h.injected[0].removed, true, '停用重扫应移除已注入按钮')
  assert.equal(h.injected.length, 1, '停用后不得重新注入')
})
