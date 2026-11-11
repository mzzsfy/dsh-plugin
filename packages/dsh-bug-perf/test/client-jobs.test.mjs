import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const source = readFileSync(new URL('../src/client.js', import.meta.url), 'utf8')

function loadPlugin() {
  let registered
  const window = { __ModuleLoader__: { load: (entry) => { registered = entry } } }
  new Function('window', source)(window)
  return registered.factory(() => { throw new Error('no modules') })
}

function fakeJobs() {
  const watched = []
  const released = []
  return {
    watched,
    released,
    watchRows(sessionId) {
      watched.push(sessionId)
      return () => released.push(sessionId)
    },
  }
}

function fakeDoc() {
  const listeners = new Map()
  return {
    addEventListener(type, listener) { listeners.set(type, listener) },
    removeEventListener(type) { listeners.delete(type) },
    clickOn(sessionId) {
      const target = { closest: (selector) => (selector === '[data-row-key]' ? { getAttribute: () => `session:${sessionId}` } : null) }
      listeners.get('click')?.({ target })
    },
    clickOnBlank() {
      listeners.get('click')?.({ target: { closest: () => null } })
    },
  }
}

// 归档集合变化换新快照对象并保持同对象身份稳定: 包装按快照身份缓存解析结果
const fakeWorkspaces = (archivedSessionIds = []) => {
  let snapshot = { phase: 'ready', archivedSessionIds }
  const listeners = new Set()
  const publish = () => { for (const listener of [...listeners]) listener() }
  return {
    list: {
      getSnapshot: () => snapshot,
      subscribe(listener) {
        listeners.add(listener)
        return () => listeners.delete(listener)
      },
    },
    archive(ids) {
      snapshot = { phase: 'ready', archivedSessionIds: [...ids] }
      publish()
    },
    pending() { snapshot = { phase: 'pending', archivedSessionIds: [] } },
    breakSnapshot() { snapshot = { phase: 'ready', archivedSessionIds: undefined } },
    listeners: () => listeners.size,
  }
}

// uiSession.isMain: 当前主视图显示的会话
const fakeUiSession = (currentIds = []) => {
  const ids = new Set(currentIds)
  return {
    isMain: (sessionId) => ids.has(String(sessionId)),
    setCurrent(sessionId) {
      ids.clear()
      if (sessionId !== undefined) ids.add(String(sessionId))
    },
  }
}

const throwingWorkspaces = {
  get list() {
    throw new Error('workspaces unavailable')
  },
}

// s1..s6 未归档;s7 与子 agent 会话 c1..c3 已归档
const ARCHIVED = ['c1', 'c2', 'c3', 's7']

const install = ({ jobs = fakeJobs(), workspaces = fakeWorkspaces(ARCHIVED), uiSession = fakeUiSession(), doc = fakeDoc(), options = {} } = {}) => {
  const plugin = loadPlugin()
  const result = plugin.__test.installJobStreamLimit({
    jobs,
    workspacesOf: () => workspaces,
    uiSessionOf: () => uiSession,
    doc,
    options: { enabled: true, base: 3, max: 5, ...options },
  })
  return { plugin, jobs, doc, workspaces, uiSession, result }
}

// Given 未归档会话数量未到默认窗口, When 逐行订阅, Then 都建立流
test('任务流_未归档会话_窗口内放行', () => {
  const { jobs, result } = install()
  for (const id of ['s1', 's2', 's3']) jobs.watchRows(id)
  assert.deepEqual(jobs.watched, ['s1', 's2', 's3'])
  assert.equal(result.state.windowUsed, 3)
  assert.equal(result.state.rejected, 0)
})

// Given 默认窗口已满, When 第 4 个未归档会话订阅, Then 拒绝且不建流
test('任务流_未归档会话_超出窗口拒绝', () => {
  const { jobs, result } = install()
  for (const id of ['s1', 's2', 's3', 's4']) jobs.watchRows(id)
  assert.deepEqual(jobs.watched, ['s1', 's2', 's3'])
  assert.equal(result.state.windowUsed, 3)
  assert.equal(result.state.rejected, 1)
  assert.equal(result.state.rejectedArchived, 0)
})

