import { WebSocket, WebSocketServer } from 'ws'

const REGISTRY_KEY = '__dshCommonTools'
const BUS_ROUTE = '/api/bus/ws'
const PKG_VERSION = '1.0.0'
const MAX_BYTES = 1024 * 1024
const HEARTBEAT_MS = 30 * 1000

function requireName(value, label) {
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`common-tools: ${label} 必须为非空字符串`)
  return value
}

function invoke(listener, value) {
  try {
    Promise.resolve(listener(value)).catch(error => console.warn('[dsh-common-tools] 回调失败:', error))
  } catch (error) { console.warn('[dsh-common-tools] 回调失败:', error) }
}

function encode(value) {
  const text = JSON.stringify(value)
  if (Object.hasOwn(value, 'payload') && !Object.hasOwn(JSON.parse(text), 'payload')) throw new TypeError('common-tools: payload 必须可序列化为 JSON')
  if (Buffer.byteLength(text) > MAX_BYTES) throw new Error('common-tools: 消息超过大小上限')
  return text
}

const CHANGE_INTERVAL_MS = 1000

export function createChangeNotifier(publish) {
  let nextAt = 0, timer = null, active = true
  const refresh = () => {
    if (!active || timer !== null) return
    const delay = nextAt - Date.now()
    if (delay > 0) { timer = setTimeout(() => { timer = null; refresh() }, delay); return }
    nextAt = Date.now() + CHANGE_INTERVAL_MS
    publish()
  }
  return { refresh, dispose() { active = false; clearTimeout(timer); timer = null } }
}

export function setupCommonTools(ctx) {
  return install(ctx, PKG_VERSION)
}

function install(ctx, version) {
  const pluginName = requireName(ctx?.fiber?.entry?.options?.name, 'ctx.fiber.entry.options.name')
  if (typeof ctx?.webServer?.registerUpgrade !== 'function') {
    console.warn('[dsh-common-tools] webServer 缺少 registerUpgrade, 总线停用')
    return { publish() {}, subscribe: () => () => {}, onPresence: () => () => {} }
  }
  const reg = (globalThis[REGISTRY_KEY] ??= {
    active: null,
    callers: new Map(),
    state: { listeners: new Map(), presence: new Map() },
  })
  const token = Symbol(pluginName)
  const stops = new Set()
  reg.callers.set(token, pluginName)
  const newer = (a, b) => {
    const left = a.split('.').map(Number), right = b.split('.').map(Number)
    for (let i = 0; i < left.length; i++) {
      if (left[i] !== right[i]) return left[i] > right[i]
    }
    return false
  }
  if (reg.active === null || newer(version, reg.active.ver)) {
    reg.active?.teardown()
    reg.active = createTransport(ctx.webServer, version, reg.state)
  }
  const own = off => {
    const stop = () => { if (stops.delete(stop)) off() }
    stops.add(stop)
    return stop
  }
  ctx.effect(() => () => {
    reg.callers.delete(token)
    for (const stop of [...stops]) stop()
    if (reg.callers.size === 0) {
      reg.active.teardown()
      reg.active = null
      reg.state = { listeners: new Map(), presence: new Map() }
    }
  }, 'common-tools WS 生命周期')
  const active = () => {
    if (!reg.callers.has(token)) throw new Error('common-tools: 插件已卸载')
    return reg.active
  }
  return {
    publish(payload = null) { active().publish(pluginName, payload) },
    subscribe(listener) {
      active()
      if (typeof listener !== 'function') throw new TypeError('common-tools: listener 必须为函数')
      const listeners = reg.state.listeners.get(pluginName) ?? new Set()
      reg.state.listeners.set(pluginName, listeners)
      const entry = { listener }
      listeners.add(entry)
      return own(() => {
        listeners.delete(entry)
        if (listeners.size === 0) reg.state.listeners.delete(pluginName)
      })
    },
    onPresence(listener) {
      const transport = active()
      if (typeof listener !== 'function') throw new TypeError('common-tools: listener 必须为函数')
      const listeners = reg.state.presence.get(pluginName) ?? new Set()
      reg.state.presence.set(pluginName, listeners)
      const entry = { listener }
      listeners.add(entry)
      const stop = own(() => {
        listeners.delete(entry)
        if (listeners.size === 0) reg.state.presence.delete(pluginName)
      })
      invoke(listener, transport.count(pluginName))
      return stop
    },
  }
}

