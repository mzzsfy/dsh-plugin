// 通知点击直达与身份高亮 BDD:
// 点击行为按通知携带的 sessionId 身份导航(uiWorkspace.openSession),不再按侧边栏 DOM
// 标题模拟点击;macOS 桌面壳经 focus-desktop 端点唤起;导航服务按实例登记、存活实例接管。
// 客户端片段按源码标记切片后在桩环境求值,宿主路由片段同样按标记切片求值;
// 高亮/提醒/代际套件走完整源码与真实 factory/apply/poll 链路。
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { buildUnit, buildWebhookPayload } from '../src/core.mjs'

const source = readFileSync(new URL('../src/client.js', import.meta.url), 'utf8')
const host = readFileSync(new URL('../src/index.js', import.meta.url), 'utf8')
const REMIND_MS = 10 * 60 * 1000
const navigation = source.slice(source.indexOf('const sessionNavigators = new Map()'), source.indexOf('// ---- 审批/提问超时二次提醒'))
const system = source.slice(source.indexOf('function notifySystem('), source.indexOf('// ---- 投影快照与认领'))

// 切片求值只含导航与系统通知段,身份判定与已读收尾以同名实现注入,
// 保证被测片段的调用形态与完整源码一致
function clickFixture({ protocol = 'dsh-app:', platform = 'darwin', focusThrows = false, openThrows = false, wakeFails = false } = {}) {
  const opened = [], requests = [], messages = [], notifications = []
  let focuses = 0
  const window = { location: { protocol }, focus() { focuses++; if (focusThrows) throw new Error('focus') } }
  const document = { documentElement: { dataset: { platform } } }
  const api = async (...args) => { requests.push(args); if (wakeFails) throw new Error('wake'); return { ok: true } }
  const toast = (message) => messages.push(message)
  class Notification { constructor(title, options) { Object.assign(this, { title, options, closed: false }); notifications.push(this) } close() { this.closed = true } }
  const runtime = new Function('window', 'document', 'api', 'toast', 'Notification', 'TOAST_MS', 'hasSessionId', 'markSessionHandled', 'notificationController', navigation + system + '\nreturn { activateSessionFromUnit, notifySystem, bind(value) { sessionNavigators.clear(); if (value) sessionNavigators.set(Symbol(), value) } }')(window, document, api, toast, Notification, 6000, (unit) => typeof unit.sessionId === 'string' && unit.sessionId.length > 0, () => {}, null)
  runtime.bind({ openSession(id) { if (openThrows) throw new Error('open'); opened.push(id) } })
  return { ...runtime, opened, requests, messages, notifications, focuses: () => focuses }
}

test('投影携带唯一会话ID，标题仍作展示，webhook 结构化同步且向后兼容', () => {
  const unit = buildUnit({ id: 'n', sessionId: 'session-42', sessionTitle: '同名标题', category: 'completed' })
  assert.equal(unit.sessionId, 'session-42')
  assert.equal(unit.session, '同名标题')
  assert.equal(buildUnit({}).sessionId, null)
  assert.equal(buildUnit({ sessionId: '' }).sessionId, null, '空串按缺省归 null')
  assert.equal(buildWebhookPayload(unit).sessionId, 'session-42', 'webhook 结构化字段同步会话 ID')
  assert.equal(buildWebhookPayload(buildUnit({})).sessionId, null, 'null 显式随行,消费方自行判空')
  assert.match(host, /status: reasonKind \?\? category,\s*sessionId,/)
})

test('真实系统通知点击回调按ID导航并关闭通知，通知创建不唤起App', async () => {
  const f = clickFixture()
  f.notifySystem({ id: 'n', text: '标题', summary: '摘要', sessionId: 's-target', session: '同名标题' })
  assert.equal(f.requests.length, 0, '通知创建不触发唤醒请求')
  assert.deepEqual(f.notifications[0].options, { tag: 'n', body: '摘要' })
  f.notifications[0].onclick()
  await Promise.resolve()
  assert.deepEqual(f.opened, ['s-target'])
  assert.equal(f.notifications[0].closed, true)
  assert.deepEqual(f.requests, [['/api/turn-notify/focus-desktop', { method: 'POST' }]])
})

