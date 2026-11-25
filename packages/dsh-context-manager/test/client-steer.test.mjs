// 插话撤回(steer recall)接线与纯函数测试:加载真实 src/client.js,
// 捕获 slots.register 断言 dock 条目结构,切片实例化纯函数锁定撤回动作与失败文案。
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const PKG_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const CLIENT_SRC = readFileSync(join(PKG_ROOT, 'src', 'client.js'), 'utf8')

// 加载 client.js 并执行 apply(mock 最小服务面),返回插槽注册捕获。
// slots.inject 收到注册回调即同步执行;binding 桩仅对会话 s1 生效
function loadClient({ binding, remoteSession, conversation, fetchImpl } = {}) {
  const modules = []
  const registered = []
  const injectedNames = []
  const windowStub = { __ModuleLoader__: { load: (module) => modules.push(module) }, addEventListener: () => {} }
  const reactStub = {
    useState: (value) => [value, () => {}],
    useEffect: () => {},
    useRef: (value) => ({ current: value }),
    createElement: () => null,
  }
  const requireStub = (name) => {
    if (name === '@mzzsfy/dsh-common-tools/client') return { toast: { show: () => 0 } }
    return reactStub
  }
  const factory = new Function('window', 'require', 'document', 'fetch', CLIENT_SRC + '\n;return null')
  factory(
    windowStub,
    requireStub,
    { createElement: () => ({ style: {}, remove() {} }), head: { appendChild: () => {} }, body: { appendChild: () => {} } },
    fetchImpl || globalThis.fetch,
  )
  assert.equal(modules.length, 1, 'client.js 模块未被捕获')
  const mod = modules[0].factory(requireStub)

  const sessions = {
    binding: (sessionId) => (sessionId === 's1' ? binding : undefined),
    scope: (sessionId) => (conversation && sessionId === 's1'
      ? { get: (name) => (name === 'conversation' ? conversation : undefined) }
      : undefined),
    fork: () => Promise.resolve('child-1'),
    open: () => {},
  }
  const remote = { session: remoteSession }
  const ctx = {
    get: (name) => (name === 'sessions' ? sessions : {}),
    effect: () => {},
    slots: {
      inject: (name, register) => { injectedNames.push(name); register() },
      register: (options, component) => registered.push({ options, component }),
    },
    get remote() { return remote },
    inject: (deps, register) => { if (deps.includes('remote.session') && remote.session) register(ctx) },
  }
  mod.apply(ctx)
  return { registered, injectedNames }
}

// 插话撤回 dock 条目捕获:与官方 queue dock(order 20)、goal dock(order 10)同槽位
function findSteerEntry(options) {
  const { registered, injectedNames } = loadClient(options)
  assert.ok(injectedNames.includes('conversation.input.dock'), 'apply 未注入 conversation.input.dock 插槽')
  const entries = registered.filter((item) => item.options.name === 'conversation.input.dock')
  const entry = entries.find((item) => item.options.id === 'context-manager-steer')
  assert.ok(entry, '未注册 id=context-manager-steer 的插话撤回 dock 条目')
  return { entry, entries }
}

test('Given client.js 装载, When apply, Then 注册插话撤回与历史浮层 dock 条目', () => {
  const { entry, entries } = findSteerEntry()
  assert.equal(typeof entry.component, 'function', 'dock 条目缺组件')
  assert.equal(entry.options.order, 25, '插话撤回条目 order 应紧邻官方队列面板(20)之后')
  assert.ok(entries.some((item) => item.options.id === 'context-manager-history'), '历史浮层条目被挤掉')
})

test('Given 会话绑定存在, When dock inject, Then updateQueue 路由到 binding.session.updateQueue', async () => {
  const calls = []
  const binding = {
    session: {
      updateQueue: async (itemId, action) => {
        calls.push({ itemId, action })
        return { ok: true }
      },
      projections: { faceOf: () => ({ getSnapshot: () => ({}) }) },
    },
  }
  const { entry } = findSteerEntry({ binding })
  const props = entry.options.inject('s1')
  assert.equal(typeof props.updateQueue, 'function', 'inject 未返回 updateQueue')
  const result = await props.updateQueue('m1', { kind: 'remove' })
  assert.deepEqual(calls, [{ itemId: 'm1', action: { kind: 'remove' } }], 'updateQueue 未按 remove 动作透传')
  assert.deepEqual(result, { ok: true })
})

test('Given 会话绑定存在, When dock inject, Then 返回 inbox 投影 face 供组件订阅', () => {
  const face = { getSnapshot: () => ({ 'next-step': [INBOX_MESSAGE] }) }
  const binding = {
    session: {
      updateQueue: async () => ({ ok: true }),
      projections: { faceOf: (name) => name === 'inbox' ? face : null },
    },
  }
  const { entry } = findSteerEntry({ binding })
  const props = entry.options.inject('s1')
  assert.equal(props.inboxFace, face, 'inject 未返回 inbox 投影 face')
})

test('Given conversation 与附件读取面齐备, When dock inject, Then 返回附件恢复通道', async () => {
  const draftCalls = []
  const conversation = {
    createDrafts: (...args) => {
      draftCalls.push(args)
      return [{ id: 'd1' }]
    },
    releaseDraftAttachments: () => {},
  }
  const binding = {
    session: {
      updateQueue: async () => ({ ok: true }),
      readAttachment: async () => ({ ok: true, value: { data: new Uint8Array([1, 2]) } }),
      getSnapshot: () => ({ subagent: null }),
      projections: { faceOf: () => ({ getSnapshot: () => ({}) }) },
    },
  }
  const { entry } = findSteerEntry({ binding, conversation })
  const props = entry.options.inject('s1')
  assert.equal(typeof props.createDrafts, 'function', 'inject 未返回 createDrafts 通道')
  assert.equal(typeof props.releaseDrafts, 'function', 'inject 未返回 releaseDrafts 通道')
  assert.equal(typeof props.readAttachmentFile, 'function', 'inject 未返回附件读取通道')
  const image = { attachmentId: 'a1', mediaType: 'image/png', name: 'shot.png', bytes: 2, width: 1, height: 1 }
  const file = await props.readAttachmentFile({ kind: 'image', attachment: image })
  assert.equal(file.name, 'shot.png')
  assert.equal(file.type, 'image/png')
  assert.deepEqual(Array.from(new Uint8Array(await file.arrayBuffer())), [1, 2])
  assert.deepEqual(props.createDrafts([file]), [{ id: 'd1' }])
  assert.equal(draftCalls[0][0], 's1', 'createDrafts 应按当前会话上传')
  assert.equal(draftCalls[0][2], true, '普通会话应上传图片(子 agent continuation 才内联)')
})

