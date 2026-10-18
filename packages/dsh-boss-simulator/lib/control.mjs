import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import { z } from 'zod'
import { createBoardApi } from './board.mjs'
import { createSessionAdapter } from './session-adapter.mjs'
import { createRunFollowers } from './run-followers.mjs'
import { createRunService, createExecutionGate } from './run-service.mjs'
import { presetDefinitions } from './presets.mjs'
import { createTaskStore, updateSettingsRecord, loadAdminBinding, updateAdminBindingRecord } from './store.mjs'
import { createSettings } from './core/settings.mjs'

const TASK_TABLE_SCHEMA = z.any()
const DOMAIN_SPEC = defineDomain({ name: 'boss_simulator', version: 1, tables: { kv: domainTable(TASK_TABLE_SCHEMA) } })

let controlRuntime = null
export function setControlRuntime(runtime) { controlRuntime = runtime }
export function getControlRuntime() { return controlRuntime }

export function registerControl(ctx) {
  let stopped = false
  const followDisposers = new Set()
  ctx.inject(['storageDomain', 'webServer'], async (scope) => {
    if (stopped) return
    const domain = await scope.storageDomain.open(DOMAIN_SPEC)
    ctx.effect(() => () => domain.close())
    const table = domain.table('kv')
    const store = {
      ...createTaskStore(table),
      loadAdminBinding: () => loadAdminBinding(table),
      updateAdminBinding: (fn) => updateAdminBindingRecord(table, fn),
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
    ctx.effect(() => scope.webServer.register({ kind: 'exact', path: '/api/boss-simulator/board', handler: api.handleBoard }), 'boss-simulator board')
    ctx.effect(() => scope.webServer.register({ kind: 'exact', path: '/api/boss-simulator/admin', handler: api.handleAdmin }), 'boss-simulator admin')
    ctx.effect(() => scope.webServer.register({ kind: 'exact', path: '/api/boss-simulator/interrupt', handler: api.handleInterrupt }), 'boss-simulator interrupt')
    ctx.effect(() => scope.webServer.register({ kind: 'exact', path: '/api/boss-simulator/settings', handler: api.handleSettings }), 'boss-simulator settings')
    ctx.effect(() => scope.webServer.register({ kind: 'exact', path: '/api/boss-simulator/drive', handler: api.handleDrive }), 'boss-simulator drive')
    const runtime = {
      store, now: () => Date.now(), withExecution: driveRef.withExecution,
      get sessionAdapter() { return driveRef.sessionAdapter },
      followRuns: (...args) => driveRef.followRuns?.(...args),
      confirmResume: args => createRunService(runtime).confirmResume(args),
    }
    driveRef.dispatch = args => createRunService(runtime).dispatch(args)
    setControlRuntime(runtime)
    try {
      ctx.provide('bossSimulatorControl', { store })
    } catch (error) {
      console.warn('[boss-simulator] provide bossSimulatorControl failed:', String(error?.message ?? error))
    }
    ctx.inject(['agentPresets'], (presetScope) => {
      const registry = presetScope.agentPresets ?? presetScope
      const register = async () => {
        const definitions = presetDefinitions()
        if (definitions.length !== 1) throw new Error(`公司管理 preset 必须恰好一个,实际 ${definitions.length}`)
        for (const definition of definitions) {
          const dispose = await registry.register(definition)
          ctx.effect(() => dispose)
        }
        const roster = await registry.list().catch(() => [])
        console.warn('[boss-simulator] preset roster:', JSON.stringify(roster).slice(0, 400))
        for (const definition of definitions) {
          try {
            const resolved = await registry.resolve(definition.id)
            if (resolved.broken !== undefined) console.warn(`[boss-simulator] preset ${definition.id} broken:`, JSON.stringify(resolved.broken).slice(0, 300))
          } catch (error) {
            console.warn(`[boss-simulator] preset ${definition.id} resolve failed:`, String(error?.message ?? error).slice(0, 200))
          }
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
