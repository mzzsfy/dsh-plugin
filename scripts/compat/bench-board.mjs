// D2 性能基准:1000 任务造数 → listAggregates/board 投影耗时。验收: board 投影 < 2s(页面可接受)。
import { performance } from 'node:perf_hooks'
import { register } from 'node:module'

// 直接在进程内复刻存储面:用真实 createTask 造 1000 个聚合存内存 Map,压 board 投影纯函数
const { queryBoard, projectTaskDetail } = await import('../../packages/dsh-boss-simulator/lib/core/query.mjs')
const { createTask, defineWorkItem, authorizeTask } = await import('../../packages/dsh-boss-simulator/lib/core/task.mjs')

const now = () => 1
const aggregates = new Map()
const t0 = performance.now()
for (let i = 0; i < 1000; i++) {
  const taskId = `t-bench-${i}`
  let agg = createTask({ taskId, title: `任务${i}`, projectWorkspaceId: 'ws1', definition: { goal: 'g', acceptanceCriteria: [{ criterionId: 'c1', text: 'c' }], dependencyTaskIds: [] }, now }).result
  agg = defineWorkItem(agg, { workItemId: 'w1', title: 'w', requiredCriterionIds: ['c1'] }).result.aggregate
  agg = authorizeTask(agg, { sourceMessageRef: { sessionId: 's0', messageId: 'm0' } }).result.aggregate
  aggregates.set(taskId, agg)
}
const buildMs = performance.now() - t0

const store = { listAggregates: async () => [...aggregates.values()], settings: false }
const t1 = performance.now()
const board = queryBoard([...aggregates.values()], { globalStopped: false, globalStopGeneration: 0 }, {})
const boardMs = performance.now() - t1
const t2 = performance.now()
const first = [...aggregates.values()][0]
for (const agg of aggregates.values()) projectTaskDetail(agg, {})
const detailMs = performance.now() - t2
void first

console.log(JSON.stringify({
  tasks: aggregates.size,
  buildMs: Math.round(buildMs),
  boardProjectMs: Math.round(boardMs),
  detailAllMs: Math.round(detailMs),
  boardCounts: board.counts,
  accept: boardMs < 2000,
}, null, 2))
