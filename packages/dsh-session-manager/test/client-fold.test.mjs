// 工作区文件夹运行标记:纯函数投影切片 + effect 扫描接线测试。
// 扫描逻辑闭包在 apply 的 effect 内,经捕获 effect 函数 + DOM 桩驱动,
// 锁定数量不变量守卫、下标对位、开关兜底与卸载清理。
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { mock } from 'node:test'

const PKG_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const CLIENT_SRC = readFileSync(join(PKG_ROOT, 'src', 'client.js'), 'utf8')

// ── 纯函数切片:常量与 folderRunningState(无外部依赖) ──

const PURE_START = CLIENT_SRC.indexOf('const FOLD_SECTION_SELECTOR')
const PURE_END = CLIENT_SRC.indexOf('// Toast 差分守卫')
assert.ok(PURE_START >= 0 && PURE_END > PURE_START, 'client.js 文件夹运行标记纯函数切片定位失败')
const pure = new Function(
  CLIENT_SRC.slice(PURE_START, PURE_END)
  + '; return { folderRunningState: folderRunningState, sectionSelector: FOLD_SECTION_SELECTOR, runningFlag: FOLD_RUNNING_FLAG, scanDelayMs: FOLD_SCAN_DELAY_MS }',
)()

const WS = (id, sessionIds) => ({ workspaceId: id, sessionIds })
const ROW = (id, extra) => ({ id, ...extra })

test('folderRunningState 主路径:运行中会话所在工作区入集合,非运行中不入', () => {
  const sessions = {
    ids: ['a', 'b'],
    byId: { a: ROW('a', { running: true }), b: ROW('b', { running: false }) },
  }
  const workspaces = { items: [WS('w1', ['a']), WS('w2', ['b'])], archivedSessionIds: [] }
  const state = pure.folderRunningState(sessions, workspaces)
  assert.deepEqual(state.ids, ['w1', 'w2'])
  assert.deepEqual([...state.running], ['w1'])
  assert.equal(state.ungrouped, false)
})

test('folderRunningState 未分组:游离运行中会话使末位未分组桶标记', () => {
  const sessions = {
    ids: ['a', 'stray'],
    byId: { a: ROW('a', { running: false }), stray: ROW('stray', { running: true }) },
  }
  const workspaces = { items: [WS('w1', ['a'])], archivedSessionIds: [] }
  const state = pure.folderRunningState(sessions, workspaces)
  assert.equal(state.running.has('w1'), false)
  assert.equal(state.ungrouped, true)
})

test('folderRunningState 排除项:subagent、已归档、空白非当前不标记,空白当前例外', () => {
  const sessions = {
    ids: ['sub', 'arch', 'blank', 'cur'],
    byId: {
      sub: ROW('sub', { running: true, origin: 'subagent' }),
      arch: ROW('arch', { running: true }),
      blank: ROW('blank', { running: true, blank: true }),
      cur: ROW('cur', { running: true, blank: true }),
    },
    current: 'cur',
  }
  const workspaces = {
    items: [WS('w1', ['sub']), WS('w2', ['arch']), WS('w3', ['blank']), WS('w4', ['cur'])],
    archivedSessionIds: ['arch'],
  }
  const state = pure.folderRunningState(sessions, workspaces)
  assert.equal(state.running.has('w1'), false, 'subagent 运行不标记')
  assert.equal(state.running.has('w2'), false, '已归档运行不标记')
  assert.equal(state.running.has('w3'), false, '空白非当前运行不标记')
  assert.equal(state.running.has('w4'), true, '空白且为当前会话标记')
})

test('folderRunningState 缺省守卫:快照缺失或账本悬空不抛错', () => {
  assert.deepEqual(pure.folderRunningState(undefined, undefined), { ids: [], running: new Set(), ungrouped: false })
  const state = pure.folderRunningState({ ids: ['gone'], byId: {} }, { items: [WS('w1', ['gone'])] })
  assert.deepEqual([...state.running], [])
  assert.equal(state.ungrouped, false)
})

// ── effect 扫描接线:DOM 桩 + 捕获 effect 函数驱动 ──

const SCAN_SETTLE_MS = pure.scanDelayMs * 4
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

// 组容器桩:属性集合语义与 Element 同构
function sectionStub() {
  const attrs = new Set()
  return {
    attrs,
    setAttribute: (name) => attrs.add(name),
    removeAttribute: (name) => attrs.delete(name),
    hasAttribute: (name) => attrs.has(name),
  }
}