// Given 会话已归档, When 它被自动订阅, Then 不占窗口, 窗口额度留给未归档会话
test('任务流_归档会话_不占窗口', () => {
  const { jobs, result } = install()
  jobs.watchRows('s7')
  for (const id of ['s1', 's2', 's3']) jobs.watchRows(id)
  assert.deepEqual(jobs.watched, ['s1', 's2', 's3'])
  assert.equal(result.state.windowUsed, 3)
  assert.equal(result.state.rejectedArchived, 1)
  assert.equal(result.state.archived, ARCHIVED.length)
})

// Given 子 agent 会话未归档, When 它被订阅, Then 与主会话同等放行(归档才是排除依据)
test('任务流_未归档子会话_放行', () => {
  const { jobs, result } = install({ workspaces: fakeWorkspaces(['s7']) })
  for (const id of ['c1', 's1', 's2']) jobs.watchRows(id)
  assert.deepEqual(jobs.watched, ['c1', 's1', 's2'])
  assert.equal(result.state.rejected, 0)
})

// Given 默认窗口已满, When 当前视图的会话订阅, Then 仍然放行且不占窗口
test('任务流_当前视图会话_窗口满也放行', () => {
  const { jobs, uiSession, result } = install()
  for (const id of ['s1', 's2', 's3']) jobs.watchRows(id)
  uiSession.setCurrent('s9')
  jobs.watchRows('s9')
  assert.deepEqual(jobs.watched, ['s1', 's2', 's3', 's9'])
  assert.equal(result.state.current, 1)
  assert.equal(result.state.windowUsed, 3)
  assert.equal(result.state.active, 4)
})

// Given 当前视图的会话已归档, When 它订阅, Then 仍按当前视图放行(当前视图优先于归档判定)
test('任务流_当前视图会话_归档也放行', () => {
  const { jobs, uiSession, result } = install()
  uiSession.setCurrent('c1')
  jobs.watchRows('c1')
  assert.deepEqual(jobs.watched, ['c1'])
  assert.equal(result.state.rejectedArchived, 0)
  assert.equal(result.state.windowUsed, 0)
  assert.equal(result.state.current, 1)
})

// Given 点击已归档会话, When 窗口已满, Then 仍然为它建立流, 且不计入归档拒绝与窗口额度
test('任务流_点击归档会话_放行', () => {
  const { jobs, doc, result } = install()
  for (const id of ['s1', 's2', 's3']) jobs.watchRows(id)
  doc.clickOn('c1')
  assert.ok(jobs.watched.includes('c1'))
  assert.equal(result.state.clicked, 1)
  assert.equal(result.state.rejectedArchived, 0)
  assert.equal(result.state.windowUsed, 3)
})

// Given 点击的未归档会话不在窗口内, When 点击, Then 同样放行
test('任务流_点击未归档会话_放行', () => {
  const { jobs, doc, result } = install()
  for (const id of ['s1', 's2', 's3']) jobs.watchRows(id)
  doc.clickOn('s6')
  assert.ok(jobs.watched.includes('s6'))
  assert.equal(result.state.windowUsed, 3)
})

// Given 点击的会话已占窗口, When 点击, Then 转为点击放行并让出窗口额度
test('任务流_点击窗口内会话_让出额度', () => {
  const { jobs, doc, result } = install()
  for (const id of ['s1', 's2', 's3']) jobs.watchRows(id)
  doc.clickOn('s1')
  assert.equal(result.state.windowUsed, 2)
  assert.equal(result.state.clicked, 0)
  jobs.watchRows('s4')
  assert.deepEqual(jobs.watched, ['s1', 's2', 's3', 's4'])
  assert.equal(result.state.windowUsed, 3)
})

