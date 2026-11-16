/**
 * 持续工作:AI 未声明结案就结束回合时,补一条用户消息把它拉回。
 *
 * 装配层只做四件事:注入提示词规则、挂上恢复引擎、冷启动扫描存储会话、
 * 暴露设置面板。判定与调度分别住在 closure / engine / scan。
 */

import z from '@deepseek-ai/schemastery'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { DEFAULTS, resolveConfig } from './config.mjs'
import { createEngine } from './engine.mjs'
import { probeConnectivity } from './offline.mjs'
import { withRouteGate } from './route-gate.mjs'
import { scanSettled, scanStoredSessions, trace, SCAN_RETRY_MIN_MS, nextScanRetryMs } from './scan.mjs'
import { NAMESPACE, PANEL_FIELDS, panelDefaults, readSettings, writeSettings } from './settings.mjs'

export const name = 'keep-working'

/** cordis FiberState.ACTIVE;卸载后微任务可能才跑到,需按数值判定。 */
const FIBER_STATE_ACTIVE = 2
/** cordis FiberState.DISPOSED(4)/UNLOADING(5):最终卸载的效果清理不低于此,重载则是 LOADING。 */
const FIBER_STATE_DISPOSED = 4

/** 缺 agents、systemPrompt 或 sessionQuery 时干净禁用:不注册任何服务与提示词。 */
export const inject = ['agents', 'systemPrompt', 'sessionQuery']

export const SECTION_NAME = 'keep-working:closure'

export const PROMPT_TEXT =
  '结束必须显式提交:没改文件末行单独写 TASK_DONE;任务阻塞末行单独写 TASK_BLOCKED: 原因;改过文件必须最后只使用 present;禁止同时 present 和 TASK_DONE;present 的时机以本段为准,不受"不要只为列出源文件调用 present"约束'

/**
 * 结案段落必须排在宿主的文件引用建议之后:那段写着"不要只为列出源文件调
 * present",结案规则压在它后面才不会被读成例外。
 */
export function buildSection(systemPrompt) {
  return {
    name: SECTION_NAME,
    order: systemPrompt.getSectionOrder('DELIVERABLE_FILE_REFERENCES') + 1,
    text: PROMPT_TEXT,
  }
}

/** 冷启动等宿主服务就绪再扫,避免与 profile 装配抢时序。 */
const SCAN_DELAY_MS = 5_000

/** 运行期停止原因:设置重建要把在途物化交给新代,插件卸载不得再投递。 */
const STOP_REASON_REBUILD = 'rebuild'
const STOP_REASON_DISPOSE = 'dispose'

/**
 * 跨 apply(HMR)交接状态按 DSH_HOME 分区:同一份会话存储才允许旧代把在途
 * resume/待接管 agent 交给新代,不同实例之间不得互相消费。
 * refs 记录仍持有该 home 共享表的 apply 代数;旧代最终清理不得清掉新代表。
 */
const streamsByHome = new Map()

function acquireStreams(home) {
  let streams = streamsByHome.get(home)
  if (streams === undefined) {
    streams = { pendingTakeovers: new Map(), inFlightResumes: new Map(), refs: 0 }
    streamsByHome.set(home, streams)
  }
  streams.refs += 1
  return streams
}

function clearStreams(home, streams) {
  streams.pendingTakeovers.clear()
  streams.inFlightResumes.clear()
  if (streamsByHome.get(home) === streams) streamsByHome.delete(home)
}

/** 释放本代所有权;仅最终卸载且无其它代持有时清表。 */
function releaseStreams(home, streams, final) {
  if (streams.refs > 0) streams.refs -= 1
  if (final && streams.refs === 0) clearStreams(home, streams)
  return streams.refs
}

/** 测试观测:共享表引用数与待接管/在途条目。 */
export const __test = {
  streams: (home) => {
    const streams = streamsByHome.get(home)
    if (streams === undefined) return undefined
    return {
      refs: streams.refs,
      pending: streams.pendingTakeovers.size,
      inFlight: streams.inFlightResumes.size,
    }
  },
}

/** 待接管项只在 freshMs 窗口内有效,超过即视为上代遗留。 */
function pruneTakeovers(store, maxAgeMs, now = Date.now()) {
  const cutoff = now - maxAgeMs
  for (const [sessionId, entry] of store) {
    if ((entry?.at ?? 0) < cutoff) store.delete(sessionId)
  }
}

