// dsh-bug-perf Host 半区:把行配置归一化后经配置路由交给浏览器半区,接收设置页保存,
// 并接收浏览器定期上报的性能采样(只落本地临时文件,用于定位“越用越卡”)。
// 会话列表瘦身在宿主执行(包装 sessionController.list),其余补丁在客户端执行;
// 这里不做认证,缺 webServer 或路由注册失败都不影响宿主。
import { appendFileSync, existsSync, renameSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import z from '@deepseek-ai/schemastery'
import { DEFAULT_CONFIG, migrateConfig, normalizeConfig } from './config.mjs'
import { installListSlim } from './list-slim.mjs'
import { installSessionWindow } from './session-window.mjs'

export const name = 'dsh-bug-perf'
// web profile 必有 webServer; 声明依赖让 apply 在服务就绪后执行,缺服务宿主即不激活本行
export const inject = ['webServer']

const CONFIG_PATH = '/api/dsh-bug-perf/config'
const DIAG_PATH = '/api/dsh-bug-perf/diag'
const NAMESPACE = 'bug-perf'
const BODY_MAX_BYTES = 64 * 1024
const DIAG_FILE = join(tmpdir(), 'dsh-bug-perf-diag.jsonl')
const DIAG_MAX_BYTES = 2 * 1024 * 1024

const SETTINGS_SCHEMA = z.object({
  // 无默认值:缺省即"旧版落盘",由读取时迁移并补写当前版本;给默认值会把旧配置误判为已迁移
  configVersion: z.number().description('配置版本:升级时按它把旧版落盘里仍等于旧默认值的字段复写为当前默认值;缺省视为旧版,保存后由插件写入当前版本'),
  restartCoalesce: z.object({
    enabled: z.boolean().default(DEFAULT_CONFIG.restartCoalesce.enabled).description('合并 session/follow 重建:同一 Remote stream 在窗口内的多次重启只保留一次尾随执行'),
    windowMs: z.number().default(DEFAULT_CONFIG.restartCoalesce.windowMs).description('合并窗口(毫秒);0 表示关闭合并,每次重启都立即执行'),
  }).description('会话流重建合并'),
  terminalWatchdog: z.object({
    enabled: z.boolean().default(DEFAULT_CONFIG.terminalWatchdog.enabled).description('终端输出看门狗:视图停滞且仍持有 attach 流时自动重连'),
    checkMs: z.number().default(DEFAULT_CONFIG.terminalWatchdog.checkMs).description('检查周期(毫秒)'),
    stallMs: z.number().default(DEFAULT_CONFIG.terminalWatchdog.stallMs).description('判定停滞的输出静默时长(毫秒)'),
    cooldownMs: z.number().default(DEFAULT_CONFIG.terminalWatchdog.cooldownMs).description('单个视图两次自愈的最小间隔(毫秒)'),
  }).description('终端输出看门狗'),
  socketKeepAlive: z.object({
    enabled: z.boolean().default(DEFAULT_CONFIG.socketKeepAlive.enabled).description('会话流保活:空闲时向会话流连接发送无害帧,避免宿主短心跳把公网连接误判为失联'),
    intervalMs: z.number().default(DEFAULT_CONFIG.socketKeepAlive.intervalMs).description('保活帧间隔(毫秒)'),
  }).description('会话流保活'),
  stuckSession: z.object({
    enabled: z.boolean().default(DEFAULT_CONFIG.stuckSession.enabled).description('会话停滞自愈:加载卡住时主动请求宿主重建连接,多次无效才给出提示'),
    checkMs: z.number().default(DEFAULT_CONFIG.stuckSession.checkMs).description('检查周期(毫秒)'),
    stallMs: z.number().default(DEFAULT_CONFIG.stuckSession.stallMs).description('判定加载停滞的持续时长(毫秒)'),
    reconnect: z.boolean().default(DEFAULT_CONFIG.stuckSession.reconnect).description('停滞时调用宿主 connection.reconnect() 主动重建连接'),
    maxReconnectAttempts: z.number().default(DEFAULT_CONFIG.stuckSession.maxReconnectAttempts).description('连续重建连接的最大次数,用尽后才显示提示'),
    reconnectIntervalMs: z.number().default(DEFAULT_CONFIG.stuckSession.reconnectIntervalMs).description('两次重建连接之间的最小间隔(毫秒)'),
  }).description('会话加载停滞兜底'),
  jobStreamLimit: z.object({
    enabled: z.boolean().default(DEFAULT_CONFIG.jobStreamLimit.enabled).description('任务状态流上限:每个会话行各订阅一条常驻 job/list 流,会话多时会把主线程压满,这里按默认窗口加点击放行'),
    base: z.number().default(DEFAULT_CONFIG.jobStreamLimit.base).description('默认窗口:只给主会话放行的条数,子 agent 会话不占这个窗口'),
    max: z.number().default(DEFAULT_CONFIG.jobStreamLimit.max).description('硬上限;点击某个会话可越过默认窗口加入,总数到上限后淘汰最先加入的一条'),
  }).description('任务状态流上限'),
  sessionWindow: z.object({
    enabled: z.boolean().default(DEFAULT_CONFIG.sessionWindow.enabled).description('历史窗口收敛:打开/重连会话时按消息预算下发历史页,工具密集的会话不会一次下发数千事件'),
    maxMessages: z.number().default(DEFAULT_CONFIG.sessionWindow.maxMessages).description('单次历史页的消息预算上限;请求预算更小时保持调用方值,不再放大'),
    minMessages: z.number().default(DEFAULT_CONFIG.sessionWindow.minMessages).description('轮边界下限的覆盖值:首屏规模实际由它决定,调小会减少首屏消息条数与渲染量;请求值更小时保持调用方值'),
    minTurns: z.number().default(DEFAULT_CONFIG.sessionWindow.minTurns).description('宿主轮边界下限的覆盖值:只向下调整(配置大于 2 不生效),仅在轮边界主导切窗时减少带回的轮数'),
  }).description('历史窗口收敛'),
  listSlim: z.object({
    enabled: z.boolean().default(DEFAULT_CONFIG.listSlim.enabled).description('会话列表瘦身:按白名单裁剪 session/list 的投影并缓存,降低列表响应体积与重建耗时;响应形状不符时透传,新增列表字段需同步白名单'),
  }).description('会话列表瘦身'),
  diag: z.object({
    enabled: z.boolean().default(DEFAULT_CONFIG.diag.enabled).description('性能采样上报:开启后按采样次数把页面性能摘要写入宿主临时文件,供事后排查;关闭时内存采样仍运行'),
    reportEvery: z.number().default(DEFAULT_CONFIG.diag.reportEvery).description('每多少次采样上报一次;采样周期固定,修改后刷新页面生效'),
  }).description('性能采样上报'),
}).description('宿主缺陷兜底与性能补丁,每个功能独立开关')

// 旧宿主 schemastery 无 volatile 方法,特性检测原样返回
export const Config = typeof SETTINGS_SCHEMA.volatile === 'function' ? SETTINGS_SCHEMA.volatile() : SETTINGS_SCHEMA

// 0.1.7 宿主以整节 volatile ref 传入,旧宿主为普通对象
const unwrapVolatile = (value) => (typeof value?.get === 'function' ? value.get() : value)

const sendJson = (res, status, body) => {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  })
  res.end(JSON.stringify(body))
}

