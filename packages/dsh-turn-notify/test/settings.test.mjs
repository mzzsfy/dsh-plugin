import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const source = readFileSync(new URL('../src/client.js', import.meta.url), 'utf8')
const nodes = node => !node || typeof node !== 'object' ? [] : Array.isArray(node)
  ? node.flatMap(nodes) : [node, ...(node.children || []).flatMap(nodes)]
const text = node => typeof node === 'string' ? node : Array.isArray(node)
  ? node.map(text).join('') : node?.children?.map(text).join('') || ''
const flush = () => new Promise(resolve => setImmediate(resolve))

function fixture({ config: seed = {}, prefs = {}, permission = 'granted', saveFails = false, testWait, loadFails = false, testFails = false } = {}) {
  const values = new Map(Object.entries(prefs)), states = [], refs = [], requests = [], feedback = []
  let cursor = 0, refCursor = 0, firstRender = true, component, mod
  let saved = { enabled: Object.fromEntries(['completed', 'error', 'interrupted', 'approval', 'ask', 'max-tokens'].map(k => [k, true])), imTargets: [], ...seed }
  const effects = [], listeners = {}
  const react = {
    useState(initial) {
      const i = cursor++
      if (!(i in states)) states[i] = typeof initial === 'function' ? initial() : initial
      return [states[i], value => { states[i] = typeof value === 'function' ? value(states[i]) : value }]
    },
    useRef(value) { const i = refCursor++; return refs[i] ||= { current: value } },
    useEffect(fn) { if (firstRender) effects.push(fn) },
    createElement: (type, props, ...children) => ({ type, props: props || {}, children }),
  }
  const window = { __ModuleLoader__: { load: entry => { mod = entry.factory(name => name === 'react' ? react : tools) } },
    localStorage: { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, String(value)) },
    addEventListener: (key, fn) => { (listeners[key] ||= []).push(fn) }, removeEventListener() {} }
  const tools = { setupCommonTools: () => ({}), toast: { show: message => feedback.push(message) } }
  const fetch = async (path, options = {}) => {
    requests.push({ path, ...options })
    if (path.endsWith('/test-webhook') && testWait) await testWait
    if (path.endsWith('/test-webhook') && testFails) throw new Error('测试网络故障')
    if (path.endsWith('/config') && !options.method && loadFails) return { ok: false, json: async () => ({ error: '无法连接' }) }
    if (path.endsWith('/config') && options.method === 'POST') {
      if (saveFails) return { ok: false, json: async () => ({ error: '保存故障' }) }
      const patch = JSON.parse(options.body)
      saved = { ...saved, ...patch }
    }
    const data = path.endsWith('/sounds') ? { sounds: [] } : path.includes('/test-') ? { ok: true, detail: 'HTTP 200' } : saved
    return { ok: true, json: async () => data }
  }
  const Notification = permission === 'unavailable' ? undefined : { permission }
  new Function('window', 'document', 'fetch', 'Notification', source)(window, {}, fetch, Notification)
  mod.apply({ get: () => ({}), inject() {}, effect() {}, slots: { inject: (_name, fn) => fn(), register: (_entry, render) => { component = render().type } } })
  const render = () => { cursor = 0; refCursor = 0; const tree = component(); firstRender = false; return tree }
  const find = predicate => nodes(render()).find(predicate)
  const control = name => find(n => n.props['aria-label'] === name || (n.type === 'input' && n.props.type === 'checkbox' && text(nodes(render()).find(p => p.type === 'label' && nodes(p).includes(n))) === name))
  const button = name => find(n => n.type === 'button' && text(n) === name)
  const tab = name => { const b = button(name); assert.ok(b, name + '入口存在'); b.props.onClick() }
  render(); effects.splice(0).forEach(fn => fn())
  return { render, find, control, button, tab, requests, values, feedback, listeners, ready: flush }
}

test('Given 旧补位开关开启 When 用户关闭桌面通知 Then 一次提交清除两个等效开关', async () => {
  const f = fixture({ config: { hostNotify: false, hostNotifyFallback: true } }); await f.ready()
  const control = f.control('后台桌面通知')
  assert.ok(control, '默认入口可操作后台桌面通知')
  assert.equal(control.props.checked, true)
  control.props.onChange({ target: { checked: false } }); await flush()
  assert.deepEqual(JSON.parse(f.requests.find(r => r.method === 'POST').body), { hostNotify: false, hostNotifyFallback: false })
  assert.equal(f.control('后台桌面通知').props.checked, false)
})

