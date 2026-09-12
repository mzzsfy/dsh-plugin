// dsh-cron-board Host 半区:轻量级定时任务看板。环境变量集中管理 + 定时任务(cron)调度,
// 执行体两类:本地脚本(宿主进程内 spawn)与 dsh 会话任务(定时向 dsh 会话投递任务文本)。
// 模块分层:store(持久化)/ logger(日志)/ executor(执行链)/ scheduler(调度)/ api(路由)。
// timer 为软依赖(嵌套注入,缺失降级只影响自动调度);settings 缺省时读默认常量。

import { homedir } from 'node:os'
import { join } from 'node:path'

import schemastery from '@deepseek-ai/schemastery'

import { createApi } from './api.mjs'
import { DEFAULT_MAX_CONCURRENT, DEFAULT_TICK_MS, MIN_TICK_MS } from './config.mjs'
import { createExecutor } from './executor.mjs'
import { createLogger } from './logger.mjs'
import { createScheduler } from './scheduler.mjs'
import { createSessionDriver } from './session-driver.mjs'
import { createStore } from './store.mjs'

export const name = 'dsh-cron-board'

// 会话任务依赖的 sessionController 由 dsh-web-app 的 session-controller 条目挂载,
// 注册晚于同批条目的 apply(异步装配),且 0.1.1-rc.2 无此服务:inject 声明会在旧版
// 永久 pending 拖死 boot,apply 内同步探测又会抢在挂载前误判缺失(0.1.2-rc.1 实测
// 404)。唯一两头正确的形态:启动后异步轮询等待服务出现再装配,超时仍缺失即干净禁用
export const inject = ['webServer']

// 数据目录 env 覆盖:测试注入临时目录(对齐 dsh-usage-panel 先例)
const DATA_DIR_ENV = 'DSH_CRON_BOARD_DATA_DIR'
const API_PREFIX = '/api/cron-board'
const SETTINGS_NS = 'cron-board'
const TIMER_UNAVAILABLE_REASON = '宿主定时服务不可用,自动调度已停用'
const SESSION_UNAVAILABLE_REASON = '宿主会话服务 sessionController 不可用(需 dsh-web-app 挂载 session-controller,0.1.1-rc.2 及更早版本缺失),会话任务通道禁用,脚本任务不受影响'
const SESSION_WAIT_MS = 15 * 1000
const SESSION_POLL_MS = 250
const DEFAULT_LOG_KEEP_PER_JOB = 200

// 设置 schema(schemastery 声明式):tick 周期 / 全局并发 / 日志与运行元数据保留份数 / 会话投递变量掩码 / 侧边栏移入偏好
const SETTINGS_SCHEMA = schemastery.object({
  tickSeconds: schemastery.number().min(MIN_TICK_MS / 1000).step(1).default(DEFAULT_TICK_MS / 1000),
  maxConcurrent: schemastery.number().min(1).step(1).default(DEFAULT_MAX_CONCURRENT),
  logKeepPerJob: schemastery.number().min(1).step(1).default(200),
  maskEnvInPrompt: schemastery.boolean().default(false).description('会话任务投递文本中环境变量打码'),
  sidebarTab: schemastery.boolean().default(false).description('看板移入 better-sidebar 侧边栏(需已安装;关闭时始终使用主界面)'),
})

export function resolveDataDir(env = process.env) {
  const override = env[DATA_DIR_ENV]
  if (override && override.trim() !== '') return override.trim()
  return join(homedir(), '.dsh', 'cron-board')
}