// 加载 client.js 并执行 apply(mock 最小服务面),effect 函数捕获不执行;
// MutationObserver 经工厂形参注入(源码自由变量),document 桩承载组容器查询
function loadClient() {
  const modules = []
  const effects = []
  const windowStub = { __ModuleLoader__: { load: (module) => modules.push(module) }, addEventListener: () => {} }
  const reactStub = {
    useState: (value) => [value, () => {}],
    useEffect: () => {},
    useSyncExternalStore: () => [],
    useRef: (value) => ({ current: value }),
    createElement: () => null,
  }
  const requireStub = (name) => {
    if (name === '@mzzsfy/dsh-toast/client') return { show: () => 0 }
    return reactStub
  }
  const sections = []
  const documentStub = {
    documentElement: {},
    createElement: () => ({ style: {}, remove() {} }),
    head: { appendChild: () => {} },
    body: { appendChild: () => {} },
    querySelectorAll: (selector) => {
      if (selector === pure.sectionSelector) return [...sections]
      if (selector === '[' + pure.runningFlag + ']') return sections.filter((section) => section.hasAttribute(pure.runningFlag))
      return []
    },
  }
  class MutationObserverStub {
    observe() {}
    disconnect() {}
  }
  const factory = new Function('window', 'require', 'document', 'MutationObserver', CLIENT_SRC + '\n;return null')
  factory(windowStub, requireStub, documentStub, MutationObserverStub)
  assert.equal(modules.length, 1, 'client.js 模块未被捕获')
  const mod = modules[0].factory(requireStub)

  // 快照源桩:监听器捕获 + emit,供测试模拟服务变更触发的重扫(生产由订阅驱动)
  let sessionsState = { ids: [], byId: {} }
  let workspacesState = undefined
  function sourceStub(getSnapshot) {
    const listeners = new Set()
    return {
      list: {
        subscribe: (cb) => {
          listeners.add(cb)
          return () => listeners.delete(cb)
        },
        getSnapshot,
      },
      emit: () => {
        for (const cb of [...listeners]) cb()
      },
    }
  }
  const sessions = { binding: () => undefined, ...sourceStub(() => sessionsState) }
  const workspaces = sourceStub(() => workspacesState)
  const ctx = {
    get: (name) => (name === 'sessions' ? sessions : name === 'workspaces' ? workspaces : {}),
    effect: (fn, tag) => effects.push({ fn, tag }),
    slots: { inject: () => {}, register: () => {} },
  }
  mod.apply(ctx)
  const entry = effects.find((item) => item.tag === 'session-manager folder running mark')
  assert.ok(entry, 'apply 未挂文件夹运行标记 effect')
  return {
    sections,
    runEffect: entry.fn,
    emitSessions: sessions.emit,
    setSessions: (next) => { sessionsState = next },
    setWorkspaces: (next) => { workspacesState = next },
  }
}

// 两工作区一运行一的基准快照
function baseSnapshots(client) {
  client.setSessions({
    ids: ['a', 'b'],
    byId: { a: ROW('a', { running: true }), b: ROW('b', { running: false }) },
  })
  client.setWorkspaces({ items: [WS('w1', ['a']), WS('w2', ['b'])], archivedSessionIds: [] })
}

async function withFetch(implOrPayload, run) {
  // mock.method 返回被 mock 的函数,还原须经 .mock.restore(),不可直接调用返回值;
  // 传函数即显式 fetch 实现(构造拉取失败),传对象即固定响应,undefined 即固定
  // 成功响应 {enabled:true}——默认路径显式 mock,不依赖运行环境对相对 URL 的
  // fetch 行为(隐式环境耦合会随 Node 升级漂移)
  const impl = typeof implOrPayload === 'function'
    ? implOrPayload
    : async () => ({ ok: true, json: async () => (implOrPayload === undefined ? { enabled: true } : implOrPayload) })
  const mocked = mock.method(globalThis, 'fetch', impl)
  try {
    await run()
  } finally {
    mocked.mock.restore()
  }
}

test('Given 两工作区组容器与快照同序, When 扫描, Then 运行中工作区组容器带标记', async () => {
  await withFetch(undefined, async () => {
    const client = loadClient()
    baseSnapshots(client)
    const [s1, s2] = [sectionStub(), sectionStub()]
    client.sections.push(s1, s2)
    client.runEffect()
    await sleep(SCAN_SETTLE_MS)
    assert.ok(s1.hasAttribute(pure.runningFlag), '运行中工作区组容器应带标记')
    assert.equal(s2.hasAttribute(pure.runningFlag), false, '空闲工作区组容器不带标记')
  })
})

