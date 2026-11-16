// 真实 apply 探针:设置重建打断在途扫描时,新代必须能重新接管旧代登记/物化的会话。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { apply, __test } from '../src/index.js'

function createClock(start = 1_000_000) {
  let now = start
  let nextId = 0
  const timers = new Map()
  return {
    timers,
    now: () => now,
    setTimeout(fn, ms) {
      const id = (nextId += 1)
      timers.set(id, { fn, ms })
      return id
    },
    clearTimeout(id) {
      timers.delete(id)
    },
    async runNext() {
      const [id, timer] = timers.entries().next().value
      timers.delete(id)
      now += timer.ms
      await timer.fn()
      return timer.ms
    },
    advance(ms) {
      now += ms
    },
  }
}

const events = [
  { seq: 1, time: 1_000_000, type: 'turn/start', data: { turn: 1 } },
  {
    seq: 2,
    time: 1_000_000,
    type: 'assistant/message',
    data: { turn: 1, step: 1, message: { role: 'assistant', content: [{ type: 'text', text: '还没结案' }] }, stream: [] },
  },
]

const observation = () => ({ header: { id: 's1' }, events, [Symbol.dispose]() {} })

function createHarness(hooks = {}, shared = {}) {
  const home = shared.home ?? mkdtempSync(join(tmpdir(), 'keep-working-generation-'))
  const clock = shared.clock ?? createClock()
  const effects = []
  const listeners = new Map()
  const agents = shared.agents ?? new Map()
  const followups = shared.followups ?? []
  const state = shared.state ?? { observeCalls: 0, resumeCalls: 0, listCalls: 0, statCalls: 0 }

  const makeAgent = () => ({
    followup(message) {
      if (hooks.followup !== undefined) return hooks.followup(message, state)
      followups.push(message)
    },
    steer(message) {
      if (hooks.followup !== undefined) return hooks.followup(message, state)
      followups.push(message)
    },
  })
  const persistence = typeof hooks.sessionPersistence === 'function'
    ? hooks.sessionPersistence({ state })
    : hooks.sessionPersistence
  const pushEffect = (factory) => {
    const dispose = factory()
    if (typeof dispose === 'function') effects.push(dispose)
    return dispose
  }
  const ctx = {
    logger: { info() {}, warn() {}, error() {} },
    agents: {
      get: (sessionId) => agents.get(sessionId),
      resume: async (args) => {
        state.resumeCalls += 1
        if (hooks.resume !== undefined) return hooks.resume(args, { agents, makeAgent, state })
        agents.set(args.resumeSessionId, makeAgent())
        return undefined
      },
      list: () => [...agents.keys()],
    },
    on: (event, handler) => {
      listeners.set(event, handler)
      return () => { if (listeners.get(event) === handler) listeners.delete(event) }
    },
    effect: pushEffect,
    fiber: { state: 2 },
    get(name) {
      if (name === 'sessionQuery') {
        return {
          listSessions: async () => {
            state.listCalls += 1
            if (hooks.listSessions !== undefined) return hooks.listSessions({ state })
            return [{ header: { id: 's1' }, events }]
          },
          observeSession: async (sessionId) => {
            state.observeCalls += 1
            if (hooks.observe !== undefined) return hooks.observe({ state, sessionId })
            return observation()
          },
        }
      }
      if (name === 'sessionPersistence') return persistence
      if (name === 'workspaceRegistry') return { archivedSessionIds: [] }
      if (name === 'systemPrompt') return hooks.systemPrompt
      return undefined
    },
    inject: (names, callback) => {
      callback({
        effect: pushEffect,
        on: () => () => {},
        settings: undefined,
        tools: { register: () => () => {} },
        webServer: { register: () => () => {} },
      })
    },
  }

  return {
    state,
    followups,
    clock,
    listeners,
    home,
    ctx,
    async start(config = {}) {
      await apply(ctx, { scanOnBoot: true, freshMs: 120_000, ...config })
    },
    dispose() {
      for (const dispose of effects.reverse()) {
        try { dispose?.() } catch {}
      }
      effects.length = 0
    },
  }
}

