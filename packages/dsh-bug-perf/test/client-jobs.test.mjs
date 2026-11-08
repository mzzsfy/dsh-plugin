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

const fakeSessions = (summaries) => {
  const snapshot = { byId: Object.fromEntries(summaries.map((item) => [item.sessionId, item])) }
  return { list: { getSnapshot: () => snapshot } }
}

// s1..s9 是主会话, c1..c3 是 s1 的子 agent 会话
const SESSIONS = fakeSessions([
  { sessionId: 's1' },
  { sessionId: 'c1', origin: 'subagent', parentSessionId: 's1' },
  { sessionId: 'c2', origin: 'subagent', parentSessionId: 's1' },
  { sessionId: 'c3', origin: 'subagent', parentSessionId: 's1' },
  { sessionId: 's2' },
  { sessionId: 's3' },
  { sessionId: 's4' },
  { sessionId: 's5' },
  { sessionId: 's6' },
])

const install = ({ jobs = fakeJobs(), sessions = SESSIONS, doc = fakeDoc(), options = {} } = {}) => {
  const plugin = loadPlugin()
  const result = plugin.__test.installJobStreamLimit({
    jobs,
    sessionsOf: () => sessions,
    doc,
    options: { enabled: true, base: 3, max: 5, ...options },
  })
  return { plugin, jobs, doc, result }
}

// Given 主会话数量未到默认窗口, When 列表逐行订阅, Then 都建立流
test('任务流_主会话_窗口内放行', () => {
  const { jobs, result } = install()
  for (const id of ['s1', 's2', 's3']) jobs.watchRows(id)
  assert.deepEqual(jobs.watched, ['s1', 's2', 's3'])
  assert.equal(result.state.main, 3)
  assert.equal(result.state.rejected, 0)
})

// Given 默认窗口已满, When 第 4 个主会话订阅, Then 拒绝且不建流
test('任务流_主会话_超出窗口拒绝', () => {
  const { jobs, result } = install()
  for (const id of ['s1', 's2', 's3', 's4']) jobs.watchRows(id)
  assert.deepEqual(jobs.watched, ['s1', 's2', 's3'])
  assert.equal(result.state.rejected, 1)
})

// Given 默认窗口还有空位, When 子 agent 会话自动订阅, Then 不占用窗口
test('任务流_子会话_不占窗口', () => {
  const { jobs, result } = install()
  jobs.watchRows('c1')
  jobs.watchRows('s1')
  jobs.watchRows('s2')
  jobs.watchRows('s3')
  assert.deepEqual(jobs.watched, ['s1', 's2', 's3'])
  assert.equal(result.state.subagent, 0)
  assert.equal(result.state.rejected, 1)
})

// Given 点击子 agent 会话, When 窗口已满, Then 仍然为它建立流
test('任务流_点击子会话_放行', () => {
  const { jobs, doc, result } = install()
  for (const id of ['s1', 's2', 's3']) jobs.watchRows(id)
  doc.clickOn('c1')
  assert.ok(jobs.watched.includes('c1'))
  assert.equal(result.state.subagent, 1)
  assert.equal(result.state.clicked, 1)
})

// Given 点击的主会话不在窗口内, When 点击, Then 同样放行
test('任务流_点击主会话_放行', () => {
  const { jobs, doc } = install()
  for (const id of ['s1', 's2', 's3']) jobs.watchRows(id)
  doc.clickOn('s6')
  assert.ok(jobs.watched.includes('s6'))
})

// Given 总数已到上限, When 再点击一个会话, Then 淘汰最老的一条, 总数不变
test('任务流_达到上限_淘汰最老', () => {
  const { jobs, doc, result } = install()
  for (const id of ['s1', 's2', 's3']) jobs.watchRows(id)
  doc.clickOn('c1')
  doc.clickOn('c2')
  assert.equal(result.state.main + result.state.subagent, 5)
  const watchedBefore = jobs.watched.length
  doc.clickOn('c3')
  assert.equal(jobs.watched.length, watchedBefore + 1)
  assert.deepEqual(jobs.released, ['s1'])
  assert.equal(result.state.evicted, 1)
  assert.equal(result.state.main + result.state.subagent, 5)
})