// Given 总数已到上限, When 再点击一个会话, Then 淘汰最老的一条并回收它的窗口额度, 总数不变
test('任务流_达到上限_淘汰最老', () => {
  const { jobs, doc, result } = install()
  for (const id of ['s1', 's2', 's3']) jobs.watchRows(id)
  doc.clickOn('c1')
  doc.clickOn('c2')
  assert.equal(result.state.active, 5)
  const watchedBefore = jobs.watched.length
  doc.clickOn('c3')
  assert.equal(jobs.watched.length, watchedBefore + 1)
  assert.deepEqual(jobs.released, ['s1'])
  assert.equal(result.state.active, 5)
  assert.equal(result.state.windowUsed, 2)
  assert.equal(result.state.evicted, 1)
})

// Given 当前视图的会话已占窗口, When 总数到上限后又加入一条, Then 淘汰跳过它
test('任务流_达到上限_跳过当前视图会话', () => {
  const { jobs, doc, uiSession, result } = install()
  for (const id of ['s1', 's2', 's3']) jobs.watchRows(id)
  uiSession.setCurrent('s1')
  doc.clickOn('c1')
  doc.clickOn('c2')
  assert.equal(result.state.active, 5)
  doc.clickOn('c3')
  assert.deepEqual(jobs.released, ['s2'])
  assert.ok(jobs.watched.includes('s1'))
  assert.equal(result.state.windowUsed, 1)
})

// Given 窗口内某行成为当前视图, When 再订阅一条未归档会话, Then 额度已按当前视图让出, 直接放行
test('任务流_当前视图让出窗口额度', () => {
  const { jobs, uiSession, result } = install()
  for (const id of ['s1', 's2', 's3']) jobs.watchRows(id)
  assert.equal(result.state.windowUsed, 3)
  uiSession.setCurrent('s1')
  assert.equal(result.state.windowUsed, 2)
  jobs.watchRows('s4')
  assert.deepEqual(jobs.watched, ['s1', 's2', 's3', 's4'])
  assert.equal(result.state.windowUsed, 3)
})

// Given 点击放行的条目比窗口条目更早加入, When 需要淘汰, Then 先淘汰窗口条目
test('任务流_达到上限_优先淘汰窗口条目', () => {
  const { jobs, doc, result } = install()
  doc.clickOn('c1')
  for (const id of ['s1', 's2', 's3']) jobs.watchRows(id)
  doc.clickOn('c2')
  assert.equal(result.state.active, 5)
  doc.clickOn('c3')
  assert.deepEqual(jobs.released, ['s1'])
  assert.ok(jobs.watched.includes('c1'))
})

// Given 已准入若干会话, When 读 state.keys, Then 按准入顺序列出当前持有的流
test('任务流_准入键列表_按顺序与移除同步', () => {
  const { jobs, doc, result } = install()
  const release = jobs.watchRows('s1')
  jobs.watchRows('s2')
  doc.clickOn('c1')
  assert.deepEqual(result.state.keys, ['s1', 's2', 'c1'])
  release()
  assert.deepEqual(result.state.keys, ['s2', 'c1'])
})

// Given 点击的非会话行, When 点击, Then 不订阅任何流
test('任务流_点击非会话行_忽略', () => {
  const { jobs, doc, result } = install()
  doc.clickOnBlank()
  assert.deepEqual(jobs.watched, [])
  assert.equal(result.state.clicked, 0)
})

// Given 已放行的行被消费方释放, When 再订阅新会话, Then 回收的额度可继续放行
test('任务流_释放后额度回收', () => {
  const { jobs, result } = install()
  for (const id of ['s1', 's2']) jobs.watchRows(id)
  const release = jobs.watchRows('s3')
  assert.equal(result.state.windowUsed, 3)
  release()
  assert.equal(result.state.windowUsed, 2)
  jobs.watchRows('s4')
  assert.deepEqual(jobs.watched, ['s1', 's2', 's3', 's4'])
})

