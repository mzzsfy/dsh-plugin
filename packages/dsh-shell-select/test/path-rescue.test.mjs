// 侧栏路径救援测试:函数映射、地址语法与实际注入生命周期。
// BDD 场景见 docs/feat-shell-select-pathrescue/plan.md B 节。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const source = readFileSync(join(here, '..', 'src', 'client.js'), 'utf8')

function extractLogic(name, deps = {}) {
  const pattern = new RegExp('// LOGIC-BEGIN ' + name + '\\n([\\s\\S]*?)\\n\\s*// LOGIC-END ' + name)
  const match = source.match(pattern)
  if (!match) throw new Error('client.js 缺少 LOGIC 段: ' + name)
  const keys = Object.keys(deps)
  return new Function(...keys, 'return (' + match[1].trim() + ')')(...keys.map((key) => deps[key]))
}

const FACTS = { platform: 'win32', home: 'C:/Users/me', tmpDir: 'C:/Users/me/AppData/Local/Temp' }

function mountClient({ facts, hasEffect = true, laterWrapper = false }) {
  let definition
  let activeFacts = facts
  const registrations = []
  const disposers = []
  const controller = {
    calls: [],
    openResource(address, options) { this.calls.push({ method: 'openResource', address, options }); return 'opened' },
    openResourceIn(sessionId, address, options) { this.calls.push({ method: 'openResourceIn', sessionId, address, options }); return 'opened' },
  }
  const original = { openResource: controller.openResource, openResourceIn: controller.openResourceIn }
  const fetcher = () => activeFacts === null
    ? Promise.reject(new Error('route not ready'))
    : Promise.resolve({ ok: true, json: () => Promise.resolve(activeFacts) })
  new Function('window', 'document', 'navigator', 'fetch', source)(
    { __ModuleLoader__: { load: (value) => { definition = value } } },
    { createElement: () => ({ setAttribute() {}, remove() {} }), head: { appendChild() {} } },
    {}, fetcher,
  )
  const client = definition.factory((name) => name === 'react'
    ? { createElement: () => null, useState: () => [false, () => {}], useEffect() {} }
    : {})
  const ctx = {
    effect: (body) => body(),
    slots: { inject: (_hole, callback) => callback(), register: (meta) => registrations.push(meta) },
    inject: (names, callback) => {
      if (!names.includes('sidebarRight')) return
      callback({
        sidebarRight: controller,
        ...(hasEffect ? { effect: (body) => disposers.push(body()) } : {}),
      })
    },
  }
  client.apply(ctx)
  if (laterWrapper) {
    const wrapped = controller.openResource
    controller.openResource = function later(address, options) { return wrapped.call(this, address, options) }
  }
  return { controller, original, disposers, setFacts: (value) => { activeFacts = value } }
}

test('B5 盘根翻译:/c/x → C:/x,/c → C:/', () => {
  const translate = extractLogic('msysToHostPath')
  assert.equal(translate('/c/Users/x', FACTS), 'C:/Users/x')
  assert.equal(translate('/c', FACTS), 'C:/')
  assert.equal(translate('/C/Users/x', FACTS), 'C:/Users/x')
})

test('B5 home 翻译:~ 与 ~/x', () => {
  const translate = extractLogic('msysToHostPath')
  assert.equal(translate('~', FACTS), 'C:/Users/me')
  assert.equal(translate('~/a/b.txt', FACTS), 'C:/Users/me/a/b.txt')
})

test('B5 tmp 翻译:/tmp 与 /tmp/x', () => {
  const translate = extractLogic('msysToHostPath')
  assert.equal(translate('/tmp', FACTS), 'C:/Users/me/AppData/Local/Temp')
  assert.equal(translate('/tmp/x.log', FACTS), 'C:/Users/me/AppData/Local/Temp/x.log')
})

test('B5 非翻译形态原样:Windows 路径/相对路径/未知 POSIX 段', () => {
  const translate = extractLogic('msysToHostPath')
  assert.equal(translate('C:/repo/a.txt', FACTS), 'C:/repo/a.txt')
  assert.equal(translate('src/index.js', FACTS), 'src/index.js')
  assert.equal(translate('/usr/bin/bash', FACTS), '/usr/bin/bash')
  assert.equal(translate(42, FACTS), 42)
})