test('重名、改名、空标题、跨工作区和折叠列表均按ID，不访问DOM', () => {
  const f = clickFixture({ protocol: 'http:' })
  for (const unit of [
    { sessionId: 'a', session: '相同标题', workspace: '/a' },
    { sessionId: 'b', session: '相同标题', workspace: '/b' },
    { sessionId: 'a', session: '旧标题' },
    { sessionId: 'c', session: null },
  ]) f.activateSessionFromUnit(unit)()
  assert.deepEqual(f.opened, ['a', 'b', 'a', 'c'])
  assert.equal(f.requests.length, 0)
})

test('旧通知或测试通知无ID时只聚焦，不按标题误跳', () => {
  const f = clickFixture({ protocol: 'http:' })
  for (const sessionId of [undefined, null, '', 42]) f.activateSessionFromUnit({ session: '存在同名行', sessionId })()
  assert.deepEqual(f.opened, [])
  assert.equal(f.focuses(), 4)
})

test('window.focus抛错不阻断ID导航；唤醒失败不产生未处理拒绝', async () => {
  const f = clickFixture({ focusThrows: true, wakeFails: true })
  f.notifySystem({ id: 'n', sessionId: 's' })
  assert.doesNotThrow(() => f.notifications[0].onclick())
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(f.opened, ['s'])
  assert.equal(f.notifications[0].closed, true)
  assert.equal(f.messages.length, 1)
})

test('导航服务缺席或调用失败时提示，不按标题走第二条路径', () => {
  const missing = clickFixture({ protocol: 'http:' })
  missing.bind(null)
  missing.activateSessionFromUnit({ sessionId: 's' })()
  assert.match(missing.messages[0], /尚未就绪/)
  const failed = clickFixture({ protocol: 'http:', openThrows: true })
  failed.notifySystem({ sessionId: 's' })
  failed.notifications[0].onclick()
  assert.match(failed.messages[0], /无法打开/)
  assert.equal(failed.notifications[0].closed, true)
})

test('普通浏览器和Windows桌面不请求macOS唤醒端点', () => {
  for (const config of [{ protocol: 'https:' }, { platform: 'win32' }]) {
    const f = clickFixture(config)
    f.activateSessionFromUnit({ sessionId: 's' })()
    assert.equal(f.requests.length, 0)
    assert.deepEqual(f.opened, ['s'])
  }
})

test('导航服务经注入生命周期绑定并卸载，不影响其他通知服务', () => {
  const start = source.indexOf("ctx.inject(['uiWorkspace']")
  const end = source.indexOf('// 样式挂载宿主文档级', start)
  let release
  const navigator = { openSession() {} }
  const ctx = { inject(names, fn) { assert.deepEqual(names, ['uiWorkspace']); fn({ get: () => navigator, effect(fn) { release = fn() } }) } }
  const run = new Function('ctx', 'const sessionNavigators = new Map();\n' + source.slice(start, end) + '\nreturn () => [...sessionNavigators.values()].at(-1) ?? null')
  const current = run(ctx)
  assert.equal(current(), navigator)
  release()
  assert.equal(current(), null)
})

test('宿主唤醒业务固定指向DSH，非macOS不执行且失败如实返回', async () => {
  const start = host.indexOf('  // 只唤起本机 macOS 桌面 App')
  const end = host.indexOf('  // 宿主通知测试点火互斥', start)
  const fragment = host.slice(start, end)
  for (const platform of ['darwin', 'linux']) {
    let registered, fail = false
    const calls = []
    const ctx = { effect(fn) { fn() }, webServer: { register(value) { registered = value } } }
    const route = (method, options, fn) => { assert.equal(method, 'POST'); assert.equal(options.crossOrigin, true); return fn }
    const spawn = { impl(...args) { calls.push(args.slice(0, 3)); args[3](fail ? new Error('failure') : null) } }
    new Function('ctx', 'route', 'sendJson', '__hostSpawn', 'process', 'HOST_FOCUS_TIMEOUT_MS', fragment)(ctx, route, (res, status, body) => Object.assign(res, { status, body }), spawn, { platform }, 5000)
    const res = {}
    await registered.handler({ body: { command: 'untrusted', url: 'https://example.org' } }, res)
    if (platform !== 'darwin') { assert.equal(res.status, 409); assert.equal(calls.length, 0); continue }
    assert.deepEqual(calls[0], ['/usr/bin/open', ['-b', 'com.deepseek.dsh', 'dsh://open'], { timeout: 5000 }])
    assert.deepEqual(res.body, { ok: true })
    fail = true
    await registered.handler({}, res)
    assert.equal(res.body.ok, false)
  }
})

