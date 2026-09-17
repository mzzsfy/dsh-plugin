// 标题栏复制 sessionId:接线与门控测试。加载真实 src/client.js,断言 header.actions
// 插槽注册、inject 契约、开关门控(停用不渲染)与复制动作(toast 反馈);
// 复制本体 copySidText 为纯函数切片(剪贴板/文档依赖注入)。
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const PKG_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const CLIENT_SRC = readFileSync(join(PKG_ROOT, 'src', 'client.js'), 'utf8')

// fetch 桩:按 URL 返回预设 payload;未预设的 URL 抛错(暴露意外请求)
function withFetchStub(routes, run) {
  const original = globalThis.fetch
  globalThis.fetch = async (url) => {
    const hit = routes.find((route) => String(url).startsWith(route.path))
    if (!hit) throw new Error('意外请求: ' + String(url))
    if (hit.reject) throw new Error('network down')
    return { ok: true, status: 200, json: async () => hit.body }
  }
  return Promise.resolve()
    .then(run)
    .finally(() => { globalThis.fetch = original })
}

// client.js 装载:react 桩为可驱动微型模拟(useState 槽位 / useEffect 收集 /
// createElement 记录),apply 后返回捕获的插槽注册表
function loadClientHarness({ documentStub } = {}) {
  const modules = []
  const registered = []
  const toasts = []
  const elements = []
  const hookSlots = []
  const effects = []
  // hook 游标:每次渲染前置 0,useState 按调用序读写槽位(模拟 React hook 链)
  let hookCursor = 0
  const reactStub = {
    useState: (init) => {
      let cell = hookSlots[hookCursor]
      if (!cell) {
        cell = { value: init }
        hookSlots[hookCursor] = cell
      }
      hookCursor += 1
      return [cell.value, (next) => { cell.value = typeof next === 'function' ? next(cell.value) : next }]
    },
    useEffect: (fn) => { effects.push(fn) },
    useRef: (value) => ({ current: value }),
    createElement: (type, props, ...children) => {
      const element = { type, props: props || {}, children }
      elements.push(element)
      return element
    },
  }
  const requireStub = (name) => {
    if (name === '@mzzsfy/dsh-toast/client') return { show: (text, opts) => toasts.push({ text, opts }) }
    return reactStub
  }
  const document = documentStub || {
    createElement: () => ({ style: {}, remove() {} }),
    head: { appendChild: () => {} },
    body: { appendChild: () => {} },
  }
  const factory = new Function('window', 'require', 'document', CLIENT_SRC + '\n;return null')
  factory({ __ModuleLoader__: { load: (module) => modules.push(module) }, addEventListener: () => {} }, requireStub, document)
  assert.equal(modules.length, 1, 'client.js 模块未被捕获')
  const mod = modules[0].factory(requireStub)
  const sessions = { binding: () => undefined, fork: () => Promise.resolve('child-1'), open: () => {} }
  const ctx = {
    get: (name) => (name === 'sessions' ? sessions : {}),
    effect: () => {},
    slots: {
      inject: (name, register) => register(),
      register: (options, component) => registered.push({ options, component }),
    },
    remote: { session: { follow: () => (async function* () { yield { type: 'snapshot', cursor: 0, records: [] }; await new Promise(() => {}) })() } },
  }
  mod.apply(ctx)
  return {
    registered,
    toasts,
    // 首渲染:清空 hook 槽位与效果队列后跑组件(全新挂载);效果同步执行
    render(component, props) {
      effects.length = 0
      elements.length = 0
      hookSlots.length = 0
      hookCursor = 0
      const output = component(props)
      for (const effect of effects.splice(0)) effect()
      return output
    },
    // 重渲染:保留 hook 槽位(setter 已写入的状态生效),不重跑效果——忠实
    // React 空 deps effect 只跑一次的语义
    rerender(component, props) {
      elements.length = 0
      hookCursor = 0
      return component(props)
    },
    async settle() { await new Promise((resolve) => setTimeout(resolve, 0)) },
  }
}