async function withGlobals(harness, fn) {
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = harness.home
  const realSetTimeout = globalThis.setTimeout
  const realClearTimeout = globalThis.clearTimeout
  const realNow = Date.now
  globalThis.setTimeout = harness.clock.setTimeout
  globalThis.clearTimeout = harness.clock.clearTimeout
  Date.now = harness.clock.now
  try {
    return await fn()
  } finally {
    harness.dispose()
    globalThis.setTimeout = realSetTimeout
    globalThis.clearTimeout = realClearTimeout
    Date.now = realNow
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
  }
}

test('设置重建打断观察在途: 新代重新扫描并恢复同一会话', async () => {
  let resolveObserve
  let observeStarted
  const observeStartedPromise = new Promise((resolve) => { observeStarted = resolve })
  const pendingObservation = new Promise((resolve) => { resolveObserve = resolve })
  const harness = createHarness({
    observe: () => {
      observeStarted()
      return pendingObservation
    },
  })
  await withGlobals(harness, async () => {
    await harness.start()
    const firstScan = harness.clock.runNext()
    await observeStartedPromise
    harness.listeners.get('loader/volatile-update')()
    await Promise.resolve()
    resolveObserve(observation())
    await firstScan

    assert.equal(harness.clock.timers.size > 0, true, '新代必须重新排启动扫描')
    await harness.clock.runNext()
    assert.equal(harness.state.observeCalls, 2, '新代不得沿用旧代 seen 短路')
    assert.equal(harness.state.resumeCalls, 1)
    assert.equal(harness.followups.length, 1)
  })
})

test('设置重建打断 resume 在途: 已物化 agent 由新代补投恢复消息', async () => {
  let resolveResume
  let resumeStarted
  const resumeStartedPromise = new Promise((resolve) => { resumeStarted = resolve })
  const harness = createHarness({
    resume: (args, { agents, makeAgent }) => new Promise((resolve) => {
      resumeStarted()
      resolveResume = () => {
        agents.set(args.resumeSessionId, makeAgent())
        resolve()
      }
    }),
  })
  await withGlobals(harness, async () => {
    await harness.start()
    const firstScan = harness.clock.runNext()
    await resumeStartedPromise
    harness.listeners.get('loader/volatile-update')()
    await Promise.resolve()
    resolveResume()
    await firstScan
    assert.equal(harness.state.resumeCalls, 1)
    assert.equal(harness.followups.length, 0, '旧代不得越过换代继续投递')

    await harness.clock.runNext()
    assert.equal(harness.followups.length, 1, '新代必须补投已物化 agent 的恢复消息')
  })
})

test('dispose/re-apply(HMR): 旧代 resume 已物化 agent 由新代补投', async () => {
  let resolveResume
  let resumeStarted
  const resumeStartedPromise = new Promise((resolve) => { resumeStarted = resolve })
  const harness = createHarness({
    resume: (args, { agents, makeAgent }) => new Promise((resolve) => {
      resumeStarted()
      resolveResume = () => {
        agents.set(args.resumeSessionId, makeAgent())
        resolve()
      }
    }),
  })
  await withGlobals(harness, async () => {
    await harness.start()
    const firstScan = harness.clock.runNext()
    await resumeStartedPromise
    harness.dispose()
    resolveResume()
    await firstScan
    assert.equal(harness.state.resumeCalls, 1)
    assert.equal(harness.followups.length, 0, 'dispose 后旧代不得自行投递')

    await harness.start()
    await harness.clock.runNext()
    assert.equal(harness.followups.length, 1, '新 apply 必须消费旧代留下的待接管 agent')
  })
})

test('跨 apply 在途 resume 单飞: 旧代未收敛时新代不得重复 resume 同会话', async () => {
  let resolveResume
  let resumeStarted
  const resumeStartedPromise = new Promise((resolve) => { resumeStarted = resolve })
  const harness = createHarness({
    resume: (args, { agents, makeAgent }) => new Promise((resolve) => {
      resumeStarted()
      resolveResume = () => {
        agents.set(args.resumeSessionId, makeAgent())
        resolve()
      }
    }),
  })
  await withGlobals(harness, async () => {
    await harness.start()
    const firstScan = harness.clock.runNext()
    await resumeStartedPromise
    // 旧代 resume 仍在途时直接换代
    harness.dispose()
    await harness.start()
    const secondScan = harness.clock.runNext()
    await secondScan
    assert.equal(harness.state.resumeCalls, 1, '新代必须等旧代在途 resume,不得重复提交')

    resolveResume()
    await firstScan
    await harness.clock.runNext()
    assert.equal(harness.state.resumeCalls, 1, '旧代收敛后仍只允许一次 resume')
    assert.equal(harness.followups.length, 1, '旧代物化的 agent 必须由新代补投')
  })
})