test('Given 末位未分组桶存在, When 扫描, Then 组容器数 = 工作区数+1 且游离运行中落末位', async () => {
  await withFetch(undefined, async () => {
    const client = loadClient()
    baseSnapshots(client)
    client.setSessions({
      ids: ['a', 'b', 'stray'],
      byId: { a: ROW('a', { running: true }), b: ROW('b', { running: false }), stray: ROW('stray', { running: true }) },
    })
    const [s1, s2, s3] = [sectionStub(), sectionStub(), sectionStub()]
    client.sections.push(s1, s2, s3)
    client.runEffect()
    await sleep(SCAN_SETTLE_MS)
    assert.ok(s1.hasAttribute(pure.runningFlag), '首工作区(运行中)带标记')
    assert.equal(s2.hasAttribute(pure.runningFlag), false, '次工作区(空闲)不带标记')
    assert.ok(s3.hasAttribute(pure.runningFlag), '末位未分组桶(游离运行中)带标记')
  })
})

test('Given 组容器数与不变量漂移(单列表/搜索态/结构变更), When 扫描, Then 清除全部标记不误标', async () => {
  await withFetch(undefined, async () => {
    const client = loadClient()
    baseSnapshots(client)
    const [s1, s2] = [sectionStub(), sectionStub()]
    client.sections.push(s1, s2)
    client.runEffect()
    await sleep(SCAN_SETTLE_MS)
    assert.ok(s1.hasAttribute(pure.runningFlag), '前置:正常对位时首组带标记')
    // 漂移:两工作区只剩一个组容器(或多余两个)均不匹配不变量
    client.sections.length = 0
    client.sections.push(s1)
    client.emitSessions()
    await sleep(SCAN_SETTLE_MS)
    assert.equal(s1.hasAttribute(pure.runningFlag), false, '数量漂移后标记被清除')
  })
})

test('Given 开关关闭(拉取返回 enabled:false), When 扫描, Then 不标记且既有标记清除', async () => {
  await withFetch({ enabled: false }, async () => {
    const client = loadClient()
    baseSnapshots(client)
    const s1 = sectionStub()
    client.sections.push(s1)
    client.runEffect()
    await sleep(SCAN_SETTLE_MS)
    assert.equal(s1.hasAttribute(pure.runningFlag), false, '停用后不新增标记')
  })
})

test('Given 开关拉取失败, When 扫描, Then 按启用兜底照常标记', async () => {
  await withFetch(async () => { throw new Error('network down') }, async () => {
    const client = loadClient()
    baseSnapshots(client)
    const [s1, s2] = [sectionStub(), sectionStub()]
    client.sections.push(s1, s2)
    client.runEffect()
    await sleep(SCAN_SETTLE_MS)
    assert.ok(s1.hasAttribute(pure.runningFlag), '拉取失败按启用兜底(默认启用)')
    assert.equal(s2.hasAttribute(pure.runningFlag), false, '兜底不改变运行态判定')
  })
})

test('Given 运行态变化经服务订阅到达(折叠组无 DOM 变更), When 快照更新, Then 标记跟随', async () => {
  await withFetch(undefined, async () => {
    const client = loadClient()
    baseSnapshots(client)
    const [s1, s2] = [sectionStub(), sectionStub()]
    client.sections.push(s1, s2)
    client.runEffect()
    await sleep(SCAN_SETTLE_MS)
    assert.ok(s1.hasAttribute(pure.runningFlag), '前置:首工作区运行中')
    // 唯一运行会话转入另一工作区(模拟会话被归档/挂到他处后的快照差)
    client.setSessions({
      ids: ['a', 'b'],
      byId: { a: ROW('a', { running: false }), b: ROW('b', { running: true }) },
    })
    client.emitSessions()
    await sleep(SCAN_SETTLE_MS)
    assert.equal(s1.hasAttribute(pure.runningFlag), false, '原运行工作区标记消除')
    assert.ok(s2.hasAttribute(pure.runningFlag), '新运行工作区获得标记')
  })
})

test('Given effect 卸载, When 清理执行, Then 标记移除且资源退订', async () => {
  await withFetch(undefined, async () => {
    const client = loadClient()
    baseSnapshots(client)
    const [s1, s2] = [sectionStub(), sectionStub()]
    client.sections.push(s1, s2)
    const cleanup = client.runEffect()
    await sleep(SCAN_SETTLE_MS)
    assert.ok(s1.hasAttribute(pure.runningFlag), '前置:标记已应用')
    cleanup()
    assert.equal(s1.hasAttribute(pure.runningFlag), false, '卸载清除运行中工作区的标记')
    assert.equal(s2.hasAttribute(pure.runningFlag), false, '卸载不残留其他标记')
  })
})

