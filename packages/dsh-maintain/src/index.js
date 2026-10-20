// dsh-maintain Host 半区:版本监测 + 一键升级 + 安全重启。
// 双端模式照 dsh-usage-panel:webServer 具名路由供浏览器半区调用;
// 配置持久化双形态:legacy 走 settings 命名空间 maintain,0.1.7+ 走 profile
// 条目 config 节(Config 导出 + volatile 热更),检查结果仅存内存。

import { readFileSync, realpathSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import z from '@deepseek-ai/schemastery'

import {
  TARGET_PACKAGE,
  fetchDistTags,
  fetchReleaseNotes,
  isValidChannelName,
  isValidRegistryBase,
  isVersionPendingRestart,
  judgeVersion,
  parseSemver,
  resolveHostVersion,
} from './core.mjs'
import { createLayout } from './managed-layout.mjs'
import { performManagedUpgrade, validateCandidate } from './managed-upgrade.mjs'

export const name = 'dsh-maintain'

// timer 为软依赖:不进 inject 声明,服务缺失时仅停用自动轮询(状态接口提示),
// 插件其余能力(状态面板 / 手动检查 / 升级)不受影响,也不因等待服务而阻塞装载
export const inject = ['webServer']

const NAMESPACE = 'maintain'

const CHECK_TIMEOUT_MS = 20 * 1000
// 版本更新内容缓存上限:长期运行中通道切换持续产生新键,无上限则缓存无界;
// 超限删最旧(Map 迭代序即插入序,命中不重插);导出仅供测试
export const RELEASE_NOTES_CACHE_MAX = 20
// 响应发出到执行退出的延迟:保证浏览器收到 200 并进入重启等待态,进程才离场;
// 导出仅供测试计算延迟窗口等待时长
export const RESTART_DELAY_MS = 2 * 1000
// 轮询底层计时粒度;导出仅供 parity 测试与 client 提示文案对拍
export const TICK_MS = 60 * 1000
// 轮询间隔上界:超大值会让到期时间戳溢出为 Infinity,轮询静默失效
export const POLL_INTERVAL_MAX_SEC = 30 * 24 * 60 * 60

// 日志单行化:拼入 console.warn 的动态串不得携带换行,防日志结构被打散
const singleLine = (text) => String(text ?? '').replace(/[\r\n]+/g, ' ')

// 受管升级只接受精确版本:范围/标签/空串一律拒绝,通道目标经 dist-tags 解析为精确值
const parseSemverStrict = (version) => (typeof version === 'string' ? parseSemver(version.trim()) : null) !== null

// 审计日志:升级/重启的触发、落定、拒绝各一行结构化输出,不引日志框架
const audit = (endpoint, outcome, extra) => {
  console.warn('[dsh-maintain] audit endpoint=' + endpoint + ' outcome=' + outcome + (extra ? ' ' + extra : ''))
}

// 活跃工作检测:agents/jobs/terminals 全软依赖方法面守卫,缺失或异常即降级——重启门控
// fail-open(不因安全网缺失死锁重启),升级门控 fail-closed(检测面缺失拒绝升级)。
// 0.2.0 实测:terminals 服务对插件 ctx 根与 agent realm 均不可探,面不可见属宿主常态
// 不计降级,终端归属 agent、agents 计数覆盖 running 期间终端活动;agent 转 idle 后
// 存活终端不可计数,属已知盲区(宿主能力边界,非本插件可修);sessions 不作活跃指标;
// 禁止顶层 inject(阻塞装载)。导出仅供测试
// 降级留痕按服务键进程首见一次:status 每拍重检,不限频会刷屏
const degradedWarned = new Set()

export function collectActiveWork(ctx) {
  const counts = { agents: 0, jobs: 0, terminals: 0 }
  let detectionAvailable = true
  const degraded = {}
  const degrade = (key, detail) => {
    detectionAvailable = false
    // 明细恒收集(409/status 透出供定位),控制台留痕按服务键进程首见一次防刷屏
    degraded[key] = singleLine(detail)
    if (degradedWarned.has(key)) return
    degradedWarned.add(key)
    console.warn('[dsh-maintain] 活跃工作检测降级,升级门拒绝/重启门放行(' + key + '): ' + degraded[key])
  }

  let agentList = []
  try {
    const agents = ctx.get('agents')
    if (!agents || typeof agents.list !== 'function') throw new Error('agents 服务方法面不可用')
    const rows = agents.list()
    agentList = Array.isArray(rows) ? rows : []
    counts.agents = agentList.filter((agent) => agent && agent.status === 'running').length
  } catch (error) {
    degrade('agents', error && error.message ? error.message : String(error))
  }

  try {
    const jobs = ctx.get('jobs')
    if (!jobs || typeof jobs.list !== 'function') throw new Error('jobs 服务方法面不可用')
    const seen = new Set()
    for (const caller of [undefined, ...agentList.map(agent => agent && agent.id).filter(id => typeof id === 'string')]) {
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
    degrade('jobs', error && error.message ? error.message : String(error))
  }

  try {
    const seen = new Set()
    const scan = (terminals, owner) => {
      if (!terminals) return
      if (owner && typeof terminals.hasOwnerActivity === 'function' && terminals.hasOwnerActivity(owner)) {
        const key = 'pending:' + String(owner.id)
        if (!seen.has(key)) { seen.add(key); counts.terminals += 1 }
      }
      if (typeof terminals.list !== 'function') {
        if (!owner || typeof terminals.hasOwnerActivity !== 'function') throw new Error('terminals 服务方法面不可用')
        return
      }
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
        degrade('terminals', 'realm 探测异常: ' + (error && error.message ? error.message : String(error)))
      }
    }
    try {
      scan(ctx.get('terminals'), undefined)
    } catch (error) {
      degrade('terminals', '根探测异常: ' + (error && error.message ? error.message : String(error)))
    }
    // 0.2.0 实测:terminals 服务对插件 ctx 根与 agent realm 均不可探,面不可见属宿主常态
    // 不计降级;agents 计数覆盖 running 期间的终端活动,agent 转 idle 后存活终端属已知盲区;
    // 服务面可见时(测试桩/未来宿主)照常计数
  } catch (error) {
    degrade('terminals', error && error.message ? error.message : String(error))
  }

  return {
    agents: counts.agents,
    jobs: counts.jobs,
    terminals: counts.terminals,
    total: counts.agents + counts.jobs + counts.terminals,
    detectionAvailable,
    // 仅降级时非空:键为服务名,值为失败明细,随 status 与 409 透出供定位
    degraded,
  }
}

// 浏览器半区调用的 API 路径清单:client.js 同名常量与之对拍(parity),防单侧改路径生产 404
export const API_PATHS = Object.freeze({
  STATUS: '/api/maintain/status',
  REFRESH: '/api/maintain/refresh',
  CHANNEL: '/api/maintain/channel',
  POLL_INTERVAL: '/api/maintain/poll-interval',
  REGISTRY_BASE: '/api/maintain/registry-base',
  UPGRADE: '/api/maintain/upgrade',
  RESTART: '/api/maintain/restart',
  RELEASE_NOTES: '/api/maintain/release-notes',
})

// 宿主进程启动时刻:重启探测的第三代际信号(容器内 pid 恒 1 且零失联时 pid 信号失效)
const BOOT_AT = Date.now() - Math.round(process.uptime() * 1000)

// 默认值导出仅供 parity 测试作 host 侧锚点;行为入口全部经 readSettings 回落
export const DEFAULT_CHANNEL = 'latest'
export const DEFAULT_POLL_INTERVAL_SEC = 6 * 60 * 60
export const DEFAULT_REGISTRY_BASE = 'https://registry.npmjs.org'

// 注册即声明 GUI 设置表单,schema 默认值即生效默认值(rs-workflow-config 先例)。
// 0.1.7 宿主以静态 Config 导出生成节表单;legacy 宿主经 settings.register 注册同名命名空间。
// volatile 根包装(照 dsh-llm-pi-gateway volatileWrap 同构):0.1.7 下整节为 live 表单,
// 节写经 loader volatile 快速道原地热更;旧宿主 schemastery 无 volatile 方法,特性检测原样返回
export const Config = volatileWrap(z.object({
  channel: z.string().default(DEFAULT_CHANNEL).description('追踪通道:npm dist-tag 名(latest/next/alpha 等,以检查返回的通道列表为准)'),
  pollIntervalSec: z.number().default(DEFAULT_POLL_INTERVAL_SEC).description('轮询间隔秒数,仅正数启用周期检查'),
  registryBase: z.string().default(DEFAULT_REGISTRY_BASE).description('npm registry 基地址,官方源不可达时改为镜像地址'),
}))

function volatileWrap(schema) {
  return typeof schema.volatile === 'function' ? schema.volatile() : schema
}

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

// volatile ref 动态解包(get 协议,官方 plainOptions 同构);legacy 宿主 config 为普通对象原样透传。
// Config 为根级 volatile 包装,解析产物是整节单 ref,解包一次即得字段明值
function unwrapVolatile(value) {
  return typeof value?.get === 'function' ? value.get() : value
}

function readSettings(ctx, config) {
  const settings = ctx.get('settings')
  // 双形态读(照 dsh-llm-pi-gateway,特性检测不硬编码版本):
  // legacy:settings 命名空间 get;0.1.7+:apply 入参 config 整节解包
  const value = typeof settings?.get === 'function' ? settings.get(NAMESPACE) : unwrapVolatile(config)
  return {
    channel: value && typeof value.channel === 'string' && value.channel.trim().length > 0 ? value.channel.trim() : DEFAULT_CHANNEL,
    pollIntervalSec:
      value && typeof value.pollIntervalSec === 'number' && Number.isFinite(value.pollIntervalSec)
        ? value.pollIntervalSec
        : DEFAULT_POLL_INTERVAL_SEC,
    registryBase:
      value && typeof value.registryBase === 'string' && value.registryBase.trim().length > 0
        ? value.registryBase.trim()
        : DEFAULT_REGISTRY_BASE,
  }
}

const samePath = (a, b, platform = process.platform) => platform === 'win32'
  ? resolve(a).toLowerCase() === resolve(b).toLowerCase()
  : resolve(a) === resolve(b)

export function discoverRunningInstall({ argv1 = process.argv[1], installAnchor, platform = process.platform } = {}) {
  try {
    const entry = realpathSync(argv1)
    const argvPackage = dirname(dirname(entry))
    const runtimePackage = installAnchor ? dirname(realpathSync(installAnchor)) : argvPackage
    if (installAnchor && !samePath(runtimePackage, argvPackage)) throw new Error('运行入口与宿主安装锚点不一致')
    const manifest = JSON.parse(readFileSync(join(runtimePackage, 'package.json'), 'utf8'))
    if (manifest.name !== TARGET_PACKAGE) throw new Error('运行入口不是 ' + TARGET_PACKAGE + ': ' + manifest.name)
    const segments = manifest.name.split('/')
    let dir = runtimePackage
    let managedBase = null
    for (let depth = 0; depth < segments.length + 4; depth += 1) {
      if (dir === dirname(dir)) break
      dir = dirname(dir)
      if (basename(dir) === '.dsh-maintain') { managedBase = dir; break }
    }
    if (managedBase !== null) {
      const prefix = dirname(managedBase)
      const originalPackage = platform === 'win32'
        ? join(prefix, 'node_modules', ...segments)
        : join(prefix, 'lib', 'node_modules', ...segments)
      const originalManifest = JSON.parse(readFileSync(join(originalPackage, 'package.json'), 'utf8'))
      if (originalManifest.name !== TARGET_PACKAGE) throw new Error('原包清单异常: ' + originalPackage)
      return { prefix, originalPackage, runningPackage: runtimePackage, runningVersion: manifest.version, error: null }
    }
    let prefix = runtimePackage
    const climbs = segments.length + (platform === 'win32' ? 1 : 2)
    for (let depth = 0; depth < climbs; depth += 1) prefix = dirname(prefix)
    return { prefix, originalPackage: runtimePackage, runningPackage: runtimePackage, runningVersion: manifest.version, error: null }
  } catch (error) {
    return { prefix: null, originalPackage: null, runningPackage: null, runningVersion: null, error: error && error.message ? error.message : String(error) }
  }
}

/** @param {import('@deepseek-ai/cordis').Context} ctx */
export function apply(ctx, config, dependencies = {}) {
  const maintenance = { active: false }
  const hooks = ctx.get('hooks')
  hooks?.on?.('agent/pre-step', ({ signal }, next) => {
    if (maintenance.active && !signal.aborted) return Promise.resolve({ kind: 'reject' })
    return next()
  })
  const legacySettingsFace = () => {
    const settings = ctx.get('settings')
    return typeof settings?.register === 'function' && typeof settings?.update === 'function'
  }
  // 写路径分发。0.1.7:configEditor.edit 的 change 回调返回完整 raw config,
  // 仅 volatile 字段变化时 loader 原地热更不重启插件,apply 无需重入。
  // 服务面缺失发 500 后返回 false,业务异常抛出由路由统一归一 400
  async function persistPatch(res, patch) {
    if (legacySettingsFace()) {
      await ctx.get('settings').update(NAMESPACE, patch)
      return true
    }
    const editor = ctx.get('configEditor')
    const entry = ctx.fiber?.entry
    if (!editor || typeof editor.edit !== 'function' || !entry) {
      sendJson(res, 500, { error: 'configEditor 服务不可用' })
      return false
    }
    await editor.edit(entry, (current) => ({ ...current, ...patch }))
    return true
  }
  // 启动器在挂载前提供 appExit(有界退出,5 秒兜底强制);缺失时重启能力关闭,
  // 受管升级切换成功必须正常退出交第三方拉起,无 appExit 时升级在切换前拒绝
  const exit = ctx.get('appExit')
  if (typeof exit !== 'function') {
    console.warn('[dsh-maintain] 启动器未提供 appExit,就地重启与受管升级切换能力关闭(面板按钮禁用)')
  }

  // 运行版本探测:服务面可注入受控实现(测试面),缺省走真实盘读;
  // 约定恒 resolve 不 reject,真实实现全失败回 null,注入侧经 then 同步抛错同折进 rejection
  function resolveCurrentHostVersion() {
    try {
      const probe = ctx.get('hostVersionProbe')
      if (typeof probe === 'function') return Promise.resolve().then(probe)
      const runtimeManifest = ctx.profileContext?.installAnchor
        ? realpathSync(ctx.profileContext.installAnchor)
        : join(dirname(dirname(realpathSync(process.argv[1]))), 'package.json')
      const manifest = JSON.parse(readFileSync(runtimeManifest, 'utf8'))
      if (manifest.name !== TARGET_PACKAGE || typeof manifest.version !== 'string') throw new Error('运行宿主清单无效')
      return Promise.resolve(manifest.version)
    } catch {
      return Promise.resolve(null)
    }
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
  let upgrade = { running: false, last: null }
  let checkInFlight = null
  let nextDueAt = null
  let restartScheduled = false
  // 受管安装发现:apply 时刻缓存(链接切换后不再重新 realpath 推断运行版)。
  // 发现失败不阻塞面板,仅升级入口拒绝并带原因
  const installAnchor = ctx.profileContext?.installAnchor
  const managedInstall = dependencies.runningInstall !== undefined
    ? dependencies.runningInstall
    : discoverRunningInstall({ installAnchor })
  // 版本更新内容缓存:键为通道最新版原始值(未归一),值为 {url,publishedAt,body};仅成功结果入缓存
  const releaseNotesCache = new Map()

  function runCheck() {
    if (checkInFlight) return checkInFlight
    checkInFlight = (async () => {
      const cfg = readSettings(ctx, config)
      try {
        snapshot.tags = await fetchDistTags({ registryBase: cfg.registryBase, timeoutMs: CHECK_TIMEOUT_MS })
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
    const intervalSec = readSettings(ctx, config).pollIntervalSec
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
      // restartScheduled 窗口内不再发起检查:关机延迟期间的网络请求与磁盘读取都是半写状态风险
      if (restartScheduled || checkInFlight !== null || nextDueAt === null || Date.now() < nextDueAt) return
      runCheck().then(scheduleNext, scheduleNext)
    }, TICK_MS)
    ctx.effect(() => dispose, 'dsh-maintain poll interval')
    pollRunning = true
  })

  function judgeNow() {
    // verdict 以运行版本判定:用户关心"跑的是不是最新";已装版本供升级复读校验
    return judgeVersion({ currentVersion: runningVersion, tags: snapshot.tags, channel: readSettings(ctx, config).channel })
  }

  async function currentStatus() {
    // 等运行版本首读落定:apply 即发起,此处仅吸收启动窗口的微小延迟
    await runningVersionReady
    const cfg = readSettings(ctx, config)
    const judged = judgeNow()
    return {
      packageName: TARGET_PACKAGE,
      pid: process.pid,
      bootAt: BOOT_AT,
      pollRunning,
      runningVersion,
      runningSource: managedInstall.error === null ? 'managed-layout' : 'unknown',
      managedReady: managedInstall.error === null,
      managedError: managedInstall.error,
      installedVersion: snapshot.installedVersion,
      restartPending: isVersionPendingRestart({ runningVersion, installedVersion: snapshot.installedVersion }),
      channel: cfg.channel,
      pollIntervalSec: cfg.pollIntervalSec,
      registryBase: cfg.registryBase,
      tags: snapshot.tags,
      channelLatest: judged.channelLatest,
      verdict: judged.verdict,
      reason: judged.reason,
      checkedAt: snapshot.checkedAt,
      checkError: snapshot.error,
      upgrade,
      activeWork: collectActiveWork(ctx),
      canRestart: typeof exit === 'function',
    }
  }

  async function defaultBeforeSwitch() {
    const activeWork = collectActiveWork(ctx)
    if (activeWork.detectionAvailable !== true || activeWork.total > 0) {
      throw new Error('提交窗口检测到活跃工作或检测不可用(detectionAvailable=' + activeWork.detectionAvailable + ' total=' + activeWork.total + ')')
    }
  }


  // 受管升级执行器:注入优先,缺省真实编排器。测试注入 deferred runner,
  // 禁止回落真实 npm;切换成功即正常退出,由第三方启动方式再次拉起
  const runManagedUpgrade = typeof dependencies.runManagedUpgrade === 'function'
    ? dependencies.runManagedUpgrade
    : performManagedUpgrade
  const buildLayout = typeof dependencies.createLayout === 'function'
    ? dependencies.createLayout
    : createLayout

  // 宿主退出调度唯一入口:手动重启(HTTP 入口)与升级落定(内部入口)共用,
  // 置双向互斥标记、留审计、延迟 exit(0)。调度窗口内升级被 409,手动重启幂等
  function scheduleHostExit({ detail, delayMs }) {
    restartScheduled = true
    maintenance.active = true
    audit('restart', 'triggered', detail + ' delayMs=' + delayMs)
    // 退出延迟与响应冲刷解耦:客户端在冲刷完成前断连会让 end 回调失效,绑定其上会使重启悬空;
    // 同步发出响应后延迟退出,延迟本身保证回执先于进程离场送达
    setTimeout(() => exit(0), delayMs)
  }

  // 受管升级全流程:布局发现→编排(安装/验证/切换,锁与阶段持久化在编排器内)
  // →成功后按单次 autoRestart 意图收尾。任何阶段失败保留原版本服务,
  // 锁与阶段状态由编排器落盘;切换状态未知时无视意图强制退出
  async function performManagedUpgradeFlow({ targetVersion, registryBase, autoRestart }) {
    const last = {
      operationId: null,
      targetVersion,
      startedAt: Date.now(),
      finishedAt: null,
      ok: false,
      switched: false,
      phase: null,
      slot: null,
      error: null,
      exitScheduled: false,
    }
    upgrade = { running: true, last }
    audit('upgrade', 'triggered', 'targetVersion=' + targetVersion)
    try {
      const layout = await buildLayout({
        prefix: managedInstall.prefix,
        originalPackage: managedInstall.originalPackage,
      })
      last.operationId = null
      maintenance.active = true
      await defaultBeforeSwitch()
      const result = await runManagedUpgrade({
        layout,
        runningPackage: managedInstall.runningPackage ?? managedInstall.originalPackage,
        targetVersion,
        registryBase,
        validate: validateCandidate,
        beforeSwitch: defaultBeforeSwitch,
        onPhase: (state) => {
          last.phase = state.phase
          last.slot = state.slot ?? null
          last.operationId = state.operationId ?? last.operationId
        },
      })
      Object.assign(last, {
        ok: true,
        switched: result.switched === true,
        phase: result.phase,
        slot: result.slot ?? null,
        operationId: result.operationId ?? last.operationId,
        finishedAt: Date.now(),
      })
      audit('upgrade', 'ok', 'operationId=' + last.operationId + ' slot=' + last.slot + ' phase=' + last.phase)
      // 切换成功按单次 autoRestart 意图收尾:开=调度正常退出交托管方式拉起;
      // 关=保留旧宿主继续跑,等待手动重启(重启按钮同链路),期间下一轮升级被运行路径不一致拒绝
      if (autoRestart === false) {
        last.exitScheduled = false
        audit('upgrade', 'switched-manual-restart', 'operationId=' + last.operationId + ' 自动重启已关闭,等待手动重启')
      } else if (typeof exit === 'function') {
        last.exitScheduled = true
        scheduleHostExit({ detail: 'reason=managed-upgrade-switched operationId=' + last.operationId, delayMs: RESTART_DELAY_MS })
      } else {
        last.error = '启动器未提供 appExit,已切换但无法退出;请手动重启'
        audit('upgrade', 'exit-missing', 'operationId=' + last.operationId)
      }
    } catch (error) {
      last.ok = false
      last.finishedAt = Date.now()
      last.error = error && error.message ? error.message : String(error)
      last.switched = error.switched === true
      last.phase = last.phase ?? 'failed'
      if (error.switched === true || error.indeterminate === true) {
        last.switched = true
        last.phase = 'indeterminate'
        last.exitScheduled = true
        scheduleHostExit({ detail: 'reason=post-switch-state-indeterminate operationId=' + (last.operationId ?? 'unknown'), delayMs: RESTART_DELAY_MS })
      } else {
        maintenance.active = false
      }
      console.warn('[dsh-maintain] 受管升级失败: ' + singleLine(last.error))
      audit('upgrade', 'failed', 'phase=' + last.phase + ' error=' + singleLine(last.error))
    } finally {
      upgrade = { running: false, last }
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
        if (restartScheduled) {
          sendJson(res, 409, { error: '重启已调度,禁止检查更新' })
          return
        }
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
        if (!(await persistPatch(res, { channel }))) return
        // 切通道无需重查:dist-tags 与 channel 无关,白名单已用现有 snapshot 校验
        scheduleNext()
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
        if (!(await persistPatch(res, { pollIntervalSec: seconds }))) return
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
        if (!(await persistPatch(res, { registryBase: base }))) return
        if (restartScheduled) {
          // 保存生效但不发起检查:关机窗口内网络请求与磁盘读取都是半写状态风险
          sendJson(res, 200, await currentStatus())
          return
        }
        await drainInFlightThenCheck()
        scheduleNext()
        sendJson(res, 200, await currentStatus())
      }),
    },
    {
      path: API_PATHS.UPGRADE,
      handler: route('POST', WRITE, async (req, res) => {
        // body 校验必须在全部门控之前:门控到编排器置位之间不得插入 await,
        // 否则并发请求双双通过 409 门控(锁文件是第二道防线,但内存门闩先拒绝)
        // 目标版本可选:缺省按追踪通道 dist-tag 解析为精确版本;显式传入也必须精确
        const rawBody = await readBody(req)
        const requestBody = rawBody ? (JSON.parse(rawBody) || {}) : {}
        let targetVersion = requestBody.targetVersion
        if (targetVersion === undefined) {
          const cfgChannel = readSettings(ctx, config).channel
          const tags = snapshot.tags
          if (!tags || typeof tags[cfgChannel] !== 'string' || !parseSemverStrict(tags[cfgChannel])) {
            sendJson(res, 400, { error: '通道 ' + cfgChannel + ' 最新版本未知或不精确,请先检查更新' })
            return
          }
          targetVersion = tags[cfgChannel]
        }
        if (!parseSemverStrict(targetVersion)) {
          sendJson(res, 400, { error: 'targetVersion 必须是精确 semver 版本: ' + targetVersion })
          return
        }
        // 单次意图:本次升级是否自动调度退出,缺省开;非布尔非缺省即 400(宽转会静默翻转收尾语义)
        const autoRestart = requestBody.autoRestart === undefined ? true : requestBody.autoRestart
        if (typeof autoRestart !== 'boolean') {
          sendJson(res, 400, { error: 'autoRestart 必须是布尔值或缺省' })
          return
        }
        // 与重启调度双向互斥:restartScheduled 置位到 exit(0) 执行的窗口内触发升级,
        // 切换后的退出会与新宿主交错
        if (upgrade.running || restartScheduled) {
          audit('upgrade', 'rejected', restartScheduled ? 'reason=restart-scheduled' : 'reason=running')
          sendJson(res, 409, { error: restartScheduled ? '重启已调度,禁止触发升级' : '升级进行中' })
          return
        }
        if (managedInstall.error !== null) {
          audit('upgrade', 'rejected', 'reason=managed-unavailable')
          sendJson(res, 409, { error: '受管安装不可用: ' + managedInstall.error })
          return
        }
        if (typeof exit !== 'function') {
          audit('upgrade', 'rejected', 'reason=no-appExit')
          sendJson(res, 409, { error: '启动器未提供 appExit,切换后无法退出,升级被拒绝' })
          return
        }
        // 活跃工作门控(fail-closed):检测面缺失即拒绝,不以放行冒充弱一致窗口;
        // 切换前编排器 beforeSwitch 还会做最终核验
        const activeWork = collectActiveWork(ctx)
        if (activeWork.detectionAvailable !== true || activeWork.total > 0) {
          // 降级明细随 409 透出:检测面缺失时"哪个面、什么原因"是定位的必要信息
          const degradedSummary = Object.entries(activeWork.degraded).map(([key, detail]) => key + '(' + detail + ')').join('; ')
          audit('upgrade', 'rejected', 'reason=active-work total=' + activeWork.total + ' detectionAvailable=' + activeWork.detectionAvailable + (degradedSummary ? ' degraded=' + degradedSummary : ''))
          sendJson(res, 409, {
            error: activeWork.detectionAvailable !== true
              ? '活跃工作检测不可用,为避免中断任务已拒绝升级;降级面: ' + degradedSummary
              : '存在活跃工作(共 ' + activeWork.total + ' 项:agents ' + activeWork.agents + '/jobs ' + activeWork.jobs + '/terminals ' + activeWork.terminals + '),升级切换会中断它们,请等待完成',
            items: activeWork,
            detectionAvailable: activeWork.detectionAvailable,
          })
          return
        }
        // 编排先入内存门闩再取快照:响应快照必须呈现 running=true,并发请求才能被 409 挡住
        const flow = performManagedUpgradeFlow({ targetVersion, registryBase: readSettings(ctx, config).registryBase, autoRestart })
        sendJson(res, 200, { ok: true, targetVersion, status: await currentStatus() })
        void flow
      }),
    },
    {
      path: API_PATHS.RESTART,
      handler: route('POST', WRITE, async (req, res) => {
        // body 读取必须在全部门控之前:幂等检查到 scheduleHostExit 置位之间不得插入
        // await,否则并发请求双双越过幂等门,双重调度 exit
        const rawBody = await readBody(req)
        // 'null' 字面量解析为 null:按空体处理,防 null.force 形态的内部错误外泄
        const requestBody = rawBody ? (JSON.parse(rawBody) || {}) : {}
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
        // 响应先发,退出调度经统一入口(与升级落定关机同一条链)
        sendJson(res, 200, { ok: true, restarting: true })
        scheduleHostExit({ detail: 'forced=' + (requestBody.force === true), delayMs: RESTART_DELAY_MS })
      }),
    },
    {
      path: API_PATHS.RELEASE_NOTES,
      handler: route('GET', {}, async (req, res) => {
        // 关机窗口内不发上游请求:退出延迟 2 秒小于上游超时,与 refresh 同纪律
        if (restartScheduled) {
          sendJson(res, 409, { error: '重启已调度,禁止查询更新内容' })
          return
        }
        // 缺省恒取追踪通道最新版;上游标签值非 semver 时 buildReleaseTag 抛错归一 400
        const version = judgeNow().channelLatest
        if (!version) {
          sendJson(res, 400, { error: '通道最新版未知,请先检查更新' })
          return
        }
        const cached = releaseNotesCache.get(version)
        if (cached) {
          sendJson(res, 200, { version, url: cached.url, publishedAt: cached.publishedAt, body: cached.body })
          return
        }
        const notes = await fetchReleaseNotes({ version, timeoutMs: CHECK_TIMEOUT_MS })
        releaseNotesCache.set(version, notes)
        while (releaseNotesCache.size > RELEASE_NOTES_CACHE_MAX) {
          releaseNotesCache.delete(releaseNotesCache.keys().next().value)
        }
        sendJson(res, 200, { version, url: notes.url, publishedAt: notes.publishedAt, body: notes.body })
      }),
    },
  ]

  for (const route of routes) {
    ctx.effect(() => ctx.webServer.register({ kind: 'exact', path: route.path, handler: route.handler }), 'dsh-maintain ' + route.path)
  }

  ctx.inject(['settings'], (settingsCtx) => {
    // 方法面防御对齐 timer 软依赖:settings 服务缺 register 面(0.1.7 已移除)即走
    // 新形态分支,不在此路径抛错拖垮启动检查
    if (legacySettingsFace()) {
      settingsCtx.settings.register(NAMESPACE, Config)
    } else if (typeof settingsCtx.settings?.configure === 'function') {
      // 0.1.7 形态:原生自动设置页与本包自定义面板重复,特性检测关闭
      // (官方 dsh-agent-default-model 同构)
      settingsCtx.effect(() => settingsCtx.settings.configure({ auto: false }, ctx.fiber))
    }
    // 启动检查在 settings 注册之后:legacy 命名空间未注册时 readSettings 只能拿默认值,
    // 配置了镜像地址的部署会确定性检查失败
    runCheck().then(scheduleNext, scheduleNext)
  })
}
