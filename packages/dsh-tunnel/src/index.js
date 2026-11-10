// dsh-tunnel Host 半区: 双入口反向代理。
//   path      /p/<name> 前缀路由(strip 后转发, 注册走 webServer 公开 API)
//   subdomain <name>.* 首标签命中即全路径全协议透传(Host 分流)
// 宿主没有 Host 维度的公开路由能力, 唯一在各代宿主上都成立且可逆的接入点是监听层:
// 摘下 webServer.server 的 request/upgrade 监听各插一层, 命中隧道即转发, 否则原样
// 委托原监听。由此不再改写任何其它插件的路由/handler, 也不再依赖 fallback 的形态
// (0.2.1 为函数, 0.2.2 为 { resource })。升级握手同层分发, 故任意 WS 路径可用。
// 规格: docs/设计-隧道改造.md; 安全边界: DEVELOPMENT/dsh-api-alignment.md。

import http from 'node:http'
import net from 'node:net'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'

import { setupCommonTools, createChangeNotifier } from '@mzzsfy/dsh-common-tools/host'
import { createApi, MESSAGES, ROUTE_PREFIX as API_PREFIX } from './api.mjs'

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
const WARN_TAG = 'dsh-tunnel: '

const ENTRY_PATH = 'path'
const ENTRY_SUBDOMAIN = 'subdomain'
const VALID_ENTRIES = new Set([ENTRY_PATH, ENTRY_SUBDOMAIN])
const SETTINGS_NS = 'tunnel'
const SETTINGS_UNAVAILABLE = '设置服务不可用'

// 监听层安装标记: 只装一次, 代际切换靠载体重定向, 旧包装退化为纯穿透
const LISTENER_PROP = 'dshTunnelListener'
// 分发载体: 包装器调用期动态读取, 插件重载后旧包装器自动路由到新代
const DISPATCH_PROP = 'dshTunnelDispatch'
// 超时载体: 同代际切换, 配置变更后旧包装器读到新值
const TIMEOUT_PROP = 'dshTunnelTimeout'
const OWN_SOCKETS_PROP = 'dshTunnelSockets'
const TIMED_OUT_MARK = Symbol.for('dsh-tunnel.timedOut')

const renderJson = (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }]

// 逐跳头不透传: 连接管理由两端的 node http 栈各自负责
const HOP_BY_HOP = new Set(['connection', 'keep-alive', 'transfer-encoding', 'upgrade', 'te', 'trailer', 'proxy-authorization', 'proxy-authenticate'])
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
  .description('允许 ai 调用隧道工具(tunnel_open/list/close), 关闭即向 ai 注销; 看板与 REST 管理不受影响')
const sidebarTabField = () => z.boolean().default(false)
  .description('看板移入 better-sidebar 侧边栏(需已安装; 关闭时始终使用主界面)')

// 字段级 volatile 标记: 0.1.7+ 该字段进自动配置节并支持 loader 原地热更;
// 旧宿主 schemastery 无 volatile 方法, 特性检测原样返回(dsh-maintain 同构)
const volatileField = (schema) => (typeof schema.volatile === 'function' ? schema.volatile() : schema)

export const Config = z.object({
  connectTimeoutMs: volatileField(timeoutField()),
  dataDir: z.string().default(join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'dsh-tunnel'))
    .description('隧道表持久化目录'),
  aiTools: volatileField(aiToolsField()),
  sidebarTab: volatileField(sidebarTabField()),
})

export const SETTINGS_SCHEMA = z.object({
  connectTimeoutMs: timeoutField(),
  aiTools: aiToolsField(),
  sidebarTab: sidebarTabField(),
})

function validateName(value) {
  return typeof value === 'string' && TUNNEL_NAME_RE.test(value) && NAME_HAS_LETTER_RE.test(value)
}