test('Given 文件附件引用, When dock inject 的 readAttachmentFile 读取, Then 二进制响应还原为 File', async () => {
  const fetched = []
  const fetchImpl = async (url, options) => {
    fetched.push({ url, options })
    return {
      ok: true,
      arrayBuffer: async () => new Uint8Array([7, 8, 9]).buffer,
    }
  }
  const binding = {
    session: {
      updateQueue: async () => ({ ok: true }),
      getSnapshot: () => ({ subagent: null }),
      projections: { faceOf: () => ({ getSnapshot: () => ({}) }) },
    },
  }
  const { entry } = findSteerEntry({ binding, fetchImpl })
  const props = entry.options.inject('s1')
  const attachment = { attachmentId: 'f1', name: 'a.bin', bytes: 3 }
  const file = await props.readAttachmentFile({ kind: 'file', attachment })
  assert.equal(file.name, 'a.bin')
  assert.deepEqual(Array.from(new Uint8Array(await file.arrayBuffer())), [7, 8, 9])
  assert.equal(fetched.length, 1)
  assert.equal(fetched[0].url, '/api/context/read-attachment')
  assert.deepEqual(JSON.parse(fetched[0].options.body), { kind: 'file', attachment })
})

test('Given 文件读取响应字节数与引用不一致, When 读取, Then 抛错而不是造出损坏 File', async () => {
  const binding = {
    session: {
      updateQueue: async () => ({ ok: true }),
      getSnapshot: () => ({ subagent: null }),
      projections: { faceOf: () => ({ getSnapshot: () => ({}) }) },
    },
  }
  const fetchImpl = async () => ({ ok: true, arrayBuffer: async () => new Uint8Array([1]).buffer })
  const { entry } = findSteerEntry({ binding, fetchImpl })
  const props = entry.options.inject('s1')
  await assert.rejects(
    () => props.readAttachmentFile({ kind: 'file', attachment: { attachmentId: 'f1', name: 'a.bin', bytes: 2 } }),
    /附件字节数不一致/,
  )
})

test('Given 文件读取路由非 2xx, When 读取, Then 透传路由错误文案', async () => {
  const binding = {
    session: {
      updateQueue: async () => ({ ok: true }),
      getSnapshot: () => ({ subagent: null }),
      projections: { faceOf: () => ({ getSnapshot: () => ({}) }) },
    },
  }
  const fetchImpl = async () => ({
    ok: false,
    status: 400,
    json: async () => ({ error: '附件过大,无法恢复' }),
  })
  const { entry } = findSteerEntry({ binding, fetchImpl })
  const props = entry.options.inject('s1')
  await assert.rejects(
    () => props.readAttachmentFile({ kind: 'file', attachment: { attachmentId: 'f1', name: 'a.bin', bytes: 2 } }),
    /附件过大,无法恢复/,
  )
})

test('Given conversation 服务缺失或旧会话面, When dock inject, Then 仅文本回填且附件读取按失败降级', async () => {
  const binding = {
    session: {
      updateQueue: async () => ({ ok: true }),
      projections: { faceOf: () => ({ getSnapshot: () => ({}) }) },
    },
  }
  const props = findSteerEntry({ binding }).entry.options.inject('s1')
  assert.equal(props.createDrafts, null, '无 conversation.createDrafts 应返回 null')
  assert.equal(typeof props.readAttachmentFile, 'function', '文件读取通道不应因旧会话面缺失')
  await assert.rejects(
    () => props.readAttachmentFile({ kind: 'image', attachment: { attachmentId: 'a1', mediaType: 'image/png' } }),
    /图片附件读取通道不可用/,
  )
})

test('Given 会话面无投影(旧宿主), When dock inject, Then inboxFace 为 undefined(组件不渲染)', () => {
  const binding = { session: { updateQueue: async () => ({ ok: true }) } }
  const { entry } = findSteerEntry({ binding })
  const props = entry.options.inject('s1')
  assert.equal(props.inboxFace, undefined, '无投影时应返回 undefined 触发组件干净缺席')
})

test('Given 会话绑定缺失, When dock inject, Then 返回空 props(干净禁用)', () => {
  const { entry } = findSteerEntry()
  assert.deepEqual(entry.options.inject('s1'), {}, '绑定缺失应返回空 props')
  assert.deepEqual(entry.options.inject('missing'), {}, '未知会话应返回空 props')
})

test('Given 会话面无 updateQueue(旧宿主), When dock inject, Then 返回空 props(干净禁用)', () => {
  const { entry } = findSteerEntry({ binding: { session: {} } })
  assert.deepEqual(entry.options.inject('s1'), {}, '会话面无 updateQueue 应返回空 props')
})

// 纯函数切片:steerRowsOfInbox / withdrawFailureText / withdrawSteer(无外部依赖,动作经注入)
const PURE_START = CLIENT_SRC.indexOf('function steerRowsOfInbox(')
const PURE_END = CLIENT_SRC.indexOf('function SteerRecallDock(')
assert.ok(PURE_START >= 0 && PURE_END > PURE_START, 'client.js 插话撤回纯函数切片定位失败')
const pure = new Function(
  CLIENT_SRC.slice(PURE_START, PURE_END)
  + '; return { steerRowsOfInbox: steerRowsOfInbox, withdrawFailureText: withdrawFailureText, restoreSteerAttachments: restoreSteerAttachments, withdrawSteer: withdrawSteer }',
)()

const INBOX_MESSAGE = {
  id: 'm1',
  source: { kind: 'user' },
  content: [{ type: 'text', text: '帮我看下' }],
}
const STEERING_ROW = { id: 'm1', source: { kind: 'user' }, preview: '帮我看下', text: '帮我看下' }

