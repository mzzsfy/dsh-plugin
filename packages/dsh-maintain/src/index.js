// dsh-maintain Host 半区:版本监测 + 一键升级 + 安全重启。
// 双端模式照 dsh-usage-panel:webServer 具名路由供浏览器半区调用;
// 设置持久化走 settings 命名空间 maintain,检查结果仅存内存,不落盘。

import { readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readFileSync, writeFileSync, rmSync } from 'node:fs'
import z from '@deepseek-ai/schemastery'

import {
  TARGET_PACKAGE,
  TAG_PLACEHOLDER,
  buildUpgradeCommand,
  classifyUpgradeFailure,
  fetchDistTags,
  isValidChannelName,
  isValidRegistryBase,
  isVersionPendingRestart,
  judgeUpgradeFreshness,
  judgeVersion,
  resolveHostVersion,
  UPGRADE_FAIL_FILE_LOCKED,
  UPGRADE_FAIL_TRANSIENT_NETWORK,
  VERDICT_UP_TO_DATE,
} from './core.mjs'
import { runUpgrade } from './upgrade.mjs'
import { detectRuntimeEnv, RUNTIME_KINDS } from './runtime.mjs'

export const name = 'dsh-maintain'

// timer 为软依赖:不进 inject 声明,服务缺失时仅停用自动轮询(状态接口提示),
// 插件其余能力(状态面板 / 手动检查 / 升级)不受影响,也不因等待服务而阻塞装载
export const inject = ['webServer']

const NAMESPACE = 'maintain'

const CHECK_TIMEOUT_MS = 20 * 1000
// 升级命令超时:client 浮条观察上限与此对拍(parity 锁定),强杀宽限另计
export const UPGRADE_TIMEOUT_MS = 10 * 60 * 1000
// 响应发出到执行退出的延迟:保证浏览器收到 200 并进入重启等待态,进程才离场;
// 导出仅供测试计算延迟窗口等待时长
export const RESTART_DELAY_MS = 2 * 1000
// 升级成功后自动重启的延迟:给 runCheck 与浮条终态一拍时间,观察器轮询可赶上;
// 导出仅供测试计算延迟窗口等待时长
export const AUTO_RESTART_DELAY_MS = 3 * 1000
// 轮询底层计时粒度;导出仅供 parity 测试与 client 提示文案对拍
export const TICK_MS = 60 * 1000
// 轮询间隔上界:超大值会让到期时间戳溢出为 Infinity,轮询静默失效
export const POLL_INTERVAL_MAX_SEC = 30 * 24 * 60 * 60

// 升级尝试次数上限(含首次):npm 文件锁重试收益递减,收敛防长期占锁;导出仅供测试与 parity 对拍
export const UPGRADE_MAX_ATTEMPTS = 3
// 可重试失败的退避序列,按重试序号取值,越界取末位;导出仅供测试与 parity 对拍
export const UPGRADE_RETRY_BACKOFF_MS = Object.freeze({
  [UPGRADE_FAIL_FILE_LOCKED]: Object.freeze([5 * 1000, 15 * 1000]),
  [UPGRADE_FAIL_TRANSIENT_NETWORK]: Object.freeze([3 * 1000, 9 * 1000]),
})

// 退避序列缺失返回 null,由调用方判不可重试:宁可不重试,不可零间隔轰击上游
function upgradeRetryBackoffMs(backoff, kind, retryIndex) {
  const seq = backoff[kind]
  if (!seq || seq.length === 0) return null
  return seq[Math.min(retryIndex, seq.length - 1)]
}

// 日志单行化:拼入 console.warn 的动态串不得携带换行,防日志结构被打散
const singleLine = (text) => String(text ?? '').replace(/[\r\n]+/g, ' ')

