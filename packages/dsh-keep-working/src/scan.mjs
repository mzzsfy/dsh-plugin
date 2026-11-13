/**
 * 重启扫描:把上次进程退出时未结案的存储会话重新拉起来。
 *
 * 宿主只在客户端打开会话时才物化 agent,所以冷启动时必须自己枚举存储、
 * 判定尾部状态、再按需 resume。
 */

import { closureVerdict, hasVisibleOutput, turnSlice } from './closure.mjs'
import { fillTemplate } from './config.mjs'
import { isTransientFailure, parseFailureFacts } from './failure.mjs'
import { isDerivedSessionHeader } from './session-kind.mjs'
import { appendFileSync, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** 扫描结论落盘,重启恢复出问题时这是唯一可观测面。 */
const logFile = () => join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'keep-working-scan.log')

export function trace(message) {
  try {
    appendFileSync(logFile(), `${new Date().toISOString()} ${message}\n`)
  } catch {}
}

/** 宿主重启产生的取消原因,值得在重启后补一次。 */
const RESTART_CANCEL_CAUSES = new Set(['disposed', 'legacy'])

/**
 * 重放会话日志里的 durable inbox 投影,得到仍在排队的输入。
 *
 * 宿主把排队消息持久化为 `agent/inbox/spliced`;重启只重建投影,不会自动唤醒
 * agent,所以扫描必须自己发现这些消息。next-turn 全部算待处理输入;next-step
 * 只算真人插话——其余是运行时上下文注入,重启后不该凭它拉起整轮。
 * 返回条数与最后一次入队时间。
 */
export function pendingInbox(events) {
  const queues = { 'next-turn': [], 'next-step': [] }
  let lastAt = 0
  for (const event of events) {
    if (event?.type !== 'agent/inbox/spliced') continue
    const data = event.data ?? {}
    const queue = queues[data.target]
    if (queue === undefined) continue
    const declared = Number.isSafeInteger(data.start) ? data.start : 0
    const start = declared < 0 ? Math.max(queue.length + declared, 0) : Math.min(declared, queue.length)
    const removed = Math.min(
      Math.max(Number.isSafeInteger(data.removedCount) ? data.removedCount : 0, 0),
      queue.length - start,
    )
    const inserted = Array.isArray(data.inserted) ? data.inserted : []
    queues[data.target] = [...queue.slice(0, start), ...inserted, ...queue.slice(start + removed)]
    if (typeof event.time === 'number') lastAt = Math.max(lastAt, event.time)
  }
  const steering = queues['next-step'].filter((message) => message?.source?.kind === 'user').length
  return { count: queues['next-turn'].length + steering, lastAt }
}

/** 尾部是否还有活;openTurn 表示回合没闭合,等同于被打断。 */
function tailVerdict(events, nowTime, config, inbox = pendingInbox(events)) {
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
  const tailAt = openTurn ? (events.at(-1)?.time ?? 0) : lastEnd.time
  // 排队消息自带时间:上一回合可能早已结束,重启前才入队的消息仍是新鲜输入
  const touchedAt = Math.max(tailAt, inbox.lastAt)
  if (touchedAt < nowTime - config.freshMs) return 'skip:超出时间窗口'
  if (openTurn) return 'resume:interrupted'

  const reason = lastEnd.data?.reason ?? {}
  switch (reason.kind) {
    case 'completed': {
      // 正常结束也可能留着未消费的排队消息:宿主重启后无人唤醒它们
      if (inbox.count > 0) return 'resume:queued'
      // 有有效写入却没交付时必须恢复:重启后重做一遍也比永远不交付安全
      const verdict = closureVerdict(events, lastEnd.data.turn)
      if (verdict.reason === 'file-write-requires-present') return 'resume:closure'
      // 回合正常结束就当它做完了:重启后重复执行的代价高于漏恢复的概率
      if (verdict.closed || hasVisibleOutput(turnSlice(events, lastEnd.data.turn))) return 'skip:正常结束'
      return config.resumeSilentTurns ? 'resume:silent' : 'skip:无可见输出'
    }
    case 'error': {
      const failure = parseFailureFacts(reason.error)
      if (failure === undefined) return 'skip:错误无法解析'
      if (config.classify && !isTransientFailure(failure, config.retryableErrorPatterns)) {
        return 'skip:永久错误'
      }
      return 'resume:error'
    }
    case 'interrupted':
      return 'resume:interrupted'
    case 'max-tokens':
      return 'resume:max-tokens'
    case 'aborted':
      return RESTART_CANCEL_CAUSES.has(reason.reason?.kind) ? 'resume:interrupted' : 'skip:用户取消'
    default:
      return 'skip:无需恢复'
  }
}

