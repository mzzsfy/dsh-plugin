// dsh-common-tools Client 半区:全家桶共享的浏览器推送总线订阅协议 + 全局浮出通知。
// - bus:按插件空间复用单条 WebSocket,支持订阅与推送(host 半区由消费插件
//   执行 setupCommonTools 激活,版本接管对 client 透明,机制见 host.js)。
// - toast:全局浮出通知,多条并存栈式展示。
// 以 DSH client-modules 自注册格式发布(__ModuleLoader__.load),消费插件经
// dsh.client.external require('@mzzsfy/dsh-common-tools/client') 使用。本包是普通
// npm 依赖而非插件:client 经消费插件 cordis.patch.yml 代挂的占位条目进入客户端
// 模块表,插件管理不可见。
// toast 渲染容器惰性自举:首次 show 挂载,容器与样式幂等,挂载前清同 id 旧代残留。
// 容器带代际标记:HMR 旧代闭包再调 mount 时发现在位容器属更新代际即退避,
// 不拆新代容器;旧代迟到通知不可见(一次性告警),刷新页面恢复。

window.__ModuleLoader__.load({
  id: '@mzzsfy/dsh-common-tools',
  factory(require) {
    const React = require('react')
    const { useSyncExternalStore } = React
    const { createRoot } = require('react-dom/client')

    // Toast 持续时长与栈上限:展示期定值;突发事件裁剪最旧条目
    const TOAST_HOLD_MS = 4 * 1000
    // setTimeout 延迟的规范钳位上界:超出即被浏览器钳到上界本身(约 24.8 天),
    // 非 sticky 条目将近乎永久驻留且无关闭按钮,超界值一律回落默认
    const HOLD_MS_MAX = 2 ** 31 - 1
    const TOAST_MAX = 4
    const KINDS = ['info', 'ok', 'error']
    const HOST_ID = 'dsh-common-tools-toast-host'
    const STYLE_ID = 'dsh-common-tools-toast-style'
    // 层级假设的显式化:承诺"高于设置全屏层"绑定此值,宿主层级调整时回归核对
    const TOAST_Z_INDEX = 1100

    // 令牌 fallback:宿主 dsh 升级更名 --dsw-* 变量时降级为可用默认形态,
    // 不静默失效为透明底/不可读字
    const CSS = [
      '.dsh-toast-stack { position:fixed; left:50%; top:16px; transform:translateX(-50%); z-index:' + TOAST_Z_INDEX + ';',
      '  display:flex; flex-direction:column; align-items:center; gap:8px; pointer-events:none; }',
      '.dsh-toast { pointer-events:auto; background:var(--dsw-alias-toast-bg, rgba(32,33,36,.92)); color:var(--dsw-alias-label-primary-inverted, #fff);',
      '  font:var(--dsw-font-xs-13, 13px/1.5 system-ui, sans-serif); padding:8px 14px; border-radius:10px; box-shadow:var(--dsw-shadow-lv2, 0 2px 8px rgba(0,0,0,.25));',
      '  animation:dsh-toast-in 0.18s ease-out; max-width:520px; max-height:60vh; overflow:auto; overflow-wrap:anywhere; display:flex; align-items:safe center; gap:10px; }',
      '.dsh-toast--ok { background:var(--dsw-alias-state-success-primary, #1a7f37); color:var(--dsw-alias-label-primary-inverted, #fff); }',
      '.dsh-toast--error { background:var(--dsw-alias-state-error-primary, #d93025); color:#fff; }',
      '.dsh-toast--click { cursor:pointer; }',
      '.dsh-toast__close { border:0; background:transparent; cursor:pointer; color:inherit;',
      '  font:var(--dsw-font-xs-strong-13, 13px system-ui, sans-serif); padding:0 2px; opacity:.8; }',
      '.dsh-toast__close:hover { opacity:1; }',
      '@keyframes dsh-toast-in { from { transform:translateY(-8px); opacity:0; } to { transform:translateY(0); opacity:1; } }',
      '@media (prefers-reduced-motion: reduce) { .dsh-toast { animation:none; } }',
    ].join('\n')

    function h(type, props) {
      const children = Array.prototype.slice.call(arguments, 2)
      return React.createElement.apply(React, [type, props || null].concat(children))
    }

    // ---- toast store:模块闭包单例,幂等无状态快照 ----

    let seq = 0
    let items = []
    const listeners = new Set()
    const emit = () => { for (const listener of listeners) listener() }

    function normalizeKind(kind) {
      return KINDS.indexOf(kind) >= 0 ? kind : 'info'
    }

    // 展示期:sticky 常驻不计时;非 sticky 取调用方有限正值,否则默认
    // (Infinity / 超钳位上界的值经浏览器 WebIDL 钳为约 24.8 天,近乎永久驻留,
    // 与展示期意图相反,必须拦;Node 语义才是溢出钳 1ms,勿混)
    function resolveHoldMs(opts) {
      const holdMs = opts && opts.holdMs
      return typeof holdMs === 'number' && Number.isFinite(holdMs) && holdMs > 0 && holdMs <= HOLD_MS_MAX ? holdMs : TOAST_HOLD_MS
    }

    // 幂等移除:未命中零分配早退;命中先撤销自动消失计时,不入滞留空转
    function dismiss(id) {
      const item = items.find((entry) => entry.id === id)
      if (item === undefined) return
      if (item.timer !== undefined) {
        clearTimeout(item.timer)
        item.timer = undefined
      }
      items = items.filter((entry) => entry.id !== id)
      emit()
    }

    const clearTimer = (entry) => {
      if (entry.timer !== undefined) {
        clearTimeout(entry.timer)
        entry.timer = undefined
      }
    }

    // 入栈即返回单调 id;超上限裁最旧(含 sticky,极端场景下错误提示让位于新通知),
    // 被裁条目的自动消失计时同步撤销;非 sticky 条目入栈即挂自动消失计时
    function show(text, opts) {
      if (typeof text !== 'string' || text.trim() === '') return null
      const sticky = Boolean(opts && opts.sticky)
      const onClick = typeof (opts && opts.onClick) === 'function' ? opts.onClick : undefined
      const entry = { id: ++seq, text, kind: normalizeKind(opts && opts.kind), sticky, onClick, timer: undefined }
      const merged = items.concat(entry)
      if (merged.length > TOAST_MAX) {
        for (const dropped of merged.slice(0, merged.length - TOAST_MAX)) clearTimer(dropped)
      }
      items = merged.slice(-TOAST_MAX)
      emit()
      // 挂载失败不抛给消费方:条目已在 store,后续 show 的自愈重建会补展示
      try {
        mount()
      } catch (error) {
        console.warn('dsh-common-tools(toast): 容器挂载失败,待下次触发自愈: ' + (error instanceof Error ? error.message : String(error)))
      }
      if (!sticky) entry.timer = setTimeout(() => dismiss(entry.id), resolveHoldMs(opts))
      return entry.id
    }

    const toastSource = {
      getSnapshot: () => items,
      subscribe(listener) {
        listeners.add(listener)
        return () => listeners.delete(listener)
      },
    }

    // ---- toast 渲染:容器直挂 body,不依赖宿主生命周期 ----

    // 样式内容原位比对:一致跳过,不一致(HMR 新代 CSS 变化)原位替换;
    // 在位节点无论新旧一律幂等补 data-plugin,防历史代残留缺标记被宿主 claimStyles 误归属
    function ensureStyle() {
      const stale = document.getElementById(STYLE_ID)
      if (stale !== null) {
        if (stale.textContent !== CSS) stale.textContent = CSS
        stale.setAttribute('data-plugin', '@mzzsfy/dsh-common-tools')
        return
      }
      const style = document.createElement('style')
      style.id = STYLE_ID
      // 自带 data-plugin:缺失时宿主 claimStyles 会把它归属给后续材质化插件,其 HMR 重建即误删
      style.setAttribute('data-plugin', '@mzzsfy/dsh-common-tools')
      style.textContent = CSS
      document.head.appendChild(style)
    }

    // 代际标记:window 级自增,旧代闭包经共享载体比对在位容器代际决定接管或退避
    const GEN = (window.__dshToolsToastGen = (window.__dshToolsToastGen || 0) + 1)

    // 容器自愈:本代容器在场即幂等(样式顺带自愈);在位容器属更新代际则本代
    // 退避不动 DOM(一次性告警,迟到通知静默蒸发是排障盲区);否则清理旧容器
    // (本代被外部移除的、HMR 上一代残留的、无归属标记的外部同 id 节点),
    // 逐个卸载 React root(detached 树不再续渲染)后移除重建
    let root = null
    let host = null
    let retireWarned = false
    function mount() {
      const inPlace = document.getElementById(HOST_ID)
      if (root !== null && inPlace === host) {
        ensureStyle()
        return
      }
      if (inPlace !== null && inPlace.__toastGen !== undefined && inPlace.__toastGen > GEN) {
        if (!retireWarned) {
          retireWarned = true
          console.warn('dsh-common-tools(toast): 本代已退役(在位容器属更新代际),本次通知不可见,请刷新页面恢复')
        }
        return
      }
      for (const stale of new Set([host, inPlace])) {
        if (stale === null) continue
        if (stale.__toastRoot !== undefined) stale.__toastRoot.unmount()
        else console.warn('dsh-common-tools(toast): 移除无归属标记的同 id 容器(外部或其他代际残留)')
        stale.remove()
      }
      ensureStyle()
      host = document.createElement('div')
      host.id = HOST_ID
      document.body.appendChild(host)
      root = createRoot(host)
      host.__toastRoot = root
      host.__toastGen = GEN
      root.render(React.createElement(ToastHost))
    }

    function ToastHost() {
      const current = useSyncExternalStore(toastSource.subscribe, toastSource.getSnapshot)
      return h('div', { className: 'dsh-toast-stack' },
        current.map((item) => h(ToastItem, { key: item.id, item })),
      )
    }

    function ToastItem(props) {
      const item = props.item
      // 携带 onClick 的条目整卡可点:触发回调并消失;「知道了」按钮先阻断冒泡,
      // 显式关闭不得连带触发直达动作
      const activate = item.onClick === undefined
        ? undefined
        : () => { dismiss(item.id); item.onClick() }
      return h('div', {
        className: 'dsh-toast dsh-toast--' + item.kind + (activate !== undefined ? ' dsh-toast--click' : ''),
        role: 'alert',
        onClick: activate,
      },
        h('span', null, item.text),
        item.sticky
          ? h('button', {
              className: 'dsh-toast__close',
              onClick: (event) => { event.stopPropagation(); dismiss(item.id) },
            }, '知道了')
          : null,
      )
    }

    // ---- bus:页面共享连接,插件即通道 ----

    const BUS_ROUTE = '/api/bus/ws'
    const MAX_BYTES = 1024 * 1024
    const RETRY_MIN_MS = 1000
    const RETRY_MAX_MS = 30 * 1000
    const CONNECT_TIMEOUT_MS = 10 * 1000
    const busState = (window.__dshCommonToolsBus ??= {
      socket: null, owners: new Set(), subscriptions: new Set(), ready: new Set(), retry: null, timeout: null, attempts: 0, revision: 0, closing: false,
    })

    function requireName(value, label) {
      if (typeof value !== 'string' || value.trim() === '') throw new Error('common-tools: ' + label + ' 必须为非空字符串')
      return value
    }

    function invoke(subscription, method, args) {
      if (!busState.subscriptions.has(subscription)) return
      const callback = method === 'onChange' ? subscription.listener : subscription.onReset
      if (typeof callback !== 'function') return
      const warn = error => console.warn('dsh-common-tools(bus): ' + method + ' 回调异常: ' + String(error))
      try { Promise.resolve(callback(...args)).catch(warn) } catch (error) { warn(error) }
    }

    function send(frame) {
      const text = JSON.stringify(frame)
      if (Object.hasOwn(frame, 'payload') && !Object.hasOwn(JSON.parse(text), 'payload')) throw new TypeError('common-tools: payload 必须可序列化为 JSON')
      if (new TextEncoder().encode(text).length + busState.socket.bufferedAmount > MAX_BYTES) {
        throw new Error('common-tools: 消息或发送积压超过上限')
      }
      busState.socket.send(text)
    }

    function syncPlugins() {
      if (busState.closing || busState.socket?.readyState !== WebSocket.OPEN) return
      const plugins = [...new Set([...busState.subscriptions].map(subscription => subscription.plugin))]
      const revision = busState.revision + 1
      send({ type: 'subscribe', plugins, revision })
      busState.revision = revision
    }

    function connectBus() {
      const url = new URL(BUS_ROUTE, window.location.href)
      url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
      const socket = new WebSocket(url.href)
      busState.socket = socket
      busState.timeout = setTimeout(() => socket.close(), CONNECT_TIMEOUT_MS)
      socket.onopen = () => {
        if (busState.socket === socket) syncPlugins()
      }
      socket.onerror = () => socket.close()
      socket.onclose = () => {
        if (busState.socket !== socket) return
        clearTimeout(busState.timeout)
        busState.socket = null
        busState.closing = false
        busState.ready.clear()
        for (const subscription of busState.subscriptions) subscription.ready = false
        if (busState.owners.size === 0) return
        const delay = Math.min(RETRY_MAX_MS, RETRY_MIN_MS * 2 ** Math.min(busState.attempts++, 5))
        busState.retry = setTimeout(() => { busState.retry = null; connectBus() }, delay * (0.5 + Math.random() / 2))
      }
      socket.onmessage = event => {
        if (busState.socket !== socket) return
        let frame
        try { frame = JSON.parse(event.data) } catch { return }
        if (!frame || typeof frame !== 'object') return
        if (frame.type === 'ready' && frame.revision === busState.revision && Array.isArray(frame.plugins)
          && frame.plugins.every(plugin => typeof plugin === 'string' && plugin.trim() !== '')) {
          clearTimeout(busState.timeout)
          busState.attempts = 0
          busState.ready = new Set(frame.plugins)
          for (const subscription of [...busState.subscriptions]) {
            if (subscription.ready || !busState.ready.has(subscription.plugin)) continue
            subscription.ready = true
            invoke(subscription, 'onReset', [])
          }
          return
        }
        if (frame.type !== 'message' || typeof frame.plugin !== 'string' || !Object.hasOwn(frame, 'payload')) return
        for (const subscription of [...busState.subscriptions]) {
          if (subscription.ready && subscription.plugin === frame.plugin) {
            invoke(subscription, 'onChange', [frame.payload])
          }
        }
      }
    }

    function setupCommonTools(ctx) {
      const plugin = requireName(ctx?.fiber?.entry?.options?.name, 'ctx.fiber.entry.options.name')
      const owner = { plugin, subscriptions: new Set() }
      const assertActive = () => {
        if (!busState.owners.has(owner)) throw new Error('common-tools: 插件已卸载')
      }
      const stop = subscription => {
        owner.subscriptions.delete(subscription)
        if (!busState.subscriptions.delete(subscription)) return
        if (![...busState.subscriptions].some(item => item.plugin === plugin)) busState.ready.delete(plugin)
      }
      const sync = () => { try { syncPlugins() } catch { busState.socket?.close() } }
      ctx.effect(() => {
        busState.owners.add(owner)
        try {
          if (busState.socket === null && busState.retry === null) connectBus()
        } catch (error) { busState.owners.delete(owner); throw error }
        return () => {
          if (!busState.owners.delete(owner)) return
          for (const subscription of [...owner.subscriptions]) stop(subscription)
          if (busState.owners.size > 0) { sync(); return }
          clearTimeout(busState.retry)
          clearTimeout(busState.timeout)
          busState.retry = null
          busState.ready.clear()
          busState.attempts = 0
          const socket = busState.socket
          if (socket) {
            busState.closing = true
            socket.onopen = socket.onmessage = null
            socket.close()
          }
        }
      }, 'common-tools WS 生命周期')
      return {
        subscribe(listener, { onReset } = {}) {
          assertActive()
          if (typeof listener !== 'function') throw new TypeError('common-tools: listener 必须为函数')
          const subscription = { plugin, listener, onReset, ready: false }
          owner.subscriptions.add(subscription)
          busState.subscriptions.add(subscription)
          try {
            if (busState.ready.has(plugin)) {
              subscription.ready = true
              invoke(subscription, 'onReset', [])
            } else syncPlugins()
          } catch (error) { stop(subscription); throw error }
          return () => {
            if (!busState.subscriptions.has(subscription)) return
            stop(subscription)
            sync()
          }
        },
        publish(payload = null) {
          assertActive()
          if (busState.closing || busState.socket?.readyState !== WebSocket.OPEN) {
            throw new Error('common-tools: 连接未就绪')
          }
          send({ type: 'publish', plugin, payload })
        },
      }
    }

    const SNAPSHOT_INTERVAL_MS = 1000
    function createSnapshotRefresh(load) {
      let active = true, inflight = false, dirty = false, timer = null, nextAt = 0
      const refresh = () => {
        if (!active) return
        dirty = true
        if (inflight || timer !== null) return
        const delay = nextAt - Date.now()
        if (delay > 0) { timer = setTimeout(() => { timer = null; refresh() }, delay); return }
        dirty = false
        inflight = true
        nextAt = Date.now() + SNAPSHOT_INTERVAL_MS
        let pending
        try { pending = load() } catch (error) { pending = Promise.reject(error) }
        Promise.resolve(pending).catch(error => console.warn('dsh-common-tools: 快照刷新失败:', error)).finally(() => {
          inflight = false
          if (dirty && active) refresh()
        })
      }
      return { refresh, dispose() { active = false; dirty = false; clearTimeout(timer); timer = null } }
    }

    return {
      apply() {},
      createSnapshotRefresh,
      toast: {
        show,
        dismiss,
        mount,
        // 非公开 API,仅供本包测试驱动 store 消费,无兼容承诺,消费方禁用
        __test: { show, dismiss, toastSource, normalizeKind, resolveHoldMs, getItems: () => items.slice() },
      },
      setupCommonTools,
    }
  },
})
