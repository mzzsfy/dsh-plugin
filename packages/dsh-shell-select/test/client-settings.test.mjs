import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const source = readFileSync(new URL('../src/client.js', import.meta.url), 'utf8')
const section = () => ({
  default: 'git-bash', deny: ['^format\\s', ' foo ', ' ', 'echo\nsecret'], timeoutMs: 120000,
  shells: [
    { id: 'git-bash', kind: 'bash', path: '', args: ['-c', 'echo two words', '{command}', '', 'a"b', "a'b", 'C:\\path', 'line\nbreak', 'tab\tcr\r', "$'literal'", 'C:\\tail\\'], env: { NOTE: 'a=b c', MULTI: 'line1\nOTHER=two', PATH: 'C:\\temp\\file', LITERAL: '\\n', QUOTED: '"literal"', CR: 'first\rsecond', TRAIL: 'C:\\temp\\' }, login: true, distro: '' },
    { id: 'pwsh', kind: 'pwsh', path: '', args: [], env: {}, login: false, distro: '' },
  ],
  resolved: { default: 'git-bash', shells: [{ id: 'git-bash', available: true, path: 'C:/Git/bash.exe' }, { id: 'pwsh', available: true }] },
})

async function page({ failLoad = false, failSave = false, failReadBack = false } = {}) {
  const state = [], effects = [], registrations = [], requests = []
  let cursor = 0, effectCursor = 0, loaded
  const React = {
    createElement: (type, props, ...children) => typeof type === 'function' ? type(props ?? {}) : { type, props: props ?? {}, children },
    useState(initial) {
      const at = cursor++
      if (!(at in state)) state[at] = typeof initial === 'function' ? initial() : initial
      return [state[at], (next) => { state[at] = typeof next === 'function' ? next(state[at]) : next }]
    },
    useEffect(fn, deps) {
      const at = effectCursor++
      const prior = effects[at]
      if (!prior || deps.some((value, index) => value !== prior.deps[index])) {
        prior?.cleanup?.()
        effects[at] = { fn, deps, pending: true }
      }
    },
  }
  const window = { __ModuleLoader__: { load: (value) => { loaded = value } } }
  const document = { documentElement: { lang: 'zh' }, createElement: () => ({ setAttribute() {}, remove() {} }), head: { appendChild() {} } }
  let current = section()
  const fetch = async (path, options = {}) => {
    requests.push({ path, ...options })
    if (path.endsWith('/probe')) return { ok: true, json: async () => ({ exists: true }) }
    if (path.endsWith('/detect')) return { ok: true, json: async () => ({ found: [{ path: 'C:/Git/bash.exe' }] }) }
    if (failReadBack && options.method !== 'POST' && requests.some((row) => row.method === 'POST')) return { ok: false, status: 503, json: async () => ({ error: '回读故障' }) }
    if (failLoad && options.method !== 'POST') return { ok: false, status: 503, json: async () => ({ error: '加载故障' }) }
    if (options.method === 'POST') {
      if (failSave) return { ok: false, status: 400, json: async () => ({ error: '写入故障' }) }
      current = { ...JSON.parse(options.body), resolved: current.resolved }
      return { ok: true, json: async () => ({ ok: true, resolved: current.resolved }) }
    }
    return { ok: true, json: async () => structuredClone(current) }
  }
  new Function('window', 'document', 'navigator', 'fetch', source)(window, document, {}, fetch)
  loaded.factory((name) => { if (name === 'react') return React; throw new Error(name) }).apply({
    effect: (fn) => fn(), slots: { inject: (_name, fn) => fn(), register: (meta, component) => { const entry = { meta, component }; registrations.push(entry); return () => registrations.splice(registrations.indexOf(entry), 1) } },
  })
  const view = registrations.find(({ meta }) => meta.name === 'settings.section' && meta.id === 'shell-select')
  assert.ok(view, '设置导航缺少 shell-select 页面')
  assert.equal(view.meta.label, 'Shell 管理')
  const render = () => { cursor = 0; effectCursor = 0; return view.component() }
  const flush = async () => {
    for (const effect of effects) if (effect.pending) { effect.pending = false; effect.cleanup = effect.fn() }
    await new Promise(setImmediate)
  }
  const initial = render()
  await flush()
  const nodes = (tree) => {
    const found = []
    const walk = (node) => { if (Array.isArray(node)) return node.forEach(walk); if (!node || typeof node !== 'object') return; found.push(node); node.children?.forEach(walk) }
    walk(tree)
    return found
  }
  const button = (tree, label) => nodes(tree).find((node) => node.type === 'button' && node.children.includes(label))
  const field = (tree, label) => nodes(tree).find((node) => node.props['aria-label'] === label)
  const dirty = () => {
    const input = field(render(), '客户端 1 id')
    input.props.onChange({ target: { value: input.props.value } })
  }
  return { initial, render, flush, nodes, button, field, dirty, requests, restoreLoad: () => { failLoad = false } }
}

