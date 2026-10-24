// 克隆仓库打开工作区:纯逻辑矩阵(目标全路径校验/git 参数构造/克隆执行)
// + 路由层校验拒绝 + client 侧推导/轮询/读取行为。
// 真实 git 只验证参数构造与失败路径,克隆成功路径全走 spawn 注入,零网络零仓库依赖。
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const PKG_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const {
  resolveCloneRequest,
  buildCloneArgs,
  runClone,
  tailLines,
  CLONE_TIMEOUT_MS,
  TARGET_EMPTY_DIR,
  TARGET_FILE,
  TARGET_MISSING,
  TARGET_NONEMPTY_DIR,
} = await import('../src/clone.mjs')
const { apply, MESSAGES } = await import('../src/index.js')

// ── 请求校验(目标全路径,IDEA Get from VCS 同构)──

const stateOf = (mapping) => async (target) => mapping[target] ?? TARGET_MISSING

test('Given 合法请求, When resolveCloneRequest, Then 返回 url/target/shallow 原样透传', async () => {
  const request = await resolveCloneRequest(
    { url: 'https://github.com/user/repo.git', target: 'C:\\work\\repo', shallow: true },
    { homedirPath: 'C:\\Users\\u', targetState: stateOf({}) },
  )
  assert.equal(request.url, 'https://github.com/user/repo.git')
  assert.equal(request.target, 'C:\\work\\repo')
  assert.equal(request.shallow, true)
})

test('Given 目标四态, When resolveCloneRequest, Then 缺失与空目录放行,非空与文件拒绝', async () => {
  const options = { homedirPath: '', targetState: stateOf({ '/t/empty': TARGET_EMPTY_DIR, '/t/full': TARGET_NONEMPTY_DIR, '/t/file': TARGET_FILE }) }
  const missing = await resolveCloneRequest({ url: 'https://e.com/r.git', target: '/t/new' }, options)
  assert.equal(missing.target, '/t/new')
  const empty = await resolveCloneRequest({ url: 'https://e.com/r.git', target: '/t/empty' }, options)
  assert.equal(empty.target, '/t/empty')
  await assert.rejects(
    () => resolveCloneRequest({ url: 'https://e.com/r.git', target: '/t/full' }, options),
    /目标目录已存在且非空/,
  )
  await assert.rejects(
    () => resolveCloneRequest({ url: 'https://e.com/r.git', target: '/t/file' }, options),
    /目标路径已被文件占用/,
  )
})

test('Given 非法 url 或非法目标, When resolveCloneRequest, Then 逐项拒绝', async () => {
  const options = { homedirPath: '/home/u', targetState: stateOf({}) }
  await assert.rejects(() => resolveCloneRequest({ url: '', target: '/tmp' }, options), /仓库地址不能为空/)
  await assert.rejects(() => resolveCloneRequest({ url: '-u=https://e.com/r', target: '/tmp' }, options), /仓库地址不合法/)
  await assert.rejects(() => resolveCloneRequest({ url: 'file:///tmp/r', target: '/tmp' }, options), /远程地址/)
  await assert.rejects(() => resolveCloneRequest({ url: 'C:\\repos\\r', target: '/tmp' }, options), /远程地址/)
  await assert.rejects(() => resolveCloneRequest({ url: 'https://e.com/r.git', target: '' }, options), /目标目录不能为空/)
  await assert.rejects(
    () => resolveCloneRequest({ url: 'https://e.com/r.git', target: 'relative/path' }, options),
    /目标目录必须是绝对路径/,
  )
})

test('Given 目标为 ~ 前缀, When resolveCloneRequest, Then 以宿主 home 展开', async () => {
  const request = await resolveCloneRequest(
    { url: 'https://e.com/r.git', target: '~/work/repo' },
    { homedirPath: '/home/u', targetState: stateOf({}) },
  )
  assert.equal(request.target, join('/home/u', 'work/repo'))
})

// ── git 参数构造 ──