test('steerRowsOfInbox:仅保留 user 来源的 next-step 行,映射为撤回行', () => {
  const messages = [
    { id: 'x1', source: { kind: 'system' }, content: [{ type: 'text', text: '注入' }] },
    INBOX_MESSAGE,
    null,
    { id: 'x2', source: { kind: 'user' }, content: [{ type: 'text', text: '第二条' }] },
  ]
  const rows = pure.steerRowsOfInbox(messages)
  assert.deepEqual(rows.map((row) => row.id), ['m1', 'x2'])
  assert.equal(rows[0].text, '帮我看下')
  assert.ok(rows[0].preview.includes('帮我看下'))
  assert.deepEqual(pure.steerRowsOfInbox([]), [])
  assert.deepEqual(pure.steerRowsOfInbox(undefined), [])
})

test('steerRowsOfInbox:含图片/文件块的插话可撤回,文本与附件分别投影', () => {
  const image = { attachmentId: 'a1', mediaType: 'image/png', bytes: 3, width: 1, height: 1 }
  const file = { attachmentId: 'f1', name: 'a.txt', bytes: 1 }
  const rows = pure.steerRowsOfInbox([
    { id: 'm2', source: { kind: 'user' }, content: [{ type: 'text', text: '看图' }, { type: 'image', attachment: image }] },
    { id: 'm3', source: { kind: 'user' }, content: [] },
    { id: 'm4', source: { kind: 'user' } },
    { id: 'm5' },
    { id: 'm6', source: { kind: 'user' }, content: [{ type: 'file', attachment: file }, { type: 'reasoning', text: '内部推理' }] },
  ])
  assert.equal(rows[0].text, '看图')
  assert.deepEqual(rows[0].attachments, [{ kind: 'image', attachment: image }])
  assert.equal(rows[1].text, '')
  assert.deepEqual(rows[1].attachments, [])
  assert.equal(rows[2].text, '')
  assert.deepEqual(rows[3].attachments, [{ kind: 'file', attachment: file }])
  assert.deepEqual(rows.map((row) => row.id), ['m2', 'm3', 'm4', 'm6'])
})

test('restoreSteerAttachments:逐个读取字节,createDrafts 注册后 addAttachments 挂到输入框', async () => {
  const calls = []
  const image = { kind: 'image', attachment: { attachmentId: 'a1' } }
  const file = { kind: 'file', attachment: { attachmentId: 'f1' } }
  const result = await pure.restoreSteerAttachments([image, file], {
    readAttachmentFile: async (item) => ({ source: item.kind }),
    createDrafts: (files) => {
      calls.push({ createDrafts: files.map((item) => item.source) })
      return files.map((item, index) => ({ id: 'd' + index }))
    },
    addAttachments: (ids) => calls.push({ addAttachments: ids }),
  })
  assert.deepEqual(result, { failed: [] })
  assert.deepEqual(calls, [
    { createDrafts: ['image', 'file'] },
    { addAttachments: ['d0', 'd1'] },
  ])
})

test('restoreSteerAttachments:单个附件读取失败隔离,其余照常恢复', async () => {
  const image = { kind: 'image', attachment: { attachmentId: 'a1' } }
  const file = { kind: 'file', attachment: { attachmentId: 'f1' } }
  const result = await pure.restoreSteerAttachments([image, file], {
    readAttachmentFile: async (item) => {
      if (item.kind === 'file') throw new Error('读取失败')
      return { source: item.kind }
    },
    createDrafts: (files) => files.map((item, index) => ({ id: 'd' + index })),
    addAttachments: () => {},
  })
  assert.deepEqual(result, { failed: [file] })
})

test('restoreSteerAttachments:createDrafts 缺失或抛错时按全部失败返回', async () => {
  const attachments = [{ kind: 'file', attachment: { attachmentId: 'f1' } }]
  const readAttachmentFile = async () => ({ source: 'file' })
  const missing = await pure.restoreSteerAttachments(attachments, { readAttachmentFile })
  assert.deepEqual(missing, { failed: attachments })
  const broken = await pure.restoreSteerAttachments(attachments, {
    readAttachmentFile,
    createDrafts: () => { throw new Error('unsupported') },
    addAttachments: () => {},
  })
  assert.deepEqual(broken, { failed: attachments })
})

test('restoreSteerAttachments:addAttachments 返回 false 时释放已注册草稿', async () => {
  const attachments = [{ kind: 'file', attachment: { attachmentId: 'f1' } }]
  const released = []
  const result = await pure.restoreSteerAttachments(attachments, {
    readAttachmentFile: async () => ({ source: 'file' }),
    createDrafts: () => [{ id: 'd1' }, { id: 'd2' }],
    addAttachments: () => false,
    releaseDrafts: (drafts) => released.push(drafts.map((draft) => draft.id)),
  })
  assert.deepEqual(result, { failed: attachments })
  assert.deepEqual(released, [['d1', 'd2']], '挂载失败必须释放 createDrafts 注册的草稿与上传')
})

test('withdrawSteer 含附件:remove 成功后回填文本并恢复附件,提示成功', async () => {
  const calls = []
  const row = {
    id: 'm2',
    text: '看图',
    attachments: [{ kind: 'image', attachment: { attachmentId: 'a1' } }],
  }
  const done = await pure.withdrawSteer(row, {
    updateQueue: async (itemId, action) => { calls.push({ itemId, action }); return { ok: true } },
    setDraft: (text) => calls.push({ setDraft: text }),
    restoreAttachments: async (attachments) => { calls.push({ restore: attachments.length }); return { failed: [] } },
    notify: (text, opts) => calls.push({ notify: text, opts }),
  })
  assert.equal(done, true)
  assert.deepEqual(calls, [
    { itemId: 'm2', action: { kind: 'remove' } },
    { setDraft: '看图' },
    { restore: 1 },
    { notify: '已撤回到输入框', opts: undefined },
  ])
})

test('withdrawSteer 纯附件撤回:回填不传空文本(保留输入框现有草稿),附件失败仍提示', async () => {
  const calls = []
  const failed = { kind: 'file', attachment: { attachmentId: 'f1' } }
  const done = await pure.withdrawSteer({ id: 'm3', text: '', attachments: [failed] }, {
    updateQueue: async () => ({ ok: true }),
    setDraft: (text) => calls.push({ setDraft: text }),
    restoreAttachments: async () => ({ failed: [failed] }),
    notify: (text, opts) => calls.push({ notify: text, opts }),
  })
  assert.equal(done, true)
  assert.deepEqual(calls, [
    { notify: '已撤回;1 个附件恢复失败,请重新添加', opts: { kind: 'error' } },
  ])
})

