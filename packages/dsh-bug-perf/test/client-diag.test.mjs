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

function fakeClock() {
  let now = 0
  let nextId = 0
  const intervals = new Map()
  return {
    now: () => now,
    setInterval: (fn, ms) => { const id = ++nextId; intervals.set(id, { fn, every: ms, at: now + ms }); return id },
    clearInterval: (id) => { intervals.delete(id) },
    advance(ms) {
      const target = now + ms
      while (true) {
        const due = [...intervals.values()].map((timer) => timer.at).filter((at) => at <= target)
        if (due.length === 0) break
        now = Math.min(...due)
        for (const timer of intervals.values()) {
          if (timer.at <= now) {
            timer.at = now + timer.every
            timer.fn()
          }
        }
      }
      now = target
    },
    intervalCount: () => intervals.size,
  }
}

function fakeWindow(clock) {
  const fetchCalls = []
  const pendingProbes = []
  const win = {
    location: { pathname: '/chat' },
    performance: { memory: { usedJSHeapSize: 64 * 1024 * 1024 } },
    document: { querySelectorAll: () => ({ length: 42 }) },
    fetch: (url, options) => {
      fetchCalls.push({ url, options })
      return Promise.resolve({ ok: true })
    },
    setTimeout: (fn) => { pendingProbes.push({ fn, startedAt: clock.now() }); return pendingProbes.length },
    addEventListener: () => {},
  }
  return { win, fetchCalls, pendingProbes }
}

// Given 默认关闭, When 采样运行五分钟, Then 不发任何请求, 采样与阻塞探测仍工作
test('诊断_默认关闭_只采样不上报', () => {
  const plugin = loadPlugin()
  const clock = fakeClock()
  const { win, fetchCalls, pendingProbes } = fakeWindow(clock)
  const diag = plugin.__test.createDiag(clock)
  plugin.__test.startDiagSampling({ win, clock, diag, doc: win.document })
  const reporting = plugin.__test.startDiagReporting({
    win,
    clock,
    diag,
    options: { enabled: false, reportEvery: 12 },
  })
  clock.advance(5 * 60 * 1000)
  assert.equal(reporting.enabled, false)
  assert.equal(diag.enabled, false)
  assert.equal(fetchCalls.length, 0)
  assert.ok(diag.samples.length >= 60)
  clock.advance(plugin.__test.DIAG_PROBE_MS)
  const probe = pendingProbes.shift()
  assert.equal(typeof probe?.fn, 'function')
  clock.advance(plugin.__test.DIAG_BLOCK_MS + 1)
  probe.fn()
  assert.equal(typeof diag.blockedAt, 'number')
  assert.ok(diag.blockedMs >= plugin.__test.DIAG_BLOCK_MS)
})

// Given 开启, When 推进一个上报周期, Then 恰好一次请求且 payload 字段完整
test('诊断_开启_按周期上报', () => {
  const plugin = loadPlugin()
  const clock = fakeClock()
  const { win, fetchCalls } = fakeWindow(clock)
  const diag = plugin.__test.createDiag(clock)
  plugin.__test.startDiagSampling({ win, clock, diag, doc: win.document })
  const reporting = plugin.__test.startDiagReporting({ win, clock, diag, options: { enabled: true, reportEvery: 12 } })
  assert.equal(reporting.enabled, true)
  assert.equal(diag.enabled, true)
  clock.advance(12 * plugin.__test.DIAG_SAMPLE_MS - 1)
  assert.equal(fetchCalls.length, 0)
  clock.advance(1)
  assert.equal(fetchCalls.length, 1)
  const { url, options } = fetchCalls[0]
  assert.ok(url.startsWith('/api/dsh-bug-perf/diag?d='))
  assert.equal(options.keepalive, true)
  const payload = JSON.parse(decodeURIComponent(url.slice(url.indexOf('?d=') + 3)))
  assert.equal(typeof payload.at, 'number')
  assert.equal(payload.path, '/chat')
  assert.equal(typeof payload.totals.opened, 'number')
  assert.ok(Array.isArray(payload.last))
  assert.ok(Array.isArray(payload.longTasks))
  assert.ok(Array.isArray(payload.errors))
  assert.equal('blockedMs' in payload, true)
  assert.ok(payload.last.length > 0)
})