// 审计日志:升级/重启的触发、落定、拒绝各一行结构化输出,不引日志框架
const audit = (endpoint, outcome, extra) => {
  console.warn('[dsh-maintain] audit endpoint=' + endpoint + ' outcome=' + outcome + (extra ? ' ' + extra : ''))
}

// 活跃工作检测:agents/jobs/terminals 全软依赖方法面守卫,缺失或异常即降级放行(fail-open,
// 不因安全网缺失死锁重启)。terminals 主路径逐 agent 的 realm 作用域解析(PTY 注册表随
// agent 挂载且 isolate,共享根作用域因 realm 隔离恒缺,仅兜底);sessions 不作活跃指标;
// 禁止顶层 inject(阻塞装载)。导出仅供测试
export function collectActiveWork(ctx) {
  const counts = { agents: 0, jobs: 0, terminals: 0 }
  let detectionAvailable = true
  const degrade = (message) => {
    detectionAvailable = false
    console.warn('[dsh-maintain] 活跃工作检测降级,门控放行: ' + singleLine(message))
  }

  let agentList = []
  try {
    const agents = ctx.get('agents')
    if (!agents || typeof agents.list !== 'function') throw new Error('agents 服务方法面不可用')
    const rows = agents.list()
    agentList = Array.isArray(rows) ? rows : []
    counts.agents = agentList.filter((agent) => agent && agent.status === 'running').length
  } catch (error) {
    degrade(error && error.message ? error.message : String(error))
  }

  try {
    const jobs = ctx.get('jobs')
    if (!jobs || typeof jobs.list !== 'function') throw new Error('jobs 服务方法面不可用')
    const seen = new Set()
    for (const caller of [undefined, ...agentList]) {
      const rows = jobs.list(caller)
      for (const job of Array.isArray(rows) ? rows : []) {
        const key = String(job && job.id)
        if (seen.has(key)) continue
        seen.add(key)
        // stopping 必须计活:kill 置 stopping 后未落定,进程仍在
        if (job && (job.status === 'running' || job.status === 'stopping')) counts.jobs += 1
      }
    }
  } catch (error) {
    degrade(error && error.message ? error.message : String(error))
  }

  try {
    const seen = new Set()
    let sawTerminalsService = false
    const scan = (terminals, owner) => {
      if (!terminals || typeof terminals.list !== 'function') return
      sawTerminalsService = true
      const rows = terminals.list(owner)
      for (const terminal of Array.isArray(rows) ? rows : []) {
        const key = String(terminal && terminal.sessionId)
        if (seen.has(key)) continue
        seen.add(key)
        if (terminal && terminal.status && terminal.status.kind === 'running') counts.terminals += 1
      }
    }
    for (const agent of agentList) {
      try {
        const agentCtx = agent && agent.ctx
        if (agentCtx && typeof agentCtx.get === 'function') scan(agentCtx.get('terminals'), agent)
      } catch (error) {
        degrade('terminals realm 探测异常: ' + (error && error.message ? error.message : String(error)))
      }
    }
    try {
      scan(ctx.get('terminals'), undefined)
    } catch (error) {
      degrade('terminals 根探测异常: ' + (error && error.message ? error.message : String(error)))
    }
    if (!sawTerminalsService) degrade('terminals 服务面不可用')
  } catch (error) {
    degrade('terminals 检测异常: ' + (error && error.message ? error.message : String(error)))
  }

  return {
    agents: counts.agents,
    jobs: counts.jobs,
    terminals: counts.terminals,
    total: counts.agents + counts.jobs + counts.terminals,
    detectionAvailable,
  }
}

const sleepMs = (ms) => new Promise((resolve) => { setTimeout(resolve, ms) })

