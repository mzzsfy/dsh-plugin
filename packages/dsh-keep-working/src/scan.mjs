/**
 * 重启扫描:把上次进程退出时未结案的存储会话重新拉起来。
 *
 * 宿主只在客户端打开会话时才物化 agent,所以冷启动时必须自己枚举存储、
 * 判定尾部状态、再按需 resume。
 */

import { closureVerdict, hasVisibleOutput, lastAssistantText, matchMarker, turnSlice } from './closure.mjs'
import { fillTemplate } from './config.mjs'
import { isTransientFailure, parseFailureFacts } from './failure.mjs'
import { rearmGoal } from './goal.mjs'
import { pendingInbox, QUEUED_RESUME_TEXT } from './inbox.mjs'
import { isDerivedSessionHeader } from './session-kind.mjs'
import { appendFileSync, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** 扫描结论落盘,重启恢复出问题时这是唯一可观测面。 */
const logFile = () => join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'keep-working-scan.log')

/** 重复日志的最小写入间隔:重试轮次逐条 appendFileSync 会白白占用主线程。 */
const TRACE_REPEAT_MS = 60_000

/** 降频表只记最近这些不同内容,避免会话 id 让表无限增长。 */
const TRACE_MEMORY = 200

/** 相同内容在间隔内只放行一次;会话级日志内容各带 id,天然互不影响。 */
export function createTraceThrottle(minIntervalMs = TRACE_REPEAT_MS) {
  const last = new Map()
  return (message, nowTime = Date.now()) => {
    const previous = last.get(message)
    if (previous !== undefined && nowTime - previous < minIntervalMs) return false
    if (last.size >= TRACE_MEMORY && previous === undefined) last.delete(last.keys().next().value)
    last.set(message, nowTime)
    return true
  }
}

const shouldTrace = createTraceThrottle()

export function trace(message) {
  if (!shouldTrace(message)) return
  try {
    appendFileSync(logFile(), `${new Date().toISOString()} ${message}\n`)
  } catch {}
}

/** 宿主重启产生的取消原因,值得在重启后补一次。 */
const RESTART_CANCEL_CAUSES = new Set(['disposed', 'legacy'])

/** 计入“最近 N 条消息”的事件类型;present 以交付事件为准。 */
const RECENT_MESSAGE_TYPES = new Set(['assistant/message', 'user/message', 'tool/result', 'deliverables/presented'])
const PRESENT_WINDOW = 10

/** 本回合最近 N 条会话消息里是否有 present。 */
function recentPresent(events, turn) {
  return turnSlice(events, turn)
    .filter((event) => RECENT_MESSAGE_TYPES.has(event?.type))
    .slice(-PRESENT_WINDOW)
    .some((event) => event.type === 'deliverables/presented')
}