// 设置页保存:legacy 命名空间以 register 在场为准(0.1.7 的 update 名义存在但按命名空间找条目必败);
// 0.1.7+ 走 configEditor 落 profile 条目,与命名空间解耦
const persistConfig = async (ctx, next) => {
  const settings = ctx.get('settings')
  if (settings !== undefined && typeof settings.register === 'function' && typeof settings.update === 'function') {
    await settings.update(NAMESPACE, next)
    return
  }
  const editor = ctx.get('configEditor')
  const entry = ctx.fiber?.entry
  if (editor !== undefined && typeof editor.edit === 'function' && entry !== undefined && entry !== null) {
    await editor.edit(entry, (current) => ({ ...(current ?? {}), ...next }))
    return
  }
  throw new Error('宿主配置服务不可用')
}

// 读回优先级:旧宿主 settings 命名空间已写入的节;否则用行配置(live ref 解箱);两者都按版本迁移
const readConfig = (ctx, config) => {
  const settings = ctx.get('settings')
  const stored = settings !== undefined && typeof settings.get === 'function' ? settings.get(NAMESPACE) : undefined
  const known = stored !== null && typeof stored === 'object'
    && ['restartCoalesce', 'terminalWatchdog', 'socketKeepAlive', 'stuckSession', 'jobStreamLimit', 'sessionWindow', 'listSlim', 'diag']
      .some((key) => stored[key] !== null && typeof stored[key] === 'object')
  return migrateConfig(known ? stored : unwrapVolatile(config))
}

const readBody = (req) => new Promise((resolve, reject) => {
  let size = 0
  const chunks = []
  req.on('data', (chunk) => {
    size += chunk.length
    if (size > BODY_MAX_BYTES) {
      reject(new Error('body too large'))
      req.destroy()
      return
    }
    chunks.push(chunk)
  })
  req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
  req.on('error', reject)
})

