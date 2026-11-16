// board API v2:/api/boss-simulator/board 只读查询(查询投影契约)+ 写路由。
// 安全边界(全仓库约定):不做 host 认证;写路由闸门统一走 withRouteGate(宿主闸门 → 同源 → JSON CT)。
// 每条路由显式声明允许的方法,其余方法一律 405(不再"不看方法一律当写入口")。
import { randomUUID } from 'node:crypto'
import { queryBoard, projectTaskDetail } from './core/query.mjs'
import { stopAll, resumeAll, recordStopOperation } from './core/global-control.mjs'
import { createSettings, saveSettings } from './core/settings.mjs'
import { interruptTask, forceStop } from './core/orchestrator.mjs'
import { ADMIN_PRESET_ID } from './presets.mjs'
import { sendJson, readJsonBody, rejectMethod } from './http.mjs'

const METHODS = {
  board: ['GET'],
  admin: ['POST'],
  interrupt: ['POST'],
  settings: ['GET', 'POST'],
}

// 命令 payload 指纹:递归按键排序;键序重排不改变同一次命令的幂等身份
function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item) ?? 'null').join(',')}]`
  if (value && typeof value === 'object') {
    const entries = Object.keys(value).sort()
      .filter((key) => value[key] !== undefined)
      .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
    return `{${entries.join(',')}}`
  }
  return JSON.stringify(value)
}

export function createBoardApi({ store, drive, now = Date.now, serverEpoch = randomUUID() }) {
  async function handleBoard(req, res, url = new URL(req.url ?? '/api/boss-simulator/board', 'http://local')) {
    if (rejectMethod(req, res, METHODS.board)) return
    try {
      const [aggregates, control, adminBinding] = await Promise.all([store.listAggregates(), store.loadControl(), store.loadAdminBinding()])
      // 读面 stale 收敛:超过失联阈值的在飞 Run 按已断投影(不写盘),
      // 否则看板会随时间与写入时机不同给出两套事实(刷新前显示执行中,任何写动作后变中断)
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
      const numberParam = (name) => {
        if (!params.has(name)) return undefined
        const raw = params.get(name)
        return raw === '' ? Number.NaN : Number(raw)
      }
      const queried = queryBoard(aggregates, control, {
        workspaceId: params.get('workspaceId') ?? undefined,
        search: params.get('search') ?? undefined,
        cursor: params.get('cursor') ?? undefined,
        limit: params.has('limit') ? Number(params.get('limit')) : undefined,
        since: numberParam('since'),
        until: numberParam('until'),
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
    if (rejectMethod(req, res, METHODS.admin)) return
    try {
      const body = await readJsonBody(req, res)
      if (body === null) return
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
    if (rejectMethod(req, res, METHODS.interrupt)) return
    try {
      const body = await readJsonBody(req, res)
      if (body === null) return
      if (!body.commandId) {
        sendJson(res, 400, { error: '缺少 commandId' })
        return
      }
      // payload 指纹只由服务端计算:客户端 payloadHash 字段不可信且不参与指纹
      const { payloadHash: _clientPayloadHash, ...commandPayload } = body
      const payloadHash = stableStringify(commandPayload)
      // 强制停止:会话不可达时的显式出口;确认字符串与任务标识必须一致才执行
      if (body.confirm === 'force-stop') {
        if (!body.taskId || body.taskId !== body.confirmTaskId) {
          sendJson(res, 400, { error: '强制停止须同时给出 taskId 与相同的 confirmTaskId', code: 'CONFIRMATION_REQUIRED' })
          return
        }
        const outcome = await forceStop(store, body.taskId, {
          reason: body.reason ?? 'force_stop', confirm: true, commandId: body.commandId, payloadHash,
        })
        if (!outcome.ok) {
          sendJson(res, outcome.code === 'NOT_FOUND' ? 404 : 409, { error: outcome.message, code: outcome.code })
          return
        }
        // 响应按当前控制态给出:历史命令重放命中时任务可能已被恢复,不得继续宣称已停
        const controlState = outcome.aggregate.control.state
        sendJson(res, 200, {
          accepted: true, forceStopped: controlState === 'paused', controlState,
          pendingStop: controlState === 'stopping', cancelErrors: [], reconcileErrors: [], replayed: outcome.replayed === true,
        })
        return
      }
      // 全局解除:全局停止不是一次性闩锁;新任务在被停止后仍须有明确放行路径
      if (body.global && body.resume === true) {
        let envelope = null
        await store.updateControl((control) => {
          envelope = resumeAll(control, { commandId: body.commandId, payloadHash, sourceRef: body.sourceRef })
          return envelope.ok ? envelope.result.state : control
        })
        if (!envelope.ok) {
          sendJson(res, 409, { error: envelope.message })
          return
        }
        sendJson(res, 200, {
          accepted: true, globalResumed: true, globalStopped: false,
          globalStopGeneration: envelope.result.result.globalStopGeneration, replayed: envelope.result.replayed,
        })
        return
      }
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
      sendJson(res, 200, { accepted: true, controlState: outcome.aggregate.control.state, pendingStop: !outcome.stopConfirmed, cancelErrors: outcome.cancelErrors, reconcileErrors: outcome.reconcileErrors ?? [], forceStopAllowed: !outcome.stopConfirmed })
    } catch (error) {
      sendJson(res, error.statusCode ?? 500, { error: error.message })
    }
  }

  async function handleSettings(req, res) {
    if (rejectMethod(req, res, METHODS.settings)) return
    try {
      if (req.method === 'GET') {
        sendJson(res, 200, store.settings ? await store.loadSettings() : createSettings(now))
        return
      }
      const body = await readJsonBody(req, res)
      if (body === null) return
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

  const handleInterruptWithGate = handleInterrupt
  async function gatedInterrupt(req, res) {
    return drive?.withExecution ? drive.withExecution(() => handleInterruptWithGate(req, res)) : handleInterruptWithGate(req, res)
  }
  return { handleBoard, handleAdmin, handleInterrupt: gatedInterrupt, handleSettings }
}
