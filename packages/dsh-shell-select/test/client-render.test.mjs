// 渲染守卫:全量执行 client.js 工厂(React 桩),实际调用注册出的 toolview
// 组件——纯文本/LOGIC 提取守卫抓不住的渲染期未定义引用(model 丢失事故)在此暴露。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const source = readFileSync(join(here, '..', 'src', 'client.js'), 'utf8')

function reactStub() {
  // 函数组件即时执行(模拟渲染语义):组件体内的未定义引用/坏访问当场抛出
  const createElement = (type, props, ...children) => {
    if (typeof type === 'function') return type(props ?? {})
    return { type, props, children }
  }
  return {
    createElement,
    useState: (init) => [typeof init === 'function' ? init() : init, () => {}],
    useEffect: () => {},
  }
}

// 加载 client.js 并执行 apply,返回 slots 注册面
function loadClient() {
  const React = reactStub()
  const registrations = []
  const slots = {
    inject: (_name, factory) => factory(),
    register: (meta, component) => registrations.push({ meta, component }),
  }
  const document = {
    documentElement: { lang: 'zh-CN' },
    createElement: () => ({ setAttribute: () => {}, remove: () => {}, style: {} }),
    head: { appendChild: () => {} },
  }
  let loaded
  const window = { __ModuleLoader__: { load: (definition) => { loaded = definition } } }
  new Function('window', 'document', 'navigator', source)(window, document, {}, undefined)
  assert.notEqual(loaded, undefined, 'client.js 未调用 __ModuleLoader__.load')
  const ctx = {
    effect(fn) {
      return fn()
    },
    slots,
  }
  loaded.factory((name) => {
    if (name === 'react') return React
    // 其余模块(primitives 等)按缺席处理:抛错触发 client 内 try/catch 降级
    throw new Error('module not available: ' + name)
  }).apply(ctx)
  return registrations
}

function toolviewOf(registrations, key) {
  const view = registrations.find((item) => item.meta.name === 'tool.call.toolview' && item.meta.key === key)
  assert.notEqual(view, undefined, `缺少 key=${key} 的 toolview 注册`)
  return view.component
}

// 已定调用块(官方形态:kind 字段在)
function settledBlock(argsRaw, text) {
  return {
    kind: 'tool',
    callId: 'c1',
    call: { callId: 'c1', name: 'shell', argsRaw },
    content: [{ type: 'text', text }],
  }
}

test('渲染守卫:settled terminal 调用组件执行不抛(引用完整)', () => {
  const component = toolviewOf(loadClient(), 'shell')
  const element = component({
    block: settledBlock(JSON.stringify({ command: 'git status', description: 'status' }), 'On branch main\n[exit code: 0]'),
    cwd: 'C:\\repo',
  })
  assert.notEqual(element, undefined)
})

test('渲染守卫:running 块组件执行不抛', () => {
  const component = toolviewOf(loadClient(), 'pwsh')
  const element = component({
    block: { callId: 'c2', name: 'pwsh', argsRaw: JSON.stringify({ command: 'Start-Sleep 1', description: 'wait' }), time: Date.now() - 65_000 },
    cwd: 'C:\\repo',
  })
  assert.notEqual(element, undefined)
})

test('渲染守卫:运行中卡展开后可见命令全文与实时时长', () => {
  const component = toolviewOf(loadClient(), 'shell')
  // 默认收起:运行中折叠行 = 黄点 + 描述 + 时长,不含卡体
  const element = component({
    block: { callId: 'c3', name: 'shell', argsRaw: JSON.stringify({ command: 'npm run build', description: 'build' }), time: Date.now() - 65_000 },
    cwd: 'C:\\repo',
  })
  assert.doesNotMatch(JSON.stringify(element), /sls-tv__body/)
  assert.match(JSON.stringify(element), /1:05/)
})

test('渲染守卫:后台 ack 块(默认收起行 + 任务号徽标)组件执行不抛', () => {
  const component = toolviewOf(loadClient(), 'bash')
  const element = component({
    block: settledBlock(JSON.stringify({ command: 'npm test', description: 'tests', run_in_background: true }), 'started background job bg-1'),
    cwd: 'C:\\repo',
  })
  assert.notEqual(element, undefined)
})

