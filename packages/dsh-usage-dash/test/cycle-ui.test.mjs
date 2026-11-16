// 计费周期配置行:三种口径的字段可见性与窗口回显。整源求值取 CycleConfig,
// useState 桩按声明顺序注入配置、窗口与错误,免去真实请求。
import test from 'node:test'
import assert from 'node:assert/strict'

import { CLIENT_SOURCE, CLIENT_BODY, DECLARATION_NAMES } from './client-eval.mjs'

const core = new Function(`${CLIENT_BODY}\nreturn { ${DECLARATION_NAMES.join(', ')} }`)()
const t = core.createTranslator(core.MESSAGES_ZH)
const INJECT_HOOK = "      inject: ['slots', 'locale', 'configForms'],"
const textOf = (node) => (typeof node === 'string' ? node : (node?.children ?? []).map(textOf).join(''))

function renderCycle({ config, range = null, failure = '' }) {
  let factory
  const queue = [[config, () => {}], [range, () => {}], [failure, () => {}], ['', () => {}], [{}, () => {}]]
  let call = 0
  const React = {
    createElement: (type, props, ...children) => ({
      type, props: props ?? {}, children: children.flat(Infinity).filter((x) => x != null && x !== false),
    }),
    memo: (fn) => fn,
    useState: () => (call < queue.length ? queue[call++] : [null, () => {}]),
    useRef: (initial) => ({ current: initial }),
    useEffect() {},
    useMemo: (fn) => fn(),
    useCallback: (fn) => fn(),
  }
  const window = { __ModuleLoader__: { load: (entry) => { factory = entry.factory } } }
  const source = CLIENT_SOURCE.replace(INJECT_HOOK, `      __test: { CycleConfig },\n${INJECT_HOOK}`)
  new Function('window', 'localStorage', source)(window, { getItem: () => null, setItem() {} })
  const { CycleConfig } = factory((name) => (name === 'react' ? React : {})).__test
  return CycleConfig({ t })
}

const inputsOf = (node, found = []) => {
  if (node === null || node === undefined) return found
  if (node.type === 'input' || node.type === 'select') found.push(node)
  for (const child of node.children ?? []) inputsOf(child, found)
  return found
}

test('Given 配置未加载 When 渲染 When Then 整行不出现', () => {
  assert.equal(renderCycle({ config: null }), null)
})

test('Given 自然月 When 渲染 Then 只有模式下拉,没有账单日与天数输入', () => {
  const node = renderCycle({ config: { kind: 'calendar', startDay: 1, days: 30 } })
  const inputs = inputsOf(node)
  assert.equal(inputs.length, 1, '自然月不该露出账单日或天数输入')
  assert.equal(inputs[0].type, 'select')
  assert.equal(inputs[0].props.value, 'calendar')
})

test('Given 每月账单日 When 渲染 Then 出现账单日输入且回显当前值', () => {
  const node = renderCycle({ config: { kind: 'monthly', startDay: 15, days: 30 } })
  const inputs = inputsOf(node)
  const number = inputs.find((input) => input.props?.type === 'number')
  assert.ok(number, '缺账单日输入')
  assert.equal(number.props.value, '15')
  assert.equal(number.props.min, 1)
  assert.equal(number.props.max, 31)
})

test('Given 滚动天数 When 渲染 Then 出现天数输入且回显当前值', () => {
  const node = renderCycle({ config: { kind: 'rolling', startDay: 1, days: 45 } })
  const number = inputsOf(node).find((input) => input.props?.type === 'number')
  assert.ok(number, '缺天数输入')
  assert.equal(number.props.value, '45')
  assert.equal(number.props.max, 366)
})

test('Given 有窗口 When 渲染 Then 起止日期可读', () => {
  const node = renderCycle({
    config: { kind: 'monthly', startDay: 15, days: 30 },
    range: { from: '2026-10-15', to: '2026-11-16' },
  })
  assert.match(textOf(node), /2026-10-15 ~ 2026-11-16/)
})

test('Given 保存失败 When 渲染 Then 错误文案出现', () => {
  const node = renderCycle({ config: { kind: 'calendar', startDay: 1, days: 30 }, failure: '计费周期保存失败' })
  assert.match(textOf(node), /计费周期保存失败/)
})