// 升级尝试循环:单次执行语义与超时不变,失败经分类,可重试类按退避重试,
// 直至成功/不可重试/次数上限;尾流只在落定结果上,attempts 条目只留判定字段。
// runImpl/sleepImpl/backoff 注入仅供测试,默认真实执行器、定时睡眠与导出退避表
export async function runUpgradeWithRetry({ command, timeoutMs = UPGRADE_TIMEOUT_MS, maxAttempts = UPGRADE_MAX_ATTEMPTS, backoff = UPGRADE_RETRY_BACKOFF_MS, runImpl = runUpgrade, sleepImpl = sleepMs, onAttemptStart }) {
  const attempts = []
  for (let index = 0; index < maxAttempts; index += 1) {
    if (index > 0 && typeof onAttemptStart === 'function') onAttemptStart()
    const startedAt = Date.now()
    let result = null
    let thrownMessage = null
    try {
      result = await runImpl({ command, timeoutMs })
    } catch (error) {
      thrownMessage = error && error.message ? error.message : String(error)
    }
    if (thrownMessage !== null) {
      attempts.push({ startedAt, finishedAt: Date.now(), ok: false, code: null, timedOut: false, kind: null })
      return { attempts, ok: false, kind: null, stillRunning: false, stdoutTail: '', stderrTail: '', error: thrownMessage }
    }
    const failure = result.ok ? null : classifyUpgradeFailure(result)
    attempts.push({
      startedAt,
      finishedAt: Date.now(),
      ok: result.ok === true,
      code: typeof result.code === 'number' ? result.code : null,
      timedOut: result.timedOut === true,
      kind: failure === null ? null : failure.kind,
    })
    const settle = { attempts, ok: result.ok === true, kind: failure === null ? null : failure.kind, stillRunning: result.stillRunning === true, stdoutTail: result.stdoutTail ?? '', stderrTail: result.stderrTail ?? '', error: null }
    if (result.ok) return settle
    if (failure.retryable !== true || index >= maxAttempts - 1) return settle
    const backoffMs = upgradeRetryBackoffMs(backoff, failure.kind, index)
    if (backoffMs === null) {
      console.warn('[dsh-maintain] 可重试分类缺少退避序列,按不可重试落定: kind=' + singleLine(failure.kind))
      return settle
    }
    await sleepImpl(backoffMs)
  }
  return { attempts, ok: false, kind: null, stillRunning: false, stdoutTail: '', stderrTail: '', error: null }
}

// 升级后自动重启守卫:四条件缺一不可——成功、非 stale、非手动直跑、appExit 可用。
// 手动直跑(双 TTY)进程退出后无人拉起,只标 requiresManualRestart 交面板指引
export function judgeAutoRestart({ ok, stale, runtimeKind, hasExit }) {
  if (ok !== true) return { schedule: false, requiresManualRestart: false }
  if (stale === true) return { schedule: false, requiresManualRestart: false }
  if (runtimeKind === RUNTIME_KINDS.MANUAL_START) return { schedule: false, requiresManualRestart: true }
  if (hasExit !== true) return { schedule: false, requiresManualRestart: false }
  return { schedule: true, requiresManualRestart: false }
}

// 浏览器半区调用的 API 路径清单:client.js 同名常量与之对拍(parity),防单侧改路径生产 404
export const API_PATHS = Object.freeze({
  STATUS: '/api/maintain/status',
  REFRESH: '/api/maintain/refresh',
  CHANNEL: '/api/maintain/channel',
  UPGRADE_TEMPLATE: '/api/maintain/upgrade-template',
  POLL_INTERVAL: '/api/maintain/poll-interval',
  REGISTRY_BASE: '/api/maintain/registry-base',
  UPGRADE: '/api/maintain/upgrade',
  RESTART: '/api/maintain/restart',
})

// 宿主进程启动时刻:重启探测的第三代际信号(容器内 pid 恒 1 且零失联时 pid 信号失效)
const BOOT_AT = Date.now() - Math.round(process.uptime() * 1000)

