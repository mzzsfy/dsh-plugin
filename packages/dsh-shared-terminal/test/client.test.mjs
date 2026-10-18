import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import { setImmediate as settled } from 'node:timers/promises'

const source = readFileSync(new URL('../src/client.js', import.meta.url), 'utf8')
function fixture({ tabs = [], params = {}, listed = async () => ({ ok: true, value: [{ id: 'term-a' }] }) } = {}) {
  let definition, component
  const effects = [], calls = [], seen = [], refs = []
  let index = 0, declared = false, active = true
  const React = {
    createElement(type, props, ...children) {
      if (typeof type === 'function') return type({ ...(props ?? {}), children })
      return { type, props: props ?? {}, children }
    },
    useEffect(effect) { effects.push(effect) },
    useRef(value) { const slot = index++; return refs[slot] ??= { current: value } },
    // 恒展开:官方行折叠态不含展开体,本文件验证结果数据可达导航;展开交互在 toolview.test.mjs
    useState() { return [true, () => {}] },
  }
  const sidebarRight = {
    openTabIn(...args) { calls.push(args) },
    openResourceIn(...args) { calls.push(['reveal', ...args]) },
    openTabs: { getSnapshot: () => tabs },
    tabDomain: { occurrence: () => ({ navigation: { getSnapshot: () => ({ params }) } }) },
  }
  const remote = { terminal: { async list(sessionId) { seen.push(sessionId); return listed(sessionId) } } }
  new vm.Script(source).runInNewContext({
    AbortController,
    document: { createElement: () => ({ setAttribute: () => {}, remove: () => {}, style: {}, textContent: '' }), head: { appendChild: () => {} } },
    window: { __ModuleLoader__: { load(value) { definition = value } } },
  })
  assert.equal(definition.id, '@mzzsfy/dsh-shared-terminal')
  const primitives = new Proxy({}, { get: (_target, name) => (props) => ({ type: String(name), props: props ?? {} }) })
  const plugin = definition.factory((id) => { if (id === 'react') return React; if (id === '@deepseek-ai/dsh-client-ui-primitives') return primitives; throw new Error('unexpected module ' + id) })
  const slots = {
    inject(name, factory) { assert.equal(name, 'tool.call.toolview'); declared = true; factory() },
    register(meta, view) { assert.equal(declared, true); assert.equal(meta.key, 'terminal'); component = view; return () => { active = false } },
  }
  plugin.apply({ remote, slots, sidebarRight, locale: { register: () => {} }, effect: (fn) => fn() })
  return {
    calls, seen, plugin,
    render(props) { index = 0; return component(props) },
    async flush() { const pending = effects.splice(0).map((effect) => effect()); await settled(); return pending },
  }
}
test('Given an existing terminal tab, When reopening result, Then it reveals the same tab with identity intact', async () => {
  const app = fixture({ tabs: [{ sessionId: 'session-a', kind: 'terminal', tabId: 'tab', contentId: 'dsh-resource://terminal/content' }], params: { terminalId: 'term-a' } })
  app.render(props('open'))
  await app.flush()
  assert.equal(JSON.stringify(app.calls), JSON.stringify([['reveal', 'session-a', 'dsh-resource://terminal/content', { kind: 'terminal', params: { terminalId: 'term-a' } }]]))
})

test('Given remote query pending, When effect unmounts and same result remounts, Then only the new lifetime may navigate', async () => {
  const pending = []
  const app = fixture({ listed: () => new Promise((resolve) => pending.push(resolve)) })
  app.render(props('open'))
  const cleanups = await app.flush()
  cleanups.forEach((cleanup) => cleanup?.())
  pending.shift()({ ok: true, value: [{ id: 'term-a' }] })
  await settled()
  assert.equal(app.calls.length, 0)
  app.render(props('open'))
  await app.flush()
  pending.shift()({ ok: true, value: [{ id: 'term-a' }] })
  await settled()
  assert.equal(app.calls.length, 1)
})

const props = (action, result = { ok: true, terminal_id: 'term-a' }) => ({
  phase: 'result', sessionId: 'session-a', callId: 'call-a', toolName: 'terminal',
  block: { call: { name: 'terminal', argsRaw: JSON.stringify({ action }) }, isError: false, content: [{ type: 'text', text: JSON.stringify(result) }] },
})
const walk = (tree) => {
  if (tree === null || tree === undefined || tree === false || tree === true) return []
  if (Array.isArray(tree)) return tree.flatMap(walk)
  if (typeof tree !== 'object') return [tree]
  if (!('type' in tree)) return typeof tree === 'string' ? [tree] : []
  return [tree, ...walk(tree.children), ...walk(tree.props?.children)]
}

test('Given classic-script loader and declared slot, When plugin materializes, Then its service gates and renderer register', () => {
  const app = fixture()
  assert.deepEqual(Array.from(app.plugin.inject), ['remote', 'remote.terminal', 'slots', 'sidebarRight', 'locale'])
  assert.ok(app.render(props('open')))
})

test('Given successful open result, When rendering then committing effect, Then only the owner Session native tab opens once', async () => {
  const app = fixture()
  const tree = app.render(props('open'))
  assert.equal(app.calls.length, 0)
  assert.match(JSON.stringify(tree), /term-a/)
  await app.flush()
  app.render(props('open'))
  await app.flush()
  assert.equal(app.calls.length, 1)
  assert.equal(JSON.stringify(app.calls[0]), JSON.stringify(['session-a', 'terminal', { params: { terminalId: 'term-a' } }]))
  assert.deepEqual(app.seen, ['session-a'])
})

test('Given read/write/close or error result, When committing renderer, Then output stays visible without automatic navigation', async () => {
  const app = fixture()
  const readTree = app.render(props('read', { ok: true, terminal_id: 'term-a', text: 'visible-screen' }))
  assert.match(JSON.stringify(readTree), /visible-screen/)
  await app.flush()
  for (const action of ['write', 'close']) {
    const tree = app.render(props(action, { ok: true, terminal_id: 'term-a' }))
    assert.match(JSON.stringify(tree), /"data-state":"done"/)
    await app.flush()
  }
  const tree = app.render(props('open', { ok: false, error: { code: 'LIMIT_REACHED', message: 'limit' } }))
  assert.match(JSON.stringify(tree), /LIMIT_REACHED/)
  await app.flush()
  assert.equal(app.calls.length, 0)
})

test('Given old open result for a closed terminal, When effect replays, Then no lost terminal is reopened', async () => {
  const app = fixture()
  const history = props('open', { ok: true, terminal_id: 'closed' })
  app.render(history)
  await app.flush()
  assert.equal(app.calls.length, 0)
})

test('Given successful open result, When clicking the terminal button, Then explicit navigation is scoped to that Session', async () => {
  const app = fixture()
  const tree = app.render(props('open'))
  const button = walk(tree).find((node) => node.type === 'button')
  assert.ok(button)
  await app.flush()
  app.calls.length = 0
  await button.props.onClick()
  assert.equal(app.calls.length, 1)
})

test('Given preparing or start phase, When rendering, Then a visible tool status is present', () => {
  const app = fixture()
  for (const phase of ['preparing', 'start']) {
    assert.ok(app.render({ phase, sessionId: 'session-a', callId: phase, toolName: 'terminal', block: { argsRaw: '{"action":"read"}' } }))
  }
})