test('Given shallow 与否, When buildCloneArgs, Then 选项在 -- 前,url 与目标在 -- 后', () => {
  assert.deepEqual(
    buildCloneArgs({ url: 'https://e.com/r.git', target: '/t/r', shallow: false }),
    ['clone', '--', 'https://e.com/r.git', '/t/r'],
  )
  assert.deepEqual(
    buildCloneArgs({ url: 'https://e.com/r.git', target: '/t/r', shallow: true }),
    ['clone', '--depth', '1', '--', 'https://e.com/r.git', '/t/r'],
  )
})

// ── 克隆执行(spawn 注入,零网络)──

function spawnStub({ code = 0, stderr = '' } = {}) {
  const calls = []
  const spawn = (cmd, args, opts) => {
    calls.push({ cmd, args, opts })
    return {
      stderr: {
        setEncoding() {},
        on(_event, listener) { if (stderr) listener(stderr) },
      },
      on(event, listener) {
        if (event === 'error') return
        if (event === 'close') setImmediate(() => listener(code))
      },
      kill() {},
    }
  }
  return { spawn, calls }
}

test('Given git 退出 0, When runClone, Then resolve 目标路径', async () => {
  const { spawn, calls } = spawnStub({ code: 0, stderr: 'Cloning into...' })
  const result = await runClone({ url: 'https://e.com/r.git', target: '/t/r', parent: '/t', spawn })
  assert.deepEqual(result, { path: '/t/r' })
  assert.equal(calls[0].cmd, 'git')
  assert.equal(calls[0].opts.cwd, '/t')
})

test('Given git 非零退出, When runClone, Then 透出 stderr 尾部', async () => {
  const { spawn } = spawnStub({ code: 128, stderr: 'warning: x\nfatal: 远端意外挂断\n' })
  await assert.rejects(() => runClone({ url: 'https://e.com/r.git', target: '/t/r', parent: '/t', spawn }), /fatal: 远端意外挂断/)
})

test('Given git 不在 PATH, When runClone, Then 收敛为可行动文案', async () => {
  const missing = new Error('spawn git ENOENT')
  missing.code = 'ENOENT'
  const spawn = () => ({ stderr: null, on(event, listener) { if (event === 'error') setImmediate(() => listener(missing)) }, kill() {} })
  await assert.rejects(() => runClone({ url: 'https://e.com/r.git', target: '/t/r', parent: '/t', spawn }), /git 不可用:未安装或不在宿主 PATH 中/)
})

test('Given 超时, When runClone, Then 树杀并以业务错误拒绝', async () => {
  let killed = null
  const treeKill = (pid) => { killed = pid }
  const child = {
    stderr: { setEncoding() {}, on() {} },
    on() {},
    kill() {},
  }
  const spawn = () => child
  child.pid = 4321
  await assert.rejects(
    () => runClone({ url: 'https://e.com/r.git', target: '/t/r', parent: '/t', spawn, timeoutMs: 5, treeKill }),
    /克隆超时/,
  )
  assert.equal(killed, 4321)
})

test('Given 默认超时未显式传, When runClone 常量校验, Then 超时为 30 分钟量级', () => {
  assert.equal(CLONE_TIMEOUT_MS, 30 * 60 * 1000)
})

test('Given 多行 stderr, When tailLines, Then 保留非空尾部指定行数', () => {
  const text = 'a\n\nb\r\nc\nd'
  assert.equal(tailLines(text, 2), 'c\nd')
  assert.equal(tailLines('', 3), '')
})

// ── 路由层:校验拒绝在 spawn 之前,零副作用 ──

const sharedTmp = mkdtempSync(join(tmpdir(), 'cx-clone-route-'))
const effectDisposers = []
test.after(() => {
  for (const disposer of effectDisposers) {
    try { disposer() } catch { /* 逐个卸载,单个失败不阻断其余清理 */ }
  }
  rmSync(sharedTmp, { recursive: true, force: true })
})