test('withdrawSteer 纯附件成功:不回填空文本,保留输入框草稿并提示成功', async () => {
  const calls = []
  const attachment = { kind: 'image', attachment: { attachmentId: 'a1' } }
  const done = await pure.withdrawSteer({ id: 'm5', text: '', attachments: [attachment] }, {
    updateQueue: async () => ({ ok: true }),
    setDraft: (text) => calls.push({ setDraft: text }),
    restoreAttachments: async () => ({ failed: [] }),
    notify: (text, opts) => calls.push({ notify: text, opts }),
  })
  assert.equal(done, true)
  assert.deepEqual(calls, [{ notify: '已撤回到输入框', opts: undefined }])
})

test('withdrawSteer 附件恢复通道缺失(旧宿主):仍回填文本,提示附件需重新添加', async () => {
  const calls = []
  const failed = { kind: 'file', attachment: { attachmentId: 'f1' } }
  const done = await pure.withdrawSteer({ id: 'm4', text: '正文', attachments: [failed] }, {
    updateQueue: async () => ({ ok: true }),
    setDraft: (text) => calls.push({ setDraft: text }),
    notify: (text, opts) => calls.push({ notify: text, opts }),
  })
  assert.equal(done, true)
  assert.deepEqual(calls, [
    { setDraft: '正文' },
    { notify: '已撤回,文本已回填;1 个附件恢复失败,请重新添加', opts: { kind: 'error' } },
  ])
})

test('withdrawSteer 主路径:remove 成功后回填草稿并提示,返回 true', async () => {
  const calls = []
  const actions = {
    updateQueue: async (itemId, action) => { calls.push({ itemId, action }); return { ok: true } },
    setDraft: (text) => calls.push({ setDraft: text }),
    notify: (text, opts) => calls.push({ notify: text, opts }),
  }
  const done = await pure.withdrawSteer(STEERING_ROW, actions)
  assert.equal(done, true)
  assert.deepEqual(calls, [
    { itemId: 'm1', action: { kind: 'remove' } },
    { setDraft: '帮我看下' },
    { notify: '已撤回到输入框', opts: undefined },
  ])
})

test('withdrawSteer 已被应用:queue-item-not-found 不回填草稿,专用文案报错', async () => {
  const calls = []
  const actions = {
    updateQueue: async () => ({ ok: false, error: { code: 'session/queue-item-not-found', message: 'queued item is no longer pending' } }),
    setDraft: (text) => calls.push({ setDraft: text }),
    notify: (text, opts) => calls.push({ notify: text, opts }),
  }
  const done = await pure.withdrawSteer(STEERING_ROW, actions)
  assert.equal(done, false)
  assert.deepEqual(calls, [{ notify: '插话已被应用,无法撤回', opts: { kind: 'error' } }])
})

test('withdrawSteer 其他失败:透传错误消息且不回填草稿', async () => {
  const calls = []
  const actions = {
    updateQueue: async () => ({ ok: false, error: { code: 'session/steer-unavailable', message: 'busy' } }),
    setDraft: (text) => calls.push({ setDraft: text }),
    notify: (text, opts) => calls.push({ notify: text, opts }),
  }
  const done = await pure.withdrawSteer(STEERING_ROW, actions)
  assert.equal(done, false)
  assert.deepEqual(calls, [{ notify: '撤回失败: busy', opts: { kind: 'error' } }])
})

test('withdrawSteer 传输层拒绝:按错误处理且不回填草稿', async () => {
  const calls = []
  const actions = {
    updateQueue: async () => { throw new Error('network down') },
    setDraft: (text) => calls.push({ setDraft: text }),
    notify: (text, opts) => calls.push({ notify: text, opts }),
  }
  const done = await pure.withdrawSteer(STEERING_ROW, actions)
  assert.equal(done, false)
  assert.deepEqual(calls, [{ notify: '撤回失败: network down', opts: { kind: 'error' } }])
})

test('withdrawSteer 摘除成功但回填抛错:兜底展示原文,不报成功', async () => {
  const calls = []
  const actions = {
    updateQueue: async () => ({ ok: true }),
    setDraft: () => { throw new Error('shell released') },
    notify: (text, opts) => calls.push({ notify: text, opts }),
  }
  const done = await pure.withdrawSteer(STEERING_ROW, actions)
  assert.equal(done, false)
  assert.deepEqual(calls, [{ notify: '草稿回填失败,原文: 帮我看下', opts: { kind: 'error' } }])
})

// ── 组件级门控:干净禁用规约的落地断言(整源加载 + 记录型 createElement 直接调组件) ──

// createElement 桩记录调用树:h(type, props, ...children) -> {type, props, children}
// useStateValues:按调用序覆盖各 useState 初始值(超出部分用组件默认),供渲染态断言
function loadComponent() {
  const modules = []
  const registered = []
  const windowStub = { __ModuleLoader__: { load: (module) => modules.push(module) }, addEventListener: () => {} }
  const reactStub = {
    useState: (value) => [value, () => {}],
    useEffect: () => {},
    useRef: (value) => ({ current: value }),
    createElement: (type, props, ...children) => ({ type, props, children }),
  }
  const requireStub = (name) => {
    if (name === '@mzzsfy/dsh-common-tools/client') return { toast: { show: () => 0 } }
    return reactStub
  }
  const factory = new Function('window', 'require', 'document', CLIENT_SRC + '\n;return null')
  factory(
    windowStub,
    requireStub,
    {
      createElement: () => ({ style: {}, remove() {} }),
      createElementNS: () => ({ appendChild() {}, setAttribute() {} }),
      head: { appendChild: () => {} },
      body: { appendChild: () => {} },
      querySelectorAll: () => [],
    },
  )
  const mod = modules[0].factory(requireStub)
  const sessions = { binding: () => undefined, fork: () => Promise.resolve('c'), open: () => {} }
  const ctx = {
    get: (name) => (name === 'sessions' ? sessions : {}),
    effect: () => {},
    slots: {
      inject: (name, register) => register(),
      register: (options, component) => registered.push({ options, component }),
    },
    get remote() { return { session: { page: () => Promise.resolve({ records: [] }) } } },
    inject: (deps, register) => { if (deps.includes('remote.session') && ctx.remote.session) register(ctx) },
  }
  mod.apply(ctx)
  const entry = registered.find((item) => item.options.id === 'context-manager-steer')
  assert.ok(entry, '组件级测试未捕获插话撤回条目')
  return { component: entry.component }
}