/** 本回合最后一条 assistant 文本是否以结案标记结尾。 */
function lastMessageClosed(events, turn) {
  const text = lastAssistantText(events, turn)
  return text.trim() !== '' && matchMarker(text) !== null
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
  const reason = openTurn ? {} : (lastEnd.data?.reason ?? {})
  // 用户主动取消优先于排队消息:这是人的决定,不能被队列改写
  if (reason.kind === 'aborted' && !RESTART_CANCEL_CAUSES.has(reason.reason?.kind)) return 'skip:用户取消'
  // 有排队消息必须唤醒;结案标记不能让消息永远留在 durable inbox
  if (inbox.count > 0) return 'resume:queued'
  const turn = openTurn ? lastStart.data.turn : lastEnd.data.turn
  // 中断类回合不认 done/present:宿主可能杀在工具中途,标记不能证明过程完整
  const interruptedLike =
    openTurn || reason.kind === 'interrupted' || (reason.kind === 'aborted' && RESTART_CANCEL_CAUSES.has(reason.reason?.kind))
  if (!interruptedLike && turn !== undefined && (lastMessageClosed(events, turn) || recentPresent(events, turn))) {
    return 'skip:已结案'
  }
  if (openTurn) return 'resume:interrupted'

  switch (reason.kind) {
    case 'completed': {
      if (hasVisibleOutput(turnSlice(events, lastEnd.data.turn))) return 'skip:有可见回答'
      if (closureVerdict(events, lastEnd.data.turn, { enforce: config.enforceClosure }).reason === 'file-write-requires-present') {
        return 'resume:closure'
      }
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
      return 'resume:interrupted'
    // 宿主 pre-step 被拒(维护闸门、目标预约竞争)把回合记成 blocked:拒绝发生在步边界,
    // 不是模型声明受阻;归档会话在物化前已被排除,归档闸门的拒绝不会走到这里
    case 'blocked':
      return 'resume:interrupted'
    default:
      return 'skip:无需恢复'
  }
}

/**
 * 恢复文案:按尾部原因取对应说法。
 *
 * 冷启动扫描与实时路径分开配置:进程重启后说"dsh 已重启"是唯一能解释现状的信息,
 * 实时中断则沿用中断文案。截断 / 空回合 / 结案提醒各有专项文案,不并入重启文案。
 */
function resumeText(config, verdict) {
  const reason = verdict.slice('resume:'.length)
  if (reason === 'queued') return QUEUED_RESUME_TEXT
  const template =
    reason === 'max-tokens'
      ? config.continueTextMaxTokens
      : reason === 'silent'
        ? config.continueTextSilent
        : reason === 'closure'
          ? config.closureText
          : config.restartText
  return fillTemplate(template, {})
}

/**
 * agent 是否正在跑回合。
 *
 * 客户端打开会话只会物化一个空闲 agent,打开本身不等于接管:崩溃恢复时浏览器
 * 重连就打开上次的会话,若把这当成"交给用户",中断的回合永远没人续跑。
 * 真正的接管信号是有回合在跑,此时插话会与驱动方抢方向。
 */
const isDriving = (agent) => agent?.status === 'running'

/** 把存储会话恢复为 live agent;reused 表示判定期间会话已被客户端打开物化。 */
async function materialize(ctx, sessionId, presetId, inFlight) {
  // 前代已有在途 resume:等它收敛,不重复向宿主提交同一个恢复
  if (inFlight?.has(sessionId)) {
    try {
      await inFlight.get(sessionId)
    } catch {
      return { agent: undefined, reused: false }
    }
    const alive = ctx.agents.get(sessionId)
    return { agent: alive, reused: alive !== undefined }
  }
  const existing = ctx.agents.get(sessionId)
  if (existing !== undefined) return { agent: existing, reused: true }
  const selection = ctx.get('agentDefaultModel')?.currentSelection?.()
  const agentOptions =
    selection === undefined ? undefined : { provider: selection.provider, model: selection.model }
  const presets = ctx.get('agentPresets')
  // resume 是真正的写操作;同一会话跨代只允许一个在途 resume,后来代等前代收敛后再判定
  const track = async (pending) => {
    if (inFlight !== undefined) inFlight.set(sessionId, pending)
    try {
      await pending
    } finally {
      if (inFlight?.get(sessionId) === pending) inFlight.delete(sessionId)
    }
  }
  if (presets === undefined) {
    await track(ctx.agents.resume({ resumeSessionId: sessionId, agentOptions }))
    return { agent: ctx.agents.get(sessionId), reused: false }
  }
  // 不挂 preset 的 agent 没有工具与提示变量,恢复后发出的请求无路由。
  const resolvedId = (await presets.resolve(presetId)).id
  await track(ctx.agents.resume({
    resumeSessionId: sessionId,
    agentOptions,
    setup: async (agentCtx) => {
      await presets.mount(agentCtx, resolvedId)
    },
  }))
  return { agent: ctx.agents.get(sessionId), reused: false }
}

/** 单轮扫描预算:超出后收手,由调用方下一轮接着扫。 */
const SCAN_BUDGET_MS = 60_000

/** 重试间隔从 1s 指数退避到 60s;freshMs 只负责总窗口。 */
export const SCAN_RETRY_MIN_MS = 1_000
export const SCAN_RETRY_MAX_MS = 60_000

export function nextScanRetryMs(previous) {
  return Math.min(Math.max(previous, SCAN_RETRY_MIN_MS) * 2, SCAN_RETRY_MAX_MS)
}

/** 每检查这么多个会话让出一次事件循环。 */
const SCAN_YIELD_BATCH = 32

/** 会话持久层的落盘目录名,与宿主存储布局一致。 */
const SESSIONS_DIR = 'sessions'

/** 产物规范名:session.v<代际>.jsonl[.zstd],迁移中间产物与临时文件不匹配。 */
const SESSION_GENERATION = /^session(?:\.v(\d+))?\.jsonl(?:\.[a-z0-9]+)?$/

/** 会话产物路径:目录内按代际取最高的一份,避免升级后旧代际文件的旧 mtime 掩盖新写入。 */
function findArtifact(sessionDir) {
  let names
  try {
    names = readdirSync(sessionDir)
  } catch {
    return undefined
  }
  let best
  let bestGeneration = -1
  for (const name of names) {
    const match = SESSION_GENERATION.exec(name)
    if (match === null) continue
    const generation = Number(match[1] ?? 0)
    if (generation <= bestGeneration) continue
    best = name
    bestGeneration = generation
  }
  return best === undefined ? undefined : join(sessionDir, best)
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
      // 宿主会话 id 不保证 session- 前缀(import-*、裸 UUID 也合法),以产物形状判定
      if (!entry.isDirectory()) continue
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

/** 归档集合必须来自宿主权威服务;读不到就抛错,调用方按未知处理。 */
function readArchivedSessionIds(ctx) {
  const registry = ctx.get('workspaceRegistry')
  if (registry === undefined) throw new Error('工作区服务缺失')
  const ids = registry.archivedSessionIds
  // 未就绪时不能把缺失字段当空集:空集会被误读成"没有归档会话"
  if (ids === null || typeof ids?.[Symbol.iterator] !== 'function') throw new Error('归档集合未就绪')
  return new Set(ids)
}

/**
 * 扫描并恢复;返回本轮观察与恢复数量。
 * signal/isActive 供卸载或换代时中止在途扫描;pendingTakeovers/takeover 用于 resume 在途换代时的跨代投递。
 */
export async function scanStoredSessions({
  ctx,
  config,
  createUserMessage,
  now = Date.now,
  budgetMs = SCAN_BUDGET_MS,
  seen = new Set(),
  pendingTakeovers = undefined,
  takeover = undefined,
  inFlightResumes = undefined,
  scanDirectory = listFreshByDirectory,
  signal = undefined,
  isActive = undefined,
}) {
  const result = { listed: 0, scanned: 0, resumed: 0, complete: true, source: undefined, settled: false }
  const deadline = Date.now() + budgetMs
  // 卸载/重建后旧代扫描必须立刻失效:每次 await 之后都重新确认,不能把消息补进新代运行期
  const active = () => signal?.aborted !== true && (isActive === undefined || isActive())
  const stop = () => {
    result.complete = false
    result.cancelled = true
    return result
  }
  // 投递旧代在 resume 在途时物化出的 agent;retry 表示失败,调用方保留待重排
  const deliverPending = (sessionId, pending) => {
    if (ctx.agents.get(sessionId) !== pending.agent) {
      trace(`接管恢复跳过 ${sessionId}: agent 已不在`)
      return 'drop'
    }
    // 旧代按结案强制排的提醒,新代设置关闭后按新的空回合口径重判
    let verdict = pending.verdict
    if (verdict === 'resume:closure' && !config.enforceClosure) {
      if (!config.resumeSilentTurns) {
        trace(`接管恢复跳过 ${sessionId}: 结案强制已关闭`)
        return 'drop'
      }
      verdict = 'resume:silent'
    }
    try {
      if (rearmGoal(ctx, pending.agent, config)) {
        result.resumed += 1
        trace(`新代接管恢复(goal) ${sessionId}`)
        return 'delivered'
      }
      const message = createUserMessage({
        content: [{ type: 'text', text: resumeText(config, verdict) }],
        source: { kind: 'user' },
      })
      if (pending.inbox.count > 0) pending.agent.steer(message)
      else pending.agent.followup(message)
      result.resumed += 1
      trace(`新代接管恢复 ${sessionId}`)
      ctx.logger?.info?.(`[keep-working] 新代接管恢复 ${sessionId}`)
      return 'delivered'
    } catch (error) {
      result.complete = false
      trace(`接管恢复失败 ${sessionId}: ${error instanceof Error ? error.message : String(error)}`)
      return 'retry'
    }
  }
  trace('扫描开始')
  // 关掉扫描或全局暂停是终态,不该按秒重试到新鲜窗口耗尽
  if (!config.scanOnBoot || config.paused) return { ...result, settled: true }
  if (!active()) return stop()
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
    archived = readArchivedSessionIds(ctx)
  } catch (error) {
    trace(`归档集合未就绪,本轮不恢复: ${error instanceof Error ? error.message : String(error)}`)
    result.complete = false
    return result
  }
  trace(`已归档 ${archived.size} 个`)
  // 上一代 resume 在途时被换代打断:物化出的 agent 已属宿主,交新代完成投递。
  // 必须先复核归档集合,已归档会话不得因待接管项被重新拉起。
  if (pendingTakeovers !== undefined && pendingTakeovers.size > 0) {
    for (const [sessionId, pending] of [...pendingTakeovers]) {
      if (archived.has(sessionId)) {
        pendingTakeovers.delete(sessionId)
        trace(`接管恢复跳过 ${sessionId}: 已归档`)
        continue
      }
      const outcome = deliverPending(sessionId, pending)
      if (outcome !== 'retry') {
        pendingTakeovers.delete(sessionId)
        // 已投递的会话在同一轮里不得再走判定:投递后它是空闲 live agent,会再补一条
        seen.add(sessionId)
      }
    }
  }
  const listed = await listFreshSessions(ctx, config, now(), scanDirectory)
  if (!active()) return stop()
  const candidates = listed?.items ?? (await listAllSessions(ctx))
  if (!active()) return stop()
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
    if (!active()) return stop()
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
    // 旧代 resume 恰在本代 listSessions/stat 阻塞期间收敛:先投递,不能再被 live-agent 短路
    const pending = pendingTakeovers?.get(sessionId)
    if (pending !== undefined) {
      if (archived.has(sessionId)) {
        pendingTakeovers.delete(sessionId)
        trace(`接管恢复跳过 ${sessionId}: 已归档`)
        continue
      }
      const outcome = deliverPending(sessionId, pending)
      if (outcome !== 'retry') pendingTakeovers.delete(sessionId)
      continue
    }
    if (isDerivedSessionHeader(candidate.header ?? { id: sessionId })) continue
    if (candidate.live === true) continue
    // 已 live 但空闲不构成接管:客户端打开会话就会物化 agent,判定后照常补恢复消息
    const liveAgent = ctx.agents.get(sessionId)
    if (liveAgent !== undefined && isDriving(liveAgent)) {
      trace(`会话 ${sessionId} 正在跑回合,跳过恢复`)
      continue
    }
    if (archived.has(sessionId)) {
      trace(`会话 ${sessionId} 已归档,跳过恢复`)
      continue
    }
    // 跨轮去重:已经裁决过的会话不再重复冷读,预算才能推进到后续会话
    if (seen.has(sessionId)) continue
    // 前代 resume 尚未收敛:本轮跳过并保持未完成,等它完成/交接后再判定
    if (inFlightResumes?.has(sessionId)) {
      result.complete = false
      continue
    }
    seen.add(sessionId)
    // 只有真正裁决完(跳过或恢复成功)才保留去重登记;中止/异常路径由 finally 撤销
    let adjudicated = false

    let observation
    try {
      observation = await query.observeSession(sessionId, { projectionMode: 'none', signal })
      if (!active()) return stop()
      const events = observation?.events
      if (!Array.isArray(events) || events.length === 0) {
        adjudicated = true
        continue
      }
      result.scanned += 1
      const inbox = pendingInbox(events)
      const verdict = tailVerdict(events, now(), config, inbox)
      trace(`会话 ${sessionId} 事件 ${events.length} 判定 ${verdict}`)
      if (!verdict.startsWith('resume')) {
        adjudicated = true
        continue
      }
      // 归档集合只在轮次开头快照过;observeSession 可能很慢,物化前必须复核权威集合
      let archivedNow
      try {
        archivedNow = readArchivedSessionIds(ctx)
      } catch (error) {
        trace(`归档集合复核失败,跳过 ${sessionId}: ${error instanceof Error ? error.message : String(error)}`)
        result.complete = false
        continue
      }
      if (!active()) return stop()
      if (archivedNow.has(sessionId)) {
        trace(`会话 ${sessionId} 已归档,跳过恢复`)
        adjudicated = true
        continue
      }
      const materialized = await materialize(ctx, sessionId, candidate.presetId, inFlightResumes)
      if (!active()) {
        // resume 在途时换代: agent 已经物化,交新代投递消息;新代据此重新接管该会话
        if (materialized.agent !== undefined && !materialized.reused && takeover?.({
          sessionId,
          agent: materialized.agent,
          inbox,
          verdict,
        }) === true) {
          trace(`会话 ${sessionId} 物化后换代,交新代投递`)
        }
        return stop()
      }
      // 等待跨代 resume 收敛期间旧代可能刚落出待接管项:先投递,不能被 reused 短路
      const handedOff = pendingTakeovers?.get(sessionId)
      if (handedOff !== undefined) {
        if (archivedNow.has(sessionId)) {
          pendingTakeovers.delete(sessionId)
          trace(`接管恢复跳过 ${sessionId}: 已归档`)
          adjudicated = true
          continue
        }
        const outcome = deliverPending(sessionId, handedOff)
        if (outcome !== 'retry') pendingTakeovers.delete(sessionId)
        adjudicated = outcome !== 'retry'
        continue
      }
      // 物化必须真的得到 live agent;拿不到按失败处理,下一轮重试
      if (materialized.agent === undefined) throw new Error('物化失败: 未得到 live agent')
      const agent = materialized.agent
      // 判定期间会话被客户端打开或被别的驱动方接管:正在跑回合则让路,空闲仍补恢复消息
      if (isDriving(agent)) {
        trace(`会话 ${sessionId} 正在跑回合,跳过恢复`)
        adjudicated = true
        continue
      }
      if (materialized.reused) trace(`会话 ${sessionId} 已 live 且空闲,直接补恢复消息`)
      // goal 已交回 driver 驱动:它自己会排下一轮,再补消息会多出一次重复回合
      if (rearmGoal(ctx, agent, config)) {
        result.resumed += 1
        adjudicated = true
        trace(`已交回 goal 驱动 ${sessionId}`)
        ctx.logger?.info?.(`[keep-working] 重启恢复(goal) ${sessionId}`)
        continue
      }
      const message = createUserMessage({
        content: [{ type: 'text', text: resumeText(config, verdict) }],
        source: { kind: 'user' },
      })
      if (!active()) return stop()
      // 有排队消息时必须插队唤醒:followup 会追加到 next-turn 队尾,排在用户消息之后
      try {
        if (inbox.count > 0) agent.steer(message)
        else agent.followup(message)
      } catch (error) {
        // agent 已 live,后续轮次不会再走物化分支;把本次未完成的投递留待重排
        pendingTakeovers?.set(sessionId, { sessionId, agent, inbox, verdict, at: Date.now() })
        throw error
      }
      result.resumed += 1
      adjudicated = true
      trace(`已恢复 ${sessionId}`)
      ctx.logger?.info?.(`[keep-working] 重启恢复 ${sessionId}`)
    } catch (error) {
      trace(`处理失败 ${sessionId ?? '?'}: ${error instanceof Error ? error.message : String(error)}`)
      ctx.logger?.warn?.(
        `[keep-working] 扫描 ${sessionId} 失败: ${error instanceof Error ? error.message : String(error)}`,
      )
      // 单会话失败不代表已裁决:下一轮必须重试,本轮也不能宣称扫完
      result.complete = false
    } finally {
      // 中止或异常后撤销本会话的本代登记,下一轮/新代必须还能重新接管
      if (!adjudicated) seen.delete(sessionId)
      observation?.[Symbol.dispose]?.()
      // 长扫描逐批让出事件循环,否则宿主在冷启动窗口内无法响应其它请求
      if (result.scanned > 0 && result.scanned % SCAN_YIELD_BATCH === 0) {
        await new Promise((resolve) => setTimeout(resolve, 0))
      }
    }
  }
  // 旧代在本轮列表等待期间落下的交接若还没投递,必须重试而不是收工
  if (pendingTakeovers !== undefined && pendingTakeovers.size > 0) result.complete = false
  return result
}