function validatePort(port) {
  return Number.isInteger(port) && port >= PORT_MIN && port <= PORT_MAX
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

// strip 隧道前缀: 前缀本身映射 '/', 其余保留前导 '/' 携带查询串
function targetPathOf(reqUrl, prefix) {
  const url = new URL(reqUrl, 'http://x')
  const rest = url.pathname === prefix ? '/' : url.pathname.slice(prefix.length)
  return rest + url.search
}

function forwardedHeaders(req, proto, { keepHopByHop = false } = {}) {
  const headers = {}
  const connectionTokens = connectionTokensOf(req.headers.connection)
  for (const [key, value] of Object.entries(req.headers)) {
    if (key.startsWith('x-forwarded-') || FORWARDED_LIE_HEADERS.includes(key)) continue
    if (!keepHopByHop && (HOP_BY_HOP.has(key) || connectionTokens.has(key))) continue
    headers[key] = value
  }
  // 无 Host 头的请求(HTTP/1.0 等)缺源值时跳过, undefined 头会使 http.request 抛错
  if (req.headers.host !== undefined) headers['x-forwarded-host'] = req.headers.host
  if (req.socket?.remoteAddress !== undefined) headers['x-forwarded-for'] = req.socket.remoteAddress
  headers['x-forwarded-proto'] = proto
  return headers
}

// 唯一响应体改写: 同源根绝对路径补前缀(排除协议相对 //), 其余原样
function rewriteLocation(proxyRes, prefix) {
  const location = proxyRes.headers.location
  if (
    proxyRes.statusCode >= REDIRECT_MIN && proxyRes.statusCode <= REDIRECT_MAX
    && typeof location === 'string' && location.startsWith('/')
    && !location.startsWith('//') && !location.startsWith(prefix)
  ) {
    proxyRes.headers.location = prefix + location
  }
}

function respondJson(res, status, payload) {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(payload))
}

