// dsh-maintain Host 半区:版本监测 + 一键升级 + 安全重启。
// 双端模式照 dsh-usage-panel:webServer 具名路由供浏览器半区调用;
// 设置持久化走 settings 命名空间 maintain,检查结果仅存内存,不落盘。

import z from '@deepseek-ai/schemastery'

import {
  TARGET_PACKAGE,
  TAG_PLACEHOLDER,
  buildUpgradeCommand,
  fetchDistTags,
  isValidChannelName,
  isValidRegistryBase,
  judgeVersion,
  resolveHostVersion,
} from './core.mjs'
import { runUpgrade } from './upgrade.mjs'

export const name = 'dsh-maintain'

// timer 为软依赖:不进 inject 声明,服务缺失时仅停用自动轮询(状态接口提示),
// 插件其余能力(状态面板 / 手动检查 / 升级)不受影响,也不因等待服务而阻塞装载
export const inject = ['webServer']

const NAMESPACE = 'maintain'

const CHECK_TIMEOUT_MS = 20 * 1000
const UPGRADE_TIMEOUT_MS = 10 * 60 * 1000
// 响应发出到执行退出的延迟:保证浏览器收到 200 并进入重启等待态,进程才离场;
// 导出仅供测试计算延迟窗口等待时长
export const RESTART_DELAY_MS = 2 * 1000
// 轮询底层计时粒度;导出仅供 parity 测试与 client 提示文案对拍
export const TICK_MS = 60 * 1000

const DEFAULT_CHANNEL = 'latest'
// 默认值导出仅供 parity 测试作 host 侧锚点;行为入口全部经 readSettings 回落
export const DEFAULT_POLL_INTERVAL_SEC = 6 * 60 * 60
export const DEFAULT_UPGRADE_TEMPLATE = 'npm install -g ' + TARGET_PACKAGE + '@' + TAG_PLACEHOLDER
export const DEFAULT_REGISTRY_BASE = 'https://registry.npmjs.org'

// 注册即声明 GUI 设置表单,schema 默认值即生效默认值(rs-workflow-config 先例)。
const SETTINGS_SCHEMA = z.object({
  channel: z.string().default(DEFAULT_CHANNEL).description('追踪通道:npm dist-tag 名(latest/next/alpha 等,以检查返回的通道列表为准)'),
  pollIntervalSec: z.number().default(DEFAULT_POLL_INTERVAL_SEC).description('轮询间隔秒数,仅正数启用周期检查'),
  upgradeCommandTemplate: z.string().default(DEFAULT_UPGRADE_TEMPLATE).description('升级命令模板,{tag} 执行时替换为追踪通道,可整体自改为任意命令'),
  registryBase: z.string().default(DEFAULT_REGISTRY_BASE).description('npm registry 基地址,官方源不可达时改为镜像地址'),
})

function sendJson(res, status, payload) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(payload))
}

// 同源守卫:浏览器写请求恒带 Origin,与 Host 不符即拒;无 Origin 的非浏览器客户端放行。
// 升级/重启是破坏性端点,与外层鉴权插件互补,阻断跨站简单请求 drive-by 触发。
// host 比较大小写归一:URL.host 恒小写,请求 Host 头保原始大小写。
function rejectCrossOrigin(req, res) {
  const origin = req.headers ? req.headers.origin : undefined
  if (!origin) return false
  const host = String((req.headers && req.headers.host) || '')
  let sameOrigin = false
  try {
    // host 为空即不同源:缺失 Host 头与 file:// Origin 的空 host 不得双空判同源
    sameOrigin = host.length > 0 && new URL(origin).host === host.toLowerCase()
  } catch {
    sameOrigin = false
  }
  if (sameOrigin) return false
  sendJson(res, 403, { error: '跨源请求被拒绝' })
  return true
}

