// 模板结构化保存往返回归:顶层策略键 autoApprove 必须从宿主 JSON 读入编辑态,
// 再经 serializeModel 写回保存载荷;丢失会使同一模板从"主循环代审"静默退化为"人工审批"。
// 真实执行 client factory 与 TemplatesPage/TemplateCard/TemplateEditor,仅替换 React Hook
// 运行时、网络与定时器边界;断言落在保存请求的 json 字段,不触碰私有序列化函数。
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const source = readFileSync(new URL('../src/client.js', import.meta.url), 'utf8')

const flush = () => new Promise((resolve) => setImmediate(resolve))
const flattenText = (node) => {
  if (typeof node === 'string') return node
  if (node == null || typeof node !== 'object') return ''
  if (Array.isArray(node)) return node.map(flattenText).join('')
  return flattenText(node.children ?? node.props?.children)
}

function walk(node, visit, seen = new Set()) {
  if (!node || typeof node !== 'object' || seen.has(node)) return
  seen.add(node)
  if (Array.isArray(node)) {
    node.forEach((item) => walk(item, visit, seen))
    return
  }
  visit(node)
  for (const child of [node.children, node.props?.children]) {
    if (Array.isArray(child)) child.forEach((item) => walk(item, visit, seen))
    else walk(child, visit, seen)
  }
}

const findByType = (tree, name) => {
  let found
  walk(tree, (node) => { if (!found && node.type?.name === name) found = node })
  return found
}
const findButton = (tree, label) => {
  let found
  walk(tree, (node) => {
    if (!found && node.type === 'button' && flattenText(node.children ?? node.props?.children).trim() === label) found = node
  })
  return found
}

function fixture() {
  let current, factory
  const mounted = [], requests = []
  const depsEqual = (a, b) => a && b && a.length === b.length && a.every((value, index) => Object.is(value, b[index]))
  const hooks = {
    createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
    memo: (fn) => fn,
    Fragment: 'fragment',
    useState(seed) {
      const owner = current, index = owner.cursor++
      if (!(index in owner.states)) owner.states[index] = typeof seed === 'function' ? seed() : seed
      return [owner.states[index], (value) => {
        if (!owner.alive) return
        owner.states[index] = typeof value === 'function' ? value(owner.states[index]) : value
        owner.dirty = true
      }]
    },
    useRef(seed) { const index = current.cursor++; return current.refs[index] ??= { current: seed } },
    useMemo(fn, deps) {
      const index = current.cursor++, old = current.memos[index]
      if (!old || !depsEqual(old.deps, deps)) current.memos[index] = { value: fn(), deps }
      return current.memos[index].value
    },
    useCallback(fn, deps) { return hooks.useMemo(() => fn, deps) },
    useEffect(fn, deps) {
      const owner = current, index = owner.cursor++, old = owner.effects[index]
      if (!old || !depsEqual(old.deps, deps)) owner.pending.push(() => {
        old?.cleanup?.()
        owner.effects[index] = { deps, cleanup: fn() }
      })
    },
  }
  hooks.useLayoutEffect = hooks.useEffect

  const window = {
    __ModuleLoader__: { load: (entry) => { factory = entry.factory } },
    __navicIcons: { register() {} },
    addEventListener() {}, removeEventListener() {},
  }
  const fetch = async (url, options = {}) => {
    const body = options.body ? JSON.parse(options.body) : null
    requests.push({ url, method: options.method ?? 'GET', body })
    const data = url.endsWith('/templates')
      ? { templates: [ENTRY] }
      : url.endsWith('/released')
        ? { ids: [] }
        : { ok: true }
    return { ok: true, status: 200, json: async () => data }
  }
  const timers = new Map()
  let timerId = 0
  const schedule = (fn, ms) => { const id = ++timerId; timers.set(id, { fn, ms }); return id }
  const clear = (id) => { timers.delete(id) }
  const interval = (fn, ms) => { const id = ++timerId; timers.set(id, { fn, ms }); return id }
  new Function('window', 'fetch', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', source)(
    window, fetch, schedule, clear, interval, clear,
  )

  const tools = {
    setupCommonTools: () => ({ subscribe: () => () => {} }),
  }
  const mod = factory((name) => name === 'react' ? hooks : name === '@mzzsfy/dsh-common-tools/client' ? tools : {})
  const slots = new Map()
  mod.apply({
    fiber: { entry: { options: { name: '@mzzsfy/dsh-rs-workflow' } } },
    effect: (fn) => fn(),
    slots: {
      inject: (_name, fn) => fn(),
      register: (entry, component) => { slots.set(entry.name, component); return () => {} },
    },
  })

  const render = (owner) => {
    current = owner
    owner.cursor = 0
    owner.dirty = false
    owner.tree = owner.component(owner.props)
    current = null
    owner.pending.splice(0).forEach((fn) => fn())
  }
  const mount = (component, props = {}) => {
    const owner = {
      component, props, states: [], refs: [], memos: [], effects: [], pending: [],
      cursor: 0, alive: true, dirty: true,
    }
    mounted.push(owner)
    render(owner)
    return owner
  }
  const settle = async () => {
    for (let index = 0; index < 16; index += 1) {
      await flush()
      mounted.filter((owner) => owner.alive && owner.dirty).forEach(render)
    }
  }
  return { requests, slots, mount, settle }
}

