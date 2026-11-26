const TITLES = {
  schedule_create: 'Create a scheduled task',
  schedule_list: 'List scheduled tasks',
  schedule_view: 'View one scheduled task',
  schedule_edit: 'Update, pause, resume, or delete one scheduled task',
}

function scheduleDefinitions(tools, agent) {
  const definitions = []
  for (const [name, title] of Object.entries(TITLES)) {
    const definition = tools.get(name, agent)
    const handler = definition && Object.getOwnPropertyDescriptor(definition, 'execute')
    if (!handler?.writable || typeof handler.value !== 'function' ||
      typeof definition.description !== 'string' || !definition.description.startsWith(title) ||
      typeof definition.presentCall !== 'function') return []
    definitions.push(definition)
  }
  return definitions
}

export function createOverlayManager(ctx, { readEnabled, listAgents, notifyChange, logger }) {
  const tools = ctx.get('tools')
  const mounted = new Map()
  // 记录「被他人替换后我们让位」的定义及其让位时的原执行入口:恢复成原入口时重新接管
  const yielded = new WeakMap()
  let disposed = false
  const debug = { enabled: false, agents: 0, wanted: 0, error: null }
  // 告警按「失效态种类」去重:命中数或 agent 数变化不该重复刷屏,恢复后复位
  let warnedKey = ''
  const warn = (message, error) => {
    logger?.warn?.('[cron-board] ' + message + ': ' + String(error?.message ?? error))
    debug.error = message + ': ' + String(error?.message ?? error)
  }
  const restore = (definition, { execute, wrapped }) => {
    mounted.delete(definition)
    if (definition.execute !== wrapped) return
    try { definition.execute = execute } catch (error) {
      warn('自动化工具执行入口无法恢复', error)
    }
  }

  function reconcile(created, retiring) {
    if (disposed) return
    const wanted = new Set()
    debug.enabled = readEnabled()
    debug.agents = 0
    debug.error = null
    if (debug.enabled && typeof tools?.get === 'function') {
      const agents = listAgents()
      debug.agents = agents.length
      for (const agent of [...agents, created]) {
        if (!agent || agent === retiring) continue
        for (const definition of scheduleDefinitions(tools, agent)) wanted.add(definition)
      }
    }
    debug.wanted = wanted.size
    // 开关开着、也有 agent,却一个官方定义都没命中:识别失效需要留痕,否则表现为静默不生效
    const key = debug.enabled && debug.agents > 0 && wanted.size === 0 ? 'no-match' : ''
    if (key !== warnedKey) {
      warnedKey = key
      if (key) logger?.warn?.('[cron-board] 覆盖模式未命中官方 schedule_* 定义(agents=' + debug.agents + '),检查宿主工具描述前缀与 presentCall 契约')
    }
    for (const [definition, handlers] of mounted) {
      if (definition.execute !== handlers.wrapped) yielded.set(definition, handlers.execute)
      if (!wanted.has(definition) || yielded.has(definition)) restore(definition, handlers)
    }
    for (const definition of wanted) {
      if (mounted.has(definition)) continue
      const restored = yielded.get(definition)
      // 宿主侧恢复原执行入口后清除让位记录,否则本次进程内再不会接管
      if (restored !== undefined) {
        if (definition.execute === restored) yielded.delete(definition)
        else continue
      }
      const execute = definition.execute
      const write = definition.name === 'schedule_create' || definition.name === 'schedule_edit'
      const wrapped = async function (args, exec) {
        const result = await execute.call(this, args, exec)
        if (write && result?.id && !result.code && !disposed && readEnabled() && definition.execute === wrapped) {
          try { notifyChange?.() } catch (error) {
            warn('自动化任务刷新通知失败', error)
          }
        }
        return result
      }
      // 保留宿主注册与准入身份。额外注册同名工具会绕过继承层的限制。
      try {
        definition.execute = wrapped
        mounted.set(definition, { execute, wrapped })
      } catch (error) {
        warn('自动化工具覆盖失败', error)
      }
    }
  }

  // 对账是观测者:异常不得沿宿主 emit 传回 agent/created 的串行宣告或 tools/change
  const guarded = (created, retiring) => {
    try { reconcile(created, retiring) } catch (error) {
      warn('自动化工具对账失败', error)
    }
  }
  const off = [
    ctx.on('tools/change', () => guarded()),
    ctx.on('agent/created', ({ agent }) => guarded(agent)),
    ctx.on('agent/disposed', ({ agent }) => guarded(undefined, agent)),
  ]
  return {
    get active() { return mounted.size > 0 },
    get debug() { return debug },
    reconcile: () => guarded(),
    dispose() {
      if (disposed) return
      disposed = true
      for (const remove of off) remove()
      for (const [definition, handlers] of mounted) restore(definition, handlers)
    },
  }
}