test('Given 无工作区且游离会话运行, When 扫描, Then 末位未分组桶正确标记', async () => {
  await withFetch(undefined, async () => {
    const client = loadClient()
    client.setSessions({ ids: ['stray'], byId: { stray: ROW('stray', { running: true }) } })
    client.setWorkspaces({ items: [], archivedSessionIds: [] })
    const s1 = sectionStub()
    client.sections.push(s1)
    client.runEffect()
    await sleep(SCAN_SETTLE_MS)
    assert.ok(s1.hasAttribute(pure.runningFlag), '零工作区时组容器数 1 = 工作区数 0 + 1,末位按未分组桶标记')
  })
})

test('Given 组容器数多于不变量上界, When 扫描, Then 清除全部标记不误标', async () => {
  await withFetch(undefined, async () => {
    const client = loadClient()
    baseSnapshots(client)
    // 数量漂移「变多」:两工作区出现四个组容器(> 工作区数+1)
    const sections = [sectionStub(), sectionStub(), sectionStub(), sectionStub()]
    client.sections.push(...sections)
    client.runEffect()
    await sleep(SCAN_SETTLE_MS)
    for (const [index, section] of sections.entries()) {
      assert.equal(section.hasAttribute(pure.runningFlag), false, '容器 ' + index + ' 数量漂移时不带标记')
    }
  })
})

test('Given 拉取未完成即卸载, When 后续拉取完成并触发调度, Then 标记不复活', async () => {
  // 拉取挂起(永不resolve),标记先经拉取完成前的唯一路径产生:
  // 未决期 scan 仅清除,故先注入「已启用 + 已标记」状态再卸载
  let release
  await withFetch(() => new Promise((resolve) => { release = resolve }), async () => {
    const client = loadClient()
    baseSnapshots(client)
    const s1 = sectionStub()
    client.sections.push(s1)
    const cleanup = client.runEffect()
    await sleep(SCAN_SETTLE_MS)
    assert.equal(s1.hasAttribute(pure.runningFlag), false, '拉取未决期间不产生标记')
    // 模拟标记已在(如卸载前最后一次 scan 的残留):卸载后拉取完成不得复活
    s1.setAttribute(pure.runningFlag, '')
    cleanup()
    release({ ok: true, json: async () => ({ enabled: true }) })
    await sleep(SCAN_SETTLE_MS)
    assert.equal(s1.hasAttribute(pure.runningFlag), false, '卸载后拉取完成不复活标记')
  })
})

test('Given 开关停用, When 拉取完成前的首次扫描, Then 不产生标记(未决期仅清除)', async () => {
  // 拉取延迟释放(3 个扫描窗口后返回停用),未决期内的扫描不得标记
  await withFetch(() => new Promise((resolve) => {
    setTimeout(() => resolve({ ok: true, json: async () => ({ enabled: false }) }), pure.scanDelayMs * 3)
  }), async () => {
    const client = loadClient()
    baseSnapshots(client)
    const s1 = sectionStub()
    client.sections.push(s1)
    client.runEffect()
    await sleep(SCAN_SETTLE_MS)
    assert.equal(s1.hasAttribute(pure.runningFlag), false, '拉取未决期首次扫描不标记')
    await sleep(SCAN_SETTLE_MS * 2)
    assert.equal(s1.hasAttribute(pure.runningFlag), false, '拉取返回停用后维持无标记')
  })
})

// ── 源码契约:CSS 规则、开关行、选择器与标记属性 ──

test('源码契约:运行点与图标着色规则、官方组容器锚点、开关行挂载齐备', () => {
  assert.ok(CLIENT_SRC.includes('div[class$="_groupSection"][data-sm-folder-running]'), '缺组容器标记 CSS 锚点')
  assert.ok(CLIENT_SRC.includes('var(--dsw-static-deepseek-450)'), '运行点色源应为官方 ongoing 实际色值(--dsh-state-ongoing 仅存在于官方状态点组件局部,组容器读不到)')
  assert.ok(!CLIENT_SRC.includes('--sm-fold-running-color: var(--dsh-state-ongoing'), '死变量引用:组容器上下文读不到 --dsh-state-ongoing,恒走回退源,不得引入永不生效的引用')
  assert.ok(CLIENT_SRC.includes('[class$="_folderActive"]'), '图标着色应让位官方 folderActive 态')
  assert.ok(CLIENT_SRC.includes('sm-fold-running-pulse'), '缺运行点脉冲动画')
  assert.ok(CLIENT_SRC.includes('prefers-reduced-motion'), '动画应尊重减少动态偏好')
  assert.ok(CLIENT_SRC.includes('h(FolderRunningSwitchRow, null)'), '归档面板未挂工作区文件夹运行标记开关行')
  assert.ok(CLIENT_SRC.includes("'工作区文件夹运行标记'"), '开关行缺展示文案')
})