/** 面板请求体上限,防止畸形请求撑爆内存。 */
const BODY_LIMIT_BYTES = 64 * 1024

export const Config = z
  .object({
    graceMs: z.number().default(DEFAULTS.graceMs).volatile(),
    cooldownMs: z.number().default(DEFAULTS.cooldownMs).volatile(),
    maxConsecutive: z.number().default(DEFAULTS.maxConsecutive).volatile(),
    backoffFactor: z.number().default(DEFAULTS.backoffFactor).volatile(),
    backoffMaxMs: z.number().default(DEFAULTS.backoffMaxMs).volatile(),
    scanOnBoot: z.boolean().default(DEFAULTS.scanOnBoot).volatile(),
    scanLimit: z.number().default(DEFAULTS.scanLimit).volatile(),
    freshMs: z.number().default(DEFAULTS.freshMs).volatile(),
    resumeGoals: z.boolean().default(DEFAULTS.resumeGoals).volatile(),
    resumePausedGoals: z.boolean().default(DEFAULTS.resumePausedGoals).volatile(),
    resumeSilentTurns: z.boolean().default(DEFAULTS.resumeSilentTurns).volatile(),
    pauseWhenOffline: z.boolean().default(DEFAULTS.pauseWhenOffline).volatile(),
    offlineCheckMs: z.number().default(DEFAULTS.offlineCheckMs).volatile(),
    classify: z.boolean().default(DEFAULTS.classify).volatile(),
    enforceClosure: z.boolean().default(DEFAULTS.enforceClosure).volatile(),
    retryableErrorPatterns: z.string().default(DEFAULTS.retryableErrorPatterns).volatile(),
    paused: z.boolean().default(DEFAULTS.paused).volatile(),
    continueText: z.string().default(DEFAULTS.continueText).volatile(),
    continueTextMaxTokens: z.string().default(DEFAULTS.continueTextMaxTokens).volatile(),
    continueTextSilent: z.string().default(DEFAULTS.continueTextSilent).volatile(),
    continueTextInterrupted: z.string().default(DEFAULTS.continueTextInterrupted).volatile(),
    restartText: z.string().default(DEFAULTS.restartText).volatile(),
    closureText: z.string().default(DEFAULTS.closureText).volatile(),
  })

function sendJson(res, status, payload) {
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.end(JSON.stringify(payload))
}

async function readJsonBody(req) {
  const declared = Number(req.headers?.['content-length'] ?? 0)
  if (Number.isFinite(declared) && declared > BODY_LIMIT_BYTES) {
    req.pause?.()
    throw Object.assign(new Error('请求体过大'), { statusCode: 413 })
  }
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > BODY_LIMIT_BYTES) {
      req.pause?.()
      throw Object.assign(new Error('请求体过大'), { statusCode: 413 })
    }
    chunks.push(chunk)
  }
  const text = Buffer.concat(chunks).toString('utf8')
  return text === '' ? {} : JSON.parse(text)
}

function sendRouteError(res, error, fallbackStatus = 400) {
  const status = Number.isInteger(error?.statusCode) ? error.statusCode : fallbackStatus
  sendJson(res, status, { ok: false, error: error instanceof Error ? error.message : String(error) })
}