function makeRouteCtx() {
  const routes = []
  const warns = []
  const ctx = {
    effect(fn) {
      const disposer = fn()
      if (typeof disposer === 'function') effectDisposers.push(disposer)
      return disposer
    },
    inject: () => {},
    fiber: { entry: { options: { id: 'context-manager' } } },
    get: () => ({
      get: () => undefined,
      register: () => {},
    }),
    logger: { warn(message) { warns.push(message) }, info() {} },
    webServer: { register: (route) => routes.push(route) },
    sessionQuery: { listSessions: async () => [] },
    sessionPersistence: undefined,
    agents: undefined,
  }
  process.env.DSH_HISTORY_CACHE_DIR = sharedTmp
  apply(ctx, undefined)
  return { handlers: new Map(routes.map((route) => [route.path, route.handler])), warns }
}

function makeRequest(method, body) {
  const state = { method, chunks: body === undefined ? [] : [JSON.stringify(body)] }
  state.on = (event, listener) => {
    if (event === 'data') for (const chunk of state.chunks) listener(Buffer.from(chunk))
    if (event === 'end') setImmediate(listener)
  }
  return state
}

function makeResponse() {
  const state = { status: undefined, body: undefined }
  state.writeHead = (status) => { state.status = status }
  state.end = (text) => { state.body = JSON.parse(text) }
  return state
}

test('Given 克隆路由, When 各非法请求, Then 逐项中文拒绝且无进程拉起', async () => {
  const { handlers } = makeRouteCtx()
  const handler = handlers.get('/api/context/git-clone')
  assert.ok(handler, '克隆路由未注册')
  const cases = [
    [{}, /仓库地址不能为空/],
    [{ url: '-x', target: '/tmp' }, /仓库地址不合法/],
    [{ url: 'file:///x', target: '/tmp' }, /远程地址/],
    [{ url: 'https://e.com/r.git', target: '' }, /目标目录不能为空/],
    [{ url: 'https://e.com/r.git', target: 'rel' }, /目标目录必须是绝对路径/],
  ]
  for (const [body, pattern] of cases) {
    const res = makeResponse()
    await handler(makeRequest('POST', body), res)
    assert.equal(res.status, 400, JSON.stringify(body))
    assert.match(res.body.error, pattern)
  }
})

test('Given 克隆路由, When 目标为非空目录或文件, Then 拒绝且不拉起 git', async () => {
  const { handlers } = makeRouteCtx()
  const handler = handlers.get('/api/context/git-clone')
  const nonempty = mkdtempSync(join(sharedTmp, 'full-'))
  writeFileSync(join(nonempty, 'seed.txt'), 'x')
  const res1 = makeResponse()
  await handler(makeRequest('POST', { url: 'https://e.com/r.git', target: nonempty }), res1)
  assert.equal(res1.status, 400)
  assert.match(res1.body.error, /目标目录已存在且非空/)
  const res2 = makeResponse()
  await handler(makeRequest('POST', { url: 'https://e.com/r.git', target: join(sharedTmp, 'no-such-parent', 'repo') }), res2)
  assert.equal(res2.status, 400)
  assert.match(res2.body.error, /父目录不存在或不是目录/, '父链缺失应前置拒绝,防 cwd ENOENT 误报 git 缺失')
})

test('Given 克隆路由, When GET, Then 405', async () => {
  const { handlers } = makeRouteCtx()
  const handler = handlers.get('/api/context/git-clone')
  const getRes = makeResponse()
  await handler(makeRequest('GET'), getRes)
  assert.equal(getRes.status, 405)
})

test('Given 真实 git 与不可达 .invalid 域, When POST 合法请求, Then 透出 git stderr 失败文案', async () => {
  const { execFileSync } = await import('node:child_process')
  let hasGit = true
  try {
    execFileSync('git', ['--version'])
  } catch {
    hasGit = false
  }
  if (!hasGit) return
  const { handlers } = makeRouteCtx()
  const handler = handlers.get('/api/context/git-clone')
  const res = makeResponse()
  await handler(
    makeRequest('POST', { url: 'https://cx-clone-nonexistent.invalid/repo.git', target: join(sharedTmp, 'invalid-host-probe') }),
    res,
  )
  assert.equal(res.status, 400)
  assert.match(res.body.error, /克隆失败/)
})