// Given 同一释放函数被调用两次, When 重复释放, Then 额度只扣一次
test('任务流_重复释放_只扣一次', () => {
  const { jobs, result } = install()
  const release = jobs.watchRows('s1')
  release()
  release()
  assert.equal(result.state.windowUsed, 0)
  assert.equal(result.state.active, 0)
  assert.deepEqual(jobs.released, ['s1'])
})

// Given 重复调用注册逻辑, When 已安装, Then 不再包装第二次
test('任务流_重复安装_幂等', () => {
  const { jobs, result } = install()
  const plugin = loadPlugin()
  const second = plugin.__test.installJobStreamLimit({
    jobs,
    workspacesOf: () => fakeWorkspaces(ARCHIVED),
    uiSessionOf: () => fakeUiSession(),
    doc: fakeDoc(),
    options: { enabled: true, base: 3, max: 5 },
  })
  assert.equal(result.installed, true)
  assert.deepEqual(second, { installed: false, reason: 'already installed' })
})

// Given 宿主没有 jobs 服务, When 安装, Then 干净跳过
test('任务流_服务缺失_跳过', () => {
  const plugin = loadPlugin()
  const result = plugin.__test.installJobStreamLimit({ jobs: undefined, workspacesOf: () => fakeWorkspaces(ARCHIVED), uiSessionOf: () => fakeUiSession(), doc: fakeDoc(), options: { enabled: true, base: 3, max: 5 } })
  assert.deepEqual(result, { installed: false, reason: 'jobs unavailable' })
})

// Given 归档快照缺失, When 订阅, Then 按未归档处理, 只受默认窗口约束
test('任务流_归档快照缺失_按未归档处理', () => {
  const { jobs, result } = install({ workspaces: null })
  for (const id of ['c1', 's1', 's2']) jobs.watchRows(id)
  assert.deepEqual(jobs.watched, ['c1', 's1', 's2'])
  assert.equal(result.state.rejectedArchived, 0)
})

// Given 归档快照尚未就绪(phase 未 ready), When 订阅, Then 不当权威空集, 仍按未归档判定
test('任务流_归档快照未就绪_按未归档处理', () => {
  const workspaces = fakeWorkspaces([])
  workspaces.pending()
  const { jobs, result } = install({ workspaces })
  for (const id of ['s1', 's2', 's3']) jobs.watchRows(id)
  assert.deepEqual(jobs.watched, ['s1', 's2', 's3'])
  assert.equal(result.state.archived, 0)
})

// Given 归档快照读取抛错, When 订阅, Then 不打断调用方, 按未归档放行
test('任务流_归档快照读取抛错_按未归档处理', () => {
  const { jobs, result } = install({ workspaces: throwingWorkspaces })
  for (const id of ['s1', 's2']) jobs.watchRows(id)
  assert.deepEqual(jobs.watched, ['s1', 's2'])
  assert.equal(result.state.rejected, 0)
})

// Given 归档快照形状异常(缺少 archivedSessionIds 数组), When 订阅, Then 按空集处理并放行
test('任务流_归档集合形状异常_按空集处理', () => {
  const workspaces = fakeWorkspaces([])
  workspaces.breakSnapshot()
  const { jobs, result } = install({ workspaces })
  for (const id of ['s1', 's2']) jobs.watchRows(id)
  assert.deepEqual(jobs.watched, ['s1', 's2'])
  assert.equal(result.state.rejected, 0)
})

// Given 已放行的会话随后被归档, When 归档集合变化后再次订阅, Then 回收它的流与窗口额度
test('任务流_归档集合变化_回收已归档条目', () => {
  const workspaces = fakeWorkspaces([])
  const { jobs, result } = install({ workspaces })
  for (const id of ['s1', 's2']) jobs.watchRows(id)
  workspaces.archive(['s1'])
  jobs.watchRows('s3')
  assert.deepEqual(jobs.released, ['s1'])
  assert.equal(result.state.reclaimed, 1)
  assert.equal(result.state.windowUsed, 2)
  assert.deepEqual(jobs.watched, ['s1', 's2', 's3'])
})

