/**
 * 重启扫描:把上次进程退出时未结案的存储会话重新拉起来。
 *
 * 宿主只在客户端打开会话时才物化 agent,所以冷启动时必须自己枚举存储、
 * 判定尾部状态、再按需 resume。
 */

import { hasVisibleOutput, turnSlice } from './closure.mjs'
import { isTransientFailure, parseFailureFacts } from './failure.mjs'
import { isDerivedSessionHeader } from './session-kind.mjs'
import { appendFileSync, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** 扫描结论落盘,重启恢复出问题时这是唯一可观测面。 */
const logFile = () => join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'keep-working-scan.log')

export function trace(message) {
  try {
    appendFileSync(logFile(), `${new Date().toISOString()} ${message}\n`)
  } catch {}
}

/** 宿主重启产生的取消原因,值得在重启后补一次。 */
const RESTART_CANCEL_CAUSES = new Set(['disposed', 'legacy'])

/** 尾部是否还有活;openTurn 表示回合没闭合,等同于被打断。 */
function tailVerdict(events, nowTime, config) {
  let lastEnd
  let lastStart
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const item = events[index]
    if (lastEnd === undefined && item?.type === 'turn/end') lastEnd = item
    if (lastStart === undefined && item?.type === 'turn/start') lastStart = item
    if (lastEnd !== undefined && lastStart !== undefined) break
  }
  const openTurn = lastStart !== undefined && (lastEnd === undefined || lastStart.seq > lastEnd.seq)
  if (!openTurn && lastEnd === undefined) return 'skip:空日志'
  const touchedAt = openTurn ? (events.at(-1)?.time ?? 0) : lastEnd.time
  if (touchedAt < nowTime - config.freshMs) return 'skip:超出时间窗口'
  if (openTurn) return 'resume'

  const reason = lastEnd.data?.reason ?? {}
  switch (reason.kind) {
    case 'completed':
      // 回合正常结束就当它做完了:重启后重复执行的代价高于漏恢复的概率
      return hasVisibleOutput(turnSlice(events, lastEnd.data.turn)) ? 'skip:正常结束' : 'resume'
    case 'error': {
      const failure = parseFailureFacts(reason.error)
      if (failure === undefined) return 'skip:错误无法解析'
      if (config.classify && !isTransientFailure(failure, config.retryableErrorPatterns)) {
        return 'skip:永久错误'
      }
      return 'resume'
    }
    case 'interrupted':
    case 'max-tokens':
      return 'resume'
    case 'aborted':
      return RESTART_CANCEL_CAUSES.has(reason.reason?.kind) ? 'resume' : 'skip:用户取消'
    default:
      return 'skip:无需恢复'
  }
}

/** 把存储会话恢复为 live agent;已 live 时直接返回。 */
async function materialize(ctx, sessionId, presetId) {
  const existing = ctx.agents.get(sessionId)
  if (existing !== undefined) return existing
  const selection = ctx.get('agentDefaultModel')?.currentSelection?.()
  const agentOptions =
    selection === undefined ? undefined : { provider: selection.provider, model: selection.model }
  const presets = ctx.get('agentPresets')
  if (presets === undefined) {
    await ctx.agents.resume({ resumeSessionId: sessionId, agentOptions })
    return ctx.agents.get(sessionId)
  }
  // 不挂 preset 的 agent 没有工具与提示变量,恢复后发出的请求无路由。
  const resolvedId = (await presets.resolve(presetId)).id
  await ctx.agents.resume({
    resumeSessionId: sessionId,
    agentOptions,
    setup: async (agentCtx) => {
      await presets.mount(agentCtx, resolvedId)
    },
  })
  return ctx.agents.get(sessionId)
}

/** goal 在进程重启后会被 disarm;active 且 disarmed 时才重新武装。 */
function rearmGoal(ctx, agent, config) {
  if (!config.resumeGoals) return
  const goals = ctx.get('goals')
  if (goals === undefined) return
  try {
    const view = goals.get(agent)
    if (view === undefined || view.revision === undefined) return
    const ref = { id: view.id, revision: view.revision }
    if (view.phase === 'active' && view.activation === 'disarmed') {
      goals.resume(agent, ref)
      return
    }
    if (view.phase === 'paused' && config.resumePausedGoals) goals.resume(agent, ref)
  } catch (error) {
    ctx.logger?.warn?.(`[keep-working] goal 恢复失败 ${agent?.id}: ${String(error)}`)
  }
}