// ---- 以下为身份高亮/提醒/代际套件:完整源码 + 真实 factory/apply/poll ----

// 仅替换浏览器/宿主边界；执行真实 factory、apply、poll 与回调。
function fixture({ rows = [], current = null, focus = false, highlight = true } = {}) {
  const definitions = [], shown = [], native = [], timers = new Map(), events = new Map(), storage = new Map()
  let payload = { version: 0, units: [] }, nextTimer = 0
  if (!highlight) storage.set('turn-notify:session-hl', '0')
  const rowEls = rows.map(({ id, title = '同名', running = false }) => {
    const classes = new Set()
    const row = {
      key: id === null ? null : 'session:' + id,
      textContent: (running ? '进行中' : '') + title,
      getAttribute: name => name === 'data-row-key' ? row.key : null,
      classList: { contains: c => classes.has(c), add: (...cs) => cs.forEach(c => classes.add(c)), remove: (...cs) => cs.forEach(c => classes.delete(c)) },
      querySelector: () => ({ textContent: title }), querySelectorAll: () => [{ textContent: title }],
      children: [], click() { throw new Error('导航不可点击DOM') },
    }
    Object.defineProperty(row, 'className', { get: () => [...classes].join(' '), set: value => { classes.clear(); value.split(' ').filter(Boolean).forEach(c => classes.add(c)) } })
    return row
  })
  const listen = (type, fn) => { if (!events.has(type)) events.set(type, new Set()); events.get(type).add(fn) }
  const unlisten = (type, fn) => events.get(type)?.delete(fn)
  const document = {
    hidden: !focus, title: '同名 — DeepSeek Harness', hasFocus: () => focus,
    body: {}, documentElement: { dataset: { platform: 'darwin' } },
    createElement: () => ({ setAttribute() {}, remove() {} }), head: { appendChild() {} },
    addEventListener: listen, removeEventListener: unlisten,
    querySelectorAll: selector => selector === '[data-row-key]' ? rowEls : selector === '.tn-sess-hl' ? rowEls.filter(row => row.classList.contains('tn-sess-hl')) : [],
  }
  const window = {
    __ModuleLoader__: { load: definition => definitions.push(definition) },
    location: { protocol: 'dsh-app:' }, focus() {},
    addEventListener: listen, removeEventListener: unlisten,
    localStorage: { get length() { return storage.size }, key: i => [...storage.keys()][i] ?? null,
      getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value), removeItem: key => storage.delete(key) },
  }
  const tools = { setupCommonTools: () => ({ subscribe: () => () => {} }), createSnapshotRefresh: refresh => ({ refresh, dispose() {} }),
    toast: { show: (text, opts) => shown.push({ text, opts }) } }
  class Notification {
    static permission = 'granted'
    constructor(text, options) { this.text = text; this.options = options; native.push(this) }
    close() { this.closed = true }
  }
  const setTimer = (fn, delay) => { timers.set(++nextTimer, { fn, delay }); return nextTimer }
  new Function('window', 'document', 'fetch', 'Notification', 'MutationObserver', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'requestAnimationFrame', 'cancelAnimationFrame', source)(
    window, document, async path => ({ ok: true, json: async () => path.endsWith('/sounds') ? { sounds: [] } : payload }), Notification,
    class { observe() {} disconnect() {} }, setTimer, id => timers.delete(id), setTimer, id => timers.delete(id), setTimer, id => timers.delete(id),
  )
  const factory = () => definitions[0].factory(name => name === 'react' ? {} : tools)
  const mod = factory()
  function owner(module = mod, { fail = false } = {}) {
    const opened = [], cleanups = [], subscriptions = new Set()
    let live = true, ownerCurrent = current
    const services = {
      uiWorkspace: { openSession(id) { assert.ok(live, '旧owner服务被调用'); if (fail) throw new Error('failed'); opened.push(id) } },
      sessions: { list: { getSnapshot() { assert.ok(live, '旧owner快照被读取'); return { byId: ownerCurrent ? { [ownerCurrent]: { id: ownerCurrent, retainedBy: { mainView: 1 } } } : {} } }, subscribe(fn) { subscriptions.add(fn); return () => subscriptions.delete(fn) } } }, workspaces: {},
    }
    module.apply({ get: key => services[key], effect(fn) { const off = fn(); if (typeof off === 'function') cleanups.push(off) },
      inject(names, callback) {
        if (names[0] !== 'uiWorkspace') return // 会话导航软依赖:接通登记,存活实例接管
        callback({ get: () => services.uiWorkspace, effect(fn) { const off = fn(); if (typeof off === 'function') cleanups.push(off) } })
      }, slots: { inject() {} } })
    return { opened, setCurrent(id) { ownerCurrent = id; for (const fn of subscriptions) fn() }, off() { while (cleanups.length) cleanups.pop()(); live = false } }
  }
  const emit = (type, event) => { for (const fn of [...(events.get(type) || [])]) fn(event) }
  return { mod, factory, owner, shown, native, rows: rowEls, window, timers,
    async notify(units, module = mod) { payload = { version: payload.version + 1, units }; assert.equal(await module.__test.poll(), true) },
    clickRow(index) { emit('click', { target: { closest: () => rowEls[index] } }) },
    remind() { for (const [id, timer] of [...timers]) if (timer.delay === REMIND_MS) { timers.delete(id); timer.fn() } },
    focus() { focus = true; document.hidden = false; emit('focus') },
  }
}
const unit = (id = 'B', category = 'ask') => ({ id: 'event-' + id, sessionId: id, session: '同名', category, text: '通知' + id })
const highlighted = row => row.classList.contains('tn-sess-hl')

