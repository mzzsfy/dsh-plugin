// dsh-tunnel Host 半区: /p/<name> 前缀路由 strip 转发与 <name>.* 子域名全路径
// 透传(任意 WS 路径)双入口, tunnels.json 持久化与激活恢复; ai 工具三件
// (tunnel_open/list/close)经 tools 服务注册。子域名分流用 wrap+shadow, 与
// dsh-auto-trust-all 同构; 规格: docs/调研-路径穿透插件.md「方案设计」两节;
// 干净禁用由 inject ['webServer'] 门控, 无任何自有认证层(仓库安全边界约定)。

import http from 'node:http'
import net from 'node:net'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'

import { createApi, MESSAGES, ROUTE_PREFIX as API_PREFIX } from './api.mjs'

export const name = 'dsh-tunnel'

export const inject = ['webServer']

const PATH_PREFIX = '/p/'
const TUNNEL_NAME_RE = /^[a-z0-9][a-z0-9-]{0,31}$/
const WS_PATH_CHARS_RE = /^\/[A-Za-z0-9/._~-]*$/
const PORT_MIN = 1
const PORT_MAX = 65535
const DEFAULT_CONNECT_TIMEOUT = 10 * 1000
const FORWARDED_PROTO = 'http'
const REDIRECT_MIN = 300
const REDIRECT_MAX = 399
const STORE_FILE = 'tunnels.json'
const STORE_TMP_SUFFIX = '.tmp'
const WARN_TAG = 'dsh-tunnel: '

const ENTRY_PATH = 'path'
const ENTRY_SUBDOMAIN = 'subdomain'
const VALID_ENTRIES = new Set([ENTRY_PATH, ENTRY_SUBDOMAIN])
// 设置命名空间与 UI 偏好: 设置页独立配置节 + 侧边栏注入开关(设计: docs/设计-隧道GUI.md)
const SETTINGS_NS = 'tunnel'
const SETTINGS_UNAVAILABLE = '设置服务不可用'
const UI_FIELD_REQUIRED = 'sidebarTab 须为布尔'
// 分流面标记: 防包装叠加/防重复 shadow/防 upgrades 表二次拦截
const WRAPPED_PROP = 'dshTunnelWrapped'
const SHADOWED_PROP = 'dshTunnelShadowed'
const UPGRADE_TABLE_PROP = 'dshTunnelUpgradeTable'
// 分发载体: 包装器调用期动态读取, 插件重载后旧包装器自动路由到新代
const DISPATCH_PROP = 'dshTunnelDispatch'
// 超时载体: 同代际切换, config 变更后旧包装器读到新值
const DISPATCH_TIMEOUT_PROP = 'dshTunnelConnectTimeoutMs'
const TIMED_OUT_MARK = Symbol.for('dsh-tunnel.timedOut')

const renderJson = (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }]

// 逐跳头不透传: 连接管理由两端的 node http 栈各自负责
const HOP_BY_HOP = new Set(['connection', 'keep-alive', 'transfer-encoding', 'upgrade'])
// 信任链头剥离: 入站伪造的代理链声明一律替换为本插件视角的真实值
const FORWARDED_LIE_HEADERS = ['forwarded', 'via', 'x-real-ip']

// 超时字段 Config 与 SETTINGS_SCHEMA 同名同约束双写, 单一工厂防漂移
const TIMEOUT_MIN_MS = 1
const TIMEOUT_MAX_MS = 60 * 1000
const timeoutField = () => z.number().step(1).min(TIMEOUT_MIN_MS).max(TIMEOUT_MAX_MS).default(DEFAULT_CONNECT_TIMEOUT)
  .description('等待目标响应头的超时, 头到即解除(SSE 等长流不受影响)')

export const Config = z.object({
  connectTimeoutMs: timeoutField(),
  dataDir: z.string().default(join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'dsh-tunnel'))
    .description('隧道表持久化目录'),
})

// 设置页独立配置节: sidebarTab 仅 UI 偏好, dataDir 属环境路径不进 UI
export const SETTINGS_SCHEMA = z.object({
  connectTimeoutMs: timeoutField(),
  sidebarTab: z.boolean().default(false)
    .description('看板移入 better-sidebar 侧边栏(需已安装; 关闭时始终使用主界面)'),
})

const normalizeWsPath = (value) => value.replace(/\/+$/, '')

// 校验作用于归一前的原始值; '/' 为合法输入
function normalizeWsPaths(raw) {
  if (raw === undefined) return []
  if (!Array.isArray(raw) || raw.some((item) => typeof item !== 'string' || !WS_PATH_CHARS_RE.test(item))) return undefined
  return [...new Set(raw.map(normalizeWsPath))]
}

