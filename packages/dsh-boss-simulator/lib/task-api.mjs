// 人类操作入口:创建/授权/派发/删除由面板直达,复用 core 状态机与 Run 服务,不复制规则。
// 任务创建以客户端生成的 taskId 作幂等键;重复提交得到冲突而不是第二条任务。
import { randomUUID } from 'node:crypto'
import { createTask, defineWorkItem, authorizeTask, hasActiveRuns, expireStaleRuns } from './core/task.mjs'
import { defaultPhaseFor, nextDispatchOf } from './core/query.mjs'
import { createRunService } from './run-service.mjs'
import { sendJson, readJsonBody, rejectMethod } from './http.mjs'

const ACTIONS = ['create', 'authorize', 'dispatch', 'delete']
const METHODS = { workspaces: ['GET'], task: ['POST'] }
const DELETE_CONFIRM = 'delete'
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
    if (rejectMethod(req, res, METHODS.workspaces)) return
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
      // 幂等短路在 core:已授权且定义未变时不改写记录,也不作废既有验收
      const outcome = authorizeTask(aggregate, {
        sourceMessageRef: { sessionId: 'boss-simulator-panel', messageId: body.commandId ?? randomUUID() },
      })
      if (!outcome.ok) throw Object.assign(new Error(outcome.message), { code: outcome.code })
      return outcome.result.aggregate
    })
    return { ok: true, taskId, businessState: updated.businessState, controlState: updated.control.state }
  }

  // 删除任务:放弃任务的唯一出口。在飞 Run 未核清时先要求停止/强制停止,
  // 失联 Run 按已断收敛后不再阻塞删除;删除本身需显式确认,避免误触。
  async function remove(body) {
    const taskId = requireText(body.taskId, 'taskId')
    if (body.confirm !== DELETE_CONFIRM) {
      throw Object.assign(new Error(`删除任务须显式确认(confirm: ${DELETE_CONFIRM})`), { statusCode: 400, code: 'CONFIRMATION_REQUIRED' })
    }
    const aggregate = await store.loadAggregate(taskId)
    if (!aggregate) throw Object.assign(new Error(`任务不存在: ${taskId}`), { code: 'NOT_FOUND' })
    const settled = expireStaleRuns(aggregate).result?.aggregate ?? aggregate
    if (hasActiveRuns(settled)) {
      throw Object.assign(new Error('任务存在未核清 Run,须先停止或强制停止后再删除'), { code: 'EXECUTION_STILL_ACTIVE' })
    }
    await store.deleteAggregate(taskId)
    return { ok: true, taskId, deleted: true }
  }

  async function dispatch(body) {
    const taskId = requireText(body.taskId, 'taskId')
    const aggregate = await store.loadAggregate(taskId)
    if (!aggregate) throw Object.assign(new Error(`任务不存在: ${taskId}`), { code: 'NOT_FOUND' })
    // 未指定子项时按服务端推进目标派发:面板不在客户端复制"先派第一个"的选择规则
    const planned = nextDispatchOf(aggregate)
    const workItemId = body.workItemId === undefined ? planned?.workItemId : requireText(body.workItemId, 'workItemId')
    if (!workItemId) throw Object.assign(new Error('没有可推进的子项(无待实施或待验收项)'), { code: 'INVALID_ARGUMENT' })
    // 缺省阶段与 nextDispatch 同源:显式 workItemId 也按子项派生态推导(已有产物代次→fix)
    const phase = body.phase ?? defaultPhaseFor(aggregate, workItemId) ?? DEFAULT_PHASE
    // 预检只给出可读错误码,执行期规则仍由 Run 服务内的许可校验决定
    if (!aggregate.authorization || aggregate.authorization.definitionRevision !== aggregate.definitionRevision) {
      throw Object.assign(new Error('当前定义无有效授权'), { code: 'AUTHORIZATION_REQUIRED' })
    }
    if (!drive?.sessionAdapter) throw Object.assign(new Error('标准会话适配未就绪'), { statusCode: 501 })
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

  const handlers = { create, authorize, dispatch, delete: remove }

  async function handleTask(req, res) {
    if (rejectMethod(req, res, METHODS.task)) return
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
