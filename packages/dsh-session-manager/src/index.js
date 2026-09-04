// dsh-session-manager Host 半区:自动归档评估 + 取消归档 + 删除(回收站) + 已删除台账与重挂载。
// 评估三触发源共用同一门闩:新会话创建(session/created,按工作区限定)、settings 就绪后的
// 启动补扫(全量)、每日周期轮(全量,经宿主 timer 软依赖);取消归档与删除后的归档清理经
// workspace 域 global 直写 archivedSessionIds 并同步注册表进程内快照(官方无 unarchive 表面,
// 域写入经 domain/changed 触发 workspace.follow 的 archived 帧);删除按失败矩阵
// 执行 locate → trash → detach → 归档清理,台账记录删除产物路径供回收站还原后
// 一键重挂载(官方 attachSession)。面板数据不在此处:client 侧以 session.list
// 行与归档集合做交集。

import { open, realpath, stat } from 'node:fs/promises'
import { dirname } from 'node:path'

import schemastery from '@deepseek-ai/schemastery'
import { z } from 'zod'
import { defineDomain } from '@deepseek-ai/dsh-storage-domain'

import {
  DAY_MS,
  DEFAULT_AUTO_ARCHIVE_DAYS,
  DEFAULT_AUTO_ARCHIVE_INTERVAL_HOURS,
  DELETE_CODES,
  artifactLooksBlank,
  deleteEligibility,
  deleteOutcome,
  isSessionRunning,
  mergeDeletedEntry,
  removeDeletedEntry,
  selectArchiveCandidates,
  updatedAtOf,
} from './core.mjs'
import { trashPath } from './trash.mjs'

export const name = 'dsh-session-manager'

export const inject = ['webServer', 'workspaceRegistry', 'sessionQuery', 'storageDomain', 'agents', 'sessions', 'sessionPersistence']

const NAMESPACE = 'session-manager'
const WORKSPACE_DOMAIN_NAME = 'workspace'

// 已删除台账域:global 单列表,条目为回收站还原后重挂载所需的最小信息
const LEDGER_SPEC = defineDomain({
  name: 'session_manager',
  version: 1,
  tables: {},
  global: {
    schema: z.object({
      deleted: z.array(z.object({
        sessionId: z.string(),
        path: z.string(),
        deletedAt: z.number(),
      })),
    }),
    initial: { deleted: [] },
  },
})

const BLANK_PROBE_CHUNK_BYTES = 64 * 1024
// 台账条目上限:超过即裁掉最旧条目(数组头部为新,尾部最旧),防无界增长写放大
const LEDGER_MAX_ENTRIES = 200
// 自动归档评估整体超时:宿主服务挂起时不因门闩未复位而永久停摆
const EVALUATION_TIMEOUT_MS = 30 * 1000
const HOUR_MS = 60 * 60 * 1000
// 周期评估固定短 tick:tick 内做到期判断,间隔设置变更自下一周期生效
const PERIODIC_TICK_MS = 60 * 1000
// 台账单次读改写超时:宿主存储域挂起时锁内 job 超时放行,防互斥链死锁与 inFlight 泄漏
const LEDGER_OP_TIMEOUT_MS = 10 * 1000

// 路由响应文案;导出供测试断言与实现同步
export const MESSAGES = {
  unsupportedBackend: '当前存储后端不支持按会话删除',
  notArchived: '仅已归档会话可删除',
  unknownSession: '会话不存在',
  running: '运行中的会话不可删除',
  trashFailed: '移入回收站失败',
  partial: '已移入回收站,但移除列表记录失败',
  archiveCleanup: '已移入回收站,但移除归档记录失败',
  ledgerFailed: '已移入回收站,但重挂载记录失败',
  notRestored: '会话产物不在持久层,请先到系统回收站还原后重试',
  ghostCleanup: '产物已不存在,已完成列表清理',
  ghostDetach: '产物已不存在,但移除列表记录失败',
  ghostArchiveSuffix: ',且移除归档记录失败',
  noWorkspace: '未找到会话所属工作区,无法重新挂载',
  ledgerCleanup: '已重新挂载,但清除台账记录失败;可在「已删除」区移除记录收尾',
  ledgerSuffix: ',且重挂载记录失败',
  inFlight: '该会话正在删除中,请稍后重试',
  badJsonBody: '请求体不是合法 JSON',
  systemError: '操作失败(系统级错误,详见服务端日志)',
  runningDuringTrash: '警告:回收期间会话恢复运行,产物已移入回收站;建议检查会话状态',
}

