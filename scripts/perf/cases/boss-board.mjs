// 任务看板用例:看板请求 = 全量聚合投影为看板行 + 逐任务详情投影。
// 输入规模取真实任务数上限,覆盖看板与详情两条投影路径。
import { SCALE } from '../scale.mjs'
import { queryBoard, projectTaskDetail } from '../../../packages/dsh-boss-simulator/lib/core/query.mjs'
import { createTask, defineWorkItem, authorizeTask } from '../../../packages/dsh-boss-simulator/lib/core/task.mjs'

// 时间源固定,使聚合构造与投影都不受时钟影响
const NOW = 1
const CONTROL = { globalStopped: false, globalStopGeneration: 0 }

function buildAggregates() {
  const aggregates = []
  for (let index = 0; index < SCALE.boardTasks; index += 1) {
    const taskId = `task-${index}`
    const definition = { goal: 'goal', acceptanceCriteria: [{ criterionId: 'c1', text: 'criterion' }], dependencyTaskIds: [] }
    const created = createTask({ taskId, title: `任务${index}`, projectWorkspaceId: 'workspace', definition, now: () => NOW })
    const withItem = defineWorkItem(created.result, { workItemId: 'w1', title: 'work', requiredCriterionIds: ['c1'] })
    aggregates.push(authorizeTask(withItem.result.aggregate, { sourceMessageRef: { sessionId: 'session', messageId: 'message' } }).result.aggregate)
  }
  return aggregates
}

const aggregates = buildAggregates()

export const cases = [
  {
    name: 'boss/queryBoard-1000',
    description: '看板全量投影',
    scale: `${aggregates.length} 任务`,
    iterations: 10,
    setup: () => aggregates,
    run: (source) => queryBoard(source, CONTROL, {}),
  },
  {
    name: 'boss/projectTaskDetail-1000',
    description: '逐任务详情投影',
    scale: `${aggregates.length} 任务`,
    iterations: 10,
    setup: () => aggregates,
    run: (source) => source.map((aggregate) => projectTaskDetail(aggregate, CONTROL)),
  },
]

export default cases[0]