test('Given 页内音已开启 When 停用页内通知再恢复 Then 禁用子项但不丢失独立音偏好', async () => {
  const f = fixture({ prefs: { 'turn-notify:page-sound': '1' } }); await f.ready()
  f.control('显示页内通知').props.onChange({ target: { checked: false } })
  assert.equal(f.control('页内提示音').props.disabled, true)
  assert.equal(f.control('页内提示音').props.checked, true)
  assert.equal(f.find(n => n.props['aria-label'] === '页内提示样式').props.disabled, true)
  f.control('显示页内通知').props.onChange({ target: { checked: true } })
  assert.equal(f.control('页内提示音').props.disabled, false)
  assert.equal(f.values.get('turn-notify:page-sound'), '1')
})

test('Given 普通和页内声音均开启 When 关闭通知提示音 Then 页内声音仍开启并保留独立偏好', async () => {
  const f = fixture({ prefs: { 'turn-notify:page-sound': '1' } }); await f.ready()
  f.control('播放通知提示音').props.onChange({ target: { checked: false } })
  assert.equal(f.values.get('turn-notify:sound'), '0')
  assert.equal(f.control('页内提示音').props.checked, true)
  assert.equal(f.control('页内提示音').props.disabled, false)
})

test('Given 浏览器通知关闭 When 查看标题备用提醒 Then 子项禁用且已保存偏好保留', async () => {
  const f = fixture(); await f.ready()
  f.control('显示系统通知').props.onChange({ target: { checked: false } })
  assert.equal(f.control('通知不可用时闪烁标题').props.disabled, true)
  assert.equal(f.values.get('turn-notify:degrade-hint'), undefined)
})

test('Given 用户修改webhook When 保存失败 Then 草稿保留且测试不可用不发测试请求', async () => {
  const f = fixture({ config: { webhookUrl: 'https://old.example/hook' }, saveFails: true }); await f.ready(); f.tab('外部推送')
  f.control('webhook URL').props.onChange({ target: { value: 'https://new.example/hook' } })
  assert.equal(f.button('测试推送').props.disabled, true)
  f.button('保存地址').props.onClick(); await flush()
  assert.equal(f.control('webhook URL').props.value, 'https://new.example/hook')
  assert.equal(f.button('测试推送').props.disabled, true)
  assert.equal(f.requests.filter(r => r.path.endsWith('/test-webhook')).length, 0)
})

test('Given webhook已修改 When 成功保存再测试 Then 请求按保存和测试顺序使用新地址', async () => {
  const f = fixture(); await f.ready(); f.tab('外部推送')
  f.control('webhook URL').props.onChange({ target: { value: 'https://new.example/hook' } })
  f.button('保存地址').props.onClick(); await flush()
  assert.equal(f.button('测试推送').props.disabled, false)
  f.button('测试推送').props.onClick(); await flush()
  const posted = f.requests.filter(r => r.method === 'POST')
  assert.equal(posted[0].path, '/api/turn-notify/config')
  assert.deepEqual(JSON.parse(posted[0].body), { webhookUrl: 'https://new.example/hook' })
  assert.equal(posted[1].path, '/api/turn-notify/test-webhook')
})

test('Given 事件允许通知 When 切换事件按钮 Then aria-pressed与持久化状态一致', async () => {
  const f = fixture(); await f.ready(); f.tab('通知规则')
  assert.equal(f.button('任务完成').props['aria-pressed'], true)
  f.button('任务完成').props.onClick(); await flush()
  assert.equal(f.button('任务完成').props['aria-pressed'], false)
  assert.deepEqual(JSON.parse(f.requests.find(r => r.method === 'POST').body), { enabled: { completed: false } })
})

test('Given 桌面通知切换保存失败 When 双向切换 Then 恢复服务器实际开关', async () => {
  for (const enabled of [true, false]) {
    const f = fixture({ config: { hostNotify: false, hostNotifyFallback: enabled }, saveFails: true }); await f.ready()
    f.control('后台桌面通知').props.onChange({ target: { checked: !enabled } }); await flush()
    assert.equal(f.control('后台桌面通知').props.checked, enabled)
  }
})

test('Given webhook已保存并测试 When 清除 Then 地址与状态同步清空且不再允许测试', async () => {
  const f = fixture({ config: { webhookUrl: 'https://old.example/hook' } }); await f.ready(); f.tab('外部推送')
  f.button('测试推送').props.onClick(); await flush()
  f.button('清除').props.onClick(); await flush()
  assert.equal(f.control('webhook URL').props.value, '')
  assert.equal(f.button('测试推送').props.disabled, true)
  assert.match(text(f.find(n => n.props.role === 'status')), /已清除|已停用/)
})