function findCopySidEntry(harness) {
  const entry = harness.registered.find((item) => item.options.id === 'context-manager-copy-sid')
  assert.ok(entry, '未注册 id=context-manager-copy-sid 的标题栏条目')
  return entry
}

test('Given client.js 装载, When apply, Then header.actions 注册复制条目', () => {
  const harness = loadClientHarness()
  const entry = findCopySidEntry(harness)
  assert.equal(entry.options.name, 'conversation.session.header.actions', '应注册进标题栏 actions 插槽')
  assert.equal(entry.options.order, -9, '应紧随官方 agent-preset 标签(-10)之后')
  assert.equal(typeof entry.component, 'function', '条目缺组件')
  assert.equal(entry.options.inject, undefined, 'sessionId 由插槽 standardProps 下发,不需 inject')
})

test('Given 开关启用, When 渲染, Then 渲染 cx-sid 复制按钮', async () => {
  const harness = loadClientHarness()
  const { component } = findCopySidEntry(harness)
  let output
  await withFetchStub([{ path: '/api/context/copy-sid-enabled', body: { enabled: true } }], async () => {
    output = harness.render(component, { sessionId: 's1' })
    await harness.settle()
  })
  output = harness.rerender(component, { sessionId: 's1' })
  assert.equal(output.type, 'button', '启用时应渲染按钮')
  assert.equal(output.props.className, 'cx-sid')
  assert.equal(output.props.title, '复制 sessionId')
  assert.equal(output.props['aria-label'], '复制 sessionId')
})

test('Given 开关停用, When 渲染, Then 不渲染(整体 null)', async () => {
  const harness = loadClientHarness()
  const { component } = findCopySidEntry(harness)
  let output
  await withFetchStub([{ path: '/api/context/copy-sid-enabled', body: { enabled: false } }], async () => {
    output = harness.render(component, { sessionId: 's1' })
    await harness.settle()
  })
  output = harness.rerender(component, { sessionId: 's1' })
  assert.equal(output, null, '停用后按钮整体不渲染')
})

test('Given 启停读取失败, When 渲染, Then 按启用兜底(fail-open,与既有开关一致)', async () => {
  const harness = loadClientHarness()
  const { component } = findCopySidEntry(harness)
  await withFetchStub([{ path: '/api/context/copy-sid-enabled', reject: true }], async () => {
    harness.render(component, { sessionId: 's1' })
    await harness.settle()
  })
  const output = harness.rerender(component, { sessionId: 's1' })
  assert.equal(output.type, 'button', '读取失败应按启用兜底')
})

test('Given 无 sessionId, When 渲染, Then 不渲染', () => {
  const harness = loadClientHarness()
  const { component } = findCopySidEntry(harness)
  const output = harness.render(component, {})
  assert.equal(output, null, '无会话 id 应不渲染')
})

// ── 纯函数切片:copySidText(剪贴板优先,execCommand 回退) ──

const PURE_START = CLIENT_SRC.indexOf('async function copySidText(')
const PURE_END = CLIENT_SRC.indexOf('function CopySidButton(')
assert.ok(PURE_START >= 0 && PURE_END > PURE_START, 'client.js copySidText 切片定位失败')
const { copySidText } = new Function(CLIENT_SRC.slice(PURE_START, PURE_END) + '; return { copySidText }')()

const FAKE_DOC = (execResult, execThrows) => {
  const appended = []
  return {
    appended,
    createElement: () => ({ style: {}, value: '', setAttribute() {}, select() {}, remove() { appended.push('removed') } }),
    body: { appendChild: (node) => appended.push(node) },
    execCommand: () => { if (execThrows) throw new Error('exec down'); return execResult },
  }
}

test('copySidText:clipboard.writeText 可用即成功', async () => {
  const writes = []
  const done = await copySidText('s1', { writeText: async (text) => { writes.push(text) } }, FAKE_DOC(true))
  assert.equal(done, true)
  assert.deepEqual(writes, ['s1'])
})

