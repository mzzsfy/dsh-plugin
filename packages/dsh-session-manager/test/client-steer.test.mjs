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
function loadClient({ binding } = {}) {
  const modules = []
  const registered = []
  const injectedNames = []
  const windowStub = { __ModuleLoader__: { load: (module) => modules.push(module) }, addEventListener: () => {} }
  const reactStub = {
    useState: (value) => [value, () => {}],
    useEffect: () => {},
    useSyncExternalStore: () => [],
    useRef: (value) => ({ current: value }),
    createElement: () => null,
  }
  const requireStub = (name) => {
    if (name === '@mzzsfy/dsh-toast/client') return { show: () => 0 }
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
    list: { subscribe: () => () => {}, getSnapshot: () => ({ ids: [], byId: {} }) },
  }
  const workspaces = {
    list: { subscribe: () => () => {}, getSnapshot: () => undefined },
  }
  const ctx = {
    get: (name) => (name === 'sessions' ? sessions : name === 'workspaces' ? workspaces : {}),
    effect: () => {},
    slots: {
      inject: (name, register) => { injectedNames.push(name); register() },
      register: (options, component) => registered.push({ options, component }),
    },
  }
  mod.apply(ctx)
  return { registered, injectedNames }
}

// 插话撤回 dock 条目捕获:与官方 queue dock(order 20)、goal dock(order 10)同槽位
function findSteerEntry(options) {
  const { registered, injectedNames } = loadClient(options)
  assert.ok(injectedNames.includes('conversation.input.dock'), 'apply 未注入 conversation.input.dock 插槽')
  const entries = registered.filter((item) => item.options.name === 'conversation.input.dock')
  const entry = entries.find((item) => item.options.id === 'session-manager-steer')
  assert.ok(entry, '未注册 id=session-manager-steer 的插话撤回 dock 条目')
  return { entry, entries }
}

test('Given client.js 装载, When apply, Then 注册插话撤回 dock 条目且历史浮层条目保留', () => {
  const { entry, entries } = findSteerEntry()
  assert.equal(typeof entry.component, 'function', 'dock 条目缺组件')
  assert.equal(entry.options.order, 25, '插话撤回条目 order 应紧邻官方队列面板(20)之后')
  assert.ok(entries.some((item) => item.options.id === 'session-manager-history'), '历史浮层条目被挤掉')
})