// 交互:校验拦截非法输入、保存失败回滚、成功后强制刷摘要
function renderInteractive({ config, range = null, fail = false }) {
  let factory
  const posts = []
  const state = { config: { ...config }, range, failure: '', fieldError: '', draft: {} }
  const setters = []
  const React = {
    createElement: (type, props, ...children) => ({
      type, props: props ?? {}, children: children.flat(Infinity).filter((x) => x != null && x !== false),
    }),
    memo: (fn) => fn,
    useState: (initial) => {
      const index = setters.length
      setters.push((next) => {
        const value = typeof next === 'function' ? next(state[['config', 'range', 'failure', 'fieldError', 'draft'][index]]) : next
        if (index === 0) state.config = value
        if (index === 1) state.range = value
        if (index === 2) state.failure = value
        if (index === 3) state.fieldError = value
        if (index === 4) state.draft = value
      })
      const seeded = index === 0 ? state.config : index === 1 ? state.range : initial
      return [seeded, setters[index]]
    },
    useRef: (initial) => ({ current: initial }),
    useEffect() {},
    useMemo: (fn) => fn(),
    useCallback: (fn) => fn(),
  }
  const window = { __ModuleLoader__: { load: (entry) => { factory = entry.factory } } }
  const source = CLIENT_SOURCE.replace(INJECT_HOOK, `      __test: { CycleConfig },\n${INJECT_HOOK}`)
  globalThis.fetch = async (url, init) => {
    const body = init?.body ? JSON.parse(init.body) : null
    posts.push({ path: String(url), method: init?.method ?? 'GET', body })
    if (fail) return { json: async () => ({ ok: false, error: { code: 'unavailable', message: 'nope' } }) }
    return {
      json: async () => ({ ok: true, value: { config: body?.cycle ?? null, window: { from: '2026-10-15', to: '2026-11-16' } } }),
    }
  }
  new Function('window', 'localStorage', source)(window, { getItem: () => null, setItem() {} })
  const { CycleConfig } = factory((name) => (name === 'react' ? React : {})).__test
  // 初次渲染:注入已加载的配置
  state.config = { ...config }
  const node = CycleConfig({ t })
  return { node, posts, state }
}

test('Given 账单日输入为零 When 失焦 Then 不发请求且本地报错', () => {
  const { node, posts, state } = renderInteractive({ config: { kind: 'monthly', startDay: 15, days: 30 } })
  const input = inputsOf(node).find((item) => item.props?.type === 'number')
  input.props.onBlur({ target: { value: '0' } })
  assert.equal(posts.length, 0, '非法值不该发 POST')
  assert.match(state.fieldError, /\d+-\d+/)
})

test('Given 账单日输入为空 When 失焦 Then 不发请求', () => {
  const { node, posts } = renderInteractive({ config: { kind: 'monthly', startDay: 15, days: 30 } })
  const input = inputsOf(node).find((item) => item.props?.type === 'number')
  input.props.onBlur({ target: { value: '  ' } })
  assert.equal(posts.length, 0)
})

test('Given 合法账单日 When 失焦 Then 提交并带回调整后的窗口', async () => {
  const { node, posts, state } = renderInteractive({ config: { kind: 'monthly', startDay: 15, days: 30 } })
  const input = inputsOf(node).find((item) => item.props?.type === 'number')
  input.props.onBlur({ target: { value: '20' } })
  await new Promise((resolve) => setTimeout(resolve, 0))
  const writes = posts.filter((item) => item.method === 'POST' && item.path.endsWith('/cycle'))
  assert.equal(writes.length, 1)
  assert.deepEqual(writes[0].body.cycle, { kind: 'monthly', startDay: 20, days: 30 })
  assert.equal(state.range.from, '2026-10-15')
})

test('Given 输入值与已存一致 When 失焦 Then 不发请求', () => {
  const { node, posts, state } = renderInteractive({ config: { kind: 'monthly', startDay: 15, days: 30 } })
  const input = inputsOf(node).find((item) => item.props?.type === 'number')
  input.props.onBlur({ target: { value: '15' } })
  assert.equal(posts.filter((item) => item.method === 'POST').length, 0, '未改动不该写配置')
  assert.equal(state.failure, '')
})

test('Given 保存失败 When 失焦提交 Then 回滚到已存值并提示', async () => {
  const { node, state } = renderInteractive({ config: { kind: 'monthly', startDay: 15, days: 30 }, fail: true })
  const input = inputsOf(node).find((item) => item.props?.type === 'number')
  input.props.onBlur({ target: { value: '20' } })
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.equal(state.config.startDay, 15, '失败后不能停在未落盘的 20')
  assert.notEqual(state.failure, '')
})

test('Given 非法值 When 失焦 Then 草稿保留用户输入而不是跳回旧值', () => {
  const { node, state } = renderInteractive({ config: { kind: 'monthly', startDay: 15, days: 30 } })
  const input = inputsOf(node).find((item) => item.props?.type === 'number')
  input.props.onBlur({ target: { value: '0' } })
  assert.equal(state.draft.startDay, '0')
  assert.match(state.fieldError, /\d+-\d+/)
})
