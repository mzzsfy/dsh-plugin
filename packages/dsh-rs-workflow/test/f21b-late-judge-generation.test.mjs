// F21b 回归守护(可失败行为测试):迟到 judge 的会话代际隔离。
// 原始缺陷(F21b):「会话是否有若水运行记录」的判定是异步的,响应回来时用户可能已切到别的
// 会话;旧会话的 isRs 结论会写进 cache 并挂上新会话的「若水编排」页签(或反过来拆掉页签)。
// 修复后契约:响应落地时会话已切换则本次判定整体作废,既不写 cache 也不动页签;
// 同一会话的新判定仍照常生效(证明是「丢弃旧代」而非「停摆」)。
// client.js 为自包含 classic script:经 __ModuleLoader__ 捕获模块后,以最小宿主桩 apply,
// 直接驱动哨兵组件(会话 id 入口)与 deferred 的 /runs 响应,断言只落在可观察输出
// (conversation.view 插槽的注册/注销)。
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const CLIENT_SRC = readFileSync(fileURLToPath(new URL('../src/client.js', import.meta.url)), 'utf8')
const RUNS = 'https://rs.local/api/rsww/runs'

const ReactStub = {
  createElement: (type, props) => ({ type, props: props ?? {}, children: [] }),
  useState: (init) => [typeof init === 'function' ? init() : init, () => {}],
  useEffect: () => {},
  useCallback: (fn) => fn,
  useRef: (value) => ({ current: value }),
}

function createHost() {
  const registrations = []
  const unregistered = []
  const calls = []
  const control = { pending: [] }
  const fetchStub = (url) => {
    calls.push(String(url))
    if (!String(url).endsWith('/runs')) return Promise.resolve({ ok: true, json: async () => ({}) })
    return new Promise((resolve) => {
      control.pending.push((runs) => resolve({ ok: true, json: async () => ({ runs }) }))
    })
  }
  const windowStub = { __ModuleLoader__: { load: (definition) => { windowStub.definition = definition } }, addEventListener() {}, removeEventListener() {} }
  const documentStub = {
    head: { appendChild() {} }, body: { appendChild() {} },
    createElement: () => ({ style: {}, setAttribute() {}, appendChild() {} }),
    addEventListener() {}, removeEventListener() {}, querySelector: () => null,
  }
  new Function('window', 'document', 'navigator', 'fetch', `${CLIENT_SRC}\n;return null`)(windowStub, documentStub, {}, fetchStub)
  assert.ok(windowStub.definition, 'client.js 未自注册')

  const bus = { subscribe: () => () => {}, publish: () => {} }
  const tools = {
    setupCommonTools: () => bus,
    createSnapshotRefresh: (fn) => ({ refresh: () => { void fn() }, dispose() {} }),
    toast: { show() {} },
    subscribeChanges: () => () => {},
    startChanges: () => () => {},
  }
  const requireStub = (name) => {
    if (name === 'react') return ReactStub
    if (name === '@mzzsfy/dsh-common-tools/client') return tools
    throw new Error('模块表缺依赖:' + name)
  }
  const slots = {
    inject: (name, factory) => factory(),
    register(meta, component) {
      registrations.push({ meta, component })
      return () => { unregistered.push(meta.id); registrations.splice(registrations.findIndex((item) => item.meta.id === meta.id), 1) }
    },
  }
  const disposers = []
  const plugin = windowStub.definition.factory(requireStub)
  plugin.apply({
    get: () => undefined,
    effect: (fn) => { const dispose = fn(); if (typeof dispose === 'function') disposers.push(dispose); return () => {} },
    slots,
  })
  const sentinel = registrations.find((item) => item.meta.name === 'conversation.input.overlay')
  assert.ok(sentinel, '未注册会话哨兵插槽')
  return {
    calls,
    control,
    view: () => registrations.find((item) => item.meta.name === 'conversation.view') ?? null,
    /** 模拟宿主以当前会话 id 渲染哨兵 */
    async setSession(sessionId) {
      sentinel.component({ sessionId })
      await new Promise((resolve) => setImmediate(resolve))
    },
    /** 按发起顺序放行第 index 个在途 /runs 请求(0 = 最早) */
    async respond(index, runs) {
      assert.ok(control.pending.length > index, '没有第 ' + index + ' 个在途 /runs 请求')
      const resolve = control.pending[index]
      control.pending.splice(index, 1)
      resolve(runs)
      await new Promise((resolve) => setImmediate(resolve))
    },
    disposeAll() { for (const dispose of disposers) dispose?.() },
  }
}

test('F21b 迟到 judge:旧会话的判定结果不得挂到新会话的页签上', async (t) => {
  const host = createHost()
  t.after(() => host.disposeAll())

  // 会话 A(有运行记录)开始判定
  await host.setSession('session-A')
  assert.equal(host.calls.length, 1, '首次判定应发出 /runs 请求')
  // 响应回来前用户切到会话 B(无运行记录),B 自己的判定在途
  await host.setSession('session-B')
  assert.equal(host.calls.length, 2, '切会话应触发新判定')

  // A 的迟到响应此刻落地:它说「A 有运行记录」
  await host.respond(0, [{ sessionId: 'session-A', status: 'running' }])
  assert.equal(host.view(), null, '旧会话的 isRs 结论不得给新会话挂上「若水编排」页签')

  // B 自己的响应落地:B 也有运行记录 → 页签按 B 的结论挂上(证明判定未停摆)
  await host.respond(0, [{ sessionId: 'session-B', status: 'running' }])
  const view = host.view()
  assert.ok(view, '当前会话的判定结论必须生效')
  assert.equal(view.meta.label, '若水编排')
})

test('F21b 判否同样按代际:旧会话「无记录」的迟到结论不得拆掉新会话的页签', async (t) => {
  const host = createHost()
  t.after(() => host.disposeAll())

  await host.setSession('session-A')
  await host.setSession('session-B')
  // 新会话 B 先判定为有记录 → 页签在列(放行 B 自己的第 2 个请求)
  await host.respond(1, [{ sessionId: 'session-B', status: 'running' }])
  assert.ok(host.view(), 'B 判定为有记录后页签在列')

  // A 的迟到响应(无 A 的记录)落地:不得把 B 的页签拆掉
  await host.respond(0, [])
  assert.ok(host.view(), '旧会话的否定结论不得拆掉当前会话的页签')
})