// 跨进程升级锁:升级子进程 detached 存活于宿主死后,宿主被外部重启时内存门闩归零
// 会放行第二次升级,与仍在跑的旧包管理器并发写同一全局目录。锁文件随升级结束删除,
// 宿主崩溃残留时按 startedAt 过期(超 UPGRADE_TIMEOUT_MS + 强杀宽限)自动失效
// 升级锁绝对路径:导出仅供测试预热清理(防测试进程中断残留毒化后续运行)
export const UPGRADE_LOCK_PATH = join(tmpdir(), 'dsh-maintain-upgrade.lock')
const UPGRADE_LOCK_STALE_MS = UPGRADE_TIMEOUT_MS + 10 * 1000

function readUpgradeLock() {
  try {
    const raw = JSON.parse(readFileSync(UPGRADE_LOCK_PATH, 'utf8'))
    if (raw && typeof raw.startedAt === 'number') return raw
  } catch { /* 缺失/损坏等同无锁 */ }
  return null
}

function upgradeLockStale(lock) {
  return lock === null || Date.now() - lock.startedAt > UPGRADE_LOCK_STALE_MS
}

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
  // 方法面守卫:settings 服务在但缺 get(宿主升级变更面)时回落默认值
  const value = settings && typeof settings.get === 'function' ? settings.get(NAMESPACE) : undefined
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
    readFileImpl: readFile,
    resolveImpl: undefined,
  })
}