test('Given 会话绑定存在, When dock inject, Then updateQueue 路由到 binding.session.updateQueue', async () => {
  const calls = []
  const binding = {
    session: {
      updateQueue: async (itemId, action) => {
        calls.push({ itemId, action })
        return { ok: true }
      },
    },
  }
  const { entry } = findSteerEntry({ binding })
  const props = entry.options.inject('s1')
  assert.equal(typeof props.updateQueue, 'function', 'inject 未返回 updateQueue')
  const result = await props.updateQueue('m1', { kind: 'remove' })
  assert.deepEqual(calls, [{ itemId: 'm1', action: { kind: 'remove' } }], 'updateQueue 未按 remove 动作透传')
  assert.deepEqual(result, { ok: true })
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

// 纯函数切片:steerRowsOf / withdrawFailureText / withdrawSteer(无外部依赖,动作经注入)
const PURE_START = CLIENT_SRC.indexOf('function steerRowsOf(')
const PURE_END = CLIENT_SRC.indexOf('function SteerRecallDock(')
assert.ok(PURE_START >= 0 && PURE_END > PURE_START, 'client.js 插话撤回纯函数切片定位失败')
const pure = new Function(
  CLIENT_SRC.slice(PURE_START, PURE_END)
  + '; return { steerRowsOf: steerRowsOf, withdrawFailureText: withdrawFailureText, withdrawSteer: withdrawSteer }',
)()

const STEERING_ROW = { id: 'm1', placement: 'steering', preview: '帮我看下', text: '帮我看下' }

test('steerRowsOf:仅保留 placement=steering,防非数组与非行形态', () => {
  const queue = [
    { id: 'q1', placement: 'queued' },
    STEERING_ROW,
    { id: 'c1', placement: 'context' },
    STEERING_ROW,
    null,
  ]
  assert.deepEqual(pure.steerRowsOf(queue), [STEERING_ROW, STEERING_ROW])
  assert.deepEqual(pure.steerRowsOf([]), [])
  assert.deepEqual(pure.steerRowsOf(undefined), [])
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
function loadComponent() {
  const modules = []
  const registered = []
  const windowStub = { __ModuleLoader__: { load: (module) => modules.push(module) }, addEventListener: () => {} }
  const element = (type, props, ...children) => ({ type, props, children })
  const reactStub = {
    useState: (value) => [value, () => {}],
    useEffect: () => {},
    useRef: (value) => ({ current: value }),
    createElement: element,
  }
  const requireStub = (name) => {
    if (name === '@mzzsfy/dsh-toast/client') return { show: () => 0 }
    return reactStub
  }
  const factory = new Function('window', 'require', 'document', CLIENT_SRC + '\n;return null')
  factory(
    windowStub,
    requireStub,
    { createElement: () => ({ style: {}, remove() {} }), head: { appendChild: () => {} }, body: { appendChild: () => {} } },
  )
  const mod = modules[0].factory(requireStub)
  const sessions = { binding: () => undefined, list: { subscribe: () => () => {}, getSnapshot: () => ({ ids: [], byId: {} }) } }
  const workspaces = { list: { subscribe: () => () => {}, getSnapshot: () => undefined } }
  const ctx = {
    get: (name) => (name === 'sessions' ? sessions : name === 'workspaces' ? workspaces : {}),
    effect: () => {},
    slots: {
      inject: (name, register) => register(),
      register: (options, component) => registered.push({ options, component }),
    },
  }
  mod.apply(ctx)
  const entry = registered.find((item) => item.options.id === 'session-manager-steer')
  assert.ok(entry, '组件级测试未捕获插话撤回条目')
  return entry.component
}

const DOCK_COMPONENT = loadComponent()
const NO_ACTIONS = { setDraft: () => {} }
const OK_UPDATE = async () => ({ ok: true })

// useSession 桩:两次 selector 读取共用同一快照(与官方 SessionSnapshotSelector 单快照同构)
function dockWith(snapshot) {
  const useSession = (selector) => selector(snapshot)
  return (props) => DOCK_COMPONENT({ session: {}, useSession, inputActions: NO_ACTIONS, updateQueue: OK_UPDATE, ...props })
}

test('SteerRecallDock 干净禁用:依赖任一缺失即返回 null', () => {
  const dock = dockWith({ queue: [STEERING_ROW], subagent: null })
  assert.equal(dock({ session: undefined }), null, 'session 缺失应不渲染')
  assert.equal(dock({ inputActions: undefined }), null, 'inputActions 缺失应不渲染')
  assert.equal(dock({ updateQueue: undefined }), null, 'updateQueue 缺失应不渲染')
})

test('SteerRecallDock 干净禁用:subagent 非 continuable 与空队列即返回 null', () => {
  const locked = dockWith({ queue: [STEERING_ROW], subagent: { address: { mode: 'prompt' } } })
  assert.equal(locked({}), null, 'queueMutable 为假应不渲染')
  const empty = dockWith({ queue: [], subagent: null })
  assert.equal(empty({}), null, '空队列应不渲染')
  const absent = dockWith({ queue: undefined, subagent: null })
  assert.equal(absent({}), null, '队列快照缺省应不渲染')
})

test('SteerRecallDock 渲染:steering 行产出撤回条,纯文本按钮可用', () => {
  const dock = dockWith({ queue: [{ id: 'q1', placement: 'queued' }, STEERING_ROW, { id: 'c1', placement: 'context' }], subagent: null })
  const root = dock({})
  assert.equal(root.type, 'div')
  assert.equal(root.props.className, 'sm-steer')
  assert.equal(root.children[0].children[0], '插话待应用')
  const rows = root.children[1]
  assert.equal(rows.length, 1, 'queued 与 context 行不得渲染')
  const row = rows[0]
  assert.equal(row.props.className, 'sm-steer__row')
  const button = row.children[1]
  assert.equal(button.type, 'button')
  assert.equal(button.props.disabled, false, '纯文本插话按钮应可用')
  assert.equal(button.props.title, '撤回到输入框重新编辑')
  assert.equal(button.children[0], '撤回编辑')
})

test('SteerRecallDock 渲染:含附件行(text=null)按钮禁用并提示', () => {
  const rich = { id: 'm2', placement: 'steering', preview: '[图片]', text: null }
  const dock = dockWith({ queue: [rich], subagent: null })
  const row = dock({}).children[1][0]
  const button = row.children[1]
  assert.equal(button.props.disabled, true, '含附件插话按钮应禁用')
  assert.equal(button.props.title, '含附件的插话不支持撤回')
})
