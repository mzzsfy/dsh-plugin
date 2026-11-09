import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const source = readFileSync(new URL('../src/client.js', import.meta.url), 'utf8')

function loadPlugin({ modules = {} } = {}) {
  let registered
  const window = { __ModuleLoader__: { load: (entry) => { registered = entry } } }
  new Function('window', source)(window)
  const requireImpl = (id) => {
    if (Object.hasOwn(modules, id)) return modules[id]
    throw new Error(`module not registered: ${id}`)
  }
  return registered.factory(requireImpl)
}

const reactStub = {
  createElement: (type, props, ...children) => ({ type, props, children }),
  useState: () => [undefined, () => {}],
  useEffect: () => {},
}

// Given React 与 slots 就绪, When 注册设置 UI, Then 两个官方插槽都登记且 key 正确
test('设置UI_注册官方插槽', () => {
  const plugin = loadPlugin({ modules: { react: reactStub } })
  const registrations = []
  const injected = []
  const styleEffects = []
  const scope = {
    slots: {
      inject: (name, callback) => { injected.push(name); callback() },
      register: (options, component) => registrations.push({ options, component }),
    },
    effect: (factory) => { styleEffects.push(factory) },
  }
  const ctx = { inject: (services, callback) => { if (services.includes('slots')) callback(scope) } }
  plugin.__test.registerSettingsUi(ctx)
  assert.deepEqual(injected.sort(), ['plugins.bundle.config', 'settings.plugin.item'])
  const byName = Object.fromEntries(registrations.map((entry) => [entry.options.name, entry.options]))
  assert.equal(byName['settings.plugin.item'].key, 'bug-perf')
  assert.equal(byName['plugins.bundle.config'].key, '@mzzsfy/dsh-bug-perf')
  assert.equal(styleEffects.length, 1)
})

// Given 无 React 或 slots, When 注册, Then 静默跳过,不影响其它补丁
test('设置UI_缺依赖_静默跳过', () => {
  const noReact = loadPlugin()
  let called = false
  noReact.__test.registerSettingsUi({ inject: () => { called = true } })
  assert.equal(called, false)
  const plugin = loadPlugin({ modules: { react: reactStub } })
  assert.doesNotThrow(() => plugin.__test.registerSettingsUi({}))
})

// Given 设置节定义, When 检查字段, Then 各节与共享配置的键一致
test('设置UI_节字段与配置同源', () => {
  const plugin = loadPlugin({ modules: { react: reactStub } })
  const keys = plugin.__test.UI_SECTIONS.map((section) => section.key)
  assert.deepEqual(keys, Object.keys(plugin.__test.DEFAULT_CONFIG))
  for (const section of plugin.__test.UI_SECTIONS) {
    for (const field of section.fields) {
      assert.equal(typeof plugin.__test.DEFAULT_CONFIG[section.key][field.name], 'number')
    }
  }
})

// Given 客户端注入设置样式, When 检查注入契约, Then data-plugin 与样式创建点数一致且开关选择器锚定 checkbox
test('设置UI_样式注入契约', () => {
  const creates = (source.match(/createElement\('style'\)/g) ?? []).length
  const markers = (source.match(/style\.setAttribute\('data-plugin'/g) ?? []).length
  assert.equal(creates, 2)
  assert.equal(markers, creates)
  assert.match(source, /input\[type="checkbox"\]:checked \+ \.bp-switch__track/)
  assert.match(source, /input\[type="checkbox"\]:focus-visible \+ \.bp-switch__track/)
})