// 路由样板收敛:方法守卫与跨源守卫统一在此,业务异常统一归一 400,handler 只留业务体
const route = (method, guards, handler) => async (req, res) => {
  if (req.method !== method) {
    sendJson(res, 405, { error: 'method not allowed' })
    return
  }
  if (guards.crossOrigin && rejectCrossOrigin(req, res)) return
  try {
    await handler(req, res)
  } catch (error) {
    sendJson(res, 400, { error: error && error.message ? error.message : String(error) })
  }
}

function readBody(req) {
  const BODY_MAX_BYTES = 64 * 1024
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > BODY_MAX_BYTES) {
        // 超限即断连:后续 destroy 触发的 error 由已 settle 的 Promise 吸收,属预期;
        // 客户端收到连接重置即视为超限,不再尝试写结构化错误
        reject(new Error('请求体超过上限'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

function readSettings(ctx) {
  const settings = ctx.get('settings')
  const value = settings ? settings.get(NAMESPACE) : undefined
  return {
    channel: value && typeof value.channel === 'string' && value.channel.trim().length > 0 ? value.channel.trim() : DEFAULT_CHANNEL,
    pollIntervalSec:
      value && typeof value.pollIntervalSec === 'number' && Number.isFinite(value.pollIntervalSec)
        ? value.pollIntervalSec
        : DEFAULT_POLL_INTERVAL_SEC,
    upgradeCommandTemplate:
      value && typeof value.upgradeCommandTemplate === 'string' && value.upgradeCommandTemplate.trim().length > 0
        ? value.upgradeCommandTemplate
        : DEFAULT_UPGRADE_TEMPLATE,
    registryBase:
      value && typeof value.registryBase === 'string' && value.registryBase.trim().length > 0
        ? value.registryBase.trim()
        : DEFAULT_REGISTRY_BASE,
  }
}

async function resolveCurrentHostVersion() {
  return resolveHostVersion({
    execPath: process.execPath,
    platform: process.platform,
    readFileImpl: (path) => import('node:fs/promises').then((fs) => fs.readFile(path, 'utf8')),
    resolveImpl: undefined,
  })
}

/** @param {import('@deepseek-ai/cordis').Context} ctx */
export function apply(ctx) {
  // 启动器在挂载前提供 appExit(有界退出,5 秒兜底强制);缺失时重启能力关闭
  const exit = ctx.get('appExit')

  // 内存快照:仅存当前态,进程重启后从启动检查重新开始(设计约束:不持久化)
  const snapshot = { currentVersion: null, tags: null, checkedAt: null, error: null }
  let upgrade = { running: false, last: null }
  let checkInFlight = null
  let nextDueAt = null
  let restartScheduled = false

  function runCheck() {
    if (checkInFlight) return checkInFlight
    checkInFlight = (async () => {
      const config = readSettings(ctx)
      try {
        snapshot.tags = await fetchDistTags({ registryBase: config.registryBase, timeoutMs: CHECK_TIMEOUT_MS })
        snapshot.error = null
      } catch (error) {
        // registry 不可达:保留上次 tags,仅记录错误
        snapshot.error = error && error.message ? error.message : String(error)
      }
      snapshot.currentVersion = await resolveCurrentHostVersion()
      snapshot.checkedAt = Date.now()
      return snapshot
    })()
    return checkInFlight.finally(() => {
      checkInFlight = null
    })
  }

  function scheduleNext() {
    const intervalSec = readSettings(ctx).pollIntervalSec
    nextDueAt = intervalSec > 0 ? Date.now() + intervalSec * 1000 : null
  }

  // 固定短 tick + 到期判断:间隔设置变更即时生效。timer 软依赖经嵌套 inject 等待:
  // 服务激活才武装轮询,缺失则回调不执行,面板以 pollRunning 提示降级。
  // dispose 显式挂回插件 fiber:timer 服务重启导致嵌套 fiber 重跑时不产生双 interval
  let pollRunning = false
  ctx.inject(['timer'], (timerCtx) => {
    if (typeof timerCtx.interval !== 'function') return
    const dispose = timerCtx.interval(() => {
      if (checkInFlight !== null || nextDueAt === null || Date.now() < nextDueAt) return
      runCheck().then(scheduleNext, scheduleNext)
    }, TICK_MS)
    ctx.effect(() => dispose, 'dsh-maintain poll interval')
    pollRunning = true
  })

  function currentStatus() {
    const config = readSettings(ctx)
    const judged = judgeVersion({ currentVersion: snapshot.currentVersion, tags: snapshot.tags, channel: config.channel })
    return {
      packageName: TARGET_PACKAGE,
      pid: process.pid,
      pollRunning,
      currentVersion: snapshot.currentVersion,
      channel: config.channel,
      upgradeTemplate: config.upgradeCommandTemplate,
      pollIntervalSec: config.pollIntervalSec,
      registryBase: config.registryBase,
      tags: snapshot.tags,
      channelLatest: judged.channelLatest,
      verdict: judged.verdict,
      reason: judged.reason,
      checkedAt: snapshot.checkedAt,
      checkError: snapshot.error,
      upgrade,
      canRestart: typeof exit === 'function',
    }
  }

  function triggerUpgrade() {
    const config = readSettings(ctx)
    // 模板校验同步失败即同步 throw,由调用方 try/catch 转 400,不走异步通道
    const command = buildUpgradeCommand({ template: config.upgradeCommandTemplate, tag: config.channel })
    const last = { command, startedAt: Date.now(), ok: false, finishedAt: null, timedOut: false, code: null, stdoutTail: '', stderrTail: '', error: null }
    // running 即串行化门闩:路由检查与本处置位之间无 await,单线程下无竞态窗口
    upgrade = { running: true, last }
    runUpgrade({ command, timeoutMs: UPGRADE_TIMEOUT_MS })
      .then((result) => {
        upgrade = {
          running: false,
          last: { ...last, ok: result.ok, finishedAt: Date.now(), timedOut: result.timedOut, code: result.code, stdoutTail: result.stdoutTail, stderrTail: result.stderrTail },
        }
      })
      .catch((error) => {
        upgrade = { running: false, last: { ...last, finishedAt: Date.now(), error: error && error.message ? error.message : String(error) } }
      })
      // 升级结束后自动重新检查版本并重排轮询(命令可能改了本地版本)
      .then(runCheck, runCheck)
      .then(scheduleNext, scheduleNext)
  }

  const WRITE = { crossOrigin: true }

  const routes = [
    {
      path: '/api/maintain/status',
      handler: route('GET', {}, async (req, res) => {
        sendJson(res, 200, currentStatus())
      }),
    },
    {
      path: '/api/maintain/refresh',
      handler: route('POST', WRITE, async (req, res) => {
        await runCheck()
        scheduleNext()
        sendJson(res, 200, currentStatus())
      }),
    },
    {
      path: '/api/maintain/channel',
      handler: route('POST', WRITE, async (req, res) => {
        const body = JSON.parse(await readBody(req))
        const channel = body && typeof body.channel === 'string' ? body.channel.trim() : ''
        if (channel.length === 0) {
          sendJson(res, 400, { error: 'channel 不能为空' })
          return
        }
        if (!isValidChannelName(channel)) {
          sendJson(res, 400, { error: '通道名含非法字符,仅允许字母/数字/-/./_ : ' + channel })
          return
        }
        // tags 未就绪时白名单兜底校验,远端可控的 tag 名不落盘
        if (snapshot.tags !== null && !Object.prototype.hasOwnProperty.call(snapshot.tags, channel)) {
          sendJson(res, 400, { error: '通道 ' + channel + ' 不在当前 dist-tags 中' })
          return
        }
        const settings = ctx.get('settings')
        if (!settings) {
          sendJson(res, 500, { error: 'settings 服务不可用' })
          return
        }
        await settings.update(NAMESPACE, { channel })
        await runCheck()
        scheduleNext()
        sendJson(res, 200, currentStatus())
      }),
    },
    {
      path: '/api/maintain/upgrade-template',
      handler: route('POST', WRITE, async (req, res) => {
        const body = JSON.parse(await readBody(req))
        const template = body && typeof body.template === 'string' ? body.template.trim() : ''
        if (template.length === 0) {
          sendJson(res, 400, { error: '升级命令不能为空' })
          return
        }
        const settings = ctx.get('settings')
        if (!settings) {
          sendJson(res, 500, { error: 'settings 服务不可用' })
          return
        }
        await settings.update(NAMESPACE, { upgradeCommandTemplate: template })
        sendJson(res, 200, currentStatus())
      }),
    },
    {
      path: '/api/maintain/poll-interval',
      handler: route('POST', WRITE, async (req, res) => {
        const body = JSON.parse(await readBody(req))
        // 严格类型:字符串/ null 等经 Number() 宽转后可能变 0,静默翻转轮询开关
        const seconds = body && typeof body.seconds === 'number' ? body.seconds : NaN
        if (!Number.isFinite(seconds) || seconds < 0) {
          sendJson(res, 400, { error: '轮询间隔必须是不小于 0 的秒数' })
          return
        }
        const settings = ctx.get('settings')
        if (!settings) {
          sendJson(res, 500, { error: 'settings 服务不可用' })
          return
        }
        await settings.update(NAMESPACE, { pollIntervalSec: seconds })
        scheduleNext()
        sendJson(res, 200, currentStatus())
      }),
    },
    {
      path: '/api/maintain/registry-base',
      handler: route('POST', WRITE, async (req, res) => {
        const body = JSON.parse(await readBody(req))
        const base = body && typeof body.base === 'string' ? body.base.trim() : ''
        if (!isValidRegistryBase(base)) {
          sendJson(res, 400, { error: 'registry 基地址必须以 http:// 或 https:// 开头' })
          return
        }
        const settings = ctx.get('settings')
        if (!settings) {
          sendJson(res, 500, { error: 'settings 服务不可用' })
          return
        }
        await settings.update(NAMESPACE, { registryBase: base })
        // 排空旧源的在途检查:runCheck 以 checkInFlight 去重,不排空会把旧源结果当作新源检查返回
        if (checkInFlight) await checkInFlight
        await runCheck()
        scheduleNext()
        sendJson(res, 200, currentStatus())
      }),
    },
    {
      path: '/api/maintain/upgrade',
      handler: route('POST', WRITE, async (req, res) => {
        if (upgrade.running) {
          sendJson(res, 409, { error: '升级进行中' })
          return
        }
        triggerUpgrade()
        sendJson(res, 200, currentStatus())
      }),
    },
    {
      path: '/api/maintain/restart',
      handler: route('POST', WRITE, async (req, res) => {
        // 与升级门闩互斥:升级子进程经 detached+unref 存活于宿主死后,
        // 重启后新宿主门闩归零会放行第二次升级,双 npm install 并发写全局目录
        if (upgrade.running) {
          sendJson(res, 409, { error: '升级进行中,禁止重启;等待升级完成后重试' })
          return
        }
        if (typeof exit !== 'function') {
          sendJson(res, 500, { error: '启动器未提供 appExit,无法重启' })
          return
        }
        if (restartScheduled) {
          sendJson(res, 200, { ok: true, restarting: true })
          return
        }
        restartScheduled = true
        sendJson(res, 200, { ok: true, restarting: true })
        // 退出延迟与响应冲刷解耦:客户端在冲刷完成前断连会让 end 回调失效,绑定其上会使重启悬空;
        // 同步发出响应后延迟退出,延迟本身保证回执先于进程离场送达
        setTimeout(() => exit(0), RESTART_DELAY_MS)
      }),
    },
  ]

  for (const route of routes) {
    ctx.effect(() => ctx.webServer.register({ kind: 'exact', path: route.path, handler: route.handler }), 'dsh-maintain ' + route.path)
  }

  ctx.inject(['settings'], (settingsCtx) => {
    settingsCtx.settings.register(NAMESPACE, SETTINGS_SCHEMA)
    // 启动检查放在 settings 注册之后:命名空间未注册时 readSettings 只能拿默认值,
    // 配置了镜像地址的部署会确定性检查失败
    runCheck().then(scheduleNext, scheduleNext)
  })
}