test('最终 dispose 清空跨代待接管: 迟到的 resume 结果不得泄漏给下一实例', async () => {
  let resolveResume
  let resumeStarted
  const resumeStartedPromise = new Promise((resolve) => { resumeStarted = resolve })
  const harness = createHarness({
    resume: (args, { agents, makeAgent }) => new Promise((resolve) => {
      resumeStarted()
      resolveResume = () => {
        agents.set(args.resumeSessionId, makeAgent())
        resolve()
      }
    }),
  })
  await withGlobals(harness, async () => {
    await harness.start()
    const firstScan = harness.clock.runNext()
    await resumeStartedPromise
    // 最终卸载: cordis 在 UNLOADING 状态跑效果清理
    harness.ctx.fiber.state = 5
    harness.dispose()
    assert.equal(__test.streams(harness.home), undefined, '最终卸载后 refs 归零且共享表清空')
    resolveResume()
    await firstScan
    assert.equal(harness.followups.length, 0, '最终卸载后旧代不得再投递')

    harness.ctx.fiber.state = 2
    await harness.start()
    await harness.clock.runNext()
    assert.equal(harness.state.resumeCalls, 1, '最终 dispose 后不得等待旧在途 resume')
    // 共享表已清空(上面已断言):新实例只靠扫描发现空闲 live agent 补一条;
    // 若待接管表泄漏,这里会是 2 条
    assert.equal(harness.followups.length, 1, '迟到物化出的空闲 agent 只由新代扫描补投一次')
  })
})

test('HMR 两代重叠: 旧代最终 dispose 不得清空新代仍在等待的 in-flight resume', async () => {
  let resolveOld
  let oldStarted
  const oldStartedPromise = new Promise((resolve) => { oldStarted = resolve })
  const shared = {
    home: mkdtempSync(join(tmpdir(), 'keep-working-generation-')),
    clock: createClock(),
    agents: new Map(),
    followups: [],
    state: { observeCalls: 0, resumeCalls: 0, listCalls: 0, statCalls: 0 },
  }
  const hooks = {
    resume: (args, { agents, makeAgent, state }) => {
      if (state.resumeCalls === 1) {
        return new Promise((resolve) => {
          oldStarted()
          resolveOld = () => {
            agents.set(args.resumeSessionId, makeAgent())
            resolve()
          }
        })
      }
      agents.set(args.resumeSessionId, makeAgent())
      return undefined
    },
  }
  const oldGen = createHarness(hooks, shared)
  const newGen = createHarness(hooks, shared)
  await withGlobals(oldGen, async () => {
    try {
      await oldGen.start()
      const oldScan = oldGen.clock.runNext()
      await oldStartedPromise
      await newGen.start()
      await newGen.clock.runNext()
      assert.equal(shared.state.resumeCalls, 1, '新代必须等待旧代在途 resume')
      oldGen.ctx.fiber.state = 5
      oldGen.dispose()
      await newGen.clock.runNext()
      assert.equal(shared.state.resumeCalls, 1, '旧代最终 dispose 不得清空新代仍在等待的 in-flight resume')
      resolveOld()
      await oldScan
      await newGen.clock.runNext()
    } finally {
      newGen.dispose()
    }
  })
})

test('HMR 两代重叠: 旧代最终 dispose 不得清空新代已写入的待接管', async () => {
  const shared = {
    home: mkdtempSync(join(tmpdir(), 'keep-working-generation-')),
    clock: createClock(),
    agents: new Map(),
    followups: [],
    state: { observeCalls: 0, resumeCalls: 0, listCalls: 0, statCalls: 0 },
  }
  let followupCalls = 0
  const hooks = {
    listSessions: async () => [{ header: { id: 's2' }, events }],
    observe: () => ({ header: { id: 's2' }, events, [Symbol.dispose]() {} }),
    followup: (message) => {
      followupCalls += 1
      if (followupCalls === 1) throw new Error('首投失败')
      shared.followups.push(message)
    },
  }
  const oldGen = createHarness(hooks, shared)
  const newGen = createHarness(hooks, shared)
  await withGlobals(oldGen, async () => {
    try {
      await oldGen.start({ scanOnBoot: false })
      await newGen.start()
      await newGen.clock.runNext()
      assert.equal(shared.followups.length, 0, '首投失败后应保留待接管')
      oldGen.ctx.fiber.state = 5
      oldGen.dispose()
      await newGen.clock.runNext()
      assert.equal(shared.followups.length, 1, '旧代最终 dispose 不得清掉新代已写入的待接管')
    } finally {
      newGen.dispose()
    }
  })
})

