// dsh-bug-perf 浏览器半区:宿主缺陷的运行期兜底。
// 每个补丁独立安装、独立开关、独立失败:任何一项结构不匹配只记录原因,不影响页面与其它补丁。
window.__ModuleLoader__.load({
  id: '@mzzsfy/dsh-bug-perf',
  factory(require) {
    const GATEWAY_CLIENT_ID = '@deepseek-ai/dsh-api-gateway/client'
    const CONFIG_PATH = '/api/dsh-bug-perf/config'
    const CONFIG_TIMEOUT_MS = 2000
    const LOG_PREFIX = '[dsh-bug-perf]'
    const PKG_ID = '@mzzsfy/dsh-bug-perf'
    const NAMESPACE = 'bug-perf'
    const DIAG_SAMPLE_MS = 5000
    const DIAG_MAX_SAMPLES = 720
    const DIAG_DEFAULT_REPORT_EVERY = 12

    // 设置卡片依赖 React;缺失时只跳过 UI,不影响其余补丁
    let React
    try {
      React = require('react')
    } catch {
      React = undefined
    }

    // 与 src/config.mjs 同源;客户端不能 import 共享模块,内联副本由测试对表
    const DEFAULT_CONFIG = {
      configVersion: 2,
      restartCoalesce: { enabled: true, windowMs: 100 },
      terminalWatchdog: { enabled: true, checkMs: 2000, stallMs: 8000, cooldownMs: 60000 },
      socketKeepAlive: { enabled: true, intervalMs: 1500 },
      stuckSession: { enabled: true, checkMs: 3000, stallMs: 60000, reconnect: true, maxReconnectAttempts: 2, reconnectIntervalMs: 120000 },
      jobStreamLimit: { enabled: true, base: 32, max: 48 },
      sessionWindow: { enabled: true, maxMessages: 200, minMessages: 30, minTurns: 2 },
      listSlim: { enabled: true },
      diag: { enabled: false, reportEvery: DIAG_DEFAULT_REPORT_EVERY },
    }
    const LIMITS = {
      restartCoalesce: { windowMs: { min: 0, max: 2000 } },
      terminalWatchdog: {
        checkMs: { min: 250, max: 60000 },
        stallMs: { min: 1000, max: 600000 },
        cooldownMs: { min: 1000, max: 3600000 },
      },
      socketKeepAlive: { intervalMs: { min: 500, max: 60000 } },
      stuckSession: {
        checkMs: { min: 250, max: 60000 },
        stallMs: { min: 1000, max: 600000 },
        maxReconnectAttempts: { min: 1, max: 20 },
        reconnectIntervalMs: { min: 500, max: 600000 },
      },
      jobStreamLimit: { base: { min: 4, max: 256 }, max: { min: 4, max: 512 } },
      sessionWindow: { maxMessages: { min: 20, max: 500 }, minMessages: { min: 5, max: 200 }, minTurns: { min: 1, max: 50 } },
      diag: { reportEvery: { min: 1, max: DIAG_MAX_SAMPLES } },
    }

    const isSection = (value) => typeof value === 'object' && value !== null && !Array.isArray(value)
    const sectionOf = (value) => (isSection(value) ? value : {})
    const booleanOr = (value, fallback) => (typeof value === 'boolean' ? value : fallback)
    const numberWithin = (value, bounds, fallback) => {
      if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
      if (value < bounds.min) return fallback
      return value > bounds.max ? bounds.max : value
    }
    const numberClamped = (value, bounds, fallback) => {
      if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
      return Math.min(bounds.max, Math.max(bounds.min, value))
    }
    // 交给宿主的计数参数必须是正安全整数:小数截断后按 numberWithin 规则收敛
    const integerWithin = (value, bounds, fallback) => {
      if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
      return numberWithin(Math.trunc(value), bounds, fallback)
    }
    const normalizeConfig = (raw) => {
      const input = sectionOf(raw)
      const restart = sectionOf(input.restartCoalesce)
      const watchdog = sectionOf(input.terminalWatchdog)
      const keepAlive = sectionOf(input.socketKeepAlive)
      const stuck = sectionOf(input.stuckSession)
      const jobLimit = sectionOf(input.jobStreamLimit)
      const sessionWindow = sectionOf(input.sessionWindow)
      const listSlim = sectionOf(input.listSlim)
      const diag = sectionOf(input.diag)
      return {
        configVersion: Number.isInteger(input.configVersion) && input.configVersion > 0 ? input.configVersion : DEFAULT_CONFIG.configVersion,
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
        socketKeepAlive: {
          enabled: booleanOr(keepAlive.enabled, DEFAULT_CONFIG.socketKeepAlive.enabled),
          intervalMs: numberWithin(keepAlive.intervalMs, LIMITS.socketKeepAlive.intervalMs, DEFAULT_CONFIG.socketKeepAlive.intervalMs),
        },
        jobStreamLimit: {
          enabled: booleanOr(jobLimit.enabled, DEFAULT_CONFIG.jobStreamLimit.enabled),
          base: Math.min(
            numberWithin(jobLimit.base, LIMITS.jobStreamLimit.base, DEFAULT_CONFIG.jobStreamLimit.base),
            numberWithin(jobLimit.max, LIMITS.jobStreamLimit.max, DEFAULT_CONFIG.jobStreamLimit.max),
          ),
          max: numberWithin(jobLimit.max, LIMITS.jobStreamLimit.max, DEFAULT_CONFIG.jobStreamLimit.max),
        },
        stuckSession: {
          enabled: booleanOr(stuck.enabled, DEFAULT_CONFIG.stuckSession.enabled),
          checkMs: numberWithin(stuck.checkMs, LIMITS.stuckSession.checkMs, DEFAULT_CONFIG.stuckSession.checkMs),
          stallMs: numberWithin(stuck.stallMs, LIMITS.stuckSession.stallMs, DEFAULT_CONFIG.stuckSession.stallMs),
          reconnect: booleanOr(stuck.reconnect, DEFAULT_CONFIG.stuckSession.reconnect),
          maxReconnectAttempts: numberWithin(stuck.maxReconnectAttempts, LIMITS.stuckSession.maxReconnectAttempts, DEFAULT_CONFIG.stuckSession.maxReconnectAttempts),
          reconnectIntervalMs: numberWithin(stuck.reconnectIntervalMs, LIMITS.stuckSession.reconnectIntervalMs, DEFAULT_CONFIG.stuckSession.reconnectIntervalMs),
        },
        sessionWindow: {
          enabled: booleanOr(sessionWindow.enabled, DEFAULT_CONFIG.sessionWindow.enabled),
          maxMessages: integerWithin(sessionWindow.maxMessages, LIMITS.sessionWindow.maxMessages, DEFAULT_CONFIG.sessionWindow.maxMessages),
          minMessages: integerWithin(sessionWindow.minMessages, LIMITS.sessionWindow.minMessages, DEFAULT_CONFIG.sessionWindow.minMessages),
          minTurns: integerWithin(sessionWindow.minTurns, LIMITS.sessionWindow.minTurns, DEFAULT_CONFIG.sessionWindow.minTurns),
        },
        listSlim: {
          enabled: booleanOr(listSlim.enabled, DEFAULT_CONFIG.listSlim.enabled),
        },
        diag: {
          enabled: booleanOr(diag.enabled, DEFAULT_CONFIG.diag.enabled),
          reportEvery: numberClamped(diag.reportEvery, LIMITS.diag.reportEvery, DEFAULT_CONFIG.diag.reportEvery),
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

    const PLUGIN_ID = '@mzzsfy/dsh-bug-perf'
    const REMOTE_MUX_PATH = '/api/remote.mux'
    const KEEPALIVE_MARKER = Symbol.for('@mzzsfy/dsh-bug-perf/socket-keepalive')
    const STUCK_MARKER = Symbol.for('@mzzsfy/dsh-bug-perf/stuck-session')
    const KEEPALIVE_STREAM_PREFIX = 'dsh-bug-perf-keepalive'
    const FRAME_TYPE_PREFIX = '{"type":"'
    const STREAM_ID_KEY = '"streamId":"'
    const ENDPOINT_KEY = '"endpoint":"'
    // 事件循环探测: 延迟超过该值视为主线程被占满; 单次渲染长任务不算假死
    const DIAG_BLOCK_MS = 5000
    const DIAG_PROBE_MS = 2000
    const DIAG_REPORT_PATH = '/api/dsh-bug-perf/diag'
    // 定时器检查节拍: 实际发送间隔由可变的 intervalMs 决定
    const KEEPALIVE_TICK_MS = 500
    // 只有协议级关闭码才可能是宿主拒绝保活帧; 链路断开与主动关闭不计入
    const PROTOCOL_CLOSE_CODES = Object.freeze([1002, 1003, 1007, 1008, 1009, 1011])
    const BREAKER_STRIKES = 2
    // 连接健康存活这么多倍间隔后清零累计, 避免历史事件把补丁永久禁用
    const BREAKER_RECOVER_INTERVALS = 10
    const STUCK_NOTICE_ID = 'dsh-bug-perf-stuck'
    const STUCK_HINT_TEXTS = ['载入历史…', 'Loading history…']
    const STUCK_MESSAGE_SELECTOR = '[data-chat-flow-key]'
    const STUCK_CSS = [
      '.bp-stuck{--bp-bg:var(--dsw-alias-bg-layer-1);--bp-border-strong:var(--dsw-alias-border-l3);--bp-text:var(--dsw-alias-label-primary);--bp-text-sub:var(--dsw-alias-label-secondary);--bp-accent:var(--dsw-alias-brand-primary);--bp-hover:var(--dsw-alias-interactive-bg-hover);--bp-radius-sm:var(--dsw-radius-sm);--bp-shadow:var(--dsw-shadow-lv3);position:fixed;top:16px;left:50%;transform:translateX(-50%);z-index:2147483000;display:flex;align-items:center;gap:8px;padding:8px 12px;border-radius:var(--bp-radius-sm);background:var(--bp-bg);border:.5px solid var(--bp-border-strong);box-shadow:var(--bp-shadow);color:var(--bp-text);font-size:12px;line-height:18px}',
      '.bp-stuck__text{color:var(--bp-text-sub)}',
      '.bp-stuck__action{min-height:24px;padding:0 10px;border-radius:var(--bp-radius-sm);border:1px solid var(--bp-border-strong);background:transparent;color:var(--bp-accent);font:inherit;font-size:12px;line-height:18px;cursor:pointer}',
      '.bp-stuck__action:hover{background:var(--bp-hover)}',
      '.bp-stuck__action:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:2px}',
    ].join('')

    // 只读诊断: 记录帧计数、消息速率、活跃流与页面规模, 用于定位“越用越卡”。
    // 不解析完整帧、不改动任何流, 采样保留最近 DIAG_MAX_SAMPLES 个点。
    const createDiag = (clock) => ({
      startedAt: clock.now(),
      enabled: false,
      sockets: [],
      samples: [],
      longTasks: [],
      errors: [],
      totals: { opened: 0, closed: 0, messages: 0, sent: 0 },
    })

    const activeStreams = (sockets) => {
      let total = 0
      for (const socket of sockets) {
        for (const count of Object.values(socket.streams)) total += count
      }
      return total
    }

    const reportDiag = (win, diag) => {
      const fetchImpl = win.fetch
      if (typeof fetchImpl !== 'function') return
      const payload = {
        at: Date.now(),
        path: win.location?.pathname ?? '',
        totals: diag.totals,
        last: diag.samples.slice(-6),
        blockedMs: diag.blockedMs ?? 0,
        longTasks: diag.longTasks.slice(-8),
        errors: diag.errors.slice(-4),
      }
      try {
        void fetchImpl(`${DIAG_REPORT_PATH}?d=${encodeURIComponent(JSON.stringify(payload))}`, { cache: 'no-store', keepalive: true }).catch(() => { })
      } catch {
        // 上报失败不影响页面
      }
    }

    const startDiagSampling = ({ win, clock, diag, doc }) => {
      const heapq = () => {
        const memory = win.performance?.memory
        return memory === undefined ? undefined : Math.round(memory.usedJSHeapSize / 1048576)
      }
      const sample = () => {
        const live = diag.sockets.filter((socket) => !socket.closed)
        diag.samples.push({
          t: Math.round(clock.now()),
          heapMB: heapq(),
          nodes: doc?.querySelectorAll?.('*').length,
          sockets: diag.sockets.length,
          liveSockets: live.length,
          activeStreams: activeStreams(live),
          messages: diag.totals.messages,
          sent: diag.totals.sent,
        })
        if (diag.samples.length > DIAG_MAX_SAMPLES) diag.samples.shift()
      }
      sample()
      const timer = clock.setInterval(sample, DIAG_SAMPLE_MS)
      const schedule = win.setTimeout
      if (typeof schedule === 'function') {
        clock.setInterval(() => {
          const started = clock.now()
          schedule(() => {
            const delay = clock.now() - started
            if (delay < DIAG_BLOCK_MS) return
            diag.blockedAt = clock.now()
            diag.blockedMs = Math.round(delay)
          }, 0)
        }, DIAG_PROBE_MS)
      }
      const observer = win.PerformanceObserver === undefined ? undefined : new win.PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          diag.longTasks.push({ t: Math.round(clock.now()), ms: Math.round(entry.duration) })
          if (diag.longTasks.length > DIAG_MAX_SAMPLES) diag.longTasks.shift()
        }
      })
      try { observer?.observe({ entryTypes: ['longtask'] }) } catch { }
      win.addEventListener?.('error', (event) => {
        diag.errors.push(String(event?.message ?? '').slice(0, 200))
        if (diag.errors.length > DIAG_MAX_SAMPLES) diag.errors.shift()
      })
      return { timer, observer }
    }

    // 采样与上报分离:关闭上报只停请求,内存采样继续供现场排查(window.__dshBugPerf)
    const startDiagReporting = ({ win, clock, diag, options }) => {
      if (options?.enabled !== true) {
        diag.enabled = false
        return { enabled: false, reason: 'disabled' }
      }
      const everyMs = options.reportEvery * DIAG_SAMPLE_MS
      const timer = clock.setInterval(() => reportDiag(win, diag), everyMs)
      diag.enabled = true
      return { enabled: true, timer }
    }

    // 宿主心跳为固定短周期且丢两次即 terminate, 经反代时 pong 常被链路吞掉。
    // 客户端在会话流连接上按间隔发一条未知 streamId 的 item 帧: 宿主收到任意帧都会刷新存活标记,
    // 未知 streamId 的 item 在宿主侧被忽略, 不改动任何流的状态。
    // 只在连接空闲(客户端自己没有上行帧)时补帧; 覆盖范围仅限安装之后新建的连接。
    const installSocketKeepAlive = ({ win, options, clock, onDisabled, diag }) => {
      const Native = win?.WebSocket
      if (typeof Native !== 'function') return { installed: false, reason: 'WebSocket unavailable' }
      if (options?.enabled === false) return { installed: false, reason: 'disabled' }
      if (Native[KEEPALIVE_MARKER] !== undefined) return { installed: false, reason: 'already installed' }
      const state = { intervalMs: options.intervalMs, timers: new Set(), strikes: 0, disabled: false, disabledReason: undefined }
      let Wrapped
      const disable = (reason) => {
        if (state.disabled) return
        state.disabled = true
        state.disabledReason = reason
        for (const id of state.timers) clock.clearInterval(id)
        state.timers.clear()
        if (win.WebSocket === Wrapped) win.WebSocket = Native
        if (Native[KEEPALIVE_MARKER] === Wrapped) delete Native[KEEPALIVE_MARKER]
        console.warn(`${LOG_PREFIX} socket keepalive disabled: ${reason}`)
        onDisabled?.(reason)
      }
      const nextStreamId = () => `${KEEPALIVE_STREAM_PREFIX}-${clock.now()}-${Math.random().toString(36).slice(2)}`
      // 只读帧统计: 用字符串扫描代替整帧解析, 用于观察活跃流与帧速率, 不改动任何流
      const readFrame = (raw) => {
        if (typeof raw !== 'string' || !raw.startsWith(FRAME_TYPE_PREFIX)) return undefined
        const typeEnd = raw.indexOf('"', FRAME_TYPE_PREFIX.length)
        if (typeEnd < 0) return undefined
        const type = raw.slice(FRAME_TYPE_PREFIX.length, typeEnd)
        const idAt = raw.indexOf(STREAM_ID_KEY)
        const streamId = idAt < 0 ? '' : raw.slice(idAt + STREAM_ID_KEY.length, raw.indexOf('"', idAt + STREAM_ID_KEY.length))
        const endpointAt = raw.indexOf(ENDPOINT_KEY)
        const endpoint = endpointAt < 0 ? '' : raw.slice(endpointAt + ENDPOINT_KEY.length, raw.indexOf('"', endpointAt + ENDPOINT_KEY.length))
        return { type, streamId, endpoint }
      }
      const trackFrame = (socket, raw) => {
        const frame = readFrame(raw)
        if (frame === undefined) return
        if (frame.type === 'open') {
          const endpoint = frame.endpoint === '' ? 'unknown' : frame.endpoint
          socket.byStream.set(frame.streamId, endpoint)
          socket.streams[endpoint] = (socket.streams[endpoint] ?? 0) + 1
          return
        }
        if (frame.type !== 'end' && frame.type !== 'cancel') return
        const endpoint = socket.byStream.get(frame.streamId)
        if (endpoint === undefined) return
        socket.byStream.delete(frame.streamId)
        socket.streams[endpoint] = (socket.streams[endpoint] ?? 0) - 1
      }
      Wrapped = class KeepAliveSocket extends Native {
        constructor(...args) {
          super(...args)
          if (state.disabled) return
          let path
          try { path = new URL(String(args[0]), win.location?.href ?? 'https://localhost/').pathname } catch { return }
          if (path !== REMOTE_MUX_PATH) return
          const openedAt = clock.now()
          const site = { lastUpstreamAt: openedAt, lastKeepAliveAt: openedAt, keepAliveSent: false }
          const socketStats = diag === undefined ? undefined : { streams: {}, byStream: new Map(), openedAt: clock.now(), closed: false }
          if (socketStats !== undefined) {
            diag.sockets.push(socketStats)
            diag.totals.opened += 1
          }
          this.addEventListener('message', (event) => {
            if (socketStats === undefined) return
            trackFrame(socketStats, event?.data)
            diag.totals.messages += 1
          })
          this.addEventListener('close', () => {
            if (socketStats === undefined || socketStats.closed) return
            socketStats.closed = true
            diag.totals.closed += 1
          })
          const rawSend = this.send.bind(this)
          this.send = (data) => {
            site.lastUpstreamAt = clock.now()
            if (socketStats !== undefined) {
              trackFrame(socketStats, data)
              diag.totals.sent += 1
            }
            return rawSend(data)
          }
          const timer = clock.setInterval(() => {
            if (state.disabled || this.readyState !== Native.OPEN) return
            const now = clock.now()
            if (state.strikes > 0 && now - openedAt >= state.intervalMs * BREAKER_RECOVER_INTERVALS) state.strikes = 0
            if (now - Math.max(site.lastUpstreamAt, site.lastKeepAliveAt) < state.intervalMs) return
            try {
              rawSend(JSON.stringify({ type: 'item', streamId: nextStreamId(), value: 0 }))
              site.lastKeepAliveAt = now
              site.keepAliveSent = true
            } catch {
              // 已进入关闭流程: 交给 close 事件清理
            }
          }, KEEPALIVE_TICK_MS)
          state.timers.add(timer)
          this.addEventListener('close', (event) => {
            clock.clearInterval(timer)
            state.timers.delete(timer)
            if (state.disabled || !site.keepAliveSent || !PROTOCOL_CLOSE_CODES.includes(event?.code)) return
            state.strikes += 1
            if (state.strikes >= BREAKER_STRIKES) disable('protocol closed the connection after a keepalive frame')
          })
        }
      }
      Native[KEEPALIVE_MARKER] = Wrapped
      win.WebSocket = Wrapped
      return {
        installed: true,
        state,
        setIntervalMs: (ms) => { state.intervalMs = ms },
        uninstall: () => disable('disabled'),
      }
    }

    // 与宿主自己的列表项口径一致: 排除分组行、过程行、空行与隐藏子树
    const isMeaningfulRow = (node) => {
      if (node.hasAttribute?.('data-chat-group-key')) return false
      if (node.getAttribute?.('data-chat-flow-kind') === 'turn-process') return false
      const hiddenAncestor = node.closest?.('[hidden]')
      if (hiddenAncestor !== null && hiddenAncestor !== undefined) return false
      if ((node.childElementCount ?? 0) === 0 && (node.textContent ?? '').trim() === '') return false
      return true
    }

    // 加载态判定只认会话流容器里没有任何有效消息行、且直接子节点文本与加载提示完全一致的节点;
    // 对话正文或历史里出现同样文字不会命中, 终端等其它区域的存在也不影响判断。
    const sessionStalled = (doc) => {
      const flow = doc.querySelector?.('[data-chat-flow]')
      if (flow === null || flow === undefined) return false
      const rows = flow.querySelectorAll?.(STUCK_MESSAGE_SELECTOR) ?? []
      for (const row of rows) {
        if (isMeaningfulRow(row)) return false
      }
      for (const child of flow.children ?? []) {
        const text = typeof child.textContent === 'string' ? child.textContent.trim() : ''
        if (STUCK_HINT_TEXTS.includes(text)) return true
      }
      return false
    }

    // 加载进展指纹: 会话流节点数、有效行数与最后一行文本长度任一变化都说明宿主仍在推进
    const stallFingerprint = (doc) => {
      const flow = doc.querySelector?.('[data-chat-flow]')
      if (flow === null || flow === undefined) return ''
      const rows = flow.querySelectorAll?.(STUCK_MESSAGE_SELECTOR) ?? []
      const last = flow.lastElementChild?.textContent
      return `${flow.childElementCount ?? 0}:${rows.length}:${typeof last === 'string' ? last.length : 0}`
    }

    const ensureStuckStyle = (doc) => {
      const selector = `style[data-plugin="${PLUGIN_ID}"]`
      const existing = doc.querySelector?.(selector)
      if (existing !== null && existing !== undefined) return
      const style = doc.createElement('style')
      style.setAttribute('data-plugin', PLUGIN_ID)
      style.textContent = STUCK_CSS
      doc.head.appendChild(style)
    }

    // 会话停滞时优先让宿主自己重建连接: 官方 connection 服务的 reconnect() 会中止当前
    // generation 并立即重试, 页面随之恢复, 不打断会话与未发送的草稿。
    // 连续多次重建仍无效才显示提示, 刷新入口只是最后手段。
    const installStuckSession = ({ win, options, clock, connection }) => {
      const doc = win?.document
      if (doc === undefined || typeof doc.createElement !== 'function') return { installed: false, reason: 'document unavailable' }
      if (options?.enabled === false) return { installed: false, reason: 'disabled' }
      // 样式随每次安装重注: HMR 重建会先删掉本插件的 style
      ensureStuckStyle(doc)
      if (win[STUCK_MARKER] === true) return { installed: false, reason: 'already installed' }
      const state = { since: undefined, fingerprint: undefined, lastTickAt: undefined, quietSince: undefined, notice: undefined, attempts: 0, lastAttemptAt: undefined }
      const reload = () => { try { win.location?.reload?.() } catch { } }
      const showNotice = () => {
        if (state.notice !== undefined || doc.getElementById(STUCK_NOTICE_ID) !== null) return
        const notice = doc.createElement('div')
        notice.setAttribute('id', STUCK_NOTICE_ID)
        notice.setAttribute('data-plugin', PLUGIN_ID)
        notice.setAttribute('role', 'status')
        notice.className = 'bp-stuck'
        const text = doc.createElement('span')
        text.className = 'bp-stuck__text'
        text.textContent = '连接重建未成功,可手动刷新页面'
        const action = doc.createElement('button')
        action.setAttribute('type', 'button')
        action.className = 'bp-stuck__action'
        action.textContent = '刷新页面'
        action.addEventListener('click', reload)
        notice.appendChild(text)
        notice.appendChild(action)
        doc.body.appendChild(notice)
        state.notice = notice
      }
      const hideNotice = () => {
        if (state.notice === undefined) return
        state.notice.remove()
        state.notice = undefined
      }
      const revive = () => {
        if (options.reconnect !== true || connection === undefined || typeof connection.reconnect !== 'function') return false
        if (state.attempts >= options.maxReconnectAttempts) return false
        const now = clock.now()
        if (state.lastAttemptAt !== undefined && now - state.lastAttemptAt < options.reconnectIntervalMs) return true
        state.attempts += 1
        state.lastAttemptAt = now
        try {
          connection.reconnect()
        } catch {
          return false
        }
        console.info(`${LOG_PREFIX} session stalled, requesting reconnect #${state.attempts}`)
        return true
      }
      // 主线程被占满(解析大历史、长渲染)不是假死证据, 只按加载态是否停滞判定:
      // 阻塞恢复后若加载仍无进展, 停滞计时自然继续, 不需要单独的阻塞分支。
      const tick = () => {
        const now = clock.now()
        // 定时器被挂起(标签页冻结、系统睡眠)或页面不可见: 计时不可信, 作废本轮
        const gap = state.lastTickAt === undefined ? 0 : now - state.lastTickAt
        state.lastTickAt = now
        if (doc.visibilityState === 'hidden' || gap > options.checkMs * 3) {
          state.since = now
          state.fingerprint = undefined
          state.quietSince = undefined
          return
        }
        if (!sessionStalled(doc)) {
          // 恢复要连续稳定几个周期才清零重连计数, 避免重建清流的一帧非加载态把上限抹掉
          if (state.quietSince === undefined) state.quietSince = now
          state.since = undefined
          state.fingerprint = undefined
          hideNotice()
          if (now - state.quietSince < options.checkMs * 3) return
          if (state.attempts > 0) console.info(`${LOG_PREFIX} session recovered after ${state.attempts} reconnect attempt(s)`)
          state.attempts = 0
          state.lastAttemptAt = undefined
          return
        }
        state.quietSince = undefined
        // 加载仍在推进(节点数/行数/最后一行文本变化)就不算停滞, 大历史会话允许慢慢渲染
        const fingerprint = stallFingerprint(doc)
        if (fingerprint !== state.fingerprint) {
          state.fingerprint = fingerprint
          state.since = now
          return
        }
        if (state.since === undefined) state.since = now
        if (now - state.since < options.stallMs) return
        if (revive()) {
          // 重建后重新计时, 避免刚发出的重建被下一 tick 当成已用尽
          state.since = now
          return
        }
        showNotice()
      }
      const timer = clock.setInterval(tick, options.checkMs)
      win[STUCK_MARKER] = true
      return { installed: true, state, timer }
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


    // 会话行与其它消费方(会话头、文件夹运行标记、子会话树等)会为每个会话订阅一条常驻 job/list 流,
    // 会话越多流越多, job 变化时宿主逐条推全量帧, 主线程随之出现数百毫秒长任务。
    // 准入: 当前视图的会话始终放行; 其余未归档会话按默认窗口放行前 base 条;
    // 归档会话与超出窗口的会话只由点击放行。点击与当前视图的会话不占窗口额度。
    // 总数到 max 后按加入顺序淘汰最老的一条, 被淘汰或未放行的行只是不显示任务状态。
    const JOB_LIMIT_MARKER = Symbol.for('@mzzsfy/dsh-bug-perf/job-stream-limit')
    const SESSION_ROW_PREFIX = 'session:'
    const installJobStreamLimit = ({ jobs, options, workspacesOf, uiSessionOf, doc }) => {
      if (jobs === undefined || typeof jobs.watchRows !== 'function') return { installed: false, reason: 'jobs unavailable' }
      if (jobs[JOB_LIMIT_MARKER] !== undefined) return { installed: false, reason: 'already installed' }
      const original = jobs.watchRows.bind(jobs)
      const entries = new Map()
      const order = []
      // active: 常驻流总数; windowUsed: 占默认窗口且不是当前视图的条数(派生值); current/clicked: 定向放行新建条数
      const state = { active: 0, current: 0, clicked: 0, rejected: 0, rejectedArchived: 0, evicted: 0, reclaimed: 0, archived: 0, keys: [] }
      // 判定读取一律 fail-open: 服务缺失或读取抛错时按未归档/非当前视图处理, 不打断宿主调用方
      const read = (probe) => {
        try {
          return probe()
        } catch {
          return undefined
        }
      }
      const forget = (key) => {
        const entry = entries.get(key)
        if (entry === undefined) return
        entries.delete(key)
        state.active -= 1
        const index = order.indexOf(key)
        if (index >= 0) order.splice(index, 1)
        state.keys = order.slice()
      }
      // 淘汰优先窗口条目, 其次点击放行; 当前视图的会话不受淘汰
      const evictable = (key) => {
        const entry = entries.get(key)
        return entry !== undefined && !isCurrent(key) ? entry : undefined
      }
      const evictOldest = () => {
        const key = order.find((item) => evictable(item)?.windowed === true) ?? order.find((item) => evictable(item) !== undefined)
        if (key === undefined) return false
        const entry = entries.get(key)
        forget(key)
        entry.release()
        state.evicted += 1
        return true
      }
      // 会话头的任务入口只为当前视图的会话订阅一条流: 窗口被名册占满后它也必须拿到
      const isCurrent = (key) => read(() => {
        const uiSession = typeof uiSessionOf === 'function' ? uiSessionOf() : uiSessionOf
        return uiSession?.isMain?.(key) === true
      }) === true
      // 占窗口的条数按当前视图实时排除: 某行先按窗口放行、之后成为当前视图时自动让出额度
      const windowPressure = () => {
        let used = 0
        for (const [key, entry] of entries) {
          if (entry.windowed && !isCurrent(key)) used += 1
        }
        return used
      }
      Object.defineProperty(state, 'windowUsed', { get: windowPressure, enumerable: true })
      // 归档集合就绪后才生效; 集合变化时回收已归档条目的流(点击与当前视图保留)
      const cache = { snapshot: undefined, archived: undefined }
      let subscription
      const sweep = (archived) => {
        for (const [key, entry] of [...entries]) {
          if (!entry.windowed || !archived.has(key) || isCurrent(key)) continue
          forget(key)
          entry.release()
          state.reclaimed += 1
        }
      }
      const readArchived = () => read(() => {
        const workspaces = typeof workspacesOf === 'function' ? workspacesOf() : workspacesOf
        const snapshot = workspaces?.list?.getSnapshot?.()
        if (snapshot === undefined) return undefined
        // phase 未就绪时 archivedSessionIds 是空占位, 不能当权威空集
        if (snapshot.phase !== undefined && snapshot.phase !== 'ready') return undefined
        if (subscription === undefined && typeof workspaces?.list?.subscribe === 'function') {
          // 归档变化即时回收: 模型推送合并到一次微任务
          let scheduled = false
          subscription = workspaces.list.subscribe(() => {
            if (scheduled) return
            scheduled = true
            const reconcile = () => {
              scheduled = false
              readArchived()
            }
            if (typeof queueMicrotask === 'function') queueMicrotask(reconcile)
            else Promise.resolve().then(reconcile)
          })
        }
        if (cache.snapshot === snapshot) return cache.archived
        const ids = Array.isArray(snapshot.archivedSessionIds) ? snapshot.archivedSessionIds : []
        const archived = new Set(ids.map((id) => String(id)))
        cache.snapshot = snapshot
        cache.archived = archived
        state.archived = archived.size
        sweep(archived)
        return archived
      })
      const isArchived = (key) => readArchived()?.has(key) === true
      const add = (key, windowed) => {
        if (entries.size >= options.max && !evictOldest()) return undefined
        const entry = { release: original(key), windowed, refs: 1 }
        entries.set(key, entry)
        order.push(key)
        state.keys = order.slice()
        state.active += 1
        return entry
      }
      const releaser = (key, entry) => {
        let released = false
        return () => {
          if (released) return
          released = true
          entry.refs -= 1
          if (entry.refs > 0) return
          if (entries.get(key) !== entry) return
          forget(key)
          entry.release()
        }
      }
      const admit = (key, windowed, reason) => {
        const entry = add(key, windowed)
        if (entry === undefined) return () => { }
        if (reason === 'current') state.current += 1
        else if (reason === 'click') state.clicked += 1
        return releaser(key, entry)
      }
      jobs.watchRows = (sessionId) => {
        const key = String(sessionId)
        const existing = entries.get(key)
        if (existing !== undefined) {
          existing.refs += 1
          return releaser(key, existing)
        }
        if (isCurrent(key)) return admit(key, false, 'current')
        // 归档会话不在默认视图里, 不占窗口, 只由点击放行
        if (isArchived(key)) {
          state.rejected += 1
          state.rejectedArchived += 1
          return () => { }
        }
        if (windowPressure() >= options.base) {
          state.rejected += 1
          return () => { }
        }
        return admit(key, true)
      }
      const promote = (sessionId) => {
        const key = String(sessionId)
        const existing = entries.get(key)
        if (existing !== undefined) {
          // 已占默认窗口的行被点击后转为点击放行(当前视图的额度豁免是派生的, 无需另行让出)
          existing.windowed = false
          return
        }
        admit(key, false, 'click')
      }
      const onDocumentClick = (event) => {
        const row = event?.target?.closest?.('[data-row-key]')
        const rowKey = row?.getAttribute?.('data-row-key')
        if (typeof rowKey !== 'string' || !rowKey.startsWith(SESSION_ROW_PREFIX)) return
        promote(rowKey.slice(SESSION_ROW_PREFIX.length))
      }
      doc?.addEventListener?.('click', onDocumentClick, true)
      const dispose = () => {
        doc?.removeEventListener?.('click', onDocumentClick, true)
        if (typeof subscription === 'function') subscription()
        subscription = undefined
        for (const [key, entry] of [...entries]) {
          forget(key)
          entry.release()
        }
      }
      Object.defineProperty(jobs, JOB_LIMIT_MARKER, { value: { state, dispose }, configurable: true })
      return { installed: true, state, dispose }
    }

    const summarize = (result) => (result.installed === true ? { installed: true } : { installed: false, reason: result.reason })

    // 安装失败只进入报告, 不影响页面与其它补丁
    const safely = (install) => {
      try {
        return install()
      } catch (error) {
        return { installed: false, reason: error instanceof Error ? error.message : String(error) }
      }
    }

    // 设置卡片:注册进官方「插件」设置页与插件管理页配置槽,不占独立导航项
    const UI_SECTIONS = [
      {
        key: 'restartCoalesce',
        title: '会话流重建合并',
        description: '同一会话流在窗口内的重复 restart 合并为一次尾随执行,降低列表重建风暴。',
        fields: [{ name: 'windowMs', label: '合并窗口', unit: '毫秒' }],
      },
      {
        key: 'terminalWatchdog',
        title: '终端输出看门狗',
        description: '终端视图停滞且仍持有 attach 流时自动重连,避免输出永久卡住。',
        fields: [
          { name: 'checkMs', label: '检查周期', unit: '毫秒' },
          { name: 'stallMs', label: '停滞判定', unit: '毫秒' },
          { name: 'cooldownMs', label: '自愈冷却', unit: '毫秒' },
        ],
      },
      {
        key: 'socketKeepAlive',
        title: '会话流保活',
        description: '空闲时向会话流连接发送无害帧,避免短心跳把公网连接误判为失联。',
        fields: [{ name: 'intervalMs', label: '保活间隔', unit: '毫秒' }],
      },
      {
        key: 'stuckSession',
        title: '会话加载停滞兜底',
        description: '加载卡住时主动请求宿主重建连接,多次无效才给出提示。',
        fields: [
          { name: 'checkMs', label: '检查周期', unit: '毫秒' },
          { name: 'stallMs', label: '停滞判定', unit: '毫秒' },
          { name: 'maxReconnectAttempts', label: '最大重连次数', unit: '次' },
          { name: 'reconnectIntervalMs', label: '重连间隔', unit: '毫秒' },
        ],
        toggles: [{ name: 'reconnect', label: '停滞时主动重建连接' }],
      },
      {
        key: 'jobStreamLimit',
        title: '任务状态流上限',
        description: '每个会话行常驻一条 job/list 流,会话多时按默认窗口限制;当前视图与点击的会话不占窗口,归档会话与窗口外的行只在点击时订阅。',
        fields: [
          { name: 'base', label: '默认窗口', unit: '条' },
          { name: 'max', label: '硬上限', unit: '条' },
        ],
      },
      {
        key: 'sessionWindow',
        title: '历史窗口收敛',
        description: '打开/重连会话时按消息预算下发历史页,工具密集的会话不再一次下发数千事件;首屏规模由轮边界下限决定,宿主默认 50 条消息、至少 2 轮。',
        fields: [
          { name: 'maxMessages', label: '消息上限', unit: '条' },
          { name: 'minMessages', label: '轮下限消息', unit: '条' },
          { name: 'minTurns', label: '轮数下限', unit: '轮' },
        ],
      },
      {
        key: 'listSlim',
        title: '会话列表瘦身',
        description: '按白名单裁剪 session/list 投影并缓存;响应形状不符时透传,新增列表字段需同步白名单。',
        fields: [],
      },
      {
        key: 'diag',
        title: '性能采样上报',
        description: '内存采样始终运行;开启后按采样次数把摘要写入宿主临时文件,默认不产生请求与落盘。',
        fields: [{ name: 'reportEvery', label: '上报间隔', unit: '次采样' }],
      },
    ]

    // 包局部视觉 token(plugin-ui-design L1):值只引用宿主语义别名,不写字面 fallback
    const UI_CSS = [
      '.bp-card {',
      '  --bp-accent:var(--dsw-alias-brand-primary); --bp-accent-deep:var(--dsw-alias-button-primary-hover);',
      '  --bp-accent-wash:color-mix(in srgb, var(--dsw-alias-brand-primary) 12%, transparent);',
      '  --bp-ok:var(--dsw-alias-state-success-primary); --bp-warn:var(--dsw-alias-state-warn-primary);',
      '  --bp-danger:var(--dsw-alias-state-error-primary);',
      '  --bp-danger-wash:color-mix(in srgb, var(--dsw-alias-state-error-primary) 10%, transparent);',
      '  --bp-bg:var(--dsw-alias-bg-layer-1); --bp-bg-sub:var(--dsw-alias-bg-layer-2);',
      '  --bp-bg-muted:var(--dsw-alias-bg-module-platform);',
      '  --bp-card:var(--dsw-alias-bg-layer-1); --bp-card-border:var(--dsw-alias-border-l2);',
      '  --bp-border:var(--dsw-alias-border-l2); --bp-border-strong:var(--dsw-alias-border-l3);',
      '  --bp-text:var(--dsw-alias-label-primary); --bp-text-sub:var(--dsw-alias-label-secondary);',
      '  --bp-text-dim:var(--dsw-alias-label-tertiary);',
      '  --bp-hover:var(--dsw-alias-interactive-bg-hover); --bp-hover-danger:var(--dsw-alias-interactive-bg-hover-danger);',
      '  --bp-skeleton:var(--dsw-alias-bg-skeleton); --bp-switch-thumb:var(--dsw-alias-switch-thumb);',
      '  --bp-radius-sm:var(--dsw-radius-sm); --bp-radius-md:var(--dsw-radius-md); --bp-radius-lg:var(--dsw-radius-lg);',
      '  box-sizing:border-box; width:100%; border:.5px solid var(--bp-card-border); border-radius:var(--bp-radius-md);',
      '  background:var(--bp-card); color:var(--bp-text); font-size:14px; line-height:22px; }',
      '.bp-card__header { display:flex; align-items:flex-start; gap:12px; width:100%; padding:16px 20px;',
      '  border:0; border-radius:var(--bp-radius-md); background:transparent; font:inherit; color:inherit;',
      '  text-align:left; cursor:pointer; }',
      '.bp-card__header:focus-visible { outline:2px solid var(--dsw-alias-state-business-primary); outline-offset:-2px; }',
      '.bp-card__head-text { display:flex; flex-direction:column; gap:2px; flex:1 1 auto; min-width:0; }',
      '.bp-card__name { font-size:16px; font-weight:500; line-height:24px; }',
      '.bp-card__description { color:var(--bp-text-sub); font-size:13px; line-height:20px; }',
      '.bp-card__chevron { flex:none; margin-top:4px; color:var(--bp-text-dim); display:inline-flex; transition:transform .15s; }',
      '.bp-card--open .bp-card__chevron { transform:rotate(180deg); }',
      '.bp-card__body { display:flex; flex-direction:column; padding:0 20px 20px; border-top:.5px solid var(--bp-border); }',
      '.bp-hint { margin:12px 0 0; color:var(--bp-text-sub); font-size:13px; line-height:20px; }',
      '.bp-error { margin:8px 0 0; padding-left:8px; border-left:2px solid var(--bp-danger); color:var(--bp-text); font-size:13px; line-height:20px; }',
      '.bp-sections { display:flex; flex-direction:column; gap:12px; margin-top:16px; }',
      '.bp-section { display:flex; flex-direction:column; padding:12px 16px 4px; border-radius:var(--bp-radius-md); background:var(--bp-bg-sub); }',
      '.bp-section__head { display:flex; align-items:center; justify-content:space-between; gap:12px; min-height:36px; }',
      '.bp-section__title { font-size:14px; font-weight:500; line-height:22px; }',
      '.bp-section__description { margin:2px 0 0; color:var(--bp-text-sub); font-size:13px; line-height:20px; }',
      '.bp-rows { display:flex; flex-direction:column; margin-top:8px; }',
      '.bp-row { display:flex; align-items:center; justify-content:space-between; gap:12px; min-height:44px; padding:12px 0; }',
      '.bp-row + .bp-row { border-top:.5px solid var(--bp-border); }',
      '.bp-field__label { color:var(--bp-text-sub); font-size:13px; line-height:20px; }',
      '.bp-field__control { display:flex; align-items:center; gap:8px; flex:none; }',
      '.bp-input { box-sizing:border-box; width:104px; min-height:32px; padding:0 10px; border:1px solid var(--bp-border-strong);',
      '  border-radius:var(--bp-radius-sm); background:var(--bp-bg); color:var(--bp-text); font:inherit; font-size:14px; line-height:22px; }',
      '.bp-input:focus { outline:2px solid var(--dsw-alias-state-business-primary); outline-offset:0; }',
      '.bp-field__unit { flex:none; min-width:44px; text-align:right; color:var(--bp-text-dim); font-size:11px; line-height:18px; }',
      '.bp-switch { display:inline-flex; align-items:center; gap:8px; flex:none; min-height:32px; cursor:pointer; user-select:none; }',
      '.bp-switch input[type="checkbox"] { position:absolute; width:0; height:0; opacity:0; }',
      '.bp-switch__track { position:relative; flex-shrink:0; box-sizing:border-box; width:34px; height:19px; border-radius:999px;',
      '  background:var(--bp-bg-muted); border:1px solid var(--bp-border); transition:background .15s,border-color .15s; }',
      '.bp-switch__thumb { position:absolute; top:50%; left:2px; width:13px; height:13px; border-radius:50%;',
      '  background:var(--bp-switch-thumb); transform:translateY(-50%); transition:left .15s; }',
      '.bp-switch__label { color:var(--bp-text-sub); font-size:13px; line-height:20px; }',
      '.bp-switch:hover .bp-switch__track { background:color-mix(in srgb,var(--bp-bg-muted) 88%,var(--bp-text)); }',
      '.bp-switch input[type="checkbox"]:checked + .bp-switch__track { background:var(--bp-accent); border-color:var(--bp-accent); }',
      '.bp-switch input[type="checkbox"]:checked + .bp-switch__track .bp-switch__thumb { left:17px; }',
      '.bp-switch input[type="checkbox"]:focus-visible + .bp-switch__track { outline:2px solid var(--dsw-alias-state-business-primary); outline-offset:2px; }',
      '.bp-switch:has(input[type="checkbox"]:disabled) { opacity:.5; cursor:not-allowed; }',
      '.bp-footer { display:flex; align-items:center; gap:12px; margin-top:16px; padding-top:12px; border-top:.5px solid var(--bp-border); }',
      '.bp-footer .bp-hint { margin:0; }',
      '.bp-button { min-height:32px; padding:0 14px; border:1px solid var(--bp-border-strong); border-radius:var(--bp-radius-sm);',
      '  background:transparent; color:var(--bp-text); font:inherit; font-size:14px; line-height:22px; cursor:pointer; }',
      '.bp-button:hover:not(:disabled) { background:var(--bp-hover); }',
      '.bp-button--primary { border-color:var(--bp-accent); background:var(--bp-accent); color:var(--dsw-alias-bg-base); }',
      '.bp-button--primary:hover:not(:disabled) { border-color:var(--bp-accent-deep); background:var(--bp-accent-deep); }',
      '.bp-button:disabled { opacity:.5; cursor:not-allowed; }',
      '@media (prefers-reduced-motion: reduce) { .bp-card__chevron, .bp-switch__track, .bp-switch__thumb { transition:none; } }',
      '@media (max-width: 560px) { .bp-card__header { padding:16px; } .bp-card__body { padding:0 16px 16px; }',
      '  .bp-section { padding:12px 12px 4px; } }',
    ].join('\n')

    const h = React === undefined ? undefined : React.createElement

    const Switch = ({ checked, disabled, label, ariaLabel, onChange }) => h('label', { className: 'bp-switch' },
      h('input', {
        type: 'checkbox',
        checked,
        disabled,
        'aria-label': ariaLabel ?? label,
        onChange: (event) => onChange(event.target.checked),
      }),
      h('span', { className: 'bp-switch__track' }, h('span', { className: 'bp-switch__thumb' })),
      label === undefined || label === '' ? null : h('span', { className: 'bp-switch__label' }, label),
    )

    function SettingsPanel() {
      const [open, setOpen] = React.useState(false)
      const [config, setConfig] = React.useState(null)
      const [dirty, setDirty] = React.useState(false)
      const [saving, setSaving] = React.useState(false)
      const [error, setError] = React.useState('')
      const [notice, setNotice] = React.useState('')
      React.useEffect(() => {
        let alive = true
        loadConfig()
          .then((raw) => { if (alive) setConfig(normalizeConfig(raw ?? window.__dshBugPerf?.config)) })
          .catch(() => { if (alive) setConfig(normalizeConfig(DEFAULT_CONFIG)) })
        return () => { alive = false }
      }, [])
      const updateSection = (key, patch) => {
        setConfig({ ...config, [key]: { ...config[key], ...patch } })
        setDirty(true)
        setError('')
        setNotice('')
      }
      const save = async () => {
        setSaving(true)
        setError('')
        try {
          const response = await fetch(CONFIG_PATH, {
            method: 'POST',
            headers: { 'content-type': 'application/json', accept: 'application/json' },
            body: JSON.stringify({ config }),
          })
          const body = await response.json().catch(() => undefined)
          if (!response.ok) throw new Error(body?.error ?? `HTTP ${response.status}`)
          setConfig(normalizeConfig(body?.config ?? config))
          setDirty(false)
          setNotice('已保存,刷新页面生效')
        } catch (failure) {
          setError(`保存失败:${failure instanceof Error ? failure.message : String(failure)}`)
        } finally {
          setSaving(false)
        }
      }
      return h('div', { className: 'bp-card' + (open ? ' bp-card--open' : '') },
        h('button', {
          type: 'button',
          className: 'bp-card__header',
          'aria-expanded': open,
          onClick: () => setOpen(!open),
        },
          h('span', { className: 'bp-card__head-text' },
            h('span', { className: 'bp-card__name' }, '缺陷兜底与性能补丁'),
            h('span', { className: 'bp-card__description' }, '会话流、终端与列表的运行时补丁;每个功能独立开关'),
          ),
          h('span', { className: 'bp-card__chevron', 'aria-hidden': 'true' },
            h('svg', { width: 14, height: 14, viewBox: '0 0 14 14', fill: 'none' },
              h('path', {
                d: 'M3.5 5.25L7 8.75L10.5 5.25',
                stroke: 'currentColor',
                'stroke-width': '1.2',
                'stroke-linecap': 'round',
                'stroke-linejoin': 'round',
              }),
            ),
          ),
        ),
        open && h('div', { className: 'bp-card__body' },
          h('p', { className: 'bp-hint' }, '修改后点保存;客户端补丁刷新页面生效,列表瘦身在下次列表请求生效。'),
          error !== '' && h('p', { className: 'bp-error' }, error),
          config === null && h('p', { className: 'bp-hint' }, '加载配置…'),
          config !== null && h('div', { className: 'bp-sections' }, UI_SECTIONS.map((section) => h('section', { key: section.key, className: 'bp-section' },
            h('div', { className: 'bp-section__head' },
              h('span', { className: 'bp-section__title' }, section.title),
              h(Switch, {
                checked: config[section.key].enabled,
                disabled: saving,
                label: '启用',
                onChange: (enabled) => updateSection(section.key, { enabled }),
              }),
            ),
            h('p', { className: 'bp-section__description' }, section.description),
            section.fields.length === 0 && (section.toggles ?? []).length === 0 ? null : h('div', { className: 'bp-rows' },
              section.fields.map((field) => {
                const bounds = LIMITS[section.key]?.[field.name]
                return h('label', { key: field.name, className: 'bp-row' },
                  h('span', { className: 'bp-field__label' }, field.label),
                  h('span', { className: 'bp-field__control' },
                    h('input', {
                      type: 'number',
                      className: 'bp-input',
                      min: bounds?.min,
                      max: bounds?.max,
                      step: 1,
                      value: config[section.key][field.name],
                      disabled: saving,
                      onChange: (event) => {
                        const value = Number(event.target.value)
                        if (Number.isFinite(value)) updateSection(section.key, { [field.name]: value })
                      },
                    }),
                    h('span', { className: 'bp-field__unit' }, field.unit),
                  ),
                )
              }),
              (section.toggles ?? []).map((toggle) => h('div', { key: toggle.name, className: 'bp-row' },
                h('span', { className: 'bp-field__label' }, toggle.label),
                h(Switch, {
                  checked: config[section.key][toggle.name],
                  disabled: saving,
                  ariaLabel: toggle.label,
                  onChange: (value) => updateSection(section.key, { [toggle.name]: value }),
                }),
              )),
            ),
          ))),
          config !== null && h('div', { className: 'bp-footer' },
            h('button', {
              type: 'button',
              className: 'bp-button bp-button--primary',
              disabled: saving || !dirty,
              onClick: save,
            }, saving ? '保存中…' : '保存'),
            dirty && h('span', { className: 'bp-hint' }, '有未保存的修改'),
            !dirty && notice !== '' && h('span', { className: 'bp-hint' }, notice),
          ),
        ),
      )
    }

    const registerSettingsUi = (ctx) => {
      if (h === undefined || typeof ctx.inject !== 'function') return
      ctx.inject(['slots'], (scope) => {
        const slots = scope.slots
        if (slots === undefined) return
        try {
          scope.effect(() => {
            const style = document.createElement('style')
            style.setAttribute('data-plugin', PKG_ID)
            style.textContent = UI_CSS
            document.head.appendChild(style)
            return () => style.remove()
          })
        } catch (error) {
          console.warn(`${LOG_PREFIX} styles unavailable:`, error instanceof Error ? error.message : String(error))
        }
        const register = (name, options) => {
          try {
            slots.inject(name, () => {
              try {
                slots.register(options, () => h(SettingsPanel))
              } catch (error) {
                console.warn(`${LOG_PREFIX} settings slot ${name} register failed:`, error instanceof Error ? error.message : String(error))
              }
            })
          } catch (error) {
            console.warn(`${LOG_PREFIX} settings slot ${name} unavailable:`, error instanceof Error ? error.message : String(error))
          }
        }
        register('settings.plugin.item', { name: 'settings.plugin.item', id: NAMESPACE, key: NAMESPACE })
        register('plugins.bundle.config', { name: 'plugins.bundle.config', key: PKG_ID })
      })
    }

    const apply = (ctx) => {
      registerSettingsUi(ctx)
      const report = { config: undefined, features: {} }
      window.__dshBugPerf = report
      const diag = createDiag(timers)
      report.diag = diag
      startDiagSampling({ win: window, clock: timers, diag, doc: window.document })
      // 会话流连接在页面启动早期建立, 保活先按默认值同步安装, 配置到达后再校正间隔
      const keepAlive = safely(() => installSocketKeepAlive({
        win: window,
        options: DEFAULT_CONFIG.socketKeepAlive,
        clock: timers,
        diag,
        onDisabled: (reason) => { report.features.socketKeepAlive = { installed: false, reason } },
      }))
      report.features.socketKeepAlive = summarize(keepAlive)
      void (async () => {
        const config = normalizeConfig(await loadConfig())
        report.config = config
        const reporting = startDiagReporting({ win: window, clock: timers, diag, options: config.diag })
        report.features.diag = reporting.enabled ? { installed: true } : { installed: false, reason: 'disabled' }
        if (!config.socketKeepAlive.enabled) {
          keepAlive.uninstall?.()
          report.features.socketKeepAlive = { installed: false, reason: 'disabled' }
        } else if (keepAlive.installed === true) {
          keepAlive.setIntervalMs?.(config.socketKeepAlive.intervalMs)
        }
        report.features.restartCoalesce = config.restartCoalesce.enabled
          ? installRestartCoalesceFromRequire({ requireImpl: require, windowMs: config.restartCoalesce.windowMs, timers })
          : { installed: false, reason: 'disabled' }
        if (config.terminalWatchdog.enabled) {
          installTerminalWatchdogWhenReady(ctx, config.terminalWatchdog, report)
        } else {
          report.features.terminalWatchdog = { installed: false, reason: 'disabled' }
        }
        const stuckOptions = config.stuckSession
        const startStuckSession = (connection) => {
          report.actions = { reconnect: () => { try { connection?.reconnect?.() } catch { } } }
          report.features.stuckSession = stuckOptions.enabled
            ? summarize(safely(() => installStuckSession({ win: window, options: stuckOptions, clock: timers, connection })))
            : { installed: false, reason: 'disabled' }
        }
        const startJobStreamLimit = (jobs) => {
          report.features.jobStreamLimit = config.jobStreamLimit.enabled
            ? safely(() => {
              const result = installJobStreamLimit({ jobs, options: config.jobStreamLimit, workspacesOf: () => ctx.get?.('workspaces'), uiSessionOf: () => ctx.get?.('uiSession'), doc: window.document })
              return result.installed === true ? { installed: true, state: result.state } : result
            })
            : { installed: false, reason: 'disabled' }
        }
        const readyJobs = ctx.get?.('jobs')
        if (readyJobs !== undefined || ctx.inject === undefined) {
          startJobStreamLimit(readyJobs)
        } else {
          ctx.inject(['jobs'], (jobs) => { startJobStreamLimit(jobs) })
        }
        const readyConnection = ctx.get?.('connection')
        if (readyConnection !== undefined || ctx.inject === undefined) {
          startStuckSession(readyConnection)
        } else {
          // connection 由核心插件提供; 等它就绪后再装, 避免错过主动重连入口
          ctx.inject(['connection'], (connection) => { startStuckSession(connection) })
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
        DIAG_SAMPLE_MS,
        DIAG_MAX_SAMPLES,
        DIAG_PROBE_MS,
        DIAG_BLOCK_MS,
        normalizeConfig,
        registerSettingsUi,
        UI_SECTIONS,
        createDiag,
        startDiagSampling,
        startDiagReporting,
        installRestartCoalesce,
        installRestartCoalesceFromRequire,
        watchdogTick,
        installTerminalWatchdog,
        installSocketKeepAlive,
        installJobStreamLimit,
        installStuckSession,
        sessionStalled,
      },
    }
  },
})