function validateName(name) {
  return typeof name === 'string' && TUNNEL_NAME_RE.test(name)
}

function validatePort(port) {
  return Number.isInteger(port) && port >= PORT_MIN && port <= PORT_MAX
}

// strip 隧道前缀: 前缀本身映射 '/', 其余保留前导 '/' 携带查询串
function targetPathOf(reqUrl, prefix) {
  const url = new URL(reqUrl, 'http://x')
  const rest = url.pathname === prefix ? '/' : url.pathname.slice(prefix.length)
  return rest + url.search
}

// 上游路径: 子域名全路径透传, 路径模式 strip 隧道前缀
function upstreamPathOf(req, record) {
  if (record.entry === ENTRY_SUBDOMAIN) return req.url
  return targetPathOf(req.url, PATH_PREFIX + record.name)
}

// 子域名匹配: hostname 首标签 === 隧道名且含点(多级名由名称正则单标签保证不误吸)
// host 解析单槽 memo: 分发在宿主全量请求热路径上, 同 Host 连发时免重复 URL 解析
let hostMemoRaw
let hostMemoValue

function hostOf(req) {
  const raw = req.headers.host
  if (typeof raw !== 'string') return ''
  if (raw === hostMemoRaw) return hostMemoValue
  hostMemoRaw = raw
  try {
    hostMemoValue = new URL('http://' + raw).hostname.toLowerCase()
  } catch {
    hostMemoValue = ''
  }
  return hostMemoValue
}

function matchSubdomain(req, subdomains) {
  const hostname = hostOf(req)
  if (!hostname.includes('.')) return undefined
  for (const record of subdomains.values()) {
    if (hostname.startsWith(record.name + '.')) return record
  }
  return undefined
}