const DOCK_COMPONENT = loadComponent()
const NO_ACTIONS = { setDraft: () => {} }
const OK_UPDATE = async () => ({ ok: true })

// useSession 桩:两次 selector 读取共用同一快照(与官方 SessionSnapshotSelector 单快照同构)
function dockWith(snapshot) {
  const useSession = (selector) => selector(snapshot)
  const dock = loadComponent()
  return (props) => dock.component({ useSession, inputActions: NO_ACTIONS, updateQueue: OK_UPDATE, inboxFace: { getSnapshot: () => ({}) }, ...props })
}

test('SteerRecallDock 干净禁用:依赖任一缺失即返回 null', () => {
  const dock = dockWith({ subagent: null })
  assert.equal(dock({ inputActions: undefined }), null, 'inputActions 缺失应不渲染')
  assert.equal(dock({ updateQueue: undefined }), null, 'updateQueue 缺失应不渲染')
  assert.equal(dock({ inboxFace: undefined }), null, 'inboxFace 缺失应不渲染(旧宿主无投影)')
})

test('SteerRecallDock 干净禁用:subagent 非 continuable 即返回 null', () => {
  const locked = dockWith({ subagent: { address: { mode: 'prompt' } } })
  assert.equal(locked({}), null, 'queueMutable 为假应不渲染')
})

test('SteerRecallDock 渲染:依赖齐备时零占位宿主(注入面由 MutationObserver 承担)', () => {
  const host = dockWith({ subagent: null })({})
  assert.equal(host.type, 'div')
  assert.equal(host.props.className, 'cx-steer-host', '应渲染零占位宿主')
})

// 撤回图标 svg:DOM 形态(注入按钮走 DOM 路径,与 forkSvg 同构)
test('steerRecallSvg:DOM 元素形态,16px viewBox 双路径 stroke 描边', () => {
  const SVG_START = CLIENT_SRC.indexOf('function steerRecallSvg(')
  const SVG_END = CLIENT_SRC.indexOf('function forkSvg(')
  assert.ok(SVG_START > 0 && SVG_END > SVG_START, 'steerRecallSvg 切片定位失败')
  const created = []
  const el = () => {
    const node = { attrs: {}, children: [], appendChild(child) { this.children.push(child) }, setAttribute(k, v) { this.attrs[k] = v } }
    created.push(node)
    return node
  }
  const svg = new Function('document', CLIENT_SRC.slice(SVG_START, SVG_END) + '; return steerRecallSvg()')({ createElementNS: el })
  assert.equal(created.length, 3, '应创建 1 个 svg + 2 个 path')
  assert.equal(svg, created[0])
  assert.equal(svg.attrs.width, '16')
  assert.equal(svg.attrs.height, '16')
  assert.equal(svg.attrs.viewBox, '0 0 16 16')
  assert.equal(svg.children.length, 2, 'undo 弯箭头应由两条 stroke 路径构成')
})

// 注入契约(源码级守卫,与 client-fork.test.mjs 的 fork 契约同构):
// 显隐由 inbox 投影行集驱动——行在注入、行不在摘除,投影订阅保证应用后即时消失。
// pending 与 durable 双路径:pending 气泡(data-pending-steering,含双标记 echo
// 形态)按文档序与投影序对齐,durable 气泡按 node-key messageId 匹配。
// 锚定 SteerRecallDock 函数体切片:防止常量定义行/注释文本满足 grep 造成守卫空转
test('SteerRecallDock 注入契约:双路径气泡锚点、投影驱动显隐、官方类克隆与清理齐备', () => {
  const DOCK_START = CLIENT_SRC.indexOf('function SteerRecallDock(')
  const DOCK_END = CLIENT_SRC.indexOf('// 对话 fork:')
  assert.ok(DOCK_START > 0 && DOCK_END > DOCK_START, 'SteerRecallDock 切片定位失败')
  const dock = CLIENT_SRC.slice(DOCK_START, DOCK_END)
  assert.ok(dock.includes("querySelectorAll('[' + FLOW_KIND_ATTR + '=\"steering\"]')"), '应扫描 durable steering 气泡(node-key 匹配路径)')
  assert.ok(dock.includes("querySelectorAll('[' + STEER_PENDING_ATTR + ']')"), '应扫描 Host pending steering 气泡(顺序对齐路径)')
  assert.ok(!dock.includes('SUBMISSION_ECHO_ATTR'), 'pending 对齐不得排除本地提交 echo——宿主 0.2.1-rc.2 发送会话内插话即双标记 echo 形态,排除即主场景错杀(行存在性检查已覆盖 Host 未确认防误配)')
  assert.ok(dock.includes("button.setAttribute(STEER_BTN_FLAG, '')"), '注入按钮应带自家标记(防重复注入与误删官方节点)')
  assert.ok(dock.includes("bubble.querySelector('[' + STEER_BTN_FLAG + ']')"), '应按气泡范围查询防重标记(同一查询点承担行不在时的摘除)')
  assert.ok(dock.includes('STEER_NODE_KEY_RE'), 'durable 气泡应经 node-key 正则提取 messageId 匹配投影行')
  assert.ok(dock.includes('const row = rows[index] || null'), 'pending 气泡应按文档序与投影序配对(顺序对齐,不依赖渲染文本)')
  assert.ok(dock.includes('face.subscribe'), '应订阅 inbox 投影,应用后驱动重扫摘除按钮')
  assert.ok(dock.includes('button.className = official.className'), '应克隆官方按钮类名(尺寸/hover/悬停显隐原生)')
  assert.ok(dock.includes("button.closest('[' + FLOW_KIND_ATTR + '=\"steering\"], [' + STEER_PENDING_ATTR + ']'"), '点击应实时重读气泡(pending 与 durable 同构)')
  assert.ok(dock.includes('forEach((button) => button.remove())'), '卸载/停用应移除全部已注入按钮')
  assert.ok(dock.includes('插话已被应用,无法撤回'), '点击竞态窗口内被应用应降级提示')
  assert.ok(dock.includes('restoreAttachments'), '含附件行点击应走附件恢复通道')
  assert.ok(dock.includes('releaseDrafts: current.releaseDrafts'), '附件挂载失败时应能释放已注册草稿')
  assert.ok(!dock.includes('含附件的插话不支持撤回'), '不得再拒绝含附件插话的撤回')
  assert.ok(dock.includes('if (!current || !current.queueMutable || !current.inboxFace'), '点击应与 scan 同款依赖守卫(face falsy/锁定态不执行)')
})