test('apply 启动抛错: acquire 的 refs 必须归还且无主共享表清空', async () => {
  const bad = createHarness({
    systemPrompt: {
      section() { throw new Error('section 失败') },
      getSectionOrder: () => 0,
    },
  })
  await withGlobals(bad, async () => {
    await assert.rejects(bad.start(), /section 失败/)
    assert.equal(__test.streams(bad.home), undefined, '失败 apply 不得留下 refs/共享表')
  })
})

test('失败 apply 不占用 refs: 旧代最终 dispose 不得误判有后继代', async () => {
  let resolveResume
  let resumeStarted
  const resumeStartedPromise = new Promise((resolve) => { resumeStarted = resolve })
  const shared = {
    home: mkdtempSync(join(tmpdir(), 'keep-working-generation-')),
    clock: createClock(),
    agents: new Map(),
    followups: [],
    state: { observeCalls: 0, resumeCalls: 0, listCalls: 0, statCalls: 0 },
  }
  const oldGen = createHarness({
    resume: (args, { agents, makeAgent }) => new Promise((resolve) => {
      resumeStarted()
      resolveResume = () => {
        agents.set(args.resumeSessionId, makeAgent())
        resolve()
      }
    }),
  }, shared)
  await withGlobals(oldGen, async () => {
    let next
    try {
      await oldGen.start()
      const oldScan = oldGen.clock.runNext()
      await resumeStartedPromise
      const bad = createHarness({
        systemPrompt: {
          section() { throw new Error('section 失败') },
          getSectionOrder: () => 0,
        },
      }, shared)
      await assert.rejects(bad.start(), /section 失败/)
      assert.equal(__test.streams(shared.home)?.refs, 1, '失败 apply 不得占用 refs')

      oldGen.ctx.fiber.state = 5
      oldGen.dispose()
      assert.equal(__test.streams(shared.home), undefined, '旧代最终 dispose 必须清空无主共享表')
      resolveResume()
      await oldScan

      next = createHarness({}, shared)
      await next.start()
      await next.clock.runNext()
      // 无后继代时旧代的迟到结果只能靠新代扫描发现空闲 live agent 补投一次;
      // 若旧代的待接管泄漏,这里会是 2 条
      assert.equal(shared.followups.length, 1, '旧代不得自行补投,新代扫描只补一次')
    } finally {
      if (next !== undefined) {
        next.ctx.fiber.state = 5
        next.dispose()
      }
    }
  })
})

test('待接管按 DSH_HOME 隔离: 其他 home 的扫描不得消费或丢弃本 home 交接项', async () => {
  let resolveResume
  let resumeStarted
  const resumeStartedPromise = new Promise((resolve) => { resumeStarted = resolve })
  const first = createHarness({
    resume: (args, { agents, makeAgent }) => new Promise((resolve) => {
      resumeStarted()
      resolveResume = () => {
        agents.set(args.resumeSessionId, makeAgent())
        resolve()
      }
    }),
  })
  await withGlobals(first, async () => {
    await first.start()
    const firstScan = first.clock.runNext()
    await resumeStartedPromise
    first.dispose()
    resolveResume()
    await firstScan
    assert.equal(first.followups.length, 0)
  })

  // 另一个 home 扫描同一 sessionId: 其全局待接管表为空,不得误删本 home 的交接项
  const other = createHarness({ listSessions: async () => [] })
  await withGlobals(other, async () => {
    await other.start()
    await other.clock.runNext()
    assert.equal(other.followups.length, 0)
  })

  await withGlobals(first, async () => {
    await first.start()
    await first.clock.runNext()
    assert.equal(first.followups.length, 1, '本 home 的待接管必须保留到自己的新代消费')
  })
})