/** @param {import('@deepseek-ai/cordis').Context} ctx */
export function apply(ctx) {
  // 启动器在挂载前提供 appExit(有界退出,5 秒兜底强制);缺失时重启能力关闭
  const exit = ctx.get('appExit')
  if (typeof exit !== 'function') {
    console.warn('[dsh-maintain] 启动器未提供 appExit,就地重启能力关闭(面板按钮禁用)')
  }
  // 幽灵锁检测:宿主外部重启后残留的锁文件若仍在有效期,升级能力保持锁定
  const staleLock = upgradeLockStale(readUpgradeLock()) ? null : readUpgradeLock()
  if (staleLock !== null) {
    console.warn('[dsh-maintain] 检测到未过期的升级锁(可能存在残留升级子进程),升级端点保持拒绝直至锁过期: ' + UPGRADE_LOCK_PATH)
  }

  // 内存快照:仅存当前态,进程重启后从启动检查重新开始(设计约束:不持久化)。
  // installedVersion 为磁盘实时版本(每次检查读取),与运行版本区分
  const snapshot = { installedVersion: null, tags: null, checkedAt: null, error: null }
  // 运行版本:apply 时读一次缓存,即宿主启动时的版本;verdict 以它判定。
  // resolveCurrentHostVersion 约定恒 resolve 不 reject,此处 catch 锁定该约束,
  // 防读盘异常以未处理拒绝形式逃逸
  let runningVersion = null
  const runningVersionReady = resolveCurrentHostVersion()
    .then((version) => { runningVersion = version })
    .catch(() => {})

  // 运行环境:apply 时一次检测;探测异步,以 ready 链收口,异常回退 unknown(维持自动重启)
  let runtimeEnv = { kind: RUNTIME_KINDS.UNKNOWN, declared: false }
  const runtimeEnvReady = detectRuntimeEnv({
    env: process.env,
    platform: process.platform,
    isTTY: { stdin: process.stdin.isTTY === true, stdout: process.stdout.isTTY === true },
  })
    .then((env) => { runtimeEnv = env })
    .catch(() => {})
  let upgrade = { running: false, last: null }
  let checkInFlight = null
  let nextDueAt = null
  let restartScheduled = false
  let autoRestartScheduled = false

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
      snapshot.installedVersion = await resolveCurrentHostVersion()
      snapshot.checkedAt = Date.now()
      return snapshot
    })()
    return checkInFlight.finally(() => {
      checkInFlight = null
    })
  }

  // 排空旧配置的在途检查再重查:runCheck 以 checkInFlight 去重,不排空会把
  // 旧 registryBase 结果当作新配置的检查返回
  async function drainInFlightThenCheck() {
    if (checkInFlight) await checkInFlight
    await runCheck()
  }

  function scheduleNext() {
    const intervalSec = readSettings(ctx).pollIntervalSec
    nextDueAt = intervalSec > 0 && intervalSec <= POLL_INTERVAL_MAX_SEC ? Date.now() + intervalSec * 1000 : null
  }

  // 固定短 tick + 到期判断:间隔设置变更即时生效。timer 软依赖经嵌套 inject 等待:
  // 服务激活才武装轮询,缺失则回调不执行,面板以 pollRunning 提示降级。
  // dispose 显式挂回插件 fiber:timer 服务重启导致嵌套 fiber 重跑时不产生双 interval
  let pollRunning = false
  ctx.inject(['timer'], (timerCtx) => {
    if (typeof timerCtx.interval !== 'function') {
      console.warn('[dsh-maintain] timer 服务方法面不可用,自动轮询停用(面板可手动检查更新)')
      return
    }
    const dispose = timerCtx.interval(() => {
      if (checkInFlight !== null || nextDueAt === null || Date.now() < nextDueAt) return
      runCheck().then(scheduleNext, scheduleNext)
    }, TICK_MS)
    ctx.effect(() => dispose, 'dsh-maintain poll interval')
    pollRunning = true
  })

  function judgeNow() {
    // verdict 以运行版本判定:用户关心"跑的是不是最新";已装版本供升级复读校验
    return judgeVersion({ currentVersion: runningVersion, tags: snapshot.tags, channel: readSettings(ctx).channel })
  }

  async function currentStatus() {
    // 等运行版本首读与运行环境检测落定:apply 即发起,此处仅吸收启动窗口的微小延迟
    await Promise.all([runningVersionReady, runtimeEnvReady])
    const config = readSettings(ctx)
    const judged = judgeNow()
    // running 即视为持锁:省一次盘读,且窗口期语义与 upgrade 路由的门闩一致
    const lock = upgrade.running === true ? { startedAt: Date.now() } : readUpgradeLock()
    return {
      packageName: TARGET_PACKAGE,
      pid: process.pid,
      bootAt: BOOT_AT,
      pollRunning,
      upgradeLockHeld: lock !== null && !upgradeLockStale(lock),
      runningVersion,
      installedVersion: snapshot.installedVersion,
      restartPending: isVersionPendingRestart({ runningVersion, installedVersion: snapshot.installedVersion }),
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
      runtimeEnv,
      autoRestartScheduled,
      activeWork: collectActiveWork(ctx),
      canRestart: typeof exit === 'function',
    }
  }

  function triggerUpgrade() {
    const config = readSettings(ctx)
    // 模板校验同步失败即同步 throw,由调用方 try/catch 转 400,不走异步通道
    const command = buildUpgradeCommand({ template: config.upgradeCommandTemplate, tag: config.channel })
    const last = {
      command,
      startedAt: Date.now(),
      ok: false,
      finishedAt: null,
      timedOut: false,
      stillRunning: false,
      code: null,
      stdoutTail: '',
      stderrTail: '',
      error: null,
      kind: null,
      attempts: [],
      previousVersion: null,
      installedVersion: null,
      stale: null,
      reason: null,
    }
    // running 即串行化门闩:路由检查与本处置位之间无 await,单线程下无竞态窗口
    upgrade = { running: true, last }
    writeUpgradeLock(last.startedAt)
    audit('upgrade', 'triggered', 'command=' + singleLine(command))
    void performUpgrade(command, last, config.channel)
  }

  // 升级锁文件只在此写入:首次与每次重试覆写,startedAt 取当前尝试开始时刻,
  // 过期阈值覆盖单次尝试的完整时长(超时 + 强杀宽限)
  function writeUpgradeLock(startedAt) {
    try {
      writeFileSync(UPGRADE_LOCK_PATH, JSON.stringify({ startedAt, pid: process.pid }), 'utf8')
    } catch { /* 锁不可写仅损失跨进程防护,内存门闩仍生效 */ }
  }

  // 自动重启与手动重启共用 restartScheduled 互斥:调度窗口内到达的升级被 409,
  // 手动重启端点幂等;autoRestartScheduled 单独给 status/client 分流终态文案
  function scheduleAutoRestart() {
    restartScheduled = true
    autoRestartScheduled = true
    audit('restart', 'scheduled', 'reason=upgrade-ok delayMs=' + AUTO_RESTART_DELAY_MS)
    setTimeout(() => exit(0), AUTO_RESTART_DELAY_MS)
  }

  async function performUpgrade(command, last, channel) {
    try {
      // 触发前快照磁盘版本,成功落定后复读对比,版本未前进或未达目标即标 stale
      last.previousVersion = await resolveCurrentHostVersion()
      const settle = await runUpgradeWithRetry({
        command,
        onAttemptStart: () => writeUpgradeLock(Date.now()),
      })
      const final = settle.attempts[settle.attempts.length - 1] ?? null
      Object.assign(last, {
        attempts: settle.attempts,
        ok: settle.ok,
        kind: settle.kind,
        error: settle.error,
        finishedAt: Date.now(),
        timedOut: final !== null ? final.timedOut : false,
        stillRunning: settle.stillRunning,
        code: final !== null ? final.code : null,
        stdoutTail: settle.stdoutTail,
        stderrTail: settle.stderrTail,
      })
      if (settle.ok) {
        last.installedVersion = await resolveCurrentHostVersion()
        const tags = snapshot.tags
        const freshness = judgeUpgradeFreshness({
          previousVersion: last.previousVersion,
          installedVersion: last.installedVersion,
          channelLatest: tags !== null && Object.prototype.hasOwnProperty.call(tags, channel) ? tags[channel] : null,
        })
        last.stale = freshness.stale
        last.reason = freshness.reason
      }
    } catch (error) {
      last.error = error && error.message ? error.message : String(error)
    } finally {
      if (last.finishedAt === null) last.finishedAt = Date.now()
      upgrade = { running: false, last }
      // stillRunning(强杀后进程树疑似仍在写全局目录)时保留锁文件,由过期机制收敛,
      // 与"宿主死后幽灵锁"防线对称;正常落定即删
      if (last.stillRunning === true) {
        console.warn('[dsh-maintain] 升级超时强杀且进程疑似仍存活,升级锁保留至过期: ' + UPGRADE_LOCK_PATH)
      } else {
        try {
          rmSync(UPGRADE_LOCK_PATH, { force: true })
        } catch (lockError) {
          console.warn('[dsh-maintain] 升级锁删除失败(将由过期机制收敛): ' + (lockError?.message ?? lockError))
        }
      }
      console.warn('[dsh-maintain] 升级结束: ok=' + last.ok + ' kind=' + singleLine(last.kind)
        + (last.code !== null ? ' 退出码=' + last.code : '')
        + (last.error ? ' ' + singleLine(last.error) : '')
        + (last.stale === true ? ' stale=' + singleLine(last.reason) : ''))
      audit('upgrade', last.ok === true ? 'ok' : 'failed',
        'durationMs=' + (last.finishedAt - last.startedAt) + ' code=' + last.code + ' kind=' + singleLine(last.kind))
      // 自动重启守卫:等环境检测落定后按四条件分流(手动直跑只标指引,不退出)
      await runtimeEnvReady
      const decision = judgeAutoRestart({ ok: last.ok === true, stale: last.stale === true, runtimeKind: runtimeEnv.kind, hasExit: typeof exit === 'function' })
      if (decision.requiresManualRestart === true) last.requiresManualRestart = true
      if (decision.schedule === true) {
        // last 镜像调度标记:浮条终态文案按其分流(与 status.autoRestartScheduled 同值)
        last.autoRestartScheduled = true
        scheduleAutoRestart()
      }
      // 升级结束后自动重新检查版本并重排轮询(命令可能改了本地版本)
      runCheck().then(scheduleNext, scheduleNext)
    }
  }

  const WRITE = { crossOrigin: true }

  const routes = [
    {
      path: API_PATHS.STATUS,
      handler: route('GET', {}, async (req, res) => {
        sendJson(res, 200, await currentStatus())
      }),
    },
    {
      path: API_PATHS.REFRESH,
      handler: route('POST', WRITE, async (req, res) => {
        await drainInFlightThenCheck()
        scheduleNext()
        sendJson(res, 200, await currentStatus())
      }),
    },
    {
      path: API_PATHS.CHANNEL,
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
        // 切通道无需重查:dist-tags 与 channel 无关,白名单已用现有 snapshot 校验
        scheduleNext()
        sendJson(res, 200, await currentStatus())
      }),
    },
    {
      path: API_PATHS.UPGRADE_TEMPLATE,
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
        sendJson(res, 200, await currentStatus())
      }),
    },
    {
      path: API_PATHS.POLL_INTERVAL,
      handler: route('POST', WRITE, async (req, res) => {
        const body = JSON.parse(await readBody(req))
        // 严格类型:字符串/ null 等经 Number() 宽转后可能变 0,静默翻转轮询开关
        const seconds = body && typeof body.seconds === 'number' ? body.seconds : NaN
        if (!Number.isFinite(seconds) || seconds < 0) {
          sendJson(res, 400, { error: '轮询间隔必须是不小于 0 的秒数' })
          return
        }
        // 上界防溢出:超过 30 天的间隔无运维意义,且秒转毫秒会溢出令轮询静默失效
        if (seconds > POLL_INTERVAL_MAX_SEC) {
          sendJson(res, 400, { error: '轮询间隔不能超过 ' + POLL_INTERVAL_MAX_SEC + ' 秒' })
          return
        }
        const settings = ctx.get('settings')
        if (!settings) {
          sendJson(res, 500, { error: 'settings 服务不可用' })
          return
        }
        await settings.update(NAMESPACE, { pollIntervalSec: seconds })
        scheduleNext()
        sendJson(res, 200, await currentStatus())
      }),
    },
    {
      path: API_PATHS.REGISTRY_BASE,
      handler: route('POST', WRITE, async (req, res) => {
        const body = JSON.parse(await readBody(req))
        const base = body && typeof body.base === 'string' ? body.base.trim() : ''
        if (!isValidRegistryBase(base)) {
          sendJson(res, 400, { error: 'registry 基地址须为 http(s) 地址且不带查询串或锚点' })
          return
        }
        const settings = ctx.get('settings')
        if (!settings) {
          sendJson(res, 500, { error: 'settings 服务不可用' })
          return
        }
        await settings.update(NAMESPACE, { registryBase: base })
        await drainInFlightThenCheck()
        scheduleNext()
        sendJson(res, 200, await currentStatus())
      }),
    },
    {
      path: API_PATHS.UPGRADE,
      handler: route('POST', WRITE, async (req, res) => {
        // 与重启调度双向互斥:restartScheduled 置位到 exit(0) 执行的窗口内触发升级,
        // detached 孤儿会与新宿主交错
        if (upgrade.running || restartScheduled) {
          audit('upgrade', 'rejected', restartScheduled ? 'reason=restart-scheduled' : 'reason=running')
          sendJson(res, 409, { error: restartScheduled ? '重启已调度,禁止触发升级' : '升级进行中' })
          return
        }
        if (upgradeLockStale(readUpgradeLock()) === false) {
          audit('upgrade', 'rejected', 'reason=lock')
          sendJson(res, 409, { error: '存在未过期的升级锁(可能有残留升级子进程),等待锁过期或删除 ' + UPGRADE_LOCK_PATH })
          return
        }
        // 防降级:运行版本已达通道最新时拒绝(重装旧版即降级,对齐 no-newer-version);
        // 信息不足(verdict unknown)放行,宽松不误拒
        const judged = judgeNow()
        if (judged.verdict === VERDICT_UP_TO_DATE) {
          audit('upgrade', 'rejected', 'reason=up-to-date')
          sendJson(res, 409, { error: '当前已是通道最新版,无需升级;重装请走命令行' })
          return
        }
        // 活跃工作门控:升级不可越(agent 会话/job 在跑时强行升级会被中断)
        const activeWork = collectActiveWork(ctx)
        if (activeWork.total > 0) {
          audit('upgrade', 'rejected', 'reason=active-work total=' + activeWork.total)
          sendJson(res, 409, {
            error: '存在活跃工作(共 ' + activeWork.total + ' 项:agents ' + activeWork.agents + '/jobs ' + activeWork.jobs + '/terminals ' + activeWork.terminals + '),升级会中断它们,请等待完成',
            items: activeWork,
            detectionAvailable: activeWork.detectionAvailable,
          })
          return
        }
        triggerUpgrade()
        sendJson(res, 200, await currentStatus())
      }),
    },
    {
      path: API_PATHS.RESTART,
      handler: route('POST', WRITE, async (req, res) => {
        // 与升级门闩互斥:升级子进程经 detached+unref 存活于宿主死后,
        // 重启后新宿主门闩归零会放行第二次升级,双 npm install 并发写全局目录
        if (upgrade.running) {
          audit('restart', 'rejected', 'reason=upgrade-running')
          sendJson(res, 409, { error: '升级进行中,禁止重启;等待升级完成后重试' })
          return
        }
        if (typeof exit !== 'function') {
          audit('restart', 'rejected', 'reason=no-appExit')
          sendJson(res, 500, { error: '启动器未提供 appExit,无法重启' })
          return
        }
        if (restartScheduled) {
          sendJson(res, 200, { ok: true, restarting: true })
          return
        }
        // 活跃工作门控:重启可被 force 越过(升级后自动重启链路无法等待人工确认,
        // 对齐 dsh-service:升级不可越/重启 force 可越)
        const rawBody = await readBody(req)
        const requestBody = rawBody ? JSON.parse(rawBody) : {}
        const activeWork = collectActiveWork(ctx)
        if (activeWork.total > 0 && requestBody.force !== true) {
          audit('restart', 'rejected', 'reason=active-work total=' + activeWork.total)
          sendJson(res, 409, {
            error: '存在活跃工作(共 ' + activeWork.total + ' 项:agents ' + activeWork.agents + '/jobs ' + activeWork.jobs + '/terminals ' + activeWork.terminals + '),重启会中断它们;确认无误请带 force 重试',
            items: activeWork,
            detectionAvailable: activeWork.detectionAvailable,
          })
          return
        }
        restartScheduled = true
        audit('restart', 'triggered', requestBody.force === true ? 'forced=true' : 'forced=false')
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
    // 方法面防御对齐 timer 软依赖:宿主升级变更 settings 服务方法面时干净降级并留痕,
    // 不让 fiber 激活即抛错拖垮启动检查与全部写路由
    if (!settingsCtx.settings || typeof settingsCtx.settings.register !== 'function' || typeof settingsCtx.settings.update !== 'function') {
      console.warn('[dsh-maintain] settings 服务方法面不可用,版本检查停用,通道/设置保存不可用')
      return
    }
    settingsCtx.settings.register(NAMESPACE, SETTINGS_SCHEMA)
    // 启动检查放在 settings 注册之后:命名空间未注册时 readSettings 只能拿默认值,
    // 配置了镜像地址的部署会确定性检查失败
    runCheck().then(scheduleNext, scheduleNext)
  })
}