/** 恢复文案:按尾部原因取对应说法,默认用中断文案。 */
function resumeText(config, verdict) {
  const reason = verdict.slice('resume:'.length)
  const template =
    reason === 'error'
      ? config.continueText
      : reason === 'max-tokens'
        ? config.continueTextMaxTokens
        : reason === 'silent'
          ? config.continueTextSilent
          : config.continueTextInterrupted
  return fillTemplate(template, {})
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

/** goal 在进程重启后会被 disarm;active 且 disarmed 时才重新武装。返回是否已交回 goal driver 驱动。 */
function rearmGoal(ctx, agent, config) {
  if (!config.resumeGoals) return false
  const goals = ctx.get('goals')
  if (goals === undefined) return false
  try {
    const view = goals.get(agent)
    if (view === undefined || view.revision === undefined) return false
    const ref = { id: view.id, revision: view.revision }
    if (view.phase === 'active' && view.activation === 'disarmed') {
      goals.resume(agent, ref)
      return true
    }
    if (view.phase === 'paused' && config.resumePausedGoals) {
      goals.resume(agent, ref)
      return true
    }
    return false
  } catch (error) {
    ctx.logger?.warn?.(`[keep-working] goal 恢复失败 ${agent?.id}: ${String(error)}`)
    return false
  }
}

/** 单轮扫描预算:超出后收手,由调用方下一轮接着扫。 */
const SCAN_BUDGET_MS = 60_000

/** 每检查这么多个会话让出一次事件循环。 */
const SCAN_YIELD_BATCH = 32

/** 会话持久层的落盘目录名,与宿主存储布局一致。 */
const SESSIONS_DIR = 'sessions'

/** 产物规范名:session.v<代际>.jsonl[.zstd],迁移中间产物与临时文件不匹配。 */
const SESSION_GENERATION = /^session(?:\.v(\d+))?\.jsonl(?:\.[a-z0-9]+)?$/

/** 会话目录前缀,目录名即会话 id。 */
const SESSION_DIR_PREFIX = 'session-'

/** 会话产物路径:目录内按代际取最高的一份,避免升级后旧代际文件的旧 mtime 掩盖新写入。 */
function findArtifact(sessionDir) {
  let names
  try {
    names = readdirSync(sessionDir)
  } catch {
    return undefined
  }
  const candidates = names
    .map((name) => ({ name, generation: SESSION_GENERATION.exec(name)?.[1] ?? '0' }))
    .filter((item) => item.generation !== undefined)
    .sort((left, right) => Number(right.generation) - Number(left.generation))
  return candidates.length === 0 ? undefined : join(sessionDir, candidates[0].name)
}

/**
 * 直接扫会话目录取最近改动过的会话。
 *
 * 宿主的 `persistence.list()` 要为上千个会话逐个解析快照,固定开销接近十秒,
 * 而筛选只需要 id 与修改时间。目录扫描是百毫秒级,命中后再向持久层要头部。
 * 目录缺失(换后端或尚未落盘)时返回 undefined,由调用方走服务接口。
 * 工作区目录不可读会让快照不完整,此时 partial 为真,调用方不得据此认定"没有待恢复会话"。
 * 单个产物缺失不算:非 zstd 后端、旧代际与删除竞态都会表现为缺失,是常态而非读取失败。
 */
export function listFreshByDirectory(config, nowTime, persistence) {
  if (persistence !== undefined && typeof persistence.stat !== 'function') return undefined
  const root = join(process.env.DSH_HOME || join(homedir(), '.dsh'), SESSIONS_DIR)
  let workspaces
  try {
    workspaces = readdirSync(root, { withFileTypes: true })
  } catch (error) {
    // 根目录不存在等于"一个会话都没有",这是权威空快照而不是读取失败:
    // 新装或被清空时若回退持久层重试,会每秒重扫到新鲜窗口耗尽
    if (error?.code === 'ENOENT') return { items: [], partial: false }
    return undefined
  }
  const cutoff = nowTime - config.freshMs
  const fresh = []
  let partial = false
  for (const workspace of workspaces) {
    if (!workspace.isDirectory()) continue
    let entries
    try {
      entries = readdirSync(join(root, workspace.name), { withFileTypes: true })
    } catch {
      partial = true
      continue
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || !entry.name.startsWith(SESSION_DIR_PREFIX)) continue
      const path = findArtifact(join(root, workspace.name, entry.name))
      if (path === undefined) continue
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
  return { items: fresh, partial }
}

/**
 * 按文件修改时间筛出候选会话。
 *
 * 存储里可能有上千个会话,逐个解码全量事件是分钟级开销;真正需要恢复的只有
 * 最近 freshMs 内被写过的那几个。优先走目录扫描,失败时回落到持久层快照。
 */
async function listFreshSessions(ctx, config, nowTime, scanDirectory = listFreshByDirectory) {
  const persistence = ctx.get('sessionPersistence')
  const byDirectory = scanDirectory(config, nowTime, persistence)
  // 没有持久层服务就拿不到 header,无法区分子会话;此时应走全量回退而不是盲恢复
  if (byDirectory !== undefined && persistence === undefined) return undefined
  if (byDirectory !== undefined) {
    trace(`目录扫出 ${byDirectory.items.length} 个近期会话`)
    // 头部里带着 preset 与父子身份,只有命中的少数会话才需要问持久层
    let statFailed = false
    const statted = await Promise.all(
      byDirectory.items.map(async (item) => {
        try {
          return { item, snapshot: await persistence.stat?.(item.id) }
        } catch (error) {
          // 服务读失败不等于该会话不存在:整批当快照不完整处理,不能据此收工
          statFailed = true
          trace(`读取会话头失败 ${item.id}: ${error instanceof Error ? error.message : String(error)}`)
          return undefined
        }
      }),
    )
    const fresh = []
    for (const entry of statted) {
      if (entry === undefined) continue
      const header = entry.snapshot?.header
      // 没有头部就无法判定是不是子会话,跳过而不是按主会话恢复
      if (header === undefined) continue
      if (isDerivedSessionHeader(header)) continue
      fresh.push({
        id: entry.item.id,
        presetId: header?.agentPreset,
        mtimeMs: entry.item.mtimeMs,
        eventCount: entry.snapshot?.eventCount ?? 0,
      })
    }
    // 先小后大:大日志解压代价高,先让小的快速出结果,再处理残留的大会话
    fresh.sort((left, right) => left.eventCount - right.eventCount || right.mtimeMs - left.mtimeMs)
    // 有读失败时快照不完整:既不能宣称"没有待恢复会话",也不能退回持久层重列
    return { items: fresh, source: byDirectory.partial || statFailed ? 'partial' : 'directory' }
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
  return { items: fresh, source: 'persistence' }
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

/**
 * 本轮扫描是否可以收工。
 *
 * 目录扫描给出的是权威快照:空结果表示近期没有会话被写过,应当收工,
 * 否则冷启动后每 1s 重扫全目录直到新鲜窗口耗尽。持久层与全量回退的空列表
 * 可能只是服务尚未就绪,仍需重试;本轮预算用完时一律重试。
 */
export function scanSettled(result) {
  if (result.settled === true) return true
  if (!result.complete) return false
  // 快照不完整时既不能宣称扫完了,也不能据此认定剩余会话无需恢复
  if (result.source === 'partial') return false
  return result.source === 'directory' || result.listed > 0
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
  const result = { listed: 0, scanned: 0, resumed: 0, complete: true, source: undefined, settled: false }
  const deadline = Date.now() + budgetMs
  trace('扫描开始')
  // 关掉扫描或全局暂停是终态,不该按秒重试到新鲜窗口耗尽
  if (!config.scanOnBoot || config.paused) return { ...result, settled: true }
  const query = ctx.get('sessionQuery')
  if (query === undefined) {
    // 宿主没有会话查询面时重启恢复整体不可用,同样是终态
    trace('sessionQuery 缺失,放弃')
    return { ...result, settled: true }
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
  const listed = await listFreshSessions(ctx, config, now(), scanDirectory)
  const candidates = listed?.items ?? (await listAllSessions(ctx))
  if (candidates === undefined) return result
  // 候选来源决定空列表的含义:只有目录扫描能证明"近期没有会话被写过",
  // 持久层与全量回退的空列表都可能只是服务尚未就绪
  result.source = listed?.source ?? 'query'
  result.listed = candidates.length
  trace(
    listed === undefined
      ? `列出 ${candidates.length} 个存储会话(全量回退)`
      : `按修改时间筛出 ${candidates.length} 个候选会话(${result.source})`,
  )

  for (const candidate of candidates) {
    if (result.resumed >= config.scanLimit) {
      // 还有候选没处理,不能宣称本轮扫完
      result.complete = false
      break
    }
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
      const inbox = pendingInbox(events)
      const verdict = tailVerdict(events, now(), config, inbox)
      trace(`会话 ${sessionId} 事件 ${events.length} 判定 ${verdict}`)
      if (!verdict.startsWith('resume')) continue
      const agent = await materialize(ctx, sessionId, candidate.presetId)
      if (agent === undefined) continue
      // goal 已交回 driver 驱动:它自己会排下一轮,再补消息会多出一次重复回合
      if (rearmGoal(ctx, agent, config)) {
        result.resumed += 1
        trace(`已交回 goal 驱动 ${sessionId}`)
        ctx.logger?.info?.(`[keep-working] 重启恢复(goal) ${sessionId}`)
        continue
      }
      const message = createUserMessage({
        content: [{ type: 'text', text: resumeText(config, verdict) }],
        source: { kind: 'user' },
      })
      // 有排队消息时必须插队唤醒:followup 会追加到 next-turn 队尾,排在用户消息之后
      if (inbox.count > 0) agent.steer(message)
      else agent.followup(message)
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