test('copySidText:writeText 抛错回退 execCommand 成功', async () => {
  const doc = FAKE_DOC(true)
  const done = await copySidText('s1', { writeText: async () => { throw new Error('denied') } }, doc)
  assert.equal(done, true)
  // 临时文本域被 append 且随后移除(无残留)
  assert.equal(doc.appended.filter((node) => typeof node === 'string' && node === 'removed').length, 1, '回退路径应清理临时文本域')
  assert.equal(doc.appended.length, 2, 'append 后必须紧跟 remove')
})

test('copySidText:无 clipboard 时走 execCommand 回退', async () => {
  assert.equal(await copySidText('s1', undefined, FAKE_DOC(true)), true)
  assert.equal(await copySidText('s1', undefined, FAKE_DOC(false)), false)
  const throwing = FAKE_DOC(null, true)
  assert.equal(await copySidText('s1', undefined, throwing), false)
  // finally 清理语义:execCommand 抛错路径临时节点同样必须移除,不得残留 DOM
  assert.deepEqual(
    throwing.appended.filter((entry) => entry === 'removed').length,
    throwing.appended.filter((entry) => typeof entry !== 'string').length,
    '每个 append 的临时节点都必须紧跟一次 remove',
  )
})

// ── 点击动作:toast 反馈 ──

test('Given 点击按钮, When 复制成功, Then toast 已复制 sessionId', async () => {
  const harness = loadClientHarness({ documentStub: FAKE_DOC(true) })
  const { component } = findCopySidEntry(harness)
  let output
  await withFetchStub([{ path: '/api/context/copy-sid-enabled', body: { enabled: true } }], async () => {
    output = harness.render(component, { sessionId: 's1' })
    await harness.settle()
  })
  output = harness.rerender(component, { sessionId: 's1' })
  output.props.onClick()
  await harness.settle()
  assert.deepEqual(harness.toasts, [{ text: '已复制 sessionId', opts: undefined }])
})

test('Given 点击按钮, When 复制失败, Then toast 复制失败(error)且不误报成功', async () => {
  const harness = loadClientHarness({ documentStub: FAKE_DOC(false) })
  const { component } = findCopySidEntry(harness)
  let output
  await withFetchStub([{ path: '/api/context/copy-sid-enabled', body: { enabled: true } }], async () => {
    output = harness.render(component, { sessionId: 's1' })
    await harness.settle()
  })
  output = harness.rerender(component, { sessionId: 's1' })
  output.props.onClick()
  await harness.settle()
  assert.deepEqual(harness.toasts, [{ text: '复制失败', opts: { kind: 'error' } }])
})

// ── 源码契约:显隐 CSS 与设置卡开关行 ──

test('CSS 显隐契约:默认隐藏,整行悬停/自身悬停/键盘聚焦显示,reduced-motion 关过渡', () => {
  assert.match(CLIENT_SRC, /\.cx-sid \{[^}]*opacity:0/, '按钮默认必须隐藏')
  assert.match(CLIENT_SRC, /\[class\*="_header"\]:has\(\.cx-sid\):hover \.cx-sid/, '标题栏整行悬停应显示按钮')
  assert.match(CLIENT_SRC, /\.cx-sid:hover, \.cx-sid:focus-visible \{ opacity:1/, '自身悬停与键盘聚焦必须兜底显示')
  assert.match(CLIENT_SRC, /@media \(prefers-reduced-motion: reduce\) \{ \.cx-sid \{ transition:none/, 'reduced-motion 应关闭过渡')
})

test('设置卡契约:第五开关行走 switchRow 工厂,挂 copy-sid-enabled 路由', () => {
  assert.ok(CLIENT_SRC.includes("switchRow(COPY_SID_ENABLED_URL, '标题栏复制 sessionId'"), '设置卡缺复制 sessionId 开关行')
  assert.ok(CLIENT_SRC.includes('h(CopySidSwitchRow)'), 'ContextPanel 未挂载第五开关行')
})