// ── client 侧:推导/轮询/读取与注入锚点契约 ──

const CLIENT_SRC = readFileSync(join(PKG_ROOT, 'src', 'client.js'), 'utf8')

test('Given client 内联目录名推导, When 各形态地址, Then 推导去 .git 的尾段;空/无效返回 null', () => {
  const declared = CLIENT_SRC.match(/function deriveRepoNameClient\(rawUrl\) \{[\s\S]*?\n\}/)
  assert.ok(declared, 'client.js 必须内联声明 deriveRepoNameClient')
  const derive = new Function(declared[0] + '\nreturn deriveRepoNameClient')()
  assert.equal(derive('https://github.com/user/repo.git'), 'repo')
  assert.equal(derive('https://github.com/user/repo/'), 'repo')
  assert.equal(derive('git@github.com:user/repo.git'), 'repo')
  assert.equal(derive('ssh://git@host:2222/group/inner/repo.git'), 'repo')
  assert.equal(derive(''), null)
  assert.equal(derive('https://example.com/.git'), null)
})

test('Given list 读取轮询, When input 延迟出现/不出现, Then 轮询到返回节点/超时返回 null', async () => {
  const pollDeclared = CLIENT_SRC.match(/function defaultPoll\(query\) \{[\s\S]*?\n\}/)
  assert.ok(pollDeclared, 'client.js 必须内联声明 defaultPoll')
  const defaultPoll = new Function(pollDeclared[0] + '\nreturn defaultPoll')()
  let appearAt = 2
  let calls = 0
  const found = await defaultPoll(() => {
    calls += 1
    return calls >= appearAt ? { value: 'x' } : null
  })
  assert.ok(found, '延迟出现的节点应被轮询到')
  assert.ok(calls >= 2, '应至少轮询两次')
  const none = await defaultPoll(() => null)
  assert.equal(none, null, '永不出现应返回 null')
}, 10 * 1000)

test('Given 浏览弹窗读取当前目录, When 编辑路径输入态出现, Then 读到完整路径并派发 Escape 收起', async () => {
  const declared = CLIENT_SRC.match(/async function readBrowseCurrentPath\(card, doc, \{ poll = defaultPoll \} = \{\}\) \{[\s\S]*?\n\}/)
  assert.ok(declared, 'client.js 必须内联声明 readBrowseCurrentPath')
  const events = []
  const input = {
    value: 'C:\\Users\\u\\Desktop\\',
    dispatchEvent(event) { events.push(event.key) },
  }
  const editZone = { disabled: false, click() { events.push('click') } }
  const crumbBar = {
    querySelector(selector) {
      if (selector === 'input') return input
      if (selector.includes('_crumbEditZone')) return editZone
      return null
    },
  }
  const card = { querySelector: (selector) => (selector === '[role="navigation"]' ? { parentElement: crumbBar } : null) }
  const readBrowseCurrentPath = new Function(
    'defaultPoll',
    declared[0] + '\nreturn readBrowseCurrentPath',
  )((query) => Promise.resolve(query()))
  const doc = {}
  const value = await readBrowseCurrentPath(card, doc)
  assert.equal(value, 'C:\\Users\\u\\Desktop\\', '应读出输入态完整路径')
  assert.equal(events[0], 'click', '应先点击编辑按钮')
  if (typeof KeyboardEvent === 'function') assert.equal(events[1], 'Escape', '读取后应派发 Escape 收起官方弹窗')
})