// Given 点击的行已经在窗口内, When 点击, Then 不重复建流, 只标记
test('任务流_点击已在窗口_不重复建流', () => {
  const { jobs, doc, result } = install()
  jobs.watchRows('s1')
  const before = jobs.watched.length
  doc.clickOn('s1')
  assert.equal(jobs.watched.length, before)
  assert.equal(result.state.clicked, 0)
})

// Given 点击了非会话行, When 触发点击, Then 忽略
test('任务流_点击非会话行_忽略', () => {
  const { jobs, doc } = install()
  doc.clickOnBlank()
  assert.deepEqual(jobs.watched, [])
})

// Given 行组件卸载, When 调用释放, Then 额度回收, 新的主会话可以进入窗口
test('任务流_释放后_额度回收', () => {
  const { jobs, result } = install()
  const release = jobs.watchRows('s1')
  jobs.watchRows('s2')
  jobs.watchRows('s3')
  jobs.watchRows('s4')
  assert.equal(result.state.rejected, 1)
  release()
  jobs.watchRows('s4')
  assert.deepEqual(jobs.watched, ['s1', 's2', 's3', 's4'])
  assert.equal(result.state.main, 3)
})

// Given 同一行重复释放, When 调用两次, Then 只扣一次
test('任务流_重复释放_只扣一次', () => {
  const { jobs, result } = install()
  const release = jobs.watchRows('s1')
  release()
  release()
  assert.equal(result.state.main, 0)
  assert.deepEqual(jobs.released, ['s1'])
})

// Given 包装已安装, When 再次安装, Then 幂等
test('任务流_重复安装_幂等', () => {
  const { jobs, plugin } = install()
  const second = plugin.__test.installJobStreamLimit({ jobs, sessionsOf: () => SESSIONS, doc: fakeDoc(), options: { enabled: true, base: 3, max: 5 } })
  assert.equal(second.installed, false)
  assert.equal(second.reason, 'already installed')
})

// Given 宿主没有 jobs 服务, When 安装, Then 跳过并记录原因
test('任务流_服务缺失_跳过', () => {
  const plugin = loadPlugin()
  const result = plugin.__test.installJobStreamLimit({ jobs: undefined, sessionsOf: () => SESSIONS, doc: fakeDoc(), options: { enabled: true, base: 3, max: 5 } })
  assert.equal(result.installed, false)
  assert.equal(result.reason, 'jobs unavailable')
})

// Given 会话摘要尚未就绪, When 订阅, Then 按主会话处理, 不误判为子会话
test('任务流_摘要缺失_按主会话处理', () => {
  const { jobs, result } = install({ sessions: null })
  jobs.watchRows('s1')
  jobs.watchRows('s2')
  jobs.watchRows('c1')
  jobs.watchRows('s4')
  assert.deepEqual(jobs.watched, ['s1', 's2', 'c1'])
  assert.equal(result.state.rejected, 1)
})

// Given 子会话已被点击放行, When 该会话从摘要里变为普通会话, Then 不重复建流
test('任务流_重复订阅同一会话_只建一次', () => {
  const { jobs, doc } = install()
  doc.clickOn('c1')
  jobs.watchRows('c1')
  jobs.watchRows('c1')
  assert.deepEqual(jobs.watched, ['c1'])
})

// Given 补丁卸载, When 调用 dispose, Then 所有流被释放且点击监听移除
test('任务流_卸载_释放全部流', () => {
  const { jobs, doc, result } = install()
  jobs.watchRows('s1')
  jobs.watchRows('s2')
  doc.clickOn('c1')
  result.dispose()
  assert.deepEqual(jobs.released.sort(), ['c1', 's1', 's2'])
  doc.clickOn('s5')
  assert.equal(jobs.watched.length, 3)
})
