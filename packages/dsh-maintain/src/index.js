// dsh-maintain Host 半区:版本监测 + 一键升级 + 安全重启。
// 双端模式照 dsh-usage-panel:webServer 具名路由供浏览器半区调用;
// 设置持久化走 settings 命名空间 maintain,检查结果仅存内存,不落盘。

import z from '@deepseek-ai/schemastery'
import { settingsNamespace } from '@deepseek-ai/dsh-settings'

import {
  TARGET_PACKAGE,
  TAG_PLACEHOLDER,
  buildUpgradeCommand,
  assertSameOrigin,
  fetchDistTags,
  judgeVersion,
  resolveHostVersion,
} from './core.mjs'
import { runUpgrade } from './upgrade.mjs'

export const name = 'dsh-maintain'

export const inject = ['webServer', 'timer']

const NAMESPACE = settingsNamespace('maintain')

const CHECK_TIMEOUT_MS = 20 * 1000
const UPGRADE_TIMEOUT_MS = 10 * 60 * 1000
const TICK_MS = 60 * 1000

const DEFAULT_CHANNEL = 'latest'
const DEFAULT_POLL_INTERVAL_SEC = 6 * 60 * 60
const DEFAULT_UPGRADE_TEMPLATE = 'npm install -g ' + TARGET_PACKAGE + '@' + TAG_PLACEHOLDER
const DEFAULT_REGISTRY_BASE = 'https://registry.npmjs.org'

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

function readBody(req) {
  const BODY_MAX_BYTES = 64 * 1024
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > BODY_MAX_BYTES) {
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
    pollIntervalSec: value && Number.isFinite(Number(value.pollIntervalSec)) ? Number(value.pollIntervalSec) : DEFAULT_POLL_INTERVAL_SEC,
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

  // 固定短 tick + 到期判断:间隔设置变更即时生效;ctx.interval 绑定 fiber,停用自动清理
  ctx.interval(() => {
    if (checkInFlight !== null || nextDueAt === null || Date.now() < nextDueAt) return
    runCheck().then(scheduleNext, scheduleNext)
  }, TICK_MS)

  function currentStatus() {
    const config = readSettings(ctx)
    const judged = judgeVersion({ currentVersion: snapshot.currentVersion, tags: snapshot.tags, channel: config.channel })
    return {
      packageName: TARGET_PACKAGE,
      currentVersion: snapshot.currentVersion,
      channel: config.channel,
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
    let command
    try {
      command = buildUpgradeCommand({ template: config.upgradeCommandTemplate, tag: config.channel })
    } catch (error) {
      return Promise.reject(error)
    }
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

  const rejectNonPost = (req, res) => {
    if (req.method === 'POST') return true
    sendJson(res, 405, { error: 'method not allowed' })
    return false
  }

  const guardSameOrigin = (req, res) => {
    try {
      assertSameOrigin({ origin: req.headers.origin, referer: req.headers.referer, host: req.headers.host })
      return true
    } catch (error) {
      sendJson(res, 403, { error: error && error.message ? error.message : String(error) })
      return false
    }
  }

  const routes = [
    {
      path: '/api/maintain/status',
      handler: async (req, res) => {
        if (req.method !== 'GET') {
          sendJson(res, 405, { error: 'method not allowed' })
          return
        }
        sendJson(res, 200, currentStatus())
      },
    },
    {
      path: '/api/maintain/refresh',
      handler: async (req, res) => {
        if (!rejectNonPost(req, res)) return
        await runCheck()
        scheduleNext()
        sendJson(res, 200, currentStatus())
      },
    },
    {
      path: '/api/maintain/channel',
      handler: async (req, res) => {
        if (!rejectNonPost(req, res)) return
        try {
          const body = JSON.parse(await readBody(req))
          const channel = body && typeof body.channel === 'string' ? body.channel.trim() : ''
          if (channel.length === 0) {
            sendJson(res, 400, { error: 'channel 不能为空' })
            return
          }
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
        } catch (error) {
          sendJson(res, 400, { error: error && error.message ? error.message : String(error) })
        }
      },
    },
    {
      path: '/api/maintain/upgrade',
      handler: async (req, res) => {
        if (!rejectNonPost(req, res)) return
        if (!guardSameOrigin(req, res)) return
        if (upgrade.running) {
          sendJson(res, 409, { error: '升级进行中' })
          return
        }
        try {
          triggerUpgrade()
        } catch (error) {
          sendJson(res, 400, { error: error && error.message ? error.message : String(error) })
          return
        }
        sendJson(res, 200, currentStatus())
      },
    },
    {
      path: '/api/maintain/restart',
      handler: async (req, res) => {
        if (!rejectNonPost(req, res)) return
        if (!guardSameOrigin(req, res)) return
        if (typeof exit !== 'function') {
          sendJson(res, 500, { error: '启动器未提供 appExit,无法重启' })
          return
        }
        sendJson(res, 200, { ok: true, restarting: true })
        // 响应先冲刷再请求退出;托管环境由进程管理器拉起,dispose 挂起时 5 秒兜底强制
        setImmediate(() => exit(0))
      },
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
