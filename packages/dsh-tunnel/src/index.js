// dsh-tunnel Host 半区: 双入口反向代理。
//   path      /p/<name> 前缀路由(strip 后转发, 注册走 webServer 公开 API)
//   subdomain <name>.* 首标签命中即全路径全协议透传(Host 分流)
// 宿主没有 Host 维度的公开路由能力, 唯一在各代宿主上都成立且可逆的接入点是监听层:
// 摘下 webServer.server 的 request/upgrade 监听各插一层, 命中隧道即转发, 否则原样
// 委托原监听。由此不再改写任何其它插件的路由/handler, 也不再依赖 fallback 的形态
// (0.2.1 为函数, 0.2.2 为 { resource })。升级握手同层分发, 故任意 WS 路径可用。
// 规格: docs/设计-隧道改造.md; 安全边界: DEVELOPMENT/dsh-api-alignment.md。

import { randomUUID } from 'node:crypto'
import http from 'node:http'
import net from 'node:net'
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, networkInterfaces } from 'node:os'
import { join } from 'node:path'
import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'

import { setupCommonTools, createChangeNotifier } from '@mzzsfy/dsh-common-tools/host'
import { createApi, MESSAGES, ROUTE_PREFIX as API_PREFIX } from './api.mjs'
import { probeTcpPort, scanListeningPorts } from './discovery.mjs'
import { withRouteGate } from './route-gate.mjs'

export const name = 'dsh-tunnel'

export const inject = ['webServer']

const PATH_PREFIX = '/p/'
const TUNNEL_NAME_RE = /^[a-z0-9][a-z0-9-]{0,31}$/
// 纯数字名会与纯 IP 访问的首段撞上(Host: 127.0.0.1 命中隧道名 127, 整个入口被劫持)
const NAME_HAS_LETTER_RE = /[a-z]/
const PORT_MIN = 1
const PORT_MAX = 65535
const DEFAULT_CONNECT_TIMEOUT = 10 * 1000
const REDIRECT_MIN = 300
const REDIRECT_MAX = 399
const STORE_FILE = 'tunnels.json'
const STORE_TMP_SUFFIX = '.tmp'
// rename 的临时文件若被外部清理, 重建重试的写尝试总次数
const STORE_WRITE_ATTEMPTS = 3
const WARN_TAG = 'dsh-tunnel: '

const ENTRY_PATH = 'path'
const ENTRY_SUBDOMAIN = 'subdomain'
const VALID_ENTRIES = new Set([ENTRY_PATH, ENTRY_SUBDOMAIN])
const SETTINGS_NS = 'tunnel'
const SETTINGS_UNAVAILABLE = '设置服务不可用'
const HEALTH_CACHE_TTL_MS = 3_000

// 监听层安装标记: 只装一次, 代际切换靠载体重定向, 旧包装退化为纯穿透
const LISTENER_PROP = 'dshTunnelListener'
// 分发载体: 包装器调用期动态读取, 插件重载后旧包装器自动路由到新代
const DISPATCH_PROP = 'dshTunnelDispatch'
// 超时载体: 同代际切换, 配置变更后旧包装器读到新值
const TIMEOUT_PROP = 'dshTunnelTimeout'
const TIMED_OUT_MARK = Symbol.for('dsh-tunnel.timedOut')

const renderJson = (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }]

// 逐跳头不透传: 连接管理由两端的 node http 栈各自负责
const HOP_BY_HOP = new Set(['connection', 'keep-alive', 'transfer-encoding', 'upgrade', 'te', 'trailer', 'proxy-authorization', 'proxy-authenticate'])
// 升级面仅这两个逐跳头属于握手本身, 必须保留
const UPGRADE_HANDSHAKE_HEADERS = new Set(['connection', 'upgrade'])
// Connection 头里点名的自定义逐跳头同样不得透传(RFC 9110 §7.6.1)
function connectionTokensOf(value) {
  return new Set(String(value ?? '').split(',').map((token) => token.trim().toLowerCase()).filter(Boolean))
}
// 信任链头剥离: 入站伪造的代理链声明一律替换为本插件视角的真实值
const FORWARDED_LIE_HEADERS = ['forwarded', 'via', 'x-real-ip']

const TIMEOUT_MIN_MS = 1
const TIMEOUT_MAX_MS = 60 * 1000
const timeoutField = () => z.number().step(1).min(TIMEOUT_MIN_MS).max(TIMEOUT_MAX_MS).default(DEFAULT_CONNECT_TIMEOUT)
  .description('等待目标响应头的超时, 头到即解除(SSE 等长流不受影响)')
const aiToolsField = () => z.boolean().default(true)
  .description('允许 ai 调用隧道工具(tunnel_open/list/ports/close), 关闭即向 ai 注销; 设置页与 REST 管理不受影响')

// 字段级 volatile 标记: 0.1.7+ 该字段进自动配置节并支持 loader 原地热更;
// 旧宿主 schemastery 无 volatile 方法, 特性检测原样返回(dsh-maintain 同构)
const volatileField = (schema) => (typeof schema.volatile === 'function' ? schema.volatile() : schema)

export const Config = z.object({
  connectTimeoutMs: volatileField(timeoutField()),
  dataDir: z.string().default(join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'dsh-tunnel'))
    .description('隧道表持久化目录'),
  aiTools: volatileField(aiToolsField()),
})

export const SETTINGS_SCHEMA = z.object({
  connectTimeoutMs: timeoutField(),
  aiTools: aiToolsField(),
})

function validateName(value) {
  return typeof value === 'string' && TUNNEL_NAME_RE.test(value) && NAME_HAS_LETTER_RE.test(value)
}

function validatePort(port) {
  return Number.isInteger(port) && port >= PORT_MIN && port <= PORT_MAX
}