test('N1 core保留身份且展示标题不变', () => {
  const result = buildUnit({ id: 'n', sessionId: 'B', sessionTitle: '同名', category: 'ask' })
  assert.equal(result.sessionId, 'B')
  assert.equal(result.session, '同名')
})

for (const rows of [[{ id: 'A' }, { id: 'B' }], [{ id: 'B' }], [], [{ id: 'B', title: '已改名' }]]) {
  test('N1 同名/单行/折叠/改名均按身份导航 ' + JSON.stringify(rows), async () => {
    const f = fixture({ rows }), a = f.owner()
    try {
      await f.notify([unit()])
      f.shown[0].opts.onClick(); f.native[0].onclick()
      assert.deepEqual(a.opened, ['B', 'B'])
      assert.equal(f.native[0].closed, true)
    } finally { a.off() }
  })
}

test('N1 无展示标题仍按身份导航；无身份仅聚焦', async () => {
  const f = fixture(), a = f.owner()
  try {
    await f.notify([{ ...unit(), session: null }, { id: 'bare', session: '同名', category: 'ask', text: '测试' }])
    f.shown[0].opts.onClick(); f.shown[1].opts.onClick()
    assert.deepEqual(a.opened, ['B'])
  } finally { a.off() }
})

test('N2 同名当前A不吞B高亮/提醒，点击A只清A', async () => {
  const f = fixture({ rows: [{ id: 'A' }, { id: 'B' }], current: 'A', focus: true }), a = f.owner()
  try {
    await f.notify([unit('A'), unit('B')])
    assert.deepEqual(f.rows.map(highlighted), [false, true])
    f.clickRow(0); f.remind()
    assert.ok(f.shown.some(item => item.text === '[再次提醒] 通知B'))
    assert.equal(f.shown.some(item => item.text === '[再次提醒] 通知A'), false)
  } finally { a.off() }
})

test('N2 同名双行点击身份A不清B；当前快照切B即已读', async () => {
  const f = fixture({ rows: [{ id: 'A' }, { id: 'B' }] }), a = f.owner()
  try {
    await f.notify([unit('A'), unit('B')])
    assert.deepEqual(f.rows.map(highlighted), [true, true])
    f.clickRow(0)
    assert.deepEqual(f.rows.map(highlighted), [false, true])
    a.setCurrent('B'); f.focus()
    assert.deepEqual(f.rows.map(highlighted), [false, false])
    const count = f.shown.length; f.remind(); assert.equal(f.shown.length, count)
  } finally { a.off() }
})

test('N2 缺失/重复DOM身份不误标；特殊字符按属性严格比较', async () => {
  const id = 'B"]#\\'
  const f = fixture({ rows: [{ id: 'B' }, { id: 'B' }, { id: null }, { id }] }), a = f.owner()
  try {
    await f.notify([unit('B'), unit(id)])
    assert.deepEqual(f.rows.map(highlighted), [false, false, false, true])
  } finally { a.off() }
})