function forwardedHeaders(req, { keepHopByHop = false } = {}) {
  const headers = {}
  for (const [key, value] of Object.entries(req.headers)) {
    if (key.startsWith('x-forwarded-') || FORWARDED_LIE_HEADERS.includes(key)) continue
    if (!keepHopByHop && HOP_BY_HOP.has(key)) continue
    headers[key] = value
  }
  // 无 Host 头的请求(HTTP/1.0 等)缺源值时跳过, undefined 头会使 http.request 抛错
  if (req.headers.host !== undefined) headers['x-forwarded-host'] = req.headers.host
  if (req.socket?.remoteAddress !== undefined) headers['x-forwarded-for'] = req.socket.remoteAddress
  headers['x-forwarded-proto'] = FORWARDED_PROTO
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

function forwardHttp(req, res, record, connectTimeoutMs) {
  const proxyReq = http.request({
    host: '127.0.0.1',
    port: record.targetPort,
    method: req.method,
    path: upstreamPathOf(req, record),
    headers: forwardedHeaders(req),
  })
  proxyReq.on('socket', (socket) => {
    socket.setTimeout(connectTimeoutMs)
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
    for (const [key, value] of Object.entries(proxyRes.headers)) {
      if (!HOP_BY_HOP.has(key)) headers[key] = value
    }
    res.writeHead(proxyRes.statusCode, headers)
    proxyRes.pipe(res)
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

// 升级透传: 重建请求头直写目标 socket(握手头 connection/upgrade/sec-websocket-* 必须原样保留), 之后双向管道
function forwardUpgrade(req, socket, head, record, connectTimeoutMs) {
  const headerLines = Object.entries(forwardedHeaders(req, { keepHopByHop: true }))
    .map(([key, value]) => `${key}: ${value}`)
    .join('\r\n')
  const headText = `${req.method} ${upstreamPathOf(req, record)} HTTP/1.1\r\n${headerLines}\r\n\r\n`
  const upstream = net.connect({ host: '127.0.0.1', port: record.targetPort })
  const destroyAll = () => {
    upstream.destroy()
    socket.destroy()
  }
  upstream.setTimeout(connectTimeoutMs, () => destroyAll())
  // 目标首字节(101 握手)到达即解除空闲计时, 建立后的长连接不受连接超时误杀
  upstream.once('data', () => upstream.setTimeout(0))
  upstream.on('error', destroyAll)
  socket.on('error', destroyAll)
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

export function apply(ctx, config) {
  const webServer = ctx.webServer

  // 形状守卫: 宿主形态漂移时干净禁用并告警, 绝不破坏宿主
  const shapeOk = webServer.exact instanceof Map
    && webServer.prefixes instanceof Map
    && webServer.upgrades instanceof Map
    && typeof webServer.register === 'function'
    && typeof webServer.registerUpgrade === 'function'
    && typeof webServer.registerFallback === 'function'
    && 'fallback' in webServer
  if (!shapeOk) {
    console.warn(`${WARN_TAG}webServer 形状不匹配, 插件停用`)
    return () => {}
  }

  // 可变绑定: 设置页改动经 settings watch 回写, 载体与各 handler 按请求期读到新值
  let connectTimeoutMs = config.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT
  const dataDir = config.dataDir

  // 活动隧道: name → 记录 + 本次激活注册的路由回收器(路径模式才有路由可回收)
  const tunnels = new Map()
  // 子域名活跃表: 分发器活读, open/close 只需增删此表
  const subdomains = new Map()

  // 单隧道事务: 任一注册失败回滚本次已注册的全部路由
  function registerRoutes(record) {
    const prefix = PATH_PREFIX + record.name
    const undo = []
    const run = (fn) => {
      try {
        undo.push(fn())
      } catch (error) {
        for (const dispose of undo.reverse()) dispose()
        throw error
      }
    }
    run(() => webServer.register({
      kind: 'prefix',
      path: prefix,
      handler: (req, res) => forwardHttp(req, res, record, connectTimeoutMs),
    }))
    for (const value of record.wsPaths) {
      for (const suffix of [value, value + '/']) {
        run(() => webServer.registerUpgrade({
          path: prefix + suffix,
          handler: (req, socket, head) => forwardUpgrade(req, socket, head, record, connectTimeoutMs),
        }))
      }
    }
    return () => {
      for (const dispose of undo.reverse()) dispose()
    }
  }

  const persist = () => saveStore(dataDir, [...tunnels.values()].map(({ createdAt, entry, name, targetPort, wsPaths }) => ({ createdAt, entry, name, targetPort, wsPaths })))

  const api = {
    open(args) {
      if (!validateName(args.name) || !validatePort(args.targetPort)) {
        return { ok: false, error: '参数不合法: name 须为小写字母/数字/连字符(≤32 位), targetPort 须为 1..65535 整数' }
      }
      const entry = args.entry ?? ENTRY_PATH
      if (!VALID_ENTRIES.has(entry)) {
        return { ok: false, error: `entry 不合法: 须为 ${ENTRY_PATH} 或 ${ENTRY_SUBDOMAIN}` }
      }
      // 子域名全路径全协议透传, wsPaths 无意义
      const wsPaths = entry === ENTRY_SUBDOMAIN ? [] : normalizeWsPaths(args.wsPaths)
      if (wsPaths === undefined) {
        return { ok: false, error: 'wsPaths 不合法: 每项须为白名单字符 [A-Za-z0-9/._~-] 的 / 开头非空路径' }
      }
      if (tunnels.has(args.name)) {
        return { ok: false, error: `隧道名已占用: ${args.name}` }
      }
      const record = { name: args.name, targetPort: args.targetPort, entry, wsPaths, createdAt: new Date().toISOString() }
      if (entry === ENTRY_SUBDOMAIN) {
        subdomains.set(record.name, record)
        tunnels.set(record.name, record)
        persist()
        return { ok: true, name: record.name, entry, host: `${record.name}.localhost`, port: webServer.port }
      }
      let disposeRoutes
      try {
        disposeRoutes = registerRoutes(record)
      } catch (error) {
        return { ok: false, error: `路由注册失败: ${error.message}` }
      }
      tunnels.set(record.name, { ...record, disposeRoutes })
      persist()
      return { ok: true, name: record.name, entry, path: PATH_PREFIX + record.name, port: webServer.port }
    },
    list() {
      return {
        ok: true,
        tunnels: [...tunnels.values()].map(({ createdAt, entry, name, targetPort, wsPaths }) => ({
          name,
          entry,
          access: entry === ENTRY_SUBDOMAIN ? `${name}.*` : PATH_PREFIX + name,
          targetPort,
          wsPaths,
          createdAt,
        })),
      }
    },
    close(args) {
      const record = tunnels.get(args.name)
      if (record === undefined) return { ok: true, removed: false }
      record.disposeRoutes?.()
      subdomains.delete(args.name)
      tunnels.delete(args.name)
      persist()
      return { ok: true, removed: true }
    },
    disposeAll() {
      for (const record of tunnels.values()) record.disposeRoutes?.()
      subdomains.clear()
      tunnels.clear()
    },
  }

  // 分流载体先行: 之后安装的包装器全部经它分发, 插件重载时整体切到新代
  webServer[DISPATCH_PROP] = (req) => matchSubdomain(req, subdomains)
  webServer[DISPATCH_TIMEOUT_PROP] = () => connectTimeoutMs

  // 包装现存与未来路由: 隧道 Host 命中即转发, 否则原 handler;
  // 超时经载体动态读, 旧代包装器在 config 变更后同样取新值
  const timeoutNow = () => webServer[DISPATCH_TIMEOUT_PROP]?.() ?? connectTimeoutMs
  const wrapHttp = (handler) => {
    if (typeof handler !== 'function' || handler[WRAPPED_PROP]) return handler
    const wrapped = (req, res) => {
      const record = webServer[DISPATCH_PROP]?.(req)
      if (record) return forwardHttp(req, res, record, timeoutNow())
      return handler(req, res)
    }
    wrapped[WRAPPED_PROP] = true
    return wrapped
  }
  const wrapUpgrade = (handler) => {
    if (typeof handler !== 'function' || handler[WRAPPED_PROP]) return handler
    const wrapped = (req, socket, head) => {
      const record = webServer[DISPATCH_PROP]?.(req)
      if (record) return forwardUpgrade(req, socket, head, record, timeoutNow())
      return handler(req, socket, head)
    }
    wrapped[WRAPPED_PROP] = true
    return wrapped
  }
  for (const route of webServer.exact.values()) route.handler = wrapHttp(route.handler)
  for (const route of webServer.prefixes.values()) route.handler = wrapHttp(route.handler)
  for (const route of webServer.upgrades.values()) route.handler = wrapUpgrade(route.handler)
  if (typeof webServer.fallback === 'function') webServer.fallback = wrapHttp(webServer.fallback)
  const shadow = (method, wrapRoute) => {
    const previous = webServer[method]
    if (typeof previous !== 'function') {
      console.warn(`${WARN_TAG}webServer.${method} 缺失, 该入口不做未来路由包装`)
      return
    }
    if (previous[SHADOWED_PROP]) return
    const shadowed = (arg) => previous.call(webServer, wrapRoute(arg))
    shadowed[SHADOWED_PROP] = true
    webServer[method] = shadowed
  }
  shadow('register', (route) => {
    route.handler = wrapHttp(route.handler)
    return route
  })
  shadow('registerUpgrade', (route) => {
    route.handler = wrapUpgrade(route.handler)
    return route
  })
  shadow('registerFallback', (handler) => wrapHttp(handler))

  // upgrades 表拦截: 官方分发仅 exact 且 miss 即销毁 socket, 动态 WS 路径
  // (如 jupyter 内核通道)只能在 miss 层合成隧道分发路由; 命中路由仍走原表
  if (!webServer.upgrades[UPGRADE_TABLE_PROP]) {
    const table = new Map(webServer.upgrades)
    const originalGet = table.get.bind(table)
    table[UPGRADE_TABLE_PROP] = true
    table.get = (pathname) => {
      const route = originalGet(pathname)
      if (route !== undefined) return route
      return {
        handler: (req, socket, head) => {
          const record = webServer[DISPATCH_PROP]?.(req)
          if (record) return forwardUpgrade(req, socket, head, record, timeoutNow())
          socket.destroy()
        },
      }
    }
    webServer.upgrades = table
  }

  // 激活恢复: 路径模式沿用单隧道事务(冲突回滚并告警, 绝不阻塞激活),
  // 子域名模式仅入表(无路由注册故无失败面); 旧记录缺 entry 视为路径模式
  for (const row of loadStore(dataDir)) {
    if (!validateName(row?.name) || !validatePort(row?.targetPort)) {
      console.warn(`${WARN_TAG}隧道表存在非法行, 已跳过: ${JSON.stringify(row)}`)
      continue
    }
    if (tunnels.has(row.name)) {
      console.warn(`${WARN_TAG}隧道表存在重复名 ${row.name}, 仅恢复首行`)
      continue
    }
    if (row.entry !== undefined && row.entry !== ENTRY_PATH && row.entry !== ENTRY_SUBDOMAIN) {
      console.warn(`${WARN_TAG}隧道 ${row.name} 的 entry 非法, 已跳过: ${String(row.entry)}`)
      continue
    }
    if (row.entry === ENTRY_SUBDOMAIN) {
      const record = { name: row.name, targetPort: row.targetPort, entry: ENTRY_SUBDOMAIN, wsPaths: [], createdAt: row.createdAt }
      subdomains.set(record.name, record)
      tunnels.set(record.name, record)
      continue
    }
    const wsPaths = normalizeWsPaths(row.wsPaths)
    if (wsPaths === undefined) console.warn(`${WARN_TAG}隧道 ${row.name} 的 wsPaths 非法, 本次按无 WS 恢复`)
    const record = { ...row, entry: ENTRY_PATH, wsPaths: wsPaths ?? [] }
    try {
      const disposeRoutes = registerRoutes(record)
      tunnels.set(record.name, { ...record, disposeRoutes })
    } catch (error) {
      console.warn(`${WARN_TAG}隧道 ${record.name} 激活失败, 已回滚待下次激活重试: ${error.message}`)
    }
  }

  const tools = [
    defineTool({
      name: 'tunnel_open',
      // 描述尾部附冲突提示: 隧道名撞入口域名首标签(含纯 IP Host 首段)会劫持入口
      description: '打开穿透隧道。entry=path(默认): 把 http://<host>:<port>/p/<name>/ 反向代理到本机 targetPort, 应用需支持子路径部署(vite --base / jupyter base_url / gradio root_path / streamlit baseUrlPath), 由你以正确 base 参数启动目标应用; WebSocket 应用传 wsPaths 相对路径(如 ["/"])。entry=subdomain: 子域名 <name>. 开头且解析到本机的任意域名全路径透传(本机浏览器用 <name>.localhost:<port>, 泛解析域名可用于局域网/公网), 应用按根路径正常启动, WebSocket 任意路径可用, 无需 base 参数与 wsPaths; 需 dsh-auto-trust-all 放行子域名 Host。隧道名避开 dsh 入口域名的首标签(纯 IP 访问时避开 IP 首段数字, 如隧道名 127/192 会劫持对应 IP 访问)。',
      parameters: {
        name: { type: 'string', required: true, description: '隧道名: 小写字母/数字/连字符, ≤32 位' },
        targetPort: { type: 'number', required: true, description: '目标本地端口 1..65535' },
        entry: { type: 'string', description: "入口形态: 'path'(默认, /p/<name> 子路径)或 'subdomain'(<name>. 子域名全路径透传)" },
        wsPaths: { type: 'array', items: { type: 'string' }, description: "仅 entry=path: 相对隧道根的 WebSocket 路径, 如 [\"/\"]; 缺省 = 纯 HTTP" },
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
      description: '列出当前活动的穿透隧道(名称/入口形态/访问地址/目标端口/WS 路径)。',
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
  ctx.inject(['tools'], (tctx) => {
    for (const tool of tools) tctx.effect(() => tctx.tools.register(tool), 'dsh-tunnel: ' + tool.name)
  })

  // 设置: schema 注册(设置页独立配置节) + 超时 watch 回写(读值经 settings.get,
  // scope 仅作触发钩); 服务缺失时绑定保持 config 初值, 行为与无设置版一致
  const settingsRef = { current: null }
  const applyTimeoutFromSettings = () => {
    const next = Number(settingsRef.current?.get(SETTINGS_NS)?.connectTimeoutMs)
    if (Number.isInteger(next) && next >= TIMEOUT_MIN_MS && next <= TIMEOUT_MAX_MS) connectTimeoutMs = next
  }
  ctx.inject(['settings'], (sctx) => {
    const svc = sctx.settings
    if (typeof svc?.register !== 'function') return
    settingsRef.current = svc
    const scope = svc.register(SETTINGS_NS, SETTINGS_SCHEMA, { base: config })
    // 激活期即同步一次: 宿主 register 已合并持久化值, watch 仅在后续改动时触发;
    // 缺这一行, 重启后绑定回退 Config 初值而设置页仍显示持久化值
    applyTimeoutFromSettings()
    if (typeof scope?.watch === 'function') scope.watch(applyTimeoutFromSettings)
  })

  // GUI 偏好读写: 缺失降级读默认 false / 写返回 ok:false, 面板与形态仲裁照常工作
  const readUi = () => ({ sidebarTab: Boolean(settingsRef.current?.get(SETTINGS_NS)?.sidebarTab) })
  const updateUi = (body) => {
    const svc = settingsRef.current
    if (!svc) return { ok: false, error: SETTINGS_UNAVAILABLE }
    if (typeof body?.sidebarTab !== 'boolean') throw new Error(UI_FIELD_REQUIRED)
    svc.update(SETTINGS_NS, { sidebarTab: body.sidebarTab })
    return { ok: true, ui: { sidebarTab: body.sidebarTab } }
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
    api.disposeAll()
    // 载体置空穿透: 包装器常驻(与 auto-trust-all 同款生命周期), 禁用后全体原路放行
    webServer[DISPATCH_PROP] = () => undefined
    webServer[DISPATCH_TIMEOUT_PROP] = () => connectTimeoutMs
  }
}