const AUTO_NAME_PREFIX = 'app'
const TUNNEL_NAME_RE_MAX_BASE = 32
// 自动名只用进程名做提示, 最终仍落回 TUNNEL_NAME_RE; 端口后缀保证短且唯一。
function autoNameFor(port, processName) {
  const base = String(processName ?? '')
    .replace(/\.[^.]+$/, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  const safeBase = NAME_HAS_LETTER_RE.test(base) ? base : AUTO_NAME_PREFIX
  const suffix = '-' + port
  const clipped = safeBase.slice(0, TUNNEL_NAME_RE_MAX_BASE - suffix.length).replace(/-+$/g, '') || AUTO_NAME_PREFIX
  return clipped + suffix
}

function uniqueTunnelName(rows, base, port) {
  const first = autoNameFor(port, base)
  if (!rows.has(first)) return first
  for (let index = 2; ; index += 1) {
    const candidate = `${first}-${index}`
    if (!rows.has(candidate)) return candidate
  }
}

function statusOf(row, health) {
  if (row.enabled === false) return 'disabled'
  if (row.error !== undefined) return 'route_error'
  if (health?.state === 'online') return 'online'
  if (health?.state === 'offline') return 'offline'
  return 'unknown'
}

function localOriginOf(webServer) {
  let host = String(webServer.host ?? '127.0.0.1')
  if (host === '' || host === '0.0.0.0' || host === '::') host = '127.0.0.1'
  if (host.includes(':') && !host.startsWith('[')) host = `[${host}]`
  return `${protocolOf(webServer)}://${host}:${webServer.port}`
}

function isPrivateIPv4(address) {
  const parts = String(address).split('.').map(Number)
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false
  return parts[0] === 10
    || (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31)
    || (parts[0] === 192 && parts[1] === 168)
}

function isVirtualInterface(name) {
  return /(vEthernet|docker|br-|vmnet|virtualbox|wsl|hyper-v|tailscale|zerotier|loopback)/i.test(String(name))
}

function lanOriginOf(webServer) {
  const host = String(webServer.host ?? '')
  const wildcard = host === '' || host === '0.0.0.0' || host === '::'
  if (!wildcard) {
    if (host === 'localhost' || host === '::1' || host.startsWith('127.')) return undefined
    const literal = host.includes(':') && !host.startsWith('[') ? `[${host}]` : host
    return `${protocolOf(webServer)}://${literal}:${webServer.port}`
  }
  for (const [name, entries] of Object.entries(networkInterfaces())) {
    if (isVirtualInterface(name)) continue
    for (const entry of entries ?? []) {
      if (entry.family === 'IPv4' && entry.internal !== true && isPrivateIPv4(entry.address)) {
        return `${protocolOf(webServer)}://${entry.address}:${webServer.port}`
      }
    }
  }
  return undefined
}

function accessUrlFor(record, origin, port) {
  if (record.entry === ENTRY_PATH) return origin + PATH_PREFIX + record.name + '/'
  const protocol = origin.startsWith('https:') ? 'https' : 'http'
  return `${protocol}://${record.name}.localhost:${port}/`
}

// 502/504 给浏览器的可读页: 隧道名与目标端口都来自本进程数据, 仍做 HTML 转义后输出。
function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]))
}