test('Given 读取路径前置守卫, When 编辑按钮缺失或禁用, Then 返回 null 且不点击', async () => {
  const declared = CLIENT_SRC.match(/async function readBrowseCurrentPath\(card, doc, \{ poll = defaultPoll \} = \{\}\) \{[\s\S]*?\n\}/)
  const readBrowseCurrentPath = new Function(
    'defaultPoll',
    declared[0] + '\nreturn readBrowseCurrentPath',
  )(() => Promise.resolve(null))
  const crumbBar = { querySelector: () => null }
  const card = { querySelector: (selector) => (selector === '[role="navigation"]' ? { parentElement: crumbBar } : null) }
  assert.equal(await readBrowseCurrentPath(card, {}), null, '编辑按钮缺失应返回 null')
  const disabledZone = { disabled: true, click() { throw new Error('不应点击') } }
  const crumbBar2 = { querySelector: (selector) => (selector.includes('_crumbEditZone') ? disabledZone : null) }
  const card2 = { querySelector: (selector) => (selector === '[role="navigation"]' ? { parentElement: crumbBar2 } : null) }
  assert.equal(await readBrowseCurrentPath(card2, {}), null, '编辑按钮禁用应返回 null')
})

test('Given client.js 装配面, When apply, Then inject 含 uiWorkspace(实测懒取不可达)且克隆注入经 ctx.effect', async () => {
  const effects = []
  const registered = []
  const modules = []
  const windowStub = { __ModuleLoader__: { load: (module) => modules.push(module) }, addEventListener: () => {} }
  const reactStub = { useState: (v) => [v, () => {}], useEffect: () => {}, useRef: (v) => ({ current: v }), createElement: () => null }
  const requireStub = (name) => (name === '@mzzsfy/dsh-change-bus/client' ? { toast: { show: () => 0 } } : reactStub)
  const factory = new Function('window', 'require', 'document', CLIENT_SRC + '\n;return null')
  factory(windowStub, requireStub, { createElement: () => ({ style: {}, remove() {} }), head: { appendChild: () => {} }, body: { appendChild: () => {} } })
  const mod = modules[0].factory(requireStub)
  const injectDeclaration = CLIENT_SRC.match(/inject: \[[^\]]*\]/)
  assert.ok(injectDeclaration, 'inject 声明缺失')
  assert.ok(injectDeclaration[0].includes('uiWorkspace'), 'uiWorkspace 必须声明注入(懒取不可达,自动打开依赖它)')
  const ctx = {
    get(name) {
      if (name === 'sessions') return { fork: () => Promise.resolve('c1') }
      if (name === 'workspaces') return { create: async () => ({ workspaceId: 'w1' }) }
      if (name === 'uiWorkspace') return { startSession: () => {} }
      return {}
    },
    effect(_fn, label) { effects.push(label) },
    slots: {
      inject: (name, register) => register(),
      register: (options, component) => registered.push({ options, component }),
    },
    get remote() { return { session: {} } },
  }
  mod.apply(ctx)
  assert.ok(effects.some((label) => String(label).includes('clone injection')), '克隆注入效应未注册')
})

// findBrowseFooter 结构契约:footer=卡片直子末元素且至少 3 按钮,末按钮=打开,
// 前一兄弟=取消;结构漂移时返回 null(干净禁用)
function fakeElement(tag) {
  return {
    tagName: String(tag).toUpperCase(),
    children: [],
    parentElement: null,
    className: 'cls-' + tag,
    disabled: false,
    querySelector: () => null,
    querySelectorAll: (selector) => (selector === 'button' ? [] : []),
    addEventListener() {},
    insertBefore() {},
    remove() {},
    getAttribute: () => null,
    appendChild(child) { this.children.push(child); child.parentElement = this },
  }
}