// Given reportEvery 改小, When 推进两个周期, Then 上报次数随周期增加
test('诊断_上报间隔_随配置变化', () => {
  const plugin = loadPlugin()
  const clock = fakeClock()
  const { win, fetchCalls } = fakeWindow(clock)
  const diag = plugin.__test.createDiag(clock)
  plugin.__test.startDiagSampling({ win, clock, diag, doc: win.document })
  plugin.__test.startDiagReporting({ win, clock, diag, options: { enabled: true, reportEvery: 2 } })
  clock.advance(2 * plugin.__test.DIAG_SAMPLE_MS)
  assert.equal(fetchCalls.length, 1)
  clock.advance(2 * plugin.__test.DIAG_SAMPLE_MS)
  assert.equal(fetchCalls.length, 2)
})

// Given fetch 缺失或抛错, When 到达上报点, Then 静默跳过且不抛
test('诊断_上报失败_静默', () => {
  const plugin = loadPlugin()
  const clock = fakeClock()
  const missing = fakeWindow(clock)
  delete missing.win.fetch
  const missingDiag = plugin.__test.createDiag(clock)
  plugin.__test.startDiagSampling({ win: missing.win, clock, diag: missingDiag, doc: missing.win.document })
  plugin.__test.startDiagReporting({ win: missing.win, clock, diag: missingDiag, options: { enabled: true, reportEvery: 1 } })
  assert.doesNotThrow(() => clock.advance(plugin.__test.DIAG_SAMPLE_MS))

  const throwing = fakeWindow(clock)
  throwing.win.fetch = () => { throw new Error('fetch boom') }
  const throwingDiag = plugin.__test.createDiag(clock)
  plugin.__test.startDiagSampling({ win: throwing.win, clock, diag: throwingDiag, doc: throwing.win.document })
  plugin.__test.startDiagReporting({ win: throwing.win, clock, diag: throwingDiag, options: { enabled: true, reportEvery: 1 } })
  assert.doesNotThrow(() => clock.advance(plugin.__test.DIAG_SAMPLE_MS))
})

// Given fetch 返回拒绝或非 2xx, When 到达上报点, Then 不产生未处理异常
test('诊断_上报异步失败_静默', async () => {
  const plugin = loadPlugin()
  const clock = fakeClock()
  const rejecting = fakeWindow(clock)
  rejecting.win.fetch = () => Promise.reject(new Error('fetch rejected'))
  const rejectingDiag = plugin.__test.createDiag(clock)
  plugin.__test.startDiagSampling({ win: rejecting.win, clock, diag: rejectingDiag, doc: rejecting.win.document })
  plugin.__test.startDiagReporting({ win: rejecting.win, clock, diag: rejectingDiag, options: { enabled: true, reportEvery: 1 } })
  assert.doesNotThrow(() => clock.advance(plugin.__test.DIAG_SAMPLE_MS))
  await Promise.resolve()

  const notOk = fakeWindow(clock)
  notOk.win.fetch = () => Promise.resolve({ ok: false })
  const notOkDiag = plugin.__test.createDiag(clock)
  plugin.__test.startDiagSampling({ win: notOk.win, clock, diag: notOkDiag, doc: notOk.win.document })
  plugin.__test.startDiagReporting({ win: notOk.win, clock, diag: notOkDiag, options: { enabled: true, reportEvery: 1 } })
  assert.doesNotThrow(() => clock.advance(plugin.__test.DIAG_SAMPLE_MS))
  await Promise.resolve()
})
