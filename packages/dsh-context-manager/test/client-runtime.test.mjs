import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { runInThisContext } from 'node:vm'

// client.js 运行时冒烟:契约测试只比对源码字符串,查不出跨组件作用域错误
// (实测漏过一个 ReferenceError:重拉入口引用了他组件的 ref,浏览器控制台才报,
// 143 条契约测试全绿)。这里真正加载 client.js、跑通 factory 模块求值、并把每个
// 已注册的插槽组件渲染一遍,让作用域/初始化类错误在测试阶段暴露。

const CLIENT_SRC = readFileSync(fileURLToPath(new URL('../src/client.js', import.meta.url)), 'utf8')
const nodeRequire = createRequire(import.meta.url)

// React 由宿主 profile 提供(本包仅声明 peerDependency,不随包安装);
// 组件函数体不渲染真实 DOM,只用 hooks 与 createElement,故不引入 react-dom
const ReactStub = (() => {
  const candidates = [
    'react',
    'C:/Users/yuanhao/.dsh/profiles/web/node_modules/react',
  ]
  for (const specifier of candidates) {
    try {
      const mod = nodeRequire(specifier)
      if (mod && typeof mod.useState === 'function') return mod
    } catch { /* 下一个候选 */ }
  }
  return null
})()

const HOST_HOOK = (name) => () => { throw new Error('缺少 react,无法执行 ' + name) }

// __ModuleLoader__ 桩:捕获 factory 与注册的插槽条目
function loadPlugin() {
  assert.ok(ReactStub, '运行时冒烟需要宿主的 react;未找到时本测试无法建立保障')
  const slots = []
  let captured = null
  // client.js 以 window/document/ MutationObserver 为宿主全局:桩全局后即在同上下文求值
  const saved = {
    window: globalThis.window,
    document: globalThis.document,
    MutationObserver: globalThis.MutationObserver,
  }
  // client.js 在 factory 求值期访问 window(工厂在宿主窗口内执行),故全局桩在
  // factory 调用期间也必须就位,不能只在 runInThisContext 期间挂载
  const stubWindow = {
    __ModuleLoader__: {
      load(definition) {
        captured = definition
      },
    },
    // 导航图标声明入口:吞噬,避免污染桩 window
    __navicIcons: { register() {} },
  }
  globalThis.window = stubWindow
  globalThis.document = {
    createElement: () => ({
      style: {},
      setAttribute() {},
      appendChild() {},
      addEventListener() {},
      querySelector: () => null,
      querySelectorAll: () => [],
    }),
    querySelector: () => null,
    querySelectorAll: () => [],
    addEventListener() {},
    documentElement: { appendChild() {} },
    head: { appendChild() {} },
  }
  globalThis.MutationObserver = class {
    observe() {}
    disconnect() {}
  }
  try {
    runInThisContext(CLIENT_SRC, { filename: 'client.js' })
    assert.ok(captured, 'client.js 必须调用 window.__ModuleLoader__.load 注册插件')
    const ctx = {
      get: () => undefined,
      slots: {
        inject: (name, register) => { register() },
        register: (definition, component) => { slots.push({ definition, component }); return () => {} },
      },
      remote: undefined,
      on: () => () => {},
      effect: () => {},
    }
    const plugin = captured.factory((specifier) => {
      if (specifier === 'react') return ReactStub
      throw new Error('模块表缺依赖:' + specifier)
    })
    assert.ok(typeof plugin === 'object' && plugin !== null, 'factory 应返回插件对象')
    return { plugin, slots, ctx, id: captured.id }
  } finally {
    globalThis.window = saved.window
    globalThis.document = saved.document
    globalThis.MutationObserver = saved.MutationObserver
  }
}

test('运行时:client.js 可加载并注册插件对象', () => {
  const { plugin, id } = loadPlugin()
  assert.equal(id, '@mzzsfy/dsh-context-manager')
  assert.equal(typeof plugin.apply, 'function', '插件应有 apply')
  assert.ok(Array.isArray(plugin.inject), '插件应声明 inject 依赖面')
  assert.ok(plugin.inject.includes('slots'), '插槽面是全部 UI 能力的载体')
})

test('运行时:apply 可执行且插槽全部注册成功(作用域错误在此暴露)', () => {
  const { plugin, slots, ctx } = loadPlugin()
  // 无远程服务面:走「干净禁用」路径,插槽注册仍应完成,不得抛错
  plugin.apply(ctx)
  assert.ok(slots.length > 0, 'apply 应至少注册一个插槽条目')
  for (const { component } of slots) {
    assert.equal(typeof component, 'function', '插槽条目必须是可渲染组件')
  }
})

test('运行时:每个插槽组件均可求值(跨组件作用域错误在此暴露)', () => {
  const { plugin, slots, ctx } = loadPlugin()
  plugin.apply(ctx)
  assert.ok(slots.length > 0)
  for (const { definition, component } of slots) {
    // 组件函数体在渲染期执行:跨组件变量引用错位会在此抛 ReferenceError
    // (实测漏过的正是 ReferenceError;hooks 与宿主注入的 hook 面在组件体外调用
    // 属宿主渲染器职责,本冒烟不模拟渲染器,故只对 ReferenceError 断言)
    try {
      component({ session: undefined, inputActions: undefined, useInput: undefined })
    } catch (error) {
      if (error instanceof ReferenceError) throw error
    }
  }
})

// 宿主侧无远程服务面时各入口的注册是「干净禁用」路径:插槽注册不得因缺面而中断
test('运行时:缺 remote.session 时仍完成全部插槽注册', () => {
  const { plugin, slots, ctx } = loadPlugin()
  assert.equal(ctx.remote, undefined)
  plugin.apply(ctx)
  const names = slots.map(({ definition }) => definition.name)
  assert.ok(names.includes('conversation.input.dock'), '输入框 dock 是 fork/历史/撤回三入口的载体')
})