// Given 插件启用；When 打开设置；Then 页面注册并加载当前配置而非出厂值。
test('设置入口:注册 Shell 管理并展示当前客户端、默认值与加载状态', async () => {
  const p = await page()
  assert.match(JSON.stringify(p.initial), /加载中/)
  const tree = p.render()
  assert.equal(p.field(tree, '客户端 1 默认').props.checked, true)
  assert.equal(p.field(tree, '客户端 1 默认').props.type, 'radio')
  assert.equal(p.field(tree, '客户端 1 id').props.value, 'git-bash')
  assert.equal(p.button(tree, '保存').props.disabled, true)
  assert.equal(p.field(tree, '客户端 1 参数').type, 'input')
  assert.match(p.field(tree, '客户端 1 环境').props.value, /^NOTE=a=b c\nMULTI=/)
  assert.equal(p.field(tree, '黑名单第 2 条').props.value, ' foo ')
  assert.equal(p.field(tree, '默认客户端'), undefined)
  p.field(tree, '客户端 2 默认').props.onChange()
  assert.equal(p.field(p.render(), '客户端 2 默认').props.checked, true)
  assert.equal(p.button(p.render(), '保存').props.disabled, false)
})

// Given 已有含空格参数和环境值；When 保存；Then 完整保留客户端字段、deny 与顶层配置。
test('保存:参数、环境、黑名单及预算字段无损往返', async () => {
  const p = await page()
  p.dirty()
  await p.button(p.render(), '保存').props.onClick()
  assert.equal(p.button(p.render(), '保存').props.disabled, true)
  const written = JSON.parse(p.requests.find((row) => row.method === 'POST').body)
  assert.deepEqual(written.shells, section().shells)
  assert.deepEqual(written.deny, section().deny)
  assert.equal(written.timeoutMs, 120000)
  assert.equal(written.default, 'git-bash')
  assert.ok(!('resolved' in written))
  assert.match(JSON.stringify(p.render()), /已保存/)
})

// Given 多个客户端；When 改默认 id 或删除默认项；Then 默认值始终指向现有客户端。
test('编辑:重命名及删除默认客户端同步更新默认值', async () => {
  const p = await page()
  p.field(p.render(), '客户端 1 id').props.onChange({ target: { value: 'bash-local' } })
  assert.equal(p.field(p.render(), '客户端 1 默认').props.checked, true)
  p.nodes(p.render()).find((node) => node.props['aria-label'] === '移除客户端 1').props.onClick()
  assert.equal(p.field(p.render(), '客户端 1 默认').props.checked, true)
})

test('编辑:多个同类客户端可新增并保存独立 id', async () => {
  const p = await page()
  p.button(p.render(), '添加客户端').props.onClick()
  p.field(p.render(), '客户端 3 id').props.onChange({ target: { value: 'bash-extra' } })
  await p.button(p.render(), '保存').props.onClick()
  const payload = JSON.parse(p.requests.find((row) => row.method === 'POST').body)
  assert.deepEqual(payload.shells.map((entry) => entry.id), ['git-bash', 'pwsh', 'bash-extra'])
})

// Given 非法配置；When 保存；Then 错误可见且不发写请求。
for (const [label, value, error] of [
  ['客户端 2 id', 'git-bash', '重复'],
  ['客户端 1 参数', '"unterminated', '引号'],
  ['客户端 1 环境', 'invalid', '环境'],
  ['黑名单第 1 条', '[', '正则'],
]) test('非法输入阻止保存: ' + label, async () => {
  const p = await page()
  p.field(p.render(), label).props.onChange({ target: { value } })
  await p.button(p.render(), '保存').props.onClick()
  assert.equal(p.requests.filter((row) => row.method === 'POST').length, 0)
  assert.match(JSON.stringify(p.render()), new RegExp(error))
})

test('加载失败:显示错误及重新加载操作', async () => {
  const p = await page({ failLoad: true })
  assert.match(JSON.stringify(p.render()), /加载故障/)
  assert.ok(p.button(p.render(), '重新加载'))
  p.restoreLoad()
  p.button(p.render(), '重新加载').props.onClick()
  p.render()
  await p.flush()
  assert.equal(p.field(p.render(), '客户端 1 默认').props.checked, true)
})

test('原规则交互:添加空行不生成空正则,逐行删除与编辑可保存', async () => {
  const p = await page()
  p.button(p.render(), '添加规则').props.onClick()
  assert.equal(p.field(p.render(), '黑名单第 5 条').props.value, '')
  p.field(p.render(), '黑名单第 1 条').props.onChange({ target: { value: '^danger' } })
  p.field(p.render(), '删除规则 2').props.onClick()
  await p.button(p.render(), '保存').props.onClick()
  const payload = JSON.parse(p.requests.find((row) => row.method === 'POST').body)
  assert.deepEqual(payload.deny, ['^danger', ' ', 'echo\nsecret'])
})