// trash 执行器出口:进程级唯一 OS 副作用注入点,测试经此桩替
export const executor = { trashPath }

const SETTINGS_SCHEMA = schemastery.object({
  autoArchiveDays: schemastery.number().min(0).step(1).default(DEFAULT_AUTO_ARCHIVE_DAYS)
    .description('自动归档阈值天数,0 表示关闭;新会话创建、启动与周期评估时生效'),
  autoArchiveIntervalHours: schemastery.number().min(0).step(1).default(DEFAULT_AUTO_ARCHIVE_INTERVAL_HOURS)
    .description('周期评估间隔小时数,0 表示关闭周期评估;变更经周期 tick 对账,关闭即时暂停、重启用最迟下个 tick 生效'),
})

function sendJson(res, status, payload) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(payload))
}

// 错误响应出口:业务错误(Error 无错误码)原样透传消息;系统级错误(带 fs 错误码,
// message 内嵌绝对路径)收敛为固定文案,原始错误仅进服务端日志
function respondError(ctx, res, error) {
  const isSystem = Boolean(error && typeof error.code === 'string' && error.code !== '')
  if (isSystem && ctx.logger) ctx.logger.warn('session-manager 系统级错误: ' + String(error && error.stack || error))
  const message = isSystem
    ? MESSAGES.systemError
    : (error && error.message ? error.message : String(error))
  sendJson(res, 400, { error: message })
}