// 宿主模板 JSON:顶层 autoApprove=true,一个合法 ai 步骤
const ENTRY = {
  id: 'demo',
  label: '演示模板',
  description: '',
  enabled: true,
  builtin: false,
  json: JSON.stringify({
    id: 'demo',
    label: '演示模板',
    autoApprove: true,
    steps: [{
      id: 'draft',
      type: 'ai',
      prompt: '执行 {request}',
      outputs: { result: '结果' },
    }],
  }, null, 2),
}

test('Given 模板 JSON 含顶层 autoApprove When 结构化编辑后保存 Then 保存载荷仍带 autoApprove:true', async () => {
  // Given 设置页渲染出模板列表
  const f = fixture()
  const section = f.mount(f.slots.get('settings.section'))
  const appElement = findByType(section.tree, 'RswwApp')
  assert.ok(appElement, '未渲染 RswwApp')
  const app = f.mount(appElement.type, appElement.props)
  const pageElement = findByType(app.tree, 'TemplatesPage')
  assert.ok(pageElement, '未渲染 TemplatesPage')
  const page = f.mount(pageElement.type, pageElement.props)
  await f.settle()

  const cardElement = findByType(page.tree, 'TemplateCard')
  assert.ok(cardElement, '模板列表未渲染 TemplateCard')
  const card = f.mount(cardElement.type, cardElement.props)

  // When 点击「编辑」打开结构化编辑器
  const edit = findButton(card.tree, '编辑')
  assert.ok(edit, '未找到编辑按钮')
  edit.props.onClick()
  await f.settle()

  const editorElement = findByType(page.tree, 'TemplateEditor')
  assert.ok(editorElement, '未打开 TemplateEditor')
  const editor = f.mount(editorElement.type, editorElement.props)

  // When 点击「保存」(不做文本「应用」,走结构化序列化路径)
  const save = findButton(editor.tree, '保存')
  assert.ok(save, '未找到保存按钮')
  save.props.onClick()
  await f.settle()

  // Then 保存请求的 json 保留顶层 autoApprove:true
  const saveRequest = f.requests.find((item) => item.url.endsWith('/template-save'))
  assert.ok(saveRequest, '未发出 template-save 请求(结构校验可能未通过)')
  assert.ok(saveRequest.body && typeof saveRequest.body.json === 'string', '保存载荷缺少 json 字段')
  const saved = JSON.parse(saveRequest.body.json)
  assert.equal(saved.id, 'demo')
  assert.equal(saved.autoApprove, true, '结构化保存丢失顶层 autoApprove')
  assert.equal(saved.steps[0].id, 'draft')
})