function createTransport(webServer, ver, state) {
  const server = new WebSocketServer({ noServer: true, maxPayload: MAX_BYTES, perMessageDeflate: false })
  const connections = new Set()
  const count = plugin => [...connections].filter(connection => connection.plugins.has(plugin)).length
  const notify = plugins => {
    for (const plugin of plugins) {
      const listeners = state.presence.get(plugin)
      for (const entry of [...(listeners ?? [])]) {
        if (listeners.has(entry)) invoke(entry.listener, count(plugin))
      }
    }
  }
  const send = (connection, text) => {
    const socket = connection.socket
    if (socket.readyState !== WebSocket.OPEN) return
    if (socket.bufferedAmount + Buffer.byteLength(text) > MAX_BYTES) { socket.terminate(); return }
    socket.send(text, error => { if (error) socket.terminate() })
  }
  const remove = connection => {
    if (!connections.delete(connection)) return
    notify(connection.plugins)
  }
  const accept = (socket, req) => {
    let canPublish = req.headers.origin === undefined
    if (!canPublish) {
      try { canPublish = new URL(req.headers.origin).host === req.headers.host } catch { canPublish = false }
    }
    const connection = { socket, plugins: new Set(), alive: true, canPublish }
    connections.add(connection)
    socket.on('error', () => { socket.terminate(); remove(connection) })
    socket.on('close', () => remove(connection))
    socket.on('pong', () => { connection.alive = true })
    socket.on('message', (data, binary) => {
      if (binary) { socket.close(1003, 'text required'); return }
      let frame
      try { frame = JSON.parse(data.toString()) } catch { socket.close(1008, 'invalid JSON'); return }
      if (!frame || typeof frame !== 'object') { socket.close(1008, 'invalid frame'); return }
      if (frame.type === 'subscribe' && Number.isSafeInteger(frame.revision) && frame.revision > 0 && Array.isArray(frame.plugins)
        && frame.plugins.every(plugin => typeof plugin === 'string' && plugin.trim() !== '')) {
        const next = new Set(frame.plugins)
        const changed = new Set([...connection.plugins, ...next].filter(plugin => connection.plugins.has(plugin) !== next.has(plugin)))
        connection.plugins = next
        send(connection, encode({ type: 'ready', plugins: [...next], revision: frame.revision }))
        notify(changed)
        return
      }
      if (frame.type === 'publish' && !connection.canPublish) { socket.close(1008, 'cross-origin write'); return }
      if (frame.type === 'publish' && typeof frame.plugin === 'string' && frame.plugin.trim() !== ''
        && Object.hasOwn(frame, 'payload')) {
        const listeners = state.listeners.get(frame.plugin)
        for (const entry of [...(listeners ?? [])]) {
          if (listeners.has(entry)) invoke(entry.listener, frame.payload)
        }
        return
      }
      socket.close(1008, 'invalid frame')
    })
  }
  const dispose = webServer.registerUpgrade({
    path: BUS_ROUTE,
    handler(req, socket, head) { server.handleUpgrade(req, socket, head, websocket => accept(websocket, req)) },
  })
  const heartbeat = setInterval(() => {
    for (const connection of connections) {
      if (!connection.alive) { connection.socket.terminate(); remove(connection); continue }
      connection.alive = false
      connection.socket.ping()
    }
  }, HEARTBEAT_MS)
  heartbeat.unref()
  return {
    ver,
    count,
    publish(plugin, payload) {
      const text = encode({ type: 'message', plugin, payload })
      for (const connection of connections) {
        if (connection.plugins.has(plugin)) send(connection, text)
      }
    },
    teardown() {
      dispose()
      clearInterval(heartbeat)
      for (const connection of [...connections]) { connection.socket.terminate(); remove(connection) }
      server.close()
    },
  }
}

export const __test = { install }