// ── 组件级 scan 行为:投影行集驱动注入/摘除(MutationObserver 与投影 face 可控行使) ──

// DOM 桩:durable 单 steering 气泡 + 可选 pending 气泡序列 + 操作排;querySelector
// 动态反映当前注入态(防重与摘除断言依赖);face 订阅记录回调,手动触发模拟投影
// 更新;effect 手动执行
function mountScanHarness({ faceRows, updateQueue, setDraft, readAttachmentFile, createDrafts, releaseDrafts, addAttachments, pendingBubble = false, pendingBubbles = null } = {}) {
  const modules = []
  const registered = []
  const effects = []
  const subscribers = []
  const injected = []
  const toastCalls = []
  let unsubscribed = false
  let enabledSlot = true
  let refCall = 0
  const refs = []
  const makeButton = () => ({
    attrs: {}, listeners: {}, className: '', title: '', type: undefined, disabled: false, removed: false, closestTarget: null,
    setAttribute(k, v) { this.attrs[k] = v },
    addEventListener(name, fn) { this.listeners[name] = fn },
    appendChild() {},
    remove() { this.removed = true },
    closest() { return this.closestTarget || bubble },
  })
  const official = makeButton()
  const makeActionsRow = (host) => {
    const row = {
      appendChild(child) {
        child.closestTarget = host
        injected.push(child)
        ;(host.buttons ||= []).push(child)
      },
      querySelector(sel) { return sel.startsWith('button:not(') ? official : null },
    }
    return row
  }
  const pendingSeeds = pendingBubbles !== null
    ? pendingBubbles
    : (pendingBubble ? [{ text: '帮我看下' }] : [])
  // echo 形态:宿主 0.2.1-rc.2 发送会话内,投影行被本地 submission 替换渲染,
  // steering 气泡 = data-pending-steering + data-submission-echo 双标记;
  // 切会话回来(本地 state 清空)渲染纯 pending 单标记
  const makeBubble = ({ pending, echo, text }) => {
    const b = {
      attrs: {
        'data-chat-node-key': pending ? null : '5:input-messagem1',
        'data-chat-flow-kind': pending ? null : 'steering',
        'data-pending-steering': pending ? '' : null,
        'data-submission-echo': echo ? '' : null,
      },
      textContent: text || '',
      buttons: null,
      hasAttribute(k) { return this.attrs[k] !== null && this.attrs[k] !== undefined },
      getAttribute(k) { return this.attrs[k] !== undefined ? this.attrs[k] : null },
      querySelector(sel) {
        if (sel === '[class$="_actions"]') { this.actionsRow ||= makeActionsRow(b); return this.actionsRow }
        if (sel === '[' + 'data-cx-steer-recall' + ']') return (this.buttons || []).find((x) => !x.removed) || null
        return null
      },
    }
    return b
  }
  const bubble = makeBubble({ pending: false })
  const pendingDom = pendingSeeds.map((seed) => makeBubble({ pending: true, echo: seed.echo, text: seed.text }))
  // 真实宿主单条插话只渲染一种气泡(pending 或 durable),桩随 pendingSeeds 切换
  const allBubbles = pendingSeeds.length > 0 ? [...pendingDom] : [bubble]
  const reactStub = {
    // enabled 槽位化:setter 写回,停用测试经返回的 setEnabled 拨关后重扫;
    // useRef 槽位持久(同一调用序返回同一 ref 对象,跨渲染保持 current)
    useState: (value) => [enabledSlot, (v) => { enabledSlot = typeof v === 'function' ? v(enabledSlot) : v }],
    useEffect: (fn, deps) => effects.push({ fn, deps }),
    useRef: (value) => {
      const i = refCall
      refCall += 1
      if (!(i in refs)) refs[i] = { current: value }
      return refs[i]
    },
    createElement: (type, props, ...children) => ({ type, props, children }),
  }
  const documentStub = {
    head: { appendChild: () => {} },
    body: { appendChild: () => {} },
    documentElement: {},
    createElement: () => makeButton(),
    createElementNS: () => ({ setAttribute() {}, appendChild() {} }),
    querySelectorAll(sel) {
      if (sel.includes('data-chat-flow-kind="steering"')) return pendingSeeds.length > 0 ? [] : [bubble]
      if (sel.includes('data-pending-steering')) return pendingDom
      if (sel.includes('data-cx-steer-recall')) {
        const alive = allBubbles.flatMap((b) => (b.buttons || []).filter((x) => !x.removed))
        return alive
      }
      return []
    },
  }
  class MutationObserverStub {
    constructor() {}
    observe() {}
    disconnect() {}
  }
  const windowStub = { __ModuleLoader__: { load: (module) => modules.push(module) }, addEventListener: () => {} }
  const requireStub = (name) => {
    if (name === '@mzzsfy/dsh-common-tools/client') return { toast: { show: (text, opts) => toastCalls.push({ text, opts }) } }
    return reactStub
  }
  const factory = new Function('window', 'require', 'document', 'MutationObserver', 'fetch', CLIENT_SRC + '\n;return null')
  factory(
    windowStub,
    requireStub,
    documentStub,
    MutationObserverStub,
    async () => ({ ok: false, status: 404, json: async () => ({}) }),
  )
  const mod = modules[0].factory(requireStub)
  const sessions = { binding: () => undefined, fork: () => Promise.resolve('c'), open: () => {} }
  const ctx = {
    get: (name) => (name === 'sessions' ? sessions : {}),
    effect: () => {},
    slots: {
      inject: (name, register) => register(),
      register: (options, component) => registered.push({ options, component }),
    },
    get remote() { return { session: {} } },
    inject: (deps, register) => { if (deps.includes('remote.session') && ctx.remote.session) register(ctx) },
  }
  mod.apply(ctx)
  const entry = registered.find((item) => item.options.id === 'context-manager-steer')
  assert.ok(entry, 'scan 行为测试未捕获插话撤回条目')
  const face = {
    getSnapshot: () => ({ 'next-step': typeof faceRows === 'function' ? faceRows() : faceRows }),
    subscribe(cb) { subscribers.push(cb); return () => { unsubscribed = true } },
  }
  const useSession = (selector) => selector({ subagent: null })
  const lastProps = {
    useSession,
    inputActions: { setDraft: setDraft || (() => {}), addAttachments: addAttachments || (() => {}) },
    updateQueue: updateQueue || (async () => ({ ok: true })),
    inboxFace: face,
    readAttachmentFile: readAttachmentFile || null,
    createDrafts: createDrafts || null,
    releaseDrafts: releaseDrafts || null,
  }
  entry.component(lastProps)
  let cleanup
  effects.forEach(({ fn }) => { cleanup = fn() })
  if (process.env.CX_DEBUG) console.error('[cx-debug]', JSON.stringify({ effectCount: effects.length, injected: injected.length, subscribers: subscribers.length, snapshotRows: face.getSnapshot()['next-step'], toastCalls: toastCalls.length }))
  return {
    face,
    injected,
    subscribers,
    toastCalls,
    deps: effects[1] ? effects[1].deps : null,
    cleanup,
    isUnsubscribed: () => unsubscribed,
    setEnabled: (v) => { enabledSlot = v },
    // 模拟 React 重渲染:同一 props 再调一次组件(hooks 桩按调用序推进,游标归零)
    rerender: () => { refCall = 0; entry.component(lastProps) },
  }
}

