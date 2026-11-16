// DST 春跳(纽约):2026-03-08 02:30 不存在,croner 把该墙钟时刻顺延到 03:30。
// recover 不得把这类合法映射触发点当残留值静默改到次日;改期即漏跑一次。
// 宿主时区在进程级固定:本文件由 node --test 独立进程运行,不影响其它测试文件。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createStore } from '../src/store.mjs'
import { createScheduler } from '../src/scheduler.mjs'

process.env.TZ = 'America/New_York'

const NY = {
  beforeGap: Date.parse('2026-03-08T03:20:00-04:00'),
  mappedTrigger: Date.parse('2026-03-08T03:30:00-04:00'),
  nextDayTrigger: Date.parse('2026-03-09T02:30:00-04:00'),
}
const TICK_MS = 30 * 1000

async function makeStore(t) {
  const dir = await mkdtemp(join(tmpdir(), 'cron-board-dst-'))
  t.after(() => rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }))
  return createStore({ dir: join(dir, 'data') })
}

function makeScheduler(store, now) {
  const dispatched = []
  const scheduler = createScheduler({
    store,
    executor: {
      dispatch: async (job) => { dispatched.push(job.id) },
      stop: async () => {},
    },
    readTickMs: () => TICK_MS,
    now: () => now(),
  })
  return { scheduler, dispatched }
}

test('S2: recover 保留 DST 春跳映射触发点(02:30→03:30),不改到次日', async (t) => {
  const store = await makeStore(t)
  // Given 重启发生在 03:20,nextRunAt 是当天被顺延到 03:30 的合法触发点
  const job = await store.jobs.create({
    name: 'dst', kind: 'shell', command: 'echo hi', schedule: '30 2 * * *',
    enabled: true, timeoutMs: 60 * 1000, nextRunAt: NY.mappedTrigger,
  })
  const { scheduler } = makeScheduler(store, () => NY.beforeGap)
  // When 重启恢复
  await scheduler.recover()
  // Then 触发点原样保留(旧实现从 03:29:59 重算得次日,静默改期漏跑)
  assert.equal(store.jobs.get(job.id).nextRunAt, NY.mappedTrigger)
})

test('S2: 保留的映射触发点在 03:30 真触发,不静默漏跑', async (t) => {
  const store = await makeStore(t)
  const job = await store.jobs.create({
    name: 'dst', kind: 'shell', command: 'echo hi', schedule: '30 2 * * *',
    enabled: true, timeoutMs: 60 * 1000, nextRunAt: NY.mappedTrigger,
  })
  let nowMs = NY.beforeGap
  const { scheduler, dispatched } = makeScheduler(store, () => nowMs)
  await scheduler.recover()
  assert.equal(store.jobs.get(job.id).nextRunAt, NY.mappedTrigger)
  // When 时钟走到 03:30
  nowMs = NY.mappedTrigger
  await scheduler.tick()
  // Then 当次触发被执行,nextRunAt 顺延到次日 02:30(不是再次跳过)
  assert.deepEqual(dispatched, [job.id])
  assert.equal(store.jobs.get(job.id).nextRunAt, NY.nextDayTrigger)
})

test('S2: 真残留值(DST 窗口内也非触发点)仍被自愈重算', async (t) => {
  const store = await makeStore(t)
  // Given 03:15 不是 30 2 * * * 的触发点(历史版本编辑残留)
  const job = await store.jobs.create({
    name: 'dst', kind: 'shell', command: 'echo hi', schedule: '30 2 * * *',
    enabled: true, timeoutMs: 60 * 1000, nextRunAt: Date.parse('2026-03-08T03:15:00-04:00'),
  })
  const { scheduler } = makeScheduler(store, () => NY.beforeGap)
  // When 重启恢复
  await scheduler.recover()
  // Then 仍按当前 schedule 重算到下一个合法触发点,自愈守卫不被 DST 兼容分支削弱
  assert.equal(store.jobs.get(job.id).nextRunAt, NY.nextDayTrigger)
})