test('Given 官方弹窗结构, When findBrowseFooter 逻辑, Then 定位打开与取消按钮;结构漂移返回 null', () => {
  const declared = CLIENT_SRC.match(/function findBrowseFooter\(card\) \{[\s\S]*?\n\}/)
  assert.ok(declared, 'client.js 必须内联声明 findBrowseFooter')
  const findFooter = new Function(declared[0] + '\nreturn findBrowseFooter')()

  const openButton = fakeElement('button')
  const cancelButton = fakeElement('button')
  const gap = fakeElement('span')
  const other = fakeElement('button')
  const footer = fakeElement('div')
  footer.querySelectorAll = (selector) => (selector === 'button' ? [other, cancelButton, openButton] : [])
  footer.querySelector = (selector) => (selector === 'button:last-of-type' ? openButton : null)
  footer.lastElementChild = openButton
  openButton.previousElementSibling = cancelButton
  cancelButton.previousElementSibling = gap
  const scope = fakeElement('div')
  scope.lastElementChild = footer
  scope.parentElement = null
  const nav = fakeElement('span')
  const card = fakeElement('div')
  nav.parentElement = scope
  scope.parentElement = card
  card.querySelector = (selector) => (selector === '[role="navigation"]' ? nav : null)

  const parts = findFooter(card)
  assert.equal(parts.openButton, openButton)
  assert.equal(parts.cancelButton, cancelButton)

  const brokenCard = fakeElement('div')
  brokenCard.querySelector = () => null
  assert.equal(findFooter(brokenCard), null, '无面包屑卡片应返回 null')
  const thinFooter = fakeElement('div')
  thinFooter.querySelectorAll = () => []
  thinFooter.querySelector = () => null
  const scope2 = fakeElement('div')
  scope2.lastElementChild = thinFooter
  const nav2 = fakeElement('span')
  const thinCard = fakeElement('div')
  nav2.parentElement = scope2
  scope2.parentElement = thinCard
  thinCard.querySelector = (selector) => (selector === '[role="navigation"]' ? nav2 : null)
  assert.equal(findFooter(thinCard), null, '按钮不足 3 的 footer 应返回 null')
})

test('Given 注入循环, When setupCloneInjection, Then header 默认注入并轮询 /login 探测闸门,命中即移除还原 3 按钮布局', () => {
  assert.ok(CLIENT_SRC.includes('const armAuthProbe'), '必须有 armAuthProbe 登录闸门轮询')
  assert.match(CLIENT_SRC, /let headerAllowed = true/, '默认注入第 4 按钮(无闸门环境零延迟有入口)')
  assert.match(CLIENT_SRC, /fetch\('\/login', \{ credentials: 'omit' \}\)/, '探测信号=/login 排他性路由(闸门 200/裸宿主 404)')
  assert.match(CLIENT_SRC, /headerProbeRounds >= HEADER_PROBE_ROUNDS/, '探测窗口封顶,超时按钮常驻')
  assert.match(CLIENT_SRC, /headerAllowed = false\n\s+clearInterval\(headerProbeTimer\)\n\s+headerProbeTimer = null\n\s+removeAllHeader\(\)/, '命中闸门即停探测并物理移除按钮')
  assert.ok(!CLIENT_SRC.includes('armClickProbe'), '不得再用点击行为探测(要求用户先点一次才出按钮)')
  assert.ok(!CLIENT_SRC.includes('headerEntry'), '不得依赖宿主 headerEntry 字段(静态环境归因已证伪)')
  assert.ok(!CLIENT_SRC.includes('dsh-web-startup-auth'), 'client 不得引用 auth 包名(归因不可靠)')
})

