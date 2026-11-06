// 真实宿主 webServer 的可观测替身: 三张表 + 单座位 fallback + 原生 http.Server 监听。
// 分发语义逐条对齐 @deepseek-ai/dsh-host-webserver 0.2.x:
//   HTTP    exact → 最长前缀 → fallback(function 或 {resource}); 无处理者 404
//   upgrade 仅 exact pathname, miss 即 socket.destroy(); 命中登记 upgradedSockets
//   resource fallback 只受理 GET/HEAD, 其余 405
//   dispose close → closeAllConnections → 销毁 upgradedSockets → close 收敛
// 插件的监听层分流必须在这个替身上成立, 不得再拿「自己谎报分发语义的 mock」自证。
import http from 'node:http'
import { once } from 'node:events'

export const FUNCTION_FALLBACK = 'function'
export const RESOURCE_FALLBACK = 'resource'

const RESOURCE_METHODS = 'GET, HEAD'

export class FakeHost {
  exact = new Map()
  prefixes = new Map()
  upgrades = new Map()
  upgradedSockets = new Set()
  fallback = undefined
  host = '127.0.0.1'
  protocol = 'http:'
  server = undefined
  listenedPort = undefined

  constructor(options = {}) {
    this.fallbackShape = options.fallbackShape ?? FUNCTION_FALLBACK
    this.server = http.createServer((req, res) => this.handle(req, res))
    this.server.on('upgrade', (req, socket, head) => this.upgrade(req, socket, head))
  }

  get port() {
    return this.listenedPort
  }

  register(route) {
    const table = route.kind === 'exact' ? this.exact : this.prefixes
    if (table.has(route.path)) throw new Error(`webserver: duplicate ${route.kind} route "${route.path}"`)
    table.set(route.path, route)
    return () => { table.delete(route.path) }
  }

  registerUpgrade(route) {
    if (this.upgrades.has(route.path)) throw new Error(`webserver: duplicate upgrade route "${route.path}"`)
    this.upgrades.set(route.path, route)
    return () => { this.upgrades.delete(route.path) }
  }

  registerFallback(fallback) {
    if (this.fallback !== undefined) throw new Error('webserver: fallback already registered')
    this.fallback = fallback
    return () => { this.fallback = undefined }
  }

  /** 宿主自带的分流: 插件的监听层拦截在此之上或之下都必须保持这一语义。 */
  handle(req, res) {
    const pathname = new URL(req.url ?? '/', 'http://x').pathname
    const responder = this.match(pathname) ?? this.fallback
    if (responder === undefined) {
      res.writeHead(404)
      res.end()
      return
    }
    if (typeof responder === 'function') return responder(req, res)
    if ('resource' in responder) return this.serveResource(req, res, responder.resource)
    return responder.handler(req, res)
  }

  match(pathname) {
    const exact = this.exact.get(pathname)
    if (exact !== undefined) return exact
    let best
    for (const [prefix, route] of this.prefixes) {
      if (pathname !== prefix && !pathname.startsWith(prefix + '/')) continue
      if (best === undefined || prefix.length > best.path.length) best = route
    }
    return best
  }

  async serveResource(req, res, resource) {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { allow: RESOURCE_METHODS })
      res.end()
      return
    }
    const request = new Request('http://' + (req.headers.host ?? 'host') + (req.url ?? '/'), {
      method: req.method,
      headers: req.headers,
      signal: AbortSignal.timeout(10 * 1000),
    })
    const response = await resource(request, undefined)
    res.writeHead(response.status, Object.fromEntries(response.headers))
    res.end(Buffer.from(await response.arrayBuffer()))
  }

  upgrade(req, socket, head) {
    const route = this.upgrades.get(new URL(req.url ?? '/', 'http://x').pathname)
    if (route === undefined) {
      socket.destroy()
      return
    }
    this.upgradedSockets.add(socket)
    socket.once('close', () => this.upgradedSockets.delete(socket))
    route.handler(req, socket, head)
  }

  /** 默认 fallback: 按构造时的形态安装。 */
  installFallback(body = 'host-fallback') {
    if (this.fallbackShape === RESOURCE_FALLBACK) {
      return this.registerFallback({ resource: async () => new Response(body, { status: 200, headers: { 'content-type': 'text/plain' } }) })
    }
    return this.registerFallback((req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain' })
      res.end(body)
    })
  }

  async listen() {
    this.server.listen(0, this.host)
    await once(this.server, 'listening')
    this.listenedPort = this.server.address().port
    return this.listenedPort
  }

  /** 宿主 disposer 的同款顺序; 超时即判定关闭悬挂。 */
  async dispose({ timeoutMs = 3000 } = {}) {
    if (this.listenedPort === undefined) return 'not-listening'
    const closed = new Promise((resolve) => this.server.close(() => resolve('closed')))
    this.server.closeAllConnections()
    const tracked = [...this.upgradedSockets]
    await Promise.all(tracked.map((socket) => new Promise((resolve) => {
      socket.once('close', resolve)
      socket.destroy()
    })))
    return Promise.race([closed, new Promise((resolve) => setTimeout(() => resolve('hung'), timeoutMs))])
  }
}

/** 目标应用: 回显请求要素, 可断言隧道转发的真实形态。 */
export async function startTarget(handler) {
  const server = http.createServer(handler)
  server.on('upgrade', (req, socket) => {
    socket.write('HTTP/1.1 101 Switching Protocols\r\nconnection: Upgrade\r\nupgrade: websocket\r\n\r\n')
    socket.pipe(socket)
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  return {
    port: server.address().port,
    async stop() {
      server.closeAllConnections()
      await once(server.close(), 'close')
    },
  }
}
