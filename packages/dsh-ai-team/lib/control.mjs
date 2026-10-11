// 控制室装配:存储域、路由、工具、角色预设。全部经 ctx.inject 门控,缺失即该面不启用。
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import { z } from 'zod'
import { createBoardApi } from './board.mjs'
import { createSessionAdapter } from './session-adapter.mjs'
import { registerToolRow } from './tools-row.mjs'
import { presetDefinitions } from './presets.mjs'
import { updateControlRecord, updateIndexRecord, updateSettingsRecord } from './store.mjs'
import { createGlobalControl } from './core/global-control.mjs'
import { applySessionEvent } from './core/orchestrator.mjs'
import { createSettings } from './core/settings.mjs'

const TASK_TABLE_SCHEMA = z.any()

// 域形态:单 kv 表承载任务聚合/索引/全局控制记录(update RMW 在域写链上原子);
// global 句柄只有 get/set 无 RMW,控制记录不走 global。
const DOMAIN_SPEC = defineDomain({
  name: 'ai_team',
  version: 1,
  tables: { kv: domainTable(TASK_TABLE_SCHEMA) },
})

const CONTROL_INITIAL = createGlobalControl(() => Date.now())

// 控制室运行时单例:组合行 realm 与控制室 realm 隔离,经模块闭包共享同一业务面
let controlRuntime = null
export function setControlRuntime(runtime) { controlRuntime = runtime }
export function getControlRuntime() { return controlRuntime }

