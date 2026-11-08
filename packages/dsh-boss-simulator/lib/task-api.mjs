// 人类操作入口:创建/授权/派发由面板直达,复用 core 状态机与 Run 服务,不复制规则。
// 任务创建以客户端生成的 taskId 作幂等键;重复提交得到冲突而不是第二条任务。
import { randomUUID } from 'node:crypto'
import { createTask, defineWorkItem, authorizeTask } from './core/task.mjs'
import { createRunService } from './run-service.mjs'
import { sendJson, readJsonBody } from './http.mjs'

const ACTIONS = ['create', 'authorize', 'dispatch']
const DEFAULT_WORK_ITEM_ID = 'w1'
const DEFAULT_PHASE = 'implement'
const CRITERION_PREFIX = 'c'
// core 错误码到 HTTP 语义的显式映射:未列出的业务错误按冲突处理,未知异常才是 500
const STATUS_BY_CODE = {
  NOT_FOUND: 404,
  INVALID_ARGUMENT: 400,
  TASK_EXISTS: 409,
  AUTHORIZATION_REQUIRED: 409,
  TASK_PAUSED: 409,
  EXECUTION_STILL_ACTIVE: 409,
  DEPENDENCY_BLOCKED: 409,
}

function requireText(value, label) {
  if (typeof value !== 'string' || value.trim() === '') throw Object.assign(new Error(`${label} 必填`), { statusCode: 400 })
  return value.trim()
}

function toCriteria(list) {
  if (list === undefined) return []
  if (!Array.isArray(list)) throw Object.assign(new Error('acceptanceCriteria 须为字符串数组'), { statusCode: 400 })
  return list
    .map((text) => (typeof text === 'string' ? text.trim() : ''))
    .filter((text) => text !== '')
    .map((text, index) => ({ criterionId: `${CRITERION_PREFIX}${index + 1}`, text }))
}

function statusOf(error) {
  return error.statusCode ?? STATUS_BY_CODE[error.code] ?? (error.code ? 409 : 500)
}

export function createTaskApi({ store, drive, listWorkspaces = () => [], now = Date.now }) {
  async function handleWorkspaces(req, res) {
    try {
      const host = await listWorkspaces()
      const fromHost = (Array.isArray(host) ? host : [])
        .filter((item) => item && typeof item.workspaceId === 'string')
        .map((item) => ({ workspaceId: item.workspaceId, title: item.title ?? item.workspaceId, path: item.path ?? null }))
      const known = new Set(fromHost.map((item) => item.workspaceId))
      const fromTasks = (await store.listAggregates())
        .map((task) => task.projectWorkspaceId)
        .filter((workspaceId) => typeof workspaceId === 'string' && !known.has(workspaceId))
      const seen = new Set()
      const items = [
        ...fromHost,
        ...[...new Set(fromTasks)].map((workspaceId) => ({ workspaceId, title: workspaceId, path: null })),
      ].filter((item) => (seen.has(item.workspaceId) ? false : seen.add(item.workspaceId)))
      sendJson(res, 200, { items })
    } catch (error) {
      sendJson(res, 500, { error: error.message })
    }
  }

  async function create(body) {
    const taskId = requireText(body.taskId, 'taskId')
    if (await store.loadAggregate(taskId)) {
      throw Object.assign(new Error(`任务已存在: ${taskId}`), { statusCode: 409 })
    }
    const criteria = toCriteria(body.acceptanceCriteria)
    const created = createTask({
      taskId,
      title: requireText(body.title, 'title'),
      projectWorkspaceId: requireText(body.workspaceId, 'workspaceId'),
      priority: body.priority,
      definition: { goal: requireText(body.goal, 'goal'), scope: body.scope ?? '', acceptanceCriteria: criteria },
      now,
    })
    if (!created.ok) throw Object.assign(new Error(created.message), { statusCode: 400 })
    const defined = defineWorkItem(created.result, {
      workItemId: DEFAULT_WORK_ITEM_ID,
      title: body.workItemTitle ?? created.result.title,
      requiredCriterionIds: criteria.map((criterion) => criterion.criterionId),
    })
    if (!defined.ok) throw Object.assign(new Error(defined.message), { statusCode: 400 })
    const saved = await store.saveAggregate(defined.result.aggregate)
    return { ok: true, taskId: saved.taskId, businessState: saved.businessState, workItemId: DEFAULT_WORK_ITEM_ID }
  }

  async function authorize(body) {
    const taskId = requireText(body.taskId, 'taskId')
    if (!(await store.loadAggregate(taskId))) throw Object.assign(new Error(`任务不存在: ${taskId}`), { code: 'NOT_FOUND' })
    const updated = await store.updateAggregate(taskId, (aggregate) => {
      // 重复授权不再改写记录:已授权且定义未变即当前事实
      if (aggregate.authorization && aggregate.authorization.definitionRevision === aggregate.definitionRevision) return aggregate
      const outcome = authorizeTask(aggregate, {
        sourceMessageRef: { sessionId: 'boss-simulator-panel', messageId: body.commandId ?? randomUUID() },
      })
      if (!outcome.ok) throw Object.assign(new Error(outcome.message), { code: outcome.code })
      return outcome.result.aggregate
    })
    return { ok: true, taskId, businessState: updated.businessState, controlState: updated.control.state }
  }

  async function dispatch(body) {
    const taskId = requireText(body.taskId, 'taskId')
    const workItemId = requireText(body.workItemId, 'workItemId')
    const aggregate = await store.loadAggregate(taskId)
    if (!aggregate) throw Object.assign(new Error(`任务不存在: ${taskId}`), { code: 'NOT_FOUND' })
    // 预检只给出可读错误码,执行期规则仍由 Run 服务内的许可校验决定
    if (!aggregate.authorization || aggregate.authorization.definitionRevision !== aggregate.definitionRevision) {
      throw Object.assign(new Error('当前定义无有效授权'), { code: 'AUTHORIZATION_REQUIRED' })
    }
    if (!drive?.sessionAdapter) throw Object.assign(new Error('标准会话适配未就绪'), { statusCode: 501 })
    const phase = body.phase ?? DEFAULT_PHASE
    const service = createRunService({
      store,
      sessionAdapter: drive.sessionAdapter,
      followRuns: drive.followRuns,
      withExecution: drive.withExecution ?? ((action) => action()),
    })
    return service.dispatch({
      taskId,
      workItemId,
      phase,
      runId: body.runId ?? randomUUID(),
      requestId: body.requestId ?? randomUUID(),
      content: requireText(body.content ?? `实施任务 ${taskId}/${workItemId}`, 'content'),
    })
  }

  const handlers = { create, authorize, dispatch }

  async function handleTask(req, res) {
    try {
      const body = await readJsonBody(req, res)
      if (body === null) return
      const handler = handlers[body?.action]
      if (!handler) {
        sendJson(res, 400, { error: `action 须为 ${ACTIONS.join('/')}` })
        return
      }
      const result = await handler(body)
      sendJson(res, body.action === 'create' ? 201 : 200, result)
    } catch (error) {
      sendJson(res, statusOf(error), { error: error.message, code: error.code })
    }
  }

  return { handleWorkspaces, handleTask }
}
