// board API v2:/api/boss-simulator/board 只读查询(查询投影契约)+/api/boss-simulator/interrupt 写路由。
// 安全边界(全仓库约定):不做 host 认证;写路由跨源防护以 Origin 同源比对为上限。
import { randomUUID } from 'node:crypto'
import { queryBoard, projectTaskDetail } from './core/query.mjs'
import { stopAll, recordStopOperation } from './core/global-control.mjs'
import { createSettings, saveSettings } from './core/settings.mjs'
import { interruptTask } from './core/orchestrator.mjs'
import { createTask, defineWorkItem, authorizeTask } from './core/task.mjs'
import { ADMIN_PRESET_ID } from './presets.mjs'

function sendJson(res, status, payload) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(payload))
}

function rejectCrossOrigin(req, res) {
  const origin = req.headers ? req.headers.origin : undefined
  if (!origin) return false
  let sameOrigin = false
  try {
    sameOrigin = new URL(origin).host === req.headers.host
  } catch {
    sameOrigin = false
  }
  if (sameOrigin) return false
  sendJson(res, 403, { error: '跨源请求被拒绝' })
  return true
}

const BODY_LIMIT_BYTES = 64 * 1024

function readBody(req) {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers?.['content-length'] ?? 0)
    if (declared > BODY_LIMIT_BYTES) {
      reject(Object.assign(new Error('请求体超过大小上限'), { statusCode: 413 }))
      return
    }
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > BODY_LIMIT_BYTES) {
        reject(Object.assign(new Error('请求体超过大小上限'), { statusCode: 413 }))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

export function createBoardApi({ store, drive, now = Date.now, serverEpoch = randomUUID() }) {
  async function handleBoard(req, res, url = new URL(req.url ?? '/api/boss-simulator/board', 'http://local')) {
    try {
      const [aggregates, control, adminBinding] = await Promise.all([store.listAggregates(), store.loadControl(), store.loadAdminBinding()])
      const taskId = url.searchParams.get('taskId')
      if (taskId) {
        const aggregate = aggregates.find((a) => a.taskId === taskId)
        if (!aggregate) {
          sendJson(res, 404, { error: `任务不存在: ${taskId}` })
          return
        }
        sendJson(res, 200, projectTaskDetail(aggregate, control))
        return
      }
      const params = url.searchParams
      if (params.get('settings') === '1') {
        sendJson(res, 200, store.settings ? await store.loadSettings() : createSettings(now))
        return
      }
      const queried = queryBoard(aggregates, control, {
        workspaceId: params.get('workspaceId') ?? undefined,
        search: params.get('search') ?? undefined,
        cursor: params.get('cursor') ?? undefined,
        limit: params.has('limit') ? Number(params.get('limit')) : undefined,
        now,
        serverEpoch,
      })
      if (!queried.ok) {
        sendJson(res, queried.code === 'REVISION_CONFLICT' ? 409 : 400, { error: queried.message, code: queried.code })
        return
      }
      sendJson(res, 200, { ...queried.result, administrator: adminBinding?.sessionId ?? null })
    } catch (error) {
      sendJson(res, error.statusCode ?? 500, { error: error.message })
    }
  }

  // PAGE-20 管理员会话入口:创建空管理员会话并登记绑定,幂等收养;绝不发送 prompt。
  let adminCreateInFlight = null
  async function handleAdmin(req, res) {
    try {
      if (rejectCrossOrigin(req, res)) return
      const raw = await readBody(req).catch((error) => { throw Object.assign(error, { statusCode: error.statusCode ?? 400 }) })
      let body = {}
      try {
        body = raw ? JSON.parse(raw) : {}
      } catch {
        sendJson(res, 400, { error: '请求体不是合法 JSON' })
        return
      }
      if (body.action !== 'create') {
        sendJson(res, 400, { error: 'action 须为 create', code: 'ADMIN_CREATE_REJECTED' })
        return
      }
      // replace:原绑定会话不可达时的显式重建,覆盖绑定;任务与历史记录不受影响
      const replace = body.replace === true
      if (!replace) {
        const existing = await store.loadAdminBinding()
        if (existing?.sessionId) {
          sendJson(res, 200, { ok: true, sessionId: existing.sessionId, created: false })
          return
        }
      }
      if (!drive?.sessionAdapter) {
        sendJson(res, 501, { error: '会话适配未装配', code: 'ADMIN_CREATE_REJECTED' })
        return
      }
      const sessionId = await (adminCreateInFlight ??= (async () => {
        const created = await drive.sessionAdapter.ensureSession({ agentPreset: ADMIN_PRESET_ID })
        if (!created?.sessionId) throw Object.assign(new Error('会话创建未返回 sessionId'), { statusCode: 500 })
        await store.updateAdminBinding((current) => (!replace && current?.sessionId) ? current : { sessionId: created.sessionId, createdAt: now() })
        return created.sessionId
      })())
      sendJson(res, 200, { ok: true, sessionId, created: true })
    } catch (error) {
      sendJson(res, error.statusCode ?? 500, { error: error.message })
    } finally {
      adminCreateInFlight = null
    }
  }

  async function handleInterrupt(req, res) {
    try {
      if (rejectCrossOrigin(req, res)) return
      const raw = await readBody(req).catch((error) => { throw Object.assign(error, { statusCode: error.statusCode ?? 400 }) })
      let body = {}
      try {
        body = raw ? JSON.parse(raw) : {}
      } catch {
        sendJson(res, 400, { error: '请求体不是合法 JSON' })
        return
      }
      if (!body.commandId) {
        sendJson(res, 400, { error: '缺少 commandId' })
        return
      }
      const payloadHash = body.payloadHash ?? JSON.stringify(body)
      if (body.global) {
        const stopTargets = (await store.listAggregates()).filter(task => !['completed', 'cancelled'].includes(task.businessState)).map(task => task.taskId)
        let envelope = null
        await store.updateControl((control) => {
          envelope = stopAll(control, { commandId: body.commandId, payloadHash, sourceRef: body.sourceRef })
          if (!envelope.ok) return control
          if (envelope.result.replayed) return envelope.result.state
          const next = envelope.result.state
          const operationId = envelope.result.result.operationId
          return { ...next, stopOperations: { ...next.stopOperations, [operationId]: { ...next.stopOperations[operationId], taskIds: stopTargets } } }
        })
        if (!envelope.ok) {
          sendJson(res, 409, { error: envelope.message })
          return
        }
        const savedControl = await store.loadControl()
        const targetIds = savedControl.stopOperations[envelope.result.result.operationId].taskIds
        const tasks = (await Promise.all(targetIds.map(id => store.loadAggregate(id)))).filter(task => task && !['completed', 'cancelled'].includes(task.businessState))
        const outcomes = []
        for (const task of tasks) {
          try {
            const outcome = await interruptTask(store, task, { sessionAdapter: drive?.sessionAdapter, reason: 'global_stop', commandId: body.commandId })
            outcomes.push({ taskId: task.taskId, stopConfirmed: outcome.stopConfirmed === true, errors: [...(outcome.cancelErrors ?? []), ...(outcome.reconcileErrors ?? [])] })
          } catch (error) { outcomes.push({ taskId: task.taskId, stopConfirmed: false, errors: [{ message: error.message }] }) }
        }
        sendJson(res, 200, { accepted: true, globalStopGeneration: envelope.result.result.globalStopGeneration, replayed: envelope.result.replayed, pendingStop: outcomes.some((outcome) => !outcome.stopConfirmed), tasks: outcomes })
        return
      }
      if (!body.taskId) {
        sendJson(res, 400, { error: '缺少 taskId 或 global' })
        return
      }
      let receipt
      await store.updateControl((control) => {
        receipt = recordStopOperation(control, { commandId: body.commandId, taskId: body.taskId, payloadHash, sourceRef: body.sourceRef })
        return receipt.ok ? receipt.result.state : control
      })
      if (!receipt.ok) return sendJson(res, 409, { error: receipt.message })
      const aggregate = await store.loadAggregate(body.taskId)
      if (!aggregate) {
        sendJson(res, 404, { error: `任务不存在: ${body.taskId}` })
        return
      }
      const outcome = await interruptTask(store, aggregate, { sessionAdapter: drive?.sessionAdapter, reason: body.reason ?? 'user_interrupt', commandId: body.commandId })
      if (!outcome.ok) return sendJson(res, 409, { error: outcome.message })
      sendJson(res, 200, { accepted: true, controlState: outcome.aggregate.control.state, pendingStop: !outcome.stopConfirmed, cancelErrors: outcome.cancelErrors, reconcileErrors: outcome.reconcileErrors ?? [] })
    } catch (error) {
      sendJson(res, error.statusCode ?? 500, { error: error.message })
    }
  }

  async function handleSettings(req, res) {
    try {
      if (rejectCrossOrigin(req, res)) return
      if (req.method === 'GET') {
        sendJson(res, 200, store.settings ? await store.loadSettings() : createSettings(now))
        return
      }
      const raw = await readBody(req).catch((error) => { throw Object.assign(error, { statusCode: error.statusCode ?? 400 }) })
      let body = {}
      try {
        body = raw ? JSON.parse(raw) : {}
      } catch {
        sendJson(res, 400, { error: '请求体不是合法 JSON' })
        return
      }
      if (!store.settings) {
        sendJson(res, 501, { error: '设置存储未装配' })
        return
      }
      let envelope = null
      let current = null
      const outcome = await store.updateSettings((existing) => {
        current = existing
        envelope = saveSettings(existing, body)
        return envelope.ok ? envelope.result : existing
      })
      if (!envelope.ok) {
        sendJson(res, 409, { error: envelope.message, code: envelope.code, current })
        return
      }
      const saved = outcome?.values ? outcome : outcome?.result?.values ? outcome.result : outcome?.result
      sendJson(res, 200, saved)
    } catch (error) {
      sendJson(res, error.statusCode ?? 500, { error: error.message })
    }
  }

  // 测试入口允许创建、派发，不允许从请求体直接写入报告事实。
  async function handleDrive(req, res) {
    try {
      if (rejectCrossOrigin(req, res)) return
      if (!drive?.sessionAdapter) {
        sendJson(res, 501, { error: '会话适配未装配' })
        return
      }
      const raw = await readBody(req).catch((error) => { throw Object.assign(error, { statusCode: error.statusCode ?? 400 }) })
      let body = {}
      try {
        body = raw ? JSON.parse(raw) : {}
      } catch {
        sendJson(res, 400, { error: '请求体不是合法 JSON' })
        return
      }
      const control = await store.loadControl()
      if (body.action === 'create') {
        if (await store.loadAggregate(body.taskId)) {
          sendJson(res, 409, { error: `任务已存在: ${body.taskId}` })
          return
        }
        const created = createTask({
          taskId: body.taskId, title: body.title ?? body.taskId, projectWorkspaceId: body.projectWorkspaceId ?? 'default',
          definition: body.definition ?? { goal: body.goal ?? '测试目标' }, now,
        })
        if (!created.ok) {
          sendJson(res, 400, { error: created.message })
          return
        }
        let agg = created.result
        const def = defineWorkItem(agg, { workItemId: body.workItemId ?? 'w1', title: body.workItemTitle ?? '子项一' })
        if (!def.ok) {
          sendJson(res, 400, { error: def.message })
          return
        }
        agg = def.result.aggregate
        agg = authorizeTask(agg, { sourceMessageRef: { sessionId: 'drive', messageId: body.requestId ?? 'drive' } }).result.aggregate
        await store.saveAggregate(agg)
        sendJson(res, 200, { ok: true, taskId: agg.taskId, businessState: agg.businessState })
        return
      }
      if (body.action === 'dispatch') {
        const outcome = await drive.dispatch({
          ...body,
          runId: body.runId ?? randomUUID(),
          requestId: body.requestId ?? randomUUID(),
          phase: body.phase ?? 'implement',
          content: body.content ?? `任务 ${body.taskId}/${body.workItemId}`,
        })
        sendJson(res, 200, outcome)
        return
      }
      sendJson(res, 400, { error: 'action 须为 create/dispatch' })
    } catch (error) {
      sendJson(res, error.statusCode ?? 500, { error: error.message })
    }
  }

  const handleInterruptWithGate = handleInterrupt
  async function gatedInterrupt(req, res) {
    return drive?.withExecution ? drive.withExecution(() => handleInterruptWithGate(req, res)) : handleInterruptWithGate(req, res)
  }
  return { handleBoard, handleAdmin, handleInterrupt: gatedInterrupt, handleSettings, handleDrive }
}