const configHandler = async (ctx, config, req, res) => {
  if (req.method !== 'POST') {
    if (req.method !== 'GET') {
      sendJson(res, 405, { error: 'method-not-allowed' })
      return
    }
    try {
      sendJson(res, 200, { config: readConfig(ctx, config) })
    } catch {
      sendJson(res, 500, { error: 'config-unavailable' })
    }
    return
  }
  let body
  try {
    body = JSON.parse(await readBody(req))
  } catch {
    sendJson(res, 400, { error: 'bad-payload' })
    return
  }
  const patch = body?.config
  if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) {
    sendJson(res, 400, { error: 'bad-config' })
    return
  }
  let next
  try {
    next = normalizeConfig({ ...readConfig(ctx, config), ...patch })
  } catch {
    sendJson(res, 500, { error: 'config-unavailable' })
    return
  }
  try {
    await persistConfig(ctx, next)
  } catch {
    sendJson(res, 503, { error: 'config-unavailable' })
    return
  }
  sendJson(res, 200, { config: next })
}

// 采样文件只保留最近一轮, 超过上限后轮转一次, 避免无限增长
const recordDiag = (payload) => {
  try {
    if (existsSync(DIAG_FILE) && statSync(DIAG_FILE).size > DIAG_MAX_BYTES) renameSync(DIAG_FILE, `${DIAG_FILE}.1`)
    appendFileSync(DIAG_FILE, `${JSON.stringify(payload)}\n`, 'utf8')
  } catch {
    // 磁盘不可写时丢弃采样, 不影响页面与宿主
  }
}

const diagHandler = (req, res) => {
  let value
  try {
    value = new URL(req.url ?? '/', 'http://localhost').searchParams.get('d')
  } catch {
    sendJson(res, 400, { error: 'bad-request' })
    return
  }
  if (value === null) {
    sendJson(res, 400, { error: 'missing-payload' })
    return
  }
  let payload
  try {
    payload = JSON.parse(value)
  } catch {
    sendJson(res, 400, { error: 'bad-payload' })
    return
  }
  recordDiag(payload)
  sendJson(res, 200, { ok: true })
}

export function apply(ctx, config) {
  // 列表瘦身与历史窗口收敛都不依赖 webServer/路由,开关从行配置实时读取;装载失败只关闭该能力
  installListSlim(ctx, { isEnabled: () => normalizeConfig(unwrapVolatile(config)).listSlim.enabled })
  installSessionWindow(ctx, {
    isEnabled: () => normalizeConfig(unwrapVolatile(config)).sessionWindow.enabled,
    readWindow: () => {
      const window = normalizeConfig(unwrapVolatile(config)).sessionWindow
      return { maxMessages: window.maxMessages, minMessages: window.minMessages, minTurns: window.minTurns }
    },
  })
  const server = ctx.get('webServer')
  if (server === undefined || typeof server.register !== 'function') return

  // 设置页持久化双形:legacy settings 命名空间 / 0.1.7 行配置编辑器
  const installSettings = (scope) => {
    const settings = scope.settings ?? scope.get?.('settings')
    if (settings === undefined) return
    if (typeof settings.register === 'function') {
      try {
        settings.register(NAMESPACE, SETTINGS_SCHEMA, { base: unwrapVolatile(config) })
      } catch (error) {
        console.warn('[dsh-bug-perf] settings unavailable:', error instanceof Error ? error.message : String(error))
      }
      return
    }
    if (typeof settings.configure === 'function') {
      try {
        scope.effect(() => settings.configure({ auto: false }, ctx.fiber))
      } catch (error) {
        console.warn('[dsh-bug-perf] settings configure failed:', error instanceof Error ? error.message : String(error))
      }
    }
  }
  if (typeof ctx.inject === 'function') ctx.inject(['settings'], installSettings)

  const routes = [
    {
      kind: 'exact',
      path: CONFIG_PATH,
      handler: (req, res) => configHandler(ctx, config, req, res),
    },
    {
      kind: 'exact',
      path: DIAG_PATH,
      handler: diagHandler,
    },
  ]
  try {
    ctx.effect(() => {
      const disposers = routes.map((route) => server.register(route))
      return () => { for (const dispose of disposers) if (typeof dispose === 'function') dispose() }
    }, 'bug-perf routes')
  } catch (error) {
    // 路由表冻结/换代竞态:补丁配置退回客户端默认值,不影响宿主
    console.warn('[dsh-bug-perf] routes unavailable:', error instanceof Error ? error.message : String(error))
  }
}

// hmr 触发探测