export function apply(ctx, config) {
  const dataDir = resolveDataDir()
  // 装配惰性单例:首个请求 / timer 激活触发初始化,各组件只建一次
  let runtimePromise = null
  // 会话通道就绪状态:等待期 API 已可服务脚本任务,就绪/禁用后状态定格
  const sessionState = { ready: false, disabled: false }
  // 生命周期解绑引用:惰性装配完成前给安全空实现,装配后指向真实 scheduler
  const schedulerRef = { current: { dispose() {} } }
  const getRuntime = () => {
    if (runtimePromise === null) {
      runtimePromise = (async () => {
        const store = await createStore({ dir: dataDir })
        const logger = createLogger({ rootDir: join(dataDir, 'logs') })
        const sessionDriver = createSessionDriver({
          getSessionController: () => sessionControllerRef.current,
          // 分组解析为可选增强:registry 缺失(旧宿主)时 driver 干净降级为 cwd-only
          getWorkspaceRegistry: () => ctx.get('workspaceRegistry'),
          // 执行预设目录为可选增强:服务缺失时任务不带 preset,由宿主解析默认
          getAgentPresets: () => ctx.get('agentPresets'),
          agents: ctx.get('agents'),
          sessionQuery: ctx.get('sessionQuery'),
        })
        const executor = createExecutor({
          store,
          logger,
          sessionRunner: sessionDriver,
          readMaxConcurrent,
          readLogKeep: () => readNumber('logKeepPerJob', DEFAULT_LOG_KEEP_PER_JOB),
          readMaskEnvInPrompt: () => readBoolean('maskEnvInPrompt', false),
          logSystem: (line) => (ctx.logger && ctx.logger.warn ? ctx.logger.warn(line) : undefined),
        })
        const scheduler = createScheduler({ store, executor, readTickMs })
        schedulerRef.current = scheduler
        await scheduler.recover()
        const api = createApi({
          store,
          logger,
          executor,
          scheduler,
          periodic,
          sessionState,
          readSidebarTab: () => readBoolean('sidebarTab', false),
          updateUiSettings,
          getAgentPresets: () => ctx.get('agentPresets'),
          logSystem: (line) => (ctx.logger && ctx.logger.warn ? ctx.logger.warn(line) : undefined),
        })
        return { api, scheduler }
      })()
      runtimePromise.catch(() => {})
    }
    return runtimePromise
  }

  // 会话通道异步就绪:轮询等待 dsh-web-app 挂载 sessionController(时序不可赌,
  // 实测 0.1.2-rc.1 冷启动挂载晚于本插件 apply),超时仍缺失即按旧宿主对待
  ctx.effect(() => {
    const startedAt = Date.now()
    const poll = setInterval(() => {
      // ctx.get 不受 inject 门控(cordis 明文契约:缺失返回 undefined)
      const sessionController = ctx.get('sessionController')
      if (sessionController) {
        sessionState.ready = true
        sessionControllerRef.current = sessionController
        clearInterval(poll)
        return
      }
      if (Date.now() - startedAt >= SESSION_WAIT_MS) {
        sessionState.disabled = true
        // rc.2 的 cordis logger 默认 exporter 仅入内存缓冲无输出通道,告警必须直写 stderr 才可见
        process.stderr.write('[cron-board] ' + SESSION_UNAVAILABLE_REASON + '\n')
        if (ctx.logger && ctx.logger.warn) ctx.logger.warn('[cron-board] ' + SESSION_UNAVAILABLE_REASON)
        clearInterval(poll)
      }
    }, SESSION_POLL_MS)
    return () => clearInterval(poll)
  }, 'cron-board session wait')
  const sessionControllerRef = { current: null }

  const periodic = { running: false, reason: null }
  let armTick = null
  let disposeTick = null

  function readNumber(name, fallback) {
    const value = readSettingValue(name)
    return typeof value === 'number' && Number.isFinite(value) ? value : fallback
  }
  function readBoolean(name, fallback) {
    const value = readSettingValue(name)
    return typeof value === 'boolean' ? value : fallback
  }
  // 客户端设置面板写入通道:settings 服务在场时按命名空间合并补丁
  function updateUiSettings(patch) {
    const settings = ctx.get('settings')
    if (!settings || typeof settings.update !== 'function') return false
    settings.update(SETTINGS_NS, patch)
    return true
  }
  function readSettingValue(name) {
    const settings = ctx.get('settings')
    const scope = settings && settings.get ? settings.get(SETTINGS_NS) : undefined
    return scope ? scope[name] : undefined
  }
  function readTickMs() {
    return Math.max(MIN_TICK_MS, readNumber('tickSeconds', DEFAULT_TICK_MS / 1000) * 1000)
  }
  function readMaxConcurrent() {
    return readNumber('maxConcurrent', DEFAULT_MAX_CONCURRENT)
  }

  ctx.inject(['timer'], (tctx) => {
    if (typeof tctx.interval !== 'function') {
      periodic.reason = TIMER_UNAVAILABLE_REASON
      return () => {}
    }
    armTick = () => {
      if (disposeTick) disposeTick()
      disposeTick = tctx.interval(() => {
        getRuntime()
          .then((runtime) => runtime.scheduler.tick())
          .catch((error) => {
            if (ctx.logger && ctx.logger.warn) ctx.logger.warn('[cron-board] 调度 tick 失败: ' + String(error && error.stack || error))
          })
      }, readTickMs())
    }
    armTick()
    periodic.running = true
    return () => {
      if (disposeTick) disposeTick()
      disposeTick = null
      periodic.running = false
    }
  })

  ctx.inject(['settings'], (sctx) => {
    if (typeof sctx.settings.register !== 'function') return
    const scope = sctx.settings.register(SETTINGS_NS, SETTINGS_SCHEMA, { base: config })
    // tick 周期等设置变更即时对账(重建 interval)
    if (scope && typeof scope.watch === 'function') {
      scope.watch(() => { if (armTick && periodic.running) armTick() })
    }
  })

  ctx.effect(
    () => {
      const disposeRoute = ctx.webServer.register({
        kind: 'prefix',
        path: API_PREFIX,
        handler: async (req, res) => {
          try {
            const runtime = await getRuntime()
            await runtime.api.handle(req, res)
          } catch (error) {
            res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' })
            res.end(JSON.stringify({ error: '操作失败(系统级错误,详见服务端日志)' }))
            if (ctx.logger && ctx.logger.warn) ctx.logger.warn('[cron-board] ' + String(error && error.stack || error))
          }
        },
      })
      return () => {
        disposeRoute()
      }
    },
    'cron-board api',
  )

  // defer 挂起定时器随插件生命周期回收,不遗留生命周期外触发
  // 生命周期钩子:scheduler 无挂起资源时 dispose 可缺省,可选调用保持约定统一
  ctx.effect(() => () => schedulerRef.current.dispose?.(), 'cron-board scheduler lifecycle')
}