/** 单轮扫描预算:超出后收手,由调用方下一轮接着扫。 */
const SCAN_BUDGET_MS = 60_000

/** 每检查这么多个会话让出一次事件循环。 */
const SCAN_YIELD_BATCH = 32

/** 会话持久层的落盘目录名,与宿主存储布局一致。 */
const SESSIONS_DIR = 'sessions'

/** 单会话产物文件名。 */
const SESSION_ARTIFACT = 'session.v4.jsonl.zstd'

/** 会话目录前缀,目录名即会话 id。 */
const SESSION_DIR_PREFIX = 'session-'

/**
 * 直接扫会话目录取最近改动过的会话。
 *
 * 宿主的 `persistence.list()` 要为上千个会话逐个解析快照,固定开销接近十秒,
 * 而筛选只需要 id 与修改时间。目录扫描是百毫秒级,命中后再向持久层要头部。
 * 目录缺失(换后端或尚未落盘)时返回 undefined,由调用方走服务接口。
 */
export function listFreshByDirectory(config, nowTime) {
  const root = join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), SESSIONS_DIR)
  let workspaces
  try {
    workspaces = readdirSync(root, { withFileTypes: true })
  } catch {
    return undefined
  }
  const cutoff = nowTime - config.freshMs
  const fresh = []
  for (const workspace of workspaces) {
    if (!workspace.isDirectory()) continue
    let entries
    try {
      entries = readdirSync(join(root, workspace.name), { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || !entry.name.startsWith(SESSION_DIR_PREFIX)) continue
      const path = join(root, workspace.name, entry.name, SESSION_ARTIFACT)
      let stat
      try {
        stat = statSync(path)
      } catch {
        continue
      }
      if (stat.mtimeMs < cutoff) continue
      fresh.push({ id: entry.name, path, mtimeMs: stat.mtimeMs })
    }
  }
  return fresh
}

/**
 * 按文件修改时间筛出候选会话。
 *
 * 存储里可能有上千个会话,逐个解码全量事件是分钟级开销;真正需要恢复的只有
 * 最近 freshMs 内被写过的那几个。优先走目录扫描,失败时回落到持久层快照。
 */
async function listFreshSessions(ctx, config, nowTime, scanDirectory = listFreshByDirectory) {
  const persistence = ctx.get('sessionPersistence')
  const byDirectory = scanDirectory(config, nowTime)
  if (byDirectory !== undefined) {
    trace(`目录扫出 ${byDirectory.length} 个近期会话`)
    // 头部里带着 preset 与父子身份,只有命中的少数会话才需要问持久层
    const statted = await Promise.all(
      byDirectory.map(async (item) => {
        try {
          return { item, snapshot: await persistence?.stat?.(item.id) }
        } catch {
          return undefined
        }
      }),
    )
    const fresh = []
    for (const entry of statted) {
      if (entry === undefined) continue
      const header = entry.snapshot?.header
      if (header !== undefined && isDerivedSessionHeader(header)) continue
      fresh.push({
        id: entry.item.id,
        presetId: header?.agentPreset,
        mtimeMs: entry.item.mtimeMs,
        eventCount: entry.snapshot?.eventCount ?? 0,
      })
    }
    // 先小后大:大日志解压代价高,先让小的快速出结果,再处理残留的大会话
    fresh.sort((left, right) => left.eventCount - right.eventCount || right.mtimeMs - left.mtimeMs)
    return fresh
  }

  if (persistence === undefined || typeof persistence.list !== 'function') return undefined
  const snapshots = await persistence.list()
  if (!Array.isArray(snapshots)) return undefined
  trace(`持久层快照 ${snapshots.length} 个`)
  const cutoff = nowTime - config.freshMs
  const fresh = []
  for (const snapshot of snapshots) {
    const header = snapshot?.header
    if (header === undefined || typeof header.id !== 'string' || header.id === '') continue
    if (isDerivedSessionHeader(header)) continue
    const path = snapshot?.location?.path
    if (typeof path !== 'string' || path === '') continue
    let mtimeMs
    try {
      mtimeMs = statSync(path).mtimeMs
    } catch {
      continue
    }
    if (mtimeMs < cutoff) continue
    fresh.push({ id: header.id, presetId: header.agentPreset, mtimeMs, eventCount: snapshot.eventCount ?? 0 })
  }
  fresh.sort((left, right) => left.eventCount - right.eventCount || right.mtimeMs - left.mtimeMs)
  return fresh
}