export function registerControl(ctx) {
  let stopped = false
  ctx.inject(['storageDomain', 'webServer'], async (scope) => {
    if (stopped) return
    const domain = await scope.storageDomain.open(DOMAIN_SPEC)
    ctx.effect(() => () => domain.close())
    const table = domain.table('kv')
    const store = {
      loadAggregate: (id) => Promise.resolve(table.get(`task/${id}`)),
      saveAggregate: async (agg) => {
        await table.put(`task/${agg.taskId}`, agg)
        await updateIndexRecord(table, () => {
          const index = table.get('taskIndex')
          const ids = index?.ids ?? []
          return ids.includes(agg.taskId) ? index : { ids: [...ids, agg.taskId] }
        }, { ids: [] })
        return agg
      },
      updateAggregate: (id, fn) => table.update(`task/${id}`, fn),
      loadControl: () => Promise.resolve(table.get('control') ?? CONTROL_INITIAL),
      updateControl: (fn) => updateControlRecord(table, fn, CONTROL_INITIAL),
    }
    const listAggregates = async () => {
      const index = table.get('taskIndex')
      const ids = index?.ids ?? []
      return Promise.all(ids.map((id) => store.loadAggregate(id)))
    }

    // sessionController 挂宿主顶层 ctx(探针留档);经 inject 门控就绪后装配会话面,缺失即干净禁用
    const driveRef = { sessionAdapter: null, followRuns: null }
    ctx.inject(['sessionController'], (sessionScope) => {
      if (stopped) return
      const sessionAdapter = createSessionAdapter({ sessionController: sessionScope.sessionController ?? ctx.sessionController })
      driveRef.sessionAdapter = sessionAdapter
      // 事件归并:每会话一条 follow 流,turn 生命周期驱动 Run 状态(pendingStop 收敛依赖于此)
      const following = new Set()
      driveRef.followRuns = (taskId, sessionId) => {
        if (following.has(sessionId) || stopped) return
        following.add(sessionId)
        const controller = new AbortController()
        ;(async () => {
          for await (const event of sessionAdapter.followSessionEvents(sessionId, controller.signal)) {
            const agg = await store.loadAggregate(taskId)
            if (!agg) continue
            const runIds = Object.values(agg.runs).filter((r) => r.sessionId === sessionId && !['settled', 'rejected'].includes(r.state)).map((r) => r.runId)
            for (const runId of runIds) {
              const type = /turn[._\/-]?(start|begin)/i.test(event.type) ? 'turn.start' : /turn[._\/-]?(end|finish|complete|settle)/i.test(event.type) ? 'turn.end' : event.type
              const outcome = applySessionEvent(agg, { runId, type, at: event.time })
              if (outcome.ok && !outcome.replayed) await store.saveAggregate(outcome.aggregate)
            }
          }
        })().catch((error) => {
          if (!stopped) console.warn('[ai-team] follow loop ended:', String(error?.message ?? error).slice(0, 160))
        }).finally(() => following.delete(sessionId))
      }
    })
    const settingsInitial = () => createSettings(() => Date.now())
    // 历史污染自愈:记录若为信封形态(values 缺失)视同未初始化
    const unwrapSettings = (s) => (s && s.values ? s : null)
    const api = createBoardApi({
      store: { ...store, listAggregates, settings: true, loadSettings: () => Promise.resolve(unwrapSettings(table.get('settings')) ?? settingsInitial()), updateSettings: (fn) => updateSettingsRecord(table, (cur) => fn(unwrapSettings(cur) ?? settingsInitial()), settingsInitial()) },
      drive: driveRef,
      now: () => Date.now(),
    })
    ctx.effect(() => scope.webServer.register({ kind: 'exact', path: '/api/ai-team/board', handler: api.handleBoard }), 'ai-team board')
    ctx.effect(() => scope.webServer.register({ kind: 'exact', path: '/api/ai-team/interrupt', handler: api.handleInterrupt }), 'ai-team interrupt')
    ctx.effect(() => scope.webServer.register({ kind: 'exact', path: '/api/ai-team/settings', handler: api.handleSettings }), 'ai-team settings')
    ctx.effect(() => scope.webServer.register({ kind: 'exact', path: '/api/ai-team/drive', handler: api.handleDrive }), 'ai-team drive')
    // 业务工具注册进全局工具面(经 inject(['tools']) 门控,同 rs-workflow 形态);guard 按预设精确 id 拒绝非受管会话(tools-row)
    ctx.inject(['tools'], (toolsScope) => {
      ctx.effect(registerToolRow(toolsScope, { store, now: () => Date.now() }))
    })
    // 控制室运行时挂模块级单例:组合行(agent realm isolate)不可注入跨 realm 服务,经同模块闭包触达
    setControlRuntime({ store })
    try {
      ctx.provide('aiTeamControl', { store })
    } catch (error) {
      console.warn('[ai-team] provide aiTeamControl failed:', String(error?.message ?? error))
    }
    // 角色预设:管理员/调度员/实施(persona 角色边界 + 业务工具行)
    ctx.inject(['agentPresets'], (presetScope) => {
      console.warn('[ai-team] agentPresets inject fired')
      const registry = presetScope.agentPresets ?? presetScope
      const register = () => Promise.all(presetDefinitions().map(async (definition) => {
        const dispose = await registry.register(definition)
        ctx.effect(() => dispose)
      }))
      register().then(async () => {
        // 启动自检:预设清单与激活诊断落日志(broken 即组合装载失败,受管会话会静默回退缺省组合)
        const roster = await registry.list().catch(() => [])
        console.warn('[ai-team] preset roster:', JSON.stringify(roster).slice(0, 400))
        for (const definition of presetDefinitions()) {
          try {
            const resolved = await registry.resolve(definition.id)
            if (resolved.broken !== undefined) console.warn(`[ai-team] preset ${definition.id} broken:`, JSON.stringify(resolved.broken).slice(0, 300))
          } catch (error) {
            console.warn(`[ai-team] preset ${definition.id} resolve failed:`, String(error?.message ?? error).slice(0, 200))
          }
        }
      })
    })
  })
  ctx.on('dispose', () => { stopped = true })
}

// 受管会话登记与事件归并装配在派发管线落地后接线(preset 组合提供角色会话)。
export { createSessionAdapter }