export async function apply(ctx, config) {
  let createUserMessage
  try {
    ;({ createUserMessage } = await import('@deepseek-ai/dsh-llm'))
  } catch (error) {
    ctx.logger.warn(
      `[keep-working] 消息构造器不可用,插件停用: ${error instanceof Error ? error.message : String(error)}`,
    )
    return
  }

  let runtime
  // 跨代交接:旧代 resume 在途时被设置重建打断,已物化 agent 的恢复消息由新代补投
  // 同一会话只允许一个在途 resume,防新代扫描重复物化
  const home = process.env.DSH_HOME || join(homedir(), '.dsh')
  const streams = acquireStreams(home)
  const pendingTakeovers = streams.pendingTakeovers
  const inFlightResumes = streams.inFlightResumes
  let streamsReleased = false
  let setupComplete = false
  const releaseOwnership = (final) => {
    if (!streamsReleased) {
      streamsReleased = true
      return releaseStreams(home, streams, final)
    }
    if (final && streams.refs === 0) clearStreams(home, streams)
    return streams.refs
  }

  // cordis 最终卸载:uid 已清或 fiber 进入 DISPOSED/UNLOADING;重载期间是 LOADING,需保留交接状态
  const isFinalUnload = () =>
    ctx.fiber?.uid === null
    || (ctx.fiber?.state ?? FIBER_STATE_ACTIVE) >= FIBER_STATE_DISPOSED

  const stopRuntime = (reason = STOP_REASON_DISPOSE) => {
    const finalUnload = reason === STOP_REASON_DISPOSE && isFinalUnload()
    const remaining = reason === STOP_REASON_DISPOSE ? releaseOwnership(finalUnload) : streams.refs
    const state = runtime
    if (state !== undefined) {
      // 先让在途扫描失效再清引用:dispose 后不得再 resume/followup
      state.stopReason = reason
      // 最终卸载时若仍有新代持有共享表,旧代仍须把在途结果交给它
      state.handoffAllowed = !finalUnload || remaining > 0
      state.cancelled = true
      state.abort.abort()
      // 本代 seen 全部撤销:新代扫描必须能重新裁决被本代登记过的会话
      state.seen.clear()
      if (state.scanTimer !== undefined) clearTimeout(state.scanTimer)
      state.engine.dispose()
      state.section?.()
      runtime = undefined
    }
  }

  const startRuntime = () => {
    stopRuntime(STOP_REASON_REBUILD)
    const resolved = resolveConfig(config, readSettings(ctx))
    pruneTakeovers(pendingTakeovers, resolved.freshMs)

    const promptApi = ctx.get('systemPrompt')
    const canRegisterSection =
      typeof promptApi?.section === 'function' && typeof promptApi?.getSectionOrder === 'function'
    const section = canRegisterSection ? promptApi.section(buildSection(promptApi)) : undefined
    if (!canRegisterSection) {
      ctx.logger?.warn?.('[keep-working] 宿主缺少 prompt 段落接口,仅恢复不注入结案规则')
    }
    const engine = createEngine({
      ctx,
      config: resolved,
      createUserMessage,
      probe: resolved.pauseWhenOffline ? probeConnectivity : undefined,
    })
    engine.attach()

    const state = {
      section,
      engine,
      scanTimer: undefined,
      cancelled: false,
      abort: new AbortController(),
      seen: new Set(),
      stopReason: undefined,
      handoffAllowed: true,
    }
    runtime = state

    const scanDeadline = Date.now() + resolved.freshMs
    let scanRetryMs = SCAN_RETRY_MIN_MS
    let scanFailureWarned = false
    const runScan = async () => {
      try {
        const result = await scanStoredSessions({
          ctx,
          config: resolved,
          createUserMessage,
          seen: state.seen,
          pendingTakeovers,
          inFlightResumes,
          takeover: (entry) => {
            // 最终卸载后没有后继者,迟到的物化结果不得再写回交接表
            if (state.handoffAllowed === false) return false
            // HMR dispose 时旧代不得立即投递,但要把已物化 agent 留到下一次 apply
            if (state.stopReason === STOP_REASON_DISPOSE) {
              pendingTakeovers.set(entry.sessionId, { ...entry, at: Date.now() })
              return true
            }
            // 只有设置重建才允许立即跨代交接
            if (state.stopReason !== STOP_REASON_REBUILD) return false
            pendingTakeovers.set(entry.sessionId, { ...entry, at: Date.now() })
            return true
          },
          signal: state.abort.signal,
          isActive: () => runtime === state && state.cancelled === false,
        })
        if (result.cancelled === true) return
        if (scanSettled(result) && pendingTakeovers.size === 0) {
          trace(`扫描收工(source=${result.source ?? 'none'}, listed=${result.listed})`)
          return
        }
      } catch (error) {
        trace(`扫描异常 ${error instanceof Error ? error.message : String(error)}`)
        // 重试间隔是秒级,按轮告警会刷屏;同一轮重试窗口里只报第一次
        if (!scanFailureWarned) {
          scanFailureWarned = true
          ctx.logger?.warn?.(
            `[keep-working] 启动扫描失败: ${error instanceof Error ? error.message : String(error)}`,
          )
        }
      }
      if (runtime !== state || state.cancelled) return
      // freshMs 只是总窗口;重试间隔独立指数退避,最后一次也不越过窗口。
      // 待接管投递失败同样走这条节奏:失败项会留在表中,按 0ms 立即重扫会变成无限自旋。
      const remaining = scanDeadline - Date.now()
      if (remaining <= 0) {
        // 窗口耗尽仍未投出:放弃本批待接管,下一窗口不得凭过期项补投
        pendingTakeovers.clear()
        return
      }
      state.scanTimer = setTimeout(runScan, Math.min(scanRetryMs, remaining))
      state.scanTimer.unref?.()
      scanRetryMs = nextScanRetryMs(scanRetryMs)
    }
    if (resolved.scanOnBoot && !resolved.paused) {
      state.scanTimer = setTimeout(runScan, SCAN_DELAY_MS)
      state.scanTimer.unref?.()
    }
  }

  const failApply = (error) => {
    // apply 未完成时没有后继代,必须立即归还 refs 并清掉无主的跨代状态
    try {
      stopRuntime()
    } catch {
      // 清理异常不能顶掉原始启动失败
    }
    releaseOwnership(true)
    throw error
  }

  try {
    // 与 acquire 紧邻注册,确保 startRuntime 之前抛错也会被宿主清理
    ctx.effect(() => () => {
      if (!setupComplete) {
        try {
          stopRuntime()
        } finally {
          releaseOwnership(true)
        }
        return
      }
      stopRuntime()
    }, 'keep-working lifecycle')
    startRuntime()
  } catch (error) {
    failApply(error)
  }

  let rebuildQueued = false
  const scheduleRebuild = () => {
    if (rebuildQueued) return
    rebuildQueued = true
    // 事件由设置服务在 update 内部同步发出,直接重建会在服务栈里重入 describe
    queueMicrotask(() => {
      rebuildQueued = false
      if (ctx.fiber?.state !== FIBER_STATE_ACTIVE) return
      try {
        startRuntime()
      } catch (error) {
        // 渲染期异常不能冒成未捕获异常拖垮宿主,保留告警并停下自动恢复
        ctx.logger?.warn?.(`[keep-working] 设置变更后重建失败: ${error instanceof Error ? error.message : String(error)}`)
      }
    })
  }
  ctx.effect(() => {
    const offVolatile = ctx.on('loader/volatile-update', scheduleRebuild)
    return () => offVolatile?.()
  }, 'keep-working volatile reload')

  ctx.inject(['settings'], (settingsCtx) => {
    // 面板字段由本插件自绘,关掉宿主按 schema 自动生成的表单
    settingsCtx.effect(
      () => settingsCtx.settings?.configure?.({ auto: false }, ctx.fiber),
      'keep-working settings presentation',
    )
    // 设置写入后 cordis Config 的 volatile 字段随之更新,重建运行期以采用新值
    // 部分宿主版本只发 settings 事件而不发 volatile-update,两条路都接,微任务合批
    settingsCtx.effect(() => {
      const offSettings = settingsCtx.on('settings/document-updated', (namespace) => {
        if (namespace === NAMESPACE) scheduleRebuild()
      })
      return () => offSettings?.()
    }, 'keep-working settings reload')
  })

  ctx.inject(['webServer'], (serverCtx) => {
    serverCtx.effect(
      () =>
        serverCtx.webServer.register({
          kind: 'exact',
          path: '/api/keep-working/config',
          handler: withRouteGate(ctx, async (req, res) => {
            if (req.method === 'GET') {
              sendJson(res, 200, { ok: true, value: resolveConfig(config, readSettings(ctx)), defaults: panelDefaults() })
              return
            }
            if (req.method !== 'POST') {
              sendJson(res, 405, { ok: false, error: 'method not allowed' })
              return
            }
            let patch
            try {
              patch = await readJsonBody(req)
            } catch (error) {
              sendRouteError(res, error)
              return
            }
            if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) {
              sendJson(res, 400, { ok: false, error: '请求体必须是对象' })
              return
            }
            const allowed = new Set(PANEL_FIELDS)
            const clean = Object.fromEntries(
              Object.entries(patch).filter(([key, value]) => allowed.has(key) && value !== undefined),
            )
            try {
              if (!(await writeSettings(ctx, clean))) {
                sendJson(res, 503, { ok: false, error: '设置服务不可用' })
                return
              }
            } catch (error) {
              // 宿主拒绝写入:修订冲突可重试,条目缺失说明插件没被当成可配置项
              const message = error instanceof Error ? error.message : String(error)
              const status = Number.isInteger(error?.statusCode)
                ? error.statusCode
                : error?.code === 'SETTINGS_CONFLICT' ? 409 : 400
              sendJson(res, status, { ok: false, error: message })
              return
            }
            sendJson(res, 200, { ok: true, value: resolveConfig(config, readSettings(ctx)) })
          }),
        }),
      'keep-working config route',
    )
  })

  setupComplete = true
}