test('N2 DOM复用和容量淘汰清旧类，分类更新不残留', async () => {
  const f = fixture({ rows: [{ id: 'B' }] }), a = f.owner()
  try {
    await f.notify([unit()]); assert.equal(highlighted(f.rows[0]), true)
    f.rows[0].key = 'session:other'
    await f.notify([unit()]); assert.equal(highlighted(f.rows[0]), false)
    f.rows[0].key = 'session:B'
    await f.notify([{ ...unit(), id: 'updated', category: 'error' }])
    assert.equal(f.rows[0].classList.contains('tn-sess-hl--error'), true)
    assert.equal(f.rows[0].classList.contains('tn-sess-hl--ask'), false)
    await f.notify(Array.from({ length: 20 }, (_, i) => unit('new-' + i)))
    assert.equal(highlighted(f.rows[0]), false)
  } finally { a.off() }
})

for (const options of [{ highlight: false }, { rows: [{ id: 'B', running: true }] }, { rows: [{ id: 'B' }] }]) {
  test('N3 高亮关闭/运行/容量淘汰均不等于处理 ' + JSON.stringify(options), async () => {
    const f = fixture(options), a = f.owner()
    try {
      await f.notify([unit()])
      if (options.rows?.[0]?.running === false || options.rows?.[0]?.running === undefined && options.rows) await f.notify([unit(), ...Array.from({ length: 20 }, (_, i) => unit('n-' + i))])
      f.remind()
      assert.ok(f.shown.some(item => item.text === '[再次提醒] 通知B'))
    } finally { a.off() }
  })
}

test('N3 关闭高亮时身份行点击仍处理；同会话后续新通知可再提醒', async () => {
  const f = fixture({ rows: [{ id: 'B' }], highlight: false }), a = f.owner()
  try {
    await f.notify([unit()]); f.clickRow(0); f.remind()
    assert.equal(f.shown.length, 1)
    await f.notify([{ ...unit(), id: 'new-B' }]); f.remind()
    assert.equal(f.shown.at(-1).text, '[再次提醒] 通知B')
  } finally { a.off() }
})

for (const first of [0, 1]) test('N4 任一owner先卸载均用存活服务 ' + first, async () => {
  const f = fixture(), owners = [f.owner(), f.owner()]
  try {
    await f.notify([unit()]); owners[first].off(); f.shown[0].opts.onClick()
    assert.deepEqual(owners[1 - first].opened, ['B']); assert.deepEqual(owners[first].opened, [])
  } finally { owners.forEach(owner => owner.off()) }
})

test('N4 最后卸载/同factory重启/HMR后旧动作不复活，旧cleanup不伤新代', async () => {
  const f = fixture(), a = f.owner()
  // 唤醒端点的失败提示异步落栈且不带 onClick,取卡片时按直达回调过滤
  const cards = () => f.shown.filter(item => typeof item.opts?.onClick === 'function')
  await f.notify([unit()]); const oldClick = f.shown[0].opts.onClick, oldNative = f.native[0]
  a.off(); oldClick(); oldNative.onclick(); assert.deepEqual(a.opened, [])
  const b = f.owner(); oldClick(); assert.deepEqual(b.opened, ['B'], '迟到闭包点击现读注册表,由同factory存活实例接管')
  await f.notify([{ ...unit(), id: 'B2' }])
  await new Promise(resolve => setImmediate(resolve))
  const bClick = cards().at(-1).opts.onClick
  const fresh = f.factory(), c = f.owner(fresh)
  bClick(); b.off(); a.off(); assert.deepEqual(b.opened, ['B', 'B'], 'B2 卡片点击由同 factory 存活的 b 接管')
  await f.notify([{ ...unit(), id: 'B3' }], fresh)
  await new Promise(resolve => setImmediate(resolve))
  cards().at(-1).opts.onClick()
  assert.deepEqual(c.opened, ['B']); c.off()
})

test('R1 关闭高亮时宿主导航查看B再离开仍撤销已读提醒', async () => {
  const f = fixture({ highlight: false, focus: true }), a = f.owner()
  try {
    await f.notify([unit('B')])
    a.setCurrent('B'); a.setCurrent('A')
    const count = f.shown.length
    f.remind()
    assert.equal(f.shown.length, count, '已查看B后离开也不再催')
  } finally { a.off() }
})

test('N5 导航抛错不误记处理且系统通知仍关闭', async () => {
  const f = fixture(), a = f.owner(f.mod, { fail: true })
  try {
    await f.notify([unit()]); assert.doesNotThrow(() => f.native[0].onclick())
    assert.equal(f.native[0].closed, true); f.remind()
    assert.equal(f.shown.at(-1).text, '[再次提醒] 通知B')
  } finally { a.off() }
})
