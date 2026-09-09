// dsh-cron-board Host 半区:轻量级青龙面板。环境变量集中管理 + 定时任务(cron)调度,
// 执行体两类:本地脚本(宿主进程内 spawn)与 dsh 会话任务(定时向 dsh 会话投递任务文本)。
// 模块分层:store(持久化)/ logger(日志)/ runner(执行)/ api(路由)/ scheduler(调度,M2)。

import { homedir } from 'node:os'
import { join } from 'node:path'

import { createApi } from './api.mjs'
import { createLogger } from './logger.mjs'
import { createStore } from './store.mjs'

export const name = 'dsh-cron-board'

export const inject = ['webServer']

// 数据目录 env 覆盖:测试注入临时目录(对齐 dsh-usage-panel 先例)
const DATA_DIR_ENV = 'DSH_CRON_BOARD_DATA_DIR'
const API_PREFIX = '/api/cron-board'

export function resolveDataDir(env = process.env) {
  const override = env[DATA_DIR_ENV]
  if (override && override.trim() !== '') return override.trim()
  return join(homedir(), '.dsh', 'cron-board')
}

export function apply(ctx, config) {
  void config
  const dataDir = resolveDataDir()
  // 装配惰性单例:首个请求触发初始化,store/logger 只建一次
  let apiPromise = null
  const getApi = () => {
    if (apiPromise === null) {
      apiPromise = (async () => {
        const store = await createStore({ dir: dataDir })
        const logger = createLogger({ rootDir: join(dataDir, 'logs') })
        return createApi({
          store,
          logger,
          logSystem: (line) => (ctx.logger && ctx.logger.warn ? ctx.logger.warn(line) : undefined),
        })
      })()
      apiPromise.catch(() => {})
    }
    return apiPromise
  }

  ctx.effect(
    () => ctx.webServer.register({
      kind: 'prefix',
      path: API_PREFIX,
      handler: async (req, res) => {
        try {
          const api = await getApi()
          await api.handle(req, res)
        } catch (error) {
          res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' })
          res.end(JSON.stringify({ error: '操作失败(系统级错误,详见服务端日志)' }))
          if (ctx.logger && ctx.logger.warn) ctx.logger.warn('[cron-board] ' + String(error && error.stack || error))
        }
      },
    }),
    'cron-board api',
  )
}