test('待接管超过 freshMs 后弃用: 新代不得补投过期交接项', async () => {
  let resolveResume
  let resumeStarted
  const resumeStartedPromise = new Promise((resolve) => { resumeStarted = resolve })
  const harness = createHarness({
    resume: (args, { agents, makeAgent }) => new Promise((resolve) => {
      resumeStarted()
      resolveResume = () => {
        agents.set(args.resumeSessionId, makeAgent())
        resolve()
      }
    }),
  })
  await withGlobals(harness, async () => {
    await harness.start()
    const firstScan = harness.clock.runNext()
    await resumeStartedPromise
    harness.dispose()
    resolveResume()
    await firstScan
    assert.equal(harness.followups.length, 0)

    harness.clock.advance(120_001)
    await harness.start()
    await harness.clock.runNext()
    assert.equal(harness.followups.length, 0, '超过 freshMs 的交接项必须被 TTL 清掉')
  })
})

test('待接管投递持续失败: 按 1s→60s 退避且不越过 freshMs, 不得 0ms 自旋', async () => {
  let resolveResume
  let resumeStarted
  const resumeStartedPromise = new Promise((resolve) => { resumeStarted = resolve })
  const harness = createHarness({
    resume: (args, { agents, makeAgent }) => new Promise((resolve) => {
      resumeStarted()
      resolveResume = () => {
        agents.set(args.resumeSessionId, makeAgent())
        resolve()
      }
    }),
    followup: (_message, state) => {
      state.followupFailures = (state.followupFailures ?? 0) + 1
      throw new Error('投递失败')
    },
  })
  await withGlobals(harness, async () => {
    await harness.start()
    const firstScan = harness.clock.runNext()
    await resumeStartedPromise
    harness.dispose()
    resolveResume()
    await firstScan
    assert.equal(harness.state.resumeCalls, 1)

    // 新代先消费旧代留下的待接管项,投递持续失败
    await harness.start()
    const delays = []
    // 上限防止旧实现的 0ms 自旋把测试挂死: 超过预期序列即由下面的断言报错
    while (harness.clock.timers.size > 0 && delays.length < 12) delays.push(await harness.clock.runNext())
    assert.deepEqual(
      delays,
      [5_000, 1_000, 2_000, 4_000, 8_000, 16_000, 32_000, 52_000],
      '失败投递必须走指数退避,并以 freshMs 窗口截断',
    )
    assert.equal(delays.includes(0), false, '不得 0ms 自旋')
    assert.ok(harness.state.followupFailures >= 8, '每一轮重扫都要真正重试投递,窗口耗尽后放弃')
  })
})

test('设置重建打断 resume 在途: 新代 stat 等待期间旧代收敛,新代仍须消费待接管 agent', async () => {
  const sessionId = 'session-s1'
  let resolveResume
  let resumeStarted
  const resumeStartedPromise = new Promise((resolve) => { resumeStarted = resolve })
  let resolveStat
  let statStarted
  const statStartedPromise = new Promise((resolve) => { statStarted = resolve })
  const secondStat = new Promise((resolve) => { resolveStat = resolve })
  const harness = createHarness({
    resume: (args, { agents, makeAgent }) => new Promise((resolve) => {
      resumeStarted()
      resolveResume = () => {
        agents.set(args.resumeSessionId, makeAgent())
        resolve()
      }
    }),
    sessionPersistence: ({ state }) => ({
      stat: async (id) => {
        state.statCalls += 1
        if (state.statCalls < 2) return { header: { id }, eventCount: 1 }
        statStarted()
        return secondStat
      },
    }),
  })
  await withGlobals(harness, async () => {
    const sessionDir = join(harness.home, 'sessions', 'ws', sessionId)
    mkdirSync(sessionDir, { recursive: true })
    writeFileSync(join(sessionDir, 'session.jsonl'), '')
    await harness.start()
    const firstScan = harness.clock.runNext()
    await resumeStartedPromise
    harness.listeners.get('loader/volatile-update')()
    await Promise.resolve()

    // 新代扫描先于旧代 resume 收敛,卡在 persistence.stat
    const secondScan = harness.clock.runNext()
    await statStartedPromise
    resolveResume()
    await firstScan
    resolveStat({ header: { id: sessionId }, eventCount: 1 })
    await secondScan

    assert.equal(harness.state.resumeCalls, 1)
    assert.equal(harness.state.statCalls, 2, '新代确实在第二次 stat 等待期间被旧代追平')
    assert.equal(harness.followups.length, 1, 'stat 等待期间收敛的旧代 agent 必须被新代消费')
  })
})
