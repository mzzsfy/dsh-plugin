// 对话 fork 接线测试:加载真实 src/client.js,断言 dock 注册条件、锚点映射构建、
// 注入契约与 fork 服务组装。锚点通道:remote.session.follow 开场帧(自带回溯窗口
// 内的事件与 seq)建立轮号→turn/end seq 映射;namespace 就绪由点分 inject 门控。
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const PKG_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const CLIENT_SRC = readFileSync(join(PKG_ROOT, 'src', 'client.js'), 'utf8')

// follow 开场帧桩:async-iterable,首个 snapshot 帧后即挂起(break 触发 return,
// 桩记录退订以证明「取到开场即断开」)
function followStub(records) {
  const state = { returned: false }
  const frames = (async function* generate() {
    try {
      yield { type: 'snapshot', cursor: 99, records }
      await new Promise(() => {})
    } finally {
      state.returned = true
    }
  })()
  return { frames, state }
}

function loadClient({ sessions, remoteSession } = {}) {
  const modules = []
  const registered = []
  const windowStub = { __ModuleLoader__: { load: (module) => modules.push(module) }, addEventListener: () => {} }
  const reactStub = {
    useState: (value) => [value, () => {}],
    useEffect: () => {},
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
  const mod = modules[0].factory(requireStub)
  const sessionsStub = sessions || { binding: () => undefined, fork: () => Promise.resolve('child-1'), open: () => {} }
  const ctx = {
    get: (name) => (name === 'sessions' ? sessionsStub : {}),
    effect: () => {},
    slots: {
      inject: (name, register) => register(),
      register: (options, component) => registered.push({ options, component }),
    },
    remote: { session: remoteSession },
  }
  mod.apply(ctx)
  return { registered }
}

function findForkEntry({ sessions, remoteSession } = {}) {
  const { registered } = loadClient({ sessions, remoteSession })
  const entries = registered.filter((item) => item.options.name === 'conversation.input.dock')
  const entry = entries.find((item) => item.options.id === 'context-manager-fork')
  return { entry, entries }
}

const EMPTY_FOLLOW = { follow: () => followStub([]).frames }

test('inject 点分声明 remote.namespace(规约:禁止 apply 内同步探测 remote 面)', () => {
  const declared = CLIENT_SRC.match(/inject: \[([^\]]*)\]/)
  assert.ok(declared, 'client.js 缺 inject 声明')
  const names = declared[1].split(',').map((item) => item.trim().replace(/'/g, '')).filter(Boolean)
  assert.ok(names.includes('remote'), 'inject 必须声明 remote')
  assert.ok(names.includes('remote.session'), 'inject 必须点分声明 remote.session(cordis 门控 namespace 就绪)')
})

test('Given sessions 服务与 remote.session.follow 齐备, When apply, Then 注册 fork dock 条目', () => {
  const { entry } = findForkEntry({ remoteSession: EMPTY_FOLLOW })
  assert.ok(entry, 'fork dock 条目未注册')
  assert.equal(entry.options.order, 24, 'fork 条目应排在官方队列(20)/撤回(25)邻近位')
  assert.equal(typeof entry.component, 'function', 'fork dock 条目缺组件')
})

test('Given sessions 服务缺 fork/open(旧宿主), When apply, Then fork 条目不注册且其余保留', () => {
  const { entry, entries } = findForkEntry({
    sessions: { binding: () => undefined },
    remoteSession: EMPTY_FOLLOW,
  })
  assert.equal(entry, undefined, 'sessions 无 fork 时 fork 条目不应注册')
  assert.ok(entries.some((item) => item.options.id === 'context-manager-steer'), '撤回条目不应被 fork 门控阻塞')
  assert.ok(entries.some((item) => item.options.id === 'context-manager-history'), '历史条目不应被 fork 门控阻塞')
})

test('Given dock inject, Then 返回 forkSession(loadTurnEnds 通道)且按会话寻址', async () => {
  const forkCalls = []
  const openCalls = []
  const { entry } = findForkEntry({
    sessions: { binding: () => undefined, fork: (opts) => { forkCalls.push(opts); return Promise.resolve('child-9') }, open: (id) => { openCalls.push(id) } },
    remoteSession: EMPTY_FOLLOW,
  })
  const props = entry.options.inject('s1')
  assert.equal(typeof props.forkSession, 'function', 'inject 未返回 forkSession')
  assert.equal(typeof props.loadTurnEnds, 'function', 'inject 未返回 loadTurnEnds')
  const childId = await props.forkSession({ sessionId: 's1', atSeq: 7, increaseTitle: true })
  assert.deepEqual(forkCalls, [{ sessionId: 's1', atSeq: 7, increaseTitle: true }])
  assert.deepEqual(openCalls, ['child-9'], 'fork 成功后应 open 子会话')
  assert.equal(childId, 'child-9', 'forkSession 应解析出子会话 id')
})

test('Given open 失败, When forkSession, Then 分叉成功事实不被推翻(childId 照常解析)', async () => {
  const forkCalls = []
  const { entry } = findForkEntry({
    sessions: {
      binding: () => undefined,
      fork: (opts) => { forkCalls.push(opts); return Promise.resolve('child-7') },
      open: () => Promise.reject(new Error('open down')),
    },
    remoteSession: EMPTY_FOLLOW,
  })
  const props = entry.options.inject('s1')
  const childId = await props.forkSession({ sessionId: 's1', atSeq: 3 })
  assert.equal(childId, 'child-7', 'open 失败不得把已成功的分叉上报为失败')
})

test('Given loadTurnEnds, Then 轮号→turn/end seq 映射按 data.turn 登记,缺失按序计数', async () => {
  const records = [
    { event: { type: 'user/message', seq: 1, data: {} } },
    { event: { type: 'turn/end', seq: 4, data: { turn: 0 } } },
    { event: { type: 'assistant/message', seq: 5, data: {} } },
    { event: { type: 'turn/end', seq: 9, data: {} } },
    { event: { type: 'turn/end', seq: 20, data: { turn: 5 } } },
  ]
  const follow = followStub(records)
  const { entry } = findForkEntry({ remoteSession: { follow: () => follow.frames } })
  const props = entry.options.inject('s1')
  const map = await props.loadTurnEnds()
  assert.ok(map instanceof Map)
  assert.equal(map.get(0), 4)
  assert.equal(map.get(1), 9, 'data 无 turn 号按出现顺序计数')
  assert.equal(map.get(5), 20)
  assert.equal(map.size, 3)
})

test('Given 开场帧取得, When loadTurnEnds 完成, Then follow 流已断开(不消费 live 帧)', async () => {
  const follow = followStub([{ event: { type: 'turn/end', seq: 2, data: { turn: 0 } } }])
  const { entry } = findForkEntry({ remoteSession: { follow: () => follow.frames } })
  const props = entry.options.inject('s1')
  const map = await props.loadTurnEnds()
  assert.equal(map.get(0), 2)
  // 退订经微任务链收敛:loadTurnEnds 解析时 for-await break 已触发 iterator.return
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.ok(follow.state.returned, '取到开场帧后应断开 follow 流')
})

test('Given follow 失败, When loadTurnEnds, Then 异常向上传播(组件侧降级不注入)', async () => {
  const { entry } = findForkEntry({ remoteSession: { follow: () => { throw new Error('gateway down') } } })
  const props = entry.options.inject('s1')
  await assert.rejects(props.loadTurnEnds(), /gateway down/)
})

// 注入契约(源码级守卫):锚点属性/按钮标记/官方类名克隆/清理/点分门控必须存在
test('ForkDock 注入契约:轮号锚点属性、按钮标记、防重标记与卸载清理齐备', () => {
  assert.ok(CLIENT_SRC.includes("TURN_ATTR = 'data-chat-turn'"), 'fork 锚点必须使用官方轮号标记')
  assert.ok(CLIENT_SRC.includes('data-cx-fork'), '应有自家按钮标记防重复注入')
  assert.ok(CLIENT_SRC.includes("querySelectorAll('[' + TURN_ATTR + ']')"), '应按轮号标记扫描消息气泡')
  assert.ok(CLIENT_SRC.includes('increaseTitle: true'), 'fork 请求应递增子会话标题')
  assert.ok(CLIENT_SRC.includes('observer.disconnect()'), '卸载应断开观察')
  assert.ok(CLIENT_SRC.includes("remote.follow({ address: { kind: 'session', sessionId }"), '锚点必须按会话寻址 follow 开场帧')
  assert.ok(CLIENT_SRC.includes("frame.type === 'snapshot'"), '映射构建必须取自 follow 开场帧')
})