function readSettings(ctx) {
  const settings = ctx.get('settings')
  const value = settings ? settings.get(NAMESPACE) : undefined
  const days = Number(value && value.autoArchiveDays)
  const hours = Number(value && value.autoArchiveIntervalHours)
  return {
    days: Number.isInteger(days) && days >= 0 ? days : DEFAULT_AUTO_ARCHIVE_DAYS,
    intervalHours: Number.isInteger(hours) && hours >= 0 ? hours : DEFAULT_AUTO_ARCHIVE_INTERVAL_HOURS,
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

async function requireSessionId(req) {
  // 协议错误与业务错误分通道:JSON 解析失败给固定中文文案,不透出引擎 SyntaxError
  let body
  try {
    body = JSON.parse(await readBody(req))
  } catch {
    throw new Error(MESSAGES.badJsonBody)
  }
  const sessionId = body && typeof body.sessionId === 'string' ? body.sessionId.trim() : ''
  if (sessionId.length === 0) throw new Error('sessionId 不能为空')
  return sessionId
}

/** JSONL 产物空白探测:读文件头部,不足两行即视为空白会话。 */
async function artifactIsBlank(path) {
  let handle
  try {
    handle = await open(path, 'r')
    const { buffer, bytesRead } = await handle.read(
      Buffer.allocUnsafe(BLANK_PROBE_CHUNK_BYTES), 0, BLANK_PROBE_CHUNK_BYTES, 0)
    const headText = buffer.toString('utf8', 0, bytesRead)
    return artifactLooksBlank(headText, bytesRead === BLANK_PROBE_CHUNK_BYTES)
  } catch {
    // 产物不可读(已被移走等)时按非空白处理,宁可漏归档不可误归档
    return false
  } finally {
    if (handle !== undefined) await handle.close().catch(() => {})
  }
}

function rejectMethod(req, res, method) {
  if (req.method === method) return true
  sendJson(res, 405, { error: 'method not allowed' })
  return false
}

/** @param {import('@deepseek-ai/cordis').Context} ctx */
export function apply(ctx, config) {
  let evaluating = false
  // 删除路由同 id 并发去重(进程内)
  const inFlightDeletes = new Set()

  // 台账域:应用装载即打开,路由内 await;打开失败由路由响应,此处仅防未处理拒绝
  const ledgerReady = ctx.storageDomain.open(LEDGER_SPEC)
  ledgerReady.catch(() => {})
  ctx.effect(() => () => {
    void ledgerReady.then((domain) => domain.close()).catch(() => {})
  }, 'session-manager ledger domain')

  // 周期评估状态:running 供设置页降级提示;timer 为软依赖,服务缺失不阻塞插件装载
  const periodic = { running: false, reason: '' }

  // 自动归档评估:筛出待归档会话并逐个走官方 archiveSession。cwd 缺省时全量评估
  // (启动补扫 / 周期轮),传入 cwd 时仅评估该工作区(新建会话触发)。
  // 门闩与超时守卫对全部触发源生效。两级筛选:先用 createdAt 纯内存预筛(mtime 只会
  // 增大 updatedAt,createdAt 未超期必不超期),仅对预筛存活者做产物 stat/blank 探测,
  // 活跃会话零 IO。返回是否真正启动:被门闩/关闭挡下的调用方(周期 tick)保持到期态
  // 由下个 tick 重试,不得据此重排周期
  function evaluateArchives(cwd) {
    const { days } = readSettings(ctx)
    if (days === 0 || evaluating) return false
    evaluating = true
    let timeoutGuard
    const work = (async () => {
      const registry = ctx.workspaceRegistry
      const archived = new Set(registry.archivedSessionIds.map(String))
      const sessionsService = ctx.get('sessions')
      const agents = ctx.get('agents')
      const persistence = ctx.get('sessionPersistence')
      const records = await ctx.sessionQuery.listSessions()
      const nowMs = Date.now()
      const cutoff = nowMs - days * DAY_MS
      const candidates = []
      for (const recordItem of records) {
        const header = recordItem.header
        if (cwd !== undefined && header.cwd !== cwd) continue
        // 预筛:createdAt 未超期必不超期(见上),跳过产物 IO
        if (header.createdAt >= cutoff) continue
        // 已归档记录永不是候选,集合随历史增长,提前跳过省产物 IO
        if (archived.has(String(header.id))) continue
        const live = sessionsService && sessionsService.get(header.id)
        const running = isSessionRunning({ agents, sessionId: header.id })
        const located = persistence && persistence.locate(header)
        // locate 缺失(第三方后端不支持定位)与产物不可读同规跳过:仅凭 createdAt
        // 判活跃会绕过 mtime 保护,与 delete 的 unsupportedBackend 拒绝口径对齐
        if (!located) continue
        const activityAt = await safeMtime(located.path)
        // 产物不可读视为已删除,不参与归档:否则删除后的会话(重连前仍在持久层
        // 列表中)会因超期被重新归档,面板行复活且无法再删
        if (activityAt === null) continue
        // stat 后即可判活跃度:未超期不必做空白探测
        const updatedAt = updatedAtOf(header, activityAt)
        if (updatedAt >= cutoff) continue
        const blank = live ? live.seq === 0 : Boolean(await artifactIsBlank(located.path))
        candidates.push({
          id: String(header.id),
          archived: false,
          running,
          blank,
          updatedAt,
        })
      }
      for (const id of selectArchiveCandidates({ records: candidates, nowMs, thresholdDays: days })) {
        try {
          await registry.archiveSession(id)
        } catch (error) {
          // 单个归档失败不中断整轮,剩余候选继续;失败者由下一次触发重试
          ctx.logger && ctx.logger.warn('session-manager 归档 ' + id + ' 失败: ' + String(error))
        }
      }
    })()
    // 门闩挂起兜底:宿主服务永不返回时超时复位,保证后续评估不被永久跳过
    const timeout = new Promise((_, reject) => {
      timeoutGuard = setTimeout(() => reject(new Error('自动归档评估超时')), EVALUATION_TIMEOUT_MS)
    })
    void Promise.race([work, timeout]).catch((error) => {
      ctx.logger && ctx.logger.warn('session-manager 自动归档评估失败: ' + String(error))
    }).finally(() => {
      clearTimeout(timeoutGuard)
      evaluating = false
      void work.catch(() => {})
    })
    return true
  }

  ctx.on('session/created', (session) => {
    const cwd = session.header && session.header.cwd
    if (cwd === undefined) return
    evaluateArchives(cwd)
  })

  // 取消归档:直写 workspace 域 global,无官方 API 可用。注册表把域 global 快照到
  // 进程内 state 且只在自身写路径同步,直写后必须把快照一并改掉:否则注册表后续
  // 全量写回(含自动归档)与 workspace.list 重连基线都会复活该 id,官方归档的幂等
  // 判定也会因旧快照静默跳过。合并 durable 与快照再移除,可自愈历史失同步与清理
  // 半失败(经取消归档重试即补全),代价是快照中的陈旧 id 会随任一次清理重新落盘,
  // 可经再次取消归档清除。inject 保证注册表就绪,快照缺失即上游形态变更,loud fail;
  // 域 global 仅支持整体写回,读改写窗口若与注册表两阶段变更交错,理论上可回退其
  // pendingMutation/workspaceIds 中间态,下次启动 validateStoredState 将 loud fail,
  // 窗口极窄且域 API 无原子原语可用,属已知取舍(详见 README)。
  async function removeArchivedId(sessionId) {
    const domain = ctx.storageDomain.get(WORKSPACE_DOMAIN_NAME)
    if (domain === undefined) throw new Error('workspace 域未打开')
    const durable = domain.global.get()
    const cached = ctx.workspaceRegistry.state
    if (cached === undefined) throw new Error('workspace 注册表快照不可用')
    const merged = new Set(durable.archivedSessionIds.map(String))
    for (const id of cached.archivedSessionIds) merged.add(String(id))
    if (!merged.delete(String(sessionId))) return
    const next = { ...durable, archivedSessionIds: [...merged] }
    await domain.global.set(next)
    ctx.workspaceRegistry.state = next
  }

  // 台账记账:trash 成功即记录,路径为回收站「原位置」还原所需。
  // ledgerChain 串行化所有读改写:get→set 交错时后写者会用旧快照整体覆盖,丢条目。
  // 逐 job 超时兜底:宿主存储域挂起时超时放行,防链条死锁与 inFlightDeletes 泄漏;
  // 超时的写操作后台落盘仍安全(合并/移除均为幂等语义)
  let ledgerChain = Promise.resolve()
  function withLedgerLock(job) {
    const runJob = () => Promise.race([
      job(),
      new Promise((_, reject) => setTimeout(
        () => reject(new Error('台账操作超时(' + LEDGER_OP_TIMEOUT_MS / 1000 + 's)')),
        LEDGER_OP_TIMEOUT_MS)),
    ])
    const run = ledgerChain.then(runJob, runJob)
    ledgerChain = run.catch(() => {})
    return run
  }

  async function recordDeletedEntry(sessionId, path) {
    return withLedgerLock(async () => {
      const ledger = await ledgerReady
      const current = ledger.global.get()
      const merged = mergeDeletedEntry(current.deleted, { sessionId, path, deletedAt: Date.now() })
      await ledger.global.set({ ...current, deleted: merged.slice(0, LEDGER_MAX_ENTRIES) })
    })
  }

  // 台账移除:幂等,未命中不产生写回
  async function removeLedgerEntry(sessionId) {
    return withLedgerLock(async () => {
      const ledger = await ledgerReady
      const current = ledger.global.get()
      const { deleted, removed } = removeDeletedEntry(current.deleted, sessionId)
      if (removed) await ledger.global.set({ ...current, deleted })
    })
  }

  // 台账命中查询:同 id 曾删除过(重删场景的幽灵资格依据);域不可用时按未命中
  async function ledgerHasEntry(sessionId) {
    try {
      const ledger = await ledgerReady
      return ledger.global.get().deleted.some((item) => item.sessionId === sessionId)
    } catch {
      return false
    }
  }

  // 幽灵残留清理:产物已缺失的会话仅解除列表可见性(detach + 归档清理),
  // 无回收与台账动作;失败点聚合成后缀,重试即补全
  async function cleanupDeletedSession(sessionId) {
    let suffix = ''
    const detachError = await detachSession(ctx, sessionId)
    if (detachError !== undefined) suffix = MESSAGES.ghostDetach
    try {
      await removeArchivedId(sessionId)
    } catch {
      suffix += MESSAGES.ghostArchiveSuffix
    }
    return suffix
  }

  const routes = [
    {
      path: '/api/session-manager/unarchive',
      handler: async (req, res) => {
        if (!rejectMethod(req, res, 'POST')) return
        try {
          await removeArchivedId(await requireSessionId(req))
          sendJson(res, 200, { ok: true })
        } catch (error) {
          respondError(ctx, res, error)
        }
      },
    },
    {
      path: '/api/session-manager/info',
      handler: async (req, res) => {
        if (!rejectMethod(req, res, 'POST')) return
        try {
          const sessionId = await requireSessionId(req)
          const header = await findHeader(ctx, sessionId)
          if (header === undefined) {
            sendJson(res, 400, { error: MESSAGES.unknownSession })
            return
          }
          const persistence = ctx.get('sessionPersistence')
          const location = persistence ? persistence.locate(header) : undefined
          if (location === undefined) {
            sendJson(res, 200, { supported: false })
            return
          }
          let info
          try {
            info = await stat(location.path)
          } catch (error) {
            // live 记录可指向已删除会话,产物缺失是常规状态而非故障
            if (error && error.code === 'ENOENT') {
              sendJson(res, 200, { supported: true, sizeBytes: 0, missing: true })
              return
            }
            throw error
          }
          sendJson(res, 200, { supported: true, sizeBytes: info.size })
        } catch (error) {
          respondError(ctx, res, error)
        }
      },
    },
    {
      path: '/api/session-manager/delete',
      handler: async (req, res) => {
        if (!rejectMethod(req, res, 'POST')) return
        const sessionId = await requireSessionId(req).catch((error) => {
          respondError(ctx, res, error)
          return undefined
        })
        if (sessionId === undefined) return
        // 同 id 去重:并发第二次删除会走幽灵清理,语义混乱且响应文案不一致
        if (inFlightDeletes.has(sessionId)) {
          sendJson(res, 400, { error: MESSAGES.inFlight })
          return
        }
        inFlightDeletes.add(sessionId)
        try {
          const header = await findHeader(ctx, sessionId)
          if (header === undefined) {
            sendJson(res, 400, { error: MESSAGES.unknownSession })
            return
          }
          // 运行中守卫:与归档评估同款判据,落实"运行中会话永不被删除"不变量
          if (isSessionRunning({ agents: ctx.get('agents'), sessionId })) {
            sendJson(res, 400, { error: MESSAGES.running })
            return
          }
          const persistence = ctx.get('sessionPersistence')
          const location = persistence ? persistence.locate(header) : undefined
          if (location === undefined) {
            sendJson(res, 400, { error: MESSAGES.unsupportedBackend })
            return
          }
          // locate 返回会话目录下的日志文件;回收对象是目录整体,残留空目录会让
          // 已删除会话在面板以空壳复活。缺失判定按目录级:日志缺失但目录在(半删除
          // 残留)仍走完整回收,目录消失才是幽灵
          const artifactDir = dirname(location.path)
          let artifactMissing = false
          try {
            await stat(artifactDir)
          } catch (error) {
            if (error && error.code !== 'ENOENT') throw error
            artifactMissing = true
          }
          if (artifactMissing) {
            // 幽灵资格:已归档或台账有记录(同 id 重删的残留清理)才放行;
            // 两者皆无的 ENOENT 可能是新建会话尚未落盘,剥离活会话属于破坏性误删
            const archivedNow = ctx.workspaceRegistry.archivedSessionIds.map(String).includes(sessionId)
            if (!archivedNow && !(await ledgerHasEntry(sessionId))) {
              sendJson(res, 400, { error: MESSAGES.notArchived })
              return
            }
            const cleanupError = await cleanupDeletedSession(sessionId)
            if (cleanupError !== '') {
              sendJson(res, 200, { ok: true, partial: true, message: cleanupError })
              return
            }
            sendJson(res, 200, { ok: true, message: MESSAGES.ghostCleanup })
            return
          }
          // host 端到端权威:归档资格在执行前校验
          const eligibility = deleteEligibility({
            archivedIds: ctx.workspaceRegistry.archivedSessionIds.map(String),
            sessionId,
          })
          if (!eligibility.ok) {
            sendJson(res, 400, { error: MESSAGES.notArchived })
            return
          }
          // TOCTOU 复检:守卫通过到执行间存在多个 await 间隙,会话可能已恢复运行
          if (isSessionRunning({ agents: ctx.get('agents'), sessionId })) {
            sendJson(res, 400, { error: MESSAGES.running })
            return
          }
          let trashError
          try {
            await executor.trashPath(artifactDir)
          } catch (error) {
            trashError = error
          }
          const outcome = deleteOutcome({ located: true, trashError })
          if (outcome.code === DELETE_CODES.TRASH_FAILED) {
            sendJson(res, 400, { error: MESSAGES.trashFailed + ': ' + String(outcome.error) })
            return
          }
          // 执行期翻转检测:OS 回收存在数百 ms 异步窗口,复检通过后仍可能恢复运行。
          // 产物已移走,中断只会更糟,照常完成收尾,但把不变量破坏变为可观测事件
          if (isSessionRunning({ agents: ctx.get('agents'), sessionId })) {
            ctx.logger && ctx.logger.warn('session-manager 删除执行期间会话恢复运行: ' + sessionId)
          }
          const runningDuringTrash = isSessionRunning({ agents: ctx.get('agents'), sessionId })
          // 台账在 trash 成功后立即记录:产物已进回收站,后续任何半失败都不影响还原资格;
          // 台账失败只降级重挂载便利,不回滚删除
          let ledgerError
          try {
            await recordDeletedEntry(sessionId, artifactDir)
          } catch (error) {
            ledgerError = error
          }
          const ledgerFailedSuffix = ledgerError !== undefined ? MESSAGES.ledgerSuffix : ''
          // 执行期翻转向用户显式告警;各 partial 分支聚合该警告
          const trashWindowSuffix = runningDuringTrash ? ';' + MESSAGES.runningDuringTrash : ''
          const detachError = await detachSession(ctx, sessionId)
          if (detachError !== undefined) {
            sendJson(res, 200, { ok: true, partial: true, message: MESSAGES.partial + ledgerFailedSuffix + trashWindowSuffix })
            return
          }
          // 归档集合同步清理:残留 id 会让面板行持续可见;detach 失败时不清理,
          // 保留归档资格供重试
          try {
            await removeArchivedId(sessionId)
          } catch {
            sendJson(res, 200, { ok: true, partial: true, message: MESSAGES.archiveCleanup + ledgerFailedSuffix + trashWindowSuffix })
            return
          }
          if (ledgerError !== undefined) {
            sendJson(res, 200, { ok: true, partial: true, message: MESSAGES.ledgerFailed + trashWindowSuffix })
            return
          }
          sendJson(res, 200, runningDuringTrash
            ? { ok: true, message: MESSAGES.runningDuringTrash }
            : { ok: true })
        } catch (error) {
          respondError(ctx, res, error)
        } finally {
          inFlightDeletes.delete(sessionId)
        }
      },
    },
    {
      path: '/api/session-manager/status',
      handler: async (req, res) => {
        if (!rejectMethod(req, res, 'GET')) return
        sendJson(res, 200, { periodic: { ...periodic } })
      },
    },
    {
      path: '/api/session-manager/deleted',
      handler: async (req, res) => {
        if (!rejectMethod(req, res, 'GET')) return
        try {
          const ledger = await ledgerReady
          sendJson(res, 200, { deleted: ledger.global.get().deleted })
        } catch (error) {
          respondError(ctx, res, error)
        }
      },
    },
    {
      path: '/api/session-manager/remount',
      handler: async (req, res) => {
        if (!rejectMethod(req, res, 'POST')) return
        try {
          const sessionId = await requireSessionId(req)
          // 产物还原的判定即持久层能重新读到 header:未还原时在此拒绝
          const header = await findHeader(ctx, sessionId)
          if (header === undefined) {
            sendJson(res, 400, { error: MESSAGES.notRestored })
            return
          }
          const workspace = await findWorkspaceByCwd(ctx, header.cwd)
          if (workspace === undefined) {
            sendJson(res, 400, { error: MESSAGES.noWorkspace })
            return
          }
          // 官方挂载通道:自带 header cwd 校验,失败即整体拒绝,台账保留供重试
          await workspace.attachSession(sessionId)
          // 挂载已成功:台账清除失败只影响收尾,不得报成挂载失败
          try {
            await removeLedgerEntry(sessionId)
          } catch {
            sendJson(res, 200, { ok: true, partial: true, message: MESSAGES.ledgerCleanup })
            return
          }
          sendJson(res, 200, { ok: true })
        } catch (error) {
          respondError(ctx, res, error)
        }
      },
    },
    {
      path: '/api/session-manager/forget',
      handler: async (req, res) => {
        if (!rejectMethod(req, res, 'POST')) return
        try {
          await removeLedgerEntry(await requireSessionId(req))
          sendJson(res, 200, { ok: true })
        } catch (error) {
          respondError(ctx, res, error)
        }
      },
    },
  ]

  for (const route of routes) {
    ctx.effect(() => ctx.webServer.register({ kind: 'exact', path: route.path, handler: route.handler }),
      'dsh-session-manager ' + route.path)
  }

  // 周期评估软依赖 timer:顶层注册(不嵌套在 settings 回调内,settings 服务重启会
  // 重跑其回调并新建 fiber,嵌套会使周期轮随重启累积复制)。服务未激活则回调不执行,
  // 插件其余能力不受影响,设置页提示降级
  ctx.inject(['timer'], (timerCtx) => {
    if (typeof timerCtx.interval !== 'function') {
      periodic.reason = '宿主定时服务不可用'
      return () => {
        periodic.running = false
      }
    }
    // 固定短 tick + 到期判断:间隔设置变更自下一周期生效,缩短经 earliest 钳制前移
    let nextDueAt = null
    let lastArmedAt = 0
    const scheduleNext = () => {
      const { intervalHours } = readSettings(ctx)
      lastArmedAt = Date.now()
      nextDueAt = intervalHours > 0 ? lastArmedAt + intervalHours * HOUR_MS : null
    }
    try {
      const dispose = timerCtx.interval(() => {
        const { intervalHours } = readSettings(ctx)
        // 设置变更对账:0 即时暂停;缺失 due(0 重启用)时补排,防周期轮静默死亡;
        // 缩短间隔时以 lastArmedAt 锚定前移,最长等新间隔而非等满旧周期
        if (intervalHours === 0) {
          nextDueAt = null
          return
        }
        const earliest = lastArmedAt > 0 ? lastArmedAt + intervalHours * HOUR_MS : Infinity
        if (nextDueAt !== null && nextDueAt > earliest) nextDueAt = earliest
        if (nextDueAt === null || Date.now() >= nextDueAt) {
          // 门闩占用(他源评估在途)时保持到期态,60s 后下个 tick 重试;
          // 仅评估真正启动才重排周期,被丢弃的到期轮不会静默失效一个周期
          if (evaluateArchives()) scheduleNext()
        }
      }, PERIODIC_TICK_MS)
      // disposer 挂本 inject fiber:timer 服务移除/重启时复位降级状态并清理 interval
      periodic.running = true
      return () => {
        dispose()
        periodic.running = false
      }
    } catch (error) {
      periodic.reason = '宿主定时服务调用失败: ' + String(error && error.message || error)
      return undefined
    }
  })

  ctx.inject(['settings'], (settingsCtx) => {
    settingsCtx.settings.register(NAMESPACE, SETTINGS_SCHEMA, { base: config })
    // 启动补扫不依赖定时服务:settings 就绪即评估一轮,清掉停机期间积压的超期会话
    evaluateArchives()
  })
}

// 产物缺失时按无活跃处理(null),不阻断整轮评估;null 与真实 mtime=0 不混淆
async function safeMtime(path) {
  try {
    return (await stat(path)).mtimeMs
  } catch {
    return null
  }
}

async function findHeader(ctx, sessionId) {
  const records = await ctx.sessionQuery.listSessions()
  const found = records.find((recordItem) => String(recordItem.header.id) === sessionId)
  return found ? found.header : undefined
}

// detach 幂等:遍历全部工作区逐个移除,不因首个工作区操作失败提前终止;
// 返回首个失败供响应,全部失败进服务端日志(部分失败范围可观测)
async function detachSession(ctx, sessionId) {
  const errors = []
  for (const workspace of ctx.workspaceRegistry.list()) {
    if (!workspace.sessionIds.some((id) => String(id) === sessionId)) continue
    try {
      await workspace.detachSession(sessionId)
    } catch (error) {
      errors.push(error)
    }
  }
  if (errors.length > 1 && ctx.logger) {
    ctx.logger.warn('session-manager detach 多工作区失败(' + sessionId + '): ' + errors.map(String).join('; '))
  }
  return errors[0]
}

// win32 路径大小写不敏感:realpath 已规范大小写,但比对侧可能存在大小写漂移
function samePath(left, right) {
  if (left === right) return true
  return process.platform === 'win32' && String(left).toLowerCase() === String(right).toLowerCase()
}

// 按会话 cwd 找归属工作区:两侧都 realpath 后比对(工作区路径本身也可能含
// 符号链接/大小写漂移),任一侧不可解析时按原值兜底,
// 最终归属校验仍由官方 attachSession 完成
async function findWorkspaceByCwd(ctx, cwd) {
  if (cwd === undefined) return undefined
  let resolved = cwd
  try {
    resolved = await realpath(cwd)
  } catch {
    // 目录不存在时按原值比对
  }
  for (const workspace of ctx.workspaceRegistry.list()) {
    let workspacePath = workspace.path
    try {
      workspacePath = await realpath(workspacePath)
    } catch {
      // 按原值比对
    }
    if (samePath(workspacePath, resolved)) return workspace
  }
  return undefined
}