test('设置卡注册:settings.section 单卡 id shell-select', () => {
  const registrations = loadClient()
  const card = registrations.find((item) => item.meta.name === 'settings.section')
  assert.notEqual(card, undefined)
  assert.equal(card.meta.id, 'shell-select')
})

test('图标名守卫:0.1.7 primitives 字重后缀名在场,尺寸后缀旧名不在首选位', () => {
  // 0.1.7 图标改名:尺寸从名字移除(IconApiOutline14 → IconApiOutlineRegular/Medium),
  // 旧名 miss 使 IconApi 落淡灰 fallback 被当成"空白 icon"(实测事故)
  assert.match(source, /'IconApiOutlineRegular'/)
  assert.match(source, /'IconChevronDownOutlineRegular'/)
  assert.match(source, /'IconInspectOutlineRegular'/)
  assert.doesNotMatch(source, /createElementOf\('IconApiOutline14'/)
})

test('名册单飞守卫:失败复位 promise,下次渲染重试(宿主启动窗口 404 不永久缺徽章)', () => {
  // 旧实现 catch 静默吞错且 promise 不复位:boot 窗口期 404 后所有卡永久缺客户端徽章
  assert.doesNotMatch(source, /catch\(\(\) => \{ \}\)/)
  assert.match(source, /clientCatalogPromise = null/)
})

test('后台卡头部守卫:状态点缺省渲染(bg pill 即标识),非法 StateDot state 不再传入', () => {
  // StateDot 合法 state 仅 done/warning/ongoing/error/idle;'none' 是编造值
  assert.match(source, /dot: undefined/)
  assert.match(source, /meta\.dot !== undefined \? TOOLVIEW_ICONS\.StateDot/)
  assert.doesNotMatch(source, /dot: 'none'/)
})

test('hooks 恒序守卫:组件内 hook 调用必须全部位于第一个提前 return 之前', () => {
  // 真实 React 的 hooks 链表按调用序对位:提前 return 之后的 hook 使不同
  // 块形态(generic/terminal)的 hook 数量分叉 → "Rendered fewer hooks
  // than expected" → 行组件树整棵卸载(shell 卡全消失事故)。React 桩无
  // hooks 链表,渲染守卫抓不住,必须源码结构断言。
  const extract = (name) => {
    const begin = source.indexOf(`function ${name}(`)
    assert.ok(begin >= 0, `缺函数 ${name}`)
    const beginLine = source.slice(0, begin).split('\n').length
    const body = source.slice(begin)
    const end = body.indexOf('\n    function ', 1)
    const scope = end >= 0 ? body.slice(0, end) : body
    const hookLines = [...scope.matchAll(/\b(?:useState|useEffect|useRef|useMemo|useCallback)\(/g)]
      .map((m) => beginLine + scope.slice(0, m.index).split('\n').length - 1)
    return { hookLines, scopeLines: beginLine + scope.split('\n').length }
  }
  const earlyReturnLine = (scope, beginLine) => {
    const m = /return h\(/.exec(scope)
    return m === null ? Number.POSITIVE_INFINITY : beginLine + scope.slice(0, m.index).split('\n').length - 1
  }
  for (const name of ['ShellToolRow', 'GenericShellRow', 'CopyButton', 'RunningDuration', 'ShellSelectApp']) {
    const { hookLines } = extract(name)
    const scopeBody = source.slice(source.indexOf(`function ${name}(`))
    const end = scopeBody.indexOf('\n    function ', 1)
    const scope = end >= 0 ? scopeBody.slice(0, end) : scopeBody
    const limit = earlyReturnLine(scope, source.slice(0, source.indexOf(`function ${name}(`)).split('\n').length)
    for (const line of hookLines) {
      assert.ok(line < limit, `${name} 的 hook 在第 ${line} 行,位于提前 return(第 ${limit} 行)之后:hooks 恒序被破坏`)
    }
  }
})