const settle = () => new Promise((resolve) => setImmediate(resolve))

test('scan pending 行:Host optimistic bubble 无 node-key 时仍注入撤回', () => {
  const h = mountScanHarness({ faceRows: [INBOX_MESSAGE], pendingBubble: true })
  assert.equal(h.injected.length, 1, 'Host pending-steering bubble 无 data-chat-flow-kind/node-key 仍须匹配其 next-step 行')
})

test('scan pending 顺序:Markdown 渲染文本与原文不一致仍按序注入(文本不参与匹配)', () => {
  // 宿主把 next-step user 行保序渲染为 pending 气泡;Markdown 渲染后 textContent
  // 不等于行原文,匹配只能靠顺序——纯文本相等匹配会让带格式插话永远无图标
  const h = mountScanHarness({ faceRows: [INBOX_MESSAGE], pendingBubbles: [{ text: '帮我看**下**,谢谢' }] })
  assert.equal(h.injected.length, 1, '渲染文本 ≠ 行原文时仍须按顺序对齐注入')
})

test('scan pending 顺序:多行多气泡按序一一配对', () => {
  const rows = [
    { id: 'm1', source: { kind: 'user' }, content: [{ type: 'text', text: '第一条' }] },
    { id: 'm2', source: { kind: 'user' }, content: [{ type: 'text', text: '**第二条**' }] },
  ]
  const h = mountScanHarness({ faceRows: rows, pendingBubbles: [{ text: '第一条' }, { text: '第二条' }] })
  assert.equal(h.injected.length, 2, '两个 pending 气泡按序配对两行')
})

// 第三次失效(2026-10-20)回归:宿主 0.2.1-rc.2 发送会话内,投影行被本地 submission
// 替换渲染,steering 气泡 = data-pending-steering + data-submission-echo 双标记;
// 排除 echo 的旧过滤把主场景气泡整体错杀,图标只在切会话回来(纯 pending 形态)出现。
// 顺序对齐保证「行存在才注入」,echo 排除的原始动机(Host 未确认防误配)已由其覆盖。
test('scan pending 双标记:发送会话内 echo 形态气泡仍按序注入(第三次失效回归)', () => {
  const h = mountScanHarness({ faceRows: [INBOX_MESSAGE], pendingBubbles: [{ text: '帮我看下', echo: true }] })
  assert.equal(h.injected.length, 1, 'Host 已确认(投影有行)的双标记 echo 气泡必须注入,不得按 echo 标记排除')
})

test('scan pending 混合:echo 与纯 pending 混合序列按序配对', () => {
  const rows = [
    { id: 'm1', source: { kind: 'user' }, content: [{ type: 'text', text: '第一条' }] },
    { id: 'm2', source: { kind: 'user' }, content: [{ type: 'text', text: '第二条' }] },
  ]
  const h = mountScanHarness({ faceRows: rows, pendingBubbles: [{ text: '第一条', echo: true }, { text: '第二条' }] })
  assert.equal(h.injected.length, 2, '双标记与单标记气泡在同序队列中一并配对')
})

test('scan pending 双标记:无行排尾 echo(Host 未确认)不注入', () => {
  const rows = [{ id: 'm1', source: { kind: 'user' }, content: [{ type: 'text', text: '第一条' }] }]
  const h = mountScanHarness({ faceRows: rows, pendingBubbles: [{ text: '第一条', echo: true }, { text: '刚发出', echo: true }] })
  assert.equal(h.injected.length, 1, '行存在性检查天然覆盖 Host 未确认场景,尾部无行 echo 不得注入')
})

test('scan pending 双标记点击:echo 形态气泡点击走 remove 主路径并回填', async () => {
  const calls = []
  const h = mountScanHarness({
    faceRows: [INBOX_MESSAGE],
    pendingBubbles: [{ text: '帮我看下', echo: true }],
    updateQueue: async (itemId, action) => { calls.push({ itemId, action }); return { ok: true } },
    setDraft: (text) => calls.push({ setDraft: text }),
  })
  h.injected[0].listeners.click()
  await settle()
  assert.deepEqual(calls, [
    { itemId: 'm1', action: { kind: 'remove' } },
    { setDraft: '帮我看下' },
  ], 'echo 形态气泡点击不得被 echo 排除拦截为「已被应用」')
})

test('scan pending 顺序:行数少于气泡数(尾部行已应用)→ 多余气泡不注入', () => {
  let rows = [
    { id: 'm1', source: { kind: 'user' }, content: [{ type: 'text', text: '第一条' }] },
    { id: 'm2', source: { kind: 'user' }, content: [{ type: 'text', text: '第二条' }] },
  ]
  const h = mountScanHarness({ faceRows: () => rows, pendingBubbles: [{ text: '第一条' }, { text: '第二条' }] })
  assert.equal(h.injected.length, 2)
  rows = [rows[1]]
  h.subscribers.forEach((cb) => cb())
  assert.equal(h.injected.filter((b) => b.removed).length, 1, '行应用后对应序位气泡按钮应摘除(头气泡失配)')
  assert.equal(h.injected.filter((b) => !b.removed).length, 1, '存续行对应气泡按钮保留')
})