/** 全量列表回退:持久层缺席时按宿主会话索引遍历。 */
async function listAllSessions(ctx) {
  const query = ctx.get('sessionQuery')
  if (query === undefined) return undefined
  const records = await query.listSessions()
  if (!Array.isArray(records)) return undefined
  return records
    .map((record) => {
      const header = record?.header
      if (header === undefined || typeof header.id !== 'string' || header.id === '') return undefined
      return { id: header.id, presetId: header.agentPreset, live: record.live === true, header }
    })
    .filter((item) => item !== undefined)
}

/** 扫描并恢复;返回本轮观察与恢复数量。 */
export async function scanStoredSessions({
  ctx,
  config,
  createUserMessage,
  now = Date.now,
  budgetMs = SCAN_BUDGET_MS,
  seen = new Set(),
  scanDirectory = listFreshByDirectory,
}) {
  const result = { listed: 0, scanned: 0, resumed: 0, complete: true }
  const deadline = Date.now() + budgetMs
  trace('扫描开始')
  if (!config.scanOnBoot || config.paused) return result
  const query = ctx.get('sessionQuery')
  if (query === undefined) {
    trace('sessionQuery 缺失,放弃')
    return result
  }
  // 归档集合决定哪些会话不该被拉起。恢复是写操作,误恢复已归档会话会真的
  // 消耗额度,所以这里的方向与只读场景相反:拿不到权威集合就不恢复。
  // 注册表是异步加载的,先等它就绪,避免每轮重试都白做一遍候选筛选。
  let archived
  try {
    const registry = ctx.get('workspaceRegistry')
    if (registry === undefined) throw new Error('工作区服务缺失')
    archived = new Set(registry.archivedSessionIds)
  } catch (error) {
    trace(`归档集合未就绪,本轮不恢复: ${error instanceof Error ? error.message : String(error)}`)
    result.complete = false
    return result
  }
  trace(`已归档 ${archived.size} 个`)
  const fresh = await listFreshSessions(ctx, config, now(), scanDirectory)
  const candidates = fresh ?? (await listAllSessions(ctx))
  if (candidates === undefined) return result
  result.listed = candidates.length
  trace(
    fresh === undefined
      ? `列出 ${candidates.length} 个存储会话(全量回退)`
      : `按修改时间筛出 ${candidates.length} 个候选会话`,
  )

  for (const candidate of candidates) {
    if (result.resumed >= config.scanLimit) break
    // 存储量可能上千,逐个解码全量事件代价高;超出本轮预算就收手,下轮接着扫
    if (Date.now() >= deadline) {
      result.complete = false
      break
    }
    const sessionId = candidate.id
    if (isDerivedSessionHeader(candidate.header ?? { id: sessionId })) continue
    if (candidate.live === true) continue
    if (ctx.agents.get(sessionId) !== undefined) continue
    if (archived.has(sessionId)) continue
    // 跨轮去重:已经裁决过的会话不再重复冷读,预算才能推进到后续会话
    if (seen.has(sessionId)) continue
    seen.add(sessionId)

    let observation
    try {
      observation = await query.observeSession(sessionId)
      const events = observation?.events
      if (!Array.isArray(events) || events.length === 0) continue
      result.scanned += 1
      const verdict = tailVerdict(events, now(), config)
      trace(`会话 ${sessionId} 事件 ${events.length} 判定 ${verdict}`)
      if (verdict !== 'resume') continue
      const agent = await materialize(ctx, sessionId, candidate.presetId)
      if (agent === undefined) continue
      rearmGoal(ctx, agent, config)
      const message = createUserMessage({
        content: [{ type: 'text', text: config.continueTextInterrupted }],
        source: { kind: 'user' },
      })
      agent.followup(message)
      result.resumed += 1
      trace(`已恢复 ${sessionId}`)
      ctx.logger?.info?.(`[keep-working] 重启恢复 ${sessionId}`)
    } catch (error) {
      trace(`处理失败 ${sessionId ?? '?'}: ${error instanceof Error ? error.message : String(error)}`)
      ctx.logger?.warn?.(
        `[keep-working] 扫描 ${sessionId} 失败: ${error instanceof Error ? error.message : String(error)}`,
      )
    } finally {
      observation?.[Symbol.dispose]?.()
      // 长扫描逐批让出事件循环,否则宿主在冷启动窗口内无法响应其它请求
      if (result.scanned > 0 && result.scanned % SCAN_YIELD_BATCH === 0) {
        await new Promise((resolve) => setTimeout(resolve, 0))
      }
    }
  }
  return result
}
