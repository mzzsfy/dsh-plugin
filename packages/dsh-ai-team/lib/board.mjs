// board API v2:/api/ai-team/board 只读查询(查询投影契约)+/api/ai-team/interrupt 写路由。
// 安全边界(全仓库约定):不做 host 认证;写路由跨源防护以 Origin 同源比对为上限。
import { queryBoard, projectTaskDetail } from './core/query.mjs'
import { stopAll, recordStopOperation } from './core/global-control.mjs'
import { stopTask, confirmStopped, hasActiveRuns, submitReport } from './core/task.mjs'
import { createSettings, saveSettings } from './core/settings.mjs'
import { dispatchRun, interruptTask } from './core/orchestrator.mjs'
import { createTask, defineWorkItem, authorizeTask } from './core/task.mjs'

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

export function createBoardApi({ store, drive, now = Date.now }) {
  async function handleBoard(req, res, url = new URL(req.url ?? '/api/ai-team/board', 'http://local')) {
    try {
      const [aggregates, control] = await Promise.all([store.listAggregates(), store.loadControl()])
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
      })
      if (!queried.ok) {
        sendJson(res, 400, { error: queried.message })
        return
      }
      sendJson(res, 200, queried.result)
    } catch (error) {
      sendJson(res, error.statusCode ?? 500, { error: error.message })
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
        let envelope = null
        await store.updateControl((control) => {
          envelope = stopAll(control, { commandId: body.commandId, payloadHash, sourceRef: body.sourceRef })
          return envelope.result.state
        })
        if (!envelope.ok) {
          sendJson(res, 409, { error: envelope.message })
          return
        }
        sendJson(res, 200, { accepted: true, globalStopGeneration: envelope.result.result.globalStopGeneration, replayed: envelope.result.replayed })
        return
      }
      if (!body.taskId) {
        sendJson(res, 400, { error: '缺少 taskId 或 global' })
        return
      }
      await store.updateControl((control) => recordStopOperation(control, { commandId: body.commandId, taskId: body.taskId, payloadHash, sourceRef: body.sourceRef }).result.state)
      const aggregate = await store.loadAggregate(body.taskId)
      if (!aggregate) {
        sendJson(res, 404, { error: `任务不存在: ${body.taskId}` })
        return
      }
      const stopped = stopTask(aggregate, { reason: body.reason ?? 'user_interrupt' })
      if (!stopped.ok) {
        sendJson(res, 409, { error: stopped.message })
        return
      }
      // 在途 Run:取消会话 turn 与队列(cancelSession),事件归并负责终态收敛
      if (drive?.sessionAdapter && hasActiveRuns(stopped.result.aggregate)) {
        const outcome = await interruptTask(store, stopped.result.aggregate, { sessionAdapter: drive.sessionAdapter })
        if (outcome.ok) {
          await store.saveAggregate(outcome.aggregate)
          const final2 = await store.loadAggregate(body.taskId)
          sendJson(res, 200, { accepted: true, controlState: final2.control.state, pendingStop: hasActiveRuns(final2), cancelErrors: outcome.cancelErrors })
          return
        }
      }
      await store.saveAggregate(stopped.result.aggregate)
      const noActive = !hasActiveRuns(stopped.result.aggregate)
      const confirmed = noActive ? confirmStopped(stopped.result.aggregate) : null
      const final = confirmed?.ok ? confirmed.result.aggregate : stopped.result.aggregate
      if (confirmed?.ok) await store.saveAggregate(final)
      sendJson(res, 200, { accepted: true, controlState: final.control.state, pendingStop: !noActive })
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

  // 测试编排入口(PKG-2: 驱动执行/停止链证明,非正式角色自主调度):
  // dispatch=经受管会话真实派发;report=以受管角色身份提交结构化报告
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
      if (body.action === 'dispatch' || body.action === 'report') {
        const aggregate = await store.loadAggregate(body.taskId)
        if (!aggregate) {
          sendJson(res, 404, { error: `任务不存在: ${body.taskId}` })
          return
        }
      }
      if (body.action === 'dispatch') {
        const aggregate = await store.loadAggregate(body.taskId)
        const outcome = await dispatchRun(store, aggregate, {
          runId: body.runId ?? `run-${now().toString(36)}`,
          workItemId: body.workItemId,
          phase: body.phase ?? 'implement',
          actorRole: body.phase === 'accept' ? 'reviewer' : 'executor',
          requestId: body.requestId ?? `req-${now().toString(36)}`,
          content: body.content ?? `任务 ${body.taskId}/${body.workItemId}`,
          presetId: body.presetId ?? 'ai-team-worker',
          sessionAdapter: drive.sessionAdapter,
          globalControl: control,
          sessionWorkspaceId: body.sessionWorkspaceId,
          sessionCwd: body.sessionCwd,
        })
        if (!outcome.ok) {
          sendJson(res, 409, { error: outcome.message, code: outcome.code, debugStack: outcome.stack?.split('\n').slice(0, 8) })
          return
        }
        await store.saveAggregate(outcome.aggregate)
        drive?.followRuns?.(body.taskId, outcome.sessionId)
        sendJson(res, 200, { ok: true, runId: outcome.runId, sessionId: outcome.sessionId, state: outcome.aggregate.runs[outcome.runId]?.state })
        return
      }
      if (body.action === 'prompt') {
        if (!drive.sessionAdapter) return sendJson(res, 501, { error: '会话适配未装配' })
        let sessionId = body.sessionId
        if (!sessionId && body.preset) {
          const created = await drive.sessionAdapter.ensureSession({ cwd: body.sessionCwd ?? '.', agentPreset: body.preset })
          sessionId = created?.sessionId
          if (!sessionId) {
            sendJson(res, 500, { error: '会话创建未返回 sessionId', debug: JSON.stringify(created)?.slice(0, 200) })
            return
          }
        }
        if (!sessionId) return sendJson(res, 400, { error: '缺少 sessionId 或 preset' })
        const outcome = await drive.sessionAdapter.dispatchPrompt({
          sessionId,
          requestId: body.requestId ?? `req-${now().toString(36)}`,
          mode: body.mode === 'steer' ? 'steer' : 'queue',
          content: typeof body.content === 'string' ? [{ type: 'text', text: body.content }] : body.content ?? [{ type: 'text', text: '继续' }],
        })
        sendJson(res, 200, { ok: true, accepted: outcome?.accepted ?? false, turnId: outcome?.turnId ?? null })
        return
      }
      if (body.action === 'report') {
        const aggregate = await store.loadAggregate(body.taskId)
        const outcome = submitReport(aggregate, {
          reportId: body.reportId ?? `rep-${now().toString(36)}`,
          runId: body.runId,
          verdict: body.verdict,
          coveredCriterionIds: body.coveredCriterionIds ?? [],
          issues: body.issues ?? [],
        })
        if (!outcome.ok) {
          sendJson(res, 409, { error: outcome.message, code: outcome.code })
          return
        }
        await store.saveAggregate(outcome.result.aggregate)
        sendJson(res, 200, { ok: true, businessState: outcome.result.aggregate.businessState })
        return
      }
      sendJson(res, 400, { error: 'action 须为 create/dispatch/report' })
    } catch (error) {
      sendJson(res, error.statusCode ?? 500, { error: error.message })
    }
  }

  return { handleBoard, handleInterrupt, handleSettings, handleDrive }
}
