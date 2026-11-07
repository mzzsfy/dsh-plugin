// dsh-bug-perf 浏览器半区:宿主缺陷的运行期兜底。
// 每个补丁独立安装、独立开关、独立失败:任何一项结构不匹配只记录原因,不影响页面与其它补丁。
window.__ModuleLoader__.load({
  id: '@mzzsfy/dsh-bug-perf',
  factory(require) {
    const GATEWAY_CLIENT_ID = '@deepseek-ai/dsh-api-gateway/client'
    const CONFIG_PATH = '/api/dsh-bug-perf/config'
    const CONFIG_TIMEOUT_MS = 2000
    const LOG_PREFIX = '[dsh-bug-perf]'

    // 与 src/config.mjs 同源;客户端不能 import 共享模块,内联副本由测试对表
    const DEFAULT_CONFIG = {
      restartCoalesce: { enabled: true, windowMs: 100 },
      terminalWatchdog: { enabled: true, checkMs: 2000, stallMs: 8000, cooldownMs: 60000 },
    }
    const LIMITS = {
      restartCoalesce: { windowMs: { min: 0, max: 2000 } },
      terminalWatchdog: {
        checkMs: { min: 250, max: 60000 },
        stallMs: { min: 1000, max: 600000 },
        cooldownMs: { min: 1000, max: 3600000 },
      },
    }

    const isSection = (value) => typeof value === 'object' && value !== null && !Array.isArray(value)
    const sectionOf = (value) => (isSection(value) ? value : {})
    const booleanOr = (value, fallback) => (typeof value === 'boolean' ? value : fallback)
    const numberWithin = (value, bounds, fallback) => {
      if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
      if (value < bounds.min) return fallback
      return value > bounds.max ? bounds.max : value
    }
    const normalizeConfig = (raw) => {
      const input = sectionOf(raw)
      const restart = sectionOf(input.restartCoalesce)
      const watchdog = sectionOf(input.terminalWatchdog)
      return {
        restartCoalesce: {
          enabled: booleanOr(restart.enabled, DEFAULT_CONFIG.restartCoalesce.enabled),
          windowMs: numberWithin(restart.windowMs, LIMITS.restartCoalesce.windowMs, DEFAULT_CONFIG.restartCoalesce.windowMs),
        },
        terminalWatchdog: {
          enabled: booleanOr(watchdog.enabled, DEFAULT_CONFIG.terminalWatchdog.enabled),
          checkMs: numberWithin(watchdog.checkMs, LIMITS.terminalWatchdog.checkMs, DEFAULT_CONFIG.terminalWatchdog.checkMs),
          stallMs: numberWithin(watchdog.stallMs, LIMITS.terminalWatchdog.stallMs, DEFAULT_CONFIG.terminalWatchdog.stallMs),
          cooldownMs: numberWithin(watchdog.cooldownMs, LIMITS.terminalWatchdog.cooldownMs, DEFAULT_CONFIG.terminalWatchdog.cooldownMs),
        },
      }
    }

    const timers = {
      now: () => performance.now(),
      setTimeout: (fn, ms) => setTimeout(fn, ms),
      clearTimeout: (id) => clearTimeout(id),
      setInterval: (fn, ms) => setInterval(fn, ms),
      clearInterval: (id) => clearInterval(id),
    }

    const RESTART_MARKER = Symbol.for('@mzzsfy/dsh-bug-perf/restart-coalesce')
    const WATCHDOG_MARKER = Symbol.for('@mzzsfy/dsh-bug-perf/terminal-watchdog')

    // 同一 Remote stream 在窗口内的重复 restart 合并为一次尾随执行:
    // restart 无参数, 最新一次即可代表期间的构建请求。
    const installRestartCoalesce = ({ RemoteStream, windowMs, timers: clock }) => {
      const proto = RemoteStream?.prototype
      if (proto === undefined || typeof proto.restart !== 'function') {
        return { installed: false, reason: 'RemoteStream.restart missing' }
      }
      if (proto[RESTART_MARKER] === true) return { installed: false, reason: 'already installed' }
      proto[RESTART_MARKER] = true
      const original = proto.restart
      const states = new WeakMap()
      proto.restart = function coalescedRestart() {
        const now = clock.now()
        let state = states.get(this)
        if (state === undefined) {
          state = { last: -Infinity, pending: undefined }
          states.set(this, state)
        }
        if (now - state.last >= windowMs) {
          if (state.pending !== undefined) {
            clock.clearTimeout(state.pending)
            state.pending = undefined
          }
          state.last = now
          return original.call(this)
        }
        if (state.pending === undefined) {
          state.pending = clock.setTimeout(() => {
            state.pending = undefined
            state.last = clock.now()
            try {
              original.call(this)
            } catch {
              // 实例已释放:尾随调用没有可重建的 generation
            }
          }, windowMs - (now - state.last))
        }
      }
      return { installed: true }
    }

    const installRestartCoalesceFromRequire = ({ requireImpl, windowMs, timers: clock }) => {
      try {
        const gateway = requireImpl(GATEWAY_CLIENT_ID)
        return installRestartCoalesce({ RemoteStream: gateway?.RemoteStream, windowMs, timers: clock })
      } catch (error) {
        return { installed: false, reason: `gateway client unavailable: ${error instanceof Error ? error.message : String(error)}` }
      }
    }

    // 终端视图健康判定:纯函数,便于单测与现场排障。
    // armed 表示该视图在本端曾持有写权;只读旁观视图不自动抢控制权。
    const watchdogTick = ({ view, state, options, now, visible }) => {
      const snapshot = view.state.getSnapshot()
      if (!visible) {
        state.changedAt = now
        return 'hidden'
      }
      if (view.revision !== state.revision) {
        state.revision = view.revision
        state.changedAt = now
        if (snapshot.writable === true) state.armed = true
        return 'progress'
      }
      if (snapshot.writable === true) {
        state.armed = true
        state.changedAt = now
        return 'progress'
      }
      if (!state.armed) {
        state.changedAt = now
        return 'idle'
      }
      if (snapshot.phase !== 'connected') {
        state.changedAt = now
        return 'not-connected'
      }
      if (view.pendingRender !== undefined) {
        state.changedAt = now
        return 'pending-render'
      }
      if (view.stream === undefined) {
        state.changedAt = now
        return 'no-stream'
      }
      if (now - state.changedAt < options.stallMs) return 'idle'
      if (now - state.healedAt < options.cooldownMs) return 'cooldown'
      state.healedAt = now
      state.armed = false
      return 'heal'
    }

    const installTerminalWatchdog = ({ holder, options, timers: clock, isVisible }) => {
      if (holder === undefined || typeof holder.view !== 'function') {
        return { installed: false, reason: 'webTerminals.view missing' }
      }
      if (holder[WATCHDOG_MARKER] === true) return { installed: false, reason: 'already installed' }
      holder[WATCHDOG_MARKER] = true
      const monitors = new WeakMap()
      const monitor = (view) => {
        if (view === undefined || monitors.has(view)) return
        const state = { revision: view.revision, changedAt: clock.now(), armed: false, healedAt: -Infinity }
        monitors.set(view, state)
        const interval = clock.setInterval(() => {
          try {
            const decision = watchdogTick({ view, state, options, now: clock.now(), visible: isVisible() })
            if (decision === 'heal') {
              console.warn(`${LOG_PREFIX} terminal stalled, reconnecting`, { sessionId: view.sessionId, id: view.id })
              view.connect()
            }
          } catch (error) {
            console.warn(`${LOG_PREFIX} watchdog tick failed:`, error instanceof Error ? error.message : String(error))
          }
        }, options.checkMs)
        view.lifetime?.signal?.addEventListener?.('abort', () => clock.clearInterval(interval), { once: true })
      }
      try {
        for (const views of holder.views?.values?.() ?? []) for (const view of views.values()) monitor(view)
      } catch {
        // 视图表结构随宿主版本变化:已有视图漏检,新建视图仍由包装覆盖
      }
      const original = holder.view.bind(holder)
      holder.view = (...args) => {
        const view = original(...args)
        monitor(view)
        return view
      }
      return { installed: true }
    }

    const loadConfig = async () => {
      try {
        const response = await fetch(CONFIG_PATH, {
          signal: AbortSignal.timeout(CONFIG_TIMEOUT_MS),
          headers: { accept: 'application/json' },
        })
        if (!response.ok) return undefined
        const body = await response.json()
        return body?.config
      } catch {
        // 旧宿主没有该路由:退回内联默认值,补丁照常按默认开关安装
        return undefined
      }
    }

    const installTerminalWatchdogWhenReady = (ctx, options, report) => {
      const start = (holder) => {
        try {
          report.features.terminalWatchdog = installTerminalWatchdog({
            holder,
            options,
            timers,
            isVisible: () => document.visibilityState !== 'hidden',
          })
        } catch (error) {
          report.features.terminalWatchdog = { installed: false, reason: error instanceof Error ? error.message : String(error) }
        }
      }
      if (typeof ctx.inject === 'function') {
        report.features.terminalWatchdog = { installed: false, reason: 'waiting for webTerminals' }
        ctx.inject(['webTerminals'], (sub) => {
          start(sub.webTerminals)
          console.info(`${LOG_PREFIX} terminal watchdog installed`, JSON.stringify(report.features.terminalWatchdog))
        })
        return
      }
      const holder = ctx.get?.('webTerminals')
      if (holder === undefined) {
        report.features.terminalWatchdog = { installed: false, reason: 'webTerminals unavailable' }
        return
      }
      start(holder)
    }

    const apply = (ctx) => {
      const report = { config: undefined, features: {} }
      window.__dshBugPerf = report
      void (async () => {
        const config = normalizeConfig(await loadConfig())
        report.config = config
        report.features.restartCoalesce = config.restartCoalesce.enabled
          ? installRestartCoalesceFromRequire({ requireImpl: require, windowMs: config.restartCoalesce.windowMs, timers })
          : { installed: false, reason: 'disabled' }
        if (config.terminalWatchdog.enabled) {
          installTerminalWatchdogWhenReady(ctx, config.terminalWatchdog, report)
        } else {
          report.features.terminalWatchdog = { installed: false, reason: 'disabled' }
        }
        console.info(`${LOG_PREFIX} applied`, JSON.stringify(report.features))
      })().catch((error) => {
        report.features.applyError = error instanceof Error ? error.message : String(error)
        console.warn(`${LOG_PREFIX} apply failed:`, report.features.applyError)
      })
    }

    return {
      inject: [],
      apply,
      __test: {
        DEFAULT_CONFIG,
        LIMITS,
        normalizeConfig,
        installRestartCoalesce,
        installRestartCoalesceFromRequire,
        watchdogTick,
        installTerminalWatchdog,
      },
    }
  },
})