function respondProxyError(req, res, record, status, message) {
  if (!String(req.headers.accept ?? '').includes('text/html')) {
    respondJson(res, status, { ok: false, error: message })
    return
  }
  const title = status === 504 ? '目标响应超时' : '目标服务不可达'
  const html = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>${title}</title>`
    + '<style>body{font:14px/1.6 system-ui,sans-serif;max-width:560px;margin:12vh auto;padding:0 24px;color:#222}'
    + 'h1{font-size:20px}p{color:#555}code{background:#f3f3f3;padding:1px 5px;border-radius:4px}</style>'
    + `<h1>${title}</h1><p>隧道 <code>${escapeHtml(record.name)}</code> 连不上本机端口 <code>${record.targetPort}</code>。</p>`
    + `<p>${escapeHtml(message)}</p><p>确认服务已启动后刷新此页。</p></html>`
  res.writeHead(status, { 'content-type': 'text/html; charset=utf-8' })
  res.end(html)
}

// 首标签取值: 无点主机名不参与子域名匹配(裸 localhost 不劫持)
function firstLabelOf(hostHeader) {
  if (typeof hostHeader !== 'string' || hostHeader === '') return undefined
  let hostname
  try {
    hostname = new URL('http://' + hostHeader).hostname.toLowerCase()
  } catch {
    return undefined
  }
  const at = hostname.indexOf('.')
  return at === -1 ? undefined : hostname.slice(0, at)
}

// 子域名隧道名等于「本次管理请求所在的 Host」首标签: 保存后这个地址会被隧道接管
// (含 /api/*), 设置页在该地址消失, 因此只在这一刻拒绝。
// 不扫描宿主 trustedHosts: 该集合由 auto-trust-all 按到达的 Host 动态累积,
// 泛解析部署下每个试用过的 <name>.<域> 都会永久留在集合里, 用它判入口必然误报
// (名字等于任一历史访问地址就被拒), 而真正会自劫持的只有当前这一个地址。
function entryHostConflict(entryHost, name) {
  return firstLabelOf(entryHost) === name
}

const entryConflictReason = (name, entryHost) =>
  `隧道名与当前访问地址首标签冲突: ${name} 是 ${entryHost} 的首标签, 保存后该地址(含 /api/*)会进入隧道而不是设置页; 换名, 或改用其它地址打开设置页后再建`

// strip 隧道前缀: 前缀本身映射 '/', 其余保留前导 '/' 携带查询串
function targetPathOf(reqUrl, prefix) {
  const url = new URL(reqUrl, 'http://x')
  const rest = url.pathname === prefix ? '/' : url.pathname.slice(prefix.length)
  return rest + url.search
}

// 升级面只保留握手头(connection/upgrade/sec-websocket-*)与端到端头:
// Content-Length/Transfer-Encoding 会让上游把 101 后的字节误当消息体,
// 其余逐跳头与 Connection 点名头同样不得透传。
function forwardedHeaders(req, proto, { upgrade = false } = {}) {
  const headers = {}
  const connectionTokens = connectionTokensOf(req.headers.connection)
  for (const [key, value] of Object.entries(req.headers)) {
    if (key.startsWith('x-forwarded-') || FORWARDED_LIE_HEADERS.includes(key)) continue
    const handshake = upgrade && (UPGRADE_HANDSHAKE_HEADERS.has(key) || key.startsWith('sec-websocket-'))
    if (!handshake && (HOP_BY_HOP.has(key) || connectionTokens.has(key))) continue
    if (upgrade && key === 'content-length') continue
    headers[key] = value
  }
  // 无 Host 头的请求(HTTP/1.0 等)缺源值时跳过, undefined 头会使 http.request 抛错
  if (req.headers.host !== undefined) headers['x-forwarded-host'] = req.headers.host
  if (req.socket?.remoteAddress !== undefined) headers['x-forwarded-for'] = req.socket.remoteAddress
  headers['x-forwarded-proto'] = proto
  return headers
}

// 唯一响应体改写: 同源根绝对路径补前缀(排除协议相对 //), 已在本隧道前缀下的不动。
// 前缀边界按 URL pathname 的路径段判定: /p/app2 不属于隧道 /p/app;
// 查询串与锚点不参与判定, 也不得被二次拼接(/p/app?x、/p/app#f 已是本隧道路径)。
function rewriteLocation(proxyRes, prefix) {
  const location = proxyRes.headers.location
  if (
    proxyRes.statusCode < REDIRECT_MIN || proxyRes.statusCode > REDIRECT_MAX
    || typeof location !== 'string' || !location.startsWith('/') || location.startsWith('//')
  ) return
  let pathname
  try {
    pathname = new URL(location, 'http://x').pathname
  } catch {
    return
  }
  if (pathname === prefix || pathname.startsWith(prefix + '/')) return
  proxyRes.headers.location = prefix + location
}

function respondJson(res, status, payload) {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(payload))
}

function touchStats(record) {
  if (record?.stats === undefined) return
  record.stats.requests += 1
  record.stats.lastAccessAt = new Date().toISOString()
}

function noteProxyStatus(record, status, error) {
  if (record?.stats === undefined) return
  record.stats.lastStatus = status
  if (error !== undefined) {
    record.stats.errors += 1
    record.stats.lastError = error
  }
}

function forwardHttp(req, res, { record, url, timeoutMs, proto }) {
  touchStats(record)
  const proxyReq = http.request({
    host: 'localhost',
    port: record.targetPort,
    autoSelectFamily: true,
    autoSelectFamilyAttemptTimeout: 250,
    method: req.method,
    path: url,
    headers: forwardedHeaders(req, proto),
  })
  proxyReq.on('socket', (socket) => {
    socket.setTimeout(timeoutMs)
    proxyReq.once('response', () => socket.setTimeout(0))
  })
  proxyReq.once('timeout', () => {
    markTimedOut(proxyReq)
    proxyReq.destroy()
  })
  proxyReq.on('response', (proxyRes) => {
    noteProxyStatus(record, proxyRes.statusCode)
    // 仅路径模式改写 Location: 子域名根部署下同源根绝对路径本就正确
    if (record.entry === ENTRY_PATH) rewriteLocation(proxyRes, PATH_PREFIX + record.name)
    const headers = {}
    const connectionTokens = connectionTokensOf(proxyRes.headers.connection)
    for (const [key, value] of Object.entries(proxyRes.headers)) {
      if (!HOP_BY_HOP.has(key) && !connectionTokens.has(key)) headers[key] = value
    }
    res.writeHead(proxyRes.statusCode, headers)
    proxyRes.pipe(res)
    // 上游响应中断即终止下游: aborted 覆盖请求体阶段中断, error 覆盖响应期套接字错误
    proxyRes.on('aborted', () => res.destroy())
    proxyRes.on('error', () => res.destroy())
  })
  proxyReq.on('error', (error) => {
    if (res.headersSent) return res.destroy()
    const status = socketTimedOut(proxyReq) ? 504 : 502
    noteProxyStatus(record, status, error.message)
    respondProxyError(req, res, record, status, `目标不可达: ${error.message}`)
  })
  // 客户端在响应任意阶段断开都回收上游连接(aborted 只覆盖请求体阶段, SSE/GET 不触发)
  res.on('close', () => {
    if (!res.writableEnded) proxyReq.destroy()
  })
  req.pipe(proxyReq)
}

// node 不带 code 的 timeout 销毁只能靠标记: socket timeout 事件打点
function socketTimedOut(proxyReq) {
  return proxyReq[TIMED_OUT_MARK] === true
}

function markTimedOut(proxyReq) {
  proxyReq[TIMED_OUT_MARK] = true
}

// 升级透传: 重建请求头直写目标 socket(握手头 connection/upgrade/sec-websocket-* 与
// 端到端头保留, Content-Length/Transfer-Encoding/逐跳头丢弃), 之后双向管道;
// 任一侧关闭即双向回收(否则正常关闭会留下目标侧悬挂连接)
function forwardUpgrade(req, socket, head, { record, url, timeoutMs, proto }) {
  touchStats(record)
  const headerLines = Object.entries(forwardedHeaders(req, proto, { upgrade: true }))
    .map(([key, value]) => `${key}: ${value}`)
    .join('\r\n')
  const headText = `${req.method} ${url} HTTP/1.1\r\n${headerLines}\r\n\r\n`
  const upstream = net.connect({ host: 'localhost', port: record.targetPort, autoSelectFamily: true, autoSelectFamilyAttemptTimeout: 250 })
  const destroyAll = () => {
    upstream.destroy()
    socket.destroy()
  }
  let established = false
  upstream.setTimeout(timeoutMs, destroyAll)
  // 目标首字节(101 握手)到达即解除空闲计时, 建立后的长连接不受连接超时误杀
  upstream.once('data', () => {
    established = true
    upstream.setTimeout(0)
    noteProxyStatus(record, 101)
  })
  upstream.on('error', (error) => {
    noteProxyStatus(record, 502, error.message)
    // 握手前失败回一个明确的 502, 比让客户端只看到连接被重置可诊断
    if (!established && socket.writable) {
      socket.end('HTTP/1.1 502 Bad Gateway\r\ncontent-length: 0\r\nconnection: close\r\n\r\n')
      upstream.destroy()
      return
    }
    destroyAll()
  })
  upstream.on('close', destroyAll)
  socket.on('error', destroyAll)
  socket.on('close', destroyAll)
  upstream.on('connect', () => {
    upstream.write(headText)
    if (head.length > 0) upstream.write(head)
    socket.pipe(upstream)
    upstream.pipe(socket)
  })
}

function storePath(dataDir) {
  return join(dataDir, STORE_FILE)
}

// 损坏文件按空表处理并告警, 不阻塞激活(禁止加载崩溃)
function loadStore(dataDir) {
  let raw
  try {
    raw = readFileSync(storePath(dataDir), 'utf8')
  } catch (error) {
    if (error.code !== 'ENOENT') console.warn(`${WARN_TAG}隧道表读取失败, 按空表处理: ${error.message}`)
    return []
  }
  try {
    const rows = JSON.parse(raw)
    return Array.isArray(rows) ? rows : []
  } catch {
    console.warn(`${WARN_TAG}隧道表损坏, 按空表处理: ${storePath(dataDir)}`)
    return []
  }
}

// 临时文件按写入者唯一(pid+随机): 固定 .tmp 名会被同 home 的并发实例抢占,
// 前者 rename 时临时文件已消失(ENOENT), 或把半截内容改名成目标
function storeTempPath(path) {
  return `${path}.${process.pid}.${randomUUID()}${STORE_TMP_SUFFIX}`
}

// 写盘失败告警: 隧道本次会话可用, 重启后消失, open 仍返回成功
function saveStore(dataDir, rows) {
  const path = storePath(dataDir)
  try {
    for (let attempt = 1; ; attempt += 1) {
      const tmp = storeTempPath(path)
      try {
        mkdirSync(dataDir, { recursive: true })
        writeFileSync(tmp, JSON.stringify(rows, null, 2))
        renameSync(tmp, path)
        return
      } catch (error) {
        // 临时文件被外部清理时重建再试; 其它错误直接上抛告警
        if (error?.code !== 'ENOENT' || attempt >= STORE_WRITE_ATTEMPTS) throw error
      } finally {
        rmSync(tmp, { force: true })
      }
    }
  } catch (error) {
    console.warn(`${WARN_TAG}隧道表写盘失败: ${error.message}`)
  }
}

// 监听层可用性: 只需要一个原生 http(s).Server 与公开注册面
function listenerUsable(webServer) {
  const server = webServer?.server
  return typeof webServer?.register === 'function'
    && typeof server?.on === 'function'
    && typeof server?.listeners === 'function'
    && typeof server?.removeAllListeners === 'function'
}

// 监听层只装一次: 捕获原监听, 命中隧道先转发, 否则原样委托。
// 卸载不摘监听, 载体置空即纯穿透(与 dsh-auto-trust-all 同款生命周期)。
function installListener(webServer, server) {
  if (server[LISTENER_PROP] !== undefined) return
  const originals = {
    request: server.listeners('request'),
    upgrade: server.listeners('upgrade'),
  }
  server.removeAllListeners('request')
  server.removeAllListeners('upgrade')
  // 分发/转发异常不得冒泡成进程级未捕获异常: 记日志后按未命中处理或回 500
  const dispatch = (kind, req) => {
    try {
      return webServer[DISPATCH_PROP]?.(kind, req)
    } catch (error) {
      console.warn(`${WARN_TAG}隧道分发异常, 交回宿主: ${error.message}`)
      return undefined
    }
  }
  server.on('request', (req, res) => {
    const match = dispatch('request', req)
    if (match !== undefined) {
      try {
        forwardHttp(req, res, { ...match, timeoutMs: readTimeout(webServer), proto: protocolOf(webServer) })
      } catch (error) {
        console.warn(`${WARN_TAG}HTTP 转发失败: ${error.message}`)
        if (!res.headersSent) respondJson(res, 500, { ok: false, error: '隧道转发失败' })
        else res.destroy()
      }
      return
    }
    for (const listener of originals.request) listener.call(server, req, res)
  })
  server.on('upgrade', (req, socket, head) => {
    const match = dispatch('upgrade', req)
    if (match !== undefined) {
      // 按当前代际的 socket 集合登记: 旧代 dispose 只回收自己接入的连接
      const generation = webServer[DISPATCH_PROP]
      trackUpgradedSocket(webServer, socket, generation, match.record)
      forwardUpgrade(req, socket, head, { ...match, timeoutMs: readTimeout(webServer), proto: protocolOf(webServer) })
      return
    }
    for (const listener of originals.upgrade) listener.call(server, req, socket, head)
  })
  server[LISTENER_PROP] = originals
}

// 宿主按 upgradedSockets 收尾关闭流程; 拦截来的连接不登记会让 server.close() 挂死
function trackUpgradedSocket(webServer, socket, generation, record) {
  const own = generation?.sockets
  if (own instanceof Set) {
    own.add(socket)
    socket.once('close', () => own.delete(socket))
  }
  // 子域名 upgrade 另记隧道名: close/停用/改名时按名字回收
  if (record?.entry === ENTRY_SUBDOMAIN && generation?.hostSockets instanceof Map) {
    generation.hostSockets.set(socket, record.name)
    socket.once('close', () => generation.hostSockets.delete(socket))
  }
  // path upgrade 同样按隧道名登记, close 时一起回收
  if (record?.entry === ENTRY_PATH && generation?.pathSockets instanceof Map) {
    generation.pathSockets.set(socket, record.name)
    socket.once('close', () => generation.pathSockets.delete(socket))
  }
  // 宿主按自己的 upgradedSockets 收尾, 两条回收链各管各的代际
  if (webServer.upgradedSockets instanceof Set) {
    webServer.upgradedSockets.add(socket)
    socket.once('close', () => webServer.upgradedSockets.delete(socket))
  }
}

function readTimeout(webServer) {
  const value = webServer[TIMEOUT_PROP]?.()
  return Number.isInteger(value) ? value : DEFAULT_CONNECT_TIMEOUT
}

function protocolOf(webServer) {
  return webServer.protocol === 'https:' ? 'https' : 'http'
}

export function apply(ctx, config) {
  const webServer = ctx.webServer
  if (!listenerUsable(webServer)) {
    console.warn(`${WARN_TAG}宿主监听面形状不匹配(webServer.server/register), 插件停用`)
    return () => {}
  }
  const server = webServer.server

  const bus = setupCommonTools(ctx)
  const changes = createChangeNotifier(() => bus.publish())
  ctx.effect(() => () => changes.dispose(), '通知变更合并')

  // 可变绑定: 偏好改动经 legacy watch / 0.1.7+ volatile-update 回写
  let connectTimeoutMs = DEFAULT_CONNECT_TIMEOUT
  const dataDir = config.dataDir

  const settingsRef = { current: null }
  const unwrapRef = (value) => (typeof value?.get === 'function' ? value.get() : value)
  const readPref = (key) => {
    const fromSettings = settingsRef.current?.get(SETTINGS_NS)?.[key]
    return fromSettings !== undefined ? fromSettings : unwrapRef(config?.[key])
  }
  const aiToolsNow = () => readPref('aiTools') !== false

  let disposeTools = null
  const syncToolsRegistration = () => {
    if (aiToolsNow() && disposeTools === null) {
      ctx.inject(['tools'], (tctx) => {
        if (disposeTools !== null || !aiToolsNow()) return
        const disposers = tools.map((tool) => tctx.tools.register(tool))
        disposeTools = () => { for (const dispose of disposers) dispose() }
      })
    } else if (!aiToolsNow() && disposeTools !== null) {
      disposeTools()
      disposeTools = null
    }
  }

  const applyPreferences = () => {
    const timeout = Number(readPref('connectTimeoutMs'))
    if (Number.isInteger(timeout) && timeout >= TIMEOUT_MIN_MS && timeout <= TIMEOUT_MAX_MS) connectTimeoutMs = timeout
    syncToolsRegistration()
  }

  // rows = 磁盘真值(含激活失败的行); tunnels = 本次活动表(分发只读它)
  const rows = new Map()
  const tunnels = new Map()
  const healthCache = new Map()
  const healthInFlight = new Map()
  const healthEpoch = new Map()
  const emptyStats = () => ({ requests: 0, errors: 0, lastAccessAt: null, lastStatus: null, lastError: null })
  const statsOf = (row) => (row.stats ??= emptyStats())
  // 已建立 upgrade 的隧道名台账: close/停用/改名都按名字回收
  const hostSockets = new Map()
  // path 与 subdomain 分表: 两张表的 socket 都只在对应隧道结束生命周期时回收
  const pathSockets = new Map()

  function registerRoutes(record) {
    return webServer.register({
      kind: 'prefix',
      path: PATH_PREFIX + record.name,
      handler: (req, res) => forwardHttp(req, res, {
        record,
        url: targetPathOf(req.url, PATH_PREFIX + record.name),
        timeoutMs: connectTimeoutMs,
        proto: protocolOf(webServer),
      }),
    })
  }

  // 激活单行: 失败不影响既有隧道, 由调用方决定保留还是回滚行
  function activate(row) {
    if (row.enabled === false) return
    statsOf(row)
    if (row.entry === ENTRY_PATH) row.disposeRoutes = registerRoutes(row)
    tunnels.set(row.name, row)
  }

  // 隧道被摘除/关闭时,既有 path/subdomain upgrade 也必须一起回收
  function closeTunnelSockets(name) {
    for (const sockets of [hostSockets, pathSockets]) {
      for (const [socket, tunnelName] of [...sockets]) {
        if (tunnelName !== name) continue
        sockets.delete(socket)
        socket.destroy()
      }
    }
  }

  function deactivate(name) {
    const row = tunnels.get(name)
    if (row !== undefined) {
      row.disposeRoutes?.()
      delete row.disposeRoutes
      tunnels.delete(name)
    }
    closeTunnelSockets(name)
  }

  const persist = () => saveStore(dataDir, [...rows.values()].map(({ createdAt, enabled, entry, name, targetPort }) => ({ createdAt, enabled: enabled !== false, entry, name, targetPort })))

  function invalidateHealth(name) {
    healthEpoch.set(name, (healthEpoch.get(name) ?? 0) + 1)
    healthCache.delete(name)
    healthInFlight.delete(name)
  }

  async function probeRowHealth(row) {
    if (row.enabled === false || row.error !== undefined || !tunnels.has(row.name)) return undefined
    const cached = healthCache.get(row.name)
    if (cached !== undefined && Date.now() - cached.at < HEALTH_CACHE_TTL_MS) return cached.value
    const pending = healthInFlight.get(row.name)
    if (pending !== undefined) return pending
    const port = row.targetPort
    const epoch = healthEpoch.get(row.name) ?? 0
    const task = probeTcpPort(port)
      .then((value) => {
        const current = rows.get(row.name)
        if (current?.targetPort === port && (healthEpoch.get(row.name) ?? 0) === epoch) {
          healthCache.set(row.name, { at: Date.now(), value })
        }
        return value
      })
      .finally(() => healthInFlight.delete(row.name))
    healthInFlight.set(row.name, task)
    return task
  }

  function rowView(row, health) {
    return {
      name: row.name,
      entry: row.entry,
      access: row.entry === ENTRY_SUBDOMAIN ? `${row.name}.*` : PATH_PREFIX + row.name,
      targetPort: row.targetPort,
      enabled: row.enabled !== false,
      active: tunnels.has(row.name),
      status: statusOf(row, health),
      createdAt: row.createdAt ?? null,
      stats: statsOf(row),
      ...(row.error === undefined ? {} : { error: row.error }),
      ...(health === undefined ? {} : { health }),
    }
  }

  const api = {
    open(args) {
      if (!validatePort(args.targetPort)) {
        return { ok: false, error: '参数不合法: targetPort 须为 1..65535 整数' }
      }
      const requestedName = typeof args.name === 'string' && args.name.trim() !== '' ? args.name.trim() : undefined
      if (requestedName !== undefined && !validateName(requestedName)) {
        return { ok: false, error: '参数不合法: name 须为小写字母/数字/连字符(≤32 位, 且至少含一个字母)' }
      }
      const entry = args.entry ?? ENTRY_PATH
      if (!VALID_ENTRIES.has(entry)) {
        return { ok: false, error: `entry 不合法: 须为 ${ENTRY_PATH} 或 ${ENTRY_SUBDOMAIN}` }
      }
      const hostPort = Number(webServer.port)
      if (args.targetPort === hostPort) {
        return { ok: false, error: `targetPort 不得为宿主监听端口 ${hostPort}(自代理环)` }
      }
      const name = requestedName ?? uniqueTunnelName(rows, AUTO_NAME_PREFIX, args.targetPort)
      // 仅子域名入口按 Host 分流, 名等于当前管理地址首标签即接管该地址; 路径入口只在 /p/<名> 下, 无此冲突
      if (entry === ENTRY_SUBDOMAIN && entryHostConflict(args.entryHost, name)) {
        return { ok: false, error: entryConflictReason(name, args.entryHost) }
      }
      const existing = rows.get(name)
      // 活动行才占用名字; 未激活行允许原地重激活(占位释放后同名 open 不得被死条目永久拒绝)
      if (existing !== undefined && tunnels.has(name)) {
        return { ok: false, error: `隧道名已占用: ${name}` }
      }
      const row = existing ?? {
        name,
        targetPort: args.targetPort,
        entry,
        enabled: true,
        createdAt: new Date().toISOString(),
      }
      const previous = existing === undefined ? undefined : { targetPort: existing.targetPort, entry: existing.entry, enabled: existing.enabled }
      if (existing !== undefined) {
        existing.targetPort = args.targetPort
        existing.entry = entry
        existing.enabled = true
      }
      try {
        activate(row)
      } catch (error) {
        if (existing !== undefined && previous !== undefined) {
          existing.targetPort = previous.targetPort
          existing.entry = previous.entry
          existing.enabled = previous.enabled
          existing.error = String(error.message)
        }
        return { ok: false, error: `路由注册失败: ${error.message}` }
      }
      delete row.error
      invalidateHealth(row.name)
      rows.set(row.name, row)
      persist()
      changes.refresh()
      const origin = localOriginOf(webServer)
      const lanOrigin = lanOriginOf(webServer)
      const outcome = {
        ok: true,
        name: row.name,
        entry,
        port: webServer.port,
        enabled: true,
        url: accessUrlFor(row, origin, webServer.port),
      }
      if (entry === ENTRY_SUBDOMAIN) {
        outcome.host = `${row.name}.localhost`
      } else {
        outcome.path = PATH_PREFIX + row.name
        if (lanOrigin !== undefined) outcome.lanUrl = lanOrigin + PATH_PREFIX + row.name + '/'
      }
      return outcome
    },
    async list(args = {}) {
      // 状态查询先补激活失败的行, 避免占位释放后仍把可用的隧道报成不可用
      retryInactiveRows()
      const list = [...rows.values()]
      const healths = args.probe === true ? await Promise.all(list.map((row) => probeRowHealth(row))) : []
      return { ok: true, tunnels: list.map((row, index) => rowView(row, healths[index])) }
    },
    async update(args) {
      const currentName = args?.name
      const patch = args?.patch
      if (typeof currentName !== 'string' || patch === null || typeof patch !== 'object' || Array.isArray(patch)) {
        return { ok: false, error: '参数不合法: name 与 patch 必填' }
      }
      const allowed = new Set(['name', 'targetPort', 'entry', 'enabled'])
      for (const key of Object.keys(patch)) {
        if (!allowed.has(key)) return { ok: false, error: `不支持修改字段: ${key}` }
      }
      if (Object.keys(patch).length === 0) return { ok: false, error: 'patch 不能为空' }
      const row = rows.get(currentName)
      if (row === undefined) return { ok: false, error: `隧道不存在: ${currentName}` }
      const next = { name: currentName, targetPort: row.targetPort, entry: row.entry, enabled: row.enabled !== false }
      if (patch.name !== undefined) {
        const requestedName = typeof patch.name === 'string' ? patch.name.trim() : ''
        if (!validateName(requestedName)) return { ok: false, error: 'name 须为小写字母/数字/连字符(≤32 位, 且至少含一个字母)' }
        next.name = requestedName
      }
      if (patch.targetPort !== undefined) {
        if (!validatePort(patch.targetPort)) return { ok: false, error: 'targetPort 须为 1..65535 整数' }
        if (patch.targetPort === Number(webServer.port)) return { ok: false, error: `targetPort 不得为宿主监听端口 ${webServer.port}(自代理环)` }
        next.targetPort = patch.targetPort
      }
      if (patch.entry !== undefined) {
        if (!VALID_ENTRIES.has(patch.entry)) return { ok: false, error: `entry 不合法: 须为 ${ENTRY_PATH} 或 ${ENTRY_SUBDOMAIN}` }
        next.entry = patch.entry
      }
      if (patch.enabled !== undefined) {
        if (typeof patch.enabled !== 'boolean') return { ok: false, error: 'enabled 须为布尔' }
        next.enabled = patch.enabled
      }
      if (next.name !== currentName && rows.has(next.name)) return { ok: false, error: `隧道名已占用: ${next.name}` }
      if (next.entry === ENTRY_SUBDOMAIN && entryHostConflict(args.entryHost, next.name)) {
        return { ok: false, error: entryConflictReason(next.name, args.entryHost) }
      }
      const previous = { name: currentName, targetPort: row.targetPort, entry: row.entry, enabled: row.enabled !== false }
      const routeChanged = previous.name !== next.name || previous.targetPort !== next.targetPort || previous.entry !== next.entry
      const wasActive = tunnels.has(currentName)
      if ((routeChanged || !next.enabled) && wasActive) deactivate(currentName)
      const rollback = () => {
        row.targetPort = previous.targetPort
        row.entry = previous.entry
        row.enabled = previous.enabled
        if (next.name !== previous.name) {
          rows.delete(next.name)
          row.name = previous.name
          rows.set(previous.name, row)
        }
      }
      row.name = next.name
      row.targetPort = next.targetPort
      row.entry = next.entry
      row.enabled = next.enabled
      if (next.name !== currentName) {
        rows.delete(currentName)
        rows.set(next.name, row)
      }
      if (next.enabled && (!wasActive || routeChanged)) {
        try {
          activate(row)
        } catch (error) {
          rollback()
          if (previous.enabled) {
            try { activate(row) } catch { row.error = String(error.message) }
          }
          persist()
          changes.refresh()
          return { ok: false, error: `路由注册失败: ${error.message}` }
        }
      }
      if (next.enabled) delete row.error
      invalidateHealth(currentName)
      if (next.name !== currentName) invalidateHealth(next.name)
      persist()
      changes.refresh()
      return { ok: true, ...rowView(row) }
    },
    async listPorts(args = {}) {
      const result = await scanListeningPorts({
        refresh: args.refresh === true,
        excludePorts: [Number(webServer.port)],
      })
      if (result.supported !== true) return result
      const items = result.items
        .filter((item) => (args.all === true ? item.system !== true : item.dev === true))
        .map((item) => ({
          ...item,
          tunnelNames: [...rows.values()].filter((row) => row.enabled !== false && row.targetPort === item.port).map((row) => row.name),
        }))
      return { ...result, items }
    },
    async probePort(port) {
      if (!validatePort(port)) return { ok: false, error: 'port 须为 1..65535 整数' }
      const health = await probeTcpPort(port)
      return { ok: true, listening: health.state === 'online', health }
    },
    close(args) {
      const row = rows.get(args.name)
      if (row === undefined) return { ok: true, removed: false }
      deactivate(args.name)
      rows.delete(args.name)
      invalidateHealth(args.name)
      persist()
      changes.refresh()
      return { ok: true, removed: true }
    },
    disposeAll() {
      for (const name of [...tunnels.keys()]) deactivate(name)
    },
  }

  // 分发载体先行: 之后安装的包装器全部经它分发, 插件重载时整体切到新代
  const matchHost = (req) => {
    const label = firstLabelOf(req.headers.host)
    if (label === undefined) return undefined
    const record = tunnels.get(label)
    if (record === undefined || record.entry !== ENTRY_SUBDOMAIN) return undefined
    return { record, url: req.url }
  }
  const matchPathUpgrade = (req) => {
    const url = new URL(req.url ?? '/', 'http://x')
    if (!url.pathname.startsWith(PATH_PREFIX)) return undefined
    const name = url.pathname.slice(PATH_PREFIX.length).split('/')[0]
    const record = tunnels.get(name)
    if (record === undefined || record.entry !== ENTRY_PATH) return undefined
    return { record, url: targetPathOf(req.url, PATH_PREFIX + name) }
  }
  // 代际令牌: 重载时新代先装载、旧代后回收, dispose 只清自己的载体
  const dispatch = (kind, req) => (kind === 'upgrade' ? (matchHost(req) ?? matchPathUpgrade(req)) : matchHost(req))
  dispatch.sockets = new Set()
  dispatch.hostSockets = hostSockets
  dispatch.pathSockets = pathSockets

  // 激活失败的行(路由注册冲突等)在占位释放后重试: 每次列表都按当前隧道表补一遍
  const retryInactiveRows = () => {
    for (const row of rows.values()) {
      if (row.enabled === false || tunnels.has(row.name)) continue
      delete row.error
      try {
        activate(row)
        changes.refresh()
      } catch (error) {
        row.error = String(error.message)
      }
    }
  }
  const timeoutOf = () => connectTimeoutMs
  webServer[DISPATCH_PROP] = dispatch
  webServer[TIMEOUT_PROP] = timeoutOf
  installListener(webServer, server)

  // 激活恢复: 先入行表再激活, 激活失败的行留在磁盘待下次重试(不得被后续 persist 抹掉)
  for (const raw of loadStore(dataDir)) {
    if (!validateName(raw?.name) || !validatePort(raw?.targetPort)) {
      console.warn(`${WARN_TAG}隧道表存在非法行, 已跳过: ${JSON.stringify(raw)}`)
      continue
    }
    if (rows.has(raw.name)) {
      console.warn(`${WARN_TAG}隧道表存在重复名 ${raw.name}, 仅保留首行`)
      continue
    }
    if (raw.entry !== undefined && !VALID_ENTRIES.has(raw.entry)) {
      console.warn(`${WARN_TAG}隧道 ${raw.name} 的 entry 非法, 已跳过: ${String(raw.entry)}`)
      continue
    }
    if (raw.targetPort === Number(webServer.port)) {
      console.warn(`${WARN_TAG}隧道 ${raw.name} 的 targetPort 为宿主监听端口 ${webServer.port}(自代理环), 已跳过`)
      continue
    }
    const row = {
      name: raw.name,
      targetPort: raw.targetPort,
      entry: raw.entry ?? ENTRY_PATH,
      enabled: raw.enabled !== false,
      createdAt: raw.createdAt ?? null,
    }
    rows.set(row.name, row)
    if (row.enabled === false) continue
    try {
      activate(row)
    } catch (error) {
      row.error = String(error.message)
      console.warn(`${WARN_TAG}隧道 ${row.name} 激活失败, 保留待下次激活重试: ${row.error}`)
    }
  }

  const tools = [
    defineTool({
      name: 'tunnel_open',
      description: '打开穿透隧道, 把本机 targetPort 反向代理到 dsh 入口。name 可省略, 自动生成 app-<port>。entry=subdomain(有多个域名映射到 dsh 时首选): 子域名首标签命中隧道名即全路径全协议透传, 应用按根路径正常启动, 任意 WebSocket 路径可用, 访问地址 <name>.<你的域名>; 本机浏览器可用 <name>.localhost:<port>。entry=path: /p/<name>/ 子路径 strip 转发, 应用需支持子路径部署(vite --base / jupyter base_url / gradio root_path / streamlit baseUrlPath), 由你以正确 base 参数启动目标应用; WebSocket 任意路径同样可用, 无需声明。返回 url(本机)与 lanUrl(同网段设备, 仅 path 入口)。',
      parameters: {
        name: { type: 'string', description: '可选隧道名: 小写字母/数字/连字符, ≤32 位, 至少含一个字母; 省略则自动命名' },
        targetPort: { type: 'number', required: true, description: '目标本地端口 1..65535' },
        entry: { type: 'string', description: "'path'(默认, /p/<name> 子路径)或 'subdomain'(<name>.* 全路径透传)" },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: true,
          properties: {
            ok: { type: 'boolean', required: true },
            name: { type: 'string' },
            entry: { type: 'string' },
            path: { type: 'string' },
            host: { type: 'string' },
            port: { type: 'number' },
            enabled: { type: 'boolean' },
            url: { type: 'string' },
            lanUrl: { type: 'string' },
            error: { type: 'string' },
          },
        },
        render: renderJson,
      },
      async execute(args) {
        return api.open(args ?? {})
      },
    }),
    defineTool({
      name: 'tunnel_list',
      description: '列出当前隧道(名称/入口形态/访问地址/目标端口/启用状态/运行期统计)。默认不探测目标; probe=true 时对每条活动隧道做一次 TCP 探活并返回 online/offline。',
      parameters: {
        probe: { type: 'boolean', description: '是否探测目标端口; 默认 false' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: true,
          properties: {
            ok: { type: 'boolean', required: true },
            tunnels: { type: 'array', items: { type: 'object', additionalProperties: true } },
          },
        },
        render: renderJson,
      },
      async execute(args) {
        return api.list(args ?? {})
      },
    }),
    defineTool({
      name: 'tunnel_ports',
      description: '列出本机正在监听、可能适合开放为隧道的端口(端口/绑定地址/进程/是否候选/已使用的隧道名)。默认只返回开发候选; all=true 返回全部非系统监听。',
      parameters: {
        all: { type: 'boolean', description: '是否包含非候选的普通监听; 默认 false' },
        refresh: { type: 'boolean', description: '绕过发现缓存重新扫描' },
        limit: { type: 'number', description: '最多返回条数 1..50, 默认 20' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: true,
          properties: {
            ok: { type: 'boolean' },
            supported: { type: 'boolean' },
            reason: { type: 'string' },
            scannedAt: { type: 'string' },
            items: { type: 'array', items: { type: 'object', additionalProperties: true } },
            truncated: { type: 'boolean' },
          },
        },
        render: renderJson,
      },
      async execute(args) {
        const limit = Number.isInteger(args?.limit) ? Math.min(50, Math.max(1, args.limit)) : 20
        const result = await api.listPorts(args ?? {})
        if (result.supported !== true) return { ...result, items: [], truncated: false }
        return { ...result, items: result.items.slice(0, limit), truncated: result.items.length > limit }
      },
    }),
    defineTool({
      name: 'tunnel_close',
      description: '关闭穿透隧道并删除持久化条目; 幂等, 不存在的名同样返回成功。',
      parameters: {
        name: { type: 'string', required: true, description: '要关闭的隧道名' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: true,
          properties: {
            ok: { type: 'boolean', required: true },
            removed: { type: 'boolean' },
          },
        },
        render: renderJson,
      },
      async execute(args) {
        return api.close(args ?? {})
      },
    }),
  ]

  applyPreferences()

  ctx.inject(['settings'], (sctx) => {
    const svc = sctx.settings
    if (typeof svc?.register !== 'function') return
    settingsRef.current = svc
    const scope = svc.register(SETTINGS_NS, SETTINGS_SCHEMA, { base: config })
    // 激活期即同步一次: 宿主 register 已合并持久化值, watch 仅在后续改动时触发
    applyPreferences()
    if (typeof scope?.watch === 'function') scope.watch(applyPreferences)
  })
  ctx.on('loader/volatile-update', applyPreferences)

  const UI_PREF_KEYS = ['aiTools']
  const uiBooleanError = (keys) => keys.join('/') + ' 须为布尔'
  const readUi = () => ({ aiTools: aiToolsNow() })
  const persistPatch = async (patch) => {
    const svc = settingsRef.current
    if (svc) {
      // 落盘失败必须回给调用方(400), 不得成为未捕获 rejection 终止进程
      await svc.update(SETTINGS_NS, patch)
      return true
    }
    const editor = ctx.get('configEditor')
    const entry = ctx.fiber?.entry
    if (!editor || typeof editor.edit !== 'function' || !entry) return false
    await editor.edit(entry, (current) => ({ ...current, ...patch }))
    return true
  }
  const updateUi = async (body) => {
    const patch = {}
    for (const key of UI_PREF_KEYS) {
      if (body?.[key] === undefined) continue
      if (typeof body[key] !== 'boolean') throw new Error(uiBooleanError([key]))
      patch[key] = body[key]
    }
    if (Object.keys(patch).length === 0) throw new Error(uiBooleanError(UI_PREF_KEYS))
    if (!(await persistPatch(patch))) return { ok: false, error: SETTINGS_UNAVAILABLE }
    applyPreferences()
    changes.refresh()
    return { ok: true, ui: readUi() }
  }

  const restApi = createApi({
    tunnelsApi: api,
    readUi,
    updateUi,
    lanOrigin: () => lanOriginOf(webServer),
    logSystem: (line) => console.warn(`${WARN_TAG}${line}`),
  })
  ctx.effect(() => {
    const disposeApiRoute = webServer.register({
      kind: 'prefix',
      path: API_PREFIX,
      // 管理面回问宿主闸门并叠写路由门;转发面(/p/*)服务别的应用,不能拦
      handler: withRouteGate(ctx, async (req, res) => {
        try {
          await restApi.handle(req, res)
        } catch (error) {
          res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' })
          res.end(JSON.stringify({ error: MESSAGES.systemError }))
          console.warn(`${WARN_TAG}${String(error && error.stack || error)}`)
        }
      }),
    })
    return disposeApiRoute
  }, 'dsh-tunnel api')

  return () => {
    if (disposeTools) {
      disposeTools()
      disposeTools = null
    }
    api.disposeAll()
    // 载体置空即纯穿透: 监听层常驻, 禁用后全体原路放行; 只清本代令牌, 不误伤新代
    if (webServer[DISPATCH_PROP] === dispatch) webServer[DISPATCH_PROP] = undefined
    if (webServer[TIMEOUT_PROP] === timeoutOf) webServer[TIMEOUT_PROP] = undefined
    // 只回收本代接入的 upgrade socket: 新代连接在它自己的集合里, 不得误杀
    for (const socket of dispatch.sockets) socket.destroy()
    dispatch.sockets.clear()
    hostSockets.clear()
    pathSockets.clear()
  }
}