test('scan pending 点击:按顺序对齐行走 remove 主路径并回填', async () => {
  const calls = []
  const h = mountScanHarness({
    faceRows: [INBOX_MESSAGE],
    pendingBubble: true,
    updateQueue: async (itemId, action) => { calls.push({ itemId, action }); return { ok: true } },
    setDraft: (text) => calls.push({ setDraft: text }),
  })
  h.injected[0].listeners.click()
  await settle()
  assert.deepEqual(calls, [
    { itemId: 'm1', action: { kind: 'remove' } },
    { setDraft: '帮我看下' },
  ], 'pending 气泡点击应按顺序对齐行发起 remove 并回填')
  assert.equal(h.toastCalls.at(-1).text, '已撤回到输入框')
})

test('scan 投影驱动:行在注入,行不在不注入;scan effect 依赖 inboxFace', () => {
  const on = mountScanHarness({ faceRows: [INBOX_MESSAGE] })
  assert.equal(on.injected.length, 1, '未应用行应注入撤回按钮')
  assert.ok(on.deps && on.deps.includes(on.face), 'scan 装配 effect 应依赖 inboxFace(会话切换重订)')
  const off = mountScanHarness({ faceRows: [] })
  assert.equal(off.injected.length, 0, '已应用行(投影无行)不应注入按钮')
})

test('scan 投影驱动:注入后被应用(行移除)→ 订阅回调摘除按钮,不重复注入', () => {
  let rows = [INBOX_MESSAGE]
  const h = mountScanHarness({ faceRows: () => rows })
  assert.equal(h.injected.length, 1)
  rows = []
  h.subscribers.forEach((cb) => cb())
  assert.equal(h.injected[0].removed, true, '应用后按钮应被投影重扫摘除')
  assert.equal(h.injected.length, 1, '摘除后不得重复注入')
})

test('scan 投影驱动:行仍在的重扫防重', () => {
  const h = mountScanHarness({ faceRows: [INBOX_MESSAGE] })
  h.subscribers.forEach((cb) => cb())
  assert.equal(h.injected.length, 1, '投影更新但行仍在时不应重复注入')
})

test('scan 点击:撤回主路径 remove + 回填 + 成功提示', async () => {
  const calls = []
  const h = mountScanHarness({
    faceRows: [INBOX_MESSAGE],
    updateQueue: async (itemId, action) => { calls.push({ itemId, action }); return { ok: true } },
    setDraft: (text) => calls.push({ setDraft: text }),
  })
  h.injected[0].listeners.click()
  await settle()
  assert.deepEqual(calls, [
    { itemId: 'm1', action: { kind: 'remove' } },
    { setDraft: '帮我看下' },
  ], '撤回应按 remove 动作路由并回填草稿')
  assert.equal(h.toastCalls.at(-1).text, '已撤回到输入框')
})

test('scan 点击:点击瞬间行已被应用 → 降级提示,不回填', async () => {
  let rows = [INBOX_MESSAGE]
  const h = mountScanHarness({ faceRows: () => rows })
  rows = []
  h.injected[0].listeners.click()
  await settle()
  assert.deepEqual(h.toastCalls, [{ text: '插话已被应用,无法撤回', opts: { kind: 'error' } }])
})

test('scan cleanup:退订投影并移除全部已注入按钮', () => {
  const h = mountScanHarness({ faceRows: [INBOX_MESSAGE] })
  h.cleanup()
  assert.equal(h.isUnsubscribed(), true, 'cleanup 应退订投影')
  assert.equal(h.injected[0].removed, true, 'cleanup 应移除已注入按钮')
})

test('scan 点击:含附件行 → remove + 回填文本 + 恢复附件', async () => {
  const calls = []
  const attachment = { attachmentId: 'a1', mediaType: 'image/png', bytes: 1, width: 1, height: 1 }
  const h = mountScanHarness({
    faceRows: [{ id: 'm1', source: { kind: 'user' }, content: [{ type: 'text', text: '看图' }, { type: 'image', attachment }] }],
    updateQueue: async (itemId, action) => { calls.push({ itemId, action }); return { ok: true } },
    setDraft: (text) => calls.push({ setDraft: text }),
    readAttachmentFile: async (item) => { calls.push({ read: item.kind }); return { name: 'x.png' } },
    createDrafts: (files) => { calls.push({ drafts: files.length }); return [{ id: 'd1' }] },
    addAttachments: (ids) => calls.push({ attach: ids }),
  })
  h.injected[0].listeners.click()
  await settle()
  assert.deepEqual(calls, [
    { itemId: 'm1', action: { kind: 'remove' } },
    { setDraft: '看图' },
    { read: 'image' },
    { drafts: 1 },
    { attach: ['d1'] },
  ], '含附件行应 remove + 回填文本 + 读取附件 + 注册并挂载草稿附件')
  assert.equal(h.toastCalls.at(-1).text, '已撤回到输入框')
})

test('scan 点击:附件挂载被输入框拒绝 → 释放已注册草稿并提示失败', async () => {
  const calls = []
  const attachment = { attachmentId: 'f1', name: 'a.txt', bytes: 1 }
  const drafts = [{ id: 'd1' }]
  const h = mountScanHarness({
    faceRows: [{ id: 'm1', source: { kind: 'user' }, content: [{ type: 'file', attachment }] }],
    updateQueue: async () => ({ ok: true }),
    setDraft: (text) => calls.push({ setDraft: text }),
    readAttachmentFile: async () => ({ name: 'a.txt' }),
    createDrafts: () => drafts,
    addAttachments: () => false,
    releaseDrafts: (released) => calls.push({ release: released.map((draft) => draft.id) }),
  })
  h.injected[0].listeners.click()
  await settle()
  assert.deepEqual(calls, [{ release: ['d1'] }], 'addAttachments=false 应释放 draft,且纯附件不写空草稿')
  assert.equal(h.toastCalls.at(-1).text, '已撤回;1 个附件恢复失败,请重新添加')
})

test('scan 停用:开关关闭后重扫移除已注入按钮且不再注入', () => {
  const h = mountScanHarness({ faceRows: [INBOX_MESSAGE] })
  assert.equal(h.injected.length, 1, '前置:启用态已注入')
  // 真实 React:setEnabled → 重渲染同步 enabledRef → effect 重跑。桩环境按此序驱动
  h.setEnabled(false)
  h.rerender()
  h.subscribers.forEach((cb) => cb())
  assert.equal(h.injected[0].removed, true, '停用重扫应移除已注入按钮')
  assert.equal(h.injected.length, 1, '停用后不得重新注入')
})