test('原参数环境文本:引号内空格与 K=V 值可编辑,不暴露 JSON', async () => {
  const p = await page()
  p.field(p.render(), '客户端 1 参数').props.onChange({ target: { value: '-c "echo new words" {command}' } })
  p.field(p.render(), '客户端 1 环境').props.onChange({ target: { value: 'NOTE=a=b c\nOTHER= two words ' } })
  await p.button(p.render(), '保存').props.onClick()
  const shell = JSON.parse(p.requests.find((row) => row.method === 'POST').body).shells[0]
  assert.deepEqual(shell.args, ['-c', 'echo new words', '{command}'])
  assert.deepEqual(shell.env, { NOTE: 'a=b c', OTHER: ' two words ' })
})

test('编辑再还原:参数与环境原始数组和换行值仍无损', async () => {
  const p = await page()
  for (const label of ['客户端 1 参数', '客户端 1 环境']) {
    const original = p.field(p.render(), label).props.value
    p.field(p.render(), label).props.onChange({ target: { value: 'temporary' } })
    p.field(p.render(), label).props.onChange({ target: { value: original } })
  }
  await p.button(p.render(), '保存').props.onClick()
  const shell = JSON.parse(p.requests.find((row) => row.method === 'POST').body).shells[0]
  assert.deepEqual(shell.args, section().shells[0].args)
  assert.deepEqual(shell.env, section().shells[0].env)
})

test('修改单个环境变量:其他含换行与反斜线的值保持不变', async () => {
  const p = await page()
  const original = p.field(p.render(), '客户端 1 环境').props.value
  p.field(p.render(), '客户端 1 环境').props.onChange({ target: { value: original.replace('NOTE=a=b c', 'NOTE=changed value') } })
  await p.button(p.render(), '保存').props.onClick()
  const posted = p.requests.find((row) => row.method === 'POST')
  assert.ok(posted, '编辑普通变量不应使已有多行值阻止保存')
  assert.deepEqual(JSON.parse(posted.body).shells[0].env, { ...section().shells[0].env, NOTE: 'changed value' })
})

test('双引号 Windows 参数:路径反斜线不能被当成 JSON 控制字符', async () => {
  const p = await page()
  const path = 'C:\\Program Files\\Git\\bin\\bash.exe'
  p.field(p.render(), '客户端 1 参数').props.onChange({ target: { value: '-c "' + path + '" {command}' } })
  await p.button(p.render(), '保存').props.onClick()
  const posted = p.requests.find((row) => row.method === 'POST')
  assert.ok(posted)
  assert.deepEqual(JSON.parse(posted.body).shells[0].args, ['-c', path, '{command}'])
})

test('参数修改保真:只追加参数仍保留原有空项、引号、反斜线与控制字符', async () => {
  const p = await page()
  const original = p.field(p.render(), '客户端 1 参数').props.value
  p.field(p.render(), '客户端 1 参数').props.onChange({ target: { value: original + ' extra' } })
  await p.button(p.render(), '保存').props.onClick()
  const posted = p.requests.find((row) => row.method === 'POST')
  assert.ok(posted)
  assert.deepEqual(JSON.parse(posted.body).shells[0].args, [...section().shells[0].args, 'extra'])
})

test('扫描不产生未保存改动:保存仍禁用', async () => {
  const p = await page()
  await p.button(p.render(), '扫描本机').props.onClick()
  assert.equal(p.button(p.render(), '保存').props.disabled, true)
})

test('探测:独立调用路径与扫描接口,不提交配置', async () => {
  const p = await page()
  p.field(p.render(), '客户端 1 路径').props.onChange({ target: { value: 'C:/Git/bash.exe' } })
  await p.button(p.render(), '探测路径').props.onClick()
  assert.match(JSON.stringify(p.render()), /路径存在/)
  await p.button(p.render(), '扫描本机').props.onClick()
  assert.match(JSON.stringify(p.render()), /C:\/Git\/bash.exe/)
  assert.equal(p.requests.filter((row) => row.path.endsWith('/config') && row.method === 'POST').length, 0)
})

test('提交成功但回读失败:明确已保存,不误报提交失败', async () => {
  const p = await page({ failReadBack: true })
  p.dirty()
  await p.button(p.render(), '保存').props.onClick()
  assert.equal(p.requests.filter((row) => row.method === 'POST').length, 1)
  const text = JSON.stringify(p.render())
  assert.match(text, /已保存.*刷新失败.*回读故障/)
  assert.doesNotMatch(text, /保存失败/)
})

test('保存失败:保留输入并显示服务端错误', async () => {
  const p = await page({ failSave: true })
  p.field(p.render(), '客户端 1 id').props.onChange({ target: { value: 'edited' } })
  await p.button(p.render(), '保存').props.onClick()
  assert.equal(p.field(p.render(), '客户端 1 id').props.value, 'edited')
  assert.match(JSON.stringify(p.render()), /写入故障/)
})