test('Given 工作区 header, When ensureHeaderCloneButton, Then 注入添加按钮旁克隆邻居类名;幂等条件写;邻居缺失隐藏;auth 在场强制隐藏', () => {
  const declared = CLIENT_SRC.match(/function ensureHeaderCloneButton\(doc, onOpen, allowed\) \{[\s\S]*?\n\}/)
  assert.ok(declared, 'client.js 必须内联声明 ensureHeaderCloneButton')
  const flagDecl = CLIENT_SRC.match(/const HEADER_CLONE_BTN_FLAG = '([^']+)'/)
  const iconDecl = CLIENT_SRC.match(/const HEADER_CLONE_ICON = '([\s\S]+?)'\n/)
  assert.ok(flagDecl && iconDecl, '常量声明缺失')
  const ensure = new Function('HEADER_CLONE_BTN_FLAG', 'HEADER_CLONE_ICON', declared[0] + '\nreturn ensureHeaderCloneButton')(flagDecl[1], iconDecl[1])

  const makeButton = () => ({
    tagName: 'BUTTON',
    type: '',
    className: '',
    title: '',
    innerHTML: '',
    attrs: {},
    style: {},
    disabled: false,
    listeners: [],
    parentElement: null,
    setAttribute(name, value) { this.attrs[name] = value },
    getAttribute(name) { return this.attrs[name] ?? null },
    addEventListener(_type, listener) { this.listeners.push(listener) },
  })
  const addBtn = makeButton()
  addBtn.attrs['aria-label'] = '添加工作区'
  addBtn.className = 'icon-btn'
  const holder = {
    children: [addBtn],
    style: {},
    querySelector(selector) {
      if (selector === 'button[aria-label=添加工作区]') return addBtn
      if (selector.includes('data-cx-clone-header-btn')) return this.children.find((c) => c.attrs && 'data-cx-clone-header-btn' in c.attrs) ?? null
      return null
    },
    insertBefore(node, anchor) {
      const at = this.children.indexOf(anchor)
      this.children.splice(at < 0 ? this.children.length : at + 1, 0, node)
      node.parentElement = this
      return node
    },
  }
  addBtn.parentElement = holder
  const doc = {
    querySelector(selector) {
      if (selector === 'button[aria-label=添加工作区]') return addBtn
      if (selector.includes('data-cx-clone-header-btn')) return holder.children.find((c) => c.attrs && 'data-cx-clone-header-btn' in c.attrs) ?? null
      return null
    },
    createElement: () => makeButton(),
  }

  const first = ensure(doc, () => {})
  assert.equal(first, true, '首次注入发生写入')
  const injected = holder.children[holder.children.indexOf(addBtn) + 1]
  assert.ok(injected, '应注入到添加按钮紧后')
  assert.ok(!('data-plugin' in injected.attrs), '按钮不得带 data-plugin(宿主样式 claim 会把它当插件节点回收)')
  assert.equal(injected.className, 'icon-btn', '克隆邻居按钮类名(原生视觉)')
  assert.equal(injected.disabled, false, '镜像添加按钮可用态')
  assert.equal(holder.style.maxWidth, 'none', '必须解除 headerActions 的 max-width 裁剪(官方 60px 只容 2 图标)')
  const again = ensure(doc, () => {})
  assert.equal(again, false, '幂等:无变化不写(条件写防变异环)')

  // 基座重渲染重建按钮并翻转镜像 → 条件写跟进
  addBtn.disabled = true
  assert.equal(ensure(doc, () => {}), true, '镜像翻转发生写入')
  assert.equal(injected.disabled, true)

  // 邻居短暂消失:隐藏而非移除,回来后复显
  const docNoAdd = {
    querySelector: (selector) => (selector.includes('data-cx-clone-header-btn') ? injected : null),
    createElement: () => makeButton(),
  }
  injected.style.display = ''
  assert.equal(ensure(docNoAdd, () => {}), true, '隐藏发生写入')
  assert.equal(injected.style.display, 'none', '应隐藏注入按钮')
  assert.equal(ensure(doc, () => {}), true, '复显发生写入')
  assert.notEqual(injected.style.display, 'none', '邻居恢复后应复显')

  // auth 在场(allowed=false):强制隐藏已注入按钮,保持官方 3 按钮布局
  assert.equal(ensure(doc, () => {}, false), true, 'auth 在场发生隐藏写入')
  assert.equal(injected.style.display, 'none', 'auth 在场应隐藏注入按钮')
  assert.equal(ensure(doc, () => {}, false), false, 'auth 在场隐藏幂等')
})