function forwardHttp(req, res, { record, url, timeoutMs, proto }) {
  const proxyReq = http.request({
    host: '127.0.0.1',
    port: record.targetPort,
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
    respondJson(res, status, { ok: false, error: `目标不可达: ${error.message}` })
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

// 升级透传: 重建请求头直写目标 socket(握手头 connection/upgrade/sec-websocket-* 必须
// 原样保留), 之后双向管道; 任一侧关闭即双向回收(否则正常关闭会留下目标侧悬挂连接)
function forwardUpgrade(req, socket, head, { url, timeoutMs, proto, targetPort }) {
  const headerLines = Object.entries(forwardedHeaders(req, proto, { keepHopByHop: true }))
    .map(([key, value]) => `${key}: ${value}`)
    .join('\r\n')
  const headText = `${req.method} ${url} HTTP/1.1\r\n${headerLines}\r\n\r\n`
  const upstream = net.connect({ host: '127.0.0.1', port: targetPort })
  const destroyAll = () => {
    upstream.destroy()
    socket.destroy()
  }
  let established = false
  upstream.setTimeout(timeoutMs, destroyAll)
  // 目标首字节(101 握手)到达即解除空闲计时, 建立后的长连接不受连接超时误杀
  upstream.once('data', () => { established = true; upstream.setTimeout(0) })
  upstream.on('error', () => {
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

// 写盘失败告警: 隧道本次会话可用, 重启后消失, open 仍返回成功
function saveStore(dataDir, rows) {
  try {
    mkdirSync(dataDir, { recursive: true })
    const path = storePath(dataDir)
    writeFileSync(path + STORE_TMP_SUFFIX, JSON.stringify(rows, null, 2))
    renameSync(path + STORE_TMP_SUFFIX, path)
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
      trackUpgradedSocket(webServer, server, socket)
      forwardUpgrade(req, socket, head, { ...match, timeoutMs: readTimeout(webServer), proto: protocolOf(webServer), targetPort: match.record.targetPort })
      return
    }
    for (const listener of originals.upgrade) listener.call(server, req, socket, head)
  })
  server[LISTENER_PROP] = originals
}

// 宿主按 upgradedSockets 收尾关闭流程; 拦截来的连接不登记会让 server.close() 挂死
function trackUpgradedSocket(webServer, server, socket) {
  if (!(server[OWN_SOCKETS_PROP] instanceof Set)) server[OWN_SOCKETS_PROP] = new Set()
  const own = server[OWN_SOCKETS_PROP]
  own.add(socket)
  socket.once('close', () => own.delete(socket))
  // 宿主按自己的 upgradedSockets 收尾, 两边都登记: 宿主关闭与插件停用各有一条回收链
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
    if (row.entry === ENTRY_PATH) row.disposeRoutes = registerRoutes(row)
    tunnels.set(row.name, row)
  }

  function deactivate(name) {
    const row = tunnels.get(name)
    if (row === undefined) return
    row.disposeRoutes?.()
    delete row.disposeRoutes
    tunnels.delete(name)
  }

  const persist = () => saveStore(dataDir, [...rows.values()].map(({ createdAt, entry, name, targetPort }) => ({ createdAt, entry, name, targetPort })))

  const api = {
    open(args) {
      if (!validateName(args.name) || !validatePort(args.targetPort)) {
        return { ok: false, error: '参数不合法: name 须为小写字母/数字/连字符(≤32 位, 且至少含一个字母), targetPort 须为 1..65535 整数' }
      }
      const entry = args.entry ?? ENTRY_PATH
      if (!VALID_ENTRIES.has(entry)) {
        return { ok: false, error: `entry 不合法: 须为 ${ENTRY_PATH} 或 ${ENTRY_SUBDOMAIN}` }
      }
      const hostPort = Number(webServer.port)
      if (args.targetPort === hostPort) {
        return { ok: false, error: `targetPort 不得为宿主监听端口 ${hostPort}(自代理环)` }
      }
      if (rows.has(args.name)) return { ok: false, error: `隧道名已占用: ${args.name}` }
      const row = { name: args.name, targetPort: args.targetPort, entry, createdAt: new Date().toISOString() }
      try {
        activate(row)
      } catch (error) {
        return { ok: false, error: `路由注册失败: ${error.message}` }
      }
      rows.set(row.name, row)
      persist()
      changes.refresh()
      return entry === ENTRY_SUBDOMAIN
        ? { ok: true, name: row.name, entry, host: `${row.name}.localhost`, port: webServer.port }
        : { ok: true, name: row.name, entry, path: PATH_PREFIX + row.name, port: webServer.port }
    },
    list() {
      return {
        ok: true,
        tunnels: [...rows.values()].map(({ createdAt, entry, error, name, targetPort }) => ({
          name,
          entry,
          access: entry === ENTRY_SUBDOMAIN ? `${name}.*` : PATH_PREFIX + name,
          targetPort,
          active: tunnels.has(name),
          createdAt,
          ...(error === undefined ? {} : { error }),
        })),
      }
    },
    close(args) {
      const row = rows.get(args.name)
      if (row === undefined) return { ok: true, removed: false }
      deactivate(args.name)
      rows.delete(args.name)
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
    const row = { name: raw.name, targetPort: raw.targetPort, entry: raw.entry ?? ENTRY_PATH, createdAt: raw.createdAt }
    rows.set(row.name, row)
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
      description: '打开穿透隧道, 把本机 targetPort 反向代理到 dsh 入口。entry=subdomain(有多个域名映射到 dsh 时首选): 子域名首标签命中隧道名即全路径全协议透传, 应用按根路径正常启动, 任意 WebSocket 路径可用, 访问地址 <name>.<你的域名>; 本机浏览器可用 <name>.localhost:<port>。entry=path: /p/<name>/ 子路径 strip 转发, 应用需支持子路径部署(vite --base / jupyter base_url / gradio root_path / streamlit baseUrlPath), 由你以正确 base 参数启动目标应用; WebSocket 任意路径同样可用, 无需声明。隧道名须至少含一个字母(纯数字名会与纯 IP 访问的首段撞上), 并避开 dsh 入口域名的首标签。',
      parameters: {
        name: { type: 'string', required: true, description: '隧道名: 小写字母/数字/连字符, ≤32 位, 至少含一个字母' },
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
      description: '列出当前隧道(名称/入口形态/访问地址/目标端口/是否激活)。',
      parameters: {},
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
      async execute() {
        return api.list()
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

  const UI_PREF_KEYS = ['aiTools', 'sidebarTab']
  const uiBooleanError = (keys) => keys.join('/') + ' 须为布尔'
  const readUi = () => ({ aiTools: aiToolsNow(), sidebarTab: readPref('sidebarTab') === true })
  const persistPatch = async (patch) => {
    const svc = settingsRef.current
    if (svc) {
      svc.update(SETTINGS_NS, patch)
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
    logSystem: (line) => console.warn(`${WARN_TAG}${line}`),
  })
  ctx.effect(() => {
    const disposeApiRoute = webServer.register({
      kind: 'prefix',
      path: API_PREFIX,
      handler: async (req, res) => {
        try {
          await restApi.handle(req, res)
        } catch (error) {
          res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' })
          res.end(JSON.stringify({ error: MESSAGES.systemError }))
          console.warn(`${WARN_TAG}${String(error && error.stack || error)}`)
        }
      },
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
    const own = server[OWN_SOCKETS_PROP]
    if (own instanceof Set) {
      for (const socket of own) socket.destroy()
      own.clear()
    }
  }
}