// Given 归档会话由点击放行, When 归档集合变化, Then 该条目保留(点击放行的流不被回收)
test('任务流_归档集合变化_点击放行保留', () => {
  const workspaces = fakeWorkspaces(['c1'])
  const { jobs, doc, result } = install({ workspaces })
  for (const id of ['s1', 's2']) jobs.watchRows(id)
  doc.clickOn('c1')
  workspaces.archive(['c1', 's1'])
  jobs.watchRows('s3')
  assert.equal(result.state.reclaimed, 1)
  assert.deepEqual(jobs.released, ['s1'])
  assert.ok(jobs.watched.includes('c1'))
})

// Given 已放行的会话随后被归档, When 归档模型推送变化, Then 不等下一次订阅就回收流与额度
test('任务流_归档推送_即时回收', async () => {
  const workspaces = fakeWorkspaces([])
  const { jobs, result } = install({ workspaces })
  for (const id of ['s1', 's2']) jobs.watchRows(id)
  workspaces.archive(['s1'])
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.deepEqual(jobs.released, ['s1'])
  assert.equal(result.state.reclaimed, 1)
  assert.equal(result.state.windowUsed, 1)
})

// Given 安装后卸载, When 卸载, Then 退订归档推送
test('任务流_卸载_退订归档推送', () => {
  const workspaces = fakeWorkspaces([])
  const { jobs, result } = install({ workspaces })
  jobs.watchRows('s1')
  assert.equal(workspaces.listeners(), 1)
  result.dispose()
  assert.equal(workspaces.listeners(), 0)
})

// Given 归档会话取消归档, When 重新订阅, Then 按未归档放行
test('任务流_取消归档后重新订阅_放行', () => {
  const workspaces = fakeWorkspaces([])
  const { jobs, result } = install({ workspaces })
  workspaces.archive(['s1'])
  jobs.watchRows('s1')
  assert.equal(result.state.rejectedArchived, 1)
  workspaces.archive([])
  jobs.watchRows('s1')
  assert.deepEqual(jobs.watched, ['s1'])
  assert.equal(result.state.windowUsed, 1)
})

// Given 同一会话被多个消费方订阅, When 重复订阅, Then 只建一条流, 释放全部后才回收
test('任务流_重复订阅_只建一条', () => {
  const { jobs, result } = install()
  const first = jobs.watchRows('s1')
  jobs.watchRows('s1')
  assert.deepEqual(jobs.watched, ['s1'])
  first()
  assert.equal(result.state.active, 1)
  assert.equal(result.state.windowUsed, 1)
})

// Given 当前视图会话被重复订阅, When 重复调用, Then 定向放行计数不重复增加
test('任务流_当前视图会话_重复订阅不重复计数', () => {
  const { jobs, uiSession, result } = install()
  uiSession.setCurrent('s1')
  jobs.watchRows('s1')
  jobs.watchRows('s1')
  assert.equal(result.state.current, 1)
  assert.equal(result.state.active, 1)
})

// Given 安装后卸载, When 卸载, Then 释放全部流且不再计数
test('任务流_卸载_释放全部流', () => {
  const { jobs, result } = install()
  for (const id of ['s1', 's2']) jobs.watchRows(id)
  result.dispose()
  assert.deepEqual(jobs.released, ['s1', 's2'])
  assert.equal(result.state.active, 0)
  assert.equal(result.state.windowUsed, 0)
  assert.deepEqual(jobs.watched, ['s1', 's2'])
})

// Given 客户端装载逻辑, When 接线, Then 准入判定读取 workspaces 与 uiSession 官方服务
test('任务流_装载接线_读取官方服务', () => {
  assert.match(source, /workspacesOf: \(\) => ctx\.get\?\.\('workspaces'\)/)
  assert.match(source, /uiSessionOf: \(\) => ctx\.get\?\.\('uiSession'\)/)
})
