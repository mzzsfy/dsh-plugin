import { createTask, defineWorkItem, authorizeTask } from '../../lib/core/task.mjs'
import { mergeRunUsage } from '../../lib/core/usage.mjs'

const STATES = ['draft', 'ready', 'implementing', 'awaiting_acceptance', 'completed', 'blocked', 'cancelled']

function makeTask(taskId, state, index) {
  const now = () => 1_700_000_000_000 + index
  let aggregate = createTask({
    taskId, title: `账务结算运行簿 ${String(index + 1).padStart(3, '0')}`,
    projectWorkspaceId: `workspace-${index % 3 + 1}`,
    priority: ['high', 'normal', 'low'][index % 3],
    definition: { goal: `交付工作区 ${index % 3 + 1} 账务结算服务`, scope: '结算、重试和审计', acceptanceCriteria: [
      { criterionId: 'contract', text: '现有 API 契约保持兼容' },
      { criterionId: 'retry', text: '重试请求幂等且可恢复' },
      { criterionId: 'audit', text: '关键修改有审计记录' },
    ], dependencyTaskIds: [] }, now,
  }).result
  aggregate = defineWorkItem(aggregate, { workItemId: 'implementation', title: '实现与回归测试', requiredCriterionIds: ['contract', 'retry'] }).result.aggregate
  aggregate = defineWorkItem(aggregate, { workItemId: 'review', title: '独立验收与审计', dependencyWorkItemIds: ['implementation'], requiredCriterionIds: ['audit'] }).result.aggregate
  if (state !== 'draft') aggregate = authorizeTask(aggregate, { sourceMessageRef: { sessionId: 'fixture-admin', messageId: `authorization-${index}` }, now }).result.aggregate
  aggregate.businessState = state
  if (state === 'blocked') aggregate.block = { reason: '等待上游 API 冻结', dependencyTaskIds: [`dependency-${index}`] }
  if (['implementing', 'awaiting_acceptance', 'completed', 'blocked', 'cancelled'].includes(state)) {
    const addRun = (runId, phase, stateOfRun, offset, model) => {
      const sessionId = `session-${taskId}-${runId}`
      aggregate.runs[runId] = {
        runId, workItemId: phase === 'accept' ? 'review' : 'implementation', phase,
        actorRole: phase === 'accept' ? 'reviewer' : 'executor', attemptOrdinal: phase === 'fix' ? 2 : 1,
        definitionRevision: 1, executionEpoch: 0, globalStopGeneration: 0, executionSlot: `${taskId}:${phase}`,
        sessionId, requestId: `request-${taskId}-${runId}`,
        state: stateOfRun, executionTreeSettled: ['settled', 'interrupted', 'rejected'].includes(stateOfRun),
        startedAt: ['prepared', 'submitted'].includes(stateOfRun) ? null : 1_700_000_000_000 + index * 60_000 + offset,
        endedAt: ['running', 'submitted'].includes(stateOfRun) ? null : 1_700_000_000_000 + index * 60_000 + offset + 45_000,
        tokenTotal: null, usageCoverage: 'unknown',
        stopObserved: stateOfRun === 'interrupted' ? 'confirmed' : null,
      }
      const usageResult = mergeRunUsage(aggregate, { runId, usage: model ? { invocationKey: `invocation-${runId}`, model, inputTokens: model === 'orion' ? 4820 : 1730, outputTokens: 0 } : null })
      if (!usageResult.ok) throw new Error(usageResult.message)
      aggregate = usageResult.result.aggregate
      aggregate.sessions[sessionId] = { sessionId, executorOf: [runId] }
    }
    if (state === 'implementing') {
      addRun('run-implementation', 'implement', 'settled', 0, 'orion')
      addRun('run-repair', 'fix', 'running', 90_000, null)
    } else if (state === 'awaiting_acceptance') {
      addRun('run-implementation', 'implement', 'settled', 0, 'orion')
      addRun('run-review', 'accept', 'submitted', 90_000, null)
    } else addRun('run-implementation', 'implement', 'interrupted', 0, 'orion')
    aggregate.reports[`report-${taskId}`] = {
      reportId: `report-${taskId}`, runId: 'run-implementation', workItemId: 'implementation',
      verdict: 'ready_for_review', coveredCriterionIds: ['contract'], issues: [], evidence: ['测试已通过'], historical: false, createdAt: now(),
    }
  }
  aggregate.updatedAt = now()
  return aggregate
}

export function makeSeedBoard() {
  const tasks = STATES.flatMap((state, stateIndex) => Array.from({ length: 2 }, (_, offset) => makeTask(`fixture-${state}-${offset + 1}`, state, stateIndex * 2 + offset)))
  tasks[4] = makeTask('fixture-running', 'implementing', 100)
  return { tasks, globalControl: { globalStopped: false, globalStopGeneration: 0, taskAllows: {} } }
}

export async function seedFixtureStore(store, { prefix = 'fixture-' } = {}) {
  const tasks = makeSeedBoard().tasks.filter((task) => task.taskId.startsWith(prefix))
  await Promise.all(tasks.map((task) => store.saveAggregate(JSON.parse(JSON.stringify(task)))))
  return tasks.length
}