test('B6 file 地址翻译:session/absolute、空格与后缀', () => {
  const translate = extractLogic('msysToHostPath')
  const rescue = extractLogic('rescueFileAddress')
  assert.equal(rescue('dsh-resource://file/session/s1//c/Users/x.txt', translate, FACTS), 'dsh-resource://file/session/s1/C:/Users/x.txt')
  assert.equal(rescue('dsh-resource://file/absolute/c/Users/y%20x.md', translate, FACTS), 'dsh-resource://file/absolute/C:/Users/y%20x.md')
  assert.ok(rescue('dsh-resource://file/absolute/c/Users/y.md?line=3', translate, FACTS).endsWith('?line=3'))
  const unchanged = 'dsh-resource://file/absolute/C%3A/Users/z.txt'
  assert.equal(rescue(unchanged, translate, FACTS), unchanged)
})

test('B6 非 file、UNC、坏转义地址原样', () => {
  const translate = extractLogic('msysToHostPath')
  const rescue = extractLogic('rescueFileAddress')
  for (const address of [
    'dsh-resource://other/abc', 'not an address',
    'dsh-resource://file/absolute//server/share/x',
    'dsh-resource://file/absolute/%zz/x',
  ]) assert.equal(rescue(address, translate, FACTS), address)
})

test('B6 编码 sessionId 翻译后只编码一次', () => {
  const translate = extractLogic('msysToHostPath')
  const rescue = extractLogic('rescueFileAddress')
  const address = 'dsh-resource://file/session/s%201//c/Users/x.txt'
  assert.equal(rescue(address, translate, FACTS), 'dsh-resource://file/session/s%201/C:/Users/x.txt')
})

test('B6 地址翻译函数是纯函数,平台门由运行时安装包装负责', () => {
  const translate = extractLogic('msysToHostPath')
  assert.equal(translate('/c/x', null), 'C:/x')
  const rescue = extractLogic('rescueFileAddress')
  assert.equal(rescue('dsh-resource://file/absolute/c/x', translate, FACTS), 'dsh-resource://file/absolute/C:/x')
})

test('B7 可观察的 sidebar 包装透传两个入口并在 fiber dispose 后恢复', async () => {
  const mounted = mountClient({ facts: FACTS })
  await new Promise((resolve) => setImmediate(resolve))
  const { controller, original, disposers } = mounted
  assert.equal(controller.openResource('dsh-resource://file/absolute/c/x', { tab: true }), 'opened')
  assert.deepEqual(controller.calls.at(-1), { method: 'openResource', address: 'dsh-resource://file/absolute/C:/x', options: { tab: true } })
  assert.equal(controller.openResourceIn('s2', 'dsh-resource://file/session/s1//c/x', { line: 2 }), 'opened')
  assert.equal(controller.calls.at(-1).address, 'dsh-resource://file/session/s1/C:/x')
  assert.equal(controller.calls.at(-1).sessionId, 's2')
  disposers[0]()
  assert.equal(controller.openResource, original.openResource)
  assert.equal(controller.openResourceIn, original.openResourceIn)
  controller.openResource('dsh-resource://file/absolute/c/x')
  assert.equal(controller.calls.at(-1).address, 'dsh-resource://file/absolute/c/x')
})

test('B7 缺少 effect 清理能力时不改写侧栏方法', () => {
  const mounted = mountClient({ facts: FACTS, hasEffect: false })
  assert.equal(mounted.controller.openResource, mounted.original.openResource)
  assert.equal(mounted.controller.openResourceIn, mounted.original.openResourceIn)
})

test('B7 后续插件包装仍保留,卸载只移除本插件包装', async () => {
  const mounted = mountClient({ facts: FACTS, laterWrapper: true })
  await new Promise((resolve) => setImmediate(resolve))
  const laterWrapper = mounted.controller.openResource
  mounted.disposers[0]()
  assert.equal(mounted.controller.openResource, laterWrapper)
  mounted.controller.openResource('dsh-resource://file/absolute/c/x')
  assert.equal(mounted.controller.calls.at(-1).address, 'dsh-resource://file/absolute/c/x')
})

test('B7 pathmap 请求失败可在后续调用重试', async () => {
  const mounted = mountClient({ facts: null })
  await new Promise((resolve) => setImmediate(resolve))
  mounted.setFacts(FACTS)
  mounted.controller.openResource('dsh-resource://file/absolute/c/x')
  await new Promise((resolve) => setImmediate(resolve))
  mounted.controller.calls.length = 0
  mounted.controller.openResource('dsh-resource://file/absolute/c/x')
  assert.equal(mounted.controller.calls[0].address, 'dsh-resource://file/absolute/C:/x')
})

test('B7 非 Windows pathmap 不改写原地址', async () => {
  const mounted = mountClient({ facts: { ...FACTS, platform: 'linux' } })
  await new Promise((resolve) => setImmediate(resolve))
  mounted.controller.openResource('/c/x')
  assert.equal(mounted.controller.calls[0].address, '/c/x')
})
