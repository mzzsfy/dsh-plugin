// dsh-bug-perf Host 半区:把行配置归一化后经只读路由交给浏览器半区。
// 补丁本身全部在客户端执行;这里只做配置分发,缺 webServer 或路由注册失败都不影响宿主。
import z from '@deepseek-ai/schemastery'
import { DEFAULT_CONFIG, normalizeConfig } from './config.mjs'

export const name = 'dsh-bug-perf'
// web profile 必有 webServer; 声明依赖让 apply 在服务就绪后执行,缺服务宿主即不激活本行
export const inject = ['webServer']

const CONFIG_PATH = '/api/dsh-bug-perf/config'

const SETTINGS_SCHEMA = z.object({
  restartCoalesce: z.object({
    enabled: z.boolean().default(DEFAULT_CONFIG.restartCoalesce.enabled).description('合并 session/follow 重建:同一 Remote stream 在窗口内的多次重启只保留一次尾随执行'),
    windowMs: z.number().default(DEFAULT_CONFIG.restartCoalesce.windowMs).description('合并窗口(毫秒);0 表示只合并同一 tick 内的重启'),
  }).description('会话流重建合并'),
  terminalWatchdog: z.object({
    enabled: z.boolean().default(DEFAULT_CONFIG.terminalWatchdog.enabled).description('终端输出看门狗:视图停滞且仍持有 attach 流时自动重连'),
    checkMs: z.number().default(DEFAULT_CONFIG.terminalWatchdog.checkMs).description('检查周期(毫秒)'),
    stallMs: z.number().default(DEFAULT_CONFIG.terminalWatchdog.stallMs).description('判定停滞的输出静默时长(毫秒)'),
    cooldownMs: z.number().default(DEFAULT_CONFIG.terminalWatchdog.cooldownMs).description('单个视图两次自愈的最小间隔(毫秒)'),
  }).description('终端输出看门狗'),
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

export function apply(ctx, config) {
  const server = ctx.get('webServer')
  if (server === undefined || typeof server.register !== 'function') return
  const route = {
    kind: 'exact',
    path: CONFIG_PATH,
    handler: (_req, res) => {
      try {
        sendJson(res, 200, { config: normalizeConfig(unwrapVolatile(config)) })
      } catch {
        sendJson(res, 500, { error: 'config-unavailable' })
      }
    },
  }
  try {
    ctx.effect(() => server.register(route), 'bug-perf config route')
  } catch (error) {
    // 路由表冻结/换代竞态:补丁配置退回客户端默认值,不影响宿主
    console.warn('[dsh-bug-perf] config route unavailable:', error instanceof Error ? error.message : String(error))
  }
}
