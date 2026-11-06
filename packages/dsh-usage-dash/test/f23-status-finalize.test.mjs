// F23 回归守护(可失败行为测试):回扫状态机的 running→idle 收尾刷新。
// 原始缺陷(F23):rebuild/restore 的回扫是同步语义,状态轮询响应回来时 running 已为 false,
// 「done 增长」增量分支永不触发,汇总额与热力图停在旧值;且首个空闲 tick 曾直接断链,
// 轮询不再续跑。
// 修复后契约:running→idle 转换(含 restart 引导的重建)恰触发一次汇总刷新 + 一次热力图
// 重取;空闲 tick 不再重复刷新,但轮询链必须续跑。
// client.js 单文件无法 import:按标记切出状态轮询 useEffect 的函数体,以注入依赖 + 假定时器
// 直接执行,断言落在外呼副作用(requestPost 次数、scheduleRefresh/bumpHeatFetch 次数、定时器
// 链是否续排)上。
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const CLIENT_SRC = readFileSync(fileURLToPath(new URL('../src/client.js', import.meta.url)), 'utf8')

const BODY_START = '        let timer = null\n'
const BODY_END = '        return () => {\n          alive = false\n'

function slicePollBody(source) {
  const start = source.indexOf(BODY_START)
  assert.ok(start >= 0, '未找到状态轮询函数体起点(标记漂移需同步测试)')
  const end = source.indexOf(BODY_END, start)
  assert.ok(end > start, '未找到状态轮询函数体终点(标记漂移需同步测试)')
  return source.slice(start + BODY_START.length, end)
}

const POLL_BODY = slicePollBody(CLIENT_SRC)
const FAST_MS = Number(/STATUS_POLL_FAST_MS = (\d+)/.exec(CLIENT_SRC)?.[1])
const SLOW_MS = Number(/STATUS_POLL_SLOW_MS = (\d+)/.exec(CLIENT_SRC)?.[1])
assert.ok(Number.isFinite(FAST_MS) && Number.isFinite(SLOW_MS), '未取到轮询间隔常量')

/** 用假定时器装载轮询体:返回受控时钟与副作用计数。 */
function loadPoll({ statuses }) {
  const timers = []
  let timerSeq = 0
  const effects = { requests: 0, statuses: [], refreshes: 0, heatFetches: 0 }
  const statusMachineRef = { current: null }
  const pending = []
  const runtime = {
    setTimeout(fn, delay) {
      timerSeq += 1
      const timer = { id: timerSeq, fn, delay, cleared: false }
      timers.push(timer)
      return timer.id
    },
    clearTimeout(id) {
      const timer = timers.find((item) => item.id === id)
      if (timer) timer.cleared = true
    },
  }
  const factory = new Function(
    'requestPost', 'ENDPOINTS', 'STATUS_POLL_FAST_MS', 'STATUS_POLL_SLOW_MS',
    'setStatus', 'scheduleRefresh', 'bumpHeatFetch', 'statusMachineRef',
    'setTimeout', 'clearTimeout',
    `${POLL_BODY}\nreturn statusMachineRef.current`,
  )
  const machine = factory(
    async () => {
      effects.requests += 1
      const next = statuses.length > 1 ? statuses.shift() : statuses[0]
      return { ok: true, value: next }
    },
    { status: 'status' },
    FAST_MS,
    SLOW_MS,
    (value) => effects.statuses.push(value),
    () => { effects.refreshes += 1 },
    () => { effects.heatFetches += 1 },
    statusMachineRef,
    runtime.setTimeout,
    runtime.clearTimeout,
  )
  /** 放行所有微任务(等待异步 tick 落地) */
  const flush = async () => {
    for (let i = 0; i < 20; i += 1) await new Promise((resolve) => setImmediate(resolve))
    void pending
  }
  /** 取最近一个未清除的定时器并触发 */
  const fireNext = async () => {
    await flush()
    const live = timers.filter((item) => !item.cleared)
    const timer = live[live.length - 1]
    assert.ok(timer, '没有待触发的轮询定时器(轮询链断了)')
    timer.cleared = true
    await timer.fn()
    await flush()
    return timer.delay
  }
  return { effects, machine, fireNext, flush, timers: () => timers.filter((item) => !item.cleared) }
}

test('F23-a 运行中→空闲:恰一次汇总刷新 + 一次热力图重取,且轮询续跑', async () => {
  const poll = loadPoll({
    statuses: [
      { running: true, done: 0 },
      { running: false, done: 0 },
      { running: false, done: 0 },
    ],
  })
  await poll.flush()
  assert.equal(poll.effects.requests, 1, '挂载即首探')
  assert.equal(poll.effects.refreshes, 0, '运行中首探不刷新')

  // 运行中 tick → 空闲 tick:回扫已结束,只能靠转换分支收尾
  const delay = await poll.fireNext()
  assert.equal(delay, FAST_MS, '运行中快轮')
  assert.equal(poll.effects.refreshes, 1, 'running→idle 必须补一次汇总刷新')
  assert.equal(poll.effects.heatFetches, 1, 'running→idle 必须重取热力图(重建产物进日桶)')
  assert.equal(poll.timers().length, 1, '空闲后轮询链必须续排')
  assert.equal(poll.timers()[0].delay, SLOW_MS, '空闲走慢轮')

  // 再一个空闲 tick:不得重复刷新
  await poll.fireNext()
  assert.equal(poll.effects.refreshes, 1, '空闲 tick 不得重复刷新')
  assert.equal(poll.effects.heatFetches, 1, '空闲 tick 不得重复重取热力图')
  assert.equal(poll.timers().length, 1, '轮询链持续存活')
})

test('F23-b 重建/恢复:restart 引导的首个 tick 走收尾刷新(同步回扫已无 running 相位)', async () => {
  const poll = loadPoll({
    statuses: [
      { running: false, done: 0 },
      { running: false, done: 0 },
      { running: false, done: 0 },
    ],
  })
  await poll.flush()
  assert.equal(poll.effects.refreshes, 0, '空闲首探不刷新')

  assert.ok(poll.machine && typeof poll.machine.restart === 'function', '未暴露 restart 引导入口')
  poll.machine.restart()
  const delay = await poll.fireNext()
  assert.equal(delay, FAST_MS, 'restart 引导快轮')
  assert.equal(poll.effects.refreshes, 1, '重建后必须补一次汇总刷新')
  assert.equal(poll.effects.heatFetches, 1, '重建后必须重取热力图')
  assert.equal(poll.timers().length, 1, '收尾后轮询链必须续排')

  await poll.fireNext()
  assert.equal(poll.effects.refreshes, 1, '收尾只做一次')
})
