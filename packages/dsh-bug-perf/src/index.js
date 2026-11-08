// dsh-bug-perf Host 半区:把行配置归一化后经只读路由交给浏览器半区,
// 并接收浏览器定期上报的性能采样(只落本地临时文件,用于定位“越用越卡”)。
// 补丁本身全部在客户端执行;这里不做认证,缺 webServer 或路由注册失败都不影响宿主。
import { appendFileSync, existsSync, renameSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import z from '@deepseek-ai/schemastery'
import { DEFAULT_CONFIG, normalizeConfig } from './config.mjs'

export const name = 'dsh-bug-perf'
// web profile 必有 webServer; 声明依赖让 apply 在服务就绪后执行,缺服务宿主即不激活本行
export const inject = ['webServer']

const CONFIG_PATH = '/api/dsh-bug-perf/config'
const DIAG_PATH = '/api/dsh-bug-perf/diag'
const DIAG_FILE = join(tmpdir(), 'dsh-bug-perf-diag.jsonl')
const DIAG_MAX_BYTES = 2 * 1024 * 1024

const SETTINGS_SCHEMA = z.object({
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
  const server = ctx.get('webServer')
  if (server === undefined || typeof server.register !== 'function') return
  const routes = [
    {
      kind: 'exact',
      path: CONFIG_PATH,
      handler: (_req, res) => {
        try {
          sendJson(res, 200, { config: normalizeConfig(unwrapVolatile(config)) })
        } catch {
          sendJson(res, 500, { error: 'config-unavailable' })
        }
      },
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
