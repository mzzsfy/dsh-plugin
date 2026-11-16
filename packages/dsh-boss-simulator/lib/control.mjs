import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import { z } from 'zod'
import { createBoardApi } from './board.mjs'
import { createTaskApi } from './task-api.mjs'
import { createSessionAdapter } from './session-adapter.mjs'
import { createRunFollowers } from './run-followers.mjs'
import { createRunService, createExecutionGate } from './run-service.mjs'
import { presetDefinitions } from './presets.mjs'
import { createTaskStore, updateSettingsRecord, loadAdminBinding, updateAdminBindingRecord } from './store.mjs'
import { createSettings } from './core/settings.mjs'
import { withRouteGate } from './route-gate.mjs'

const TASK_TABLE_SCHEMA = z.any()
const DOMAIN_SPEC = defineDomain({ name: 'boss_simulator', version: 1, tables: { kv: domainTable(TASK_TABLE_SCHEMA) } })

// onChange:看板写路径成功后的失效信号(由插件 apply 注入公共总线发布),业务模块不感知通道
export function registerControl(ctx, { onChange = () => {} } = {}) {
  let stopped = false
  const followDisposers = new Set()
  // 工作区候选:宿主注册表可用时以它为唯一来源,不可用时由任务记录回落
  let listWorkspaces = () => []
  ctx.inject(['workspaceRegistry'], (workspaceScope) => {
    const registry = workspaceScope.workspaceRegistry
    if (!registry) return
    listWorkspaces = () => registry.list().map((workspace) => ({
      workspaceId: String(workspace.id),
      title: workspace.title,
      path: workspace.path,
    }))
    workspaceScope.effect(() => () => { listWorkspaces = () => [] }, 'boss-simulator workspaces')
  })
  ctx.inject(['storageDomain', 'webServer'], async (scope) => {
    if (stopped) return
    const domain = await scope.storageDomain.open(DOMAIN_SPEC)
    ctx.effect(() => () => domain.close())
    const table = domain.table('kv')
    const store = {
      ...createTaskStore(table, { onChange }),
      loadAdminBinding: () => loadAdminBinding(table),
      updateAdminBinding: async (fn) => {
        const saved = await updateAdminBindingRecord(table, fn)
        onChange()
        return saved
      },
    }
    const listAggregates = () => store.listAggregates()
    const driveRef = { sessionAdapter: null, followRuns: null, withExecution: createExecutionGate() }
    ctx.inject(['sessionController'], (sessionScope) => {
      if (stopped) return
      const sessionAdapter = createSessionAdapter({ sessionController: sessionScope.sessionController ?? ctx.sessionController })
      driveRef.sessionAdapter = sessionAdapter
      const followers = createRunFollowers({ store, sessionAdapter })
      driveRef.followRuns = followers.follow
      const disposeFollow = () => followers.dispose()
      followDisposers.add(disposeFollow)
      sessionScope.effect(() => () => {
        driveRef.sessionAdapter = null
        followers.dispose()
        followDisposers.delete(disposeFollow)
      })
      followers.restore().catch(error => console.warn('[boss-simulator] restore followers failed:', error.message))
    })
    const settingsInitial = () => createSettings(() => Date.now())
    const unwrapSettings = (value) => value?.values ? value : null
    const api = createBoardApi({
      store: { ...store, listAggregates, settings: true, loadSettings: () => Promise.resolve(unwrapSettings(table.get('settings')) ?? settingsInitial()), updateSettings: (fn) => updateSettingsRecord(table, (current) => fn(unwrapSettings(current) ?? settingsInitial()), settingsInitial()) },
      drive: driveRef,
      now: () => Date.now(),
    })
    ctx.effect(() => scope.webServer.register({ kind: 'exact', path: '/api/boss-simulator/board', handler: withRouteGate(ctx, api.handleBoard) }), 'boss-simulator board')
    ctx.effect(() => scope.webServer.register({ kind: 'exact', path: '/api/boss-simulator/admin', handler: withRouteGate(ctx, api.handleAdmin) }), 'boss-simulator admin')
    ctx.effect(() => scope.webServer.register({ kind: 'exact', path: '/api/boss-simulator/interrupt', handler: withRouteGate(ctx, api.handleInterrupt) }), 'boss-simulator interrupt')
    ctx.effect(() => scope.webServer.register({ kind: 'exact', path: '/api/boss-simulator/settings', handler: withRouteGate(ctx, api.handleSettings) }), 'boss-simulator settings')
    // 人类操作入口:创建/授权/派发/删除与工作区候选,与管理员工具共用同一状态机
    const taskApi = createTaskApi({ store, drive: driveRef, listWorkspaces: () => listWorkspaces(), now: () => Date.now() })
    ctx.effect(() => scope.webServer.register({ kind: 'exact', path: '/api/boss-simulator/workspaces', handler: withRouteGate(ctx, taskApi.handleWorkspaces) }), 'boss-simulator workspaces')
    ctx.effect(() => scope.webServer.register({ kind: 'exact', path: '/api/boss-simulator/task', handler: withRouteGate(ctx, taskApi.handleTask) }), 'boss-simulator task')
    const runtime = {
      store, now: () => Date.now(), withExecution: (...args) => driveRef.withExecution(...args),
      get sessionAdapter() { return driveRef.sessionAdapter },
      followRuns: (...args) => driveRef.followRuns?.(...args),
      confirmResume: args => createRunService(runtime).confirmResume(args),
    }
    driveRef.dispatch = args => createRunService(runtime).dispatch(args)
    // 控制运行时只经 ctx 服务发布:行卸载即随 fiber 撤销,不存在模块级悬挂引用。
    // 工具行在使用点 ctx.get 取,不在 apply 时刻缓存(缓存会在重载后指向已关闭的存储域)。
    ctx.effect(() => {
      try {
        return ctx.provide('bossSimulatorControl', runtime)
      } catch (error) {
        console.warn('[boss-simulator] provide bossSimulatorControl failed:', String(error?.message ?? error))
        return () => {}
      }
    }, 'boss-simulator control runtime')
    ctx.inject(['agentPresets'], (presetScope) => {
      const registry = presetScope.agentPresets ?? presetScope
      const register = async () => {
        const definitions = presetDefinitions()
        if (definitions.length !== 1) throw new Error(`公司管理 preset 必须恰好一个,实际 ${definitions.length}`)
        for (const definition of definitions) {
          const dispose = await registry.register(definition)
          ctx.effect(() => dispose)
        }
      }
      register().catch((error) => console.warn('[boss-simulator] preset registration failed:', String(error?.message ?? error)))
    })
  })
  ctx.on('dispose', () => {
    stopped = true
    for (const disposeFollow of followDisposers) disposeFollow()
    followDisposers.clear()
  })
}

export { createSessionAdapter }