test('Given webhook测试在途 When 用户查看地址操作 Then 不允许修改保存或清除直到响应结束', async () => {
  let finish
  const testWait = new Promise(resolve => { finish = resolve })
  const f = fixture({ config: { webhookUrl: 'https://old.example/hook' }, testWait }); await f.ready(); f.tab('外部推送')
  f.button('测试推送').props.onClick(); await flush()
  assert.equal(f.control('webhook URL').props.disabled, true)
  assert.equal(f.button('保存地址').props.disabled, true)
  assert.equal(f.button('清除').props.disabled, true)
  finish(); await flush()
  assert.equal(f.control('webhook URL').props.disabled, false)
})

test('Given 其他标签页关闭页内通知并静音 When storage事件及清空 Then 依赖与音量即时同步和恢复默认', async () => {
  const f = fixture({ prefs: { 'turn-notify:page-sound': '1' } }); await f.ready()
  f.values.set('turn-notify:toast', '0'); f.values.set('turn-notify:volume', '0')
  for (const fn of f.listeners.storage) fn({ key: 'turn-notify:toast' })
  assert.equal(f.control('显示页内通知').props.checked, false)
  assert.equal(f.control('页内提示音').props.disabled, true)
  assert.equal(f.control('通知音量').props.value, 0)
  f.values.clear()
  for (const fn of f.listeners.storage) fn({ key: null })
  assert.equal(f.control('显示页内通知').props.checked, true)
  assert.equal(f.control('通知音量').props.value, 0.6)
})

test('Given 共享配置加载失败 When 查看状态并重试 Then 明确失败原因且重新请求配置', async () => {
  const f = fixture({ loadFails: true }); await f.ready()
  assert.match(text(f.render()), /配置加载失败/)
  assert.equal(f.control('后台桌面通知').props.disabled, true)
  f.button('重新加载').props.onClick(); await flush()
  assert.equal(f.requests.filter(r => r.path.endsWith('/config') && !r.method).length, 2)
})

test('Given webhook请求网络失败 When 测试结束 Then 显示失败终态并解除锁定且地址保留', async () => {
  const f = fixture({ config: { webhookUrl: 'https://old.example/hook' }, testFails: true }); await f.ready(); f.tab('外部推送')
  f.button('测试推送').props.onClick(); await flush()
  assert.match(text(f.find(n => n.props.role === 'status')), /测试失败.*测试网络故障/)
  assert.equal(f.button('测试推送').props.disabled, false)
  assert.equal(f.control('webhook URL').props.value, 'https://old.example/hook')
})

test('R2 Given 合法非预设时长 When 查看并修改规则 Then 显示真实值且预设不重复', async () => {
  const f = fixture({ config: { minTurnDurationMs: 1500 } }); await f.ready(); f.tab('通知规则')
  const duration = f.control('最短执行时长')
  const options = nodes(duration).filter(n => n.type === 'option')
  assert.ok(options.some(n => String(n.props.value) === String(duration.props.value)), '合法当前值必须可显示')
  assert.match(text(options.find(n => Number(n.props.value) === 1500)), /1\.5 秒/)
  duration.props.onChange({ target: { value: '5000' } }); await flush()
  const changed = f.control('最短执行时长')
  assert.equal(changed.props.value, '5000')
  assert.equal(nodes(changed).filter(n => n.type === 'option' && Number(n.props.value) === 5000).length, 1)
})

test('F10 Given 当前浏览器偏好 When 切换前台无声系统通知 Then 本机保存且不写host', async () => {
  const f = fixture(); await f.ready()
  const before = f.requests.length
  const control = f.control('专注时保留无声系统通知')
  assert.ok(control, '提醒方式包含可操作的前台偏好')
  assert.equal(control.props.checked, false)
  control.props.onChange({ target: { checked: true } })
  assert.equal(f.control('专注时保留无声系统通知').props.checked, true)
  assert.equal(f.requests.length, before)
  assert.equal(f.values.get('turn-notify:foreground-system'), '1')
})

test('Given 通知权限例表 When 查看浏览器通知 Then 已授权无状态而非授权显示红字', async () => {
  for (const permission of ['granted', 'default', 'denied', 'unavailable']) {
    const f = fixture({ permission }); await f.ready()
    const alert = f.find(n => n.props.className === 'tn-field__alert')
    assert.equal(Boolean(alert), permission !== 'granted', permission)
    if (permission === 'unavailable') assert.match(text(alert), /不支持|不可用/)
  }
})
