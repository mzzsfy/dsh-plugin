/**
 * 持续工作:AI 未声明结案就结束回合时,补一条用户消息把它拉回。
 *
 * 装配层只做四件事:注入提示词规则、挂上恢复引擎、冷启动扫描存储会话、
 * 暴露设置面板。判定与调度分别住在 closure / engine / scan。
 */

import z from '@deepseek-ai/schemastery'

import { DEFAULTS, resolveConfig } from './config.mjs'
import { createEngine } from './engine.mjs'
import { probeConnectivity } from './offline.mjs'
import { guardWrite } from './route-guard.mjs'
import { withHostGate } from './route-gate.mjs'
import { scanSettled, scanStoredSessions, trace } from './scan.mjs'
import { NAMESPACE, PANEL_FIELDS, panelDefaults, readSettings, writeSettings } from './settings.mjs'

export const name = 'keep-working'

/** cordis FiberState.ACTIVE;卸载后微任务可能才跑到,需按数值判定。 */
const FIBER_STATE_ACTIVE = 2

/** 缺 agents 或 systemPrompt 时干净禁用:不注册任何服务与提示词。 */
export const inject = ['agents', 'systemPrompt']

export const SECTION_NAME = 'keep-working:closure'

export const PROMPT_TEXT =
  '结束必须显式提交:没改文件末行追加 (TASK_DONE);任务阻塞末行追加 (TASK_BLOCKED: 原因);改过文件必须最后只使用 present;禁止同时present和(TASK_DONE);present 的时机以本段为准,交付产物本身就是 present 的用途,不受"不要只为列出源文件调用 present"约束'

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

/** 宿主服务尚未就绪时按此间隔重试;工作区注册表通常在数秒内完成异步加载。 */
const SCAN_RETRY_MS = 1_000

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
    retryableErrorPatterns: z.string().default(DEFAULTS.retryableErrorPatterns).volatile(),
    paused: z.boolean().default(DEFAULTS.paused).volatile(),
    continueText: z.string().default(DEFAULTS.continueText).volatile(),
    continueTextMaxTokens: z.string().default(DEFAULTS.continueTextMaxTokens).volatile(),
    continueTextSilent: z.string().default(DEFAULTS.continueTextSilent).volatile(),
    continueTextInterrupted: z.string().default(DEFAULTS.continueTextInterrupted).volatile(),
    closureText: z.string().default(DEFAULTS.closureText).volatile(),
  })

function sendJson(res, status, payload) {
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.end(JSON.stringify(payload))
}

async function readJsonBody(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > BODY_LIMIT_BYTES) throw new Error('请求体过大')
    chunks.push(chunk)
  }
  const text = Buffer.concat(chunks).toString('utf8')
  return text === '' ? {} : JSON.parse(text)
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
  // 本进程已裁决过的存储会话,跨扫描轮次去重
  const seenSessions = new Set()

  const stopRuntime = () => {
    if (runtime === undefined) return
    if (runtime.scanTimer !== undefined) clearTimeout(runtime.scanTimer)
    runtime.engine.dispose()
    runtime.section?.()
    runtime = undefined
  }

  const startRuntime = () => {
    stopRuntime()
    const resolved = resolveConfig(config, readSettings(ctx))

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

    const state = { section, engine, scanTimer: undefined }
    runtime = state

    const scanDeadline = Date.now() + resolved.freshMs
    let scanFailureWarned = false
    const runScan = async () => {
      try {
        const result = await scanStoredSessions({ ctx, config: resolved, createUserMessage, seen: seenSessions })
        if (scanSettled(result)) {
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
      if (Date.now() >= scanDeadline || runtime !== state) return
      state.scanTimer = setTimeout(runScan, SCAN_RETRY_MS)
      state.scanTimer.unref?.()
    }
    if (resolved.scanOnBoot && !resolved.paused) {
      state.scanTimer = setTimeout(runScan, SCAN_DELAY_MS)
      state.scanTimer.unref?.()
    }
  }

  startRuntime()

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
          handler: withHostGate(serverCtx, async (req, res) => {
            if (req.method === 'GET') {
              sendJson(res, 200, { ok: true, value: resolveConfig(config, readSettings(ctx)), defaults: panelDefaults() })
              return
            }
            if (req.method !== 'POST') {
              sendJson(res, 405, { ok: false, error: 'method not allowed' })
              return
            }
            if (guardWrite(req, res, sendJson)) return
            let patch
            try {
              patch = await readJsonBody(req)
            } catch (error) {
              sendJson(res, 400, { ok: false, error: error instanceof Error ? error.message : String(error) })
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
              const status = error?.code === 'SETTINGS_CONFLICT' ? 409 : 400
              sendJson(res, status, { ok: false, error: message })
              return
            }
            sendJson(res, 200, { ok: true, value: resolveConfig(config, readSettings(ctx)) })
          }),
        }),
      'keep-working config route',
    )
  })

  ctx.effect(() => () => stopRuntime(), 'keep-working lifecycle')
}
